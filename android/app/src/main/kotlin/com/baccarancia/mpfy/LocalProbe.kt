package com.baccarancia.mpfy

import android.content.ContentUris
import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.MediaStore
import android.system.Os
import com.baccarancia.mpfy.Json.list
import com.baccarancia.mpfy.Json.map
import com.baccarancia.mpfy.Json.str
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * What reading a file found, as the cache keeps it: the raw values the core builds the track from
 * with the source's own rules (id, tags, format, codec, duration, bitrate, sampleRate, bitDepth,
 * coverId, lyrics), where its cover came from (`file` or `folder`, never sent), and the ids the
 * file had before its bytes changed (`was`).
 */
class Facts(val map: Map<String, Any?>) {
  val id: String get() = map.str("id") ?: ""
  val duration: Double? get() = (map["duration"] as? Number)?.toDouble()
  val album: String? get() = map.map("tags")?.str("album")
  val coverId: String? get() = map.str("coverId")
  val coverFrom: String? get() = map.str("coverFrom")
  val was: List<String> get() = map.list("was")?.filterIsInstance<String>() ?: emptyList()

  fun with(key: String, value: Any?): Facts = Facts(LinkedHashMap(map).also { it[key] = value })

  fun without(key: String): Facts = Facts(LinkedHashMap(map).also { it.remove(key) })

  fun json(): String = Json.write(map)

  companion object {
    fun parse(text: String?): Facts? = text?.let { Json.obj(it) }?.let { Facts(it) }

    fun of(
      id: String,
      tags: Map<String, Any?>,
      format: String,
      codec: String?,
      duration: Double?,
      bitrate: Long?,
      sampleRate: Long?,
      bitDepth: Long?,
      coverId: String?,
      coverFrom: String?,
      lyrics: Map<String, Any?>?,
    ): Facts = Facts(
      linkedMapOf(
        "id" to id, "tags" to tags, "format" to format, "codec" to codec, "duration" to duration, "bitrate" to bitrate,
        "sampleRate" to sampleRate, "bitDepth" to bitDepth, "coverId" to coverId, "coverFrom" to coverFrom, "lyrics" to lyrics,
        "was" to emptyList<String>(),
      ),
    )
  }
}

/** A file read once: [facts] when it is a song; CHANGING: it moved while read, nothing kept, read again at the next check. */
class Probe(val outcome: Outcome, val facts: Facts?) {
  enum class Outcome { OK, SKIPPED, UNREADABLE, CHANGING }
}

/** Reads one file of the index (LocalProbe on the phone; a fake in the tests). */
interface FileReader {
  fun probe(row: Row): Probe

  /** The loudness of a whole file, decoded (R128Meter); null when it cannot be measured. */
  fun loudness(row: Row): R128Meter.Result? = null
}

data class Stat(val size: Long, val mtimeSec: Long)

/** What the platform's retriever and extractor say of a file. */
data class Meta(
  val title: String?,
  val artist: String?,
  val album: String?,
  val albumArtist: String?,
  val trackNo: Long?,
  val discNo: Long?,
  val year: Long?,
  val durationMs: Long?,
  val bitrate: Long?,
  val sampleRate: Long?,
  val bitDepth: Long?,
  val codec: String?,
  val hasVideo: Boolean,
  val genre: String? = null,
)

/**
 * The sort tags and the ReplayGain / R128 numbers of [values] (TagReader) into the facts' tags, as
 * the core takes them (client-core/phone-track.js): none, no key, so facts without them hash as before.
 */
