package com.baccarancia.mpfy

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.DocumentsContract
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import java.io.ByteArrayInputStream
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The whole UI is the web app served by the client core on [ORIGIN], in one WebView that never
 * leaves that origin. Started with the extra "code" (adb shell am start ... --es code "MPFY-...")
 * or with a link of the app's QR codes (mpfy://collega?..., mpfy://fonte?..., [CodeLinks]) it
 * opens the add screen with the code filled in (#aggiungi=); started from a message
 * notification (the extra "chat") it opens that conversation (#chat=). While it is started it
 * looks for app updates ([Updates]); a debuggable build takes the extra "updateUrl" instead of the
 * release channel.
 * When the WebView's renderer dies, a new WebView (and bridge) takes its place; the music, played
 * by the PlaybackService in this same process, goes on. It also opens the system pickers the
 * bridge asks for (a folder to upload, the profile file) and serves the picked folders' files.
 */
class MainActivity : ComponentActivity(), BridgeHost {
  private lateinit var root: FrameLayout
  private var web: PageWebView? = null
  private var bridge: MPfyBridge? = null
  private var controller: MediaController? = null
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private val gate = PageLoadGate()
  private var pendingCode: String? = null
  // A message notification was tapped: its conversation, until the page can open it.
  private var pendingChat: String? = null
  private var loadFailed = false
  // The renderer died while the page could not be seen: a new WebView at the next start.
  private var webGone = false
  private val main = Handler(Looper.getMainLooper())
  // With the core down, the next ready loads the page (the collector in onCreate).
  private val retryLoad = Runnable { if (gate.reload(CoreHost.ready.value)) load() }
  // While started: the next update check, a day after the last one.
  private val updateTimer = object : Runnable {
    override fun run() {
      Updates.check()
      armUpdateTimer()
    }
  }
  // The request a picker on screen answers: one of each at a time.
  private val folderPicker = PickerSlot()
  private val profilePicker = PickerSlot()
  private val scanSlot = PickerSlot()
  // A link double tapped opens one page.
  private val links = OnceWithin(LINK_WINDOW_MS)
  private var paused = true
  // While uploads go on the page stays awake with the screen off (PageWebView); paused once they end.
  private val onUploads: (Boolean) -> Unit = { on ->
    web?.keepVisible = on
    if (!on && paused) web?.onPause()
  }

  private val pickTree =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val rid = folderPicker.answer() ?: return@registerForActivityResult
      val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
      Folders.walk(this, rid, uri) { e -> bridge?.emit(e) }
    }

  private val pickDocument =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val rid = profilePicker.answer() ?: return@registerForActivityResult
      val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
      IdentityFile.onPicked(rid, uri) { e -> bridge?.emit(e) }
    }

  private val scanner =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val rid = scanSlot.answer() ?: return@registerForActivityResult
      val text = if (result.resultCode == RESULT_OK) result.data?.getStringExtra(ScanActivity.EXTRA_TEXT) else null
      val state = if (text != null) "ok" else result.data?.getStringExtra(ScanActivity.EXTRA_STATE)?.takeIf { it != "ok" } ?: "cancel"
      bridge?.emit(JSONObject().put("type", "scanned").put("requestId", rid).put("state", state).put("text", text).toString())
    }

  // The answer needs nothing more: the notifications show, or they do not.
  private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  // The phone's music: the index hears the answer at once. A "no" that came back at once from the
  // settings row was Android refusing by itself: the app's settings page instead.
  private var musicAskedAt = 0L
  private var musicMode = ""
  private val askMusic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    LocalMusic.refreshAccess()
    val ms = SystemClock.elapsedRealtime() - musicAskedAt
    if (musicMode == "settings" && MusicAccess.unseen(granted, shouldShowRequestPermissionRationale(MediaAccess.permission), ms)) MediaAccess.openSettings(this)
  }

  private val pickFiles =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val data = result.data
      val clip = data?.clipData
      val uris = when {
        result.resultCode != RESULT_OK || data == null -> null
        clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
        data.data != null -> arrayOf(data.data!!)
        else -> null
      }
      fileCallback?.onReceiveValue(uris) // null = cancelled: the page must get an answer
      fileCallback = null
    }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    volumeControlStream = AudioManager.STREAM_MUSIC
    WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)

    root = FrameLayout(this)
    root.setBackgroundColor(BACKGROUND)
    setContentView(root)

    // The service worker's own requests: the same origin lock and the same picked files.
    ServiceWorkerController.getInstance().setServiceWorkerClient(
      object : ServiceWorkerClient() {
        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? = intercept(applicationContext, request)
      },
    )

    // Edge to edge (enforced from target 35): keep the page clear of the bars, the cutout and the
    // keyboard. The padding goes on the container, which WebView content honours.
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    createWebView()
    Uploads.addListener(onUploads)

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val w = web
          if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true) // back leaves the music playing
        }
      },
    )

    pendingCode = codeOf(intent)
    pendingChat = chatOf(intent)
    Updates.takeOverride(intent)
    Updates.check()
    lifecycleScope.launch {
      CoreHost.ready.collect { ready -> if (gate.onReady(ready)) load() }
    }

    // The controller lives as long as the Activity, so the page keeps hearing about errors and
    // track changes while it is in the background (the car, screen off).
    val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
    val future = MediaController.Builder(this, token).buildAsync()
    controllerFuture = future
    future.addListener(
      {
        try {
          val c = future.get()
          controller = c
          bridge?.attach(c)
        } catch (e: Exception) {
          Log.w(TAG, "media controller", e)
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (Updates.takeOverride(intent)) Updates.check()
    chatOf(intent)?.let { cid ->
      val w = web
      // app.js listens to hashchange and opens the conversation.
      if (gate.loaded && w != null) w.evaluateJavascript("location.hash=${JSONObject.quote("chat=$cid")}", null) else pendingChat = cid
    }
    val code = codeOf(intent) ?: return
    val w = web
    if (!gate.loaded || w == null) {
      pendingCode = code
      return
    }
    // app.js listens to hashchange and opens the add screen with the code.
    w.evaluateJavascript("location.hash=${JSONObject.quote("aggiungi=" + Uri.encode(code))}", null)
  }

  override fun onStart() {
    super.onStart()
    if (webGone) newWebView()
    bridge?.setVisible(true)
    if (Updates.due()) Updates.check()
    armUpdateTimer()
  }

  private fun armUpdateTimer() {
    main.removeCallbacks(updateTimer)
    main.postDelayed(updateTimer, Updates.nextCheckIn().coerceAtLeast(60_000))
  }

  override fun onResume() {
    super.onResume()
    paused = false
    web?.onResume()
    Updates.resumed(this)
  }

  override fun onPause() {
    paused = true
    Updates.paused()
    if (!Uploads.active) web?.onPause()
    super.onPause()
  }

  override fun onStop() {
    main.removeCallbacks(updateTimer)
    Updates.stopped()
    bridge?.setVisible(false)
    super.onStop()
  }

  // While a picker is open (a double tap asked twice), the new request is answered cancelled and
  // the one on screen keeps its answer.
  override fun pickFolder(requestId: String): Boolean {
    if (!folderPicker.open(requestId)) {
      Folders.walk(this, requestId, null) { e -> bridge?.emit(e) }
      return true
    }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    return try {
      pickTree.launch(intent)
      true
    } catch (e: ActivityNotFoundException) {
      folderPicker.failed(requestId)
      false
    }
  }

  override fun pickProfileFile(requestId: String): Boolean {
    if (!profilePicker.open(requestId)) {
      IdentityFile.onPicked(requestId, null) { e -> bridge?.emit(e) }
      return true
    }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(DocumentsContract.EXTRA_INITIAL_URI, IdentityFile.initialUri())
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    return try {
      pickDocument.launch(intent)
      true
    } catch (e: ActivityNotFoundException) {
      profilePicker.failed(requestId)
      false
    }
  }

  // A second tap while the scanner opens: answered cancelled, the scanner on screen keeps its answer.
  override fun scanCode(requestId: String): Boolean {
    if (!scanSlot.open(requestId)) {
      bridge?.emit(JSONObject().put("type", "scanned").put("requestId", requestId).put("state", "cancel").toString())
      return true
    }
    return try {
      scanner.launch(Intent(this, ScanActivity::class.java))
      true
    } catch (e: ActivityNotFoundException) {
      scanSlot.failed(requestId)
      false
    }
  }

  /** The same link twice within [LINK_WINDOW_MS] (a double tap) opens one page. */
  override fun openLink(url: Uri) {
    if (!links.allow(url.toString(), SystemClock.elapsedRealtime())) return
    try {
      startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (e: ActivityNotFoundException) {
      Log.w(TAG, "no browser for $url")
    }
  }

  /** Android 13 and later: the progress of downloads and uploads shows only with a yes, asked once, when they start. */
  override fun askNotifications() {
    val sdk = Build.VERSION.SDK_INT
    if (sdk < NotificationAsk.SINCE_SDK) return
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    val inFront = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    if (!NotificationAsk.shouldAsk(sdk, granted, prefs.getBoolean(K_NOTIFICATIONS_ASKED, false), inFront)) return
    prefs.edit().putBoolean(K_NOTIFICATIONS_ASKED, true).apply()
    try {
      askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    } catch (e: ActivityNotFoundException) {
      Log.w(TAG, "no permission screen")
    }
  }

  /** The phone's music: the system's own dialog (its words say what is asked), or the app's settings page once Android no longer shows it. */
  override fun askMusicAccess(mode: String) {
    if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
    when (MediaAccess.step(this, mode)) {
      MusicAccess.Step.NOTHING -> {}
      MusicAccess.Step.SETTINGS -> MediaAccess.openSettings(this)
      MusicAccess.Step.DIALOG -> {
        MediaAccess.markAsked(this)
        musicMode = mode
        musicAskedAt = SystemClock.elapsedRealtime()
        try {
          askMusic.launch(MediaAccess.permission)
        } catch (e: ActivityNotFoundException) {
          Log.w(TAG, "no permission screen")
        }
      }
    }
  }

  override fun onDestroy() {
    Uploads.removeListener(onUploads)
    main.removeCallbacks(retryLoad)
    bridge?.release()
    bridge = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    controller = null
    fileCallback?.onReceiveValue(null)
    fileCallback = null
    web?.destroy()
    web = null
    super.onDestroy()
  }

  /** A WebView with the bridge, in the container; [load] loads the page into it. */
  @SuppressLint("SetJavaScriptEnabled")
  private fun createWebView() {
    val w = PageWebView(this)
    w.keepVisible = Uploads.active
    w.setBackgroundColor(BACKGROUND)
    // No scroll bars of its own, like the page (styles.css).
    w.isVerticalScrollBarEnabled = false
    w.isHorizontalScrollBarEnabled = false
    w.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true // localStorage for the player state; IndexedDB is on by default
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      safeBrowsingEnabled = false // no lookups at Google (the manifest turns it off too)
    }
    val b = MPfyBridge(this, w, this)
    w.addJavascriptInterface(b, "MPfyNative") // before the first loadUrl
    w.webViewClient = Client()
    w.webChromeClient = Chrome()
    root.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    web = w
    bridge = b
    controller?.let { b.attach(it) }
  }

  /** The WebView whose renderer died goes, for good (it must not be used again). */
  private fun dropWebView() {
    val w = web ?: return
    web = null
    main.removeCallbacks(retryLoad)
    bridge?.release()
    bridge = null
    fileCallback?.onReceiveValue(null) // the page that asked is gone
    fileCallback = null
    root.removeView(w)
    w.destroy()
  }

  /** A new WebView after the renderer died, and the page in it (with a code still pending). */
  private fun newWebView() {
    webGone = false
    if (web != null) return
    Log.i(TAG, "new WebView")
    createWebView()
    loadFailed = false
    if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && !Uploads.active) web?.onPause()
    bridge?.setVisible(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    if (gate.reload(CoreHost.ready.value)) load()
  }

  /** Loads the page, the core's token in its cookie (CoreHost.token). */
  private fun load() {
    val w = web ?: return
    CookieManager.getInstance().setCookie(ORIGIN, CoreHost.cookie())
    Log.i(TAG, "loading the UI")
    w.loadUrl(startUrl())
  }

  /** The extra "code", else a link of ours the intent opens (the camera app, a tap): [CodeLinks.codeOf]. */
  private fun codeOf(i: Intent?): String? = CodeLinks.codeOf(i?.action, i?.dataString, i?.getStringExtra("code"))

  /** The conversation of a tapped message notification (the extra "chat", 32 hex), or null. */
  private fun chatOf(i: Intent?): String? = ChatLinks.cidOf(i?.getStringExtra(ChatNote.EXTRA))

  private fun startUrl(): String = ChatLinks.startUrl(ORIGIN, pendingCode?.let { Uri.encode(it) }, pendingChat)

  private inner class Client : WebViewClient() {
    // The bridge is exposed to every frame of every page, so this WebView only ever shows our
    // own origin; an https link opens in the system browser, anything else goes nowhere.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val u = request.url
      if (isOurs(u)) return false
      if (request.isForMainFrame && u.scheme == "https") openLink(u)
      return true
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
      intercept(applicationContext, request)

    // The core restarting (a worklet that crashed): try the page again in a moment, or as soon as
    // the core is ready again.
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (view !== web || !request.isForMainFrame) return
      loadFailed = true
      Log.w(TAG, "page load failed: ${error.errorCode} ${error.description}")
      main.removeCallbacks(retryLoad)
      main.postDelayed(retryLoad, 1_500)
    }

    override fun onPageFinished(view: WebView, url: String) {
      if (view !== web) return
      if (loadFailed) {
        loadFailed = false // the error page; the retry still carries the code
        return
      }
      pendingCode = null // the page took the code
      // A conversation that waited behind a code goes now; one in the address was taken with it.
      pendingChat?.let { cid -> if (!url.endsWith("#chat=$cid")) view.evaluateJavascript("location.hash=${JSONObject.quote("chat=$cid")}", null) }
      pendingChat = null
      Log.i(TAG, "page loaded")
    }

    // The renderer died: it crashed, or the system took its memory back (the app in the
    // background, the music playing). Unhandled (false), Android kills the whole process, and
    // the music and the core with it. This WebView must not be used again: a new one takes its
    // place, now when the page can be seen, else at the next start.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      Log.w(TAG, "page renderer gone (${if (detail.didCrash()) "crashed" else "killed by the system"})")
      if (view !== web) {
        (view.parent as? FrameLayout)?.removeView(view)
        view.destroy()
        return true
      }
      dropWebView()
      webGone = true
      if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) main.post { if (webGone) newWebView() }
      return true
    }
  }

  private inner class Chrome : WebChromeClient() {
    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
      fileCallback?.onReceiveValue(null)
      fileCallback = callback
      val mimes = mimeTypesOf(params.acceptTypes)
      val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = if (mimes.size == 1) mimes[0] else "*/*"
        if (mimes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
      }
      return try {
        pickFiles.launch(intent)
        true
      } catch (e: ActivityNotFoundException) {
        fileCallback = null
        false
      }
    }

    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
      if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
        Log.w(WEB_TAG, "${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})")
      }
      return true
    }
  }

  companion object {
    private const val TAG = "MPfyMain"
    private const val WEB_TAG = "MPfyPage"
    private const val PREFS = "mpfy"
    private const val K_NOTIFICATIONS_ASKED = "notifications.asked"
    private const val LINK_WINDOW_MS = 1_000L
    private val BACKGROUND = Color.rgb(0x14, 0x14, 0x14)

    fun isOurs(u: Uri): Boolean = u.scheme == "http" && u.host == "127.0.0.1" && u.port == CORE_PORT

    /**
     * Every request of the page and of its service worker. Nothing is ever fetched from another
     * host (no third party in the path); /__native/ is answered here from the picked
     * folders; an upload request tells the notification its source.
     */
    fun intercept(ctx: Context, request: WebResourceRequest): WebResourceResponse? {
      val u = request.url
      if ((u.scheme == "http" || u.scheme == "https") && !isOurs(u)) {
        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }
      if (!isOurs(u)) return null
      val path = u.path
      if (Folders.isFileRequest(path)) {
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        return Folders.serve(ctx, request.method, path, range)
      }
      Uploads.noteRequest(path)
      return null
    }

    /**
     * The accept attribute as MIME types for the system picker: songs, archives and pictures (the
     * upload sheet takes them all, like cover.jpg with an album), or pictures only (a custom
     * cover). Some file managers call FLAC or Opus files application/octet-stream: allowed with audio.
     */
    fun mimeTypesOf(accept: Array<String>?): List<String> {
      val out = LinkedHashSet<String>()
      for (raw in accept.orEmpty()) {
        for (token in raw.split(',')) {
          val t = token.trim().lowercase()
          when {
            t.isEmpty() -> {}
            t.startsWith(".") -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.substring(1))?.let { out.add(it) }
            t.contains('/') -> out.add(t)
          }
        }
      }
      if (out.isEmpty()) return listOf("*/*")
      if (out.any { it.startsWith("audio/") }) {
        out.add("audio/*")
        out.add("application/ogg")
        out.add("application/octet-stream")
        // Albums as archives, extracted on the source.
        out.add("application/zip")
        out.add("application/x-7z-compressed")
        out.add("application/vnd.rar")
        out.add("application/x-rar-compressed")
      }
      return out.toList()
    }
  }
}

/**
 * The page's WebView. A page the WebView sees hidden is frozen after about five minutes (its
 * timers and network callbacks stop), and the upload queue lives in the page: while uploads go on,
 * it is told its window stays visible, so a long upload goes on with the screen off.
 */
class PageWebView(context: Context) : WebView(context) {
  private var realVisibility = View.VISIBLE

  var keepVisible = false
    set(value) {
      if (field == value) return
      field = value
      super.onWindowVisibilityChanged(if (value) View.VISIBLE else realVisibility)
    }

  override fun onWindowVisibilityChanged(visibility: Int) {
    realVisibility = visibility
    super.onWindowVisibilityChanged(if (keepVisible) View.VISIBLE else visibility)
  }
}
