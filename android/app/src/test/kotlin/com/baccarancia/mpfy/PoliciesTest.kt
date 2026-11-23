package com.baccarancia.mpfy

import androidx.media3.common.Player
import androidx.media3.exoplayer.offline.Download
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadPolicyTest {
  @Test
  fun aQueuedDownloadDoesNotHoldTheCoreAwake() {
    // A download restored by a new process comes back queued: counting it as active kept the
    // worklet awake and the 1 s poll running for good.
    assertFalse(DownloadPolicy.isActive(Download.STATE_QUEUED, 0))
    assertFalse(DownloadPolicy.isActive(Download.STATE_STOPPED, 0))
    assertFalse(DownloadPolicy.isActive(Download.STATE_RESTARTING, 0))
  }

  @Test
  fun onlyADownloadMovingBytesIsActive() {
    assertTrue(DownloadPolicy.isActive(Download.STATE_DOWNLOADING, 0))
    // No network (or another requirement not met): nothing moves.
    assertFalse(DownloadPolicy.isActive(Download.STATE_DOWNLOADING, 1))
  }

  @Test
  fun unfinishedStates() {
    for (s in listOf(Download.STATE_QUEUED, Download.STATE_DOWNLOADING, Download.STATE_STOPPED, Download.STATE_RESTARTING)) {
      assertTrue("state $s", DownloadPolicy.isUnfinished(s))
    }
    for (s in listOf(Download.STATE_COMPLETED, Download.STATE_FAILED, Download.STATE_REMOVING)) {
      assertFalse("state $s", DownloadPolicy.isUnfinished(s))
    }
  }
}

class LevelsTest {
  private val t = "c892caba55a134ab573797d6"
  private val f = "0d6f1b2a3c4d5e6f70819293"

  @Test
  fun aThreePartKeyIsOneVersionAtOneLevel() {
    assertEquals(Levels.Download(t, f, "max"), Levels.parse("$t:$f:max"))
    assertEquals("$t:$f:low", Levels.key(t, f, "low"))
    assertEquals("low", Levels.ofKey(Levels.key(t, f, "low")))
  }

  @Test
  fun anOlderTwoPartKeyReadsAsTheTracksFirstFile() {
    assertEquals(Levels.Download(t, t, "max"), Levels.parse("$t:max"))
    assertEquals("high", Levels.ofKey("$t:high"))
  }

  @Test
  fun aStreamKeyIsNeverADownload() {
    val k = Levels.streamKey("a1b2c3d4", t, f, "max")
    assertEquals("stream:a1b2c3d4:$t:$f:max", k)
    assertNull(Levels.parse(k))
    assertNull(Levels.ofKey(k))
    assertEquals(Levels.Stream("a1b2c3d4", t, f, "max"), Levels.parseStream(k))
    // Even a stream key whose parts would look like a download is not one.
    assertNull(Levels.parse("stream:$t:max"))
    assertNull(Levels.parseStream("$t:$f:max"))
  }

  @Test
  fun keysThatNameNothing() {
    assertNull(Levels.parse(t))
    assertNull(Levels.parse("$t:loud"))
    assertNull(Levels.parse(":max"))
    assertNull(Levels.parse("$t:$f:x:max"))
    assertNull(Levels.parse("$t/x:max"))
    assertNull(Levels.parseStream("stream:a1b2c3d4:$t:$f"))
  }

  @Test
  fun aDownloadServedAtAnotherLevelMovesToThatLevelKeepingItsFile() {
    // Alta asked, transcode not ready: the source served the original.
    assertEquals("$t:$f:max", Levels.moveTo("$t:$f:high", "max", moved = false))
    assertEquals("$t:$f:normal", Levels.moveTo("$t:$f:high", " Normal ", moved = false))
    // An older two-part download moves to a three-part key of the same (first) file.
    assertEquals("$t:$t:max", Levels.moveTo("$t:high", "max", moved = false))
  }

  @Test
  fun aDownloadStaysWhenTheLevelMatchesOrIsUnknown() {
    assertNull(Levels.moveTo("$t:$f:high", "HIGH", moved = false))
    assertNull(Levels.moveTo("$t:$f:high", null, moved = false)) // a source that does not say
    assertNull(Levels.moveTo("$t:$f:high", "loud", moved = false))
    assertNull(Levels.moveTo(Levels.streamKey("a1b2c3d4", t, f, "high"), "max", moved = false)) // not a download
  }

  @Test
  fun aDownloadMovesOnceAtMost() {
    assertNull(Levels.moveTo("$t:$f:normal", "low", moved = true))
  }

  @Test
  fun aVersionPlaysFromItsDownloadWhateverLevelItWasStoredAt() {
    assertEquals("$t:$f:high", Levels.playKey("a1b2c3d4", t, f, "high", setOf("$t:$f:high", "$t:$f:max")))
    // Asked at Alta, stored at Max (moved): it still plays offline.
    assertEquals("$t:$f:max", Levels.playKey("a1b2c3d4", t, f, "high", setOf("$t:$f:max", "u:$f:high")))
    assertEquals("$t:$f:high", Levels.playKey("a1b2c3d4", t, f, "low", setOf("$t:$f:normal", "$t:$f:high")))
  }

  @Test
  fun aDownloadPlaysOnlyForItsOwnFile() {
    // The track was replaced on its source (a new fileHash): the old file's download is not this version.
    val k = Levels.playKey("a1b2c3d4", t, f, "max", setOf("$t:$t:max", "$t:max"))
    assertEquals(Levels.streamKey("a1b2c3d4", t, f, "max"), k)
    // The first file of the track does play from its two-part download, under that very key.
    assertEquals("$t:max", Levels.playKey("a1b2c3d4", t, t, "max", setOf("$t:max")))
  }