internal fun sortAndGain(values: Map<String, String>, t: MutableMap<String, Any?>) {
  for ((k, name) in listOf("ARTISTSORT" to "artistSort", "ALBUMARTISTSORT" to "albumArtistSort", "ALBUMSORT" to "albumSort", "TITLESORT" to "titleSort")) {
    values[k]?.let { t[name] = it }
  }
  val number = Regex("""^\s*([+-]?\d+(?:\.\d+)?)""")
  fun dec(k: String): Double? = values[k]?.let { number.find(it)?.groupValues?.get(1)?.toDoubleOrNull() }?.takeIf { it.isFinite() }
  val rg = linkedMapOf<String, Any?>()
  dec("REPLAYGAIN_TRACK_GAIN")?.let { rg["trackGain"] = it }
  dec("REPLAYGAIN_TRACK_PEAK")?.let { rg["trackPeak"] = it }
  dec("REPLAYGAIN_ALBUM_GAIN")?.let { rg["albumGain"] = it }
  dec("REPLAYGAIN_ALBUM_PEAK")?.let { rg["albumPeak"] = it }
  values["R128_TRACK_GAIN"]?.trim()?.toIntOrNull()?.let { rg["r128Track"] = it }
  values["R128_ALBUM_GAIN"]?.trim()?.toIntOrNull()?.let { rg["r128Album"] = it }
  if (rg.isNotEmpty()) t["rg"] = rg
}

/** One open file: its bytes, the system's word on it, and what only the platform reads. */
interface OpenFile : ByteSource, Closeable {
  fun stat(): Stat

  /** Null when the retriever failed or took too long. [codec]: the codec is needed (the container does not say it). */
  fun metadata(codec: Boolean): Meta?

  /** The platform's embedded picture, for a container whose tags did not hold together. */
  fun embeddedPicture(): ByteArray?

  /** An .lrc beside the file, where the system lets an app read one (Android 10), at most 64 KB. */
  fun lrcBeside(): String?

  /** The whole first audio stream decoded and measured (R128Meter); null when it cannot be. */
  fun loudness(): R128Meter.Result? = null
}

interface ProbeIo {
  /** Null when the file cannot be opened. */
  fun open(row: Row): OpenFile?
}

/**
 * Reads a file once: its container from its first bytes (the source's rule), its tags' pictures
 * and lyrics, its id (the first 24 hex of the SHA-256 of every byte, the id a source gives the same
 * file), then what the platform reads. A file whose size or time moved during the read, or whose
 * size is not the one MediaStore listed, is left for the next check: it is still being written.
 */
class FileProbe(private val io: ProbeIo, private val art: ArtSink) : FileReader {
  companion object {
    private const val HEAD = 4096
    private const val CHUNK = 256 * 1024
    private val CODECS = mapOf("mp3" to "audio/mpeg", "aac" to "audio/mp4a-latm", "flac" to "audio/flac", "ogg" to "audio/vorbis", "opus" to "audio/opus", "wav" to "audio/raw")
  }

  override fun loudness(row: Row): R128Meter.Result? {
    val f = try {
      io.open(row)
    } catch (e: Exception) {
      null
    } ?: return null
    return try {
      f.loudness()
    } catch (e: Exception) {
      null
    } finally {
      runCatching { f.close() }
    }
  }

  override fun probe(row: Row): Probe {
    val f = try {
      io.open(row)
    } catch (e: Exception) {
      null
    } ?: return Probe(Probe.Outcome.UNREADABLE, null)
    try {
      return read(row, f)
    } catch (e: Exception) {
      return Probe(Probe.Outcome.UNREADABLE, null)
    } finally {
      runCatching { f.close() }
    }
  }

