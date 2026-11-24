package com.baccarancia.mpfy

import java.io.ByteArrayOutputStream
import java.util.Base64

/** A file's bytes read at given positions, as on a descriptor. */
interface ByteSource {
  val size: Long

  /** Reads up to [len] bytes at [pos] into [dst]; fewer only at the end of the file, -1 past it. */
  fun read(pos: Long, dst: ByteArray, off: Int, len: Int): Int
}

/** Exactly [len] bytes at [pos], or null when the file does not hold them. */
fun ByteSource.bytesAt(pos: Long, len: Int): ByteArray? {
  if (pos < 0 || len < 0 || pos + len > size) return null
  val b = ByteArray(len)
  var done = 0
  while (done < len) {
    val n = read(pos + done, b, done, len - done)
    if (n <= 0) return null
    done += n
  }
  return b
}

internal class ArraySource(private val data: ByteArray) : ByteSource {
  override val size: Long get() = data.size.toLong()

  override fun read(pos: Long, dst: ByteArray, off: Int, len: Int): Int {
    if (pos >= data.size) return -1
    val n = minOf(len.toLong(), data.size - pos).toInt()
    System.arraycopy(data, pos.toInt(), dst, off, n)
    return n
  }
}

class SyncedLine(val t: Long, val text: String)

/**
 * A picture a file carries: its type (3 is the front cover; null where the container has none) and
 * the length of its data, read only when asked. [exact]: the length is the data's; otherwise it is
 * at most that (a picture inside an encoded comment).
 */
class Picture(val typeId: Int?, val length: Long, private val exact: Boolean = true, private val loader: () -> ByteArray?) {
  fun bytes(): ByteArray? {
    if (length <= 0 || (exact && length > CoverArt.MAX_COVER_BYTES)) return null
    val b = loader() ?: return null
    return if (b.isEmpty() || b.size > CoverArt.MAX_COVER_BYTES) null else b
  }
}

/**
 * What a file's tags hold that the phone needs and the platform does not give: the pictures with
 * their types, the lyrics, and the rate and depth of FLAC and WAV. [walked]: the container's tags
 * held together; when they did not, the platform's own picture stands in. [audioStart]: the first
 * byte after the ID3v2 tags at the start.
 */
class TagInfo(
  val walked: Boolean,
  val pictures: List<Picture>,
  val synced: List<List<SyncedLine>>,
  val texts: List<String>,
  val sampleRate: Int?,
  val bitDepth: Int?,
  val audioStart: Long,
  // ARTISTSORT, ALBUMARTISTSORT, ALBUMSORT, TITLESORT, REPLAYGAIN_* and R128_*: their first value.
  val values: Map<String, String> = emptyMap(),
)

/**
 * Reads the few regions of an audio file that hold lyrics and pictures, as the source's parser
 * (music-metadata) reads them: ID3v2.2 to 2.4 (USLT, ULT, SYLT in milliseconds, APIC, PIC),
 * Vorbis comments in FLAC, Ogg Vorbis and Opus (LYRICS, UNSYNCEDLYRICS, UNSYNCED LYRICS,
 * METADATA_BLOCK_PICTURE), FLAC PICTURE blocks, MP4 (moov/udta/meta/ilst: (c)lyr, covr) and the ID3
 * chunk of WAV. Every size field is checked against what holds it and against the end of the file;
 * a text over 64 KB is refused before it is read, a synced list is read until its 2,001st line, a
 * line is cut before it is kept, and a picture is read only once it is chosen.
 */
object TagReader {
  const val MAX_LYRICS_BYTES = 64 * 1024
  const val MAX_LINES = 2000
  // What of a synced line the source looks at (UTF-16 units).
  const val RAW_LINE = 4000
  private const val MAX_ID3_TAGS = 4
  // A whole tag that must be decoded in memory (ID3v2.3 unsynchronisation).
  private const val MAX_WHOLE_TAG = 32L * 1024 * 1024
  // A synced lyrics frame read at most this far.
  private const val MAX_SYLT = 2 * 1024 * 1024
  // The pages read for an Ogg stream's comment header.
  private const val MAX_OGG_HEADER = 1024 * 1024
  // A text frame's description before its text.
  private const val MAX_DESC = 64 * 1024
  private const val FRONT_COVER = 3
  private val TEXT_KEYS = setOf("LYRICS", "UNSYNCEDLYRICS", "UNSYNCED LYRICS")
  // The tags read besides lyrics and pictures (Vorbis names): sort names, ReplayGain and R128.
  private val VALUE_KEYS = setOf(
    "ARTISTSORT", "ALBUMARTISTSORT", "ALBUMSORT", "TITLESORT",
    "REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_PEAK", "REPLAYGAIN_ALBUM_GAIN", "REPLAYGAIN_ALBUM_PEAK", "R128_TRACK_GAIN", "R128_ALBUM_GAIN",
  )
  private val ID3_SORT = mapOf("TSOP" to "ARTISTSORT", "TSO2" to "ALBUMARTISTSORT", "TSOA" to "ALBUMSORT", "TSOT" to "TITLESORT")
  private val MP4_SORT = mapOf("soar" to "ARTISTSORT", "soaa" to "ALBUMARTISTSORT", "soal" to "ALBUMSORT", "sonm" to "TITLESORT")
  // A value frame, comment or item longer than this is none of these.
  private const val MAX_VALUE = 4096

