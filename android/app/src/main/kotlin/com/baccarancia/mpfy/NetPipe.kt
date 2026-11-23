package com.baccarancia.mpfy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.net.URL
import java.util.Base64
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/*
 * The HTTPS of the phone's own songs' lookups (details from MusicBrainz and the Cover Art Archive,
 * lyrics from LRCLIB): the core asks ({ t: 'net', id, service, url, kind }) and gets its answer back
 * ({ t: 'net-reply', id, status, retryAfter, json | cover | error }). Only to those three services,
 * with exactly the source's User-Agent and an Accept, only on Wi-Fi or another unmetered network
 * with neither Data Saver nor battery saver on, each body capped as the source caps it. Free of
 * Android classes but [Lookups].
 */

/** One GET as a lookup makes it: its status, its redirect's Location, its Retry-After, its body (null past the cap). */
class Fetched(val status: Int, val location: String?, val retryAfter: String?, val body: ByteArray?)

/** One HTTPS GET with exactly [headers], no redirect followed, the body read up to [cap] bytes. Throws when nothing answered. */
fun interface Fetch {
  fun get(url: String, headers: Map<String, String>, cap: Long): Fetched
}

/** A cover as the core keeps it: the picture's two sizes (160 and 640 px boxes) as JPEGs, or null when it does not decode. */
fun interface CoverSizes {
  fun make(image: ByteArray): Pair<ByteArray, ByteArray>?
}

/** What may be asked, where, with which headers, and on which network. */
object NetRules {
  private val PREFIX = mapOf(
    "musicbrainz" to ("musicbrainz.org" to "/ws/2/"),
    "caa" to ("coverartarchive.org" to "/"),
    "lrclib" to ("lrclib.net" to "/api/"),
  )

  // The source's caps (server/details.mjs, server/lyrics.mjs).
  private val CAP = mapOf("musicbrainz" to (4L shl 20), "caa" to CoverArt.MAX_COVER_BYTES.toLong(), "lrclib" to (1L shl 20))

  /** Between two requests to MusicBrainz, and between two to the Cover Art Archive: every phone at home shares one address. */
  const val GAP_MS = 3_000L
  private val PACED = setOf("musicbrainz", "caa")

  const val MAX_REDIRECTS = 5

  fun userAgent(version: String) = "MPfy/$version ( https://github.com/BaccaranciaSte/MPfy )"

  fun headers(kind: String, userAgent: String): Map<String, String> =
    linkedMapOf("User-Agent" to userAgent, "Accept" to if (kind == "cover") "image/*" else "application/json")

  fun capOf(service: String): Long? = CAP[service]

  fun paced(service: String) = service in PACED

  /** The first request of a lookup: the service's own host, over HTTPS, under its path. */
  fun allowed(service: String, url: String): Boolean {
    val (host, path) = PREFIX[service] ?: return false
    val u = plain(url) ?: return false
    return u.host == host && u.rawPath.startsWith(path)
  }

  /** Where an answer may send it: the Cover Art Archive to the Internet Archive that keeps its pictures; nothing else moves. */
  fun redirectAllowed(service: String, url: String): Boolean {
    if (allowed(service, url)) return true
    if (service != "caa") return false
    val u = plain(url) ?: return false
    val h = u.host
    return h == "archive.org" || h.endsWith(".archive.org")
  }

  /** Only an unmetered network that is not a phone's mobile data, with neither saver on. */
  fun mayUse(type: String, metered: Boolean, dataSaver: Boolean, batterySaver: Boolean): Boolean =
    (type == "wifi" || type == "ethernet") && !metered && !dataSaver && !batterySaver

  // An https URL with a lowercase host, no user, no port but 443, and a path with no dot segment.
  private fun plain(url: String): URI? {
    val u = try {
      URI(url)
    } catch (e: Exception) {
      return null
    }
    if (u.scheme != "https" || u.rawUserInfo != null || u.rawFragment != null) return null
    if (u.port != -1 && u.port != 443) return null
    val host = u.host ?: return null
    if (host != host.lowercase()) return null
    val path = u.rawPath ?: return null
    if (path.split('/').any { it == "." || it == ".." || it.equals("%2e", true) || it.equals("%2e%2e", true) || it.equals(".%2e", true) || it.equals("%2e.", true) }) return null
    return u
  }
}

