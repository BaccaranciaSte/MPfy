package com.baccarancia.mpfy

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSink
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import java.util.concurrent.Executors

/**
 * The prefetch: one background CacheWriter, the only writer of the stream cache, reads the current
 * item from where the player reads it, then the next one. A source that drops mid-song then
 * changes nothing that can be heard. What to fetch and when is [PrefetchQueue]'s, on the main
 * thread, from where the player reads ([reads]) and what the cache holds; the writer runs on its own.
 */
@OptIn(UnstableApi::class)
object Prefetch : PrefetchQueue.Runner {
  private const val TAG = "MPfyPrefetch"
  private const val FRAGMENT_BYTES = 1L shl 20

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor { r ->
    Thread(r, "MPfyPrefetch").apply {
      isDaemon = true
      priority = Thread.MIN_PRIORITY
    }
  }
  private val queue = PrefetchQueue(this)
  private var app: Context? = null

  /** Where the player reads each song, told by the top of its chain (GuardedDataSource). */
  val reads = PlayerReads { key, opened -> main.post { queue.playerMoved(key, opened) } }

  fun init(ctx: Context) {
    if (app != null) return
    app = ctx.applicationContext
    // Back on a network after a tunnel, or on another one: what gave up meanwhile tries again, and the link is measured again.
    Net.addListener { s, switched -> if (switched && s.type != "none") queue.networkBack() }
  }

  /** The player's current and next items (null: nothing in the player) and whether it means to play. Main thread. */
  fun onPlayer(cur: PrefetchQueue.Item?, nxt: PrefetchQueue.Item?, playing: Boolean) = queue.onPlayer(cur, nxt, playing)

  /** An item prepared again with the same key (its representation changed): from scratch. Main thread. */
  fun restart(key: String) = queue.restart(key)

  /** Another representation turned up under [key]: its writer stops now, and it waits for its item to be prepared again. Any thread. */
  fun cancelKey(key: String) {
    queue.cancelRunning(key)
    main.post { queue.dropped(key) }
  }

  /** "Svuota cache": the writer stops while the cache is cleared. Main thread. */
  fun pause() = queue.clearing()

  /** After the clear: only [kept] keeps its bytes. Main thread. */
  fun resume(kept: Set<String>) = queue.cleared(kept)

  override fun start(job: PrefetchQueue.Job) {
    val ctx = app ?: return
    worker.execute {
      val (error, result) = run(ctx, job)
      main.post { queue.ended(job, error, result) }
    }
  }

  override fun later(ms: Long, task: Runnable) {
    main.postDelayed(task, ms)
  }

  override fun cancelLater(task: Runnable) {
    main.removeCallbacks(task)
  }

  override fun log(line: String) {
    Log.i(TAG, line)
  }

  override fun playerAt(key: String): Long = reads.position(key)

  override fun wakeAt(key: String, position: Long) = reads.wakeAt(key, position)

  override fun cachedFrom(key: String, position: Long): Long {
    val ctx = app ?: return 0
    return runCatching { StreamCache.cache(ctx).getCachedLength(key, position, Long.MAX_VALUE) }.getOrDefault(0L).coerceAtLeast(0L)
  }

  override fun sizeOf(key: String): Long {
    val ctx = app ?: return -1
    return runCatching { ContentMetadata.getContentLength(StreamCache.cache(ctx).getContentMetadata(key)) }.getOrDefault(C.LENGTH_UNSET.toLong())
  }

  private fun run(ctx: Context, job: PrefetchQueue.Job): Pair<Exception?, PrefetchQueue.Result?> {
    if (job.cancelled) return null to null
    val key = job.item.key
    val cache = StreamCache.cache(ctx)
    val generation = StreamCache.generation(key)
    val upstream = FailoverDataSource.Factory(
      onServed = { k, level ->
        StreamCache.noteCachedLevel(k, level)
        // On a metered network a source that fell back to a higher level is not fetched whole.
        if (PrefetchPolicy.stopsOnServed(Net.state.metered, job.item.level, level)) {
          job.metered = true
          job.cancel()
        }
      },
      // A skip or a pause ends the read at once, an open still waiting for its answer included.
      created = { s -> job.onCancel { s.cancel() } },
    )
    val source = CacheDataSource.Factory()
      .setCache(cache)
      .setCacheWriteDataSinkFactory(CacheDataSink.Factory().setCache(cache).setFragmentSize(FRAGMENT_BYTES))
      .setUpstreamDataSourceFactory(upstream)
      .createDataSourceForDownloading()
    val spec = DataSpec.Builder()
      .setUri(job.item.url)
      .setKey(key)
      .setPosition(job.from)
      .setLength(if (job.length < 0) C.LENGTH_UNSET.toLong() else job.length)
      .build()
    var fetched = 0L
    val writer = CacheWriter(source, spec, null) { _, bytesCached, newBytesCached ->
      job.done = bytesCached
      fetched += newBytesCached
    }
    job.onCancel { writer.cancel() }
    if (job.cancelled) return null to null
    val began = SystemClock.elapsedRealtime()
    return try {
      writer.cache()
      null to PrefetchQueue.Result(fetched, SystemClock.elapsedRealtime() - began, job.done)
    } catch (e: Exception) {
      e to null
    } finally {
      // Dropped meanwhile: a fragment committed after the drop goes too.
      if (StreamCache.generation(key) != generation) StreamCache.removeKey(key)
    }
  }
}

/**
 * Where the player reads each song: the byte its loader is at, told by the top of its chain for
 * every open and read. The prefetch fetches from there, and a fetch waiting for the player to come
 * nearer is woken from here, with no timer. [onMove] runs on the thread that read: an open
 * ([opened] true), or a read that passed the position asked by [wakeAt]. Any thread.
 */
class PlayerReads(private val max: Int = 32, private val onMove: (key: String, opened: Boolean) -> Unit) {
  /** One song as one load of the player reads it. */
  class At internal constructor(private val reads: PlayerReads, val key: String) {
    @Volatile var position = 0L
      internal set
    @Volatile internal var wake = Long.MAX_VALUE

    /** [n] bytes more read. */
    fun read(n: Int) {
      position += n
      if (position >= wake) {
        wake = Long.MAX_VALUE
        reads.onMove(key, false)
      }
    }
  }

  private val map = object : LinkedHashMap<String, At>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, At>?) = size > max
  }

  /** The player opened [key] at [position]: its reads go to what this returns. */
  fun opened(key: String, position: Long): At {
    val at = synchronized(map) { map.getOrPut(key) { At(this, key) } }
    at.position = position
    onMove(key, true)
    return at
  }

  /** The byte the player reads [key] at, or -1 when it did not open it. */
  fun position(key: String): Long = synchronized(map) { map[key] }?.position ?: -1

  /** [onMove] once the player reads [key] at [position] or past it (at once when it is there). */
  fun wakeAt(key: String, position: Long) {
    val at = synchronized(map) { map[key] } ?: return
    at.wake = position
    if (at.position >= position) {
      at.wake = Long.MAX_VALUE
      onMove(key, false)
    }
  }
}
