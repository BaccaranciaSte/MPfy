package com.baccarancia.mpfy

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.MediaController
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject

/** What the bridge asks of its Activity: the system pickers, links, and the yes to notifications. */
interface BridgeHost {
  fun pickFolder(requestId: String): Boolean

  fun pickProfileFile(requestId: String): Boolean

  /** An https link in the system browser. */
  fun openLink(url: Uri)

  /** Downloads or uploads start: their notifications need the person's yes (asked once). */
  fun askNotifications()

  /** The phone's music: "first" (the system's dialog, once ever) or "settings" (the dialog while Android shows it, else the app's settings page). */
  fun askMusicAccess(mode: String)

  /** The QR scanner for [requestId]; false when it could not open. */
  fun scanCode(requestId: String): Boolean = false
}

/**
 * window.MPfyNative, native bridge v7 (v6, and the car's library in pages: setBrowsePage,
 * setBrowseIndex, getBrowsePages; v6: v5 and the message notifications: getChatNotify,
 * setChatNotify, chatSeen, [ChatNotifier]; v5: the native player reports what plays, so the page
 * does not, [ActivityReporter]). Every argument from the page is a string.
 * Methods annotated @JavascriptInterface run on a private WebView thread ("JavaBridge"): player
 * and download calls are posted to the main thread, and the synchronous getters return snapshots
 * kept up to date on the main thread. The player calls act on the session's own player
 * ([Playback.player]), in the order the page made them, each whole before anything else acts on
 * it; the Activity's MediaController only listens. Native to page: window.__mpfyNative(<JSON string>) with
 * { type: 'state' | 'downloads' | 'network' | 'error' | 'folder' | 'profileFile' |
 * 'profileFileState' | 'storage' | 'update' | 'liked' | 'scanned', ... }. The QR scanner (scanCode)
 * came within v7: the page looks for the method itself.
 */
class MPfyBridge(private val activity: ComponentActivity, private val web: WebView, private val host: BridgeHost) {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var controller: MediaController? = null
  @Volatile private var stateJson = "{\"type\":\"state\",\"playing\":false,\"buffering\":false,\"index\":-1,\"queueId\":null}"
  // getQueue(): the player's items (rebuilt when its list changes), its id, index and position.
  @Volatile private var queueItems = "[]"
  @Volatile private var queueId: String? = null
  @Volatile private var queueIndex = -1
  @Volatile private var queuePositionMs = 0L
  private var visible = true
  @Volatile private var released = false

