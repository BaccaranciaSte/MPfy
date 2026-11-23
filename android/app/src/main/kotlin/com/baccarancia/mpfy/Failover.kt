package com.baccarancia.mpfy

import java.io.EOFException
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/*
 * The byte reader under the player and the prefetch, free of Android classes: the
 * Media3 DataSource around it is in FailoverDataSource.kt.
 */

/** A source answered with an HTTP error status. */
class HttpStatusException(val status: Int) : IOException("HTTP $status")

/** Every version this read could use failed. [hasUntried]: the item still has a version the service has not tried. */
class VersionsExhaustedException(cause: IOException, val hasUntried: Boolean) : IOException("no version left: ${cause.message}", cause)

/** The source sent another representation under a key (another level, or a transcode made again). */
class RepresentationChangedException(val key: String) : IOException("another representation under $key")

/** The core took the request but no response head came: the source behind it says nothing. */
class NoAnswerException(cause: IOException) : IOException("no answer: ${cause.message}", cause)

/** One HTTP response of the core. */
interface Upstream {
  val status: Int
  val etag: String?

  /** X-MPfy-Quality: the level the source served. */
  val quality: String?

  /** Body bytes announced (Content-Length), or -1. */
  val length: Long

  /** The whole resource's size from a 416's Content-Range, or -1. */
  val totalSize: Long

  /** -1 at the end of the body. */
  fun read(buffer: ByteArray, offset: Int, length: Int): Int

  /** Unblocks a read in progress, from any thread; every read after it fails. */
  fun abort()

  fun close()
}

fun interface Opener {
  /** GET [url] with [headers]; throws when nothing answered: no connection, or [NoAnswerException] when no head came. */
  fun open(url: String, headers: Map<String, String>): Upstream

  /** The same, and [abort] ends it from another thread before the head came (a skip): it then throws at once. */
  fun open(url: String, headers: Map<String, String>, abort: Abort): Upstream = open(url, headers)
}

/** Ends an open in progress from any thread: the opener hands over how ([set]), the reader fires it. */
class Abort {
  private var hook: (() -> Unit)? = null
  private var fired = false

  /** [h] ends the open; at once when it was fired already. */
  fun set(h: () -> Unit) {
    val now = synchronized(this) {
      hook = h
      fired
    }
    if (now) h()
  }

  fun fire() {
    val h = synchronized(this) {
      fired = true
      hook
    }
    h?.invoke()
  }

  val isFired: Boolean get() = synchronized(this) { fired }
}

/** The ETag of each key's first response, and what happens when another one turns up. */
interface Representations {
  /** Bumped every time a key is invalidated: a reader that began before reads no further. */
  fun generation(key: String): Int

  fun etagOf(key: String): String?

  /** True when a response carrying [etag] may be read under [key]; the first one sets it. */
  fun admit(key: String, etag: String?): Boolean

  /** Another representation under [key]: the prefetch of it stops and its cached bytes go. */
  fun invalidate(key: String)
}

/** The sources' links: a call when one goes down. */
fun interface LinkWatch {
  fun onDown(sourceId: String, call: () -> Unit): AutoCloseable
}

/** The Range header for [position] and [length] (-1: to the end); never If-Range. */
fun requestHeaders(position: Long, length: Long): Map<String, String> = when {
  position == 0L && length < 0 -> emptyMap()
  length < 0 -> mapOf("Range" to "bytes=$position-")
  else -> mapOf("Range" to "bytes=$position-${position + length - 1}")
}

/** The stream URL of a version at a level on [origin]. */
fun streamUrl(origin: String, v: Version, level: String) =
  "$origin/s/${v.sourceId}/api/stream/${v.trackId}?q=$level&f=${v.fileHash}"

/**
 * Reads one key's bytes from the version the key names, at the key's level, and keeps reading when
 * that source stalls or fails: from another source with the same file at Max (the only level whose
 * bytes are the same everywhere), else from the same version once more, at the same byte position.
 * Every response under a key must carry the ETag of the first one. Once a read moved to another
 * source, later opens of the key start there (the key's own source may be gone).
 *
 * open, read and close run on the loader's thread; [cancel], the stall watchdog and the link
 * listener may abort the response from other threads.
 */
