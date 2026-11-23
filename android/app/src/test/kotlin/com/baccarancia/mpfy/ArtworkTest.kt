package com.baccarancia.mpfy

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executors
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArtworkTest {
  private val src = "a3435d00"
  private val cover = "0123456789abcdef01234567"
  private val own = "http://127.0.0.1:47123/s/$src/api/cover/$cover"

  @Test
  fun ownCoverUrlsBecomeContentUrisWithTheirSize() {
    assertEquals("content://com.baccarancia.mpfy.art/cover/$src/$cover/small", Artwork.of("$own?size=small"))
    assertEquals("content://com.baccarancia.mpfy.art/cover/$src/$cover/large", Artwork.of("$own?size=large"))
    assertEquals("content://com.baccarancia.mpfy.art/cover/$src/$cover/large", Artwork.of(own))
    assertEquals("content://com.baccarancia.mpfy.art/cover/$src/$cover/small", Artwork.of("$own?size=small&cached=1"))
  }

  @Test
  fun ourContentUriIsKeptAndAnythingElseIsNone() {
    val ours = "content://com.baccarancia.mpfy.art/cover/$src/$cover/small"
    assertEquals(ours, Artwork.of(ours))
    for (bad in listOf(
      null, "",
      "content://com.android.providers.media.documents/document/image%3A12",
      "content://com.baccarancia.mpfy.art/cover/$src/$cover/huge",
      "content://com.baccarancia.mpfy.art/cover/$src/../x/small",
      "content://com.baccarancia.mpfy.art/cover/$src/$cover/small?x=1",
      "content://evil.art/cover/$src/$cover/small",
      "http://127.0.0.1:47124/s/$src/api/cover/$cover?size=small",
      "http://10.0.0.1:47123/s/$src/api/cover/$cover?size=small",
      "https://example.org/cover.jpg",
      "http://127.0.0.1:47123/s/$src/api/stream/$cover?q=max",
      "http://127.0.0.1:47123/s/ZZ/api/cover/$cover",
      "file:///sdcard/cover.jpg",
    )) {
      assertNull(bad.toString(), Artwork.of(bad))
    }
  }

  @Test
  fun theProviderAcceptsOnlyItsCoverPaths() {
    assertEquals(Artwork.Key(src, cover, "large"), Artwork.keyOf("/cover/$src/$cover/large"))
    assertEquals("\"$cover.small\"", Artwork.keyOf("/cover/$src/$cover/small")!!.etag)
    for (bad in listOf(null, "", "/cover/$src/$cover", "/cover/$src/$cover/large/x", "/covers/$src/$cover/large", "/cover/$src/$cover/LARGE", "/cover/A3435D00/$cover/large", "cover/$src/$cover/large", "/cover/$src/..%2F/large")) {
      assertNull(bad.toString(), Artwork.keyOf(bad))
    }
  }

  @Test
  fun aCoverOfThePhonesMusicBecomesAContentUri() {
    assertEquals("content://com.baccarancia.mpfy.art/cover/0000/$cover/small", Artwork.of("http://127.0.0.1:47123/s/0000/api/cover/$cover?size=small"))
    assertEquals(Artwork.Key("0000", cover, "large"), Artwork.keyOf("/cover/0000/$cover/large"))
    // Any other short id is still none.
    assertNull(Artwork.of("http://127.0.0.1:47123/s/0001/api/cover/$cover"))
    assertNull(Artwork.keyOf("/cover/000/$cover/large"))
  }

  @Test
  fun theTypeComesFromTheMagic() {
    assertEquals("image/jpeg", Artwork.typeOf(byteArrayOf(-1, -40, -1, -32)))
    assertEquals("image/png", Artwork.typeOf(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)))
    assertEquals("image/webp", Artwork.typeOf("RIFF0000WEBPVP8 ".toByteArray()))
    assertNull(Artwork.typeOf("GIF89a".toByteArray()))
    assertNull(Artwork.typeOf(ByteArray(0)))
  }
}