  private class Found {
    var walked = true
    val pictures = ArrayList<Picture>()
    val synced = ArrayList<List<SyncedLine>>()
    val texts = ArrayList<String>()
    var sampleRate: Int? = null
    var bitDepth: Int? = null
    var audioStart = 0L
    val values = LinkedHashMap<String, String>()
  }

  /** The container a file's first bytes say, as the source's sniffAudio: id3, mp3, aac, m4a, flac, ogg, opus, wav, or null. */
  fun sniff(head: ByteArray): String? {
    if (head.size < 4) return null
    if (ascii(head, 0, 3) == "ID3") return "id3"
    if (ascii(head, 0, 4) == "fLaC") return "flac"
    if (ascii(head, 0, 4) == "OggS") return if (ascii(head, 0, head.size).contains("OpusHead")) "opus" else "ogg"
    if (head.size >= 12 && ascii(head, 0, 4) == "RIFF" && ascii(head, 8, 4) == "WAVE") return "wav"
    if (head.size >= 8 && ascii(head, 4, 4) == "ftyp") return "m4a"
    // Raw MPEG audio or ADTS, possibly after some zero padding.
    var i = 0
    while (i < head.size && head[i] == 0.toByte()) i++
    if (isAdts(head, i)) return "aac"
    if (isMpeg(head, i)) return "mp3"
    return null
  }

  private fun isMpeg(b: ByteArray, i: Int): Boolean {
    if (b.size < i + 3 || u8(b, i) != 0xff || (u8(b, i + 1) and 0xe0) != 0xe0) return false
    val version = (u8(b, i + 1) shr 3) and 3
    val layer = (u8(b, i + 1) shr 1) and 3
    val bitrate = u8(b, i + 2) shr 4
    val rate = (u8(b, i + 2) shr 2) and 3
    return version != 1 && layer != 0 && bitrate != 15 && rate != 3
  }

  private fun isAdts(b: ByteArray, i: Int): Boolean {
    if (b.size < i + 3 || u8(b, i) != 0xff || (u8(b, i + 1) and 0xf6) != 0xf0) return false
    return ((u8(b, i + 2) shr 2) and 0x0f) < 13
  }

  /** The source's choice: the first front cover, else the first picture. */
  fun chosen(info: TagInfo): Picture? = info.pictures.firstOrNull { it.typeId == FRONT_COVER } ?: info.pictures.firstOrNull()

  /** Reads the tags of a file whose first bytes said [container] (sniff's answer). */
  fun read(src: ByteSource, container: String): TagInfo {
    val f = Found()
    when (container) {
      "id3", "mp3", "aac" -> {
        f.audioStart = id3Chain(src, 0, f)
        if (container == "id3" && magic(src, f.audioStart, "fLaC")) flac(src, f.audioStart + 4, f)
      }
      "flac" -> flac(src, 4, f)
      "ogg", "opus" -> ogg(src, f)
      "m4a" -> mp4(src, f)
      "wav" -> wav(src, f)
    }
    return TagInfo(f.walked, f.pictures, f.synced, f.texts, f.sampleRate, f.bitDepth, f.audioStart, f.values)
  }

  private fun magic(src: ByteSource, pos: Long, word: String): Boolean {
    val b = src.bytesAt(pos, word.length) ?: return false
    return ascii(b, 0, b.size) == word
  }

  // ------------------------------------------------------------------ ID3v2

  private fun id3Chain(src: ByteSource, start: Long, f: Found): Long {
    var pos = start
    repeat(MAX_ID3_TAGS) {
      if (!magic(src, pos, "ID3")) return pos
      pos = id3(src, pos, src.size, f) ?: return pos
    }
    return pos
  }

