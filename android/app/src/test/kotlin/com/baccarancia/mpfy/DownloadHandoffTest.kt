package com.baccarancia.mpfy

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A download manager ordered as Media3's DownloadManager (1.11.1). What the main thread tells it
 * waits for its own thread and runs there in order. That thread writes the index as it goes (the
 * main thread reads the index as it is) and posts each change to the main thread, which hears it
 * later, with the manager's list as it was then. A removal marks the download REMOVING; its remove
 * task (one at a time) ends on another thread, and that end waits in the same queue behind what
 * came before it: only then the download leaves the index and the list. An add of a download being
 * removed restarts it once the removal ends. Removing a key it does not hold does nothing.
 */
internal class Media3Manager(private val post: (Update) -> Unit) {
  /** A change the main thread hears: [key] changed, or went for good ([removed]), and the list then. */
  class Update(val key: String, val removed: Boolean, val list: Set<String>)

  private sealed class Msg {
    class Add(val key: String) : Msg()

    class Remove(val key: String) : Msg()

    object RemoveAll : Msg()

    class Finished(val key: String) : Msg()

    class RemoveTaskEnded(val key: String) : Msg()
  }

  private val messages = ArrayDeque<Msg>()
  private var removeTask: String? = null
  private var removeTaskEnding = false

  /** Each download the manager's thread holds, with its state: the index. */
  val states = LinkedHashMap<String, String>()

  /** The manager's list (currentDownloads) as the main thread last heard it. */
  var list: Set<String> = emptySet()
    private set

  /** What a removal on the main thread reads: the index as it is, and the list it heard. */
  val stored: Set<String> get() = LinkedHashSet(states.keys).apply { addAll(list) }

  fun add(key: String) = messages.addLast(Msg.Add(key))

  fun remove(key: String) = messages.addLast(Msg.Remove(key))

  fun removeAll() = messages.addLast(Msg.RemoveAll)

  /** The download of [key] stored its last byte; the news waits in the queue too. */
  fun finish(key: String) = messages.addLast(Msg.Finished(key))

  /** The main thread hears [u]. */
  fun heard(u: Update) {
    list = u.list
  }

  /** Its own thread handles the next message; false when none waits. */
  fun step(): Boolean {
    when (val m = messages.removeFirstOrNull() ?: return false) {
      is Msg.Add -> {
        val s = states[m.key]
        states[m.key] = if (s == REMOVING || s == RESTARTING) RESTARTING else QUEUED
        changed(m.key)
      }
      is Msg.Remove -> if (m.key in states) {
        states[m.key] = REMOVING
        changed(m.key)
      }
      Msg.RemoveAll -> for (k in states.keys.toList()) {
        states[k] = REMOVING
        changed(k)
      }
      is Msg.Finished -> if (states[m.key] == QUEUED) {
        states[m.key] = COMPLETED
        changed(m.key)
      }
      is Msg.RemoveTaskEnded -> {
        removeTask = null
        if (states[m.key] == RESTARTING) {
          states[m.key] = QUEUED
          changed(m.key)
        } else {
          states.remove(m.key)
          post(Update(m.key, true, unfinished()))
        }
      }
    }
    if (removeTask == null) {
      removeTask = states.entries.firstOrNull { it.value == REMOVING || it.value == RESTARTING }?.key
      removeTaskEnding = false
    }
    return true
  }

  /** The remove task running ends: its end joins the queue. False when none runs or it already ended. */
  fun endRemoveTask(): Boolean {
    val k = removeTask ?: return false
    if (removeTaskEnding) return false
    removeTaskEnding = true
    messages.addLast(Msg.RemoveTaskEnded(k))
    return true
  }

  private fun unfinished(): Set<String> = states.filterValues { it != COMPLETED }.keys.toSet()

  private fun changed(key: String) = post(Update(key, false, unfinished()))

  companion object {
    const val QUEUED = "queued"
    const val COMPLETED = "completed"
    const val REMOVING = "removing"
    const val RESTARTING = "restarting"
  }
}