/** One answer of the core: a status, an ETag and a body. */
private class CoverAnswer(override val status: Int, override val etag: String?, private val body: ByteArray) : Upstream {
  override val quality: String? = null
  override val length: Long = body.size.toLong()
  override val totalSize: Long = -1
  private var at = 0
  var closed = false

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (at >= body.size) return -1
    val n = minOf(length, body.size - at)
    System.arraycopy(body, at, buffer, offset, n)
    at += n
    return n
  }

  override fun abort() {
    closed = true
  }

  override fun close() {
    closed = true
  }
}

class ArtFetcherTest {
  private val dir: File = Files.createTempDirectory("mpfy-art").toFile()
  private val timer = Executors.newSingleThreadScheduledExecutor()
  private val log = ArrayList<String>()
  private val answers = ArrayList<Upstream>()
  private val opener = Opener { url, _ ->
    log.add(url)
    if (answers.isEmpty()) throw IOException("refused") else answers.removeAt(0)
  }
  // The core's sources, and whether the gate's wait ends with the link up.
  private val sources = mutableSetOf("a3435d00")
  private var up = true
  private val gate = object : CoreGate {
    override fun isSource(sourceId: String) = sourceId in sources

    override fun principal(): String? = null

    override fun <T> use(tag: String, sourceId: String, block: (up: Boolean) -> T): T {
      log.add("hold $tag $sourceId")
      try {
        return block(up)
      } finally {
        log.add("release $tag")
      }
    }
  }
  private val key = Artwork.Key("a3435d00", "0123456789abcdef01234567", "small")
  private val jpeg = byteArrayOf(-1, -40, -1, -32, 1, 2, 3)

  @After
  fun cleanup() {
    timer.shutdownNow()
    dir.deleteRecursively()
  }

  private fun fetcher(max: Long = 64L * 1024 * 1024) = ArtFetcher(ArtCache(dir, max), opener, gate, timer, origin = "http://core")

  @Test
  fun onlyTheSizedImageIsCachedAndServedAgainWithoutAFetch() {
    answers.add(CoverAnswer(200, "\"${key.coverId}.small\"", jpeg))
    val f = fetcher()
    val got = f.open(key)
    assertFalse(got.temp)
    assertEquals(File(dir, "${key.coverId}.small"), got.file)
    assertArrayEquals(jpeg, got.file.readBytes())
    assertEquals(listOf("hold art:${key.fileName} ${key.sourceId}", "http://core/s/${key.sourceId}/api/cover/${key.coverId}?size=small", "release art:${key.fileName}"), log)
    log.clear()
    assertEquals(got.file, f.open(key).file)
    assertTrue(log.isEmpty())
  }

  @Test
  fun theOriginalSentMeanwhileIsServedOnceFromATemporaryFile() {
    answers.add(CoverAnswer(200, "\"${key.coverId}\"", jpeg))
    answers.add(CoverAnswer(200, "\"${key.coverId}.small\"", jpeg))
    val f = fetcher()
    val first = f.open(key)
    assertTrue(first.temp)
    assertTrue(first.file.name.endsWith(".tmp"))
    assertFalse(File(dir, key.fileName).exists())
    first.file.delete()
    val second = f.open(key)
    assertFalse(second.temp)
    assertEquals(2, log.count { it.startsWith("http://") })
  }

  @Test
  fun aFailedFetchIsFileNotFoundAndLeavesNothing() {
    val f = fetcher()
    answers.add(CoverAnswer(404, null, ByteArray(0)))
    answers.add(CoverAnswer(200, "\"${key.coverId}.small\"", "<html>".toByteArray()))
    for (i in 0 until 3) {
      try {
        f.open(key)
        throw AssertionError("expected FileNotFoundException")
      } catch (e: FileNotFoundException) {
        // expected
      }
    }
    assertEquals(emptyList<String>(), dir.list()!!.toList())
    assertEquals(3, log.count { it.startsWith("release") })
  }