class FailoverReader(
  private val registry: VersionRegistry,
  private val opener: Opener,
  private val reps: Representations,
  private val links: LinkWatch,
  private val timer: ScheduledExecutorService,
  private val origin: String,
  private val stallMs: Long = 1_500,
  private val onServed: (key: String, level: String) -> Unit = { _, _ -> },
  private val onMoved: (key: String, from: Version, to: Version, position: Long) -> Unit = { _, _, _, _ -> },
  private val now: () -> Long = System::currentTimeMillis,
) {
  private var key: String? = null
  private var entry: VersionRegistry.Entry? = null
  private var level = "max"
  private var current: Version? = null
  private var currentUrl = ""
  @Volatile private var response: Upstream? = null
  private var position = 0L
  private var remaining = -1L
  private var toEnd = true
  private var responseLeft = -1L
  private val tried = HashSet<String>()
  private var retriedSame = false
  private var readSinceSwitch = 0L
  private var myEtag: String? = null
  private var generation = -1
  private var watch: AutoCloseable? = null
  private var tick: ScheduledFuture<*>? = null
  @Volatile private var waitingSince = 0L
  @Volatile private var firstByte = false
  @Volatile private var cancelled = false
  // The open waiting for its head now, and the thread that reads: a skip ends either at once.
  @Volatile private var opening: Abort? = null
  @Volatile private var ioThread: Thread? = null

  /** The level the open response says it served, or null. */
  @Volatile var served: String? = null
    private set

  /** The version being read, or null for a plain URL. */
  val reading: Version? get() = current

  /** Opens [key] (or plain [url] when it names no version) at [position]; [length] -1 reads to the end. Returns the bytes to read, or -1. */
  fun open(key: String?, url: String, position: Long, length: Long): Long {
    if (cancelled) throw IOException("cancelled")
    ioThread = Thread.currentThread()
    startWatchdog()
    this.position = position
    remaining = length
    toEnd = length < 0
    tried.clear()
    retriedSame = false
    served = null
    if (key == null || (Levels.parseStream(key) == null && Levels.parse(key) == null)) {
      this.key = null
      current = null
      entry = null
      val r = openUrl(url, requestHeaders(position, length))
      if (r.status !in 200..299) {
        r.close()
        throw HttpStatusException(r.status)
      }
      return begin(r, position, length)
    }
    if (this.key == key && generation >= 0) {
      if (reps.generation(key) != generation) throw RepresentationChangedException(key)
    } else {
      generation = reps.generation(key)
      myEtag = null
    }
    this.key = key
    val e = registry.get(key)
    entry = e
    level = Levels.levelOfAnyKey(key) ?: "max"
    val named = e?.versionOf(key)
    val v = named ?: synthetic(key)
    reopenMoved(key, e, v, position, length)?.let { return it }
    current = v
    tried.add(v.id)
    // Always the key's level: the page's URLs for the item playing may already ask another one.
    currentUrl = if (named != null && named.sourceId.isNotEmpty()) streamUrl(origin, named, level) else url.takeIf { it.startsWith("$origin/") } ?: streamUrl(origin, v, level)
    val r = try {
      openUrl(currentUrl, requestHeaders(position, length))
    } catch (x: NoAnswerException) {
      // The core is there, the source behind it is not: another version, when there is one.
      throw VersionsExhaustedException(x, e?.hasUntried(key) ?: false)
    } // no connection at all (the core restarting): the caller's retries
    // At or past the end (a bounded span of the prefetch too): nothing to read, the end is known.
    if (r.status == 416 && r.totalSize in 0..position) {
      r.close()
      remaining = 0
      return 0
    }
    if (r.status !in 200..299) {
      r.close()
      throw VersionsExhaustedException(HttpStatusException(r.status), e?.hasUntried(key) ?: false)
    }
    admit(key, r)
    e?.movedTo = null
    watchLink(v)
    return begin(r, position, length)
  }

  /**
   * A key whose read moved to the same file on another source opens there again, when it still
   * answers with the same bytes; otherwise (null) the key's own version is opened as usual.
   */
  private fun reopenMoved(key: String, e: VersionRegistry.Entry?, named: Version, position: Long, length: Long): Long? {
    if (level != "max" || e == null) return null
    val id = e.movedTo ?: return null
    val alt = e.versions.firstOrNull { it.id == id && it.id != named.id && it.fileHash == named.fileHash && it.sourceId.isNotEmpty() } ?: return null
    val url = streamUrl(origin, alt, level)
    val r = try {
      openUrl(url, requestHeaders(position, length))
    } catch (x: IOException) {
      return null
    }
    val ok = if (position > 0) r.status == 206 else r.status in 200..299
    if (!ok || !sameBytes(key, r)) {
      r.close()
      return null
    }
    myEtag = r.etag
    noteServed(key, r)
    current = alt
    currentUrl = url
    tried.add(alt.id)
    watchLink(alt)
    return begin(r, position, length)
  }

  private fun begin(r: Upstream, position: Long, length: Long): Long {
    response = r
    firstByte = false
    responseLeft = r.length
    readSinceSwitch = 0
    val ignoredRange = position > 0 && r.status == 200
    if (ignoredRange) skip(r, position)
    val body = if (r.length < 0) -1 else if (ignoredRange) r.length - position else r.length
    val n = if (length >= 0) length else body
    remaining = n
    startWatchdog()
    return n
  }

  private fun skip(r: Upstream, n: Long) {
    val buf = ByteArray(16 * 1024)
    var left = n
    while (left > 0) {
      val got = r.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
      if (got < 0) throw EOFException("short body")
      left -= got
    }
    if (responseLeft >= 0) responseLeft -= n
  }

  /** A version for a key the registry does not know (an item from an older queue). */
  private fun synthetic(key: String): Version {
    Levels.parseStream(key)?.let { return Version(it.sourceId, it.trackId, it.fileHash, "", 0) }
    val d = Levels.parse(key)!!
    return Version("", d.trackId, d.fileHash, "", 0)
  }

  /** The guard of the first response under a key: another ETag drops the key everywhere. */
  private fun admit(key: String, r: Upstream) {
    val etag = r.etag
    if ((etag != null && myEtag != null && etag != myEtag) || !reps.admit(key, etag)) {
      r.close()
      reps.invalidate(key)
      throw RepresentationChangedException(key)
    }
    if (etag != null) myEtag = etag
    noteServed(key, r)
  }

  private fun noteServed(key: String, r: Upstream) {
    val q = Levels.ofHeader(r.quality) ?: return
    served = q
    onServed(key, q)
  }

  /** Another source's response may continue these bytes only with the very same representation. */
  private fun sameBytes(key: String, r: Upstream): Boolean {
    val want = myEtag ?: reps.etagOf(key) ?: return false
    return r.etag == want
  }

  fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (remaining == 0L) return -1
    ioThread = Thread.currentThread()
    while (true) {
      if (cancelled) throw IOException("cancelled")
      val r = response ?: throw IOException("not open")
      val want = if (remaining < 0) length else minOf(length.toLong(), remaining).toInt()
      val n = try {
        waitingSince = now()
        r.read(buffer, offset, want)
      } catch (e: IOException) {
        waitingSince = 0
        if (cancelled || Interrupts.isCancel(e) || Thread.currentThread().isInterrupted) throw e
        failover(e)
        continue
      }
      waitingSince = 0
      if (n < 0) {
        if (responseLeft > 0) {
          if (cancelled) throw IOException("cancelled")
          failover(EOFException("body cut short"))
          continue
        }
        return -1
      }
      if (n > 0) firstByte = true
      position += n
      if (remaining > 0) remaining -= n
      if (responseLeft > 0) responseLeft -= n
      readSinceSwitch += n
      if (readSinceSwitch >= RETRY_AGAIN_AFTER) retriedSame = false
      return n
    }
  }

  /** The current response failed mid-body: another source with the same file, else this one once more. */
  private fun failover(cause: IOException) {
    val k = key
    val cur = current
    closeResponse()
    if (k == null || cur == null) throw cause
    val e = entry
    if (level == "max" && e != null) {
      for (alt in e.versions) {
        if (alt.id in tried || alt.fileHash != cur.fileHash || alt.sourceId.isEmpty()) continue
        tried.add(alt.id)
        val url = streamUrl(origin, alt, level)
        val r = try {
          openUrl(url, requestHeaders(position, if (toEnd) -1 else remaining))
        } catch (x: IOException) {
          continue
        }
        // Checked before a byte is read: another file, or a transcode, never joins these bytes.
        val partial = if (position > 0) r.status == 206 else r.status in 200..299
        if (!partial || !sameBytes(k, r)) {
          r.close()
          continue
        }
        noteServed(k, r)
        switchTo(alt, url, r)
        return
      }
    }
    if (!retriedSame) {
      retriedSame = true
      val r = try {
        openUrl(currentUrl, requestHeaders(position, if (toEnd) -1 else remaining))
      } catch (x: IOException) {
        throw exhausted(x)
      }
      if (r.status !in 200..299 || (position > 0 && r.status != 206)) {
        r.close()
        throw exhausted(if (r.status >= 400) HttpStatusException(r.status) else cause)
      }
      admit(k, r)
      switchTo(cur, currentUrl, r)
      return
    }
    throw exhausted(cause)
  }

  private fun exhausted(cause: IOException): IOException {
    val k = key ?: return cause
    return VersionsExhaustedException(cause, entry?.hasUntried(k) ?: false)
  }

  private fun switchTo(v: Version, url: String, r: Upstream) {
    key?.let { k ->
      current?.let { onMoved(k, it, v, position) }
      entry?.movedTo = if (v.isNamedBy(k)) null else v.id
    }
    current = v
    currentUrl = url
    response = r
    firstByte = false
    responseLeft = r.length
    readSinceSwitch = 0
    watchLink(v)
  }

  private fun watchLink(v: Version) {
    runCatching { watch?.close() }
    watch = if (v.sourceId.isEmpty()) null else links.onDown(v.sourceId) { response?.abort() }
  }

  private fun startWatchdog() {
    if (tick != null) return
    val period = (stallMs / 4).coerceAtLeast(20)
    tick = timer.scheduleWithFixedDelay({ checkStall() }, period, period, TimeUnit.MILLISECONDS)
  }

  /**
   * A read that waits [stallMs] for bytes after the response's first one: its source stalled. And
   * Media3 stops a load (the old song at a skip) by interrupting its thread, which a socket never
   * hears: the open or the read it waits in ends here, within a tick, not at the read timeout.
   */
  private fun checkStall() {
    val t = ioThread
    if (t != null && t.isInterrupted) {
      opening?.fire()
      response?.abort()
      return
    }
    val since = waitingSince
    if (since == 0L || !firstByte) return
    if (now() - since > stallMs) response?.abort()
  }

  /** One open that [cancel] and an interrupt of the reading thread can end before its head came. */
  private fun openUrl(url: String, headers: Map<String, String>): Upstream {
    if (cancelled) throw IOException("cancelled")
    if (Thread.currentThread().isInterrupted) throw InterruptedIOException("interrupted")
    val a = Abort()
    opening = a
    try {
      // A cancel between the check above and here saw no open to end: this one ends itself.
      if (cancelled) a.fire()
      return opener.open(url, headers, a)
    } finally {
      opening = null
    }
  }

  /** Stops a read in progress for good (the prefetch was cancelled, its song skipped): no failover follows, an open waiting for its head included. */
  fun cancel() {
    cancelled = true
    opening?.fire()
    response?.abort()
  }

  private fun closeResponse() {
    val r = response
    response = null
    if (r != null) runCatching { r.close() }
  }

  fun close() {
    tick?.cancel(false)
    tick = null
    runCatching { watch?.close() }
    watch = null
    waitingSince = 0
    closeResponse()
  }

  companion object {
    // After this many bytes from a version, a later failure may try it once more: the prefetch
    // reads a whole song in one read, and two glitches minutes apart are not a source that fails.
    const val RETRY_AGAIN_AFTER = 512L * 1024
  }
}

