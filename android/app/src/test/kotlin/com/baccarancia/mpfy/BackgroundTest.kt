package com.baccarancia.mpfy

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Starts nothing: records what the queue asks for, and runs its timers when told. */
private class FakeRunner : PrefetchQueue.Runner {
  val started = ArrayList<PrefetchQueue.Job>()
  val timers = ArrayList<Pair<Long, Runnable>>()

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

  fun fire() {
    timers.removeAt(0).second.run()
  }
}

class PrefetchQueueTest {
  private val runner = FakeRunner()
  private val q = PrefetchQueue(runner)

  private fun stream(n: Int) = PrefetchQueue.Item("t$n", "stream:aaaa:t$n:f$n:high", "http://127.0.0.1:47123/s/aaaa/api/stream/t$n?q=high&f=f$n", "high")

  private fun downloaded(n: Int) = PrefetchQueue.Item("t$n", "t$n:f$n:high", "", "high", downloaded = true)

  private val keys get() = runner.started.map { it.item.key }

  /** Every try of the job running fails, through the waits, until the queue gives up on its item. */
  private fun failToTheEnd() {
    val key = runner.started.last().item.key
    while (true) {
      q.ended(runner.started.last(), IOException("timeout"))
      if (runner.timers.isEmpty()) return
      runner.fire()
      assertEquals(key, keys.last())
    }
  }

  @Test
  fun theItemPlayingIsFetchedWholeThenTheNextOne() {
    q.onPlayer(stream(1), stream(2), playing = true)
    assertEquals(listOf(stream(1).key), keys)
    // The first span tells a fast link: the rest of the song in one go, then the next one.
    val first = runner.started[0]
    q.ended(first, null, PrefetchQueue.Result(first.length, 20, first.length))
    assertEquals(listOf(stream(1).key, stream(1).key), keys)
    assertEquals(-1L, runner.started[1].length)
    q.ended(runner.started[1], null)
    assertEquals(listOf(stream(1).key, stream(1).key, stream(2).key), keys)
  }

  @Test
  fun aDownloadedItemPlayingLetsTheNextOneBeFetchedAtOnce() {
    q.onPlayer(downloaded(1), stream(2), playing = true)
    assertEquals(listOf(stream(2).key), keys)
    // The next one starts playing: its fetch goes on.
    q.onPlayer(stream(2), stream(3), playing = true)
    assertFalse(runner.started[0].cancelled)
    assertEquals(1, runner.started.size)
  }

  @Test
  fun nothingIsFetchedWhileThePlayerIsPaused() {
    q.onPlayer(stream(1), stream(2), playing = false)
    assertTrue(runner.started.isEmpty())
    q.onPlayer(stream(1), stream(2), playing = true)
    assertEquals(listOf(stream(1).key), keys)
  }

  @Test
  fun aPauseStopsTheFetchWithoutGivingUpOnIt() {
    q.onPlayer(stream(1), stream(2), playing = true)
    val job = runner.started[0]
    q.onPlayer(stream(1), stream(2), playing = false)
    assertTrue(job.cancelled)
    q.ended(job, IOException("cancelled"))
    assertTrue(runner.timers.isEmpty())
    q.onPlayer(stream(1), stream(2), playing = true)
    assertEquals(listOf(stream(1).key, stream(1).key), keys)
    assertEquals(0, runner.started[1].attempt)
  }

  @Test
  fun anItemThatGaveUpTriesAgainWhenPlayResumes() {
    q.onPlayer(stream(1), stream(2), playing = true)
    // A sleeping core or a tunnel: every try fails, 1, 2, 4, 8 and 15 s apart, then it gives up.
    failToTheEnd()
    assertEquals(6, runner.started.count { it.item.key == stream(1).key })
    assertEquals(stream(2).key, keys.last()) // meanwhile the next one
    q.onPlayer(stream(1), stream(2), playing = true)
    assertEquals(7, runner.started.size)
    q.onPlayer(stream(1), stream(2), playing = false)
    q.ended(runner.started.last(), IOException("cancelled"))
    q.onPlayer(stream(1), stream(2), playing = true)
    assertEquals(stream(1).key, keys.last())
    assertEquals(0, runner.started.last().attempt)
  }