  /** The tag at [pos], which must end by [limit]: the position after it, or null when it does not hold together. */
  private fun id3(src: ByteSource, pos: Long, limit: Long, f: Found): Long? {
    val h = src.bytesAt(pos, 10) ?: return null
    val major = u8(h, 3)
    val flags = u8(h, 5)
    if (major !in 2..4) {
      f.walked = false
      return null
    }
    val size = syncsafe(h, 6)
    val bodyStart = pos + 10
    val bodyEnd = bodyStart + size
    if (bodyEnd > limit) {
      // The source refuses a tag that claims more than the file holds.
      f.walked = false
      return null
    }
    val after = bodyEnd + if (major == 4 && (flags and 0x10) != 0) 10 else 0
    var body: ByteSource = src
    var off = bodyStart
    var end = bodyEnd
    if ((flags and 0x80) != 0 && major < 4) {
      // ID3v2.2 and 2.3 unsynchronise the whole tag: it is decoded in memory.
      if (size > MAX_WHOLE_TAG) {
        f.walked = false
        return after
      }
      val clean = removeUnsync(src.bytesAt(bodyStart, size.toInt()) ?: return null)
      body = ArraySource(clean)
      off = 0
      end = clean.size.toLong()
    }
    if ((flags and 0x40) != 0 && major >= 3) {
      val e = body.bytesAt(off, 4)
      val extSize = when {
        e == null -> -1L
        major == 4 -> syncsafe(e, 0)
        else -> u32be(e, 0) + 4
      }
      if (extSize < (if (major == 4) 6 else 10) || extSize > end - off) {
        f.walked = false
        return after
      }
      off += extSize
    }
    frames(body, off, end, major, f)
    return after
  }

  private fun frames(body: ByteSource, start: Long, end: Long, major: Int, f: Found) {
    val headLen = if (major == 2) 6 else 10
    var p = start
    while (p + headLen <= end) {
      val h = body.bytesAt(p, headLen) ?: return
      // Padding follows the last frame.
      if (h[0] == 0.toByte()) return
      val id = ascii(h, 0, if (major == 2) 3 else 4)
      val len = when (major) {
        2 -> u24be(h, 3).toLong()
        3 -> u32be(h, 4)
        else -> syncsafe(h, 4)
      }
      val flags = if (major == 2) 0 else (u8(h, 8) shl 8) or u8(h, 9)
      p += headLen
      // A size past the end of the tag is cut there, as the source's parser cuts it.
      val have = minOf(len, end - p)
      frame(body, p, have, id, major, flags, f)
      p += len
    }
  }

  private fun frame(body: ByteSource, start: Long, len: Long, id: String, major: Int, flags: Int, f: Found) {
    val kind = when {
      id == "USLT" || id == "ULT" -> 'T'
      id == "SYLT" -> 'S'
      (id == "APIC" && major >= 3) || (id == "PIC" && major == 2) -> 'P'
      id in ID3_SORT && major >= 3 -> 'V'
      id == "TXXX" && major >= 3 -> 'X'
      else -> return
    }
    val unsync = major == 4 && (flags and 0x0002) != 0
    val lengthIndicator = major == 4 && (flags and 0x0001) != 0
    if (kind == 'V' || kind == 'X') {
      if (len < 2 || len > MAX_VALUE) return
      val raw = body.bytesAt(start, len.toInt()) ?: return
      val d = if (unsync || lengthIndicator) decodeFrame(raw, unsync, lengthIndicator) ?: return else raw
      if (kind == 'V') textValue(d, ID3_SORT.getValue(id), f) else txxx(d, f)
      return
    }
    if (!unsync && !lengthIndicator) {
      when (kind) {
        'T' -> uslt(body, start, len, f)
        'S' -> sylt(body, start, len, f)
        else -> apic(body, start, len, major, f)
      }
      return
    }
    // ID3v2.4 per frame: decoded in memory.
    val cap = when (kind) {
      'T' -> 4L + MAX_DESC + 4 * MAX_LYRICS_BYTES
      'S' -> MAX_SYLT.toLong()
      else -> 2L * CoverArt.MAX_COVER_BYTES
    }
    if (kind == 'P') {
      // Its type from the first bytes, its data only once it is chosen.
      val head = body.bytesAt(start, minOf(len, 4096L).toInt()) ?: return
      val clean = decodeFrame(head, unsync, lengthIndicator) ?: return
      val pic = apicHeader(clean, major) ?: return
      f.pictures.add(
        Picture(pic.first, len - pic.second, exact = false) {
          if (len > cap) null else body.bytesAt(start, len.toInt())?.let { decodeFrame(it, unsync, lengthIndicator) }?.let { d -> apicHeader(d, major)?.let { d.copyOfRange(it.second.toInt(), d.size) } }
        },
      )
      return
    }
    val raw = body.bytesAt(start, minOf(len, cap).toInt()) ?: return
    val clean = decodeFrame(raw, unsync, lengthIndicator) ?: return
    if (kind == 'T') uslt(ArraySource(clean), 0, clean.size.toLong(), f) else sylt(ArraySource(clean), 0, clean.size.toLong(), f, cut = len > cap)
  }

  private fun decodeFrame(b: ByteArray, unsync: Boolean, lengthIndicator: Boolean): ByteArray? {
    var d = if (unsync) removeUnsync(b) else b
    if (lengthIndicator) {
      if (d.size < 4) return null
      d = d.copyOfRange(4, d.size)
    }
    return d
  }

