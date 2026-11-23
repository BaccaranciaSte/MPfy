package com.baccarancia.mpfy

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The stream cache: what the whole-song prefetch fetched, read by the player before the
 * network. Only the prefetch writes it. It also keeps, per key, the ETag of the first response
 * (the representation guard) and the level the source served.
 */
@OptIn(UnstableApi::class)
object StreamCache : Representations {
  private const val TAG = "MPfyStreamCache"
  private const val MAX_BYTES = 1L shl 30
  private const val ETAG = "mpfy-etag"
  private const val LEVEL = "mpfy-level"
  private var cache: SimpleCache? = null
  private val lock = Any()
  private val generations = HashMap<String, Int>()
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "MPfyStreamCache").apply { isDaemon = true } }

  // Key -> level its source served, most recent last.
  private val served = object : LinkedHashMap<String, String>(64, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 500
  }

  @Synchronized
  fun cache(ctx: Context): SimpleCache = cache
    ?: SimpleCache(File(ctx.applicationContext.filesDir, "stream-cache"), LeastRecentlyUsedCacheEvictor(MAX_BYTES), Downloads.db(ctx)).also { cache = it }

  private fun cacheOrNull(): SimpleCache? = synchronized(this) { cache }

  /** Bytes the stream cache takes. */
  fun space(): Long = runCatching { cacheOrNull()?.cacheSpace ?: 0L }.getOrDefault(0L)

  fun noteServed(key: String, level: String) {
    synchronized(served) { served[key] = level }
  }

  /**
   * The level of the bytes the prefetch is writing under [key], kept with them in the cache like
   * the ETag: a song played from the cache after the app was closed still says its quality.
   */
  fun noteCachedLevel(key: String, level: String) {
    noteServed(key, level)
    val c = cacheOrNull() ?: return
    synchronized(lock) {
      try {
        if (c.getContentMetadata(key).get(LEVEL, null as String?) != level) {
          c.applyContentMetadataMutations(key, ContentMetadataMutations().set(LEVEL, level))
        }
      } catch (e: Exception) {
        Log.w(TAG, "level not stored", e)
      }
    }
  }

  /** The level last served under [key] in this run, else the one kept with its cached bytes. */
  fun servedOf(key: String): String? = synchronized(served) { served[key] }
    ?: runCatching { cacheOrNull()?.getContentMetadata(key)?.get(LEVEL, null as String?) }.getOrNull()?.takeIf { it in Levels.ALL }

  override fun generation(key: String): Int = synchronized(generations) { generations[key] ?: 0 }

  override fun etagOf(key: String): String? = runCatching { cacheOrNull()?.getContentMetadata(key)?.get(ETAG, null as String?) }.getOrNull()

  override fun admit(key: String, etag: String?): Boolean {
    if (etag == null) return true
    val c = cacheOrNull() ?: return true
    synchronized(lock) {
      val stored = runCatching { c.getContentMetadata(key).get(ETAG, null as String?) }.getOrNull()
      if (stored != null) return stored == etag
      try {
        c.applyContentMetadataMutations(key, ContentMetadataMutations().set(ETAG, etag))
      } catch (e: Exception) {
        Log.w(TAG, "etag not stored", e)
      }
      return true
    }
  }

  override fun invalidate(key: String) {
    synchronized(generations) { generations[key] = (generations[key] ?: 0) + 1 }
    Log.i(TAG, "another representation under $key: dropping it")
    Prefetch.cancelKey(key)
    removeKey(key)
  }

  /** Every cached byte of [key], its ETag and its level. */
  fun removeKey(key: String) {
    val c = cacheOrNull() ?: return
    synchronized(served) { served.remove(key) }
    synchronized(lock) {
      try {
        c.removeResource(key)
        val meta = c.getContentMetadata(key)
        if (meta.get(ETAG, null as String?) != null || meta.get(LEVEL, null as String?) != null) {
          c.applyContentMetadataMutations(key, ContentMetadataMutations().remove(ETAG).remove(LEVEL))
        }
      } catch (e: Exception) {
        Log.w(TAG, "remove $key", e)
      }
    }
  }

  /** "Svuota cache": everything but [keep] (the items playing and next). Off the caller's thread; [done] after. */
  fun clear(keep: Set<String>, done: () -> Unit) {
    worker.execute {
      val c = cacheOrNull()
      var n = 0
      if (c != null) {
        for (k in c.keys.toList()) {
          if (k in keep) continue
          removeKey(k)
          n++
        }
      }
      Log.i(TAG, "cache cleared: $n keys, ${keep.size} kept")
      done()
    }
  }
}

/** "Memoria": downloads and stream cache, for getStorage() and the storage event. */
object Storage {
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

  fun addListener(l: (String) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (String) -> Unit) {
    listeners.remove(l)
  }

  fun json(): JSONObject = JSONObject()
    .put("downloadsBytes", Downloads.space())
    .put("downloadsCount", Downloads.count)
    .put("cacheBytes", StreamCache.space())

  /** The sizes changed: the page hears it. */
  fun changed() {
    if (listeners.isEmpty()) return
    val s = json().put("type", "storage").toString()
    for (l in listeners) l(s)
  }
}
