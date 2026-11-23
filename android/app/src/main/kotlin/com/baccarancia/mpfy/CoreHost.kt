package com.baccarancia.mpfy

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet

const val CORE_PORT = 47123
const val ORIGIN = "http://127.0.0.1:$CORE_PORT"

/**
 * Owns the Bare worklet that runs the client core (android/worklet/index.js), which
 * serves [ORIGIN] for the WebView, the player and the downloads. The worklet is started at process
 * start, restarted with a backoff when it exits (a fatal error), suspended and resumed as [Keeper]
 * decides, and told about every switch of the default network.
 */
object CoreHost : CoreState {
  private const val TAG = "MPfyCore"
  // How long a suspended worklet may keep running to suspend its DHT node before its loop idles.
  private const val SUSPEND_LINGER_MS = 3_000
  private const val MIN_BACKOFF_MS = 1_000L
  private const val MAX_BACKOFF_MS = 30_000L
  // A worklet that ran this long before exiting was healthy: the next restart is quick again.
  private const val HEALTHY_RUN_MS = 60_000L
  private const val USABLE_WAIT_MS = 15_000L

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private lateinit var app: Context
  private var worklet: Worklet? = null
  private var outbox: Channel<String>? = null
  private var suspended = false
  // Each worklet's number: messages bound to the worklet that asked (the phone's music feed) go to it only.
  private var number = 0L

  private val _ready = MutableStateFlow(false)

  /** True while the core listens on [ORIGIN] (it stays true across a suspension). */
  val ready: StateFlow<Boolean> = _ready

  override val listening: Boolean get() = _ready.value

  // Set by the worklet's own "started" and "resumed", cleared when it is suspended or gone.
  @Volatile private var awake: Long? = null

  override val awakeSince: Long? get() = awake

  override val listed: Boolean get() = Links.listed

  override fun isSource(sourceId: String): Boolean = Links.isSource(sourceId)

  override fun isUp(sourceId: String): Boolean = Links.isUp(sourceId)

  override val principal: String? get() = Links.principal

  override val home: String? get() = Links.home

  /**
   * The loopback address is shared by every app on the phone, so the core must tell this app's
   * requests from anyone else's: a random secret for the life of the process, handed to the core
   * in the start message, sent by the WebView as the cookie [TOKEN_COOKIE] and by the player, the
   * downloads and the notification artwork as the header [TOKEN_HEADER]. The core refusing
   * requests without it is client-core's side of this contract.
   */
  val token: String = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  const val TOKEN_HEADER = "X-MPfy-Token"
  const val TOKEN_COOKIE = "mpfy_token"

  /** Default request properties of every native HTTP data source that talks to the core. */
  val requestHeaders: Map<String, String> = mapOf(TOKEN_HEADER to token)

  /** The cookie the WebView carries to [ORIGIN] (set before every page load). */
  fun cookie(): String = "$TOKEN_COOKIE=$token; Path=/; HttpOnly; SameSite=Strict"

  fun init(context: Context) {
    if (::app.isInitialized) return
    app = context.applicationContext
    // Wi-Fi to mobile, tunnels in the car: every link re-checks itself at once.
    Net.addListener { _, switched -> if (switched) send(JSONObject().put("t", "network")) }
    // The phone's songs played from their files, and the lookups' HTTPS for them.
    PhoneFiles.init(app)
    Lookups.init(app)
    scope.launch { supervise() }
  }

  private suspend fun supervise() {
    var webRoot: File? = null
    var backoff = MIN_BACKOFF_MS
    while (true) {
      val began = SystemClock.elapsedRealtime()
      try {
        val root = webRoot ?: WebAssets.ensure(app).also { webRoot = it }
        runOnce(root)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Throwable) {
        Log.e(TAG, "worklet failed", e)
      }
      _ready.value = false
      backoff = if (SystemClock.elapsedRealtime() - began > HEALTHY_RUN_MS) MIN_BACKOFF_MS else (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      Log.w(TAG, "starting a new worklet in $backoff ms")
      delay(backoff)
    }
  }

  private suspend fun runOnce(webRoot: File) = coroutineScope {
    val w = Worklet(app)
    val ipc = Ipc(w) // must exist before start()
    val box = Channel<String>(Channel.UNLIMITED)
    synchronized(lock) {
      worklet = w
      outbox = box
      suspended = false
      awake = null
      number++
    }
    LocalMusic.onAwake(true)
    val reader = launch {
      try {
        readLoop(ipc, w)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "IPC read ended: $e")
      }
    }
    val writer = launch {
      try {
        for (line in box) ipc.write((line + "\n").encodeToByteArray())
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "IPC write ended: $e")
      }
    }
    try {
      w.start("app.bundle") // src/main/assets/app.bundle, built by android/worklet
      Log.i(TAG, "worklet started")
      val start = JSONObject()
        .put("t", "start")
        .put("statePath", File(app.filesDir, "mpfy-state.json").absolutePath)
        .put("webRoot", webRoot.absolutePath)
        .put("port", CORE_PORT)
        .put("deviceName", Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android")
        .put("token", token)
        // The phone's music: Locale's state beside the core's, the index's covers (read only), the app's version.
        .put("phoneDir", File(app.filesDir, "mpfy-state.json").absolutePath + ".phone")
        .put("artDir", LocalMusic.artDir(app).absolutePath)
        .put("appVersion", runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "")
      box.trySend(start.toString())
      main.post { Keeper.update() } // a new worklet starts awake: re-arm the suspension timer
      val code = w.wait()
      Log.w(TAG, "worklet exited with code $code")
    } finally {
      synchronized(lock) {
        if (worklet === w) {
          worklet = null
          outbox = null
          suspended = false
          awake = null
        }
      }
      LocalMusic.onWorkletGone()
      _ready.value = false
      box.close()
      writer.cancel()
      reader.cancel()
      runCatching { ipc.close() }
      runCatching { w.close() }
    }
  }