  private fun read(row: Row, f: OpenFile): Probe {
    val before = f.stat()
    // MediaStore listed a shorter or longer file than the one there now: its update is coming.
    if (before.size != row.size) return Probe(Probe.Outcome.CHANGING, null)
    val head = f.bytesAt(0, minOf(before.size, HEAD.toLong()).toInt()) ?: return Probe(Probe.Outcome.CHANGING, null)
    val sniffed = TagReader.sniff(head) ?: return Probe(Probe.Outcome.SKIPPED, null)
    val tags = TagReader.read(f, sniffed)
    var format = if (sniffed == "id3") afterId3(f, tags.audioStart) else sniffed
    val id = hash(f, before.size) ?: return Probe(Probe.Outcome.CHANGING, null)
    if (f.stat() != before) return Probe(Probe.Outcome.CHANGING, null)
    val meta = f.metadata(format == null || format == "m4a" || format == "ogg") ?: return Probe(Probe.Outcome.UNREADABLE, null)
    if (meta.hasVideo) return Probe(Probe.Outcome.SKIPPED, null)
    if (format == null) {
      format = when {
        meta.codec == "audio/mp4a-latm" -> "aac"
        else -> "mp3"
      }
    }
    if (format == "m4a" && meta.codec == null) return Probe(Probe.Outcome.SKIPPED, null)
    // Too short for a song, 0 included (LocalPolicy); MPEG audio and ADTS must say how long they are.
    val duration = meta.durationMs?.let { it / 1000.0 }
    if (LocalPolicy.tooShort(duration)) return Probe(Probe.Outcome.SKIPPED, null)
    if (duration == null && (format == "mp3" || format == "aac")) return Probe(Probe.Outcome.SKIPPED, null)
    val coverId = cover(f, tags)
    val lyrics = lyricsOf(tags, f.lrcBeside())
    val t = linkedMapOf<String, Any?>(
      "title" to meta.title, "artist" to meta.artist, "album" to meta.album, "albumArtist" to meta.albumArtist,
      "trackNo" to meta.trackNo, "discNo" to meta.discNo, "year" to meta.year,
    )
    // The genre tag as it is: the core cuts it into genres (web/js/genres.js); none, no key.
    meta.genre?.takeIf { it.isNotBlank() }?.let { t["genres"] = listOf(it) }
    sortAndGain(tags.values, t)
    return Probe(
      Probe.Outcome.OK,
      Facts.of(
        id, t, format, meta.codec ?: CODECS[format], duration, meta.bitrate,
        meta.sampleRate ?: tags.sampleRate?.toLong(), meta.bitDepth ?: tags.bitDepth?.toLong(),
        coverId, if (coverId != null) "file" else null, lyrics,
      ),
    )
  }

  /** What follows the ID3v2 tags decides: FLAC, ADTS or MPEG audio; null: the platform says. */
  private fun afterId3(f: OpenFile, at: Long): String? {
    val b = f.bytesAt(at, minOf(HEAD.toLong(), f.size - at).toInt().coerceAtLeast(0)) ?: return null
    return when (TagReader.sniff(b)) {
      "flac" -> "flac"
      "aac" -> "aac"
      "mp3" -> "mp3"
      else -> null
    }
  }

  private fun hash(f: OpenFile, size: Long): String? {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(CHUNK)
    var pos = 0L
    while (true) {
      val n = f.read(pos, buf, 0, buf.size)
      if (n <= 0) break
      md.update(buf, 0, n)
      pos += n
    }
    if (pos != size) return null
    return CoverArt.hex(md.digest()).substring(0, 24)
  }

  private fun cover(f: OpenFile, tags: TagInfo): String? {
    val chosen = TagReader.chosen(tags)
    val bytes = when {
      chosen != null -> chosen.bytes()
      !tags.walked -> f.embeddedPicture()
      else -> null
    } ?: return null
    val id = CoverArt.coverId(bytes) ?: return null
    if (art.has(id) || art.put(id, bytes)) return id
    return null
  }

  private fun lyricsOf(tags: TagInfo, lrc: String?): Map<String, Any?>? {
    if (tags.synced.isEmpty() && tags.texts.isEmpty() && lrc == null) return null
    return linkedMapOf(
      "synced" to tags.synced.map { list -> list.map { linkedMapOf("t" to it.t, "text" to it.text) } },
      "texts" to tags.texts,
      "lrc" to lrc,
    )
  }
}

/** The files of MediaStore, opened through their content URI (never a path), on any API level. */
class LocalProbe(context: Context) : ProbeIo {
  private val ctx = context.applicationContext
  // The retriever runs on its own thread with a time limit: a parser that hangs costs that thread, not the index.
  private var retriever: ExecutorService = newRetriever()

  companion object {
    private const val RETRIEVER_LIMIT_S = 10L
    // A whole file decoded: an hour-long mix on a slow phone included.
    private const val LOUDNESS_LIMIT_S = 600L
    private const val MAX_LRC = 64 * 1024
  }

