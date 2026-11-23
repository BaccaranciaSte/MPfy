package com.baccarancia.mpfy

import com.baccarancia.mpfy.Json.list
import com.baccarancia.mpfy.Json.long
import com.baccarancia.mpfy.Json.map
import com.baccarancia.mpfy.Json.str
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The index of the phone's music against a fake MediaStore, fake files and a fake core. */
class LocalIndexTest {
  private val ms = FakeMediaStore()
  private val reader = FakeReader(ms)
  private val folders = FakeFolders()
  private val host = IndexHost()
  private val store = MemoryStore()
  private val main = "external_primary"
  private val card = "1234-abcd"

  private fun index(granted: Boolean = true) = LocalIndex(store, ms, reader, folders, host).also { it.open(granted) }

  private fun scan(ix: LocalIndex) {
    ix.check()
    while (ix.probeNext()) Unit
  }

  private fun id(n: Int) = "%024x".format(n)

  private fun songs(n: Int, volume: String = main, folder: String = "Download/", from: Int = 0): List<Row> =
    (0 until n).map { i -> ms.add(volume, folder, "song ${from + i}.mp3", Content(id(from + i + 1), album = null), added = 1_700_000_000_000 + (from + i) * 1000L) }

  private fun coreIds() = host.core.tracks.keys.toSet()

  @Test
  fun theFirstScanReadsNewestFirstAndFeedsBatchesOfAtMost200() {
    songs(450)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    assertEquals((449 downTo 0).map { "song $it.mp3" }, reader.names())
    host.pump(ix)
    val puts = host.core.messages.filter { it.str("op") == "put" }
    assertTrue(puts.all { it.list("tracks")!!.size <= LocalIndex.MAX_TRACKS })
    assertEquals(3, puts.size)
    assertEquals((1..450).map { id(it) }.toSet(), coreIds())
    assertEquals(0, ix.unsent())
    // The served time is the copy's: DATE_ADDED in ms.
    assertEquals(1_700_000_000_000 + 449_000L, host.core.tracks.getValue(id(450)).long("addedAt"))
  }

  @Test
  fun anUnchangedVersionAndGenerationReadNoRowAtStart() {
    songs(30)
    scan(index())
    ms.resetCounters()
    reader.reads.clear()
    val again = index()
    again.check()
    while (again.probeNext()) Unit
    assertEquals(0, ms.rowsRead)
    assertEquals(0, ms.listings)
    assertEquals(0, ms.idListings)
    assertEquals(0, ms.counts)
    assertTrue(reader.reads.isEmpty())
  }

  @Test
  fun aMovedGenerationProbesOnlyTheChangedRowsAndFindsTheDeletedOnesByTheIdListing() {
    val rows = songs(10)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    ms.resetCounters()
    reader.reads.clear()
    ms.add(main, "Download/", "new.mp3", Content(id(100)))
    ms.rewrite(rows[3], Content(id(103)))
    ms.delete(rows[7])
    scan(ix)
    assertEquals(setOf("new.mp3", "song 3.mp3"), reader.names().toSet())
    assertEquals(2, ms.rowsRead)
    assertEquals(1, ms.idListings)
    host.pump(ix)
    assertEquals((1..10).map { id(it) }.toSet() - id(4) - id(8) + id(100) + id(103), coreIds())
  }

  @Test
  fun withoutGenerationsOneListingGivesTheSameResult() {
    ms.api30 = false
    val rows = songs(10)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    ms.resetCounters()
    reader.reads.clear()
    ms.add(main, "Download/", "new.mp3", Content(id(100)))
    ms.rewrite(rows[3], Content(id(103)))
    ms.delete(rows[7])
    scan(ix)
    assertEquals(setOf("new.mp3", "song 3.mp3"), reader.names().toSet())
    assertEquals(1, ms.listings)
    assertEquals(0, ms.idListings)
    host.pump(ix)
    assertEquals((1..10).map { id(it) }.toSet() - id(4) - id(8) + id(100) + id(103), coreIds())
  }

