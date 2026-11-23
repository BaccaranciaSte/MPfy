package com.baccarancia.mpfy

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A player's list as ExoPlayer keeps it, items by identity: adding or removing items before the
 * one playing moves its index; removing the one playing loses it (the player moves on, or ends).
 */
internal class ListPlayer(ids: List<String>, current: Int, override val canGoOn: Boolean = true) : PageQueue.Target<ListPlayer.Item> {
  class Item(val id: String) {
    override fun toString() = id
  }

  val items: MutableList<Item> = ids.map { Item(it) }.toMutableList()
  override var current: Int = current
    private set

  /** The item playing went with a removal. */
  var lost = false
  var loads = 0
  var loadedPositionMs = -1L
  var play: Boolean? = null
  var wentOn: Item? = null

  val ids: List<String> get() = items.map { it.id }
  val playing: Item? get() = items.getOrNull(current)

  override val count: Int get() = items.size

  override fun idAt(index: Int): String = items[index].id

  override fun clear() {
    items.clear()
    current = -1
  }

  override fun remove(from: Int, to: Int) {
    require(from in 0..to && to <= items.size) { "remove $from $to of ${items.size}" }
    repeat(to - from) { items.removeAt(from) }
    when {
      current < from -> {}
      current >= to -> current -= to - from
      else -> {
        lost = true
        current = if (from < items.size) from else -1
      }
    }
  }

  override fun add(index: Int, items: List<Item>) {
    require(index in 0..this.items.size) { "add at $index of ${this.items.size}" }
    this.items.addAll(index, items)
    if (current >= index) current += items.size
  }

  override fun goOn(fresh: Item) {
    wentOn = fresh
  }

  override fun load(items: List<Item>, index: Int, positionMs: Long) {
    this.items.clear()
    this.items.addAll(items)
    current = index
    loads++
    loadedPositionMs = positionMs
  }

  override fun setPlayWhenReady(play: Boolean) {
    this.play = play
  }
}

class PageQueueTest {
  /** The page's list: new items, as setQueue builds them from its JSON. */
  private fun page(vararg ids: String) = ids.map { ListPlayer.Item(it) }

  private fun apply(p: ListPlayer, items: List<ListPlayer.Item>, index: Int, keep: Boolean, positionMs: Long = 10_000, play: Boolean = true) =
    PageQueue.apply(p, items, { it.id }, index, positionMs, play, keep)

  @Test
  fun anEditAroundTheItemPlayingKeepsItPlaying() {
    // "Aggiungi in coda": M right after the song playing.
    val p = ListPlayer(listOf("A", "B", "C"), 1)
    val b = p.playing
    val list = page("A", "B", "M", "C")
    apply(p, list, 1, keep = false)
    assertEquals(0, p.loads)
    assertEquals(listOf("A", "B", "M", "C"), p.ids)
    assertEquals(1, p.current)
    assertSame(b, p.playing)
    assertSame(list[1], p.wentOn)
    assertFalse(p.lost)
    assertEquals(true, p.play)
  }

  @Test
  fun anEditMadeBeforeThePageSawThePlayerMoveOnKeepsWhatPlays() {
    // A, B, M, C with B playing; previous twice on Bluetooth went to A, the page moved M after A
    // and sent its list with A current; next, pressed at once, got there first: B plays.
    val p = ListPlayer(listOf("A", "B", "M", "C"), 1)
    val b = p.playing
    apply(p, page("A", "M", "B", "C"), 0, keep = true)
    assertEquals(0, p.loads)
    assertEquals(listOf("A", "M", "B", "C"), p.ids)
    assertEquals(2, p.current)
    assertSame(b, p.playing)
    assertFalse(p.lost)
  }

  @Test
  fun aListThePageMeansToStartFromAnotherItemLoadsAfresh() {
    // Not an edit: the page jumps (a tap on a song further down that moves the queued ones).
    val p = ListPlayer(listOf("A", "B", "C"), 1)
    apply(p, page("A", "B", "C"), 0, keep = false, positionMs = 0)
    assertEquals(1, p.loads)
    assertEquals(0, p.current)
    assertEquals(0L, p.loadedPositionMs)
    assertEquals(listOf("A", "B", "C"), p.ids)
  }

  @Test
  fun anEditWithoutTheItemPlayingLoadsAtThePagesIndex() {
    val p = ListPlayer(listOf("A", "B", "C"), 2)
    apply(p, page("A", "B", "D"), 1, keep = true, positionMs = 1_234)
    assertEquals(1, p.loads)
    assertEquals(1, p.current)
    assertEquals(1_234L, p.loadedPositionMs)
  }

  @Test
  fun aPlayerThatCannotGoOnLoadsAfresh() {
    // A failed, stopped or ended player is prepared again from the page's list.
    val p = ListPlayer(listOf("A", "B"), 0, canGoOn = false)
    apply(p, page("A", "B"), 0, keep = true)
    assertEquals(1, p.loads)
  }

