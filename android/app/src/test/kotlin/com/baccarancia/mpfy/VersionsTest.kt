package com.baccarancia.mpfy

import androidx.media3.common.C
import java.io.IOException
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun v(src: String, t: String = "t", f: String = "f", off: Long = 0) = Version(src, t, f, "", off)

class VersionOrderTest {
  @Test
  fun downloadedVersionsGoFirstBestLevelFirstThenThePagesOrder() {
    val a = v("aaaa", f = "fa")
    val b = v("bbbb", f = "fb")
    val c = v("cccc", f = "fc")
    val d = v("dddd", f = "fd")
    val completed = setOf("t:fc:low", "t:fd:max")
    assertEquals(listOf(d, c, a, b), VersionOrder.order(listOf(a, b, c, d), completed))
    // Nothing downloaded: the page's order stands.
    assertEquals(listOf(a, b, c, d), VersionOrder.order(listOf(a, b, c, d), emptySet()))
  }

  @Test
  fun anOlderTwoPartDownloadCountsForTheTracksFirstFile() {
    val first = v("aaaa", t = "t", f = "t")
    val other = v("bbbb", t = "t", f = "fb")
    assertEquals(listOf(first, other), VersionOrder.order(listOf(other, first), setOf("t:high")))
  }

  @Test
  fun theSameVersionTwiceIsKeptOnce() {
    val a = v("aaaa")
    assertEquals(listOf(a), VersionOrder.order(listOf(a, a.copy(offsetMs = 5)), emptySet()))
  }

  @Test
  fun theItemPlaysFromItsFirstVersionsKey() {
    val a = v("aaaa", f = "fa")
    assertEquals("stream:aaaa:t:fa:high", VersionOrder.keyOf(a, "high", emptySet()))
    assertEquals("t:fa:max", VersionOrder.keyOf(a, "high", setOf("t:fa:max")))
  }

  @Test
  fun aFailedVersionGoesLastAndTheNextUntriedOneFirst() {
    val a = v("aaaa")
    val b = v("bbbb")
    val c = v("cccc")
    assertEquals(listOf(b, c, a), VersionOrder.rotate(listOf(a, b, c), a, emptySet()))
    // B failed too, A was tried: C next.
    assertEquals(listOf(c, a, b), VersionOrder.rotate(listOf(b, c, a), b, setOf(a.id)))
    // Every other one tried: nothing left.
    assertNull(VersionOrder.rotate(listOf(c, a, b), c, setOf(a.id, b.id)))
    assertNull(VersionOrder.rotate(listOf(a), a, emptySet()))
  }

  @Test
  fun theNewVersionStartsAtTheSameMomentOfTheSong() {
    // Offsets are against the page's first version: 300 ms later in the old file is 120 ms later in the new one.
    assertEquals(60_000L - 300 + 120, VersionOrder.alignedPosition(60_000, v("aaaa", off = 300), v("bbbb", off = 120)))
    assertEquals(0L, VersionOrder.alignedPosition(100, v("aaaa", off = 500), v("bbbb")))
  }

  @Test
  fun theVersionPlayingThatThePageLeftOutKeepsItsMomentInTheNewList() {
    // A plays; B is another file 1238 ms later. A's source goes down: the page sends B alone, its
    // offset now 0 against itself. A failing then goes to B 1238 ms further on, not at the same ms.
    val a = v("aaaa", f = "fa", off = 0)
    val b = v("bbbb", f = "fb", off = 1238)
    val key = "stream:aaaa:t:fa:max"
    val list = VersionOrder.forPlaying(listOf(a, b), listOf(b.copy(offsetMs = 0)), a)
    assertEquals(listOf(b.copy(offsetMs = 0), a.copy(offsetMs = -1238)), list)
    val s = VersionOrder.next(list, key, emptySet(), 60_000)!!
    assertEquals(a.copy(offsetMs = -1238), s.failed)
    assertEquals(b.id, s.versions.first().id)
    assertEquals(61_238L, s.atMs)
  }

