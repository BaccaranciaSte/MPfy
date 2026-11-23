package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.zip.GZIPInputStream

/** The car's library in pages (bridge 7): pages and an index as the page sends them. */
object Pages {
  fun hash(n: Int) = "%016x".format(0x1234L * (n + 1))

  /** Song k of the test library: its title says its number, two albums by parity. */
  fun song(k: Int, title: String = "Song $k") =
    Fixture.track(k, title, if (k % 3 == 0) "Trio" else "Solo", if (k % 2 == 0) Fixture.AL1 else Fixture.AL2, null, listOf(Fixture.v(Fixture.SRC_A, k)))

  fun pageText(n: Int, songs: List<Map<String, Any?>>, h: String = hash(n)) =
    Json.write(linkedMapOf("format" to "mpfy-browse-page", "v" to 1, "n" to n, "h" to h, "tracks" to songs))

  fun page(n: Int, ks: IntRange, h: String = hash(n)) = Snapshot.parsePage(pageText(n, ks.map { song(it) }, h))!!

  fun indexMap(pages: List<Int>, edit: (MutableMap<String, Any?>) -> Unit = {}): MutableMap<String, Any?> {
    val o = linkedMapOf<String, Any?>(
      "format" to "mpfy-browse-index", "v" to 1, "at" to 1763380000000L, "h" to "00000000000000ab",
      "quality" to linkedMapOf("wifi" to "max", "cellular" to "high"),
      "pages" to pages,
      "albums" to listOf(
        linkedMapOf("id" to Fixture.AL1, "n" to "Pari", "a" to "Solo", "y" to 2026, "art" to null, "tr" to listOf(Fixture.t(2), Fixture.t(4))),
        linkedMapOf("id" to Fixture.AL2, "n" to "Dispari", "a" to "Solo", "y" to null, "art" to null, "tr" to listOf(Fixture.t(1), Fixture.t(25))),
      ),
      "artists" to listOf(linkedMapOf("id" to Fixture.AR1, "n" to "Trio", "art" to null, "tr" to listOf(Fixture.t(3), Fixture.t(24)))),
      "playlists" to listOf(linkedMapOf("id" to Fixture.PL1, "n" to "Auto", "art" to null, "tr" to listOf(Fixture.t(25), Fixture.t(1), Fixture.t(12)))),
      "liked" to listOf(linkedMapOf("id" to Fixture.t(12), "ids" to listOf(Fixture.t(12)))),
      "recent" to listOf(linkedMapOf("k" to "playlist", "id" to Fixture.PL1)),
    )
    edit(o)
    return o
  }

  fun index(pages: List<Int>, edit: (MutableMap<String, Any?>) -> Unit = {}) = Snapshot.parseIndex(Json.write(indexMap(pages, edit)))!!

  /** Songs 1 to 30 in three pages of ten: slots 0, 1 and 2. */
  fun three(state: BrowseState = BrowseState()): BrowseState {
    assertTrue(state.putPage(page(0, 1..10)))
    assertTrue(state.putPage(page(1, 11..20)))
    assertTrue(state.putPage(page(2, 21..30)))
    state.putIndex(index(listOf(0, 1, 2)))
    return state
  }
}

class BrowsePagesTest {
  private fun ids(s: Snapshot) = s.tracks.map { it.id }

  @Test
  fun pagesAndAnIndexMakeTheLibraryInTheIndexOrder() {
    val state = Pages.three()
    val s = state.snapshot!!
    assertTrue(s.paged)
    assertEquals((1..30).map { Fixture.t(it) }, ids(s))
    assertEquals(30, s.tracks.size)
    assertEquals(Fixture.t(17), s.tracks[16].id)
    assertEquals(listOf(0, 1, 2), s.pages.map { it.n })
    for (k in 1..30) assertEquals("Song $k", s.trackById.getValue(Fixture.t(k)).title)
    assertEquals("high", s.levelFor("cellular"))
    // Another order of the pages: the songs follow it.
    state.putIndex(Pages.index(listOf(2, 0, 1)))
    assertEquals((21..30).map { Fixture.t(it) } + (1..20).map { Fixture.t(it) }, ids(state.snapshot!!))
  }

  @Test
  fun aSongIsFoundBySearchOnAnyPage() {
    val state = Pages.three()
    val tree = BrowseTree(state.snapshot!!, Fixture.labels)
    for (k in listOf(1, 10, 11, 20, 21, 30)) assertEquals("song $k", listOf(Fixture.t(k)), tree.search("Song $k").filter { it.title == "Song $k" }.map { it.id })
    // "song 2": 2 and 20 to 29 by title, in library order across the pages.
    assertEquals(listOf(2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29).map { Fixture.t(it) }, tree.search("song 2").map { it.id })
    // By artist, then by album, from every page.
    assertEquals((1..30).filter { it % 3 == 0 }.map { Fixture.t(it) }, tree.search("trio").map { it.id })
    assertEquals((1..30).filter { it % 2 == 1 }.map { Fixture.t(it) }, tree.search("dispari").map { it.id })
    // A tapped result plays among the results, wherever their pages are.
    val mem = SearchMemory()
    val nodes = tree.searchNodes("trio", mem)
    val e = tree.expand(nodes[5].id, mem)!!
    assertEquals(10, e.tracks.size)
    assertEquals(5, e.start)
    assertEquals(Fixture.t(18), e.tracks[5].id)
  }

