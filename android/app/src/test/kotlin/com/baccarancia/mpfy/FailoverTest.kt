package com.baccarancia.mpfy

import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private const val ORIGIN_T = "http://127.0.0.1:47123"

/** A response of the fake core: [body] from byte [from]; it may wait before its first byte, or stop sending after [stallAfter] bytes. */
private class FakeResponse(
  override val status: Int,
  override val etag: String?,
  private val body: ByteArray,
  private val from: Int,
  private val stallAfter: Int = -1,
  private val firstByteDelayMs: Long = 0,
  override val quality: String? = null,
  private val failAfter: Int = -1,
) : Upstream {
  override val length: Long = if (status in 200..299) (body.size - from).toLong() else -1
  override val totalSize: Long = body.size.toLong()
  private var pos = from
  private val gate = CountDownLatch(1)
  @Volatile var aborted = false
  @Volatile var closed = false
  @Volatile var bytesRead = 0

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (aborted) throw IOException("aborted")
    if (firstByteDelayMs > 0 && pos == from) waitUntilAborted(firstByteDelayMs, throwOnAbort = true)
    if (failAfter >= 0 && pos - from >= failAfter) throw IOException("connection reset")
    if (stallAfter >= 0 && pos - from >= stallAfter) {
      waitUntilAborted(20_000, throwOnAbort = true)
      throw IOException("stalled for good")
    }
    if (pos >= body.size) return -1
    var n = minOf(length, body.size - pos)
    if (stallAfter >= 0) n = minOf(n, from + stallAfter - pos)
    if (failAfter >= 0) n = minOf(n, from + failAfter - pos)
    System.arraycopy(body, pos, buffer, offset, n)
    pos += n
    bytesRead += n
    return n
  }

  private fun waitUntilAborted(ms: Long, throwOnAbort: Boolean) {
    if (!gate.await(ms, TimeUnit.MILLISECONDS)) return
    if (throwOnAbort) throw IOException("aborted")
  }

  override fun abort() {
    aborted = true
    gate.countDown()
  }

  override fun close() {
    closed = true
    abort()
  }
}

private class Request(val url: String, val headers: Map<String, String>)

/** The core: per URL, the responses it gives in turn (the last one again when they run out). */
private class FakeCore : Opener {
  val requests = CopyOnWriteArrayList<Request>()
  val opened = CopyOnWriteArrayList<FakeResponse>()
  private val plans = ConcurrentHashMap<String, MutableList<(Long) -> FakeResponse>>()
  private val silent = ConcurrentHashMap.newKeySet<String>()

  fun on(url: String, vararg make: (Long) -> FakeResponse) {
    plans[url] = make.toMutableList()
  }

  /** The core takes the request, the source behind it never answers. */
  fun silent(url: String) {
    silent.add(url)
  }

  override fun open(url: String, headers: Map<String, String>): Upstream {
    requests.add(Request(url, headers))
    if (url in silent) throw NoAnswerException(SocketTimeoutException("Read timed out"))
    val plan = plans[url] ?: throw IOException("connection refused")
    val make = if (plan.size > 1) plan.removeAt(0) else plan[0]
    val from = headers["Range"]?.substringAfter("bytes=")?.substringBefore('-')?.toLong() ?: 0
    return make(from).also { opened.add(it) }
  }
}

private class FakeReps : Representations {
  val stored = ConcurrentHashMap<String, String>()
  val generations = ConcurrentHashMap<String, Int>()
  val invalidated = CopyOnWriteArrayList<String>()

  override fun generation(key: String) = generations[key] ?: 0

  override fun etagOf(key: String): String? = stored[key]

  override fun admit(key: String, etag: String?): Boolean {
    if (etag == null) return true
    val s = stored.putIfAbsent(key, etag) ?: return true
    return s == etag
  }

  override fun invalidate(key: String) {
    invalidated.add(key)
    generations[key] = generation(key) + 1
    stored.remove(key)
  }
}

private class FakeLinks : LinkWatch {
  private val watchers = Collections.synchronizedList(ArrayList<Pair<String, () -> Unit>>())

  override fun onDown(sourceId: String, call: () -> Unit): AutoCloseable {
    val w = sourceId to call
    watchers.add(w)
    return AutoCloseable { watchers.remove(w) }
  }