  @Test
  fun anEmptyListClearsThePlayerAndLeavesPlayAlone() {
    val p = ListPlayer(listOf("A", "B"), 1)
    apply(p, emptyList(), 0, keep = true)
    assertEquals(emptyList<String>(), p.ids)
    assertNull(p.play)
  }

  @Test
  fun theNearestCopyOfTheItemPlayingGoesOn() {
    assertEquals(1, PageQueue.keepAt("B", true, listOf("X", "B", "Y", "Z", "B"), 0, keep = true))
    assertEquals(4, PageQueue.keepAt("B", true, listOf("X", "B", "Y", "Z", "B"), 3, keep = true))
    // On a tie, the later one: the player moves on more often than back.
    assertEquals(3, PageQueue.keepAt("B", true, listOf("X", "B", "Y", "B"), 2, keep = true))
    // At the page's index, whatever else holds it.
    assertEquals(3, PageQueue.keepAt("B", true, listOf("B", "B", "Y", "B"), 3, keep = false))
    assertEquals(-1, PageQueue.keepAt("B", true, listOf("X", "B"), 0, keep = false))
    assertEquals(-1, PageQueue.keepAt(null, true, listOf("X", "B"), 0, keep = true))
    assertEquals(-1, PageQueue.keepAt("B", false, listOf("B"), 0, keep = true))
  }

  @Test
  fun theItemPlayingNeverGoesWhereverItSits() {
    // Any list the player holds, any index it plays (moved by a key, the car, the end of a song),
    // any list of the page that holds that song: the song goes on, untouched, in the page's order.
    val rnd = Random(29)
    val names = listOf("A", "B", "C", "D", "E")
    repeat(5_000) { round ->
      val held = List(1 + rnd.nextInt(7)) { names[rnd.nextInt(names.size)] }
      val ci = rnd.nextInt(held.size)
      val p = ListPlayer(held, ci)
      val playing = p.playing!!
      val ids = MutableList(1 + rnd.nextInt(7)) { names[rnd.nextInt(names.size)] }
      val keep = rnd.nextBoolean()
      val at = rnd.nextInt(ids.size)
      // An edit holds the song somewhere; a list kept without keep holds it at the page's index.
      val index = if (keep) rnd.nextInt(ids.size) else at
      ids[at] = playing.id
      val list = ids.map { ListPlayer.Item(it) }
      apply(p, list, index, keep)
      val where = "round $round: $held at $ci, page $ids at $index keep $keep"
      assertEquals(where, 0, p.loads)
      assertFalse(where, p.lost)
      assertSame(where, playing, p.playing)
      assertEquals(where, ids, p.ids)
      assertEquals(where, PageQueue.keepAt(playing.id, true, ids, index, keep), p.current)
      // Every other item is the page's.
      for (i in list.indices) if (i != p.current) assertSame(where, list[i], p.items[i])
    }
  }

  @Test
  fun thePagesPlayerCallsActOnTheSessionsOwnPlayerInOneOrder() {
    val bridge = Sources.read("MPfyBridge.kt")
    // The page's list lands whole, on the player the keys and the car act on.
    assertTrue(Sources.body(bridge, "fun setQueue(").contains("PageQueue.apply(PlayerQueue(p), Playback.itemsOf(arr, register = false), { it.mediaId }, index, positionMs, playWhenReady, keep)"))
    val onMain = Sources.body(bridge, "private fun onMain(")
    assertTrue(onMain.contains("block: (Player) -> Unit"))
    assertTrue(onMain.contains("val p = Playback.player ?: return@post"))
    // No call of the page reaches the player through the Activity's controller (its commands
    // waited for a later turn of the main thread, behind and between the keys').
    val commands = Regex("""\b(c|controller\??)\.(setMediaItems|addMediaItems|removeMediaItems|clearMediaItems|replaceMediaItems?|moveMediaItems?|seekTo\w*|play|pause|prepare|stop)\(""")
    assertEquals(emptyList<String>(), commands.findAll(bridge).map { it.value }.toList())
    assertFalse(Regex("""\b(c|controller\??)\.(playWhenReady|repeatMode)\s*=""").containsMatchIn(bridge))
    // The items that go in are registered, as the session does for a controller's.
    assertTrue(Sources.body(bridge, "override fun add(").contains("items.forEach(Playback::register)"))
    assertTrue(Sources.body(bridge, "override fun load(").contains("items.forEach(Playback::register)"))
    val service = Sources.read("PlaybackService.kt")
    assertTrue(Sources.body(service, "override fun onCreate()").contains("Playback.player = player"))
    assertTrue(Sources.body(service, "override fun onDestroy()").contains("Playback.player = null"))
  }
}