  @Test
  fun theVersionPlayingStaysAsThePageSentItWhenTheListHoldsIt() {
    val a = v("aaaa", f = "fa", off = 0)
    val b = v("bbbb", f = "fb", off = 500)
    // B is faster now: the page puts it first, and A's offset comes against B.
    val fresh = listOf(b.copy(offsetMs = 0), a.copy(offsetMs = -500))
    assertEquals(fresh, VersionOrder.forPlaying(listOf(a, b), fresh, a))
    assertEquals(60_500L, VersionOrder.next(fresh, "stream:aaaa:t:fa:max", emptySet(), 60_000)!!.atMs)
  }

  @Test
  fun withNoVersionInCommonTheVersionPlayingIsTakenAsAlignedWithTheNewFirst() {
    val b = v("bbbb", f = "fb", off = 0)
    val a = v("aaaa", f = "fa", off = 400)
    val c = v("cccc", f = "fc", off = 0)
    val d = v("dddd", f = "fd", off = 300)
    assertEquals(listOf(c, d, a.copy(offsetMs = 0)), VersionOrder.forPlaying(listOf(b, a), listOf(c, d), a))
    // An empty list from the page changes nothing.
    assertEquals(listOf(b, a), VersionOrder.forPlaying(listOf(b, a), emptyList(), a))
  }

  @Test
  fun nothingIsLeftWhenEveryOtherVersionWasTried() {
    val a = v("aaaa", f = "fa")
    val b = v("bbbb", f = "fb")
    assertNull(VersionOrder.next(listOf(a, b), "stream:aaaa:t:fa:max", setOf(b.id), 1_000))
    // A key the list does not hold names nothing to move on from.
    assertNull(VersionOrder.next(listOf(b), "stream:aaaa:t:fa:max", emptySet(), 1_000))
  }
}

class VersionRegistryTest {
  private val a = v("aaaa", f = "fa")
  private val b = v("bbbb", f = "fb")
  private val c = v("cccc", f = "fc")

  @Test
  fun theKeyNamesItsVersion() {
    val e = VersionRegistry.Entry("t", "max", listOf(a, b))
    assertEquals(b, e.versionOf("stream:bbbb:t:fb:max"))
    assertEquals(a, e.versionOf("t:fa:high")) // a download names the file
    assertNull(e.versionOf("stream:cccc:t:fc:max"))
  }

  @Test
  fun thePlayingItemTakesThePagesNewOrderAndKeepsWhatWasTried() {
    val r = VersionRegistry()
    val key = "stream:bbbb:t:fb:max"
    r.put(key, VersionRegistry.Entry("t", "max", listOf(b, c, a), tried = setOf(a.id)))
    r.update(key, "t", "max", listOf(a, c, b))
    val e = r.get(key)!!
    assertEquals(listOf(a, c, b), e.versions)
    assertEquals(setOf(a.id), e.tried)
    // C is still untried; with C tried too, nothing is.
    assertTrue(e.hasUntried(key))
    r.update(key, "t", "max", listOf(b, a))
    assertFalse(r.get(key)!!.hasUntried(key))
  }

  @Test
  fun anotherItemUnderTheKeyStartsAfresh() {
    val r = VersionRegistry()
    val key = "stream:aaaa:t:fa:max"
    r.put(key, VersionRegistry.Entry("t", "max", listOf(a, b), tried = setOf(b.id)))
    r.get(key)!!.movedTo = b.id
    r.update(key, "other", "max", listOf(a, b))
    assertEquals(emptySet<String>(), r.get(key)!!.tried)
    assertNull(r.get(key)!!.movedTo)
  }

  @Test
  fun whereTheReadsMovedStaysWhileThePageKeepsThatVersion() {
    val r = VersionRegistry()
    val key = "stream:aaaa:t:fa:max"
    r.put(key, VersionRegistry.Entry("t", "max", listOf(a, b)))
    r.get(key)!!.movedTo = b.id
    r.update(key, "t", "max", listOf(b, a))
    assertEquals(b.id, r.get(key)!!.movedTo)
    r.update(key, "t", "max", listOf(a, c))
    assertNull(r.get(key)!!.movedTo)
  }