  @Test
  fun aMovedGenerationWithNothingDeletedReadsNoIdListing() {
    val rows = songs(10)
    val ix = index()
    scan(ix)
    ms.resetCounters()
    ms.add(main, "Download/", "new.mp3", Content(id(100)))
    ms.rewrite(rows[2], Content(id(102)))
    ms.rename(rows[5], "Music/", "renamed.mp3")
    scan(ix)
    assertEquals(1, ms.counts)
    assertEquals(0, ms.idListings)
    ms.delete(rows[1])
    scan(ix)
    assertEquals(1, ms.idListings)
    // A rename keeps the hash: nothing read again for it.
    assertFalse(reader.names().contains("renamed.mp3"))
  }

  @Test
  fun aMediaStoreRebuildListsEverythingReadsNoFileAgainAndKeepsAddedAt() {
    songs(20)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    val before = host.core.tracks.mapValues { it.value.long("addedAt") }
    val sent = host.lines.size
    reader.reads.clear()
    ms.rebuild(main)
    scan(ix)
    host.pump(ix)
    assertTrue(reader.reads.isEmpty())
    assertEquals(before, host.core.tracks.mapValues { it.value.long("addedAt") })
    // Nothing changed for the core: no put, no drop.
    assertTrue(host.ops(sent).none { it == "put" || it == "drop" })
  }

  @Test
  fun aVolumeAwayAndBackDropsItsTracksThenPutsThemWithTheSameIdsAndNoRead() {
    songs(5)
    songs(4, volume = card, folder = "Music/Album/", from = 50)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    assertEquals(9, coreIds().size)
    reader.reads.clear()
    // Unmounted: no audio row changed, only the list of volumes.
    ms.mounted.remove(card)
    scan(ix)
    host.pump(ix)
    assertEquals((1..5).map { id(it) }.toSet(), coreIds())
    ms.mounted.add(card)
    scan(ix)
    host.pump(ix)
    assertEquals((1..5).map { id(it) }.toSet() + (51..54).map { id(it) }, coreIds())
    assertTrue(reader.reads.isEmpty())
  }

  @Test
  fun aMovedFileIsNotReadAgainAndKeepsItsTrack() {
    val rows = songs(3)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    val added = host.core.tracks.getValue(id(2)).long("addedAt")
    reader.reads.clear()
    ms.move(rows[1], "Music/Moved/")
    scan(ix)
    host.pump(ix)
    assertTrue(reader.reads.isEmpty())
    assertEquals((1..3).map { id(it) }.toSet(), coreIds())
    assertEquals(added, host.core.tracks.getValue(id(2)).long("addedAt"))
    assertEquals("Music/Moved/", ix.fileOf(id(2))!!.relPath)
  }

  @Test
  fun aRowLeftProbingBecomesUnreadableAtStartAndIsNotReadAgainUntilItChanges() {
    val rows = songs(3)
    reader.crashOn = rows[1].mediaId
    val ix = index()
    ix.check()
    try {
      while (ix.probeNext()) Unit
    } catch (e: ProcessDeath) {
      // The process ends with the row marked as being read.
    }
    assertEquals(LocalStore.PROBING, store.allFiles().single { it.mediaId == rows[1].mediaId }.state)
    reader.crashOn = null
    reader.reads.clear()
    val after = index()
    scan(after)
    val f = store.allFiles().single { it.mediaId == rows[1].mediaId }
    assertEquals(LocalStore.UNREADABLE, f.state)
    assertEquals(1, f.tries)
    assertFalse(reader.names().contains("song 1.mp3"))
    // Again at the next start: still not read.
    scan(index())
    assertFalse(reader.names().contains("song 1.mp3"))
    // Its bytes change: read again.
    ms.rewrite(rows[1], Content(id(77)))
    scan(after)
    assertTrue(reader.names().contains("song 1.mp3"))
    assertEquals(LocalStore.OK, store.allFiles().single { it.mediaId == rows[1].mediaId }.state)
  }

