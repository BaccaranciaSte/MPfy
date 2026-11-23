package com.baccarancia.mpfy

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private const val ORIGIN_L = "http://127.0.0.1:47123"

/** The phone's files by track id, from a folder; [vanish] takes one away as a card pulled out would. */
private class FolderFiles(private val dir: File) : LocalFiles {
  val asked = ArrayList<String>()

  override fun open(trackId: String): FileInputStream? {
    asked.add(trackId)
    val f = File(dir, trackId)
    return if (f.isFile) FileInputStream(f) else null
  }

  fun vanish(trackId: String) {
    File(dir, trackId).delete()
  }
}

/** A source's answer: [body] from the Range's first byte, every one of them, or up to [failAfter]. */
private class SourceAnswer(override val etag: String?, private val body: ByteArray, private val from: Int) : Upstream {
  override val status = if (from > 0) 206 else 200
  override val quality: String? = "max"
  override val length = (body.size - from).toLong()
  override val totalSize = body.size.toLong()
  private var pos = from

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (pos >= body.size) return -1
    val n = minOf(length, body.size - pos)
    System.arraycopy(body, pos, buffer, offset, n)
    pos += n
    return n
  }

  override fun abort() {}

  override fun close() {}
}

class LocalOpenerTest {
  private val dir: File = Files.createTempDirectory("mpfy-local").toFile()
  private val id = "0123456789abcdef01234567"
  private val body = ByteArray(200_000) { (it * 7 + 3).toByte() }
  private val files = FolderFiles(dir)
  private val http = ArrayList<String>()
  private val sources = HashMap<String, ByteArray>()
  private val httpOpener = Opener { url, headers ->
    http.add(url)
    val data = sources.entries.firstOrNull { url.startsWith(it.key) }?.value ?: throw IOException("refused")
    val from = headers["Range"]?.substringAfter("bytes=")?.substringBefore('-')?.toInt() ?: 0
    SourceAnswer("\"$id\"", data, from)
  }
  private val opener = LocalOpener(httpOpener, files, ORIGIN_L)
  private lateinit var timer: ScheduledExecutorService

  private val phone = Version(LocalSource.ID, id, id, "", 0)
  private val source = Version("aaaa0001", id, id, "", 0)
  private val other = Version("bbbb0002", "ffffffffffffffffffffffff", "ffffffffffffffffffffffff", "", 2_000)

  @Before
  fun setUp() {
    File(dir, id).writeBytes(body)
    timer = Executors.newSingleThreadScheduledExecutor()
  }

  @After
  fun tearDown() {
    timer.shutdownNow()
    dir.deleteRecursively()
  }

  private fun url(v: Version, level: String = "high") = streamUrl(ORIGIN_L, v, level)