  fun removeUnsync(b: ByteArray): ByteArray {
    val out = ByteArray(b.size)
    var r = 0
    var w = 0
    while (r < b.size - 1) {
      out[w++] = b[r]
      r += if (b[r] == 0xff.toByte() && b[r + 1] == 0.toByte()) 2 else 1
    }
    if (r < b.size) out[w++] = b[r]
    return out.copyOf(w)
  }

  /** The picture's type and where its data starts, from the frame's first bytes; null when they do not say. */
  private fun apicHeader(d: ByteArray, major: Int): Pair<Int?, Long>? {
    if (d.isEmpty()) return null
    val enc = encOf(u8(d, 0))
    var i = 1
    if (major == 2) {
      i += 3
    } else {
      val z = findZero(d, i, d.size, Enc.LATIN1)
      if (z >= d.size) return null to d.size.toLong()
      i = z + 1
    }
    if (i >= d.size) return null to d.size.toLong()
    val type = u8(d, i)
    i++
    val z = findZero(d, i, d.size, enc)
    if (z >= d.size) return type to d.size.toLong()
    return type to (z + termLen(enc)).toLong().coerceAtMost(d.size.toLong())
  }

  /** The first bytes of a frame that hold its description: a few, or up to 64 KB of description when it is that long. */
  private fun frameHead(body: ByteSource, start: Long, len: Long, ends: (ByteArray) -> Boolean): ByteArray? {
    val small = body.bytesAt(start, minOf(len, 1024L).toInt()) ?: return null
    if (small.size.toLong() == len || ends(small)) return small
    return body.bytesAt(start, minOf(len, 1024L + MAX_DESC).toInt())
  }

  private fun apic(body: ByteSource, start: Long, len: Long, major: Int, f: Found) {
    // The type and the description sit in the first bytes; a description of more than 64 KB is not looked through.
    val head = frameHead(body, start, len) { h -> apicHeader(h, major).let { it != null && it.second < h.size } } ?: return
    val (type, dataOff) = apicHeader(head, major) ?: return
    val complete = head.size.toLong() == len
    if (!complete && dataOff >= head.size) return
    val dataStart = start + dataOff
    val dataLen = len - dataOff
    f.pictures.add(Picture(type, dataLen) { body.bytesAt(dataStart, dataLen.toInt()) })
  }

  private fun uslt(body: ByteSource, start: Long, len: Long, f: Found) {
    if (len < 4) return
    val head = frameHead(body, start, len) { h -> findZero(h, 4, h.size, encOf(u8(h, 0))) < h.size } ?: return
    val enc = encOf(u8(head, 0))
    val z = findZero(head, 4, head.size, enc)
    if (z >= head.size) return
    val textStart = z + termLen(enc)
    val region = len - textStart
    // Over 64 KB for sure in that encoding: refused before it is read.
    if (region <= 0 || region > maxTextBytes(enc) + termLen(enc)) return
    val t = body.bytesAt(start + textStart, region.toInt()) ?: return
    val text = nullTerminated(t, 0, t.size, enc)?.first ?: return
    keepText(text, f)
  }

  // A text frame: its encoding, then its first value.
  private fun textValue(d: ByteArray, key: String, f: Found) {
    if (d.size < 2) return
    val enc = encOf(u8(d, 0))
    nullTerminated(d, 1, d.size, enc)?.first?.let { keepValue(key, it, f) }
  }

  // TXXX: its encoding, a description (the key), then the value.
  private fun txxx(d: ByteArray, f: Found) {
    if (d.size < 3) return
    val enc = encOf(u8(d, 0))
    val (desc, used) = nullTerminated(d, 1, d.size, enc) ?: return
    val key = desc.trim().uppercase()
    if (key !in VALUE_KEYS || 1 + used >= d.size) return
    nullTerminated(d, 1 + used, d.size, enc)?.first?.let { keepValue(key, it, f) }
  }

  private fun keepValue(key: String, value: String, f: Found) {
    val v = value.trim()
    if (v.isNotEmpty() && v.length <= MAX_VALUE && key !in f.values) f.values[key] = v
  }

  private fun keepText(text: String, f: Found) {
    if (text.isEmpty() || text.length > MAX_LYRICS_BYTES || utf8Length(text) > MAX_LYRICS_BYTES) return
    f.texts.add(text)
  }

  // The most bytes a text of at most 64 KB can take in an encoding (a byte order mark included).
  private fun maxTextBytes(e: Enc): Long = when (e) {
    Enc.LATIN1 -> MAX_LYRICS_BYTES + 2L
    Enc.UTF16LE, Enc.UTF16BE -> 2L * MAX_LYRICS_BYTES + 2
    Enc.UTF8 -> 3L * MAX_LYRICS_BYTES + 3
  }

