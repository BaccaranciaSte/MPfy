package com.baccarancia.mpfy

import com.baccarancia.mpfy.Json.list
import com.baccarancia.mpfy.Json.map
import com.baccarancia.mpfy.Json.str
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One file as the platform would give it: its bytes, what the system says of it, what the retriever reads. */
internal class FakeOpen(
  private val data: ByteArray,
  var stats: MutableList<Stat>,
  var meta: Meta?,
  var platformPicture: ByteArray? = null,
  var lrc: String? = null,
) : OpenFile {
  var bytesRead = 0L
  var closed = false
  var metaCalls = 0

  override val size: Long get() = data.size.toLong()

  override fun read(pos: Long, dst: ByteArray, off: Int, len: Int): Int {
    if (pos >= data.size) return -1
    val n = minOf(len.toLong(), data.size - pos).toInt()
    System.arraycopy(data, pos.toInt(), dst, off, n)
    bytesRead += n
    return n
  }

  override fun stat(): Stat = if (stats.size > 1) stats.removeAt(0) else stats[0]

  var codecAsked = false

  override fun metadata(codec: Boolean): Meta? {
    metaCalls++
    codecAsked = codec
    return meta
  }

  override fun embeddedPicture(): ByteArray? = platformPicture

  override fun lrcBeside(): String? = lrc

  override fun close() {
    closed = true
  }
}

internal class FakeArt : ArtSink {
  val made = ArrayList<String>()
  var decodes = true

  override fun has(coverId: String): Boolean = coverId in made

  override fun put(coverId: String, image: ByteArray): Boolean {
    if (!decodes) return false
    made.add(coverId)
    return true
  }
}

class LocalProbeTest {
  private val art = FakeArt()
  private var open: FakeOpen? = null
  private val probe = FileProbe(object : ProbeIo {
    override fun open(row: Row): OpenFile? = open
  }, art)

  private fun meta(durationMs: Long? = 241_371, codec: String? = null, video: Boolean = false) =
    Meta("Titolo", "Artista", null, null, 3, null, 2019, durationMs, 320_000, 44_100, null, codec, video)

  private fun row(data: ByteArray, mtime: Long = 1_700_000_000_000) = Row("external_primary", 7, "Music/", "x.mp3", data.size.toLong(), mtime, mtime, 3, null)

  private fun file(data: ByteArray, meta: Meta? = meta(), stats: MutableList<Stat>? = null): Row {
    val r = row(data)
    open = FakeOpen(data, stats ?: mutableListOf(Stat(data.size.toLong(), r.mtime / 1000)), meta)
    return r
  }

  private fun facts(p: Probe) = Json.obj(p.facts!!.json())!!

  private val mpeg = Bytes.of(0xff, 0xfb, 0x90, 0x64)

  @Test
  fun theIdIsTheSourcesIdForTheSameBytes() {
    @Suppress("UNCHECKED_CAST")
    val v = Json.obj(javaClass.getResource("/local/vectors.json")!!.readText())!!["file"] as Map<String, Any?>
    val data = Bytes.of(mpeg, Bytes.fill((v["length"] as Long).toInt(), (v["seed"] as Long).toInt()))
    val p = probe.probe(file(data))
    assertEquals(Probe.Outcome.OK, p.outcome)
    assertEquals(v["id"], p.facts!!.id)
    assertEquals("mp3", facts(p).str("format"))
    assertTrue(open!!.closed)
    // MPEG audio says its codec: no extractor for it.
    assertFalse(open!!.codecAsked)
    // Read whole once, plus the head and the tag regions.
    assertTrue(open!!.bytesRead in data.size.toLong()..data.size.toLong() + 64 * 1024)
  }

