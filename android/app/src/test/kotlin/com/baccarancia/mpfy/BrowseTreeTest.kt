package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A small library as the page sends it: two albums, an artist, a playlist, a like, the recents. */
object Fixture {
  const val SRC_A = "a3435d00"
  const val SRC_B = "08878502"
  const val AL1 = "00000000000000a1"
  const val AL2 = "00000000000000a2"
  const val AR1 = "00000000000000b1"
  const val AR2 = "00000000000000b2"
  const val PL1 = "00000000000000c1"
  fun t(n: Int) = "%024x".format(n)
  fun cover(n: Int) = "c%023x".format(n)

  fun track(n: Int, title: String, artist: String, album: String, trackNo: Int?, versions: List<Map<String, Any?>>) = linkedMapOf(
    "id" to t(n), "t" to title, "a" to artist, "aa" to artist, "al" to album, "n" to trackNo, "d" to 200_000 + n,
    "art" to listOf(SRC_A, cover(n), cover(n + 100)), "v" to versions,
  )

  fun v(src: String, n: Int, f: Int = n, o: Long = 0) = linkedMapOf("s" to src, "tr" to t(n), "f" to t(f), "o" to o)

  fun snapshot(edit: (MutableMap<String, Any?>) -> Unit = {}): MutableMap<String, Any?> {
    val o = linkedMapOf<String, Any?>(
      "format" to "mpfy-browse", "v" to 1, "at" to 1763380000000L,
      "quality" to linkedMapOf("wifi" to "max", "cellular" to "high"),
      "tracks" to listOf(
        track(1, "Last Scene", "NEA", AL1, 1, listOf(v(SRC_A, 1), v(SRC_B, 11, 12, 250))),
        track(2, "Blue Regret", "NEA", AL1, 2, listOf(v(SRC_A, 2))),
        track(3, "Caf\u00e9 del Mar", "Energy 52", AL2, 1, listOf(v(SRC_B, 3))),
        track(4, "Yoru ni Kakeru", "YOASOBI", AL2, 2, listOf(v(SRC_A, 4))),
      ),
      "albums" to listOf(
        linkedMapOf("id" to AL1, "n" to "Blue Regret", "a" to "NEA", "y" to 2026, "art" to listOf(SRC_A, cover(1), cover(101)), "tr" to listOf(t(1), t(2))),
        linkedMapOf("id" to AL2, "n" to "Mix", "a" to "Vari", "y" to null, "art" to null, "tr" to listOf(t(3), t(4))),
      ),
      "artists" to listOf(
        linkedMapOf("id" to AR1, "n" to "NEA", "art" to null, "tr" to listOf(t(2), t(1))),
        linkedMapOf("id" to AR2, "n" to "YOASOBI", "art" to null, "tr" to listOf(t(4))),
      ),
      "playlists" to listOf(linkedMapOf("id" to PL1, "n" to "Auto", "art" to null, "tr" to listOf(t(4), t(1), t(3)))),
      "liked" to listOf(linkedMapOf("id" to t(3), "ids" to listOf(t(3))), linkedMapOf("id" to t(1), "ids" to listOf(t(1), t(11)))),
      "recent" to listOf(linkedMapOf("k" to "playlist", "id" to PL1), linkedMapOf("k" to "liked", "id" to ""), linkedMapOf("k" to "album", "id" to AL2)),
    )
    edit(o)
    return o
  }

  fun text(edit: (MutableMap<String, Any?>) -> Unit = {}) = Json.write(snapshot(edit))

  fun parsed(edit: (MutableMap<String, Any?>) -> Unit = {}) = Snapshot.parse(text(edit))!!

  val labels = Labels("Recenti", "Playlist", "Album", "Artisti", "Mi piace", "Libreria", "1 brano", "%d brani")
}

class BrowseTreeTest {
  private val snap = Fixture.parsed()
  private val tree = BrowseTree(snap, Fixture.labels)
  private fun ids(list: List<Node>?) = list!!.map { it.id }