  private val ticker = object : Runnable {
    override fun run() {
      pushState()
      if (visible && controller?.isPlaying == true) main.postDelayed(this, TICK_MS)
    }
  }

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.contains(Player.EVENT_TIMELINE_CHANGED)) rebuildQueue()
      pushState()
      main.removeCallbacks(ticker)
      if (visible && player.isPlaying) main.postDelayed(ticker, TICK_MS)
    }
  }

  // Only a track that failed on every version reaches the page (the service tries the others first).
  private val onError = Playback.ErrorListener { message, itemId ->
    emit(JSONObject().put("type", "error").put("message", message).put("itemId", itemId ?: JSONObject.NULL).toString())
  }

  private val onNetwork = Net.Listener { s, _ ->
    emit(JSONObject().put("type", "network").put("network", s.type).put("metered", s.metered).toString())
  }

  private val onDownloads: (String) -> Unit = { snapshot -> emit(snapshot) }
  private val onStorage: (String) -> Unit = { s -> emit(s) }
  private val onProfileFile: (String) -> Unit = { s -> emit(s) }
  private val onUpdate: (String) -> Unit = { s -> emit(s) }
  private val onLiked: (String) -> Unit = { s -> emit(s) }

  init {
    Net.addListener(onNetwork)
    Downloads.addListener(onDownloads)
    Storage.addListener(onStorage)
    IdentityFile.addListener(onProfileFile)
    Playback.addErrorListener(onError)
    Updates.addListener(onUpdate)
    Likes.addListener(onLiked)
  }

  fun attach(c: MediaController) {
    controller = c
    c.addListener(listener)
    Playback.uiAttached = true
    rebuildQueue()
    pushState()
    if (visible && c.isPlaying) main.postDelayed(ticker, TICK_MS)
  }

  /** Unhooks everything; the bridge is not used again. Its page's uploads went with it. Main thread. */
  fun release() {
    released = true
    Uploads.gone(this)
    controller?.removeListener(listener)
    controller = null
    Playback.uiAttached = false
    main.removeCallbacks(ticker)
    Net.removeListener(onNetwork)
    Downloads.removeListener(onDownloads)
    Storage.removeListener(onStorage)
    IdentityFile.removeListener(onProfileFile)
    Playback.removeErrorListener(onError)
    Updates.removeListener(onUpdate)
    Likes.removeListener(onLiked)
  }

  /** Position ticks only while the page can be seen; events are sent either way. Main thread. */
  fun setVisible(v: Boolean) {
    visible = v
    main.removeCallbacks(ticker)
    if (v) {
      pushState()
      if (controller?.isPlaying == true) main.postDelayed(ticker, TICK_MS)
    }
  }

  /** A player call of the page, on the main thread and on the session's own player. */
  private fun onMain(block: (Player) -> Unit) {
    main.post {
      if (released) return@post
      val p = Playback.player ?: return@post
      try {
        block(p)
      } catch (e: Exception) {
        Log.w(TAG, "player call failed", e)
      }
    }
  }

  @JavascriptInterface fun bridgeVersion(): String = "7"

  // --- the message notifications ---

  /** "Notifiche dei messaggi": "1" or "0". */
  @JavascriptInterface fun getChatNotify(): String = if (Chats.enabled()) "1" else "0"

  /** Turns them on ("1") or off (anything else); says what is kept now. */
  @JavascriptInterface
  fun setChatNotify(value: String): String {
    Chats.setEnabled(value == "1")
    return if (value == "1") "1" else "0"
  }

  /** The page opened that conversation: its notification goes. */
  @JavascriptInterface
  fun chatSeen(cid: String) {
    if (CID.matches(cid)) Chats.seen(cid)
  }

  // --- player ---

  /**
   * { queueId, items, index, positionMs, playWhenReady, keep }: the page's list with its current
   * item at index ([PageQueue]). keep: an edit of the items around the one playing, which goes on
   * even when the player moved on before the page saw it.
   */
  @JavascriptInterface
  fun setQueue(json: String) {
    val o = try {
      JSONObject(json)
    } catch (e: Exception) {
      Log.w(TAG, "setQueue: bad JSON")
      return
    }
    val arr = o.optJSONArray("items") ?: JSONArray()
    val index = o.optInt("index", 0)
    val positionMs = o.optLong("positionMs", 0).coerceAtLeast(0)
    val playWhenReady = o.optBoolean("playWhenReady", false)
    val keep = o.optBoolean("keep", false)
    val id = if (o.isNull("queueId")) null else o.optString("queueId")
    Playback.saveQueue(activity, json)
    onMain { p ->
      Playback.owner.pageSet(id)
      PageQueue.apply(PlayerQueue(p), Playback.itemsOf(arr, register = false), { it.mediaId }, index, positionMs, playWhenReady, keep)
    }
  }

  /** { queueId, index, positionMs, items: [{ id, title, artist, album, durationMs, ctx }] }: the list the player holds. */
  @JavascriptInterface
  fun getQueue(): String = "{\"queueId\":${queueId?.let { JSONObject.quote(it) } ?: "null"},\"index\":$queueIndex,\"positionMs\":$queuePositionMs,\"items\":$queueItems}"

  /** { id, liked, likedIds }: after every like change the page sees, its queue items and the car follow. */
  @JavascriptInterface
  fun setLiked(json: String) {
    val o = runCatching { JSONObject(json) }.getOrNull() ?: return
    val id = o.optString("id")
    if (!Levels.isId(id)) return
    val ids = o.optJSONArray("likedIds")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { Levels.isId(it) } }.orEmpty()
    Likes.fromPage(id, o.optBoolean("liked", ids.isNotEmpty()), ids)
  }

  /** The car's library (format mpfy-browse), kept on disk for Android Auto with the page closed. */
  @JavascriptInterface
  fun setBrowseSnapshot(json: String) {
    if (json.length > Snapshot.MAX_CHARS) return
    Browse.offer(json)
  }

  /** One page of the car's library (bridge 7, format mpfy-browse-page): n is its slot. */
  @JavascriptInterface
  fun setBrowsePage(n: String, json: String) {
    val slot = n.toIntOrNull() ?: return
    if (slot !in 0 until Snapshot.MAX_PAGES || json.length > Snapshot.MAX_CHARS) return
    Browse.offerPage(slot, json)
  }

  /** The rest of the car's library (bridge 7, format mpfy-browse-index): the levels, the pages' order, the groups. */
  @JavascriptInterface
  fun setBrowseIndex(json: String) {
    if (json.length > Snapshot.MAX_INDEX_CHARS) return
    Browse.offerIndex(json)
  }

  /** { index, pages: [{ n, h, first }] }: the pages the app holds, so the page sends only what moved. */
  @JavascriptInterface fun getBrowsePages(): String = Browse.held()

  /** { state: none|available|downloading|installing, versionName, progress }. */
  @JavascriptInterface fun getUpdate(): String = Updates.json

  /** The installed versionName: a page cached before an update is older than it. */
  @JavascriptInterface
  fun appVersion(): String = runCatching { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName }.getOrNull() ?: ""

  /** Only from "available"; in the other states nothing. */
  @JavascriptInterface
  fun startUpdate() {
    main.post { if (!released) Updates.startUpdate() }
  }

  // As the session does for a controller's play: a failed player prepares again, an ended one starts over.
  @OptIn(UnstableApi::class)
  @JavascriptInterface
  fun play() = onMain { Util.handlePlayButtonAction(it) }

  @JavascriptInterface fun pause() = onMain { it.pause() }

  @JavascriptInterface
  fun seekTo(ms: String) {
    val v = ms.toDoubleOrNull() ?: return
    onMain { it.seekTo(v.toLong().coerceAtLeast(0)) }
  }

  @JavascriptInterface
  fun skipTo(index: String) {
    val i = index.toDoubleOrNull()?.toInt() ?: return
    onMain { p -> if (i in 0 until p.mediaItemCount) p.seekToDefaultPosition(i) }
  }

  @JavascriptInterface fun next() = onMain { it.seekToNext() }

  // Only reached from Bluetooth-like flows: the page decides "previous" itself.
  @JavascriptInterface fun previous() = onMain { it.seekToPrevious() }

  @JavascriptInterface
  fun setRepeat(mode: String) = onMain {
    it.repeatMode = when (mode) {
      "all" -> Player.REPEAT_MODE_ALL
      "one" -> Player.REPEAT_MODE_ONE
      else -> Player.REPEAT_MODE_OFF
    }
  }

  @JavascriptInterface fun getState(): String = stateJson

  // --- downloads and storage ---

  /** [{ id, trackId, fileHash, url, quality }]: one version of a track at one level each. */
  @JavascriptInterface
  fun download(json: String) {
    val arr = runCatching { JSONArray(json) }.getOrNull() ?: return
    main.post {
      Downloads.add(activity, arr)
      if (!released) host.askNotifications()
    }
  }

  /** Items: a trackId (every version and level), or { trackId, fileHash } (every level of that version). */
  @JavascriptInterface
  fun removeDownload(json: String) {
    val arr = runCatching { JSONArray(json) }.getOrNull() ?: return
    val selectors = ArrayList<DownloadSelector>()
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i)
      if (o != null) {
        val t = o.optString("trackId")
        val f = o.optString("fileHash").ifEmpty { t }
        if (Levels.isId(t) && Levels.isId(f)) selectors.add(DownloadSelector.Version(t, f))
      } else {
        val t = arr.optString(i)
        if (Levels.isId(t)) selectors.add(DownloadSelector.Track(t))
      }
    }
    if (selectors.isEmpty()) return
    main.post { Downloads.remove(activity, selectors) }
  }

  @JavascriptInterface fun listDownloads(): String = Downloads.snapshot

  @JavascriptInterface
  fun clearDownloads() {
    main.post { Downloads.removeAll(activity) }
  }

  @JavascriptInterface fun getStorage(): String = Storage.json().toString()

  /** "Svuota cache": the stream cache but the items playing and next, and the WebView's HTTP cache. */
  @JavascriptInterface
  fun clearCache() {
    main.post {
      val keep = HashSet<String>()
      controller?.let { c ->
        c.currentMediaItem?.let { item -> Playback.keyOf(item)?.let { keep.add(it) } }
        val i = c.nextMediaItemIndex
        if (i != C.INDEX_UNSET) Playback.keyOf(c.getMediaItemAt(i))?.let { keep.add(it) }
      }
      Prefetch.pause()
      StreamCache.clear(keep) {
        main.post {
          Prefetch.resume(keep)
          Storage.changed()
        }
      }
      if (!released) web.clearCache(true)
    }
  }

  // --- uploads, folders, the profile file, secrets ---

  @JavascriptInterface
  fun setUploading(value: String) {
    val on = value == "true"
    main.post {
      if (released) return@post // a word from a page already gone
      Uploads.set(this, on)
      if (on) host.askNotifications()
    }
  }

  @JavascriptInterface
  fun pickFolder(): String {
    val rid = newRequestId()
    main.post {
      if (!host.pickFolder(rid)) emit(JSONObject().put("type", "folder").put("requestId", rid).put("state", "error").toString())
    }
    return rid
  }

  @JavascriptInterface fun releaseFolder(requestId: String) = Folders.release(activity, requestId)

  @JavascriptInterface
  fun pickProfileFile(): String {
    val rid = newRequestId()
    main.post {
      if (!host.pickProfileFile(rid)) emit(JSONObject().put("type", "profileFile").put("requestId", rid).put("state", "error").toString())
    }
    return rid
  }

  @JavascriptInterface fun adoptProfileFile(requestId: String) = IdentityFile.adopt(requestId)

  /**
   * The QR scanner, full screen ([ScanActivity]). Returns the request id; the answer is
   * { type: 'scanned', requestId, state: 'ok' | 'cancel' | 'denied' | 'error', text } with the
   * text of a code of ours when state is 'ok'.
   */
  @JavascriptInterface
  fun scanCode(): String {
    val rid = newRequestId()
    main.post {
      if (!host.scanCode(rid)) emit(JSONObject().put("type", "scanned").put("requestId", rid).put("state", "error").toString())
    }
    return rid
  }

  @JavascriptInterface fun getProfileFile(): String = IdentityFile.json().toString()

  /**
   * The profile code to the clipboard, marked sensitive; cleared after a minute while the app is in
   * front and the clip is still ours, told by its description (the clip itself is never read back).
   */
  @JavascriptInterface
  fun copySecret(text: String) {
    if (text.isEmpty()) return
    main.post {
      val cm = activity.getSystemService(ClipboardManager::class.java) ?: return@post
      val clip = ClipData.newPlainText(SecretClip.LABEL, text)
      clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
      try {
        cm.setPrimaryClip(clip)
      } catch (e: Exception) {
        Log.w(TAG, "clipboard: ${e.javaClass.simpleName}")
        return@post
      }
      val ours = runCatching { cm.primaryClipDescription?.timestamp }.getOrNull() ?: 0L
      main.postDelayed({
        if (!Keeper.inForeground) return@postDelayed
        val d = runCatching { cm.primaryClipDescription }.getOrNull()
        if (SecretClip.stillOurs(d?.label, d?.timestamp ?: 0L, ours)) runCatching { cm.clearPrimaryClip() }
      }, SECRET_CLIP_MS)
    }
  }

  // --- system ---

  @JavascriptInterface fun getNetwork(): String = Net.json()

  // --- the phone's music (found by the page by their presence, not by the bridge's number) ---

  /** "granted" or "off": the phone's music may be read now. */
  @JavascriptInterface fun getMusicAccess(): String = MusicAccess.state(MediaAccess.granted(activity))

  /** "first" when the app first shows, "settings" from the row or Home's button; the page sees the outcome in /local/sources. */
  @JavascriptInterface
  fun askMusicAccess(mode: String) {
    if (mode != "first" && mode != "settings") return
    main.post { if (!released) host.askMusicAccess(mode) }
  }

  /** Opens an https:// link in the system browser; the WebView itself never leaves 127.0.0.1. */
  @JavascriptInterface
  fun openExternal(url: String) {
    val u = Uri.parse(url)
    if (u.scheme != "https" || u.host.isNullOrEmpty()) return
    main.post { if (!released) host.openLink(u) }
  }

  // --- internals ---

  /** The player's list as getQueue tells it. Main thread. */
  private fun rebuildQueue() {
    val c = controller ?: return
    val arr = JSONArray()
    for (i in 0 until c.mediaItemCount) {
      val it = c.getMediaItemAt(i)
      val m = it.mediaMetadata
      arr.put(
        JSONObject()
          .put("id", it.mediaId)
          .put("title", m.title?.toString() ?: "")
          .put("artist", m.artist?.toString() ?: "")
          .put("album", m.albumTitle?.toString() ?: "")
          .put("durationMs", m.durationMs ?: 0L)
          .put("ctx", Playback.ctxOf(it)?.let { x -> JSONObject().put("k", x.kind).put("id", x.id ?: JSONObject.NULL) } ?: JSONObject.NULL),
      )
    }
    queueItems = arr.toString()
    // Named with the list it names: a tick between a new owner and its items never pairs them wrong.
    queueId = Playback.owner.idFor(c.mediaItemCount)
  }

  private fun pushState() {
    val c = controller ?: return
    val item = c.currentMediaItem
    if (c.mediaItemCount == 0) queueId = null
    queueIndex = if (item == null) -1 else c.currentMediaItemIndex
    queuePositionMs = c.currentPosition.coerceAtLeast(0)
    val playing = c.playWhenReady &&
      (c.playbackState == Player.STATE_READY || c.playbackState == Player.STATE_BUFFERING) &&
      c.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE
    val v = item?.let { Playback.playingOf(it) }
    stateJson = JSONObject()
      .put("type", "state")
      .put("playing", playing)
      .put("buffering", c.playbackState == Player.STATE_BUFFERING)
      .put("index", if (item == null) -1 else c.currentMediaItemIndex)
      .put("itemId", item?.mediaId ?: JSONObject.NULL)
      .put("positionMs", c.currentPosition.coerceAtLeast(0))
      .put("durationMs", c.duration.coerceAtLeast(0))
      .put("repeat", when (c.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "off" })
      .put("quality", item?.let { Playback.qualityOf(it) } ?: JSONObject.NULL)
      .put("sourceId", v?.sourceId?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL)
      .put("trackId", v?.trackId ?: JSONObject.NULL)
      .put("fileHash", v?.fileHash ?: JSONObject.NULL)
      .put("queueId", queueId ?: JSONObject.NULL)
      .toString()
    emit(stateJson)
  }

  /** evaluateJavascript needs the UI thread. */
  fun emit(json: String) {
    main.post {
      if (released) return@post
      web.evaluateJavascript("window.__mpfyNative&&window.__mpfyNative(${JSONObject.quote(json)})", null)
    }
  }

  companion object {
    private const val TAG = "MPfyBridge"
    private const val TICK_MS = 500L
    private const val SECRET_CLIP_MS = 60_000L
    private val rng = SecureRandom()
    private val CID = Regex("^[0-9a-f]{32}$")

    /** 16 hex, for pickers and folders. */
    fun newRequestId(): String = ByteArray(8).also { rng.nextBytes(it) }.joinToString("") { "%02x".format(it) }
  }
}