  private fun sylt(body: ByteSource, start: Long, len: Long, f: Found, cut: Boolean = false) {
    if (len < 6) return
    val n = minOf(len, MAX_SYLT.toLong()).toInt()
    val d = body.bytesAt(start, n) ?: return
    val partial = cut || len > MAX_SYLT
    val enc = encOf(u8(d, 0))
    // Milliseconds only: the source leaves MPEG frame times.
    if (u8(d, 4) != 2) return
    var i = 6
    val desc = nullTerminated(d, i, d.size, enc) ?: return
    i += desc.second
    val lines = ArrayList<SyncedLine>()
    while (i < d.size) {
      val item = nullTerminated(d, i, d.size, enc) ?: return
      i += item.second
      if (i + 4 > d.size) return
      lines.add(SyncedLine(u32be(d, i), headOf(item.first, RAW_LINE)))
      i += 4
      if (lines.size > MAX_LINES) break
    }
    // Cut before its 2,001st line: what follows is unknown, so nothing is kept.
    if (lines.isEmpty() || (partial && lines.size <= MAX_LINES)) return
    f.synced.add(lines)
  }

  // ------------------------------------------------------------------ FLAC

  private fun flac(src: ByteSource, start: Long, f: Found) {
    var p = start
    while (true) {
      val h = src.bytesAt(p, 4)
      if (h == null) {
        f.walked = false
        return
      }
      val last = (u8(h, 0) and 0x80) != 0
      val type = u8(h, 0) and 0x7f
      val len = u24be(h, 1).toLong()
      val data = p + 4
      if (data + len > src.size) {
        f.walked = false
        return
      }
      when (type) {
        0 -> if (len == 34L) src.bytesAt(data, 34)?.let { si ->
          f.sampleRate = (u8(si, 10) shl 12) or (u8(si, 11) shl 4) or (u8(si, 12) shr 4)
          f.bitDepth = (((u8(si, 12) and 1) shl 4) or (u8(si, 13) shr 4)) + 1
        }
        4 -> if (!comments(src, data, data + len, f)) f.walked = false
        6 -> flacPicture(src, data, len, f)
      }
      p = data + len
      if (last) return
    }
  }

  private fun flacPicture(src: ByteSource, start: Long, len: Long, f: Found) {
    val head = src.bytesAt(start, minOf(len, 8L).toInt()) ?: return
    if (head.size < 8) return
    val type = u32be(head, 0).toInt()
    val mimeLen = u32be(head, 4)
    val p2 = start + 8 + mimeLen
    val d = src.bytesAt(p2, 4) ?: return
    val descLen = u32be(d, 0)
    val p3 = p2 + 4 + descLen
    val rest = src.bytesAt(p3, 20) ?: return
    val dataLen = u32be(rest, 16)
    val dataStart = p3 + 20
    if (dataStart + dataLen > start + len) return
    f.pictures.add(Picture(type, dataLen) { src.bytesAt(dataStart, dataLen.toInt()) })
  }

  /** A FLAC picture block held in memory (a Vorbis comment's): its data. */
  private fun pictureData(b: ByteArray): ByteArray? {
    if (b.size < 32) return null
    var i = 4L
    val mimeLen = u32be(b, i.toInt())
    i += 4 + mimeLen
    if (i + 4 > b.size) return null
    val descLen = u32be(b, i.toInt())
    i += 4 + descLen
    if (i + 20 > b.size) return null
    val dataLen = u32be(b, i.toInt() + 16)
    i += 20
    if (i + dataLen > b.size) return null
    return b.copyOfRange(i.toInt(), (i + dataLen).toInt())
  }

  // ------------------------------------------------------------------ Vorbis comments

  /** The comment list in [start, end): false when it does not hold together. */
  private fun comments(src: ByteSource, start: Long, end: Long, f: Found): Boolean {
    var p = start
    val v = src.bytesAt(p, 4) ?: return false
    p += 4 + u32le(v, 0)
    if (p + 4 > end) return false
    val c = src.bytesAt(p, 4) ?: return false
    val count = u32le(c, 0)
    p += 4
    var k = 0L
    while (k < count) {
      if (p + 4 > end) return false
      val l = src.bytesAt(p, 4) ?: return false
      val len = u32le(l, 0)
      p += 4
      if (p + len > end) return false
      comment(src, p, len, f)
      p += len
      k++
    }
    return true
  }