  fun down(sourceId: String) {
    for (w in watchers.toList()) if (w.first == sourceId) w.second()
  }
}

class FailoverTest {
  private val body = ByteArray(64 * 1024) { (it * 31 + 7).toByte() }
  private val t = "t0"
  private val f = "f0"
  private val a = Version("aaaa", t, f, "", 0)
  private val b = Version("bbbb", t, f, "", 0)
  private val c = Version("cccc", t, f, "", 0)
  private val other = Version("dddd", t, "f9", "", 0)
  private lateinit var timer: ScheduledExecutorService
  private val core = FakeCore()
  private val reps = FakeReps()
  private val links = FakeLinks()
  private val registry = VersionRegistry()

  private fun url(v: Version, level: String = "max") = streamUrl(ORIGIN_T, v, level)

  private fun key(v: Version, level: String = "max") = Levels.streamKey(v.sourceId, v.trackId, v.fileHash, level)

  private fun ok(etag: String? = "\"$f\"", stallAfter: Int = -1, delay: Long = 0, failAfter: Int = -1, quality: String? = "max", data: ByteArray = body): (Long) -> FakeResponse =
    { from -> FakeResponse(if (from > 0) 206 else 200, etag, data, from.toInt(), stallAfter, delay, quality, failAfter) }

  private fun status(code: Int): (Long) -> FakeResponse = { from -> FakeResponse(code, null, body, from.toInt()) }

  private fun reader(stallMs: Long = 150) = FailoverReader(registry, core, reps, links, timer, ORIGIN_T, stallMs)