  @Test
  fun aFileThatChangesDuringItsReadKeepsNothing() {
    val data = Bytes.of(mpeg, Bytes.fill(10_000, 1))
    // Grew between the two looks at it.
    val r = file(data, stats = mutableListOf(Stat(data.size.toLong(), 1_700_000_000), Stat(data.size + 4096L, 1_700_000_001)))
    assertEquals(Probe.Outcome.CHANGING, probe.probe(r).outcome)
    // The system's row is not the file any more: not even read.
    val stale = file(data, stats = mutableListOf(Stat(data.size + 1L, 1_700_000_000)))
    val p = probe.probe(stale)
    assertEquals(Probe.Outcome.CHANGING, p.outcome)
    assertNull(p.facts)
    assertEquals(0L, open!!.bytesRead)
  }

  @Test
  fun whatIsNotAudioOrTooShortOrAVideoIsSkipped() {
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(Bytes.of("#!AMR\n", Bytes.fill(500, 1)))).outcome)
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(Bytes.of(mpeg, Bytes.fill(500, 1)), meta(durationMs = 300))).outcome)
    // MPEG audio needs a duration; FLAC may have none.
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(Bytes.of(mpeg, Bytes.fill(500, 1)), meta(durationMs = null))).outcome)
    val flac = Bytes.of("fLaC", Bytes.block(0, Bytes.streamInfo(44100, 16), last = true), Bytes.fill(500, 2))
    assertEquals(Probe.Outcome.OK, probe.probe(file(flac, meta(durationMs = null))).outcome)
    val mp4 = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray()), Bytes.fill(500, 3))
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(mp4, meta(codec = "audio/mp4a-latm", video = true))).outcome)
  }

  @Test
  fun aRetrieverThatFailsLeavesTheFileUnreadable() {
    assertEquals(Probe.Outcome.UNREADABLE, probe.probe(file(Bytes.of(mpeg, Bytes.fill(500, 1)), meta = null)).outcome)
    open = null
    assertEquals(Probe.Outcome.UNREADABLE, probe.probe(row(ByteArray(10))).outcome)
  }

  @Test
  fun theChosenPictureMakesTheCoverOnce() {
    val back = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(50, 1))
    val front = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(80, 2))
    val data = Bytes.of(Bytes.id3(3, Bytes.frame(3, "APIC", Bytes.apic(4, back)), Bytes.frame(3, "APIC", Bytes.apic(3, front))), mpeg, Bytes.fill(2000, 3))
    val p = probe.probe(file(data))
    assertEquals(CoverArt.coverId(front), p.facts!!.coverId)
    assertEquals("file", facts(p).str("coverFrom"))
    assertEquals(listOf(CoverArt.coverId(front)), art.made)
    probe.probe(file(data))
    assertEquals(1, art.made.size)
    // A picture that does not decode is no cover.
    art.decodes = false
    art.made.clear()
    assertNull(probe.probe(file(data)).facts!!.coverId)
  }

  @Test
  fun thePlatformsPictureIsUsedOnlyWhereTheReaderCouldNotWalk() {
    val pic = Bytes.of(0xff, 0xd8, 0xff, Bytes.fill(60, 4))
    val walked = file(Bytes.of(mpeg, Bytes.fill(2000, 1)))
    open!!.platformPicture = pic
    assertNull(probe.probe(walked).facts!!.coverId)
    // A tag that claims more than the file holds: not walked.
    val broken = Bytes.of("ID3", 3, 0, 0, Bytes.syncsafe(9_000_000), mpeg, Bytes.fill(2000, 1))
    val r = file(broken)
    open!!.platformPicture = pic
    assertEquals(CoverArt.coverId(pic), probe.probe(r).facts!!.coverId)
  }

  @Test
  fun theFactsCarryTheRawTagsLyricsAndAnLrcBeside() {
    val data = Bytes.of(Bytes.id3(3, Bytes.frame(3, "USLT", Bytes.uslt(0, "testo semplice")), Bytes.frame(3, "SYLT", Bytes.sylt(0, listOf("uno" to 1000L, "due" to 2000L)))), mpeg, Bytes.fill(2000, 3))
    val r = file(data)
    open!!.lrc = "[00:01.00]riga"
    val f = facts(probe.probe(r))
    val tags = f.map("tags")!!
    assertEquals("Titolo", tags["title"])
    assertNull(tags["album"])
    assertEquals(3L, tags["trackNo"])
    assertEquals(2019L, tags["year"])
    assertEquals(241.371, f["duration"])
    assertEquals("audio/mpeg", f["codec"])
    val lyr = f.map("lyrics")!!
    assertEquals(listOf("testo semplice"), lyr.list("texts"))
    assertEquals(listOf(mapOf("t" to 1000L, "text" to "uno"), mapOf("t" to 2000L, "text" to "due")), lyr.list("synced")!!.single())
    assertEquals("[00:01.00]riga", lyr["lrc"])
    // No lyrics at all: null.
    assertNull(facts(probe.probe(file(Bytes.of(mpeg, Bytes.fill(500, 1)))))["lyrics"])
  }

  @Test
  fun aFlacGivesItsBitDepthWhereTheRetrieverDoesNot() {
    val flac = Bytes.of("fLaC", Bytes.block(0, Bytes.streamInfo(96000, 24), last = true), Bytes.fill(500, 2))
    val f = facts(probe.probe(file(flac, Meta(null, null, null, null, null, null, null, 241_000, null, null, null, null, false))))
    assertEquals("flac", f["format"])
    assertEquals(24L, f["bitDepth"])
    assertEquals(96000L, f["sampleRate"])
  }

  @Test
  fun anId3TagDecidesNothingAboutTheFormatThatFollowsIt() {
    val adts = Bytes.of(Bytes.id3(3, Bytes.frame(3, "TIT2", Bytes.of(0, "x"))), 0xff, 0xf1, 0x50, 0x80, Bytes.fill(500, 1))
    assertEquals("aac", facts(probe.probe(file(adts)))["format"])
    val flac = Bytes.of(Bytes.id3(3, Bytes.frame(3, "TIT2", Bytes.of(0, "x"))), "fLaC", Bytes.block(0, Bytes.streamInfo(44100, 16), last = true), Bytes.fill(500, 1))
    assertEquals("flac", facts(probe.probe(file(flac)))["format"])
    val mp3 = Bytes.of(Bytes.id3(4, Bytes.frame(4, "TIT2", Bytes.of(0, "x"))), mpeg, Bytes.fill(500, 1))
    assertEquals("mp3", facts(probe.probe(file(mp3)))["format"])
  }

  @Test
  fun anAlacFileSaysItsCodec() {
    val mp4 = Bytes.of(Bytes.box("ftyp", "M4A ".toByteArray()), Bytes.fill(500, 3))
    val f = facts(probe.probe(file(mp4, meta(codec = "audio/alac"))))
    assertEquals("m4a", f["format"])
    assertEquals("audio/alac", f["codec"])
    assertTrue(open!!.codecAsked)
  }

  @Test
  fun aFileShorterThan20SecondsOrOfLength0IsSkippedAndAnUnknownLengthStays() {
    val flac = Bytes.of("fLaC", Bytes.block(0, Bytes.streamInfo(44100, 16), last = true), Bytes.fill(500, 2))
    val mp3 = Bytes.of(mpeg, Bytes.fill(500, 1))
    // A voice command, a voice model's sample, a short mp3 in Download: not songs.
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(flac, meta(durationMs = 1_900))).outcome)
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(flac, meta(durationMs = 8_600))).outcome)
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(mp3, meta(durationMs = 6_000))).outcome)
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(mp3, meta(durationMs = 19_999))).outcome)
    // A length the platform knows to be 0 is not an unknown one.
    assertEquals(Probe.Outcome.SKIPPED, probe.probe(file(flac, meta(durationMs = 0))).outcome)
    // 20 s is a song; a FLAC whose length nobody knows stays, as before.
    assertEquals(Probe.Outcome.OK, probe.probe(file(flac, meta(durationMs = 20_000))).outcome)
    assertEquals(Probe.Outcome.OK, probe.probe(file(flac, meta(durationMs = null))).outcome)
  }
}