  private fun comment(src: ByteSource, start: Long, len: Long, f: Found) {
    // The key is in the first bytes; a key longer than these is none of ours.
    val head = src.bytesAt(start, minOf(len, 32L).toInt()) ?: return
    val eq = head.indexOf('='.code.toByte())
    if (eq < 0) return
    val key = ascii(head, 0, eq).uppercase()
    val valueStart = start + eq + 1
    val valueLen = len - eq - 1
    when {
      key in TEXT_KEYS -> {
        if (valueLen > maxTextBytes(Enc.UTF8)) return
        val b = src.bytesAt(valueStart, valueLen.toInt()) ?: return
        keepText(utf8(b, 0, b.size), f)
      }
      key in VALUE_KEYS -> {
        if (valueLen <= 0 || valueLen > MAX_VALUE) return
        val b = src.bytesAt(valueStart, valueLen.toInt()) ?: return
        keepValue(key, utf8(b, 0, b.size), f)
      }
      key == "METADATA_BLOCK_PICTURE" -> {
        if (valueLen < 8) return
        // Base64 of a FLAC picture block: the type from its first eight characters.
        val first = src.bytesAt(valueStart, 8) ?: return
        val type = runCatching { Base64.getDecoder().decode(first) }.getOrNull()?.let { if (it.size >= 4) u32be(it, 0).toInt() else null } ?: return
        f.pictures.add(
          Picture(type, valueLen * 3 / 4, exact = false) {
            if (valueLen > 2L * CoverArt.MAX_COVER_BYTES) null
            else src.bytesAt(valueStart, valueLen.toInt())?.let { runCatching { Base64.getMimeDecoder().decode(it) }.getOrNull() }?.let { pictureData(it) }
          },
        )
      }
    }
  }

  // ------------------------------------------------------------------ Ogg

  private fun ogg(src: ByteSource, f: Found) {
    // The first two packets of the first stream: the identification, then the comments.
    var p = 0L
    var serial: Long? = null
    var budget = MAX_OGG_HEADER.toLong()
    val packets = ArrayList<ByteArray>()
    val cur = ByteArrayOutputStream()
    pages@ while (packets.size < 2) {
      val h = src.bytesAt(p, 27)
      if (h == null || ascii(h, 0, 4) != "OggS") {
        f.walked = false
        return
      }
      val nseg = u8(h, 26)
      val lacing = src.bytesAt(p + 27, nseg) ?: run {
        f.walked = false
        return
      }
      val dataLen = lacing.sumOf { it.toInt() and 0xff }
      val pageEnd = p + 27 + nseg + dataLen
      if (pageEnd > src.size) {
        f.walked = false
        return
      }
      val ser = u32le(h, 14)
      if (serial == null) serial = ser
      if (ser == serial) {
        budget -= 27 + nseg + dataLen
        if (budget < 0) {
          // A comment header past 1 MB: the platform's picture stands in.
          f.walked = false
          return
        }
        val data = src.bytesAt(p + 27 + nseg, dataLen) ?: return
        var o = 0
        for (lb in lacing) {
          val l = lb.toInt() and 0xff
          cur.write(data, o, l)
          o += l
          if (l < 255) {
            packets.add(cur.toByteArray())
            cur.reset()
            if (packets.size == 2) break@pages
          }
        }
      }
      p = pageEnd
    }
    val c = packets[1]
    val skip = when {
      c.size >= 7 && u8(c, 0) == 3 && ascii(c, 1, 6) == "vorbis" -> 7
      c.size >= 8 && ascii(c, 0, 8) == "OpusTags" -> 8
      else -> return
    }
    if (!comments(ArraySource(c), skip.toLong(), c.size.toLong(), f)) f.walked = false
  }

  // ------------------------------------------------------------------ MP4

  private class Box(val type: String, val start: Long, val end: Long)

  /** The boxes in [start, end); a box that passes [end] or is shorter than its header ends the walk. */
  private fun boxes(src: ByteSource, start: Long, end: Long, top: Boolean, f: Found): List<Box> {
    val out = ArrayList<Box>()
    var p = start
    while (p + 8 <= end) {
      val h = src.bytesAt(p, 8) ?: break
      var size = u32be(h, 0)
      val type = ascii(h, 4, 4)
      var head = 8L
      if (size == 1L) {
        val l = src.bytesAt(p + 8, 8) ?: break
        size = (u32be(l, 0) shl 32) or u32be(l, 4)
        head = 16
      } else if (size == 0L) {
        size = end - p
      }
      if (size < head) {
        f.walked = false
        break
      }
      var boxEnd = p + size
      if (boxEnd > end || boxEnd < p) {
        // A file cut short keeps what it holds; inside a box, a child that passes its parent is hostile.
        if (!top) {
          f.walked = false
          break
        }
        boxEnd = end
      }
      out.add(Box(type, p + head, boxEnd))
      p = boxEnd
    }
    return out
  }

  private fun mp4(src: ByteSource, f: Found) {
    for (moov in boxes(src, 0, src.size, true, f).filter { it.type == "moov" }) {
      for (b in boxes(src, moov.start, moov.end, false, f)) {
        when (b.type) {
          "udta" -> for (m in boxes(src, b.start, b.end, false, f)) if (m.type == "meta") meta(src, m, f)
          "meta" -> meta(src, b, f)
        }
      }
    }
  }