  @Test
  fun theSnapshotIsReadWithEveryFieldAndWrittenBackTheSame() {
    assertEquals(4, snap.tracks.size)
    val t1 = snap.trackById.getValue(Fixture.t(1))
    assertEquals("Last Scene", t1.title)
    assertEquals(1, t1.trackNo)
    assertEquals(200_001L, t1.durationMs)
    assertEquals(Art(Fixture.SRC_A, Fixture.cover(1), Fixture.cover(101)), t1.art)
    assertEquals(listOf(SnapVersion(Fixture.SRC_A, Fixture.t(1), Fixture.t(1), 0), SnapVersion(Fixture.SRC_B, Fixture.t(11), Fixture.t(12), 250)), t1.versions)
    assertEquals("high", snap.cellular)
    assertEquals(2026, snap.albumById.getValue(Fixture.AL1).year)
    assertNull(snap.albumById.getValue(Fixture.AL2).year)
    val again = Snapshot.parse(snap.toJson())!!
    assertEquals(snap.toJson(), again.toJson())
  }

  @Test
  fun anythingWithoutTheShapeIsRefused() {
    val bad = listOf<(MutableMap<String, Any?>) -> Unit>(
      { it["format"] = "other" },
      { it["v"] = 2 },
      { it.remove("tracks") },
      { it["quality"] = linkedMapOf("wifi" to "auto", "cellular" to "high") },
      { (it["tracks"] as List<MutableMap<String, Any?>>)[0]["id"] = "../etc" },
      { (it["tracks"] as List<MutableMap<String, Any?>>)[0]["d"] = 1.5 },
      { (it["tracks"] as List<MutableMap<String, Any?>>)[0]["art"] = listOf("x", "y") },
      { (it["albums"] as List<MutableMap<String, Any?>>)[0]["tr"] = listOf("NOT HEX") },
      { it["recent"] = listOf(linkedMapOf("k" to "song", "id" to Fixture.t(1))) },
      { it["playlists"] = "none" },
    )
    for ((i, b) in bad.withIndex()) assertNull("case $i", Snapshot.parse(Fixture.text(b)))
    assertNull(Snapshot.parse("{not json"))
    assertNull(Snapshot.parse("[]"))
    assertNotNull(Snapshot.parse(Fixture.text()))
  }

  @Test
  fun theRootHasFiveTabsWithoutALimitAndFourForAndroidAuto() {
    val five = listOf("cat:recent", "cat:playlists", "cat:albums", "cat:artists", "cat:liked")
    assertEquals(five, ids(tree.children("root", null)))
    assertEquals(five, ids(tree.children("root", 5)))
    assertEquals(listOf("cat:recent", "cat:playlists", "cat:liked", "cat:library"), ids(tree.children("root", 4)))
    assertEquals(listOf("cat:recent", "cat:playlists"), ids(tree.children("root", 2)))
    assertEquals(listOf("cat:albums", "cat:artists"), ids(tree.children("cat:library", 4)))
    assertEquals(listOf("Recenti", "Playlist", "Mi piace", "Libreria"), tree.children("root", 4)!!.map { it.title })
    assertEquals(listOf("Album", "Artisti"), tree.children("cat:library", 4)!!.map { it.title })
  }

  @Test
  fun eachCategoryListsItsChildrenWithTheirKinds() {
    assertEquals(listOf("pl:${Fixture.PL1}", "cat:liked", "al:${Fixture.AL2}"), ids(tree.children("cat:recent", null)))
    assertEquals("Mi piace", tree.children("cat:recent", null)!![1].title)
    val pls = tree.children("cat:playlists", null)!!
    assertEquals(listOf("pl:${Fixture.PL1}"), ids(pls))
    assertEquals("3 brani", pls[0].subtitle)
    assertEquals(NodeKind.PLAYLIST, pls[0].kind)
    val albums = tree.children("cat:albums", null)!!
    assertEquals(listOf("al:${Fixture.AL1}", "al:${Fixture.AL2}"), ids(albums))
    assertEquals("NEA", albums[0].subtitle)
    assertEquals(Artwork.contentUri(Fixture.SRC_A, Fixture.cover(1), "large"), albums[0].artUri)
    assertEquals(NodeKind.ALBUM, albums[0].kind)
    assertEquals(listOf("ar:${Fixture.AR1}", "ar:${Fixture.AR2}"), ids(tree.children("cat:artists", null)))
    assertEquals(NodeKind.ARTIST, tree.children("cat:artists", null)!![0].kind)
    assertEquals(listOf("tr:lk::${Fixture.t(3)}", "tr:lk::${Fixture.t(1)}"), ids(tree.children("cat:liked", null)))
    assertEquals(NodeKind.FOLDER_PLAYLISTS, tree.item("cat:playlists")!!.kind)
    assertEquals(NodeKind.FOLDER_ALBUMS, tree.item("cat:albums")!!.kind)
    assertEquals(NodeKind.FOLDER_ARTISTS, tree.item("cat:artists")!!.kind)
    assertEquals(NodeKind.FOLDER_MIXED, tree.item("cat:recent")!!.kind)
  }