  @Test
  fun aFileGrowingDuringItsReadGoesBackToNewWithNoResultAndNoTries() {
    val rows = songs(2)
    reader.once[rows[0].mediaId] = Probe.Outcome.CHANGING
    val ix = index()
    scan(ix)
    val f = store.allFiles().single { it.mediaId == rows[0].mediaId }
    assertEquals(LocalStore.NEW, f.state)
    assertEquals(0, f.tries)
    assertNull(f.trackId)
    // Read once in that run, not again until the next check.
    assertEquals(1, reader.names().count { it == "song 0.mp3" })
    ms.rewrite(rows[0], Content(id(1)), size = rows[0].size + 4096)
    scan(ix)
    assertEquals(2, reader.names().count { it == "song 0.mp3" })
    assertEquals(id(1), store.allFiles().single { it.mediaId == rows[0].mediaId }.trackId)
  }

  @Test
  fun aRetagWrittenAsANewFileThenADeleteInTwoChecksKeepsTheOldIdAsAnAlias() {
    val old = ms.add(main, "Music/", "x.mp3", Content(id(1), duration = 200.0))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    // The editor writes the new file first; the old row goes in a later check.
    ms.add(main, "Music/", "x.mp3", Content(id(2), duration = 200.4), size = old.size + 300)
    scan(ix)
    ms.delete(old)
    scan(ix)
    host.pump(ix)
    assertEquals(setOf(id(2)), coreIds())
    assertEquals(listOf(id(1)), host.core.tracks.getValue(id(2)).list("was"))
  }

  @Test
  fun aRetagDeletedFirstThenWrittenInALaterCheckKeepsTheOldIdAsAnAlias() {
    val old = ms.add(main, "Music/", "x.mp3", Content(id(1), duration = 200.0))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    ms.delete(old)
    scan(ix)
    host.pump(ix)
    assertTrue(coreIds().isEmpty())
    host.now += 3_600_000
    ms.add(main, "Music/", "x.mp3", Content(id(2), duration = 199.2), size = old.size + 300)
    scan(ix)
    host.pump(ix)
    assertEquals(listOf(id(1)), host.core.tracks.getValue(id(2)).list("was"))
  }

  @Test
  fun aFileRewrittenInPlaceKeepsItsOldIdsButAnotherSongAtThatPathDoesNot() {
    val r = ms.add(main, "Music/", "x.mp3", Content(id(1), duration = 200.0))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    val r2 = ms.rewrite(r, Content(id(2), duration = 200.0))
    scan(ix)
    ms.rewrite(r2, Content(id(3), duration = 200.5))
    scan(ix)
    host.pump(ix)
    assertEquals(listOf(id(1), id(2)), host.core.tracks.getValue(id(3)).list("was"))
    // Another song written at the same path (another length) is a new track.
    val r3 = ms.row(main, "x.mp3")
    ms.rewrite(r3, Content(id(4), duration = 150.0))
    scan(ix)
    host.pump(ix)
    assertEquals(emptyList<Any>(), host.core.tracks.getValue(id(4)).list("was"))
  }

  @Test
  fun theAliasesStopAtEight() {
    var r = ms.add(main, "Music/", "x.mp3", Content(id(1)))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    for (n in 2..12) {
      r = ms.rewrite(r, Content(id(n)))
      scan(ix)
    }
    host.pump(ix)
    assertEquals((4..11).map { id(it) }, host.core.tracks.getValue(id(12)).list("was"))
  }