/**
 * The main thread as Downloads runs it over a [Media3Manager]: add, remove, removeAll, move and
 * the manager's listener. The manager's updates and the moves a download's source posts wait in
 * its queue, in order; a tap runs when it comes, ahead of what still waits.
 */
internal class MainThread {
  val handoff = DownloadHandoff()
  private val queue = ArrayDeque<() -> Unit>()
  val manager = Media3Manager { u -> queue.addLast { heard(u) } }
  private val moving = HashSet<String>()
  private val movedTo = HashSet<String>()

  /** Downloads' listener: onDownloadChanged, onDownloadRemoved. */
  private fun heard(u: Media3Manager.Update) {
    manager.heard(u)
    if (u.removed) moving.remove(u.key)
  }

  /** Downloads.add. */
  fun on(keys: Collection<String>) {
    for (k in keys) {
      handoff.handed(k)
      manager.add(k)
    }
  }

  /** Downloads.remove with the page's selectors. */
  fun off(selectors: Collection<DownloadSelector>) {
    for (k in handoff.toRemove(manager.stored, selectors)) manager.remove(k)
  }

  /** Downloads.removeAll. */
  fun deleteAll() {
    moving.clear()
    handoff.dropAll(manager.stored)
    manager.removeAll()
  }

  /** The source of the download of [key], while it runs, served [level]: the move waits in the queue. */
  fun served(key: String, level: String) {
    queue.addLast { move(key, level) }
  }

  /** Downloads.move. */
  private fun move(key: String, served: String) {
    if (key in moving || !handoff.mayMove(key)) return
    if (key !in manager.list) return
    val target = Levels.moveTo(key, served, key in movedTo) ?: return
    moving.add(key)
    if (manager.states[target] != Media3Manager.COMPLETED) {
      handoff.handed(target)
      movedTo.add(target)
      manager.add(target)
    }
    manager.remove(key)
  }

  /** It handles [n] of what waits in its queue. */
  fun hear(n: Int = Int.MAX_VALUE) {
    var left = n
    while (left-- > 0) (queue.removeFirstOrNull() ?: return)()
  }

  /** Everything runs to its end. */
  fun settle() {
    while (true) {
      if (manager.step()) continue
      if (queue.isNotEmpty()) {
        hear(1)
        continue
      }
      if (manager.endRemoveTask()) continue
      return
    }
  }
}

class DownloadHandoffTest {
  private val main = MainThread()
  private val manager = main.manager
  private val handoff = main.handoff

  private fun track(i: Int) = "t%023d".format(i)

  private fun keyOf(i: Int, level: String = "max") = Levels.key(track(i), track(i), level)

  private fun switchOn(range: IntRange) = main.on(range.map { keyOf(it) })

  private fun switchOff(range: IntRange) = main.off(range.map { DownloadSelector.Track(track(it)) })

  private fun held(): Set<String> = manager.states.keys.toSet()