  private fun newRetriever(): ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "MPfyLocalMeta").apply { isDaemon = true } }

  override fun open(row: Row): OpenFile? {
    val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(row.volume), row.mediaId)
    val pfd = ctx.contentResolver.openFileDescriptor(uri, "r") ?: return null
    return Opened(pfd, row)
  }

  private inner class Opened(private val pfd: ParcelFileDescriptor, private val row: Row) : OpenFile {
    private val stream = FileInputStream(pfd.fileDescriptor)
    private val channel: FileChannel = stream.channel
    override val size: Long = channel.size()

    override fun read(pos: Long, dst: ByteArray, off: Int, len: Int): Int = channel.read(ByteBuffer.wrap(dst, off, len), pos)

    override fun stat(): Stat {
      val s = Os.fstat(pfd.fileDescriptor)
      return Stat(s.st_size, s.st_mtime)
    }

    override fun metadata(codec: Boolean): Meta? = limited { retrieve(codec) }

    override fun embeddedPicture(): ByteArray? = limited {
      val m = MediaMetadataRetriever()
      try {
        m.setDataSource(pfd.fileDescriptor)
        m.embeddedPicture
      } finally {
        runCatching { m.release() }
      }
    }

    private fun <T> limited(work: () -> T): T? {
      val job = retriever.submit<T?> { work() }
      return try {
        job.get(RETRIEVER_LIMIT_S, TimeUnit.SECONDS)
      } catch (e: java.util.concurrent.TimeoutException) {
        job.cancel(true)
        // That thread may never come back: the next file gets a new one.
        retriever.shutdownNow()
        retriever = newRetriever()
        null
      } catch (e: Exception) {
        null
      }
    }

    private fun retrieve(codec: Boolean): Meta {
      val m = MediaMetadataRetriever()
      try {
        m.setDataSource(pfd.fileDescriptor)
        fun s(k: Int) = m.extractMetadata(k)?.takeIf { it.isNotEmpty() }
        val year = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_YEAR)) ?: s(MediaMetadataRetriever.METADATA_KEY_DATE)?.takeIf { it.length >= 4 }?.let { leadingInt(it.substring(0, 4)) }
        var sampleRate: Long? = null
        var bitDepth: Long? = null
        if (Build.VERSION.SDK_INT >= 31) {
          sampleRate = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE))
          bitDepth = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE))
        }
        // The extractor only where it says something: the codec of an MP4 or Ogg file, the sample rate below Android 12.
        val (mime, rate) = if (codec || Build.VERSION.SDK_INT < 31) extract() else null to null
        return Meta(
          title = s(MediaMetadataRetriever.METADATA_KEY_TITLE),
          artist = s(MediaMetadataRetriever.METADATA_KEY_ARTIST),
          album = s(MediaMetadataRetriever.METADATA_KEY_ALBUM),
          albumArtist = s(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST),
          genre = s(MediaMetadataRetriever.METADATA_KEY_GENRE),
          trackNo = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)),
          discNo = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)),
          year = year,
          durationMs = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_DURATION)),
          bitrate = leadingInt(s(MediaMetadataRetriever.METADATA_KEY_BITRATE)),
          sampleRate = sampleRate ?: rate,
          bitDepth = bitDepth,
          codec = mime,
          hasVideo = s(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes",
        )
      } finally {
        runCatching { m.release() }
      }
    }

    // The codec of the first audio track and its sample rate.
    private fun extract(): Pair<String?, Long?> {
      val x = MediaExtractor()
      try {
        x.setDataSource(pfd.fileDescriptor)
        for (i in 0 until x.trackCount) {
          val fmt = x.getTrackFormat(i)
          val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
          if (!mime.startsWith("audio/")) continue
          val rate = if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE).toLong() else null
          return mime to rate
        }
        return null to null
      } catch (e: Exception) {
        return null to null
      } finally {
        runCatching { x.release() }
      }
    }

    override fun lrcBeside(): String? {
      // Android 11 and later let no app read an .lrc another app made, under any media permission.
      if (Build.VERSION.SDK_INT >= 30) return null
      val path = row.dataPath ?: return null
      val audio = File(path)
      val dir = audio.parentFile ?: return null
      val base = audio.name.substringBeforeLast('.', audio.name)
      val lrc = lrcFiles(dir)["$base.lrc".lowercase()] ?: return null
      return try {
        if (lrc.length() > MAX_LRC) null else lrc.readText(Charsets.UTF_8)
      } catch (e: Exception) {
        null
      }
    }

    // MediaCodec decodes; a file that takes longer than LOUDNESS_LIMIT_S, changes its format midway
    // or has no audio stream is not measured.
    override fun loudness(): R128Meter.Result? {
      val ex = MediaExtractor()
      try {
        ex.setDataSource(pfd.fileDescriptor)
        val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return null
        ex.selectTrack(track)
        val format = ex.getTrackFormat(track)
        val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
        try {
          codec.configure(format, null, null, 0)
          codec.start()
          val deadline = System.nanoTime() + LOUDNESS_LIMIT_S * 1_000_000_000L
          val info = MediaCodec.BufferInfo()
          var meter: R128Meter? = null
          var channels = 0
          var float = false
          var buf = FloatArray(0)
          var inputDone = false
          while (true) {
            if (System.nanoTime() > deadline) return null
            if (!inputDone) {
              val i = codec.dequeueInputBuffer(10_000)
              if (i >= 0) {
                val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
                if (n < 0) {
                  codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                  inputDone = true
                } else {
                  codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                  ex.advance()
                }
              }
            }
            val o = codec.dequeueOutputBuffer(info, 10_000)
            if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
              if (meter != null) return null
              val out = codec.outputFormat
              channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              float = Build.VERSION.SDK_INT >= 24 && out.containsKey(MediaFormat.KEY_PCM_ENCODING) && out.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
              meter = R128Meter(out.getInteger(MediaFormat.KEY_SAMPLE_RATE), channels)
            } else if (o >= 0) {
              val m = meter
              if (info.size > 0 && m != null && channels > 0) {
                val ob = codec.getOutputBuffer(o)!!.order(ByteOrder.nativeOrder())
                ob.position(info.offset)
                ob.limit(info.offset + info.size)
                val n = if (float) info.size / 4 else info.size / 2
                if (buf.size < n) buf = FloatArray(n)
                if (float) {
                  ob.asFloatBuffer().get(buf, 0, n)
                } else {
                  val sb = ob.asShortBuffer()
                  for (k in 0 until n) buf[k] = sb.get() / 32768f
                }
                m.push(buf, n / channels)
              }
              codec.releaseOutputBuffer(o, false)
              if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return meter?.result()
            }
          }
        } finally {
          runCatching { codec.stop() }
          runCatching { codec.release() }
        }
      } catch (e: Exception) {
        return null
      } finally {
        runCatching { ex.release() }
      }
    }

    override fun close() {
      runCatching { stream.close() }
      runCatching { pfd.close() }
    }
  }

  // The .lrc files of the folders read lately: a folder is listed once, not once per song.
  private val lrcs = object : LinkedHashMap<String, Pair<Long, Map<String, File>>>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<Long, Map<String, File>>>?) = size > 16
  }

  private fun lrcFiles(dir: File): Map<String, File> {
    val now = SystemClock.elapsedRealtime()
    lrcs[dir.path]?.let { (at, m) -> if (now - at < 60_000) return m }
    val m = HashMap<String, File>()
    dir.listFiles()?.filter { it.isFile && it.name.endsWith(".lrc", ignoreCase = true) }?.sortedBy { it.name }?.forEach { m.putIfAbsent(it.name.lowercase(), it) }
    lrcs[dir.path] = now to m
    return m
  }

  private fun leadingInt(s: String?): Long? {
    if (s == null) return null
    val t = s.trim()
    var i = 0
    while (i < t.length && t[i].isDigit()) i++
    return if (i == 0) null else t.substring(0, minOf(i, 15)).toLongOrNull()
  }
}