  @Test
  fun aPageIsReplacedAlone() {
    val state = Pages.three()
    val before = state.snapshot!!
    // Page 1 again: 11 renamed, 15 gone, 31 new.
    val songs = (11..20).filter { it != 15 }.map { if (it == 11) Pages.song(11, "Undici") else Pages.song(it) } + Pages.song(31)
    assertTrue(state.putPage(Snapshot.parsePage(Pages.pageText(1, songs, "00000000000000f1"))!!))
    val after = state.snapshot!!
    assertSame(before.pages[0], after.pages[0])
    assertSame(before.pages[2], after.pages[2])
    assertEquals("00000000000000f1", after.pages[1].hash)
    // The other pages' songs are found as the objects those pages hold (the lookup is the
    // state's own, so it is read against the pages, not against the snapshot of before).
    for (k in 1..10) assertSame(before.pages[0].tracks[k - 1], after.trackById[Fixture.t(k)])
    for (k in 21..30) assertSame(before.pages[2].tracks[k - 21], after.trackById[Fixture.t(k)])
    assertEquals("Undici", after.trackById.getValue(Fixture.t(11)).title)
    assertNull(after.trackById[Fixture.t(15)])
    assertNotNull(after.trackById[Fixture.t(31)])
    assertEquals((1..10).map { Fixture.t(it) } + songs.map { it["id"] } + (21..30).map { Fixture.t(it) }, ids(after))
    // Search reads the new page.
    val tree = BrowseTree(after, Fixture.labels)
    assertEquals(listOf("Undici"), tree.search("undici").map { it.title })
    assertTrue(tree.search("song 15").none { it.title == "Song 15" })
    // The index stays: the groups are the same objects.
    assertSame(before.index, after.index)
  }

  @Test
  fun aSongMovingBetweenTwoPagesIsFoundOnceBothCame() {
    for (newFirst in listOf(true, false)) {
      val state = Pages.three()
      // Song 10 moves from page 0 to the head of page 1.
      val p0 = Pages.page(0, 1..9, "00000000000000a0")
      val p1 = Snapshot.parsePage(Pages.pageText(1, (10..20).map { Pages.song(it) }, "00000000000000a1"))!!
      if (newFirst) {
        state.putPage(p1)
        state.putPage(p0)
      } else {
        state.putPage(p0)
        state.putPage(p1)
      }
      val s = state.snapshot!!
      assertSame("new page first: $newFirst", p1.tracks[0], s.trackById[Fixture.t(10)])
      assertEquals((1..30).map { Fixture.t(it) }, ids(s))
    }
  }

  @Test
  fun aPageWaitsForAnIndexThatNamesItAndAnIndexDropsThePagesItDoesNotName() {
    val state = Pages.three()
    // A new slot (page 0 cut in two): not shown before its index.
    assertTrue(state.putPage(Pages.page(0, 1..5, "00000000000000b0")))
    assertTrue(state.putPage(Pages.page(5, 6..10, "00000000000000b5")))
    assertEquals((1..5).map { Fixture.t(it) } + (11..30).map { Fixture.t(it) }, ids(state.snapshot!!))
    // The index names it after page 0 and leaves page 2 out.
    val gone = state.putIndex(Pages.index(listOf(0, 5, 1)))
    assertEquals(listOf(2), gone)
    val s = state.snapshot!!
    assertEquals((1..20).map { Fixture.t(it) }, ids(s))
    assertNull(s.trackById[Fixture.t(25)])
    // The playlist and the album skip the songs that went; the liked tab keeps the one here.
    val tree = BrowseTree(s, Fixture.labels)
    assertEquals(listOf(Fixture.t(1), Fixture.t(12)), tree.children("pl:${Fixture.PL1}", null)!!.map { it.track!!.id })
    assertEquals(listOf("tr:lk::${Fixture.t(12)}"), tree.children("cat:liked", null)!!.map { it.id })
    // A page the index names that never came: nothing of it, nothing broken.
    state.putIndex(Pages.index(listOf(0, 5, 1, 9)))
    assertEquals(20, state.snapshot!!.tracks.size)
  }