  private fun readAll(r: FailoverReader): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(4096)
    while (true) {
      val n = r.read(buf, 0, buf.size)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  @Before
  fun setUp() {
    timer = Executors.newSingleThreadScheduledExecutor()
  }

  @After
  fun tearDown() {
    timer.shutdownNow()
  }

  @Test
  fun theFirstOpenUsesTheKeysOwnVersionEvenWhenItsSourceIsDown() {
    // The page put B first, but the item plays A's key; the app's map has A's source down (the
    // core waits for it), and the read is not cut for that.
    val withUrls = listOf(b.copy(url = url(b)), a.copy(url = url(a)))
    registry.put(key(a), VersionRegistry.Entry(t, "max", withUrls))
    core.on(url(a), ok())
    core.on(url(b), ok())
    Links.update(listOf(Links.Source("aaaa", "A", false), Links.Source("bbbb", "B", true)))
    try {
      assertFalse(Links.isUp("aaaa"))
      val r = FailoverReader(registry, core, reps, Links, timer, ORIGIN_T, 150)
      r.open(key(a), url(a), 0, -1)
      assertEquals(a.id, r.reading?.id)
      assertArrayEquals(body, readAll(r))
      r.close()
    } finally {
      Links.update(emptyList())
    }
    assertEquals(listOf(url(a)), core.requests.map { it.url })
    assertEquals(body.size, core.opened[0].bytesRead)
  }

  @Test
  fun theKeysOwnLevelIsAskedWhateverLevelTheListsUrlsAsk() {
    // The page asked Alta for the item playing while it plays at Normale: the next play takes it.
    registry.put(key(a, "normal"), VersionRegistry.Entry(t, "normal", listOf(a.copy(url = url(a, "high")), b.copy(url = url(b, "high")))))
    core.on(url(a, "normal"), ok(quality = "normal"))
    core.on(url(a, "high"), ok(etag = "\"high\"", quality = "high"))
    val r = reader()
    r.open(key(a, "normal"), url(a, "high"), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals("normal", r.served)
    assertEquals(listOf(url(a, "normal")), core.requests.map { it.url })
    assertTrue(reps.invalidated.isEmpty())
  }

  @Test
  fun aLaterOpenStartsWhereTheReadMovedTo() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(stallAfter = 10_000), status(503))
    core.on(url(b), ok())
    val first = reader()
    first.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(first))
    first.close()
    assertEquals(b.id, registry.get(key(a))!!.movedTo)
    // A hole after a cached span, a seek, a retry of the prefetch: B again, not the source that stalled.
    core.requests.clear()
    val later = reader()
    later.open(key(a), url(a), 20_000, -1)
    assertEquals(b, later.reading)
    assertArrayEquals(body.copyOfRange(20_000, body.size), readAll(later))
    assertEquals(listOf(url(b)), core.requests.map { it.url })
  }

  @Test
  fun aMovedToSourceThatIsGoneGivesWayToTheKeysOwnVersion() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    registry.get(key(a))!!.movedTo = b.id
    reps.stored[key(a)] = "\"$f\""
    core.on(url(b), status(503))
    core.on(url(a), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals(listOf(url(b), url(a)), core.requests.map { it.url })
    assertTrue(core.opened[0].closed)
    assertNull(registry.get(key(a))!!.movedTo)
  }

  @Test
  fun noAnswerOnOpenGoesToTheNextVersion() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, other)))
    core.silent(url(a))
    try {
      reader().open(key(a), url(a), 0, -1)
      fail("opened")
    } catch (e: VersionsExhaustedException) {
      assertTrue(e.hasUntried)
      assertTrue(e.cause is NoAnswerException)
      assertEquals(androidx.media3.common.C.TIME_UNSET, StreamRetry.delayFor(e, 1))
    }
    // Nothing else to try: the usual rule for a source that does not answer, six tries.
    registry.put(key(c), VersionRegistry.Entry(t, "max", listOf(c)))
    core.silent(url(c))
    try {
      reader().open(key(c), url(c), 0, -1)
      fail("opened")
    } catch (e: VersionsExhaustedException) {
      assertFalse(e.hasUntried)
      assertEquals(StreamRetry.DEFAULT, StreamRetry.delayFor(e, 1))
    }
  }

  @Test
  fun noConnectionToTheCoreStaysForTheUsualRetries() {
    // The core restarting: every version would fail alike, the player waits for it.
    registry.put(key(b), VersionRegistry.Entry(t, "max", listOf(b, other)))
    try {
      reader().open(key(b), url(b), 0, -1)
      fail("opened")
    } catch (e: IOException) {
      assertFalse(e is VersionsExhaustedException)
    }
  }

  @Test
  fun theSameVersionIsTriedAgainAfterServingMoreSinceItsLastTry() {
    // A whole song is one read: glitches far apart are not a source that fails.
    val big = ByteArray(2 * 1024 * 1024) { (it * 7 + 3).toByte() }
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a)))
    core.on(url(a), ok(stallAfter = 600_000, data = big), ok(stallAfter = 600_000, data = big), ok(data = big))
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(big, readAll(r))
    assertEquals(listOf(url(a), url(a), url(a)), core.requests.map { it.url })
  }

  @Test
  fun aVersionThatFailsAgainSoonAfterItsSecondTryIsExhausted() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a)))
    core.on(url(a), ok(stallAfter = 1000), ok(stallAfter = 1000), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    try {
      readAll(r)
      fail("read to the end")
    } catch (e: VersionsExhaustedException) {
      assertFalse(e.hasUntried)
    }
    assertEquals(listOf(url(a), url(a)), core.requests.map { it.url })
  }

  @Test
  fun aStallAfterTheFirstByteMovesToTheSameFileOnAnotherSourceAtTheSameOffset() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, other, b)))
    core.on(url(a), ok(stallAfter = 10_000))
    core.on(url(b), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    val got = readAll(r)
    r.close()
    assertArrayEquals(body, got)
    // B was asked from where A stopped; the other file was never asked.
    assertEquals(listOf(url(a), url(b)), core.requests.map { it.url })
    assertEquals("bytes=10000-", core.requests[1].headers["Range"])
    assertEquals(b, r.reading)
  }

  @Test
  fun aBodyCutShortAlsoMovesOn() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(failAfter = 777))
    core.on(url(b), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals("bytes=777-", core.requests[1].headers["Range"])
  }

  @Test
  fun a206WithAnotherEtagIsClosedBeforeReading() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b, c)))
    core.on(url(a), ok(stallAfter = 5000))
    core.on(url(b), ok(etag = "\"another\""))
    core.on(url(c), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(r))
    val fromB = core.opened[1]
    assertTrue(fromB.closed)
    assertEquals(0, fromB.bytesRead)
    assertEquals(listOf(url(a), url(b), url(c)), core.requests.map { it.url })
    // Skipping a response of another representation drops nothing.
    assertTrue(reps.invalidated.isEmpty())
  }

  @Test
  fun aResponseWithoutAnEtagNeverJoinsTheBytes() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(stallAfter = 5000), ok())
    core.on(url(b), ok(etag = null))
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals(0, core.opened[1].bytesRead)
    // None left: the same version once more.
    assertEquals(listOf(url(a), url(b), url(a)), core.requests.map { it.url })
  }

  @Test
  fun noIfRangeIsEverSent() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(stallAfter = 3000))
    core.on(url(b), ok())
    val r = reader()
    r.open(key(a), url(a), 1000, -1)
    readAll(r)
    assertTrue(core.requests.size >= 2)
    for (q in core.requests) {
      assertFalse(q.headers.keys.any { it.equals("If-Range", ignoreCase = true) })
      assertTrue(q.headers["Range"]!!.matches(Regex("bytes=\\d+-")))
    }
    assertEquals(mapOf("Range" to "bytes=1000-"), core.requests[0].headers)
    assertEquals(emptyMap<String, String>(), requestHeaders(0, -1))
    assertEquals(mapOf("Range" to "bytes=10-19"), requestHeaders(10, 10))
  }

  @Test
  fun aSlowFirstByteIsNotAStall() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    // Five times the stall time before the first byte; the read timeout (8 s) covers that wait.
    core.on(url(a), ok(delay = 750))
    core.on(url(b), ok())
    val r = reader(stallMs = 150)
    r.open(key(a), url(a), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals(listOf(url(a)), core.requests.map { it.url })
  }

  @Test
  fun anEtagOtherThanTheStoredOneDropsTheKeyAndThrows() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a)))
    reps.stored[key(a)] = "\"first\""
    core.on(url(a), ok(etag = "\"second\""))
    val r = reader()
    try {
      r.open(key(a), url(a), 0, -1)
      fail("opened another representation")
    } catch (e: RepresentationChangedException) {
      assertEquals(key(a), e.key)
    }
    assertEquals(listOf(key(a)), reps.invalidated)
    assertTrue(core.opened[0].closed)
    assertEquals(0, core.opened[0].bytesRead)
  }

  @Test
  fun theSameVersionOnceMoreMustCarryTheSameEtag() {
    // A transcode made again while this read was cut: the retry brings other bytes.
    registry.put(key(a, "high"), VersionRegistry.Entry(t, "high", listOf(a)))
    core.on(url(a, "high"), ok(etag = "\"x1\"", stallAfter = 2000, quality = "high"), ok(etag = "\"x2\"", quality = "high"))
    val r = reader()
    r.open(key(a, "high"), url(a, "high"), 0, -1)
    try {
      readAll(r)
      fail("read across two representations")
    } catch (e: RepresentationChangedException) {
      assertEquals(listOf(key(a, "high")), reps.invalidated)
    }
  }

  @Test
  fun aKeyDroppedSinceThisReaderBeganIsNotOpenedAgain() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a)))
    core.on(url(a), ok())
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    r.close()
    reps.invalidate(key(a))
    try {
      r.open(key(a), url(a), 100, -1)
      fail("reopened after the drop")
    } catch (e: RepresentationChangedException) {
      // the player prepares the item again
    }
  }

  @Test
  fun belowMaxOnlyTheSameVersionIsTriedAgain() {
    // Transcodes differ between sources: never joined, whatever their ETag says.
    registry.put(key(a, "high"), VersionRegistry.Entry(t, "high", listOf(a, b)))
    core.on(url(a, "high"), ok(stallAfter = 4000), ok())
    core.on(url(b, "high"), ok())
    val r = reader()
    r.open(key(a, "high"), url(a, "high"), 0, -1)
    assertArrayEquals(body, readAll(r))
    assertEquals(listOf(url(a, "high"), url(a, "high")), core.requests.map { it.url })
  }

  @Test
  fun aLinkGoingDownClosesTheRead() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(stallAfter = 6000))
    core.on(url(b), ok())
    // A stall watchdog that would not fire within the test: only the link can end A's read.
    val r = reader(stallMs = 60_000)
    r.open(key(a), url(a), 0, -1)
    val buf = ByteArray(6000)
    var got = 0
    while (got < 6000) got += r.read(buf, got, 6000 - got)
    val began = System.currentTimeMillis()
    timer.schedule({ links.down("aaaa") }, 200, TimeUnit.MILLISECONDS)
    val rest = readAll(r)
    assertTrue(System.currentTimeMillis() - began < 5_000)
    assertArrayEquals(body.copyOfRange(6000, body.size), rest)
    assertEquals(url(b), core.requests.last().url)
  }

  @Test
  fun a4xxOnOpenEndsAtOnce() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), status(404))
    core.on(url(b), ok())
    val r = reader()
    try {
      r.open(key(a), url(a), 0, -1)
      fail("opened")
    } catch (e: VersionsExhaustedException) {
      assertEquals(404, (e.cause as HttpStatusException).status)
      assertTrue(e.hasUntried) // B: the service tries it
    }
    assertEquals(listOf(url(a)), core.requests.map { it.url })
  }

  @Test
  fun a5xxOnOpenEndsAtOnceToo() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a)))
    core.on(url(a), status(503))
    try {
      reader().open(key(a), url(a), 0, -1)
      fail("opened")
    } catch (e: VersionsExhaustedException) {
      assertFalse(e.hasUntried)
    }
  }

  @Test
  fun whenEverythingFailsTheReadIsExhausted() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b, other), tried = emptySet()))
    core.on(url(a), ok(stallAfter = 1000), status(503))
    core.on(url(b), status(502))
    val r = reader()
    r.open(key(a), url(a), 0, -1)
    try {
      readAll(r)
      fail("read to the end")
    } catch (e: VersionsExhaustedException) {
      // The other file is still untried: the service moves to it.
      assertTrue(e.hasUntried)
    }
    assertEquals(listOf(url(a), url(b), url(a)), core.requests.map { it.url })
  }

  @Test
  fun aCancelledReadDoesNotMoveOn() {
    registry.put(key(a), VersionRegistry.Entry(t, "max", listOf(a, b)))
    core.on(url(a), ok(stallAfter = 1000))
    core.on(url(b), ok())
    val r = reader(stallMs = 60_000)
    r.open(key(a), url(a), 0, -1)
    val buf = ByteArray(1000)
    var got = 0
    while (got < 1000) got += r.read(buf, got, 1000 - got)
    timer.schedule({ r.cancel() }, 100, TimeUnit.MILLISECONDS)
    try {
      r.read(buf, 0, buf.size)
      fail("read after the cancel")
    } catch (e: IOException) {
      assertFalse(e is VersionsExhaustedException)
    }
    assertEquals(listOf(url(a)), core.requests.map { it.url })
  }

  @Test
  fun theServedLevelIsReported() {
    registry.put(key(a, "high"), VersionRegistry.Entry(t, "high", listOf(a)))
    core.on(url(a, "high"), ok(quality = "MAX"))
    val seen = CopyOnWriteArrayList<String>()
    val r = FailoverReader(registry, core, reps, links, timer, ORIGIN_T, onServed = { k, level -> seen.add("$k=$level") })
    r.open(key(a, "high"), url(a, "high"), 0, -1)
    assertEquals("max", r.served)
    assertEquals(listOf("${key(a, "high")}=max"), seen)
  }

  @Test
  fun aKeyTheRegistryDoesNotKnowStillOpensItsItemsUrl() {
    core.on("$ORIGIN_T/s/aaaa/api/stream/t0?q=max", ok())
    val r = reader()
    r.open(key(a), "$ORIGIN_T/s/aaaa/api/stream/t0?q=max", 0, -1)
    assertArrayEquals(body, readAll(r))
    assertNull(registry.get(key(a)))
  }
}