  @Test
  fun excludedFoldersAreNeverRead() {
    ms.add(main, "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes/", "PTT-1.opus", Content(id(1)))
    ms.add(main, "Music/Recordings/Call Recordings/", "x.m4a", Content(id(2)))
    ms.add(main, "Ringtones/", "ring.mp3", Content(id(3)))
    ms.add(main, "Download/", "x.mp3", Content(id(4)))
    val ix = index()
    scan(ix)
    assertEquals(listOf("x.mp3"), reader.names())
    // Kept in the cache, so the count of the selection still matches with nothing deleted.
    ms.resetCounters()
    ms.add(main, "Download/", "y.mp3", Content(id(5)))
    scan(ix)
    assertEquals(0, ms.idListings)
  }

  @Test
  fun excludedPathsTable() {
    val out = listOf(
      "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio/",
      "android/data/x/",
      "Music/Recordings/Call Recordings/",
      "Recordings/",
      "Music/Call/",
      "Music/CallRecordings/",
      "Voice Recorder/",
      "Music/VoiceRecorder/",
      "Sound recorder/",
      "Sound_recorder/",
      "Recorder/",
      "Ringtones/",
      "Notifications/",
      "Alarms/",
      "Podcasts/",
      "Audiobooks/",
      "Music/Audiobooks/Some book/",
      "WhatsApp/Media/WhatsApp Audio/",
      "Telegram/Telegram Audio/",
    )
    val kept = listOf("Download/", "Music/", "Music/Album/", "Download/Telegram/", "Music/Recorded live/", "Music/Callas/", "", "Music/WhatsApp hits/", "Bluetooth/")
    for (p in out) assertTrue(p, LocalPolicy.excluded(p))
    for (p in kept) assertFalse(p, LocalPolicy.excluded(p))
  }

  @Test
  fun skippedAndUnreadableFilesHaveNoTrack() {
    ms.add(main, "Download/", "a.amr", Content(id(1), outcome = Probe.Outcome.SKIPPED))
    ms.add(main, "Download/", "b.mp3", Content(id(2), outcome = Probe.Outcome.UNREADABLE))
    ms.add(main, "Download/", "c.mp3", Content(id(3)))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    assertEquals(setOf(id(3)), coreIds())
    reader.reads.clear()
    scan(index())
    assertTrue(reader.reads.isEmpty())
  }

  @Test
  fun twoFilesWithTheSameBytesAreOneTrackUntilBothAreGone() {
    val a = ms.add(main, "Download/", "a.mp3", Content(id(1)), added = 1_000)
    val b = ms.add(main, "Music/", "b.mp3", Content(id(1)), added = 2_000)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    assertEquals("a.mp3", host.core.tracks.getValue(id(1)).str("name"))
    ms.delete(a)
    scan(ix)
    host.pump(ix)
    assertEquals("b.mp3", host.core.tracks.getValue(id(1)).str("name"))
    ms.delete(b)
    scan(ix)
    host.pump(ix)
    assertTrue(coreIds().isEmpty())
  }

  // ------------------------------------------------------------------ the feed

  @Test
  fun anAckMarksFedOnlyTheHashThatWasSent() {
    val r = ms.add(main, "Download/", "a.mp3", Content(id(1)))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    ix.flush()
    val put = host.sent().last { it.str("op") == "put" }
    // Renamed while that batch is in flight: other facts.
    ms.rename(r, "Download/", "b.mp3")
    scan(ix)
    ix.ack(put.str("token"), put.long("batch")!!)
    assertEquals(1, ix.unsent())
    ix.flush()
    val again = host.sent().last { it.str("op") == "put" }
    assertTrue(again !== put)
    assertEquals("b.mp3", (again.list("tracks")!!.single() as Map<*, *>)["name"])
    ix.ack(again.str("token"), again.long("batch")!!)
    assertEquals(0, ix.unsent())
  }

