package com.baccarancia.mpfy

import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/*
 * Covers outside the page (notification, lock screen, Bluetooth, the car), free of Android classes:
 * the one artwork rule of every item, and the provider's paths, cache and fetch. ArtProvider is the
 * ContentProvider around them.
 */

object Artwork {
  const val AUTHORITY = "com.baccarancia.mpfy.art"
  // A source's 8 hex, or the phone's own music (its covers come from the core too).
  private val SOURCE = Regex("[0-9a-f]{8}|${LocalSource.ID}")
  private val COVER = Regex("[0-9a-f]{24}")
  private val SIZES = setOf("small", "large")

  /** One cover at one size. */
  data class Key(val sourceId: String, val coverId: String, val size: String) {
    val fileName: String get() = "$coverId.$size"

    /** The ETag of the sized image (the original a source serves meanwhile has "<coverId>"). */
    val etag: String get() = "\"$coverId.$size\""

    val uri: String get() = contentUri(sourceId, coverId, size)
  }

  fun contentUri(sourceId: String, coverId: String, size: String) = "content://$AUTHORITY/cover/$sourceId/$coverId/$size"

  /** The provider's path /cover/<8 hex, or 0000>/<24 hex>/<small|large>, or null. */
  fun keyOf(path: String?): Key? {
    val p = path?.split('/') ?: return null
    if (p.size != 5 || p[0].isNotEmpty() || p[1] != "cover") return null
    if (!SOURCE.matches(p[2]) || !COVER.matches(p[3]) || p[4] !in SIZES) return null
    return Key(p[2], p[3], p[4])
  }

  /**
   * The artwork of an item, whatever path built it: an own cover URL of the core becomes our
   * content URI (the size kept, large when missing), our content URI is kept, anything else
   * (another host, another app's content) is none.
   */
  fun of(url: String?): String? {
    if (url.isNullOrEmpty()) return null
    val u = try {
      URI(url)
    } catch (e: Exception) {
      return null
    }
    if (u.rawFragment != null || u.rawUserInfo != null) return null
    if (u.scheme == "content") {
      if (u.rawAuthority != AUTHORITY || u.rawQuery != null) return null
      return keyOf(u.rawPath)?.uri?.takeIf { it == url }
    }
    if (u.scheme != "http" || u.host != "127.0.0.1" || u.port != CORE_PORT) return null
    val p = (u.rawPath ?: return null).split('/')
    if (p.size != 6 || p[0].isNotEmpty() || p[1] != "s" || p[3] != "api" || p[4] != "cover") return null
    if (!SOURCE.matches(p[2]) || !COVER.matches(p[5])) return null
    val size = u.rawQuery?.split('&')?.firstOrNull { it.startsWith("size=") }?.substringAfter('=')?.takeIf { it in SIZES } ?: "large"
    return contentUri(p[2], p[5], size)
  }

  /** The image type of a file's first bytes: image/jpeg, image/png or image/webp, else null. */
  fun typeOf(head: ByteArray, n: Int = head.size): String? {
    fun at(i: Int) = if (i < n) head[i].toInt() and 0xff else -1
    if (at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff) return "image/jpeg"
    if (at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4e && at(3) == 0x47 && at(4) == 0x0d && at(5) == 0x0a && at(6) == 0x1a && at(7) == 0x0a) return "image/png"
    if (at(0) == 'R'.code && at(1) == 'I'.code && at(2) == 'F'.code && at(3) == 'F'.code && at(8) == 'W'.code && at(9) == 'E'.code && at(10) == 'B'.code && at(11) == 'P'.code) return "image/webp"
    return null
  }

  fun typeOf(f: File): String? = try {
    val b = ByteArray(12)
    val n = f.inputStream().use { it.read(b) }
    typeOf(b, n.coerceAtLeast(0))
  } catch (e: IOException) {
    null
  }
}

/**
 * The covers fetched for the provider: cacheDir/art/<coverId>.<size>, least recently used out
 * past [maxBytes]. Any thread.
 */
class ArtCache(val dir: File, private val maxBytes: Long = 64L * 1024 * 1024) {
  fun get(key: Artwork.Key): File? {
    val f = File(dir, key.fileName)
    if (!f.isFile) return null
    f.setLastModified(System.currentTimeMillis())
    return f
  }

