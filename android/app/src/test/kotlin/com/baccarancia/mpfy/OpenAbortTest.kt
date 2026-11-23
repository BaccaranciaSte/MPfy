package com.baccarancia.mpfy

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A core that takes a request and never answers it: how a source behind a thin link looks while the old song's head is on its way. */
private class SilentCore : AutoCloseable {
  private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
  val port: Int get() = server.localPort
  val requested = CountDownLatch(1)
  val closed = CountDownLatch(1)
  val closedAt = AtomicLong(0)
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()

  init {
    Thread {
      try {
        val s = server.accept()
        sockets.add(s)
        val input = s.getInputStream()
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (last4 != 0x0d0a0d0a) {
          val b = input.read()
          if (b < 0) break
          head.write(b)
          last4 = (last4 shl 8) or b
        }
        requested.countDown()
        // Nothing is sent: the end of the connection is the app letting go of it.
        while (input.read() >= 0) {
          // the app sends nothing more
        }
        closedAt.set(System.nanoTime())
        closed.countDown()
      } catch (e: IOException) {
        closedAt.set(System.nanoTime())
        closed.countDown()
      }
    }.apply { isDaemon = true }.start()
  }

  override fun close() {
    for (s in sockets) runCatching { s.close() }
    runCatching { server.close() }
  }
}

/**
 * A skip lets go of the old song's reads at once, while their answer is still on its way too: the
 * prefetch's (its job is cancelled) and the player's (Media3 interrupts its loader). Before, both
 * waited for the head or the read timeout, with the request alive in the core all that time.
 */
class OpenAbortTest {
  private lateinit var timer: ScheduledExecutorService
  private val links = LinkWatch { _, _ -> AutoCloseable {} }
  private val reps = object : Representations {
    override fun generation(key: String) = 0

    override fun etagOf(key: String): String? = null

    override fun admit(key: String, etag: String?) = true

    override fun invalidate(key: String) {}
  }

  @Before
  fun setUp() {
    timer = Executors.newSingleThreadScheduledExecutor()
  }

  @After
  fun tearDown() {
    timer.shutdownNow()
  }

  /** Opens the old song on its own thread; [ended] is when the open gave up. */
  private class Opening(val thread: Thread, val ended: CountDownLatch, val endedAt: AtomicLong, val error: AtomicReference<Throwable?>)

  private fun open(core: SilentCore): Pair<FailoverReader, Opening> {
    val origin = "http://127.0.0.1:${core.port}"
    // The read timeout is long, as the app's (the core waits for the source's link): only the abort can end the wait early.
    val reader = FailoverReader(VersionRegistry(), HttpOpener(emptyMap(), readMs = 4_000), reps, links, timer, origin, stallMs = 200)
    val key = Levels.streamKey("aaaa0001", "t1", "f1", "high")
    val ended = CountDownLatch(1)
    val endedAt = AtomicLong(0)
    val error = AtomicReference<Throwable?>(null)
    val t = Thread {
      try {
        reader.open(key, "$origin/s/aaaa0001/api/stream/t1?q=high&f=f1", 0, -1)
      } catch (e: Throwable) {
        error.set(e)
      } finally {
        endedAt.set(System.nanoTime())
        ended.countDown()
      }
    }
    t.isDaemon = true
    t.start()
    assertTrue("the request reached the core", core.requested.await(3, TimeUnit.SECONDS))
    return reader to Opening(t, ended, endedAt, error)
  }

  private fun ms(fromNanos: Long, toNanos: Long) = (toNanos - fromNanos) / 1_000_000

  @Test
  fun aCancelEndsAnOpenStillWaitingForItsHeadAndLetsGoOfItsConnection() {
    SilentCore().use { core ->
      val (reader, o) = open(core)
      val t0 = System.nanoTime()
      reader.cancel()
      assertTrue("the open ended", o.ended.await(3, TimeUnit.SECONDS))
      assertTrue("the open ended ${ms(t0, o.endedAt.get())} ms after the cancel", ms(t0, o.endedAt.get()) < 600)
      assertNotNull(o.error.get())
      assertTrue("the connection closed", core.closed.await(3, TimeUnit.SECONDS))
      assertTrue("the connection closed ${ms(t0, core.closedAt.get())} ms after the cancel", ms(t0, core.closedAt.get()) < 600)
    }
  }

  @Test
  fun anInterruptedLoaderEndsAnOpenStillWaitingForItsHeadWithinATick() {
    SilentCore().use { core ->
      val (_, o) = open(core)
      val t0 = System.nanoTime()
      // What Media3's Loader does to the player's old load at a skip: cancelLoad, then an interrupt.
      o.thread.interrupt()
      assertTrue("the open ended", o.ended.await(3, TimeUnit.SECONDS))
      assertTrue("the open ended ${ms(t0, o.endedAt.get())} ms after the interrupt", ms(t0, o.endedAt.get()) < 600)
      assertTrue("the connection closed", core.closed.await(3, TimeUnit.SECONDS))
      assertTrue("the connection closed ${ms(t0, core.closedAt.get())} ms after the interrupt", ms(t0, core.closedAt.get()) < 600)
    }
  }
}