  @Test
  fun aLostAckIsRepairedByHello() {
    songs(3)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.core.acks = false
    host.pump(ix)
    assertEquals(3, coreIds().size)
    assertEquals(3, ix.unsent() + store.allTracks().count { !it.fed })
    ix.disconnect()
    val sent = host.lines.size
    ix.hello(host.core.token, host.core.batch)
    host.core.acks = true
    host.pump(ix)
    // Nothing sent again: the core had it all.
    assertTrue(host.ops(sent).none { it == "put" || it == "reset" })
    assertTrue(store.allTracks().all { it.fed })
  }

  @Test
  fun batchesTheCoreNeverAppliedAreSentAgain() {
    songs(3)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    songs(2, from = 10)
    scan(ix)
    ix.flush()
    // The worklet died before applying that put.
    host.core.applied = host.lines.size
    ix.disconnect()
    ix.hello(host.core.token, host.core.batch)
    host.pump(ix)
    assertEquals(5, coreIds().size)
  }

  @Test
  fun aTokenMismatchSendsResetEveryTrackAndEnd() {
    val rows = songs(5)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    // The core lost its log: it says another token.
    ms.delete(rows[0])
    scan(ix)
    val sent = host.lines.size
    host.core.token = "lost"
    host.core.batch = 0
    ix.disconnect()
    ix.hello("lost", 0)
    host.pump(ix)
    val ops = host.ops(sent).filter { it != "access" && it != "progress" }
    assertEquals("reset", ops.first())
    assertEquals("end", ops.last())
    val m = host.sent(sent).filter { it.str("op") == "put" }
    assertEquals((2..5).map { id(it) }.toSet(), m.flatMap { p -> p.list("tracks")!!.map { (it as Map<*, *>)["id"] } }.toSet())
    assertEquals((2..5).map { id(it) }.toSet(), coreIds())
    assertEquals("0", store.meta("reset_open"))
  }

  @Test
  fun aCrashBetweenResetAndEndSendsEndAgain() {
    songs(4)
    val ix = index()
    scan(ix)
    host.core.acks = false
    ix.hello("other", 3)
    // Everything up to the end is sent, the end itself never reaches the core.
    ix.flush()
    val endAt = host.lines.indexOfFirst { it.contains("\"op\":\"end\"") }
    while (host.core.applied < (if (endAt >= 0) endAt else host.lines.size)) {
      val m = host.sent(host.core.applied).first()
      host.core.applied++
      host.core.apply(m)
    }
    host.lines.subList(host.core.applied, host.lines.size).clear()
    assertEquals("1", store.meta("reset_open"))
    // A new worklet: the same token, every put applied, but no end.
    ix.disconnect()
    host.core.acks = true
    val sent = host.lines.size
    ix.hello(host.core.token, host.core.batch)
    host.pump(ix)
    assertEquals(listOf("end"), host.ops(sent).filter { it != "access" && it != "progress" })
    assertEquals("0", store.meta("reset_open"))
  }

  @Test
  fun aPutIsCutByItsBytesAndNotOnlyByItsCount() {
    for (i in 0 until 200) ms.add(main, "Download/", "s$i.mp3", Content(id(i + 1), lyricsBytes = 64 * 1024 - 100), added = i.toLong())
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    val puts = host.lines.filter { it.contains("\"op\":\"put\"") }
    assertTrue(puts.size > 1)
    for (p in puts) assertTrue("a put of ${p.toByteArray().size} bytes", p.toByteArray().size <= LocalIndex.MAX_PUT_BYTES)
    assertEquals(200, coreIds().size)
    // The lyrics reach the core; the cache's rows keep them apart from their facts.
    assertEquals(1, host.core.tracks.getValue(id(1)).map("lyrics")!!.list("texts")!!.size)
    assertTrue(store.allFiles().none { it.facts!!.contains("lyrics") })
  }

