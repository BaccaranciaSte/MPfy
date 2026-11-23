package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The core as CoreHost reports it, set by hand. */
internal class StubCore : CoreState {
  override var listening = true
  override var awakeSince: Long? = 0L
  override var listed = true
  override var principal: String? = null
  val sources = HashSet<String>()
  val up = HashSet<String>()

  override fun isSource(sourceId: String) = sourceId in sources

  override fun isUp(sourceId: String) = sourceId in up
}

internal class HoldLog(private val log: MutableList<String>) : Holder {
  override fun hold(tag: String) {
    log.add("hold $tag")
  }

  override fun release(tag: String) {
    log.add("release $tag")
  }
}

/** A clock that only moves when the gate pauses, and what happens meanwhile at given times. */
internal class FakeTime(var now: Long = 100_000L) {
  private val events = ArrayList<Pair<Long, () -> Unit>>()

  fun at(time: Long, what: () -> Unit) {
    events.add(time to what)
  }

  fun sleep(ms: Long) {
    now += ms
    val due = events.filter { it.first <= now }
    events.removeAll(due)
    due.forEach { it.second() }
  }
}

class HeldGateTest {
  private val src = "a3435d00"
  private val log = ArrayList<String>()
  private val core = StubCore().apply {
    sources += src
    up += src
  }
  private val time = FakeTime()
  private val gate = HeldGate(HoldLog(log), core, { time.now }, { time.sleep(it) })

  @Test
  fun aSuspendedCoreIsWaitedForUntilTheWorkletSaysItResumed() {
    // Suspended: its last flags still say it listens and the link is up.
    core.awakeSince = null
    val began = time.now
    time.at(began + 3_000) { core.awakeSince = time.now }
    var ranAt = -1L
    assertTrue(gate.use("like:x", src) { up -> ranAt = time.now; up })
    assertTrue("ran at ${ranAt - began}", ranAt - began in 3_000..3_100)
    assertEquals(listOf("hold like:x", "release like:x"), log)
  }

  @Test
  fun aLinkComingBackAfterTheResumeIsWaitedFor() {
    core.awakeSince = time.now
    core.up.clear()
    time.at(time.now + 4_000) { core.up += src }
    assertTrue(gate.use("art:x", src) { it })
  }

  @Test
  fun aSourceThatIsSimplyOffCostsNoWait() {
    // Awake for a minute and the link still down: it is not coming back in the next 15 s either.
    core.awakeSince = time.now - 60_000
    core.up.clear()
    val began = time.now
    assertFalse(gate.use("art:x", src) { it })
    assertEquals(began, time.now)
    // Woken 10 s ago: the link gets the rest of its 15 s.
    core.awakeSince = time.now - 10_000
    assertFalse(gate.use("art:x", src) { it })
    assertTrue(time.now - began in 5_000..5_100)
  }

  @Test
  fun aCoreThatNeverWakesIsWaitedFor15sThenTheRequestGoesAnyway() {
    core.awakeSince = null
    val began = time.now
    var ran = false
    assertFalse(gate.use("like:x", src) { up -> ran = true; up })
    assertTrue(ran)
    assertTrue(time.now - began in 15_000..15_100)
    assertEquals(listOf("hold like:x", "release like:x"), log)
  }

  @Test
  fun aSourceThatIsNotOursIsNeitherASourceNorWaitedFor() {
    assertTrue(gate.isSource(src))
    assertFalse(gate.isSource("deadbeef"))
    // Just woken, so a link of ours that is down would be waited for: one that is no source is not.
    core.awakeSince = time.now
    core.up.clear()
    val began = time.now
    assertFalse(gate.use("art:x", "deadbeef") { it })
    assertEquals(began, time.now)
  }

  @Test
  fun beforeTheCoresFirstListItIsWaitedForThenSourcesAndPrincipalAreRead() {
    core.listed = false
    core.principal = src
    val began = time.now
    time.at(began + 1_500) { core.listed = true }
    assertEquals(src, gate.principal())
    assertTrue(time.now - began in 1_500..1_600)
    assertTrue(gate.isSource(src))
    // A list that never comes: nothing after the wait.
    core.listed = false
    assertNull(gate.principal())
    assertFalse(gate.isSource(src))
  }
}

class CarLeaseTest {
  private val log = ArrayList<String>()
  private var now = 0L
  private val timers = ArrayList<Pair<Runnable, Long>>()
  private val lease = CarLease(HoldLog(log), { r, ms -> timers.add(r to now + ms) }, { r -> timers.removeAll { it.first === r } }, leaseMs = 300_000)

  private fun advance(ms: Long) {
    now += ms
    val due = timers.filter { it.second <= now }
    timers.removeAll(due)
    due.forEach { it.first.run() }
  }

  @Test
  fun aBrowserThatNeverSaysGoodbyeIsLetGoAfterTheLease() {
    lease.touch()
    assertEquals(listOf("hold auto"), log)
    advance(299_999)
    assertEquals(listOf("hold auto"), log)
    advance(1)
    assertEquals(listOf("hold auto", "release auto"), log)
    assertFalse(lease.held)
  }

  @Test
  fun eachCallRenewsTheLeaseAndHoldsOnce() {
    lease.touch()
    advance(200_000)
    lease.touch()
    advance(200_000)
    assertEquals(listOf("hold auto"), log)
    advance(100_000)
    assertEquals(listOf("hold auto", "release auto"), log)
    // The car again: held again.
    lease.touch()
    assertEquals(listOf("hold auto", "release auto", "hold auto"), log)
    assertEquals(1, timers.size)
  }

  @Test
  fun closingLetsGoAtOnceAndOnlyOnce() {
    lease.close()
    assertTrue(log.isEmpty())
    lease.touch()
    lease.close()
    lease.close()
    assertEquals(listOf("hold auto", "release auto"), log)
    assertTrue(timers.isEmpty())
  }
}
