package com.baccarancia.mpfy

import android.content.ContentResolver
import android.content.Context
import android.os.ParcelFileDescriptor
import java.io.FileInputStream
import java.io.IOException
import java.net.URI

/*
 * The phone's own music ("Locale") played from its files: the player's stream URLs of source
 * "0000" are read here, never through the core, so they play with no page, no core and no network
 * (the car, the lock screen, Bluetooth, airplane mode). Free of Android classes but [PhoneFiles].
 */

/** The phone's music as a source of the page: its id, and the keys and URLs that name it. */
object LocalSource {
  const val ID = "0000"
  private val TRACK = Regex("[0-9a-f]{24}")

  /** A stream key of the phone's music (the prefetch never fetches one, nothing is cached under one). */
  fun isKey(key: String): Boolean = Levels.parseStream(key)?.sourceId == ID

  /** Whether [url] asks the core for something of the phone's music (/s/0000/...). */
  fun names(url: String?, origin: String = ORIGIN): Boolean {
    val u = parse(url, origin) ?: return false
    return u.rawPath.startsWith("/s/$ID/")
  }

  /** The track a stream URL of the phone's music names (/s/0000/api/stream/<id> on [origin]), or null for any other URL. */
  fun trackOf(url: String?, origin: String = ORIGIN): String? {
    val u = parse(url, origin) ?: return null
    val p = u.rawPath.split('/')
    if (p.size != 6 || p[0].isNotEmpty() || p[1] != "s" || p[2] != ID || p[3] != "api" || p[4] != "stream") return null
    return p[5].takeIf { TRACK.matches(it) }
  }

  /** The f= of a stream URL: the file its version names, or null. */
  fun fileOf(url: String): String? = parse(url, null)?.rawQuery?.split('&')?.firstOrNull { it.startsWith("f=") }?.substringAfter('=')

  // [origin] null: any.
  private fun parse(url: String?, origin: String?): URI? {
    if (url.isNullOrEmpty()) return null
    val u = try {
      URI(url)
    } catch (e: Exception) {
      return null
    }
    if (u.rawPath == null || u.rawUserInfo != null || u.rawFragment != null) return null
    if (origin != null && "${u.scheme}://${u.rawAuthority}" != origin) return null
    return u
  }
}

/** The phone's files by track id (the earliest-added readable file of that id). Any thread. */
interface LocalFiles {
  /** The file's bytes from its start, or null when no file of that id can be read now. */
  fun open(trackId: String): FileInputStream?
}

/**
 * The player's opener: a stream URL of the phone's music is the file itself, the original bytes at
 * any level asked, read from the Range's position with a counted read; any other URL goes to the
 * core ([http]). A file that is gone (a card pulled out, deleted since) answers 404 as a gone track
 * does, so the reader moves the song to its next version at once, or ends it when there is none.
 */
class LocalOpener(private val http: Opener, private val files: LocalFiles, private val origin: String = ORIGIN) : Opener {
  override fun open(url: String, headers: Map<String, String>): Upstream = open(url, headers, Abort())

  override fun open(url: String, headers: Map<String, String>, abort: Abort): Upstream {
    val id = LocalSource.trackOf(url, origin) ?: return http.open(url, headers, abort)
    // The phone's id is its file's hash: a version that names another file is gone.
    val f = LocalSource.fileOf(url)
    if (f != null && f != id) return Missing
    val input = try {
      files.open(id)
    } catch (e: IOException) {
      null
    } catch (e: SecurityException) {
      null
    } ?: return Missing
    try {
      val size = input.channel.size()
      return when (val ask = NativeFiles.range(headers["Range"], size)) {
        NativeFiles.Ask.Whole -> FileAnswer(input, "\"$id\"", size, size)
        is NativeFiles.Ask.Part -> {
          input.channel.position(ask.first)
          FileAnswer(input, "\"$id\"", ask.last - ask.first + 1, size)
        }
        NativeFiles.Ask.Unsatisfiable -> {
          runCatching { input.close() }
          PastTheEnd(size)
        }
      }
    } catch (e: IOException) {
      runCatching { input.close() }
      return Missing
    }
  }

  /** [count] bytes of the file from where [input] stands, as a source answers its original at Max. */
  private class FileAnswer(private val input: FileInputStream, override val etag: String, count: Long, override val totalSize: Long) : Upstream {
    override val status = 206
    override val quality = "max"
    override val length = count
    private var left = count
    @Volatile private var aborted = false

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (aborted) throw IOException("aborted")
      if (left <= 0) return -1
      val n = input.read(buffer, offset, minOf(length.toLong(), left).toInt())
      if (n < 0) throw IOException("the file ended early")
      left -= n
      return n
    }

    override fun abort() {
      aborted = true
      runCatching { input.close() }
    }

    override fun close() = abort()
  }

  private class PastTheEnd(override val totalSize: Long) : Upstream {
    override val status = 416
    override val etag: String? = null
    override val quality: String? = null
    override val length = -1L

    override fun read(buffer: ByteArray, offset: Int, length: Int) = -1

    override fun abort() {}

    override fun close() {}
  }

  private object Missing : Upstream {
    override val status = 404
    override val etag: String? = null
    override val quality: String? = null
    override val length = -1L
    override val totalSize = -1L

    override fun read(buffer: ByteArray, offset: Int, length: Int) = -1

    override fun abort() {}

    override fun close() {}
  }
}

/**
 * The stream cache's representation guard, with nothing kept for the phone's own keys: their id is
 * their bytes' hash, so no other representation can turn up, and the stream cache stays unwritten.
 */
class LocalRepresentations(private val cache: Representations) : Representations {
  override fun generation(key: String): Int = cache.generation(key)

  override fun etagOf(key: String): String? = if (LocalSource.isKey(key)) null else cache.etagOf(key)

  override fun admit(key: String, etag: String?): Boolean = LocalSource.isKey(key) || cache.admit(key, etag)

  override fun invalidate(key: String) = cache.invalidate(key)
}

/** The phone's files through MediaStore's content URIs (LocalMusic's index): never a path. */
object PhoneFiles : LocalFiles {
  @Volatile private var resolver: ContentResolver? = null

  fun init(ctx: Context) {
    resolver = ctx.applicationContext.contentResolver
  }

  override fun open(trackId: String): FileInputStream? {
    val r = resolver ?: return null
    val uri = LocalMusic.uriOf(trackId) ?: return null
    // Gone since the index saw it, a volume away, the permission taken back: no file.
    val pfd = try {
      r.openFileDescriptor(uri, "r")
    } catch (e: Exception) {
      null
    } ?: return null
    return ParcelFileDescriptor.AutoCloseInputStream(pfd)
  }
}