  @Test
  fun aTrackLargerThanAPutGoesAlone() {
    ms.add(main, "Download/", "big.mp3", Content(id(1), lyricsBytes = 300 * 1024), added = 2)
    ms.add(main, "Download/", "small.mp3", Content(id(2)), added = 1)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    val puts = host.core.messages.filter { it.str("op") == "put" }
    assertEquals(listOf(1, 1), puts.map { it.list("tracks")!!.size })
    assertEquals(2, coreIds().size)
  }

  @Test
  fun noMoreThanAFewBatchesWaitForTheirAck() {
    songs(1000)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.core.acks = false
    ix.flush()
    ix.flush()
    assertEquals(LocalIndex.WINDOW, host.ops().count { it == "put" || it == "drop" || it == "end" })
  }

  @Test
  fun accessAndProgressAreToldAfterHello() {
    songs(3)
    val ix = index()
    ix.check()
    ix.hello(null, 0)
    val first = host.sent().filter { it.str("op") == "access" || it.str("op") == "progress" }
    assertEquals(true, first.first { it.str("op") == "access" }["granted"])
    assertEquals(3L, first.first { it.str("op") == "progress" }.long("pending"))
    while (ix.probeNext()) Unit
    host.pump(ix)
    assertEquals(0L, host.sent().last { it.str("op") == "progress" }.long("pending"))
  }

  // ------------------------------------------------------------------ permission

  @Test
  fun aRevokedPermissionDropsEveryTrackAndAGrantBringsThemBackWithNoRead() {
    songs(4)
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    reader.reads.clear()
    // Android ends the process on a revoke: the next start has no permission.
    val off = index(granted = false)
    off.hello(host.core.token, host.core.batch)
    host.pump(off)
    assertTrue(coreIds().isEmpty())
    assertEquals(false, host.sent().last { it.str("op") == "access" }["granted"])
    off.setAccess(true)
    scan(off)
    host.pump(off)
    assertEquals((1..4).map { id(it) }.toSet(), coreIds())
    assertTrue(reader.reads.isEmpty())
  }

  @Test
  fun theIndexIsKeptForThirtyDaysWithoutThePermission() {
    val day = 86_400_000L
    assertTrue(LocalWork.keepIndex(null, 1000))
    assertTrue(LocalWork.keepIndex(0, 29 * day))
    assertFalse(LocalWork.keepIndex(0, 30 * day))
  }

  // ------------------------------------------------------------------ gone rows and art

  @Test
  fun goneRowsLeaveAfterADayAndTheirArtAfterTheDropIsAcked() {
    val r = ms.add(main, "Download/", "a.mp3", Content(id(1), cover = "c".repeat(24)))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    ms.delete(r)
    scan(ix)
    host.pump(ix)
    assertTrue(coreIds().isEmpty())
    // Kept a day for a retag that writes a new file: its art too.
    assertTrue(host.dropped.isEmpty())
    host.now += 25 * 3_600_000L
    scan(ix)
    assertEquals(listOf("c".repeat(24)), host.dropped)
    assertTrue(store.allFiles().isEmpty())
  }

  @Test
  fun artStaysWhileAnotherFileNamesIt() {
    val pic = "d".repeat(24)
    val a = ms.add(main, "Download/", "a.mp3", Content(id(1), cover = pic))
    ms.add(main, "Download/", "b.mp3", Content(id(2), cover = pic))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    ms.delete(a)
    scan(ix)
    host.pump(ix)
    host.now += 25 * 3_600_000L
    scan(ix)
    host.pump(ix)
    assertTrue(host.dropped.isEmpty())
  }

  // ------------------------------------------------------------------ folder art