  @Test
  fun theAppSaysWhatItHoldsInTheIndexOrder() {
    val state = BrowseState()
    assertEquals("""{"index":null,"pages":[]}""", state.held())
    Pages.three(state)
    state.putIndex(Pages.index(listOf(2, 0, 1)))
    val held = Json.obj(state.held())!!
    assertEquals("00000000000000ab", held["index"])
    @Suppress("UNCHECKED_CAST")
    val pages = held["pages"] as List<Map<String, Any?>>
    assertEquals(listOf(2L, 0L, 1L), pages.map { it["n"] })
    assertEquals(listOf(Pages.hash(2), Pages.hash(0), Pages.hash(1)), pages.map { it["h"] })
    assertEquals(listOf(Fixture.t(21), Fixture.t(1), Fixture.t(11)), pages.map { it["first"] })
    // A page waiting for its index is not said: the page sends it again with the index.
    state.putPage(Pages.page(7, 31..32))
    assertEquals(3, (Json.obj(state.held())!!["pages"] as List<*>).size)
  }

  @Test
  fun theHeartChangesTheIndexWhichSaysItChangedHere() {
    val state = Pages.three()
    val s = state.likeDone(Fixture.t(25), true, listOf(Fixture.t(25)))!!
    assertTrue(s.paged)
    assertEquals(listOf(Fixture.t(25), Fixture.t(12)), s.liked.map { it.id })
    assertEquals("", s.index.hash)
    assertEquals("", Json.obj(state.held())!!["index"])
    // Written as an index, read back the same.
    val back = Snapshot.parseIndex(s.index.toJson())!!
    assertEquals(listOf(0, 1, 2), back.pages)
    assertEquals(listOf(Fixture.t(25), Fixture.t(12)), back.liked.map { it.id })
    assertEquals(s.index.toJson(), back.toJson())
    // A page after the heart keeps the like.
    state.putPage(Pages.page(1, 11..20, "00000000000000c1"))
    assertEquals(listOf(Fixture.t(25), Fixture.t(12)), state.snapshot!!.liked.map { it.id })
    assertEquals(listOf(Fixture.t(25)), state.likedOf(Fixture.t(25)))
  }

  @Test
  fun bridgeFourSnapshotsAreStillReadAndReplaceThePages() {
    val state = Pages.three()
    val whole = Fixture.parsed()
    assertFalse(whole.paged)
    assertEquals(1, whole.pages.size)
    state.replace(whole)
    val s = state.snapshot!!
    assertSame(whole, s)
    assertEquals(4, s.tracks.size)
    assertNull(s.trackById[Fixture.t(20)])
    assertEquals("""{"index":null,"pages":[]}""", state.held())
    // The heart on a whole snapshot writes a whole snapshot.
    val liked = state.likeDone(Fixture.t(4), true, listOf(Fixture.t(4)))!!
    assertFalse(liked.paged)
    assertNotNull(Snapshot.parse(liked.toJson()))
    // Pages after it: shown once their index comes.
    state.putPage(Pages.page(0, 1..10))
    assertSame(liked, state.snapshot)
    state.putIndex(Pages.index(listOf(0)))
    assertEquals((1..10).map { Fixture.t(it) }, ids(state.snapshot!!))
  }

  @Test
  fun aPagedSnapshotAnswersAsTheWholeOneWithTheSameSongs() {
    val songs = (1..30).map { Pages.song(it) }
    val o = Pages.indexMap(emptyList())
    o["format"] = "mpfy-browse"
    o.remove("h")
    o.remove("pages")
    val wholeMap = linkedMapOf<String, Any?>()
    for ((k, v) in o) {
      wholeMap[k] = v
      if (k == "quality") wholeMap["tracks"] = songs
    }
    val whole = BrowseTree(Snapshot.parse(Json.write(wholeMap))!!, Fixture.labels)
    val paged = BrowseTree(Pages.three().snapshot!!, Fixture.labels)
    for (id in listOf("root", "cat:recent", "cat:playlists", "cat:albums", "cat:artists", "cat:liked", "al:${Fixture.AL1}", "al:${Fixture.AL2}", "ar:${Fixture.AR1}", "pl:${Fixture.PL1}")) {
      assertEquals(id, whole.children(id, null), paged.children(id, null))
      assertEquals(id, whole.item(id), paged.item(id))
    }
    for (q in listOf("song 1", "trio", "pari", "dispari", "solo")) assertEquals(q, whole.search(q), paged.search(q))
    for (id in listOf("tr:pl:${Fixture.PL1}:${Fixture.t(12)}", "tr:al:${Fixture.AL2}:${Fixture.t(25)}", "cat:liked", "pl:${Fixture.PL1}")) {
      assertEquals(id, whole.expand(id, SearchMemory()), paged.expand(id, SearchMemory()))
    }
  }