  private suspend fun readLoop(ipc: Ipc, w: Worklet) {
    val line = ByteArrayOutputStream()
    ipc.data.collect { chunk ->
      var start = 0
      for (i in chunk.indices) {
        if (chunk[i] == '\n'.code.toByte()) {
          line.write(chunk, start, i - start)
          val text = String(line.toByteArray(), Charsets.UTF_8)
          line.reset()
          start = i + 1
          if (text.isNotEmpty()) {
            try {
              onMessage(JSONObject(text), w)
            } catch (e: Exception) {
              Log.w(TAG, "bad message from the worklet", e)
            }
          }
        }
      }
      line.write(chunk, start, chunk.size - start)
    }
  }

  private fun onMessage(m: JSONObject, w: Worklet) {
    when (m.optString("t")) {
      "started" -> {
        Log.i(TAG, "client core listening on 127.0.0.1:${m.optInt("port")}")
        synchronized(lock) { if (worklet === w && !suspended) awake = SystemClock.elapsedRealtime() }
        _ready.value = true
      }
      "start-failed" -> {
        Log.e(TAG, "client core did not start: ${m.optString("code")} ${m.optString("message")}")
        // EADDRINUSE: a previous worklet still holds the port. Start a new one after the backoff.
        runCatching { w.terminate() }
      }
      "event" -> onEvent(m.optJSONObject("event"))
      // The identity as the .mpfy file holds it: written to Documents/MPfy, never logged.
      "identity" -> IdentityFile.onIdentity(m.optString("fileName"), m.optString("text"))
      "log" -> Log.i(TAG, "core: ${m.optString("line")}")
      "suspended" -> Log.i(TAG, "worklet suspended")
      "resumed" -> {
        // A resume asked before a later suspend: that worklet is going back to sleep.
        synchronized(lock) { if (worklet === w && !suspended) awake = SystemClock.elapsedRealtime() }
        Log.i(TAG, "worklet resumed")
      }
      "stopped" -> Log.i(TAG, "client core stopped")
      "fatal" -> Log.e(TAG, "worklet fatal error: ${m.optString("message")}")
      // The phone's music feed: where the core's log is, and each batch it applied and synced.
      "local-hello" -> {
        val n = synchronized(lock) { if (worklet === w) number else -1L }
        if (n >= 0) {
          // The core serves the phone's music: its covers and the phone's store are at "0000".
          Links.servePhone()
          LocalMusic.onHello(n, if (m.isNull("token")) null else m.optString("token"), m.optLong("batch"))
        }
      }
      "local-ack" -> LocalMusic.onAck(if (m.isNull("token")) null else m.optString("token"), m.optLong("batch"))
      // A lookup of the phone's songs: one HTTPS GET, answered to the worklet that asked.
      "net" -> {
        val n = synchronized(lock) { if (worklet === w) number else -1L }
        if (n >= 0) Lookups.request(n, m)
      }
    }
  }