/**
 * The session's player as the page's list needs it ([PageQueue]): what goes in is registered (its
 * versions, as the session does for the items a controller sends), and the item going on takes
 * the page's new order of its versions. Main thread.
 */
private class PlayerQueue(private val p: Player) : PageQueue.Target<MediaItem> {
  override val count: Int get() = p.mediaItemCount

  override val current: Int get() = if (p.currentMediaItem == null) -1 else p.currentMediaItemIndex

  override val canGoOn: Boolean
    get() = p.currentMediaItem != null &&
      p.playerError == null &&
      p.playbackState != Player.STATE_IDLE &&
      p.playbackState != Player.STATE_ENDED

  override fun idAt(index: Int): String = p.getMediaItemAt(index).mediaId

  override fun clear() = p.clearMediaItems()

  override fun remove(from: Int, to: Int) = p.removeMediaItems(from, to)

  override fun add(index: Int, items: List<MediaItem>) {
    items.forEach(Playback::register)
    p.addMediaItems(index, items)
  }

  override fun goOn(fresh: MediaItem) {
    p.currentMediaItem?.let { Playback.updatePlaying(it, fresh) }
  }

  override fun load(items: List<MediaItem>, index: Int, positionMs: Long) {
    items.forEach(Playback::register)
    p.setMediaItems(items, index, positionMs)
    p.prepare()
  }

  override fun setPlayWhenReady(play: Boolean) {
    p.playWhenReady = play
  }
}