  @Test
  fun aOneSongPlaylistSaysOneBrano() {
    val s = Fixture.parsed { o -> (o["playlists"] as List<MutableMap<String, Any?>>)[0]["tr"] = listOf(Fixture.t(2)) }
    assertEquals("1 brano", BrowseTree(s, Fixture.labels).children("cat:playlists", null)!![0].subtitle)
  }

  @Test
  fun groupsListTheirSongsAsPlayableItemsWithSmallArt() {
    val songs = tree.children("al:${Fixture.AL1}", null)!!
    assertEquals(listOf("tr:al:${Fixture.AL1}:${Fixture.t(1)}", "tr:al:${Fixture.AL1}:${Fixture.t(2)}"), ids(songs))
    val s = songs[0]
    assertTrue(s.playable)
    assertEquals(NodeKind.MUSIC, s.kind)
    assertEquals("Last Scene", s.title)
    assertEquals("NEA", s.subtitle)
    assertEquals("Blue Regret", s.album)
    assertEquals(200_001L, s.track!!.durationMs)
    assertEquals(Artwork.contentUri(Fixture.SRC_A, Fixture.cover(101), "small"), s.artUri)
    assertEquals(listOf("tr:ar:${Fixture.AR1}:${Fixture.t(2)}", "tr:ar:${Fixture.AR1}:${Fixture.t(1)}"), ids(tree.children("ar:${Fixture.AR1}", null)))
    assertEquals(3, tree.children("pl:${Fixture.PL1}", null)!!.size)
  }

  @Test
  fun unknownIdsAreRefusedAndEveryKnownIdAnswers() {
    for (bad in listOf("", "cat:songs", "al:zz", "al:${"0".repeat(65)}", "tr:al::${Fixture.t(1)}", "tr:lk:x:${Fixture.t(1)}", "tr:s:123:${Fixture.t(1)}", "tr:xx:${Fixture.AL1}:${Fixture.t(1)}", "al:00000000000000ff")) {
      assertNull(bad, tree.children(bad, null))
    }
    assertNull(tree.item("al:00000000000000ff"))
    assertNull(tree.item("tr:lk::${Fixture.t(99)}"))
    assertNull(tree.item("nope"))
    for (id in listOf("root", "cat:library", "al:${Fixture.AL1}", "ar:${Fixture.AR2}", "pl:${Fixture.PL1}", "tr:pl:${Fixture.PL1}:${Fixture.t(4)}", "tr:s:0123abcd:${Fixture.t(4)}")) {
      assertEquals(id, tree.item(id)!!.id)
    }
    assertEquals("MPfy", tree.item("root")!!.title)
  }

  @Test
  fun aTappedSongQueuesItsContextFromItsPlaceWithGroupIds() {
    val e = tree.expand("tr:pl:${Fixture.PL1}:${Fixture.t(1)}", SearchMemory())!!
    assertEquals(listOf(Fixture.t(4), Fixture.t(1), Fixture.t(3)), e.tracks.map { it.id })
    assertEquals(1, e.start)
    assertEquals(QueueCtx("playlist", Fixture.PL1), e.ctx)
    val al = tree.expand("tr:al:${Fixture.AL1}:${Fixture.t(2)}", SearchMemory())!!
    assertEquals(listOf(Fixture.t(1), Fixture.t(2)), al.tracks.map { it.id })
    assertEquals(1, al.start)
    assertEquals(QueueCtx("album", Fixture.AL1), al.ctx)
    val ar = tree.expand("tr:ar:${Fixture.AR1}:${Fixture.t(1)}", SearchMemory())!!
    assertEquals(1, ar.start)
    assertEquals(QueueCtx("artist", Fixture.AR1), ar.ctx)
    val lk = tree.expand("tr:lk::${Fixture.t(1)}", SearchMemory())!!
    assertEquals(listOf(Fixture.t(3), Fixture.t(1)), lk.tracks.map { it.id })
    assertEquals(1, lk.start)
    assertEquals(QueueCtx("liked", null), lk.ctx)
  }

