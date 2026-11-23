package com.baccarancia.mpfy

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Scheduler
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Offline downloads: Media3 DownloadManager into one SimpleCache, which the player
 * reads from too. A download is one version of a track at one level: its id and cache key are both
 * trackId:fileHash:quality (older two-part ones, trackId:quality, read as the track's first file), so a
 * version downloaded in Max plays offline whatever level streaming would pick, and only for its own
 * file. The quality in the key is the level the source served: a download whose source answered
 * with another level (the one asked not ready) moves to that level's key
 * ([LevelCheckDataSource]). Process-wide singletons (one SimpleCache per folder, or it throws); the
 * manager and the snapshot live on the main thread.
 */
@OptIn(UnstableApi::class)
object Downloads {
  private const val TAG = "MPfyDownloads"
  // DownloadRequest.data of a download already moved to the level its source served.
  private val MOVED = "moved".encodeToByteArray()
  private var app: Context? = null
  private var db: StandaloneDatabaseProvider? = null
  private var cache: SimpleCache? = null
  private var manager: DownloadManager? = null
  private val main = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()
  private val pollTask = Runnable { refresh(readIndex = false) }
  // Keys of the downloads being moved to another level. Main thread.
  private val moving = HashSet<String>()
  // What a removal must reach that the manager may not show yet. Main thread.
  private val handoff = DownloadHandoff()

  /** Cache keys of the finished downloads. */
  @Volatile
  private var completed: Set<String> = emptySet()

  /**
   * listDownloads() and the "downloads" event: { type, ids, items: [{ trackId, fileHash, quality }],
   * progress: { trackId: 0..100 }, bytes }.
   */
  @Volatile
  var snapshot: String = "{\"type\":\"downloads\",\"ids\":[],\"items\":[],\"progress\":{},\"bytes\":0}"
    private set

  fun isDownloaded(key: String) = key in completed

  /** Finished downloads, counted per track. */
  val count: Int get() = completed.mapNotNull { Levels.parse(it)?.trackId }.distinct().size

  /** Bytes the downloads take. */
  fun space(): Long = runCatching { cache?.cacheSpace ?: 0L }.getOrDefault(0L)

  /** The keys of the finished downloads, for the player's choice of cache key (any thread). */
  val completedKeys: Set<String> get() = completed

  fun addListener(l: (String) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (String) -> Unit) {
    listeners.remove(l)
  }

  @Synchronized
  fun db(ctx: Context) = db ?: StandaloneDatabaseProvider(ctx.applicationContext).also { db = it }

  @Synchronized
  fun cache(ctx: Context) = cache
    ?: SimpleCache(File(ctx.applicationContext.filesDir, "downloads"), NoOpCacheEvictor(), db(ctx)).also { cache = it }

  /** Call first on the main thread (MPfyApp.onCreate). */
  @Synchronized
  fun manager(ctx: Context): DownloadManager = manager ?: run {
    val appContext = ctx.applicationContext
    app = appContext
    // Through the P2P link a reconnect can take seconds: generous timeouts.
    val http = DefaultHttpDataSource.Factory()
      .setConnectTimeoutMs(30_000)
      .setReadTimeoutMs(30_000)
      .setUserAgent("MPfy")
      .setDefaultRequestProperties(CoreHost.requestHeaders)
    DownloadManager(
      appContext,
      db(appContext),
      cache(appContext),
      LevelCheckDataSource.Factory(http) { key, served -> main.post { move(key, served) } },
      Executors.newFixedThreadPool(2),
    ).apply {
      maxParallelDownloads = 2
      minRetryCount = 5
      addListener(
        object : DownloadManager.Listener {
          override fun onDownloadChanged(m: DownloadManager, d: Download, e: Exception?) {
            if (d.state == Download.STATE_FAILED) {
              Log.w(TAG, "download failed: ${d.request.id}", e)
              // The page forgets a failed download, so nothing else would ever remove it: its
              // partial bytes would stay in the cache for good (and in the space shown), and a
              // retry would build on them.
              m.removeDownload(d.request.id)
            }
            refresh(readIndex = true)
          }

          override fun onDownloadRemoved(m: DownloadManager, d: Download) {
            moving.remove(d.request.id)
            refresh(readIndex = true)
          }

          override fun onInitialized(m: DownloadManager) {
            removeFailed(m)
            refresh(readIndex = true)
            app?.let { onForeground(it) }
          }
        },
      )
      // A new manager starts paused, and only DownloadService.onCreate resumes it (Media3
      // 1.11.1): a download cut off by the end of the process came back queued and stayed so,
      // and one added while the service had never run did not start.
      resumeDownloads()
    }.also { manager = it }
  }

  /** Failed downloads of an earlier process, still in the index with their partial bytes. */
  private fun removeFailed(m: DownloadManager) {
    val ids = ArrayList<String>()
    try {
      m.downloadIndex.getDownloads(Download.STATE_FAILED).use { c ->
        while (c.moveToNext()) ids.add(c.download.request.id)
      }
    } catch (e: Exception) {
      Log.w(TAG, "download index", e)
    }
    for (id in ids) m.removeDownload(id)
  }

  /**
   * Rebuilds the snapshot and tells the page; polls every second while something downloads.
   * [readIndex]: read the finished downloads again (after a change; the poll only needs progress).
   */
  private fun refresh(readIndex: Boolean) {
    val m = manager ?: return
    if (readIndex) {
      val keys = HashSet<String>()
      try {
        m.downloadIndex.getDownloads(Download.STATE_COMPLETED).use { c ->
          while (c.moveToNext()) keys.add(c.download.request.id)
        }
      } catch (e: Exception) {
        Log.w(TAG, "download index", e)
      }
      completed = keys
    }
    val ids = JSONArray()
    val items = JSONArray()
    val parsed = completed.mapNotNull { Levels.parse(it) }
    for (id in parsed.map { it.trackId }.distinct()) ids.put(id)
    for (d in parsed) items.put(JSONObject().put("trackId", d.trackId).put("fileHash", d.fileHash).put("quality", d.level))
    val progress = JSONObject()
    var active = false
    val notMet = m.notMetRequirements
    for (d in m.currentDownloads) {
      if (!DownloadPolicy.isUnfinished(d.state)) continue
      active = active || DownloadPolicy.isActive(d.state, notMet)
      val track = d.request.id.substringBefore(':')
      val pct = d.percentDownloaded.let { if (it.isNaN() || it < 0) 0 else it.coerceIn(0f, 100f).toInt() }
      progress.put(track, maxOf(pct, progress.optInt(track, 0)))
    }
    snapshot = JSONObject().put("type", "downloads").put("ids", ids).put("items", items).put("progress", progress).put("bytes", space()).toString()
    Keeper.setDownloading(active)
    for (l in listeners) l(snapshot)
    if (readIndex) Storage.changed()
    main.removeCallbacks(pollTask)
    if (active) main.postDelayed(pollTask, 1_000)
  }

  /**
   * [items]: [{ id, trackId, fileHash, url, quality }] from the page. The key and the request id
   * are trackId:fileHash:quality; an older page sends only id (the track, its first file). Main thread.
   */
  fun add(ctx: Context, items: JSONArray) {
    val m = manager(ctx)
    var added = 0
    for (i in 0 until items.length()) {
      val o = items.optJSONObject(i) ?: continue
      // A song of the phone is its file already: never downloaded.
      if (DownloadPolicy.refuses(o.optString("url"))) continue
      val trackId = o.optString("trackId").ifEmpty { o.optString("id") }
      val fileHash = o.optString("fileHash").ifEmpty { trackId }
      val q = o.optString("quality").takeIf { it in Playback.LEVELS } ?: "max"
      val uri = Playback.ownUri(o.optString("url"))
      if (!Levels.isId(trackId) || !Levels.isId(fileHash) || uri.toString().isEmpty()) continue
      val k = Levels.key(trackId, fileHash, q)
      handoff.handed(k)
      m.addDownload(DownloadRequest.Builder(k, uri).setCustomCacheKey(k).build())
      added++
    }
    if (added > 0) startService(ctx)
  }

  /** An Activity became visible: unfinished downloads (of an earlier process, or added in the background) get the service. Main thread. */
  fun onForeground(ctx: Context) {
    val m = manager ?: return
    if (m.currentDownloads.any { DownloadPolicy.isUnfinished(it.state) && it.state != Download.STATE_STOPPED }) startService(ctx)
  }

  /**
   * The service keeps the process alive (and in the foreground) while downloads run. It can only
   * be started while the app is visible; otherwise the manager works on by itself while the
   * process lives. Main thread.
   */
  private fun startService(ctx: Context) {
    if (!Keeper.inForeground) return
    try {
      DownloadService.start(ctx, MPfyDownloadService::class.java)
    } catch (e: Exception) {
      Log.w(TAG, "download service not started", e)
    }
  }

  /**
   * The source of the download stored under [key] served level [served] (from the data source's
   * thread). Its bytes belong under that level's key: a new download there replaces this one,
   * which is removed before it stores anything. A download a removal reached stays removed: the
   * new one would be left behind. Main thread.
   */
  private fun move(key: String, served: String) {
    val m = manager ?: return
    if (key in moving || !handoff.mayMove(key)) return
    val d = m.currentDownloads.firstOrNull { it.request.id == key } ?: return
    val target = Levels.moveTo(key, served, d.request.data.contentEquals(MOVED)) ?: return
    val level = Levels.ofKey(target) ?: return
    moving.add(key)
    Log.i(TAG, "download $key: the source served $level, moving it to $target")
    if (target !in completed) {
      handoff.handed(target)
      m.addDownload(DownloadRequest.Builder(target, withLevel(d.request.uri, level)).setCustomCacheKey(target).setData(MOVED).build())
    }
    m.removeDownload(key)
  }

  /** [uri] asking for [level] (?q=). */
  private fun withLevel(uri: Uri, level: String): Uri {
    val b = uri.buildUpon().clearQuery()
    var set = false
    for (name in uri.queryParameterNames) {
      for (value in uri.getQueryParameters(name)) {
        if (name != "q") {
          b.appendQueryParameter(name, value)
        } else if (!set) {
          b.appendQueryParameter("q", level)
          set = true
        }
      }
    }
    if (!set) b.appendQueryParameter("q", level)
    return b.build()
  }

  /**
   * Removes the downloads (finished or not) the selectors name, those just added too: the manager
   * removes in the order it was told, after the adds before. Main thread.
   */
  fun remove(ctx: Context, selectors: List<DownloadSelector>) {
    val m = manager(ctx)
    for (id in handoff.toRemove(stored(m), selectors)) m.removeDownload(id)
  }

  /** The keys of the index and of the manager's list. */
  private fun stored(m: DownloadManager): Set<String> {
    val keys = LinkedHashSet<String>()
    try {
      m.downloadIndex.getDownloads().use { c ->
        while (c.moveToNext()) keys.add(c.download.request.id)
      }
    } catch (e: Exception) {
      Log.w(TAG, "download index", e)
    }
    for (d in m.currentDownloads) keys.add(d.request.id)
    return keys
  }

  /** "Elimina download": every download. Main thread. */
  fun removeAll(ctx: Context) {
    val m = manager(ctx)
    moving.clear()
    handoff.dropAll(stored(m))
    m.removeAllDownloads()
  }

  fun notification(service: DownloadService, downloads: List<Download>, notMetRequirements: Int): Notification {
    val open = PendingIntent.getActivity(
      service,
      0,
      Intent(service, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return DownloadNotificationHelper(service, MPfyDownloadService.CHANNEL).buildProgressNotification(
      service,
      R.drawable.ic_stat_mpfy,
      open,
      null,
      downloads,
      notMetRequirements,
    )
  }
}

@OptIn(UnstableApi::class)
class MPfyDownloadService : DownloadService(
  FOREGROUND_ID,
  DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL,
  CHANNEL,
  R.string.channel_downloads,
  0,
) {
  override fun getDownloadManager(): DownloadManager = Downloads.manager(this)

  // Nothing reschedules downloads after the process dies; the next process resumes them
  // (Downloads.manager), and the next visible Activity starts this service for them.
  override fun getScheduler(): Scheduler? = null

  override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification =
    Downloads.notification(this, downloads, notMetRequirements)

  companion object {
    const val FOREGROUND_ID = 2001
    const val CHANNEL = "downloads"
  }
}

/**
 * The downloads' upstream. A download is stored under trackId:level, so its bytes must be of that
 * level; a source serves another one when the level asked is not ready (X-MPfy-Quality).
 * Then this refuses the bytes before any is stored, and reports the level served to
 * [onMismatch] (key, served), which moves the download to that level's key.
 */
@OptIn(UnstableApi::class)
class LevelCheckDataSource(
  private val upstream: HttpDataSource,
  private val onMismatch: (String, String) -> Unit,
) : DataSource {
  class Mismatch(key: String, served: String) : IOException("level $served served for $key")

  override fun addTransferListener(transferListener: TransferListener) = upstream.addTransferListener(transferListener)

  override fun open(dataSpec: DataSpec): Long {
    val length = upstream.open(dataSpec)
    val key = dataSpec.key ?: return length
    val served = Playback.servedLevel(upstream.responseHeaders) ?: return length
    if (Levels.moveTo(key, served, moved = false) == null) return length
    runCatching { upstream.close() }
    onMismatch(key, served)
    throw Mismatch(key, served)
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int = upstream.read(buffer, offset, length)

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() = upstream.close()

  class Factory(private val http: HttpDataSource.Factory, private val onMismatch: (String, String) -> Unit) : DataSource.Factory {
    override fun createDataSource(): DataSource = LevelCheckDataSource(http.createDataSource(), onMismatch)
  }
}