  @Test
  fun onThenOffQuicklyLeavesNoSongDownloaded() {
    // A long playlist switched on, and off again before the manager's thread stored most of it.
    switchOn(1..40)
    repeat(3) { manager.step() }
    switchOff(1..40)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun offBeforeTheManagerStoredAnythingRemovesEverySong() {
    switchOn(1..5)
    switchOff(1..5)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun onOffOnSettlesOn() {
    switchOn(1..10)
    repeat(4) { manager.step() }
    switchOff(1..10)
    switchOn(1..10)
    main.settle()
    assertEquals((1..10).map { keyOf(it) }.toSet(), held())
    // Switched on again, a song may move to the level its source served.
    assertTrue(handoff.mayMove(keyOf(1)))
    assertTrue(handoff.mayMove(keyOf(10)))
  }

  @Test
  fun aRemovalReachesOnlyTheSongsItNames() {
    switchOn(1..6)
    switchOff(1..3)
    main.settle()
    assertEquals((4..6).map { keyOf(it) }.toSet(), held())
  }

  @Test
  fun aSongOnItsWayBackIsReachedAfterARemovalOfAnother() {
    // Song 2 switched off and on again: its add waits behind the end of its removal. A removal of
    // song 1 meanwhile sees song 2 in the index (still being removed), and must not take it for
    // stored: once that removal ends song 2 is in neither the index nor the list.
    switchOn(1..2)
    main.settle()
    switchOff(2..2)
    manager.step()
    manager.endRemoveTask()
    switchOn(2..2)
    switchOff(1..1)
    manager.step() // the removal of song 2 ends, its new add still waits
    main.hear()
    switchOff(2..2)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun aRemovalOfOneSongStillReachesTheOthersLater() {
    switchOn(1..2)
    switchOff(1..1)
    switchOff(2..2)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun offOnOffWhileDownloadingSettlesOff() {
    // Two songs downloading, the switch tapped three times: off, on, off.
    switchOn(1..2)
    main.settle()
    switchOff(1..2)
    manager.step() // song 1 REMOVING
    manager.endRemoveTask() // its removal ends at once; the news waits behind the removal of song 2
    main.hear() // the main thread hears song 1 REMOVING
    switchOn(1..2) // the adds wait behind the end of the old removal
    manager.step() // song 2 REMOVING
    manager.step() // the old removal ends: song 1 leaves the index and the list, its add still waits
    main.hear() // the main thread hears song 1 gone
    switchOff(1..2) // song 1 is in neither the index nor the list
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun onOffOnOffSettlesOff() {
    switchOn(1..2)
    switchOff(1..2)
    repeat(3) { manager.step() } // add 1, add 2, remove 1
    manager.endRemoveTask()
    switchOn(1..2)
    repeat(2) { manager.step() } // remove 2, then the end of the removal of song 1, whose new add still waits
    main.hear()
    switchOff(1..2)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun aRemovalThatEndsLateDoesNotLetAMoveAddTheSongBack() {
    // Off, on and off again; the end of the first removal is heard after the second, and the
    // source of the new download served another level meanwhile.
    switchOn(1..1)
    main.settle()
    switchOff(1..1)
    manager.step() // REMOVING
    manager.endRemoveTask()
    switchOn(1..1)
    manager.step() // the first removal ends: gone (heard later)
    manager.step() // the new add: downloading again
    main.served(keyOf(1), "high")
    switchOff(1..1)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun aSongARemovalReachedDoesNotMoveToAnotherLevel() {
    // Its source served another level and the move was on its way when the switch went off: the
    // move would add the song again under the new key, with nothing left to remove it.
    switchOn(1..2)
    main.settle()
    assertTrue(handoff.mayMove(keyOf(1)))
    main.served(keyOf(1), "high")
    switchOff(1..1)
    assertFalse(handoff.mayMove(keyOf(1)))
    assertTrue(handoff.mayMove(keyOf(2)))
    main.settle()
    assertEquals(setOf(keyOf(2)), held())
    // Removed for good: a later download of it starts clean.
    switchOn(1..1)
    assertTrue(handoff.mayMove(keyOf(1)))
  }

  @Test
  fun aMoveHandedOverIsRemovedWithTheSong() {
    // The song moved to the level its source served (a new key) and the switch went off before
    // the manager stored the new one.
    switchOn(1..1)
    main.settle()
    main.served(keyOf(1), "high")
    main.hear()
    switchOff(1..1)
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun aSongSwitchedOnStaysOnAtTheLevelItMovedTo() {
    switchOn(1..1)
    main.settle()
    main.served(keyOf(1), "high")
    main.settle()
    assertEquals(setOf(keyOf(1, "high")), held())
  }

  @Test
  fun deleteAllStopsMovesToo() {
    switchOn(1..3)
    manager.step()
    main.served(keyOf(1), "high")
    main.deleteAll()
    for (i in 1..3) assertFalse(handoff.mayMove(keyOf(i)))
    main.settle()
    assertEquals(emptySet<String>(), held())
  }

  @Test
  fun anyOrderOfTapsAndManagerStepsSettlesOnTheLastTaps() {
    val rnd = Random(27)
    repeat(40_000) { run ->
      val m = MainThread()
      val on = BooleanArray(4)
      val trace = ArrayList<String>()
      fun songs(): IntRange = if (rnd.nextInt(3) == 0) 1..3 else rnd.nextInt(1, 4).let { it..it }
      repeat(rnd.nextInt(4, 40)) {
        when (rnd.nextInt(12)) {
          0, 1 -> songs().let { r ->
            trace.add("on $r")
            m.on(r.map { keyOf(it) })
            for (i in r) on[i] = true
          }
          2, 3 -> songs().let { r ->
            trace.add("off $r")
            m.off(r.map { DownloadSelector.Track(track(it)) })
            for (i in r) on[i] = false
          }
          4, 5, 6 -> if (m.manager.step()) trace.add("step")
          7 -> if (m.manager.endRemoveTask()) trace.add("remove task ends")
          8, 9 -> {
            trace.add("hear")
            m.hear(1)
          }
          10 -> m.manager.states.filterValues { it == Media3Manager.QUEUED }.keys.filter { Levels.ofKey(it) == "max" }.randomOrNull(rnd)?.let { k ->
            if (rnd.nextBoolean()) {
              trace.add("served $k")
              m.served(k, "high")
            } else {
              trace.add("finished $k")
              m.manager.finish(k)
            }
          }
          else -> if (rnd.nextInt(6) == 0) {
            trace.add("delete all")
            m.deleteAll()
            on.fill(false)
          }
        }
      }
      m.settle()
      for (i in 1..3) {
        val held = m.manager.states.keys.any { Levels.parse(it)?.trackId == track(i) }
        assertEquals("run $run, song $i after: ${trace.joinToString(", ")}", on[i], held)
      }
    }
  }

  @Test
  fun aSongOfThePhoneIsNeverDownloaded() {
    val id = track(7)
    assertTrue(DownloadPolicy.refuses("http://127.0.0.1:47123/s/0000/api/stream/$id?q=max&f=$id"))
    assertFalse(DownloadPolicy.refuses("http://127.0.0.1:47123/s/a3435d00/api/stream/$id?q=max&f=$id"))
    assertFalse(DownloadPolicy.refuses("http://127.0.0.1:47123/s/00000000/api/stream/$id?q=max&f=$id"))
    // The page's request goes through that check before anything is handed over.
    val add = Sources.body(Sources.read("Downloads.kt"), "fun add(")
    assertTrue(add.contains("DownloadPolicy.refuses("))
    assertTrue(add.indexOf("DownloadPolicy.refuses(") < add.indexOf("handoff.handed("))
  }

  @Test
  fun downloadsAddEveryKeyThroughTheHandoffAndRemovalsUseIt() {
    val code = Sources.read("Downloads.kt")
    // Every add, the page's and a move's, is handed over first.
    val lines = code.lines()
    val adds = lines.indices.filter { lines[it].contains("m.addDownload(") }
    assertEquals(2, adds.size)
    for (i in adds) assertTrue(lines[i - 1].trim().startsWith("handoff.handed("))
    assertTrue(Sources.body(code, "fun remove(").contains("handoff.toRemove(stored(m), selectors)"))
    assertTrue(Sources.body(code, "fun removeAll(").contains("handoff.dropAll("))
    assertTrue(Sources.body(code, "private fun move(").contains("if (key in moving || !handoff.mayMove(key)) return"))
    // The manager's updates cannot say which hand-over they are about: none of them changes what
    // a removal must reach.
    assertFalse(Sources.body(code, "override fun onDownloadChanged(", indent = 10).contains("handoff"))
    assertFalse(Sources.body(code, "override fun onDownloadRemoved(", indent = 10).contains("handoff"))
    assertFalse(code.contains("Levels.toRemove("))
  }
}
