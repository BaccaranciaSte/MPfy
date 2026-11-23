package com.baccarancia.mpfy

import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val CR: Byte = 13
private const val LF: Byte = 10

/** What the native player reports to the core (bridge 5): the body, the request, the coalescing, the heartbeat. */
class ActivityTest {
  private val v1 = Version("aaaa0001", "111111111111111111111111", "111111111111111111111111", "http://core/s/aaaa0001/api/stream/1", 0)
  private val v2 = Version("bbbb0002", "222222222222222222222222", "222222222222222222222222", "http://core/s/bbbb0002/api/stream/2", 0)

  @Test
  fun theBridgeSaysFiveOrLaterAndTheServiceReports() {
    // From bridge 5 the page knows the native player reports what plays: the page stops reporting
    // (6, the message notifications, and 7, the car's library in pages, keep it).
    val dir = listOf(java.io.File("src/main/kotlin"), java.io.File("app/src/main/kotlin")).first { it.isDirectory }
    val bridge = java.io.File(dir, "com/baccarancia/mpfy/MPfyBridge.kt").readText()
    assertTrue(Regex("""fun bridgeVersion\(\): String = "7"""").containsMatchIn(bridge))
    val service = java.io.File(dir, "com/baccarancia/mpfy/PlaybackService.kt").readText()
    assertTrue(Regex("""EVENT_IS_PLAYING_CHANGED, Player\.EVENT_MEDIA_ITEM_TRANSITION\)\) activity\.update""").containsMatchIn(service))
    assertTrue(service.contains("activity.stop()"))
  }

  @Test
  fun theTrackIdIsTheVersionPlayingElseTheFirst() {
    assertEquals(v2.trackId, ActivityState.trackIdOf(v2, listOf(v1, v2), "group"))
    assertEquals(v1.trackId, ActivityState.trackIdOf(null, listOf(v1, v2), "group"))
    assertEquals("group", ActivityState.trackIdOf(null, emptyList(), "group"))
  }

  private val phone = Version("0000", "333333333333333333333333", "333333333333333333333333", "http://core/s/0000/api/stream/3", 0)

  @Test
  fun aSongOnlyOnThePhoneIsNeverReported() {
    assertNull(ActivityState.trackIdOf(phone, listOf(phone), "group"))
    assertNull(ActivityState.trackIdOf(null, listOf(phone), "group"))
  }

  @Test
  fun thePhonesVersionPlayingReportsTheSongsVersionOnASource() {
    assertEquals(v1.trackId, ActivityState.trackIdOf(phone, listOf(phone, v1, v2), "group"))
    assertEquals(v1.trackId, ActivityState.trackIdOf(null, listOf(phone, v1), "group"))
    // A source's version playing reports itself, as before.
    assertEquals(v2.trackId, ActivityState.trackIdOf(v2, listOf(phone, v1, v2), "group"))
  }

  @Test
  fun artistPageComesFromTheCtxExtra() {
    assertTrue(ActivityState.artistPage(QueueCtx("artist", "0123456789abcdef")))
    assertFalse(ActivityState.artistPage(QueueCtx("album", "0123456789abcdef")))
    assertFalse(ActivityState.artistPage(QueueCtx("library", null)))
    assertFalse(ActivityState.artistPage(null))
    // As the page hands it over: the item's { k, id }.
    assertTrue(ActivityState.artistPage(QueueCtx.parse("{\"k\":\"artist\",\"id\":\"0123456789abcdef\"}")))
  }

  @Test
  fun theBodyNamesTheSongAndWhetherItPlays() {
    val t = ActivityTrack(v2.trackId, "Onda \"quadra\"", "Delta Nadir", "Frequenze", true)
    assertEquals(
      "{\"track\":{\"trackId\":\"222222222222222222222222\",\"title\":\"Onda \\\"quadra\\\"\",\"artist\":\"Delta Nadir\",\"album\":\"Frequenze\",\"artistPage\":true},\"playing\":true}",
      ActivityState(t, true).body(),
    )
    assertEquals("{\"track\":null,\"playing\":false}", ActivityState.NONE.body())
    // No song: never "playing".
    assertEquals("{\"track\":null,\"playing\":false}", ActivityState(null, true).body())
    val parsed = Json.obj(ActivityState(t.copy(artistPage = false), false).body())!!
    assertEquals(false, (parsed["track"] as Map<*, *>)["artistPage"])
    assertEquals(false, parsed["playing"])
  }

  /** One request to a fake core on a free port: what it got, and what it answered. */
  private class FakeCore(private val status: Int, private val answer: String) : AutoCloseable {
    private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort
    var requestLine = ""
    val headers = HashMap<String, String>()
    var body = ""
    private val done = CountDownLatch(1)
    private val thread = Thread {
      server.accept().use { s ->
        // The head byte by byte up to its blank line, then exactly Content-Length bytes.
        val input = s.getInputStream()
        val head = java.io.ByteArrayOutputStream()
        while (true) {
          val b = input.read()
          if (b < 0) break
          head.write(b)
          val h = head.toByteArray()
          if (h.size >= 4 && h[h.size - 4] == CR && h[h.size - 3] == LF && h[h.size - 2] == CR && h[h.size - 1] == LF) break
        }
        val lines = String(head.toByteArray(), Charsets.US_ASCII).split(String(byteArrayOf(CR, LF), Charsets.US_ASCII))
        requestLine = lines.first()
        for (line in lines.drop(1)) {
          val i = line.indexOf(':')
          if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val n = headers["content-length"]?.toInt() ?: 0
        val buf = ByteArray(n)
        var read = 0
        while (read < n) {
          val k = input.read(buf, read, n - read)
          if (k < 0) break
          read += k
        }
        body = String(buf, 0, read, Charsets.UTF_8)
        val bytes = answer.toByteArray(Charsets.UTF_8)
        val out = s.getOutputStream()
        out.write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
      }
      done.countDown()
    }.apply {
      isDaemon = true
      start()
    }

    fun await() = assertTrue(done.await(5, TimeUnit.SECONDS))

    override fun close() = server.close()
  }

  @Test
  fun coreHttpJsonSendsTheBodyWithTheTokenAndReadsTheAnswer() {
    FakeCore(200, "{\"ok\":true}").use { core ->
      val body = ActivityState(ActivityTrack(v1.trackId, "Città di sale", "Lumen Marino", "Città di sale", false), true).body()
      val (status, text) = CoreHttp.jsonWith("t0ken", "PUT", "http://127.0.0.1:${core.port}/local/activity", body, 5_000)
      core.await()
      assertEquals(200, status)
      assertEquals("{\"ok\":true}", text)
      assertEquals("PUT /local/activity HTTP/1.1", core.requestLine)
      assertEquals("t0ken", core.headers[CoreHost.TOKEN_HEADER.lowercase()])
      assertEquals("MPfy", core.headers["user-agent"])
      assertEquals("application/json", core.headers["content-type"])
      assertEquals(body.toByteArray(Charsets.UTF_8).size.toString(), core.headers["content-length"])
      assertEquals(body, core.body)
    }
  }

  @Test
  fun coreHttpJsonReadsAnErrorAnswerToo() {
    FakeCore(400, "{\"error\":\"Richiesta non valida\",\"code\":\"bad_request\"}").use { core ->
      val (status, text) = CoreHttp.jsonWith("t0ken", "GET", "http://127.0.0.1:${core.port}/local/people", null, 5_000)
      core.await()
      assertEquals(400, status)
      assertTrue(text.contains("bad_request"))
      assertEquals("GET /local/people HTTP/1.1", core.requestLine)
      assertNull(core.headers["content-type"])
    }
  }

  /** The reporter with a worker, timers and a core of its own: what was sent, when. */
  private class Rig(ready: Boolean = true) {
    val log = ArrayList<String>()
    val sent = ArrayList<String>()
    val jobs = ArrayList<Runnable>()
    val timers = ArrayList<Pair<Runnable, Long>>()
    val core = StubCore().apply {
      listening = ready
      awakeSince = if (ready) 0L else null
    }
    val time = FakeTime()
    val reporter = ActivityReporter(
      http = { method, url, body, timeout ->
        sent.add("$method $url $body $timeout")
        200 to "{\"ok\":true}"
      },
      awake = AwakeCall(HoldLog(log), core, { time.now }, { time.sleep(it) }),
      worker = { jobs.add(it) },
      later = { r, ms -> timers.add(r to ms) },
      cancel = { r -> timers.removeAll { it.first === r } },
      origin = "http://core",
    )

    fun runJobs() {
      while (jobs.isNotEmpty()) jobs.removeAt(0).run()
    }
  }

  private fun playing(id: String, on: Boolean) = ActivityState(ActivityTrack(id, "T $id", "A", "L", false), on)

  @Test
  fun oneRequestInFlightAndTheLatestStateReplacesAWaitingOne() {
    val r = Rig()
    r.reporter.update(playing(v1.trackId, true)) // starts a job
    r.reporter.update(playing(v1.trackId, false)) // waits
    r.reporter.update(playing(v2.trackId, true)) // replaces the waiting one
    r.reporter.update(playing(v2.trackId, false)) // and again
    assertEquals(1, r.jobs.size)
    r.runJobs()
    assertEquals(2, r.sent.size)
    assertTrue(r.sent[0].contains(v1.trackId) && r.sent[0].contains("\"playing\":true"))
    assertTrue(r.sent[1].contains(v2.trackId) && r.sent[1].contains("\"playing\":false"))
    assertTrue(r.sent.all { it.startsWith("PUT http://core/local/activity ") && it.endsWith(" ${ActivityReporter.TIMEOUT_MS}") })
    // Each one held the worklet for itself, and let it go.
    assertEquals(listOf("hold activity", "release activity", "hold activity", "release activity"), r.log)
    // Quiet again: the next one starts a job of its own.
    r.reporter.update(playing(v2.trackId, true))
    assertEquals(1, r.jobs.size)
  }

  @Test
  fun theHeartbeatRunsEveryMinuteOnlyWhilePlaying() {
    val r = Rig()
    r.reporter.update(playing(v1.trackId, false))
    assertTrue(r.timers.isEmpty())
    r.reporter.update(playing(v1.trackId, true))
    assertEquals(1, r.timers.size)
    assertEquals(ActivityReporter.HEARTBEAT_MS, r.timers[0].second)
    r.runJobs()
    val before = r.sent.size
    // A minute later: the same state again, and the next minute armed.
    val beat = r.timers.removeAt(0).first
    beat.run()
    r.runJobs()
    assertEquals(before + 1, r.sent.size)
    assertTrue(r.sent.last().contains("\"playing\":true"))
    assertEquals(1, r.timers.size)
    // Paused: no timer left.
    r.reporter.update(playing(v1.trackId, false))
    assertTrue(r.timers.isEmpty())
    // An empty player: nothing plays, no timer.
    r.reporter.update(ActivityState.NONE)
    r.runJobs()
    assertTrue(r.timers.isEmpty())
    assertTrue(r.sent.last().contains("{\"track\":null,\"playing\":false}"))
  }

  @Test
  fun aSongOnlyOnThePhoneSaysNothingPlaysAndArmsNoHeartbeat() {
    val r = Rig()
    // As PlaybackService builds it: the trackId the item reports, none for a song only on the phone.
    val t = ActivityTrack(ActivityState.trackIdOf(phone, listOf(phone), "group"), "Solo qui", "A", "L", false)
    assertEquals("{\"track\":null,\"playing\":false}", ActivityState(t, true).body())
    r.reporter.update(ActivityState(t, true))
    assertTrue(r.timers.isEmpty())
    r.runJobs()
    assertEquals(1, r.sent.size)
    assertTrue(r.sent[0].contains("{\"track\":null,\"playing\":false}"))
    assertFalse(r.sent[0].contains("Solo qui"))
  }

  @Test
  fun theServiceGoingSaysNothingPlaysAtOnceAndStopsTheTimer() {
    val r = Rig(ready = false)
    r.reporter.update(playing(v1.trackId, true))
    r.reporter.stop()
    assertTrue(r.timers.isEmpty())
    r.runJobs()
    // The first waited for the core (15 s) and gave up; the last one went at once, 1 s at most.
    assertEquals(1, r.sent.size)
    assertTrue(r.sent[0].contains("{\"track\":null,\"playing\":false}") && r.sent[0].endsWith(" ${ActivityReporter.STOP_TIMEOUT_MS}"))
    assertTrue(r.time.now - 100_000L >= 15_000L)
  }

  @Test
  fun aReportWaitsForTheCoreToWakeButNotForAnySource() {
    val r = Rig(ready = false)
    r.time.at(100_500L) {
      r.core.awakeSince = 100_500L
      r.core.listening = true
    }
    r.reporter.update(playing(v1.trackId, true))
    r.runJobs()
    assertEquals(1, r.sent.size)
    assertTrue(r.time.now in 100_500L..101_000L)
  }

  @Test
  fun aFailingCoreNeverStopsTheReporter() {
    val log = ArrayList<String>()
    var calls = 0
    val jobs = ArrayList<Runnable>()
    val reporter = ActivityReporter(
      http = { _, _, _, _ ->
        calls++
        throw java.io.IOException("refused")
      },
      awake = AwakeCall(HoldLog(log), StubCore(), { 0L }, { }),
      worker = { jobs.add(it) },
      later = { _, _ -> },
      cancel = { },
    )
    reporter.update(playing(v1.trackId, true))
    while (jobs.isNotEmpty()) jobs.removeAt(0).run()
    reporter.update(playing(v2.trackId, true))
    while (jobs.isNotEmpty()) jobs.removeAt(0).run()
    assertEquals(2, calls)
    assertEquals(listOf("hold activity", "release activity", "hold activity", "release activity"), log)
  }
}