  @Test
  fun noFolderArtIsAskedInAFolderThatIsNotAnAlbumFolder() {
    // Mixed: audio of several albums and photos, the folder a chat app fills.
    ms.add(main, "Download/Telegram/", "a.mp3", Content(id(1), album = "One"))
    ms.add(main, "Download/Telegram/", "b.mp3", Content(id(2), album = "Two"))
    ms.add(main, "Download/Telegram/", "c.mp3", Content(id(3), album = null))
    // One song alone in its folder.
    ms.add(main, "Music/Single/", "d.mp3", Content(id(4), album = "Three"))
    // An album folder where one song has no album tag.
    ms.add(main, "Music/Mixed/", "e.mp3", Content(id(5), album = "Four"))
    ms.add(main, "Music/Mixed/", "f.mp3", Content(id(6), album = null))
    val ix = index()
    scan(ix)
    assertTrue(folders.asked.toString(), folders.asked.isEmpty())
  }

  @Test
  fun anAlbumFolderGetsItsFolderArtOncePerCheckForTheSongsWithoutPictures() {
    val pic = "e".repeat(24)
    folders.covers["Music/Album/"] = pic
    ms.add(main, "Music/Album/", "1.mp3", Content(id(1), album = "Same"))
    ms.add(main, "Music/Album/", "2.mp3", Content(id(2), album = "Same"))
    ms.add(main, "Music/Album/", "3.mp3", Content(id(3), album = "Same", cover = "f".repeat(24)))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    assertEquals(listOf("Music/Album/"), folders.asked)
    assertEquals(pic, host.core.tracks.getValue(id(1)).str("coverId"))
    assertEquals(pic, host.core.tracks.getValue(id(2)).str("coverId"))
    assertEquals("f".repeat(24), host.core.tracks.getValue(id(3)).str("coverId"))
    // Nothing touched the folder: not asked again.
    scan(ix)
    assertEquals(1, folders.asked.size)
    // A song of another album joins the folder: no longer an album folder, the folder art goes.
    ms.add(main, "Music/Album/", "4.mp3", Content(id(4), album = "Other"))
    scan(ix)
    host.pump(ix)
    assertNull(host.core.tracks.getValue(id(1)).str("coverId"))
    assertEquals(1, folders.asked.size)
  }

  // ------------------------------------------------------------------ when the work runs

  private fun work(granted: Boolean = true): Pair<LocalIndex, LocalWork> {
    val ix = LocalIndex(store, ms, reader, folders, host)
    val sched = FakeScheduler(host)
    val w = LocalWork(ix, sched)
    w.start(granted)
    this.sched = sched
    return ix to w
  }

  private lateinit var sched: FakeScheduler

  private fun resumeReadsNoRow() {
    songs(5)
    val (_, w) = work()
    sched.run()
    assertEquals(5, reader.reads.size)
    ms.resetCounters()
    w.onAwake(false)
    sched.advance(60_000)
    w.onAwake(true)
    sched.advance(60_000)
    assertEquals(0, ms.binderCalls)
    assertEquals(0, ms.rowsRead)
    // A change while suspended: checked at the resume, not before.
    w.onAwake(false)
    w.onMediaChange()
    sched.advance(60_000)
    assertEquals(0, ms.binderCalls)
    w.onAwake(true)
    sched.advance(3_000)
    assertTrue(ms.binderCalls > 0)
  }

  @Test
  fun aResumeWithNothingMarkedReadsNoRow() = resumeReadsNoRow()

  @Test
  fun aResumeWithNothingMarkedReadsNoRowWithoutGenerations() {
    ms.api30 = false
    resumeReadsNoRow()
  }

  @Test
  fun aBurstOfChangesIsOneCheckTwoSecondsAfterTheLastAndAtMostTenAfterTheFirst() {
    songs(2)
    val (_, w) = work()
    sched.run()
    ms.resetCounters()
    repeat(50) {
      w.onMediaChange()
      sched.advance(20)
    }
    assertEquals(0, ms.binderCalls)
    sched.advance(2_000)
    val one = ms.binderCalls
    assertTrue(one > 0)
    sched.advance(30_000)
    assertEquals(one, ms.binderCalls)
    // Changes every second for 30 s: checks at most every 10 s, not once at the end.
    ms.resetCounters()
    var checks = 0
    var last = 0
    repeat(30) {
      w.onMediaChange()
      sched.advance(1_000)
      if (ms.binderCalls != last) {
        checks++
        last = ms.binderCalls
      }
    }
    assertTrue("checks: $checks", checks in 2..4)
  }