  @Test
  fun pagesAndIndexesWithoutTheirShapeAreRefused() {
    val ok = (1..3).map { Pages.song(it) }
    assertNotNull(Snapshot.parsePage(Pages.pageText(255, ok)))
    val bad = listOf(
      Pages.pageText(256, ok),
      Pages.pageText(-1, ok),
      Pages.pageText(0, emptyList()),
      Pages.pageText(0, (1..2001).map { Pages.song(it) }),
      Pages.pageText(0, ok, "not hex"),
      Pages.pageText(0, ok).replace("mpfy-browse-page", "mpfy-browse"),
      Pages.pageText(0, ok).replace("\"v\":1", "\"v\":2"),
      Pages.pageText(0, ok).replace("\"n\":0", "\"n\":\"0\""),
      Pages.pageText(0, listOf(Pages.song(1) + ("id" to "../etc"))),
    )
    for ((i, b) in bad.withIndex()) assertNull("page $i", Snapshot.parsePage(b))
    assertNotNull(Snapshot.parseIndex(Json.write(Pages.indexMap(listOf(0, 1)) { it["h"] = "" })))
    val badIndexes = listOf<(MutableMap<String, Any?>) -> Unit>(
      { it["pages"] = listOf(0, 0) },
      { it["pages"] = listOf(256) },
      { it["pages"] = listOf("0") },
      { it.remove("pages") },
      { it["h"] = "XYZ" },
      { it.remove("h") },
      { it["format"] = "mpfy-browse" },
      { it["quality"] = linkedMapOf("wifi" to "auto", "cellular" to "high") },
      { it["recent"] = listOf(linkedMapOf("k" to "song", "id" to Fixture.t(1))) },
    )
    for ((i, b) in badIndexes.withIndex()) assertNull("index $i", Snapshot.parseIndex(Json.write(Pages.indexMap(listOf(0, 1), b))))
    // A whole snapshot is not a page and a page is not a whole snapshot.
    assertNull(Snapshot.parsePage(Fixture.text()))
    assertNull(Snapshot.parse(Pages.pageText(0, ok)))
  }

  @Test
  fun theCarHoldsAtMostItsSongs() {
    val state = BrowseState(maxTracks = 25)
    Pages.three(state)
    // Shown: the pages in order while they fit.
    assertEquals((1..20).map { Fixture.t(it) }, ids(state.snapshot!!))
    // Held: at most twice as many (old and new pages while the page moves them).
    assertTrue(state.putPage(Pages.page(3, 31..50)))
    assertFalse(state.putPage(Pages.page(4, 51..52)))
    assertNull(state.snapshot!!.trackById[Fixture.t(51)])
    // Replacing a page counts only the difference.
    assertTrue(state.putPage(Pages.page(3, 31..40)))
  }

  @Test
  fun twentyThousandSongsInTenPagesAreAllFound() {
    val state = BrowseState()
    val began = System.nanoTime()
    for (n in 0 until 10) assertTrue(state.putPage(Snapshot.parsePage(Pages.pageText(n, (n * 2000 + 1..n * 2000 + 2000).map { Pages.song(it) }))!!))
    state.putIndex(Pages.index((0 until 10).toList()))
    val ms = (System.nanoTime() - began) / 1_000_000
    val s = state.snapshot!!
    assertEquals(20_000, s.tracks.size)
    for (k in listOf(1, 2000, 2001, 9999, 20_000)) assertEquals("Song $k", s.trackById.getValue(Fixture.t(k)).title)
    assertEquals(listOf(Fixture.t(19_999)), BrowseTree(s, Fixture.labels).search("song 19999").map { it.id })
    println("20000 songs in 10 pages parsed and held in $ms ms")
  }

  @Test
  fun theTextsThePageWritesAreRead() {
    // Written by web/js/browse.js through web/dev/browse-pages.mjs --fixtures (gzipped).
    val dir = listOf(File("src/test/resources/browse"), File("app/src/test/resources/browse")).first { it.isDirectory }
    fun text(name: String) = GZIPInputStream(File(dir, "$name.json.gz").inputStream()).bufferedReader().use { it.readText() }
    val index = Snapshot.parseIndex(text("index"))!!
    val state = BrowseState()
    for (n in index.pages) assertTrue(state.putPage(Snapshot.parsePage(text("page-$n"))!!))
    state.putIndex(index)
    val whole = Snapshot.parse(text("whole"))!!
    val s = state.snapshot!!
    assertEquals(whole.tracks, s.tracks)
    assertEquals(whole.albums, s.albums)
    assertEquals(whole.artists, s.artists)
    assertEquals(whole.playlists, s.playlists)
    assertEquals(whole.liked, s.liked)
    assertEquals(whole.recent, s.recent)
    assertEquals(whole.wifi to whole.cellular, s.wifi to s.cellular)
    assertTrue(index.pages.size > 1)
  }
}