/**
 * One lookup's GET, answered as the core reads it. [mayUse] says whether the network may be used
 * now; MusicBrainz and the Cover Art Archive are each asked [NetRules.GAP_MS] apart at most (the
 * core paces them too). Blocking, one request per thread.
 */
class NetPipe(
  private val fetch: Fetch,
  private val covers: CoverSizes,
  private val mayUse: () -> Boolean,
  private val userAgent: String,
  private val clock: () -> Long,
  private val sleep: (Long) -> Unit,
) {
  private val last = HashMap<String, Long>()

  fun answer(id: Any?, service: String, url: String, kind: String): Map<String, Any?> {
    val reply = linkedMapOf<String, Any?>("t" to "net-reply", "id" to id)
    val cap = NetRules.capOf(service)
    if (cap == null || !NetRules.allowed(service, url) || (kind != "json" && kind != "cover")) return reply.also { it["error"] = "not_allowed" }
    if (!mayUse()) return reply.also { it["error"] = "metered" }
    if (NetRules.paced(service)) {
      val wait = synchronized(last) {
        val now = clock()
        val at = maxOf(now, (last[service] ?: Long.MIN_VALUE / 2) + NetRules.GAP_MS)
        last[service] = at
        at - now
      }
      if (wait > 0) sleep(wait)
      if (!mayUse()) return reply.also { it["error"] = "metered" }
    }
    val headers = NetRules.headers(kind, userAgent)
    var target = url
    var hops = 0
    var f = fetchOrNull(target, headers, cap) ?: return reply.also { it["error"] = "network" }
    // Redirects are followed here, each checked before it is asked.
    while (f.status in REDIRECTS) {
      val loc = f.location ?: break
      val next = try {
        URI(target).resolve(loc).toString()
      } catch (e: Exception) {
        return reply.also { it["error"] = "not_allowed" }
      }
      if (!NetRules.redirectAllowed(service, next)) return reply.also { it["error"] = "not_allowed" }
      if (++hops > NetRules.MAX_REDIRECTS) return reply.also { it["error"] = "network" }
      target = next
      f = fetchOrNull(target, headers, cap) ?: return reply.also { it["error"] = "network" }
    }
    if (f.status in 200..299 && f.body == null) return reply.also { it["error"] = "too_large" }
    reply["status"] = f.status
    reply["retryAfter"] = f.retryAfter
    if (f.status == 200) {
      val body = f.body ?: ByteArray(0)
      if (kind == "json") reply["json"] = String(body, Charsets.UTF_8) else reply["cover"] = coverOf(body)
    }
    return reply
  }

  private fun fetchOrNull(url: String, headers: Map<String, String>, cap: Long): Fetched? = try {
    fetch.get(url, headers, cap)
  } catch (e: IOException) {
    null
  }

  // The picture's id as a source makes it from the same bytes, and its two sizes; null when it is none.
  private fun coverOf(image: ByteArray): Map<String, Any?>? {
    val id = CoverArt.coverId(image) ?: return null
    val (small, large) = covers.make(image) ?: return null
    val b64 = Base64.getEncoder()
    return linkedMapOf("coverId" to id, "small" to b64.encodeToString(small), "large" to b64.encodeToString(large))
  }

  companion object {
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)
  }
}

/**
 * The lookups on Android: the core's requests answered on two background threads (details and
 * lyrics each have one in flight), the network read from ConnectivityManager and PowerManager at
 * each request. A refusal for the network pauses the core's lookups until it hears `network`:
 * CoreHost sends it at a switch of network, and here when battery saver or Data Saver went off
 * after a refusal. Nothing runs at rest.
 */
object Lookups {
  private const val TAG = "MPfyLookups"
  private const val TIMEOUT_MS = 20_000