  @Test
  fun aGoneContextPlaysTheSongAloneAndAGoneSongNothing() {
    val alone = tree.expand("tr:al:00000000000000ff:${Fixture.t(2)}", SearchMemory())!!
    assertEquals(listOf(Fixture.t(2)), alone.tracks.map { it.id })
    assertEquals(0, alone.start)
    assertNull(alone.ctx)
    // The album is there but no longer holds the song.
    assertEquals(listOf(Fixture.t(3)), tree.expand("tr:al:${Fixture.AL1}:${Fixture.t(3)}", SearchMemory())!!.tracks.map { it.id })
    // A search no longer remembered.
    assertEquals(listOf(Fixture.t(4)), tree.expand("tr:s:0123abcd:${Fixture.t(4)}", SearchMemory())!!.tracks.map { it.id })
    assertNull(tree.expand("tr:al:${Fixture.AL1}:${Fixture.t(99)}", SearchMemory()))
    assertNull(tree.expand("al:00000000000000ff", SearchMemory()))
    assertNull(tree.expand("cat:albums", SearchMemory()))
  }

  @Test
  fun aTappedGroupOrTheLikedTabPlaysFromTheStart() {
    val pl = tree.expand("pl:${Fixture.PL1}", SearchMemory())!!
    assertEquals(listOf(Fixture.t(4), Fixture.t(1), Fixture.t(3)), pl.tracks.map { it.id })
    assertEquals(0, pl.start)
    val lk = tree.expand("cat:liked", SearchMemory())!!
    assertEquals(listOf(Fixture.t(3), Fixture.t(1)), lk.tracks.map { it.id })
    assertEquals(QueueCtx("liked", null), lk.ctx)
    assertEquals(QueueCtx("artist", Fixture.AR2), tree.expand("ar:${Fixture.AR2}", SearchMemory())!!.ctx)
  }

  @Test
  fun pagesAreSlicesOfTheList() {
    val all = (1..7).map { Node("x$it", "x", null, NodeKind.MUSIC, null) }
    fun page(p: Int, size: Int): List<String> {
      val from = p.toLong() * size
      if (from >= all.size) return emptyList()
      return all.subList(from.toInt(), minOf(all.size.toLong(), from + size).toInt()).map { it.id }
    }
    assertEquals(listOf("x4", "x5", "x6"), page(1, 3))
    assertEquals(listOf("x7"), page(2, 3))
    assertEquals(emptyList<String>(), page(3, 3))
    assertEquals(7, page(0, Int.MAX_VALUE).size)
  }

  @Test
  fun searchIsNormalizedOrderedByTitleArtistAlbumAndCapped() {
    assertEquals("cafe del mar", Search.norm("  Caf\u00e9   DEL\tMar "))
    assertEquals("e", Search.norm("\u00c9"))
    assertEquals("fi", Search.norm("\ufb01"))
    // "nea": the artist of 1 and 2.
    assertEquals(listOf(Fixture.t(1), Fixture.t(2)), tree.search("NEA").map { it.id })
    // "mix": the album of 3 and 4.
    assertEquals(listOf(Fixture.t(3), Fixture.t(4)), tree.search("mix").map { it.id })
    assertEquals(listOf(Fixture.t(3)), tree.search("cafe").map { it.id })
    assertEquals(emptyList<SnapTrack>(), tree.search("   "))
    val many = Fixture.parsed { o ->
      o["tracks"] = (1..80).map { Fixture.track(it, "Song $it", if (it % 2 == 0) "Song artist" else "X", Fixture.AL1, null, listOf(Fixture.v(Fixture.SRC_A, it))) }
      (o["albums"] as List<MutableMap<String, Any?>>).forEach { it["tr"] = listOf<String>() }
      o["artists"] = listOf<Any?>(); o["playlists"] = listOf<Any?>(); o["liked"] = listOf<Any?>(); o["recent"] = listOf<Any?>()
    }
    val found = BrowseTree(many, Fixture.labels).search("song")
    assertEquals(50, found.size)
    assertEquals(Fixture.t(1), found[0].id)
  }

