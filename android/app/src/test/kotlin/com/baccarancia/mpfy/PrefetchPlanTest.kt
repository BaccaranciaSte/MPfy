package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The prefetch as a fake cache sees it: where the player reads, what is cached, how big each song
 * is. [finish] ends the running span as a fetch at [rate] bytes per second would.
 */
private class PlanRunner : PrefetchQueue.Runner {
  val started = ArrayList<PrefetchQueue.Job>()
  val timers = ArrayList<Pair<Long, Runnable>>()
  val player = HashMap<String, Long>()
  val sizes = HashMap<String, Long>()
  val wakes = ArrayList<Pair<String, Long>>()
  // Per key, the cached ranges.
  val cached = HashMap<String, MutableList<LongRange>>()

  override fun start(job: PrefetchQueue.Job) {
    started.add(job)
  }

  override fun later(ms: Long, task: Runnable) {
    timers.add(ms to task)
  }

  override fun cancelLater(task: Runnable) {
    timers.removeAll { it.second === task }
  }

  override fun log(line: String) {}

  override fun playerAt(key: String): Long = player[key] ?: -1

  override fun wakeAt(key: String, position: Long) {
    wakes.add(key to position)
  }

  override fun cachedFrom(key: String, position: Long): Long {
    val r = cached[key]?.firstOrNull { position in it } ?: return 0
    return r.last + 1 - position
  }

  override fun sizeOf(key: String): Long = sizes[key] ?: -1

  /** What the last span read: from its first byte to its end, the song's end, or the next cached byte. */
  fun finish(q: PrefetchQueue, rate: Long) {
    val job = started.last()
    val size = sizes[job.item.key] ?: (8L shl 20)
    val end = if (job.length < 0) size else minOf(size, job.from + job.length)
    val covered = end - job.from
    val list = cached.getOrPut(job.item.key) { ArrayList() }
    list.add(job.from until end)
    // Merge what touches.
    list.sortBy { it.first }
    val merged = ArrayList<LongRange>()
    for (r in list) {
      val last = merged.lastOrNull()
      if (last != null && r.first <= last.last + 1) merged[merged.size - 1] = last.first..maxOf(last.last, r.last) else merged.add(r)
    }
    cached[job.item.key] = merged
    if (end >= size) sizes[job.item.key] = size
    job.done = covered
    q.ended(job, null, PrefetchQueue.Result(covered, maxOf(1L, covered * 1000 / rate), covered))
  }
}

class PrefetchPlanTest {
  private val runner = PlanRunner()
  private val q = PrefetchQueue(runner)
  private val mib = 1L shl 20
  private val fast = 8 * mib
  private val slow = 64L * 1024

  private fun stream(n: Int) = PrefetchQueue.Item("t$n", "stream:aaaa0001:t$n:f$n:high", "http://127.0.0.1:47123/s/aaaa0001/api/stream/t$n?q=high&f=f$n", "high")

  private fun phone(n: Int) = PrefetchQueue.Item("t$n", "stream:0000:t$n:t$n:high", "http://127.0.0.1:47123/s/0000/api/stream/t$n?q=high&f=t$n", "high")

  private val one = stream(1)
  private val two = stream(2)

  private fun jobsOf(item: PrefetchQueue.Item) = runner.started.filter { it.item.key == item.key }

  @Test
  fun aSongStartedMidwayIsFetchedFromThePlayPositionAndItsStartOnlyWhenAskedFor() {
    runner.sizes[one.key] = 8 * mib
    runner.player[one.key] = 5 * mib
    q.onPlayer(one, two, playing = true)
    assertEquals(5 * mib, runner.started.last().from)
    runner.finish(q, fast)
    // A fast link: the rest in one request, from where the first span ended.
    val rest = runner.started.last()
    assertEquals(one.key, rest.item.key)
    assertEquals(5 * mib + PrefetchPolicy.FIRST_SPAN, rest.from)
    assertEquals(-1L, rest.length)
    runner.finish(q, fast)
    // Then the next song, not the part of this one behind the play position.
    assertEquals(two.key, runner.started.last().item.key)
    assertEquals(0L, runner.started.last().from)
    assertTrue(jobsOf(one).all { it.from >= 5 * mib })
    runner.finish(q, fast)
    val n = runner.started.size
    q.playerMoved(one.key, opened = false)
    assertEquals(n, runner.started.size)
    // The listener goes back to minute one: that part is fetched now, from there.
    runner.player[one.key] = mib
    q.playerMoved(one.key, opened = true)
    assertEquals(one.key, runner.started.last().item.key)
    assertEquals(mib, runner.started.last().from)
  }

  @Test
  fun thePlayerOpeningPastTheFetchMovesTheFetchThere() {
    runner.sizes[one.key] = 8 * mib
    // The first open reads the file's head; the play starts at minute two.
    runner.player[one.key] = 0
    q.onPlayer(one, two, playing = true)
    val head = runner.started.last()
    assertEquals(0L, head.from)
    head.done = 100L * 1024
    // An open the running fetch is about to reach leaves it alone.
    runner.player[one.key] = 200L * 1024
    q.playerMoved(one.key, opened = true)
    assertFalse(head.cancelled)
    assertEquals(1, runner.started.size)
    runner.player[one.key] = 6 * mib
    q.playerMoved(one.key, opened = true)
    assertTrue(head.cancelled)
    assertEquals(6 * mib, runner.started.last().from)
    q.ended(head, java.io.IOException("cancelled"))
    assertEquals(2, runner.started.size)
  }