  private lateinit var app: Context
  private val exec = Executors.newFixedThreadPool(2) { r ->
    Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
      r.run()
    }, "MPfyLookups").apply { isDaemon = true }
  }
  @Volatile private var refused = false
  private var watching = false

  private val pipe: NetPipe by lazy {
    val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: ""
    NetPipe({ u, h, c -> get(u, h, c) }, { sizes(it) }, { mayUse() }, NetRules.userAgent(version), { SystemClock.elapsedRealtime() }, { Thread.sleep(it) })
  }

  fun init(ctx: Context) {
    if (::app.isInitialized) return
    app = ctx.applicationContext
  }

  /** The core's request [m] from worklet [number]: answered to that worklet, off the caller's thread. */
  fun request(number: Long, m: JSONObject) {
    if (!::app.isInitialized) return
    val id: Any? = m.opt("id")
    val service = m.optString("service")
    val url = m.optString("url")
    val kind = m.optString("kind")
    exec.execute {
      val reply = try {
        pipe.answer(if (id is Number) id.toLong() else id?.toString(), service, url, kind)
      } catch (e: Exception) {
        linkedMapOf("t" to "net-reply", "id" to (if (id is Number) id.toLong() else id?.toString()), "error" to "network")
      }
      if (reply["error"] == "metered") onRefused()
      Log.i(TAG, "$service ${reply["status"] ?: reply["error"]}")
      CoreHost.sendTo(number, Json.write(reply))
    }
  }

  private fun mayUse(): Boolean {
    val s = Net.state
    val cm = app.getSystemService(ConnectivityManager::class.java)
    val dataSaver = cm?.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    val batterySaver = app.getSystemService(PowerManager::class.java)?.isPowerSaveMode == true
    return NetRules.mayUse(s.type, s.metered, dataSaver, batterySaver)
  }

  // Refused while a saver was on: when it goes off, the core hears it (a switch of network it hears from CoreHost).
  private fun onRefused() {
    refused = true
    synchronized(this) {
      if (watching) return
      watching = true
    }
    val filter = IntentFilter().apply {
      addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
      addAction(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED)
    }
    ContextCompat.registerReceiver(app, savers, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  private val savers = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (!refused || !mayUse()) return
      refused = false
      synchronized(this@Lookups) { watching = false }
      runCatching { app.unregisterReceiver(this) }
      CoreHost.send(JSONObject().put("t", "network"))
    }
  }

  private fun get(url: String, headers: Map<String, String>, cap: Long): Fetched {
    val c = URL(url).openConnection() as HttpsURLConnection
    try {
      c.instanceFollowRedirects = false
      c.useCaches = false
      c.connectTimeout = TIMEOUT_MS
      c.readTimeout = TIMEOUT_MS
      for ((k, v) in headers) c.setRequestProperty(k, v)
      val status = c.responseCode
      val location = c.getHeaderField("Location")
      val retryAfter = c.getHeaderField("Retry-After")
      if (status !in 200..299) return Fetched(status, location, retryAfter, ByteArray(0))
      val declared = c.contentLengthLong
      if (declared > cap) return Fetched(status, location, retryAfter, null)
      val out = ByteArrayOutputStream()
      val buf = ByteArray(16 * 1024)
      c.inputStream.use { input ->
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          if (out.size() + n > cap) return Fetched(status, location, retryAfter, null)
          out.write(buf, 0, n)
        }
      }
      return Fetched(status, location, retryAfter, out.toByteArray())
    } finally {
      c.disconnect()
    }
  }

  private fun sizes(image: ByteArray): Pair<ByteArray, ByteArray>? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(image, 0, image.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= CoverArt.LARGE && bounds.outHeight / (sample * 2) >= CoverArt.LARGE) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(image, 0, image.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    try {
      val large = jpeg(bmp, CoverArt.LARGE) ?: return null
      val small = jpeg(bmp, CoverArt.SMALL) ?: return null
      return small to large
    } finally {
      bmp.recycle()
    }
  }

  private fun jpeg(bmp: Bitmap, px: Int): ByteArray? {
    val (w, h) = CoverArt.fit(bmp.width, bmp.height, px)
    val b = if (w == bmp.width && h == bmp.height) bmp else Bitmap.createScaledBitmap(bmp, w, h, true)
    try {
      val out = ByteArrayOutputStream()
      return if (b.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) out.toByteArray() else null
    } finally {
      if (b !== bmp) b.recycle()
    }
  }

  private const val JPEG_QUALITY = 85
}