  @Test
  fun titleMatchesComeBeforeArtistAndAlbumMatches() {
    val s = Fixture.parsed { o ->
      o["tracks"] = listOf(
        Fixture.track(1, "Alpha", "Moon", Fixture.AL2, null, listOf(Fixture.v(Fixture.SRC_A, 1))),
        Fixture.track(2, "Beta", "Gamma", Fixture.AL1, null, listOf(Fixture.v(Fixture.SRC_A, 2))),
        Fixture.track(3, "Moonlight", "Delta", Fixture.AL2, null, listOf(Fixture.v(Fixture.SRC_A, 3))),
      )
      (o["albums"] as List<MutableMap<String, Any?>>)[0]["n"] = "Moon album"
    }
    // 3 by title, 1 by artist, 2 by album ("Moon album" is AL1).
    assertEquals(listOf(Fixture.t(3), Fixture.t(1), Fixture.t(2)), BrowseTree(s, Fixture.labels).search("moon").map { it.id })
  }

  @Test
  fun searchResultsAreRememberedSoATapPlaysAmongThem() {
    val mem = SearchMemory()
    val nodes = tree.searchNodes("Caf\u00e9", mem)
    val hash = Search.hash("cafe")
    assertEquals(hash, Search.hash("  CAF\u00c9 "))
    assertEquals(8, hash.length)
    assertEquals(listOf("tr:s:$hash:${Fixture.t(3)}"), nodes.map { it.id })
    val e = tree.expand(nodes[0].id, mem)!!
    assertEquals(QueueCtx("search", "Caf\u00e9"), e.ctx)
    // Only the last four queries are kept.
    for (q in listOf("a", "b", "c", "d")) tree.searchNodes(q, mem)
    assertNull(mem.get(hash))
  }

  @Test
  fun theSearchHashIsTheSha256OfTheNormalizedQuery() {
    // printf 'cafe' | sha256sum
    assertEquals("a860b858", Search.hash("Caf\u00e9"))
  }

  @Test
  fun versionsGoDownloadedFirstThenUpThenTheRestAtMostFour() {
    val t = SnapTrack(
      Fixture.t(1), "x", "x", "x", "", null, 1, null,
      listOf(
        SnapVersion("s1", "a1", "f1", 0),
        SnapVersion("s2", "a2", "f2", 10),
        SnapVersion("s3", "a3", "f3", 20),
        SnapVersion("s4", "a4", "f4", 30),
        SnapVersion("s5", "a5", "f5", 40),
        SnapVersion("s6", "a6", "f6", 50),
      ),
    )
    val completed = setOf(Levels.key("a5", "f5", "high"), Levels.key("a6", "f6", "max"))
    val up = setOf("s3", "s4")
    val got = CarVersions.order(t, completed) { it in up }
    assertEquals(listOf("s6", "s5", "s3", "s4"), got.map { it.sourceId })
    assertEquals(listOf(50L, 40L, 20L, 30L), got.map { it.offsetMs })
    val none = CarVersions.order(t, emptySet()) { false }
    assertEquals(listOf("s1", "s2", "s3", "s4"), none.map { it.sourceId })
  }

  @Test
  fun aVersionAwayOnACardGoesWithTheDownOnes() {
    val t = SnapTrack(
      Fixture.t(1), "x", "x", "x", "", null, 1, null,
      listOf(
        SnapVersion("s1", "a1", "f1", 0, away = true),
        SnapVersion("s2", "a2", "f2", 10),
        SnapVersion("s3", "a3", "f3", 20),
      ),
    )
    val got = CarVersions.order(t, emptySet()) { it != "s3" }
    assertEquals(listOf("s2", "s1", "s3"), got.map { it.sourceId })
    // A downloaded copy plays whatever the card does.
    val dl = CarVersions.order(t, setOf(Levels.key("a1", "f1", "high"))) { true }
    assertEquals("s1", dl.first().sourceId)
  }

  @Test
  fun theLevelFollowsTheNetwork() {
    assertEquals("high", snap.levelFor("cellular"))
    assertEquals("max", snap.levelFor("wifi"))
    assertEquals("max", snap.levelFor("ethernet"))
    assertEquals("max", snap.levelFor("none"))
  }