  @Test
  fun aStreamNeverReadsAPartialDownload() {
    // The key of a version that is not downloaded is no download key: a partial download of
    // another level (other bytes) can never be mixed into the stream.
    val k = Levels.playKey("a1b2c3d4", t, f, "high", setOf("u:$f:high"))
    assertTrue(k != "$t:$f:high")
    assertNull(Levels.ofKey(k))
  }

  @Test
  fun twoSourcesStreamUnderTwoKeys() {
    assertTrue(Levels.playKey("a1b2c3d4", t, f, "high", emptySet()) != Levels.playKey("e5f6a7b8", t, f, "high", emptySet()))
  }

  @Test
  fun removingOneVersionRemovesThatVersionOnly() {
    val other = "1111111111111111111111aa"
    val keys = listOf("$t:$f:max", "$t:$f:low", "$t:$other:max", "$t:max", "$t:$t:high", "x:$f:max", Levels.streamKey("a1b2c3d4", t, f, "max"))
    assertEquals(listOf("$t:$f:max", "$t:$f:low"), Levels.toRemove(keys, listOf(DownloadSelector.Version(t, f))))
    // The first file of the track: the two-part keys go with it.
    assertEquals(listOf("$t:max", "$t:$t:high"), Levels.toRemove(keys, listOf(DownloadSelector.Version(t, t))))
    // A track id alone: every version and level, never a stream key.
    assertEquals(listOf("$t:$f:max", "$t:$f:low", "$t:$other:max", "$t:max", "$t:$t:high"), Levels.toRemove(keys, listOf(DownloadSelector.Track(t))))
  }
}

class PlayerPolicyTest {
  @Test
  fun aPausedPlayerThatFailsStaysPaused() {
    // The page gone, the listener paused; the buffering ahead failed: skip, but do not play.
    assertEquals(PlayerPolicy.AfterError.SKIP, PlayerPolicy.afterError(uiAttached = false, errorStreak = 1, hasNext = true, playWhenReady = false))
  }

  @Test
  fun aPlayingPlayerThatFailsGoesOnWithTheNextTrack() {
    assertEquals(PlayerPolicy.AfterError.SKIP_AND_PLAY, PlayerPolicy.afterError(uiAttached = false, errorStreak = 1, hasNext = true, playWhenReady = true))
  }

  @Test
  fun thePageOrTheLimitsDecideOtherwise() {
    assertEquals(PlayerPolicy.AfterError.NOTHING, PlayerPolicy.afterError(uiAttached = true, errorStreak = 1, hasNext = true, playWhenReady = true))
    assertEquals(PlayerPolicy.AfterError.NOTHING, PlayerPolicy.afterError(uiAttached = false, errorStreak = 4, hasNext = true, playWhenReady = true))
    assertEquals(PlayerPolicy.AfterError.NOTHING, PlayerPolicy.afterError(uiAttached = false, errorStreak = 1, hasNext = false, playWhenReady = true))
  }

  @Test
  fun aPausedPlayerStillLoadingNeedsTheCore() {
    // Suspending the worklet under a paused player that buffers ahead made its loads time out.
    assertTrue(PlayerPolicy.needsCore(playWhenReady = false, playbackState = Player.STATE_READY, isLoading = true))
    assertFalse(PlayerPolicy.needsCore(playWhenReady = false, playbackState = Player.STATE_READY, isLoading = false))
  }

  @Test
  fun playingOrMeaningToPlayNeedsTheCore() {
    assertTrue(PlayerPolicy.needsCore(playWhenReady = true, playbackState = Player.STATE_BUFFERING, isLoading = false))
    assertTrue(PlayerPolicy.needsCore(playWhenReady = true, playbackState = Player.STATE_READY, isLoading = false))
    assertFalse(PlayerPolicy.needsCore(playWhenReady = true, playbackState = Player.STATE_IDLE, isLoading = false))
    assertFalse(PlayerPolicy.needsCore(playWhenReady = true, playbackState = Player.STATE_ENDED, isLoading = false))
  }
}

class PageLoadGateTest {
  @Test
  fun theFirstReadyLoadsOnce() {
    val g = PageLoadGate()
    assertFalse(g.onReady(false))
    assertTrue(g.onReady(true))
    assertFalse(g.onReady(true))
  }

  @Test
  fun aFailedLoadWithTheCoreDownIsLoadedAtTheNextReady() {
    val g = PageLoadGate()
    assertTrue(g.onReady(true))
    // The core went down under the first load: the retry finds it not ready...
    assertFalse(g.reload(false))
    assertFalse(g.onReady(false))
    // ...and the core coming back must load the page (it stayed on the error page before).
    assertTrue(g.onReady(true))
  }

  @Test
  fun aFailedLoadWithTheCoreUpIsLoadedAtOnce() {
    val g = PageLoadGate()
    assertTrue(g.onReady(true))
    assertTrue(g.reload(true))
    assertFalse(g.onReady(true))
  }
}

class PhoneVersionOrderTest {
  private val a = Version("aaaa0001", "t1", "f1", "", 0)
  private val b = Version("bbbb0002", "t2", "f2", "", 0)
  private val phone = Version("0000", "t3", "t3", "", 0)

  @Test
  fun thePhonesVersionGoesFirstThenTheDownloadedOnesThenThePagesOrder() {
    val completed = setOf(Levels.key("t2", "f2", "high"))
    assertEquals(listOf(phone, b, a), VersionOrder.order(listOf(a, b, phone), completed))
    assertEquals(listOf(phone, a, b), VersionOrder.order(listOf(a, phone, b), emptySet()))
    // Without one, as before.
    assertEquals(listOf(b, a), VersionOrder.order(listOf(a, b), completed))
  }
}