  @Test
  fun aSlowLinkKeepsTheFetchAWindowAheadOfThePlayer() {
    runner.sizes[one.key] = 8 * mib
    runner.sizes[two.key] = 8 * mib
    runner.player[one.key] = 0
    q.onPlayer(one, two, playing = true)
    // The first span tells the link: 64 KiB/s, far from what a whole song in one go needs.
    runner.finish(q, slow)
    val ahead = PrefetchPolicy.ahead(slow)
    assertTrue(ahead in PrefetchPolicy.MIN_AHEAD..PrefetchPolicy.MAX_AHEAD)
    var job = runner.started.last()
    assertEquals(one.key, job.item.key)
    assertEquals(PrefetchPolicy.FIRST_SPAN, job.from)
    assertEquals(ahead, job.from + job.length)
    runner.finish(q, slow)
    // Its window is full: the next song's first window, then nothing until the player moves on.
    job = runner.started.last()
    assertEquals(two.key, job.item.key)
    assertEquals(0L, job.from)
    assertEquals(ahead, job.length)
    runner.finish(q, slow)
    val n = runner.started.size
    assertEquals(listOf(one.key to ahead / 2), runner.wakes)
    runner.player[one.key] = ahead / 2 + 10
    q.playerMoved(one.key, opened = false)
    assertEquals(n + 1, runner.started.size)
    job = runner.started.last()
    assertEquals(ahead, job.from)
    assertEquals(ahead / 2 + 10 + ahead, job.from + job.length)
    // Never more than a window past the player on this link.
    for (j in jobsOf(one)) assertTrue(j.length in 1..ahead)
  }

  @Test
  fun aFastLinkFetchesTheRestInOneGoAndTheWindowGrowsWithTheLink() {
    runner.sizes[one.key] = 8 * mib
    runner.player[one.key] = 0
    q.onPlayer(one, null, playing = true)
    assertEquals(PrefetchPolicy.FIRST_SPAN, runner.started.last().length)
    runner.finish(q, fast)
    assertEquals(-1L, runner.started.last().length)
    assertEquals(-1L, PrefetchPolicy.ahead(PrefetchPolicy.FAST))
    assertTrue(PrefetchPolicy.ahead(slow) < PrefetchPolicy.ahead(4 * slow))
    assertEquals(PrefetchPolicy.FIRST_SPAN, PrefetchPolicy.ahead(null))
  }

  @Test
  fun aSpanNeverStartsAtTheEndOfTheSong() {
    val size = mib + 1000
    runner.sizes[one.key] = size
    runner.player[one.key] = 0
    q.onPlayer(one, null, playing = true)
    runner.finish(q, slow)
    var guard = 0
    while (guard++ < 50) {
      val job = runner.started.last()
      assertTrue(job.from < size)
      if (job.length > 0) assertTrue(job.from + job.length <= size)
      runner.player[one.key] = job.from + job.length.coerceAtLeast(0)
      val before = runner.started.size
      runner.finish(q, slow)
      if (runner.started.size == before) q.playerMoved(one.key, opened = false)
      if (runner.started.size == before) break
    }
    assertEquals(listOf(0 until size), runner.cached[one.key])
  }

  @Test
  fun aSongOnThePhoneIsNeverPrefetched() {
    q.onPlayer(phone(1), two, playing = true)
    assertEquals(listOf(two.key), runner.started.map { it.item.key })
    q.onPlayer(two, phone(3), playing = true)
    runner.finish(q, fast)
    runner.finish(q, fast)
    assertTrue(runner.started.none { LocalSource.isKey(it.item.key) })
  }

  @Test
  fun aSkipCancelsTheOldSongsFetchBeforeTheNewOneStarts() {
    val order = ArrayList<String>()
    val r = object : PrefetchQueue.Runner by runner {
      override fun start(job: PrefetchQueue.Job) {
        order.add("start ${job.item.itemId}")
        job.onCancel { order.add("cancel ${job.item.itemId}") }
        runner.start(job)
      }
    }
    val q2 = PrefetchQueue(r)
    q2.onPlayer(one, two, playing = true)
    q2.onPlayer(stream(5), stream(6), playing = true)
    assertEquals(listOf("start t1", "cancel t1", "start t5"), order)
  }

  @Test
  fun anotherNetworkMeasuresTheLinkAgain() {
    runner.sizes[one.key] = 8 * mib
    runner.player[one.key] = 0
    q.onPlayer(one, null, playing = true)
    runner.finish(q, fast)
    assertEquals(-1L, runner.started.last().length)
    q.onPlayer(null, null, playing = false)
    q.networkBack()
    runner.player[one.key] = 3 * mib
    q.onPlayer(one, null, playing = true)
    assertEquals(PrefetchPolicy.FIRST_SPAN, runner.started.last().length)
  }
}