  /** [tmp] becomes the cached file of [key], atomically. */
  @Synchronized
  fun put(key: Artwork.Key, tmp: File): File {
    val f = File(dir, key.fileName)
    if (!tmp.renameTo(f)) {
      tmp.delete()
      throw IOException("cannot keep ${key.fileName}")
    }
    f.setLastModified(System.currentTimeMillis())
    trim(f)
    return f
  }

  @Synchronized
  fun trim(keep: File? = null) {
    val files = dir.listFiles { f -> f.isFile && !f.name.endsWith(".tmp") }?.toList() ?: return
    var total = files.sumOf { it.length() }
    for (f in files.sortedBy { it.lastModified() }) {
      if (total <= maxBytes) break
      if (f == keep) continue
      val n = f.length()
      if (f.delete()) total -= n
    }
  }
}

/**
 * Fetches a cover the cache does not hold, one fetch per key at a time. Only the sized image
 * (its ETag "<coverId>.<size>") is cached; the original a source serves while that size is not
 * made yet comes back as a temporary file, fetched again next time. The provider is open to every
 * app: a source that is not one of ours is refused before anything is read, held or waited for,
 * and a source still down once the gate's wait is over is not asked.
 */
class ArtFetcher(
  private val cache: ArtCache,
  private val opener: Opener,
  private val gate: CoreGate,
  private val timer: ScheduledExecutorService,
  private val origin: String = ORIGIN,
  private val timeoutMs: Long = 8_000,
) {
  /** A file to serve: [temp] ones are deleted once opened. */
  data class Fetched(val file: File, val temp: Boolean)

  private val locks = ConcurrentHashMap<String, Any>()
  private val serial = AtomicLong()

  fun open(key: Artwork.Key): Fetched {
    if (!gate.isSource(key.sourceId)) throw FileNotFoundException("cover ${key.fileName}: not a source")
    cache.get(key)?.let { return Fetched(it, false) }
    val lock = locks.computeIfAbsent(key.fileName) { Any() }
    try {
      synchronized(lock) {
        cache.get(key)?.let { return Fetched(it, false) }
        return try {
          gate.use("art:${key.fileName}", key.sourceId) { up ->
            if (!up) throw IOException("source ${key.sourceId} not reachable")
            fetch(key)
          }
        } catch (e: IOException) {
          throw FileNotFoundException("cover ${key.fileName}: ${e.message}")
        }
      }
    } finally {
      locks.remove(key.fileName, lock)
    }
  }

  private fun fetch(key: Artwork.Key): Fetched {
    val url = "$origin/s/${key.sourceId}/api/cover/${key.coverId}?size=${key.size}"
    val began = System.nanoTime()
    val r = opener.open(url, emptyMap())
    // The whole fetch, head included, within the timeout.
    val left = timeoutMs - (System.nanoTime() - began) / 1_000_000
    val watchdog = timer.schedule({ r.abort() }, left.coerceAtLeast(0), TimeUnit.MILLISECONDS)
    cache.dir.mkdirs()
    val tmp = File(cache.dir, "${key.fileName}.${serial.incrementAndGet()}.tmp")
    try {
      if (r.status != 200) throw IOException("HTTP ${r.status}")
      if (r.length > MAX_BYTES) throw IOException("too large")
      val buf = ByteArray(16 * 1024)
      var total = 0L
      FileOutputStream(tmp).use { out ->
        while (true) {
          val n = r.read(buf, 0, buf.size)
          if (n < 0) break
          total += n
          if (total > MAX_BYTES) throw IOException("too large")
          out.write(buf, 0, n)
        }
      }
      if (Artwork.typeOf(tmp) == null) throw IOException("not an image")
      return if (r.etag == key.etag) Fetched(cache.put(key, tmp), false) else Fetched(tmp, true)
    } catch (e: IOException) {
      tmp.delete()
      throw e
    } finally {
      watchdog.cancel(false)
      r.close()
    }
  }

  companion object {
    const val MAX_BYTES = 16L * 1024 * 1024
  }
}