  @Test
  fun aCoverOfNoSourceOfOursIsRefusedBeforeTheCacheWithoutAHoldOrAFetch() {
    answers.add(CoverAnswer(200, "\"${key.coverId}.small\"", jpeg))
    val f = fetcher()
    assertFalse(f.open(key).temp)
    log.clear()
    // The same cover under a made-up source: another app learns nothing, not even that it is cached.
    val other = key.copy(sourceId = "deadbeef")
    try {
      f.open(other)
      throw AssertionError("expected FileNotFoundException")
    } catch (e: FileNotFoundException) {
      // expected
    }
    assertEquals(emptyList<String>(), log)
  }

  @Test
  fun aCoverOfThePhonesMusicIsServedWhileTheCoreServesIt() {
    // The core's own list never names the phone: it serves it, and said so.
    Links.update(listOf(Links.Source("a3435d00", "A", true)), "a3435d00")
    Links.servePhone()
    val time = FakeTime()
    val f = ArtFetcher(ArtCache(dir), opener, HeldGate(HoldLog(log), LinksCore(), { time.now }, { time.sleep(it) }), timer, origin = "http://core")
    val k = Artwork.Key(LocalSource.ID, key.coverId, "small")
    answers.add(CoverAnswer(200, "\"${k.coverId}.small\"", jpeg))
    val got = f.open(k)
    assertFalse(got.temp)
    assertArrayEquals(jpeg, got.file.readBytes())
    assertTrue(log.toString(), log.contains("http://core/s/0000/api/cover/${k.coverId}?size=small"))
  }

  @Test
  fun aSourceStillDownWhenTheWaitIsOverIsNotAsked() {
    up = false
    answers.add(CoverAnswer(200, "\"${key.coverId}.small\"", jpeg))
    try {
      fetcher().open(key)
      throw AssertionError("expected FileNotFoundException")
    } catch (e: FileNotFoundException) {
      // expected
    }
    assertEquals(listOf("hold art:${key.fileName} ${key.sourceId}", "release art:${key.fileName}"), log)
    assertEquals(1, answers.size)
  }

  @Test
  fun aBodyOver16MiBIsRefused() {
    answers.add(object : Upstream by CoverAnswer(200, "\"${key.coverId}.small\"", jpeg) {
      override val length: Long = 16L * 1024 * 1024 + 1
    })
    try {
      fetcher().open(key)
      throw AssertionError("expected FileNotFoundException")
    } catch (e: FileNotFoundException) {
      // expected
    }
  }

  @Test
  fun aSourceThatStopsSendingIsCutAtTheTimeout() {
    val stuck = object : Upstream {
      private val gone = java.util.concurrent.CountDownLatch(1)
      override val status = 200
      override val etag: String? = "\"${key.coverId}.small\""
      override val quality: String? = null
      override val length = -1L
      override val totalSize = -1L
      private var sent = false

      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (!sent) {
          sent = true
          System.arraycopy(jpeg, 0, buffer, offset, jpeg.size)
          return jpeg.size
        }
        gone.await()
        throw IOException("aborted")
      }

      override fun abort() = gone.countDown()

      override fun close() = gone.countDown()
    }
    answers.add(stuck)
    val f = ArtFetcher(ArtCache(dir), opener, gate, timer, origin = "http://core", timeoutMs = 300)
    var failed = false
    val t = Thread {
      failed = runCatching { f.open(key) }.exceptionOrNull() is FileNotFoundException
    }.apply { isDaemon = true }
    t.start()
    t.join(5_000)
    assertFalse("still reading", t.isAlive)
    assertTrue(failed)
  }

  @Test
  fun theCacheDropsTheLeastRecentlyUsedPastItsSize() {
    val c = ArtCache(dir, 10)
    val keys = (1..3).map { Artwork.Key("a3435d00", "%024x".format(it), "large") }
    for ((i, k) in keys.withIndex()) {
      val t = File(dir, "t$i.tmp")
      t.writeBytes(ByteArray(4))
      c.put(k, t)
      File(dir, k.fileName).setLastModified(1_000_000L * (i + 1))
    }
    c.trim()
    // 12 bytes against 10: the oldest goes.
    assertNull(c.get(keys[0]))
    assertTrue(c.get(keys[1]) != null && c.get(keys[2]) != null)
  }
}