  @Test
  fun theNetworkComingBackRetriesWhatGaveUp() {
    q.onPlayer(stream(1), null, playing = true)
    failToTheEnd()
    val tries = runner.started.size
    q.onPlayer(stream(1), null, playing = true)
    assertEquals(tries, runner.started.size)
    q.networkBack()
    assertEquals(tries + 1, runner.started.size)
    assertEquals(stream(1).key, keys.last())
  }

  @Test
  fun nothingInThePlayerStopsEverything() {
    q.onPlayer(stream(1), stream(2), playing = true)
    q.onPlayer(null, null, playing = false)
    assertTrue(runner.started[0].cancelled)
    q.ended(runner.started[0], IOException("cancelled"))
    q.networkBack()
    assertEquals(1, runner.started.size)
  }

  @Test
  fun aSourceThatServedMoreThanAskedOnAMeteredNetworkIsStreamedInstead() {
    q.onPlayer(stream(1), stream(2), playing = true)
    val job = runner.started[0]
    job.metered = true
    job.cancel()
    q.ended(job, IOException("cancelled"))
    assertTrue(runner.timers.isEmpty())
    assertEquals(listOf(stream(1).key, stream(2).key), keys)
  }

  @Test
  fun anotherItemPlayingStopsTheFetch() {
    q.onPlayer(stream(1), stream(2), playing = true)
    q.onPlayer(stream(5), stream(6), playing = true)
    assertTrue(runner.started[0].cancelled)
    q.ended(runner.started[0], IOException("cancelled"))
    assertEquals(stream(5).key, keys.last())
  }
}

class UploadStateTest {
  @Test
  fun aPageThatGoesAwayTakesItsUploadsWithIt() {
    val s = UploadState()
    val page = Any()
    assertTrue(s.say(page, true))
    assertTrue(s.active)
    // Its renderer died, or the app was swiped away: the queue was in the page.
    assertTrue(s.gone(page))
    assertFalse(s.active)
    assertFalse(s.gone(page))
  }

  @Test
  fun aPageGoingAwayLeavesAnotherPagesWordAlone() {
    val s = UploadState()
    val old = Any()
    val fresh = Any()
    s.say(old, true)
    assertFalse(s.say(fresh, true))
    assertFalse(s.gone(old))
    assertTrue(s.active)
    assertTrue(s.say(fresh, false))
    assertFalse(s.active)
  }

  @Test
  fun aStartOnItsWayIsNeverStoppedFromOutside() {
    val s = UploadState()
    assertTrue(s.mayStop)
    // Uploads start and end at once (a file refused at once): the start is still on its way.
    s.starting()
    assertFalse(s.mayStop)
    s.starting()
    s.started()
    assertFalse(s.mayStop)
    s.started()
    assertTrue(s.mayStop)
    s.started()
    s.starting()
    assertFalse(s.mayStop)
  }
}

class NotificationAskTest {
  @Test
  fun askedOnceFromAndroid13WithTheAppInFront() {
    assertTrue(NotificationAsk.shouldAsk(33, granted = false, askedBefore = false, inFront = true))
    assertTrue(NotificationAsk.shouldAsk(36, granted = false, askedBefore = false, inFront = true))
    assertFalse(NotificationAsk.shouldAsk(32, granted = false, askedBefore = false, inFront = true))
    assertFalse(NotificationAsk.shouldAsk(34, granted = true, askedBefore = false, inFront = true))
    assertFalse(NotificationAsk.shouldAsk(34, granted = false, askedBefore = true, inFront = true))
    assertFalse(NotificationAsk.shouldAsk(34, granted = false, askedBefore = false, inFront = false))
  }
}

class SecretClipTest {
  @Test
  fun onlyTheClipTheAppPutThereIsCleared() {
    assertTrue(SecretClip.stillOurs("MPfy", 1_000, 1_000))
    // Another app copied something since: left alone.
    assertFalse(SecretClip.stillOurs("Chat", 5_000, 1_000))
    assertFalse(SecretClip.stillOurs("MPfy", 5_000, 1_000))
    assertFalse(SecretClip.stillOurs(null, 0, 1_000))
    // Our own time unknown: nothing is cleared on a guess.
    assertFalse(SecretClip.stillOurs("MPfy", 0, 0))
  }
}