  private fun onEvent(e: JSONObject?) {
    when (e?.optString("type")) {
      "profile" -> IdentityFile.onProfile(!e.isNull("profile"))
      "sources" -> {
        val list = e.optJSONArray("sources") ?: return
        val states = ArrayList<Links.Source>()
        var principal: String? = null
        val parts = (0 until list.length()).map { i ->
          val s = list.getJSONObject(i)
          states.add(Links.Source(s.optString("id"), s.optString("name"), s.optBoolean("connected")))
          if (s.optBoolean("principal")) principal = s.optString("id")
          val err = if (s.isNull("lastError")) "" else ", ${s.optString("lastError")}"
          "${s.optString("id")} ${if (s.optBoolean("connected")) "connected" else "not connected"}${if (s.optBoolean("principal")) " principal" else ""}$err"
        }
        // Where the person's data lives; a core that does not say keeps it on the principal.
        val home = if (!e.has("home")) principal else if (e.isNull("home")) null else e.optString("home")
        Log.i(TAG, "sources (${list.length()}): ${parts.joinToString("; ")}${if (home != principal) "; home $home" else ""}")
        Links.update(states, principal, home)
      }
    }
  }

  fun send(msg: JSONObject) {
    val box = synchronized(lock) { outbox }
    box?.trySend(msg.toString())
  }

  /** Sends [line] (one JSON message) to worklet [number] only, false when another one runs or none does. */
  fun sendTo(number: Long, line: String): Boolean {
    val box = synchronized(lock) { if (this.number == number && worklet != null) outbox else null } ?: return false
    return box.trySend(line).isSuccess
  }

  /** The worklet held awake for one request, and up to 15 s for the core and the source's link first. Off the main thread. */
  val gate: CoreGate = HeldGate(Keeper, this, { SystemClock.elapsedRealtime() }, { Thread.sleep(it) }, USABLE_WAIT_MS)

  /** Bare Kit suspend: the worklet suspends its DHT node and then idles. */
  fun suspend() {
    synchronized(lock) {
      val w = worklet ?: return
      if (suspended) return
      try {
        w.suspend(SUSPEND_LINGER_MS)
        suspended = true
        awake = null
      } catch (e: Exception) {
        Log.w(TAG, "suspend failed", e)
        return
      }
    }
    LocalMusic.onAwake(false)
    Log.i(TAG, "suspend requested")
  }

  /** Bare Kit resume: the worklet resumes its DHT node and every link re-checks itself. */
  fun resume() {
    synchronized(lock) {
      val w = worklet ?: return
      if (!suspended) return
      try {
        w.resume()
      } catch (e: Exception) {
        Log.w(TAG, "resume failed", e)
      }
      suspended = false
    }
    LocalMusic.onAwake(true)
    Log.i(TAG, "resume requested")
  }
}

/**
 * The core's sources as the app needs them: which links are up, a call when one goes
 * down (the failover leaves a source that dropped), their names, the principal, and the home
 * (the heart's likes go there). The phone's own music ("0000") is in no list: it is a source, and
 * up, once the core said it serves it (its covers, the phone's store). Any thread.
 */
object Links : LinkWatch {
  data class Source(val id: String, val name: String, val connected: Boolean)

  private class Watcher(val sourceId: String, val call: () -> Unit)

  private val up = ConcurrentHashMap<String, Boolean>()
  private val names = ConcurrentHashMap<String, String>()
  private val watchers = CopyOnWriteArrayList<Watcher>()

  fun isUp(id: String): Boolean = if (id == LocalSource.ID) phone else up[id] == true

  fun isSource(id: String): Boolean = if (id == LocalSource.ID) phone else up.containsKey(id)

  fun nameOf(id: String): String? = names[id]

  /** The core's first list of sources came. */
  @Volatile
  var listed = false
    private set

  /** The source with principal: true in the last sources event, or null. */
  @Volatile
  var principal: String? = null
    private set

  /** Where the person's data lives (the last sources event's home): a source of the list, "0000", or null. */
  @Volatile
  var home: String? = null
    private set

  /** The core serves the phone's own music (it said hello for it, or named its store the home). For the life of the process: every core of this app serves it. */
  @Volatile
  var phone = false
    private set

  fun servePhone() {
    phone = true
  }

  fun update(list: List<Source>, principal: String? = this.principal, home: String? = principal) {
    this.principal = principal?.takeIf { p -> list.any { it.id == p } }
    if (home == LocalSource.ID) phone = true
    this.home = home?.takeIf { h -> h == LocalSource.ID || list.any { it.id == h } }
    val down = ArrayList<String>()
    val seen = HashSet<String>()
    for (s in list) {
      seen.add(s.id)
      names[s.id] = s.name
      if (up.put(s.id, s.connected) == true && !s.connected) down.add(s.id)
    }
    for (id in up.keys.toList()) {
      if (id !in seen && up.remove(id) == true) down.add(id)
    }
    listed = true
    for (id in down) {
      for (w in watchers) if (w.sourceId == id) runCatching { w.call() }
    }
  }

  override fun onDown(sourceId: String, call: () -> Unit): AutoCloseable {
    val w = Watcher(sourceId, call)
    watchers.add(w)
    return AutoCloseable { watchers.remove(w) }
  }
}