/** The real HTTP client against a local server: what goes on the wire, and a stall over a real socket. */
class HttpOpenerTest {
  private lateinit var server: HttpServer
  private lateinit var timer: ScheduledExecutorService
  private val seen = CopyOnWriteArrayList<Map<String, String>>()
  private val body = ByteArray(200_000) { (it % 251).toByte() }

  @Before
  fun setUp() {
    timer = Executors.newSingleThreadScheduledExecutor()
    server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.executor = Executors.newCachedThreadPool()
    // A source that never answers: the core took the request, no head follows for a long while.
    server.createContext("/silent/") { ex ->
      try {
        Thread.sleep(2_500)
        ex.sendResponseHeaders(503, -1)
      } catch (e: Exception) {
        // the client went away
      } finally {
        ex.close()
      }
    }
    server.createContext("/") { ex ->
      seen.add(ex.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(",") })
      val range = ex.requestHeaders.getFirst("Range")
      val from = range?.substringAfter("bytes=")?.substringBefore('-')?.toInt() ?: 0
      val stall = ex.requestURI.path.contains("/aaaa/")
      ex.responseHeaders.add("ETag", "\"f0\"")
      ex.responseHeaders.add("X-MPfy-Quality", "max")
      if (from > 0) ex.responseHeaders.add("Content-Range", "bytes $from-${body.size - 1}/${body.size}")
      ex.sendResponseHeaders(if (from > 0) 206 else 200, (body.size - from).toLong())
      try {
        ex.responseBody.use { out ->
          if (stall) {
            out.write(body, from, 50_000)
            out.flush()
            Thread.sleep(4_000) // then nothing more: the client must leave
          } else {
            out.write(body, from, body.size - from)
          }
        }
      } catch (e: IOException) {
        // the client went away
      }
    }
    server.start()
  }

  @After
  fun tearDown() {
    server.stop(0)
    timer.shutdownNow()
  }

  @Test
  fun aStalledSocketIsLeftForTheSameFileElsewhereWithAPlainRange() {
    val origin = "http://127.0.0.1:${server.address.port}"
    val a = Version("aaaa", "t0", "f0", "", 0)
    val b = Version("bbbb", "t0", "f0", "", 0)
    val registry = VersionRegistry()
    val key = Levels.streamKey("aaaa", "t0", "f0", "max")
    registry.put(key, VersionRegistry.Entry("t0", "max", listOf(a, b)))
    val r = FailoverReader(registry, HttpOpener(mapOf("X-MPfy-Token" to "tok")), FakeReps(), FakeLinks(), timer, origin, stallMs = 300)
    r.open(key, streamUrl(origin, a, "max"), 0, -1)
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    val began = System.currentTimeMillis()
    while (true) {
      val n = r.read(buf, 0, buf.size)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    r.close()
    assertArrayEquals(body, out.toByteArray())
    assertTrue("left the stalled source in time", System.currentTimeMillis() - began < 3_500)
    assertEquals(2, seen.size)
    assertNull(seen[0]["range"])
    assertEquals("bytes=50000-", seen[1]["range"])
    for (h in seen) {
      assertFalse(h.containsKey("if-range"))
      assertEquals("tok", h["x-mpfy-token"])
      assertEquals("identity", h["accept-encoding"])
    }
  }

  @Test
  fun aHeadThatDoesNotComeIsNoAnswerOnceTheReadTimeIsOver() {
    val origin = "http://127.0.0.1:${server.address.port}"
    val began = System.currentTimeMillis()
    try {
      HttpOpener(emptyMap(), readMs = 300).open("$origin/silent/x", emptyMap())
      fail("a head came")
    } catch (e: NoAnswerException) {
      assertTrue(e.cause is SocketTimeoutException)
    }
    val took = System.currentTimeMillis() - began
    assertTrue("waited $took ms", took in 250..2_000)
  }

  @Test
  fun theCoreHas6SecondsToTakeARequestAnd8ToAnswerIt() {
    // The read time also covers the core's 6 s wait for a source's link, plus a round trip.
    assertEquals(6_000, HttpOpener.CONNECT_MS)
    assertEquals(8_000, HttpOpener.READ_MS)
  }

  @Test
  fun noCoreAtAllIsNotNoAnswer() {
    val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
    try {
      HttpOpener(emptyMap()).open("http://127.0.0.1:$port/x", emptyMap())
      fail("connected")
    } catch (e: IOException) {
      assertFalse(e is NoAnswerException)
    }
  }
}