  private fun meta(src: ByteSource, m: Box, f: Found) {
    // A full box (version and flags first), except in files that write it plain, where hdlr comes at once.
    val plain = src.bytesAt(m.start + 4, 4)?.let { ascii(it, 0, 4) == "hdlr" } == true
    val start = if (plain) m.start else m.start + 4
    for (b in boxes(src, start, m.end, false, f)) {
      if (b.type != "ilst") continue
      for (item in boxes(src, b.start, b.end, false, f)) {
        val sortKey = MP4_SORT[item.type]
        if (sortKey != null || item.type == "----") {
          mp4Value(src, item, sortKey, f)
          continue
        }
        val lyrics = item.type == "\u00a9lyr"
        if (!lyrics && item.type != "covr") continue
        for (d in boxes(src, item.start, item.end, false, f)) {
          if (d.type != "data" || d.end - d.start < 8) continue
          val dh = src.bytesAt(d.start, 8) ?: continue
          if (u8(dh, 0) != 0) continue
          val type = u24be(dh, 1)
          val valueStart = d.start + 8
          val valueLen = d.end - valueStart
          if (lyrics && (type == 1 || type == 18)) {
            if (valueLen > maxTextBytes(Enc.UTF8)) continue
            val v = src.bytesAt(valueStart, valueLen.toInt()) ?: continue
            keepText(utf8(v, 0, v.size), f)
          } else if (!lyrics && (type == 13 || type == 14)) {
            f.pictures.add(Picture(null, valueLen) { src.bytesAt(valueStart, valueLen.toInt()) })
          }
        }
      }
    }
  }

  // A sort item (its key given) or a freeform iTunes item ("----": mean, name, data): a UTF-8 value.
  private fun mp4Value(src: ByteSource, item: Box, sortKey: String?, f: Found) {
    var key = sortKey
    for (d in boxes(src, item.start, item.end, false, f)) {
      val n = d.end - d.start
      if (d.type == "name" && sortKey == null && n in 5L..260L) {
        val b = src.bytesAt(d.start + 4, (n - 4).toInt()) ?: return
        key = utf8(b, 0, b.size).trim().uppercase()
      } else if (d.type == "data" && n in 9L..(8L + MAX_VALUE)) {
        val k = key ?: return
        if (k !in VALUE_KEYS) return
        val dh = src.bytesAt(d.start, 8) ?: return
        if (u8(dh, 0) != 0 || u24be(dh, 1) != 1) return
        val v = src.bytesAt(d.start + 8, (n - 8).toInt()) ?: return
        keepValue(k, utf8(v, 0, v.size), f)
        return
      }
    }
  }

  // ------------------------------------------------------------------ WAV

  private fun wav(src: ByteSource, f: Found) {
    val h = src.bytesAt(0, 12)
    if (h == null || ascii(h, 0, 4) != "RIFF" || ascii(h, 8, 4) != "WAVE") {
      f.walked = false
      return
    }
    var p = 12L
    while (p + 8 <= src.size) {
      val c = src.bytesAt(p, 8) ?: break
      val id = ascii(c, 0, 4)
      val len = u32le(c, 4)
      val data = p + 8
      if (data + len > src.size) {
        // The audio often runs to the end of the file; anything else that does is not trusted.
        if (id != "data") f.walked = false
        break
      }
      when (id) {
        "fmt " -> src.bytesAt(data, minOf(len, 16L).toInt())?.takeIf { it.size >= 16 }?.let {
          f.sampleRate = u32le(it, 4).toInt()
          f.bitDepth = u8(it, 14) or (u8(it, 15) shl 8)
        }
        "id3 ", "ID3 " -> id3(src, data, data + len, f)
      }
      p = data + len + (len and 1)
    }
  }

  // ------------------------------------------------------------------ text

  private enum class Enc { LATIN1, UTF16LE, UTF16BE, UTF8 }

  private fun encOf(b: Int): Enc = when (b) {
    0 -> Enc.LATIN1
    1 -> Enc.UTF16LE
    2 -> Enc.UTF16BE
    else -> Enc.UTF8
  }

  private fun termLen(e: Enc) = if (e == Enc.UTF16LE || e == Enc.UTF16BE) 2 else 1

  /** The first terminator at or after [from] (on 2-byte steps for UTF-16), or [to]. */
  private fun findZero(d: ByteArray, from: Int, to: Int, e: Enc): Int {
    if (e == Enc.UTF16LE || e == Enc.UTF16BE) {
      var i = from
      while (i + 1 < to) {
        if (d[i] == 0.toByte() && d[i + 1] == 0.toByte()) return i
        i += 2
      }
      return to
    }
    for (i in from until to) if (d[i] == 0.toByte()) return i
    return to
  }

