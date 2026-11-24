package com.baccarancia.mpfy

import java.io.ByteArrayOutputStream
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A file in memory that counts what is read of it and never lets a read pass its end. */
internal class MemorySource(private val data: ByteArray) : ByteSource {
  var bytesRead = 0L

  override val size: Long get() = data.size.toLong()

  override fun read(pos: Long, dst: ByteArray, off: Int, len: Int): Int {
    require(pos >= 0 && len >= 0)
    if (pos >= data.size) return -1
    val n = minOf(len.toLong(), data.size - pos).toInt()
    System.arraycopy(data, pos.toInt(), dst, off, n)
    bytesRead += n
    return n
  }
}

/** Builds the files of the tests, bytes only, synthetic texts only. */
internal object Bytes {
  fun of(vararg parts: Any): ByteArray {
    val o = ByteArrayOutputStream()
    for (p in parts) when (p) {
      is ByteArray -> o.write(p)
      is String -> o.write(p.toByteArray(Charsets.ISO_8859_1))
      is Int -> o.write(p)
      is List<*> -> for (x in p) o.write(of(x!!))
      else -> error("bad part $p")
    }
    return o.toByteArray()
  }

  fun u16be(n: Int) = byteArrayOf((n shr 8).toByte(), n.toByte())
  fun u24be(n: Int) = byteArrayOf((n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
  fun u32be(n: Long) = byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
  fun u32be(n: Int) = u32be(n.toLong() and 0xffffffffL)
  fun u32le(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())
  fun syncsafe(n: Int) = byteArrayOf((n shr 21 and 0x7f).toByte(), (n shr 14 and 0x7f).toByte(), (n shr 7 and 0x7f).toByte(), (n and 0x7f).toByte())
  fun fill(n: Int, seed: Int) = ByteArray(n) { ((it * 31 + seed) and 0xff).toByte() }

  // ID3v2
  fun id3(major: Int, vararg frames: ByteArray, flags: Int = 0, padding: Int = 0): ByteArray {
    val body = of(frames.toList(), ByteArray(padding))
    return of("ID3", major, 0, flags, syncsafe(body.size), body)
  }

  fun frame(major: Int, id: String, data: ByteArray, flags: Int = 0, size: Int = data.size): ByteArray = when (major) {
    2 -> of(id, u24be(size), data)
    3 -> of(id, u32be(size), u16be(flags), data)
    else -> of(id, syncsafe(size), u16be(flags), data)
  }

  fun enc(text: String, e: Int): ByteArray = when (e) {
    0 -> text.toByteArray(Charsets.ISO_8859_1)
    1 -> of(0xff, 0xfe, text.toByteArray(Charsets.UTF_16LE))
    -1 -> of(0xfe, 0xff, text.toByteArray(Charsets.UTF_16BE)) // encoding 1 with a big-endian BOM
    2 -> text.toByteArray(Charsets.UTF_16BE)
    else -> text.toByteArray(Charsets.UTF_8)
  }

  fun term(e: Int): ByteArray = if (e == 1 || e == -1 || e == 2) ByteArray(2) else ByteArray(1)

  fun encByte(e: Int) = if (e == -1) 1 else e

  fun uslt(e: Int, text: String, desc: String = "") = of(encByte(e), "eng", enc(desc, e), term(e), enc(text, e))

  fun sylt(e: Int, lines: List<Pair<String, Long>>, format: Int = 2) =
    of(encByte(e), "eng", format, 1, enc("", e), term(e), lines.map { (t, ms) -> of(enc(t, e), term(e), u32be(ms)) })

  fun apic(type: Int, data: ByteArray, mime: String = "image/jpeg", desc: String = "") = of(0, mime, 0, type, desc, 0, data)

  fun pic22(type: Int, data: ByteArray) = of(0, "JPG", type, "", 0, data)

  fun unsync(b: ByteArray): ByteArray {
    val o = ByteArrayOutputStream()
    for (i in b.indices) {
      o.write(b[i].toInt())
      if (b[i] == 0xff.toByte() && (i + 1 == b.size || (b[i + 1].toInt() and 0xe0) == 0xe0 || b[i + 1] == 0.toByte())) o.write(0)
    }
    return o.toByteArray()
  }

  // FLAC
  fun block(type: Int, data: ByteArray, last: Boolean = false) = of((if (last) 0x80 else 0) or type, u24be(data.size), data)

  fun streamInfo(rate: Int, bits: Int, channels: Int = 2): ByteArray {
    val b = ByteArray(34)
    b[10] = (rate shr 12).toByte()
    b[11] = (rate shr 4).toByte()
    b[12] = (((rate and 0xf) shl 4) or ((channels - 1) shl 1) or ((bits - 1) shr 4)).toByte()
    b[13] = (((bits - 1) and 0xf) shl 4).toByte()
    return b
  }

  fun comments(vararg kv: String) = of(u32le(4), "test", u32le(kv.size), kv.map { val v = it.toByteArray(Charsets.UTF_8); of(u32le(v.size), v) })

  fun flacPicture(type: Int, data: ByteArray, mime: String = "image/jpeg") =
    of(u32be(type), u32be(mime.length), mime, u32be(0), u32be(500), u32be(500), u32be(24), u32be(0), u32be(data.size), data)

  // Ogg
  fun oggPages(serial: Int, packets: List<ByteArray>, pageMax: Int = 255): ByteArray {
    val segs = ArrayList<Pair<ByteArray, Boolean>>() // a segment, and whether it starts a packet
    for (p in packets) {
      var i = 0
      var first = true
      while (true) {
        val n = minOf(255, p.size - i)
        segs.add(p.copyOfRange(i, i + n) to first)
        first = false
        i += n
        if (n < 255) break
      }
    }
    val o = ByteArrayOutputStream()
    var seq = 0
    var k = 0
    while (k < segs.size) {
      val page = segs.subList(k, minOf(segs.size, k + pageMax))
      val continued = !page.first().second
      o.write(of("OggS", 0, if (continued) 1 else if (seq == 0) 2 else 0, ByteArray(8), u32le(serial), u32le(seq), ByteArray(4), page.size, page.map { it.first.size }.map { byteArrayOf(it.toByte()) }, page.map { it.first }))
      seq++
      k += page.size
    }
    return o.toByteArray()
  }

  // MP4
  fun box(type: String, vararg payload: ByteArray) = of(u32be(8 + payload.sumOf { it.size }), type, payload.toList())

  fun data(type: Int, value: ByteArray) = box("data", u32be(type), u32be(0), value)
}

class TagReaderTest {
  private fun read(b: ByteArray, container: String) = TagReader.read(MemorySource(b), container)

  private val lyric = "Prima riga di prova\nSeconda riga di prova\nTerza riga, con un accento: perche' no"

  @Test
  fun usltIsReadInEveryEncodingOfId3v23And24() {
    for (major in listOf(3, 4)) {
      for (e in listOf(0, 1, -1, 2, 3)) {
        val text = if (e == 0) lyric else "$lyric \u00e8 \u4e2d"
        val f = Bytes.id3(major, Bytes.frame(major, "TIT2", Bytes.of(0, "Titolo")), Bytes.frame(major, "USLT", Bytes.uslt(e, text, desc = "d")), padding = 40)
        val info = read(Bytes.of(f, 0xff, 0xfb, 0x90, 0x64, Bytes.fill(500, 1)), "id3")
        assertEquals("v$major enc $e", listOf(text), info.texts)
        assertTrue(info.walked)
        assertEquals(f.size.toLong(), info.audioStart)
      }
    }
  }

  @Test
  fun id3v22UltIsReadAndItsSltIsLeftAsTheSourceLeavesIt() {
    val f = Bytes.id3(2, Bytes.frame(2, "ULT", Bytes.uslt(0, lyric)), Bytes.frame(2, "SLT", Bytes.sylt(0, listOf("a" to 10L, "b" to 20L))))
    val info = read(f, "id3")
    assertEquals(listOf(lyric), info.texts)
    assertTrue(info.synced.isEmpty())
  }

  @Test
  fun syltIsReadInMillisecondsOnly() {
    val lines = listOf("uno" to 1200L, "due" to 3400L, "tre" to 5600L)
    for (e in listOf(0, 1, 3)) {
      val f = Bytes.id3(3, Bytes.frame(3, "SYLT", Bytes.sylt(e, lines)), Bytes.frame(3, "SYLT", Bytes.sylt(e, lines, format = 1)))
      val info = read(f, "id3")
      assertEquals(1, info.synced.size)
      assertEquals(lines, info.synced.single().map { it.text to it.t })
    }
  }

  @Test
  fun aLongSyltIsReadUntilIts2001stLine() {
    val lines = (0 until 5000).map { "riga $it" to it * 100L }
    val info = read(Bytes.id3(4, Bytes.frame(4, "SYLT", Bytes.sylt(3, lines))), "id3")
    assertEquals(TagReader.MAX_LINES + 1, info.synced.single().size)
  }

  @Test
  fun aTextOver64KbIsRefusedBeforeItIsRead() {
    val big = "x".repeat(70 * 1024)
    for (e in listOf(0, 1)) {
      val src = MemorySource(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(e, big)), Bytes.frame(3, "USLT", Bytes.uslt(e, "corto"))))
      val info = TagReader.read(src, "id3")
      assertEquals(listOf("corto"), info.texts)
      assertTrue("read ${src.bytesRead} bytes", src.bytesRead < 8 * 1024)
    }
    // UTF-8 may hold 64 KB in more bytes: read, then refused.
    val info = read(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(3, big))), "id3")
    assertTrue(info.texts.isEmpty())
    // Exactly at the limit: kept.
    val edge = "y".repeat(64 * 1024)
    assertEquals(listOf(edge), read(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, edge))), "id3").texts)
  }

  @Test
  fun aFrameSizePastTheEndIsCutAtTheEndOfTheTag() {
    val pic = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(300, 2))
    // The picture frame says 2 GB; the tag ends 300 bytes after its header.
    val frame = Bytes.frame(3, "APIC", Bytes.apic(3, pic), size = 0x7ffffff0)
    val f = Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, lyric)), frame)
    val file = Bytes.of(f, Bytes.fill(2000, 9))
    val src = MemorySource(file)
    val info = TagReader.read(src, "id3")
    assertEquals(listOf(lyric), info.texts)
    val chosen = TagReader.chosen(info)!!
    assertEquals(3, chosen.typeId)
    assertArrayEquals(pic, chosen.bytes())
  }

  @Test
  fun aTagLargerThanTheFileIsNotTrusted() {
    val f = Bytes.of("ID3", 3, 0, 0, Bytes.syncsafe(50_000_000), Bytes.frame(3, "USLT", Bytes.uslt(0, lyric)))
    val info = read(f, "id3")
    assertFalse(info.walked)
    assertTrue(info.texts.isEmpty())
  }

  @Test
  fun unsynchronisedTagsAndFramesAreReadBack() {
    val pic = Bytes.of(0xff, 0xd8, 0xff, 0xe0, 0xff, 0x00, 0xff, 0xff, Bytes.fill(100, 3))
    // ID3v2.3: the whole tag.
    val body = Bytes.unsync(Bytes.of(Bytes.frame(3, "APIC", Bytes.apic(3, pic)), Bytes.frame(3, "USLT", Bytes.uslt(0, lyric))))
    val v3 = Bytes.of("ID3", 3, 0, 0x80, Bytes.syncsafe(body.size), body)
    val i3 = read(v3, "id3")
    assertArrayEquals(pic, TagReader.chosen(i3)!!.bytes())
    assertEquals(listOf(lyric), i3.texts)
    // ID3v2.4: per frame, with a data length indicator.
    val raw = Bytes.apic(3, pic)
    val v4data = Bytes.of(Bytes.syncsafe(raw.size), Bytes.unsync(raw))
    val v4 = Bytes.id3(4, Bytes.frame(4, "APIC", v4data, flags = 0x0003), Bytes.frame(4, "USLT", Bytes.uslt(3, lyric)))
    val i4 = read(v4, "id3")
    assertArrayEquals(pic, TagReader.chosen(i4)!!.bytes())
    assertEquals(listOf(lyric), i4.texts)
  }

  @Test
  fun theFrontCoverIsChosenWhenABackCoverComesFirst() {
    val back = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(50, 1))
    val front = Bytes.of(0x89, "PNG", Bytes.fill(80, 2))
    val other = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(60, 3))
    // ID3v2.3
    val mp3 = read(Bytes.id3(3, Bytes.frame(3, "APIC", Bytes.apic(4, back)), Bytes.frame(3, "APIC", Bytes.apic(3, front, "image/png", "fronte")), Bytes.frame(3, "APIC", Bytes.apic(0, other))), "id3")
    assertEquals(listOf(4, 3, 0), mp3.pictures.map { it.typeId })
    assertArrayEquals(front, TagReader.chosen(mp3)!!.bytes())
    // ID3v2.2
    val v22 = read(Bytes.id3(2, Bytes.frame(2, "PIC", Bytes.pic22(4, back)), Bytes.frame(2, "PIC", Bytes.pic22(3, front))), "id3")
    assertArrayEquals(front, TagReader.chosen(v22)!!.bytes())
    // FLAC picture blocks
    val flac = Bytes.of("fLaC", Bytes.block(0, Bytes.streamInfo(44100, 16)), Bytes.block(6, Bytes.flacPicture(4, back)), Bytes.block(6, Bytes.flacPicture(3, front, "image/png"), last = true), Bytes.fill(100, 4))
    assertArrayEquals(front, TagReader.chosen(read(flac, "flac"))!!.bytes())
    // No front cover: the first.
    val none = read(Bytes.id3(3, Bytes.frame(3, "APIC", Bytes.apic(4, back)), Bytes.frame(3, "APIC", Bytes.apic(0, other))), "id3")
    assertArrayEquals(back, TagReader.chosen(none)!!.bytes())
    assertNull(TagReader.chosen(read(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, lyric))), "id3")))
  }

  @Test
  fun onlyTheChosenPictureIsRead() {
    val big = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(400_000, 1))
    val front = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(100, 2))
    val src = MemorySource(Bytes.id3(3, Bytes.frame(3, "APIC", Bytes.apic(4, big)), Bytes.frame(3, "APIC", Bytes.apic(3, front))))
    val info = TagReader.read(src, "id3")
    assertArrayEquals(front, TagReader.chosen(info)!!.bytes())
    assertTrue("read ${src.bytesRead}", src.bytesRead < 20_000)
  }

  @Test
  fun vorbisCommentsInFlacGiveLyricsPicturesAndTheBitDepth() {
    val front = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(70, 5))
    val b64 = Base64.getEncoder().encodeToString(Bytes.flacPicture(3, front))
    val flac = Bytes.of(
      "fLaC",
      Bytes.block(0, Bytes.streamInfo(96000, 24)),
      Bytes.block(4, Bytes.comments("TITLE=Titolo", "lyrics=$lyric", "UNSYNCEDLYRICS=altro testo", "METADATA_BLOCK_PICTURE=$b64")),
      Bytes.block(1, ByteArray(100), last = true),
      Bytes.fill(300, 6),
    )
    val info = read(flac, "flac")
    assertEquals(listOf(lyric, "altro testo"), info.texts)
    assertEquals(24, info.bitDepth)
    assertEquals(96000, info.sampleRate)
    assertArrayEquals(front, TagReader.chosen(info)!!.bytes())
  }

  @Test
  fun anId3TagBeforeFlacIsReadAndSoAreTheBlocks() {
    val flac = Bytes.of(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, "dal tag"))), "fLaC", Bytes.block(0, Bytes.streamInfo(44100, 16)), Bytes.block(4, Bytes.comments("LYRICS=dal blocco"), last = true))
    val info = read(flac, "id3")
    assertEquals(listOf("dal tag", "dal blocco"), info.texts)
    assertEquals(16, info.bitDepth)
  }

  @Test
  fun oggVorbisAndOpusCommentsAreReadAcrossPages() {
    val back = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(900, 1))
    val front = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(700, 2))
    val pics = listOf(4 to back, 3 to front).map { (t, d) -> "METADATA_BLOCK_PICTURE=" + Base64.getEncoder().encodeToString(Bytes.flacPicture(t, d)) }
    val vorbisId = Bytes.of(1, "vorbis", Bytes.u32le(0), 2, Bytes.u32le(48000), ByteArray(13), 1)
    val vorbisComments = Bytes.of(3, "vorbis", Bytes.comments("ARTIST=Qualcuno", "Unsynced Lyrics=$lyric", *pics.toTypedArray()), 1)
    // Small pages: the comment packet spans several.
    val ogg = Bytes.of(Bytes.oggPages(7, listOf(vorbisId, vorbisComments, Bytes.fill(400, 3)), pageMax = 3))
    val v = read(ogg, "ogg")
    assertEquals(listOf(lyric), v.texts)
    assertArrayEquals(front, TagReader.chosen(v)!!.bytes())
    val opusHead = Bytes.of("OpusHead", 1, 2, Bytes.u16be(0), Bytes.u32le(48000), Bytes.u16be(0), 0)
    val opusTags = Bytes.of("OpusTags", Bytes.comments("LYRICS=$lyric"))
    val o = read(Bytes.oggPages(9, listOf(opusHead, opusTags, Bytes.fill(400, 3))), "opus")
    assertEquals(listOf(lyric), o.texts)
  }

  @Test
  fun mp4LyricsAndCoversAreReadWithTheirBoxesChecked() {
    val jpeg = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(200, 1))
    val png = Bytes.of(0x89, "PNG", Bytes.fill(90, 2))
    val ilst = Bytes.box("ilst", Bytes.box("\u00a9nam", Bytes.data(1, "Titolo".toByteArray())), Bytes.box("\u00a9lyr", Bytes.data(1, lyric.toByteArray(Charsets.UTF_8))), Bytes.box("covr", Bytes.data(13, jpeg), Bytes.data(14, png)))
    val meta = Bytes.box("meta", ByteArray(4), Bytes.box("hdlr", ByteArray(25)), ilst)
    val moov = Bytes.box("moov", Bytes.box("mvhd", ByteArray(100)), Bytes.box("udta", meta))
    val file = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray(), ByteArray(8)), Bytes.box("mdat", Bytes.fill(5000, 3)), moov)
    val info = read(file, "m4a")
    assertEquals(listOf(lyric), info.texts)
    assertEquals(2, info.pictures.size)
    assertArrayEquals(jpeg, TagReader.chosen(info)!!.bytes())
  }

  @Test
  fun aHostileBoxSizeStopsTheWalkWithoutReadingPastIt() {
    val lyr = Bytes.of(0xa9, "lyr")
    val good = Bytes.of(Bytes.u32be(8 + 16 + 5), lyr, Bytes.data(1, "testo".toByteArray()))
    val hostile = Bytes.of(Bytes.u32be(0xffffffffL), "covr", Bytes.data(13, Bytes.fill(20, 1)))
    val ilst = Bytes.of(Bytes.u32be(8 + good.size + hostile.size), "ilst", good, hostile)
    val meta = Bytes.box("meta", ByteArray(4), ilst)
    // moov says it is far longer than the file.
    val moovBody = Bytes.box("udta", meta)
    val moov = Bytes.of(Bytes.u32be(10_000_000), "moov", moovBody)
    val file = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray()), moov)
    val src = MemorySource(file)
    val info = TagReader.read(src, "m4a")
    assertEquals(listOf("testo"), info.texts)
    assertTrue(info.pictures.isEmpty())
    assertTrue(src.bytesRead <= file.size)
    // A box smaller than its own header.
    val tiny = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray()), Bytes.u32be(3), "moov", Bytes.fill(40, 1))
    assertTrue(read(tiny, "m4a").texts.isEmpty())
  }

  @Test
  fun wavGivesItsBitDepthAndItsId3Chunk() {
    val fmt = Bytes.of(Bytes.u16be(0x0100), Bytes.u16be(0x0200), Bytes.u32le(48000), Bytes.u32le(48000 * 6), Bytes.u16be(0x0600), Bytes.u16be(0x1800))
    val tag = Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, lyric)))
    val body = Bytes.of("WAVE", "fmt ", Bytes.u32le(fmt.size), fmt, "id3 ", Bytes.u32le(tag.size), tag, if (tag.size % 2 == 1) Bytes.of(0) else ByteArray(0), "data", Bytes.u32le(100), ByteArray(100))
    val wav = Bytes.of("RIFF", Bytes.u32le(body.size), body)
    val info = read(wav, "wav")
    assertEquals(24, info.bitDepth)
    assertEquals(48000, info.sampleRate)
    assertEquals(listOf(lyric), info.texts)
  }

  @Test
  fun aPictureOverTheCoverLimitIsNotRead() {
    val f = Bytes.id3(3, Bytes.frame(3, "APIC", Bytes.of(0, "image/jpeg", 0, 3, "", 0)), padding = 10)
    // A frame that claims a 20 MB picture inside a tag that really holds it would be refused unread.
    val p = TagReader.chosen(read(f, "id3"))
    assertNotNull(p)
    val huge = Picture(3, 20L * 1024 * 1024) { error("read") }
    assertNull(huge.bytes())
  }

  @Test
  fun theContainerIsSniffedAsTheSourceDoes() {
    val doc = Json.obj(javaClass.getResource("/local/vectors.json")!!.readText())!!
    @Suppress("UNCHECKED_CAST")
    for (v in doc["sniff"] as List<Map<String, Any?>>) {
      val hex = v["hex"] as String
      val head = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
      assertEquals(v["name"] as String, v["format"], TagReader.sniff(head))
    }
  }

  @Test
  fun sortTagsAndGainsAreReadInEveryContainer() {
    // ID3v2.3: TSOP, TSOT and a TXXX of ReplayGain; a TXXX of anything else is left.
    val tag = Bytes.id3(
      3,
      Bytes.frame(3, "TSOP", Bytes.of(0, "Beatles, The")),
      Bytes.frame(3, "TSOT", Bytes.of(0, "Kokoro", 0)),
      Bytes.frame(3, "TXXX", Bytes.of(0, "replaygain_track_gain", 0, "-6.52 dB")),
      Bytes.frame(3, "TXXX", Bytes.of(0, "MOOD", 0, "allegro")),
    )
    val v = read(Bytes.of(tag, Bytes.fill(200, 1)), "mp3").values
    assertEquals(mapOf("ARTISTSORT" to "Beatles, The", "TITLESORT" to "Kokoro", "REPLAYGAIN_TRACK_GAIN" to "-6.52 dB"), v)
    // Vorbis comments, any case.
    val flac = Bytes.of(
      "fLaC",
      Bytes.block(0, Bytes.streamInfo(44100, 16)),
      Bytes.block(4, Bytes.comments("ALBUMSORT=Album, The", "R128_TRACK_GAIN=-1234", "replaygain_album_peak=0.98"), last = true),
      Bytes.fill(100, 2),
    )
    assertEquals(mapOf("ALBUMSORT" to "Album, The", "R128_TRACK_GAIN" to "-1234", "REPLAYGAIN_ALBUM_PEAK" to "0.98"), read(flac, "flac").values)
    // MP4: soaa, and a freeform iTunes item.
    val soaa = Bytes.box("soaa", Bytes.data(1, "Artisti, Vari".toByteArray()))
    val free = Bytes.box("----", Bytes.box("mean", ByteArray(4), "com.apple.iTunes".toByteArray()), Bytes.box("name", ByteArray(4), "replaygain_track_peak".toByteArray()), Bytes.data(1, "0.5".toByteArray()))
    val ilst = Bytes.box("ilst", soaa, free)
    val m4a = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray()), Bytes.box("moov", Bytes.box("udta", Bytes.box("meta", ByteArray(4), ilst))))
    assertEquals(mapOf("ALBUMARTISTSORT" to "Artisti, Vari", "REPLAYGAIN_TRACK_PEAK" to "0.5"), read(m4a, "m4a").values)
    // Into the facts: the numbers parsed, sort names as they are.
    val t = linkedMapOf<String, Any?>()
    sortAndGain(v + mapOf("R128_ALBUM_GAIN" to " 512 ", "REPLAYGAIN_ALBUM_GAIN" to "n/a"), t)
    assertEquals(mapOf("artistSort" to "Beatles, The", "titleSort" to "Kokoro", "rg" to mapOf("trackGain" to -6.52, "r128Album" to 512)), t)
  }
}
