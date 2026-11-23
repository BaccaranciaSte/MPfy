package com.baccarancia.mpfy

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * The like state outside the page: the heart of the media notification, the lock screen and the
 * car ([LikeAction]), and the page's setLiked, which keeps the queue items and the car's snapshot
 * in step with every like change it sees.
 */
object Likes {
  const val COMMAND = "mpfy.like"
  private const val TAG = "MPfyLikes"
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private var app: Context? = null

  /** The pages, told { type: 'liked', id, liked, likedIds, ok }. */
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

  /** The player's side: every queue item of a song takes a new like state. Set by the PlaybackService; main thread. */
  var queue: ((String, Boolean, List<String>) -> Unit)? = null

  fun init(ctx: Context) {
    app = ctx.applicationContext
  }

  fun addListener(l: (String) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (String) -> Unit) {
    listeners.remove(l)
  }

  private val effects = object : LikeEffects {
    override fun setLiked(id: String, liked: Boolean, likedIds: List<String>) {
      main.post { queue?.invoke(id, liked, likedIds) }
    }

    override fun snapshotChanged(s: Snapshot) = Browse.persist(s)

    override fun childrenChanged(parentId: String) = Browse.notifyChanged(parentId)

    override fun told(id: String, liked: Boolean, likedIds: List<String>, ok: Boolean, wasLiked: Boolean) {
      val e = JSONObject().put("type", "liked").put("id", id).put("liked", liked).put("likedIds", JSONArray(likedIds)).put("ok", ok).toString()
      for (l in listeners) l(e)
      if (!ok) {
        Log.w(TAG, "the heart on $id failed")
        main.post {
          // With no page to say it, the page's own words.
          if (!Playback.uiAttached) app?.let { Toast.makeText(it, it.getString(if (wasLiked) R.string.like_not_removed else R.string.like_not_saved), Toast.LENGTH_SHORT).show() }
        }
      }
    }
  }

  private val action = LikeAction(CoreHost.gate, CoreHttp, Browse.state, effects)

  /** setLiked from the page: the queue items of [id] and the snapshot's map. Any thread. */
  fun fromPage(id: String, liked: Boolean, likedIds: List<String>) {
    Browse.state.setLiked(id, liked, likedIds)
    main.post { queue?.invoke(id, liked, likedIds) }
  }

  /** The heart on the item playing, on the principal. [done] runs on the main thread with the outcome. */
  fun toggle(groupId: String, liked: Boolean, likedIds: List<String>, done: (Boolean) -> Unit) {
    worker.execute {
      val ok = try {
        action.toggle(groupId, liked, likedIds)
      } catch (e: Exception) {
        Log.w(TAG, "heart", e)
        false
      }
      main.post { done(ok) }
    }
  }
}

/**
 * Requests to the core with the app's token, each within its timeout: [send] for a bodiless PUT or
 * DELETE (the status), [json] for a JSON body and answer (the reporter of what plays).
 */
object CoreHttp : CoreRequests, CoreJson {
  private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "mpfy-http-timer").apply { isDaemon = true } }

  /** At most this much of an answer is read. */
  const val MAX_ANSWER = 1 shl 20

  override fun json(method: String, url: String, body: String?, timeoutMs: Int): Pair<Int, String> = jsonWith(CoreHost.token, method, url, body, timeoutMs)

  /**
   * [json] with the token given: the same User-Agent and watchdog as [send], Content-Type
   * application/json and a fixed-length body when there is one, the answer as UTF-8 (at most
   * [MAX_ANSWER] bytes, the rest left unread). IOException when nothing answered.
   */
  fun jsonWith(token: String, method: String, url: String, body: String?, timeoutMs: Int): Pair<Int, String> {
    val c = URL(url).openConnection() as HttpURLConnection
    val watchdog = timer.schedule({ c.disconnect() }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
    try {
      c.requestMethod = method
      c.connectTimeout = timeoutMs
      c.readTimeout = timeoutMs
      c.instanceFollowRedirects = false
      c.useCaches = false
      c.setRequestProperty("User-Agent", "MPfy")
      c.setRequestProperty(CoreHost.TOKEN_HEADER, token)
      c.setRequestProperty("Accept", "application/json")
      if (body != null) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.setFixedLengthStreamingMode(bytes.size)
        c.outputStream.use { it.write(bytes) }
      }
      val status = c.responseCode
      val text = runCatching { (if (status >= 400) c.errorStream else c.inputStream)?.use { readUpTo(it, MAX_ANSWER) } }.getOrNull() ?: ""
      return status to text
    } finally {
      watchdog.cancel(false)
      c.disconnect()
    }
  }

  private fun readUpTo(input: java.io.InputStream, max: Int): String {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < max) {
      val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return String(out.toByteArray(), Charsets.UTF_8)
  }

  override fun send(method: String, url: String, timeoutMs: Int): Int {
    val c = URL(url).openConnection() as HttpURLConnection
    val watchdog = timer.schedule({ c.disconnect() }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
    try {
      c.requestMethod = method
      c.connectTimeout = timeoutMs
      c.readTimeout = timeoutMs
      c.instanceFollowRedirects = false
      c.useCaches = false
      c.setRequestProperty("User-Agent", "MPfy")
      c.setRequestProperty(CoreHost.TOKEN_HEADER, CoreHost.token)
      if (method == "PUT") {
        c.doOutput = true
        c.setFixedLengthStreamingMode(0)
        c.outputStream.close()
      }
      val status = c.responseCode
      runCatching { (if (status >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() } }
      return status
    } finally {
      watchdog.cancel(false)
      c.disconnect()
    }
  }
}