  @Test
  fun theLikeMapFollowsThePageAndTheHeartAlsoTheList() {
    val state = BrowseState()
    state.replace(snap)
    assertEquals(listOf(Fixture.t(1), Fixture.t(11)), state.likedOf(Fixture.t(1)))
    state.setLiked(Fixture.t(2), true, listOf(Fixture.t(2)))
    assertEquals(listOf(Fixture.t(2)), state.likedOf(Fixture.t(2)))
    // The page's word changes the map only: the liked tab waits for the next snapshot.
    assertEquals(listOf(Fixture.t(3), Fixture.t(1)), state.snapshot!!.liked.map { it.id })
    state.setLiked(Fixture.t(1), false, emptyList())
    assertNull(state.likedOf(Fixture.t(1)))
    val next = state.likeDone(Fixture.t(4), true, listOf(Fixture.t(4)))!!
    assertEquals(listOf(Fixture.t(4), Fixture.t(3), Fixture.t(1)), next.liked.map { it.id })
    val after = state.likeDone(Fixture.t(3), false, emptyList())!!
    assertEquals(listOf(Fixture.t(4), Fixture.t(1)), after.liked.map { it.id })
    assertEquals(listOf(Fixture.t(4), Fixture.t(1)), Snapshot.parse(after.toJson())!!.liked.map { it.id })
  }

  // The phone's own music in the car: its songs are ordinary songs of the pages, and they play
  // from the file with no core at all.

  private val onlyPhone = Fixture.track(40, "Solo sul telefono", "Solo", Fixture.AL2, 3, listOf(Fixture.v(LocalSource.ID, 40)))
  private val onBoth = Fixture.track(41, "Su tutti e due", "Solo", Fixture.AL2, 4, listOf(Fixture.v(Fixture.SRC_A, 41), Fixture.v(LocalSource.ID, 41)))

  @Test
  fun aSongOfThePhoneIsFoundInAPageOfTheSnapshot() {
    val state = BrowseState()
    assertTrue(state.putPage(Snapshot.parsePage(Pages.pageText(0, listOf(Pages.song(1), onlyPhone, onBoth)))!!))
    state.putIndex(Pages.index(listOf(0)))
    val s = state.snapshot!!
    assertEquals(listOf(SnapVersion(LocalSource.ID, Fixture.t(40), Fixture.t(40), 0)), s.trackById.getValue(Fixture.t(40)).versions)
    assertEquals(listOf(Fixture.SRC_A, LocalSource.ID), s.trackById.getValue(Fixture.t(41)).versions.map { it.sourceId })
    assertEquals(listOf(Fixture.t(40)), BrowseTree(s, Fixture.labels).search("solo sul telefono").map { it.id })
  }

  @Test
  fun theCarPlaysASongOfThePhoneWithTheCoreStoppedThroughTheOpenerAlone() {
    val state = BrowseState()
    assertTrue(state.putPage(Snapshot.parsePage(Pages.pageText(0, listOf(onlyPhone)))!!))
    state.putIndex(Pages.index(listOf(0)))
    val s = state.snapshot!!
    // The core stopped: no source is up; the phone's file is still there.
    val order = CarVersions.order(s.trackById.getValue(Fixture.t(40)), emptySet()) { false }
    assertEquals(listOf(LocalSource.ID), order.map { it.sourceId })
    val dir = java.nio.file.Files.createTempDirectory("mpfy-car").toFile()
    try {
      val bytes = ByteArray(5000) { (it * 3).toByte() }
      java.io.File(dir, Fixture.t(40)).writeBytes(bytes)
      val asked = ArrayList<String>()
      val files = object : LocalFiles {
        override fun open(trackId: String): java.io.FileInputStream? = java.io.File(dir, trackId).takeIf { it.isFile }?.let { java.io.FileInputStream(it) }
      }
      val origin = "http://127.0.0.1:47123"
      val opener = LocalOpener(Opener { url, _ -> asked.add(url); throw java.io.IOException("the core is stopped") }, files, origin)
      val r = opener.open(streamUrl(origin, order[0], s.levelFor("wifi")), requestHeaders(0, -1))
      val out = java.io.ByteArrayOutputStream()
      val buf = ByteArray(1024)
      while (true) {
        val n = r.read(buf, 0, buf.size)
        if (n < 0) break
        out.write(buf, 0, n)
      }
      r.close()
      assertEquals(206, r.status)
      assertTrue(out.toByteArray().contentEquals(bytes))
      assertTrue("nothing went to the core: $asked", asked.isEmpty())
    } finally {
      dir.deleteRecursively()
    }
  }
}