  @Test
  fun aSuspendedWorkletPausesTheReadsAfterTheFileItIsOn() {
    songs(10)
    lateinit var w: LocalWork
    reader.onRead = { if (reader.reads.size == 3) w.onAwake(false) }
    w = work().second
    sched.advance(60_000)
    assertEquals(3, reader.reads.size)
    w.onAwake(true)
    sched.advance(60_000)
    assertEquals(10, reader.reads.size)
  }

  @Test
  fun nothingRunsWithoutThePermissionOrAtRest() {
    songs(3)
    val (_, w) = work(granted = false)
    sched.advance(600_000)
    assertEquals(0, ms.binderCalls)
    assertTrue(reader.reads.isEmpty())
    w.onAccess(true)
    sched.advance(60_000)
    assertEquals(3, reader.reads.size)
    // At rest: no timer left.
    assertEquals(0, sched.waiting())
  }

  @Test
  fun theFeedGoesOutWhileFilesAreRead() {
    songs(450)
    var linesAtLastRead = -1
    // Reading a file takes 50 ms.
    reader.onRead = {
      host.now += 50
      if (reader.reads.size == 450) linesAtLastRead = host.lines.size
    }
    val (ix, w) = work()
    w.onHello(null, 0)
    sched.advance(60_000)
    val early = host.lines.take(linesAtLastRead).filter { it.contains("\"op\":\"put\"") }
    assertTrue(early.isNotEmpty())
    // The first songs went out on the two-second clock, not after 200 of them.
    assertTrue((Json.obj(early.first())!!.list("tracks")!!.size) < LocalIndex.MAX_TRACKS)
    host.pump(ix)
    assertEquals(450, coreIds().size)
  }

  @Test
  fun anIndexFromBeforeTheLengthRuleDropsItsShortRowsAtTheNextCheckReadingOnlyTheRowsOfUnknownLength() {
    ms.add(main, "Music/", "song.mp3", Content(id(1)))
    ms.add(main, "Music/", "ai_command.wav", Content(id(2), duration = 1.9))
    ms.add(main, "VoiceModel/", "sample 1.wav", Content(id(3), duration = 8.4))
    ms.add(main, "Download/", "beep.mp3", Content(id(4), duration = 6.0))
    ms.add(main, "Music/", "live.flac", Content(id(5), duration = null))
    val zero = ms.add(main, "VoiceModel/", "sample 2.wav", Content(id(6), duration = null))
    val ix = index()
    ix.hello(null, 0)
    scan(ix)
    host.pump(ix)
    // An index made before the rule (the fake reader has no rule of its own): every row a track,
    // and no mark of the rule in the cache (the key is kept on the phones: never renamed).
    store.setMeta("short_rule", null)
    assertEquals((1..6).map { id(it) }.toSet(), coreIds())
    reader.reads.clear()
    ms.resetCounters()
    // Read again, the platform says 0 for this one: the probe skips it.
    reader.once[zero.mediaId] = Probe.Outcome.SKIPPED
    scan(ix)
    host.pump(ix)
    // The short ones go without a read; only the two of unknown length are read again.
    assertEquals(setOf("live.flac", "sample 2.wav"), reader.names().toSet())
    assertEquals(0, ms.rowsRead)
    assertEquals(setOf(id(1), id(5)), coreIds())
    assertEquals(LocalStore.SKIPPED, store.allFiles().single { it.name == "beep.mp3" }.state)
    // Once: the next check reads nothing more.
    reader.reads.clear()
    scan(ix)
    assertTrue(reader.reads.isEmpty())
    assertEquals(setOf(id(1), id(5)), coreIds())
  }
}