  @Test
  fun theOldestItemsGo() {
    val r = VersionRegistry(max = 2)
    r.put("k1", VersionRegistry.Entry("1", "max", listOf(a)))
    r.put("k2", VersionRegistry.Entry("2", "max", listOf(a)))
    r.get("k1")
    r.put("k3", VersionRegistry.Entry("3", "max", listOf(a)))
    assertNull(r.get("k2"))
    assertEquals("1", r.get("k1")!!.itemId)
  }
}

class StreamRetryTest {
  @Test
  fun aChangedRepresentationGoesToThePlayerAtOnce() {
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(RepresentationChangedException("k"), 1))
  }

  @Test
  fun anExhaustedReadWithAVersionLeftGoesToThePlayerAtOnce() {
    // Even a cause that would be retried six times: the service moves on to the next version.
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(VersionsExhaustedException(IOException("reset"), hasUntried = true), 1))
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(VersionsExhaustedException(HttpStatusException(503), hasUntried = true), 1))
  }

  @Test
  fun withNoVersionLeftTheUsualRulesApplyToTheCause() {
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(VersionsExhaustedException(HttpStatusException(404), hasUntried = false), 1))
    assertEquals(1_000L, StreamRetry.delayFor(VersionsExhaustedException(HttpStatusException(503), hasUntried = false), 1))
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(VersionsExhaustedException(HttpStatusException(503), hasUntried = false), 2))
    assertEquals(StreamRetry.DEFAULT, StreamRetry.delayFor(VersionsExhaustedException(SocketTimeoutException("x"), hasUntried = false), 1))
  }

  @Test
  fun otherFailuresKeepTheUsualRules() {
    assertEquals(C.TIME_UNSET, StreamRetry.delayFor(HttpStatusException(403), 1))
    assertEquals(1_000L, StreamRetry.delayFor(HttpStatusException(502), 1))
    // A connection that failed: the default six tries.
    assertEquals(StreamRetry.DEFAULT, StreamRetry.delayFor(IOException("connection refused"), 3))
  }
}

class PrefetchPolicyTest {
  @Test
  fun onAMeteredNetworkAHigherLevelThanAskedIsNotFetchedWhole() {
    assertTrue(PrefetchPolicy.stopsOnServed(metered = true, asked = "high", served = "max"))
    assertFalse(PrefetchPolicy.stopsOnServed(metered = true, asked = "high", served = "high"))
    assertFalse(PrefetchPolicy.stopsOnServed(metered = true, asked = "high", served = "normal"))
    assertFalse(PrefetchPolicy.stopsOnServed(metered = false, asked = "high", served = "max"))
    assertFalse(PrefetchPolicy.stopsOnServed(metered = true, asked = "high", served = null))
  }

  @Test
  fun itTriesAgainAfter1To15Seconds() {
    assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L), PrefetchPolicy.RETRY_MS)
  }
}

class IdentityNamesTest {
  @Test
  fun theFileIsNamedAfterTheProfile() {
    assertEquals("Bacca.mpfy", IdentityNames.forProfile("Bacca"))
    assertEquals("MPfy.mpfy", IdentityNames.forProfile(""))
    assertEquals("MPfy.mpfy", IdentityNames.forProfile(null))
  }

  @Test
  fun badCharactersAndControlsGo() {
    assertEquals("ab c.mpfy", IdentityNames.forProfile("a\\/:*?\"<>|b\u0007 c"))
    assertEquals("MPfy.mpfy", IdentityNames.forProfile("/:*?"))
  }

  @Test
  fun leadingDotsAndSpacesGoTogether() {
    // A leading dot would hide the file.
    assertEquals("x.mpfy", IdentityNames.forProfile(". .x"))
    assertEquals("x.mpfy", IdentityNames.forProfile(" ..x "))
    assertEquals("a.b.mpfy", IdentityNames.forProfile("a.b"))
    assertEquals("x.mpfy", IdentityNames.forProfile("\u00a0\u3000.x\ufeff"))
  }

  @Test
  fun atMost60CharactersCountedAsCodePoints() {
    val emoji = "\ud83c\udfb5" // one code point, two UTF-16 units
    val name = emoji.repeat(61)
    assertEquals(emoji.repeat(60) + ".mpfy", IdentityNames.forProfile(name))
    assertEquals("a".repeat(60) + ".mpfy", IdentityNames.forProfile("a".repeat(70)))
    // Cut, then trimmed again.
    assertEquals("a".repeat(59) + ".mpfy", IdentityNames.forProfile("a".repeat(59) + " b"))
  }