  private fun readAll(u: Upstream): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (true) {
      val n = u.read(buf, 0, buf.size)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  @Test
  fun aRangeIsServedFromItsPositionAsTheOriginalFile() {
    val r = opener.open(url(phone), requestHeaders(150_000, -1))
    assertEquals(206, r.status)
    assertEquals("max", r.quality)
    assertEquals("\"$id\"", r.etag)
    assertEquals(50_000L, r.length)
    assertEquals(body.size.toLong(), r.totalSize)
    assertArrayEquals(body.copyOfRange(150_000, 200_000), readAll(r))
    r.close()
    // A bounded range, and the whole file with no Range at all.
    val part = opener.open(url(phone), requestHeaders(10, 100))
    assertEquals(100L, part.length)
    assertArrayEquals(body.copyOfRange(10, 110), readAll(part))
    val whole = opener.open(url(phone), emptyMap())
    assertEquals(body.size.toLong(), whole.length)
    assertArrayEquals(body, readAll(whole))
    assertTrue(http.isEmpty())
  }

  @Test
  fun aPositionAtTheEndAnswers416WithTheSize() {
    val r = opener.open(url(phone), requestHeaders(body.size.toLong(), -1))
    assertEquals(416, r.status)
    assertEquals(body.size.toLong(), r.totalSize)
  }

  @Test
  fun anUnknownFileOrAnotherFileHashIsNotFound() {
    assertEquals(404, opener.open(url(phone.copy(trackId = "fedcba9876543210fedcba98", fileHash = "fedcba9876543210fedcba98")), emptyMap()).status)
    // The phone's id is its file's hash: a version naming another file is gone.
    assertEquals(404, opener.open("$ORIGIN_L/s/0000/api/stream/$id?q=max&f=fedcba9876543210fedcba98", emptyMap()).status)
    assertTrue(http.isEmpty())
  }

  @Test
  fun anyOtherUrlReachesTheCore() {
    sources[url(source).substringBefore('?')] = body
    val r = opener.open(url(source), emptyMap())
    assertEquals(listOf(url(source)), http)
    assertArrayEquals(body, readAll(r))
    // A look-alike path on another origin, or another source id, is not the phone's.
    for (u in listOf("http://127.0.0.1:47124/s/0000/api/stream/$id", "$ORIGIN_L/s/00000/api/stream/$id", "$ORIGIN_L/s/0000/api/cover/$id")) {
      http.clear()
      try {
        opener.open(u, emptyMap())
      } catch (e: IOException) {
        // the fake core refuses what it does not know
      }
      assertEquals(listOf(u), http)
    }
    assertTrue(files.asked.isEmpty())
  }

  @Test
  fun aVanishedFileMovesThePlayerToTheNextVersionAtTheSameMoment() {
    val registry = VersionRegistry()
    val key = Levels.streamKey(LocalSource.ID, id, id, "high")
    registry.put(key, VersionRegistry.Entry(id, "high", listOf(phone, other)))
    files.vanish(id)
    val reader = FailoverReader(registry, opener, LocalRepresentations(StreamFake()), { _, _ -> AutoCloseable {} }, timer, ORIGIN_L)
    try {
      reader.open(key, url(phone), 0, -1)
      fail("the open must throw")
    } catch (e: VersionsExhaustedException) {
      // Another version is there: the player moves on at once (no retry of a file that is gone).
      assertTrue(e.hasUntried)
      assertEquals(androidx.media3.common.C.TIME_UNSET, StreamRetry.delayFor(e, 1))
    }
    reader.close()
    val s = VersionOrder.next(listOf(phone, other), key, emptySet(), 30_000)!!
    assertEquals(other, s.versions.first())
    assertEquals(32_000L, s.atMs)
    assertTrue(http.isEmpty())
  }

  @Test
  fun aFileThatFailsMidSongGoesOnFromTheSameFileOnASource() {
    // The same bytes on a source: at Max the read goes on there at the same byte.
    val registry = VersionRegistry()
    val key = Levels.streamKey(LocalSource.ID, id, id, "max")
    registry.put(key, VersionRegistry.Entry(id, "max", listOf(phone, source)))
    sources[url(source, "max").substringBefore('?')] = body
    val cut = object : LocalFiles {
      override fun open(trackId: String): FileInputStream? {
        val f = File(dir, trackId)
        return object : FileInputStream(f) {
          var n = 0

          override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (n >= 60_000) throw IOException("the card was pulled out")
            val got = super.read(b, off, minOf(len, 60_000 - n))
            if (got > 0) n += got
            return got
          }
        }
      }
    }
    val reader = FailoverReader(registry, LocalOpener(httpOpener, cut, ORIGIN_L), LocalRepresentations(StreamFake()), { _, _ -> AutoCloseable {} }, timer, ORIGIN_L)
    reader.open(key, url(phone, "max"), 0, -1)
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (true) {
      val n = reader.read(buf, 0, buf.size)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    reader.close()
    assertArrayEquals(body, out.toByteArray())
    assertEquals(1, http.size)
    assertTrue(http[0].startsWith("$ORIGIN_L/s/aaaa0001/api/stream/$id"))
  }

  @Test
  fun aPhoneFileKeepsNothingInTheStreamCache() {
    val cache = StreamFake()
    val reps = LocalRepresentations(cache)
    val key = Levels.streamKey(LocalSource.ID, id, id, "max")
    assertTrue(reps.admit(key, "\"$id\""))
    assertNull(reps.etagOf(key))
    assertTrue(cache.admitted.isEmpty())
    // A source's key is guarded as before.
    val theirs = Levels.streamKey("aaaa0001", id, id, "max")
    assertTrue(reps.admit(theirs, "\"$id\""))
    assertEquals(listOf(theirs), cache.admitted)
  }

  @Test
  fun thePhonesKeysAndUrlsAreKnownAsSuch() {
    assertTrue(LocalSource.isKey(Levels.streamKey(LocalSource.ID, id, id, "high")))
    assertFalse(LocalSource.isKey(Levels.streamKey("aaaa0001", id, id, "high")))
    assertFalse(LocalSource.isKey(Levels.key(id, id, "high")))
    assertEquals(id, LocalSource.trackOf("$ORIGIN_L/s/0000/api/stream/$id?q=high&f=$id", ORIGIN_L))
    assertNull(LocalSource.trackOf("$ORIGIN_L/s/aaaa0001/api/stream/$id", ORIGIN_L))
    assertNull(LocalSource.trackOf("$ORIGIN_L/s/0000/api/stream/bad..id", ORIGIN_L))
  }
}

/** The stream cache's guard, recording what it was asked to keep. */
private class StreamFake : Representations {
  val admitted = ArrayList<String>()

  override fun generation(key: String) = 0

  override fun etagOf(key: String): String? = null

  override fun admit(key: String, etag: String?): Boolean {
    admitted.add(key)
    return true
  }

  override fun invalidate(key: String) {}
}