  /** A string ended by its terminator or by [to]: the text and the bytes it took; null when it cannot be decoded. */
  private fun nullTerminated(d: ByteArray, from: Int, to: Int, e: Enc): Pair<String, Int>? {
    val z = findZero(d, from, to, e)
    val text = decode(d, from, z, e) ?: return null
    return text to if (z >= to) to - from else z - from + termLen(e)
  }

  // The source parser's decoding, byte order marks and all.
  private fun decode(d: ByteArray, from: Int, to: Int, e: Enc): String? {
    val n = to - from
    if (n >= 2 && u8(d, from) == 0xff && u8(d, from + 1) == 0xfe) return decode(d, from + 2, to, e)
    if (e == Enc.UTF16LE && n >= 2 && u8(d, from) == 0xfe && u8(d, from + 1) == 0xff) {
      if (n and 1 != 0) return null
      return decode(swapped(d, from, to), 0, n, e)
    }
    return when (e) {
      Enc.UTF16BE -> if (n and 1 != 0) null else utf16le(swapped(d, from, to), 0, n)
      Enc.UTF16LE -> utf16le(d, from, to)
      Enc.UTF8 -> utf8(d, from, to)
      Enc.LATIN1 -> {
        val s = StringBuilder(n)
        for (i in from until to) s.append(u8(d, i).toChar())
        s.toString()
      }
    }
  }

  private fun swapped(d: ByteArray, from: Int, to: Int): ByteArray {
    val b = d.copyOfRange(from, to)
    var i = 0
    while (i + 1 < b.size) {
      val a = b[i]
      b[i] = b[i + 1]
      b[i + 1] = a
      i += 2
    }
    return b
  }

  private fun utf16le(d: ByteArray, from: Int, to: Int): String {
    val s = StringBuilder((to - from) / 2)
    var i = from
    if (to - i >= 2 && u8(d, i) == 0xff && u8(d, i + 1) == 0xfe) i += 2
    while (i + 1 < to) {
      val u1 = u8(d, i) or (u8(d, i + 1) shl 8)
      i += 2
      if (u1 in 0xd800..0xdbff) {
        if (i + 1 < to) {
          val u2 = u8(d, i) or (u8(d, i + 1) shl 8)
          if (u2 in 0xdc00..0xdfff) {
            s.append(u1.toChar()).append(u2.toChar())
            i += 2
          } else {
            s.append('\ufffd')
          }
        } else {
          s.append('\ufffd')
        }
        continue
      }
      if (u1 in 0xdc00..0xdfff) {
        s.append('\ufffd')
        continue
      }
      s.append(u1.toChar())
    }
    if (i < to) s.append('\ufffd')
    return s.toString()
  }

  private fun utf8(d: ByteArray, from: Int, to: Int): String {
    var i = from
    if (to - i >= 3 && u8(d, i) == 0xef && u8(d, i + 1) == 0xbb && u8(d, i + 2) == 0xbf) i += 3
    return String(d, i, to - i, Charsets.UTF_8)
  }

  /** The bytes of [s] in UTF-8, a lone surrogate as three. */
  fun utf8Length(s: String): Int {
    var n = 0
    var i = 0
    while (i < s.length) {
      val c = s[i]
      when {
        c.code < 0x80 -> n += 1
        c.code < 0x800 -> n += 2
        c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
          n += 4
          i++
        }
        else -> n += 3
      }
      i++
    }
    return n
  }

  /** The first [n] UTF-16 units of [s], one less when the last would split a pair. */
  private fun headOf(s: String, n: Int): String {
    if (s.length <= n) return s
    return s.substring(0, if (s[n - 1].isHighSurrogate()) n - 1 else n)
  }

  // ------------------------------------------------------------------ numbers

  private fun u8(d: ByteArray, i: Int) = d[i].toInt() and 0xff

  private fun u24be(d: ByteArray, i: Int) = (u8(d, i) shl 16) or (u8(d, i + 1) shl 8) or u8(d, i + 2)

  private fun u32be(d: ByteArray, i: Int): Long = (u8(d, i).toLong() shl 24) or (u24be(d, i + 1).toLong())

  private fun u32le(d: ByteArray, i: Int): Long =
    (u8(d, i + 3).toLong() shl 24) or (u8(d, i + 2).toLong() shl 16) or (u8(d, i + 1).toLong() shl 8) or u8(d, i).toLong()

  private fun syncsafe(d: ByteArray, i: Int): Long =
    ((u8(d, i) and 0x7f).toLong() shl 21) or ((u8(d, i + 1) and 0x7f).toLong() shl 14) or ((u8(d, i + 2) and 0x7f).toLong() shl 7) or (u8(d, i + 3) and 0x7f).toLong()

  private fun ascii(d: ByteArray, start: Int, len: Int): String {
    val s = StringBuilder(len)
    for (i in start until minOf(d.size, start + len)) s.append(u8(d, i).toChar())
    return s.toString()
  }
}