  @Test
  fun aNameTheCoreSentIsCheckedAgain() {
    assertEquals("Bacca.mpfy", IdentityNames.sanitize("Bacca.mpfy"))
    assertEquals("x.mpfy", IdentityNames.sanitize("../x.mpfy"))
    assertEquals("MPfy.mpfy", IdentityNames.sanitize(".mpfy"))
    assertEquals("MPfy.mpfy", IdentityNames.sanitize(null))
  }

  @Test
  fun onlyAFileOnThePhoneIsAdopted() {
    assertTrue(IdentityNames.canAdopt("com.android.externalstorage.documents"))
    // Picked from Recent, or the media provider's own roots: still a file on the phone.
    assertTrue(IdentityNames.canAdopt("com.android.providers.media.documents"))
    assertTrue(IdentityNames.canAdopt("media"))
    assertFalse(IdentityNames.canAdopt("com.google.android.apps.docs.storage"))
    assertFalse(IdentityNames.canAdopt("com.microsoft.skydrive.content.StorageAccessProvider"))
    assertFalse(IdentityNames.canAdopt("com.android.providers.downloads.documents"))
    assertFalse(IdentityNames.canAdopt(null))
  }
}

class NativeFilesTest {
  @Test
  fun aFolderKeepsSongsArchivesAndPictures() {
    for (n in listOf("01.mp3", "a.M4A", "b.aac", "c.flac", "d.ogg", "e.opus", "f.wav", "x.zip", "y.7z", "z.RAR", "cover.jpg", "f.jpeg", "b.png", "c.webp")) {
      assertTrue(n, NativeFiles.keeps(n))
    }
    for (n in listOf("album.cue", "rip.log", "info.nfo", "list.m3u", "booklet.pdf", "noext", ".hidden")) {
      assertFalse(n, NativeFiles.keeps(n))
    }
  }

  @Test
  fun rangesAreServedAs206() {
    assertEquals(NativeFiles.Ask.Part(0, 99), NativeFiles.range("bytes=0-99", 1000))
    assertEquals(NativeFiles.Ask.Part(500, 999), NativeFiles.range("bytes=500-", 1000))
    assertEquals(NativeFiles.Ask.Part(900, 999), NativeFiles.range("bytes=900-5000", 1000))
    assertEquals(NativeFiles.Ask.Whole, NativeFiles.range(null, 1000))
    assertEquals(NativeFiles.Ask.Whole, NativeFiles.range("bytes=-100", 1000))
    assertEquals(NativeFiles.Ask.Unsatisfiable, NativeFiles.range("bytes=1000-", 1000))
    assertEquals(NativeFiles.Ask.Unsatisfiable, NativeFiles.range("bytes=10-5", 1000))
  }
}

class UploadPolicyTest {
  @Test
  fun theNotificationNamesTheOneSourceUploadsGoTo() {
    assertEquals("Caricamento su Mi A2", UploadPolicy.title(listOf("Mi A2")))
    assertEquals("Caricamento", UploadPolicy.title(listOf("Mi A2", "PC")))
    assertEquals("Caricamento", UploadPolicy.title(emptyList()))
    assertEquals("Caricamento", UploadPolicy.title(listOf("")))
  }

  @Test
  fun anUploadRequestTellsItsSource() {
    assertEquals("a1b2c3d4", UploadPolicy.targetOf("/s/a1b2c3d4/api/upload/01.m4a"))
    assertEquals("a1b2c3d4", UploadPolicy.targetOf("/s/a1b2c3d4/api/uploads"))
    assertEquals("a1b2c3d4", UploadPolicy.targetOf("/s/a1b2c3d4/api/uploads/0123456789abcdef"))
    assertNull(UploadPolicy.targetOf("/s/a1b2c3d4/api/stream/t"))
    assertNull(UploadPolicy.targetOf("/s/a1b2c3d4/api/uploadsx"))
    assertNull(UploadPolicy.targetOf(null))
  }
}
