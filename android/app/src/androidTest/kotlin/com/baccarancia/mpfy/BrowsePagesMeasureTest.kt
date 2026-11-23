package com.baccarancia.mpfy

import android.os.Debug
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What 100,000 songs in pages cost the app on a phone, measured before the page may send that
 * many (browse.js MAX_PAGED_TRACKS): the 50 pages and the index parsed off the main thread as
 * Browse parses them, the time it takes and the heap it adds once held, and the car's search over
 * them. It runs only when asked, with nothing else of the app touched:
 *
 *   ./gradlew connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.baccarancia.mpfy.BrowsePagesMeasureTest \
 *     -Pandroid.testInstrumentationRunnerArguments.mpfyMeasure=1
 *
 * The numbers go to logcat under MPfyMeasure and in the test's own messages.
 */
@RunWith(AndroidJUnit4::class)
class BrowsePagesMeasureTest {
  private val songs = 100_000
  private val perPage = 2_000

  private fun hex(n: Int, len: Int) = n.toString(16).padStart(len, '0')

  /** Page n as the page sends it: titles, artists and albums of a real-looking size, two versions each. */
  private fun pageText(n: Int): String {
    val b = StringBuilder(1 shl 20)
    b.append("{\"format\":\"mpfy-browse-page\",\"v\":1,\"n\":").append(n).append(",\"h\":\"").append(hex(n + 1, 16)).append("\",\"tracks\":[")
    for (i in 0 until perPage) {
      val k = n * perPage + i
      if (i > 0) b.append(',')
      val id = hex(k, 24)
      b.append("{\"id\":\"").append(id).append("\",\"t\":\"Titolo di prova numero ").append(k)
        .append("\",\"a\":\"Artista ").append(k / 60).append("\",\"aa\":\"Artista ").append(k / 60)
        .append("\",\"al\":\"").append(hex(k / 12, 16)).append("\",\"n\":").append(k % 12 + 1).append(",\"d\":").append(180_000 + k % 120_000)
        .append(",\"art\":[\"a54a6750\",\"").append(hex(k / 12, 24)).append("\",\"").append(hex(k / 12 + 1, 24)).append("\"]")
        .append(",\"v\":[{\"s\":\"a54a6750\",\"tr\":\"").append(id).append("\",\"f\":\"").append(id).append("\",\"o\":0}")
        .append(",{\"s\":\"afa2c425\",\"tr\":\"").append(hex(k + 1_000_000, 24)).append("\",\"f\":\"").append(hex(k + 1_000_000, 24)).append("\",\"o\":248}]}")
    }
    return b.append("]}").toString()
  }

  private fun indexText(): String {
    val o = LinkedHashMap<String, Any?>()
    o["format"] = "mpfy-browse-index"
    o["v"] = 1
    o["at"] = 1763380000000L
    o["h"] = "00000000000000ab"
    o["quality"] = linkedMapOf("wifi" to "max", "cellular" to "high")
    o["pages"] = (0 until songs / perPage).toList()
    o["albums"] = (0 until songs / 12).map { a -> linkedMapOf("id" to hex(a, 16), "n" to "Album $a", "a" to "Artista ${a / 5}", "y" to 2000, "art" to null, "tr" to (0 until 12).map { hex(a * 12 + it, 24) }) }
    o["artists"] = (0 until songs / 60).map { r -> linkedMapOf("id" to hex(r + 1_000_000, 16), "n" to "Artista $r", "art" to null, "tr" to (0 until 60).map { hex(r * 60 + it, 24) }) }
    o["playlists"] = listOf(linkedMapOf("id" to hex(7, 16), "n" to "Lunga", "art" to null, "tr" to (0 until 20_000).map { hex(it * 5, 24) }))
    o["liked"] = (0 until songs).map { linkedMapOf("id" to hex(it, 24), "ids" to listOf(hex(it, 24))) }
    o["recent"] = listOf(linkedMapOf("k" to "liked", "id" to ""))
    return Json.write(o)
  }

  private fun usedHeap(): Long {
    val r = Runtime.getRuntime()
    repeat(3) {
      r.gc()
      System.runFinalization()
      SystemClock.sleep(100)
    }
    return r.totalMemory() - r.freeMemory()
  }

  @Test
  fun aHundredThousandSongsInPages() {
    assumeTrue("only when asked (mpfyMeasure=1)", InstrumentationRegistry.getArguments().getString("mpfyMeasure") == "1")
    assertNotEquals("off the main thread", Looper.getMainLooper().thread, Thread.currentThread())
    // The texts as the bridge hands them over, made before the measure.
    val pages = (0 until songs / perPage).map { pageText(it) }
    val index = indexText()
    val chars = pages.sumOf { it.length.toLong() } + index.length
    val before = usedHeap()
    val nativeBefore = Debug.getNativeHeapAllocatedSize()
    val state = BrowseState(maxTracks = songs)
    val began = SystemClock.elapsedRealtime()
    for (t in pages) assertTrue(state.putPage(Snapshot.parsePage(t)!!))
    state.putIndex(Snapshot.parseIndex(index)!!)
    val parseMs = SystemClock.elapsedRealtime() - began
    val snap = state.snapshot!!
    assertEquals(songs, snap.tracks.size)
    val tree = BrowseTree(snap, Labels("Recenti", "Playlist", "Album", "Artisti", "Mi piace", "Libreria", "1 brano", "%d brani"))
    val s0 = SystemClock.elapsedRealtime()
    val found = tree.search("numero 99999")
    val searchMs = SystemClock.elapsedRealtime() - s0
    val l0 = SystemClock.elapsedRealtime()
    val liked = tree.children("cat:liked", null)!!.size
    val likedMs = SystemClock.elapsedRealtime() - l0
    // One page again, the others untouched.
    val r0 = SystemClock.elapsedRealtime()
    assertTrue(state.putPage(Snapshot.parsePage(pages[25])!!))
    val pageMs = SystemClock.elapsedRealtime() - r0
    val heap = usedHeap() - before
    val native = Debug.getNativeHeapAllocatedSize() - nativeBefore
    val line = "100000 songs in 50 pages (${chars / 1_000_000} M chars): parsed and held in $parseMs ms; heap +${heap / 1_048_576} MB, native +${native / 1_048_576} MB; " +
      "search ${found.size} in $searchMs ms; liked tab $liked in $likedMs ms; one page again in $pageMs ms; max heap ${Runtime.getRuntime().maxMemory() / 1_048_576} MB"
    Log.i("MPfyMeasure", line)
    println(line)
    assertEquals(1, found.size)
    assertTrue("parsed in $parseMs ms, at most 10000", parseMs < 10_000)
  }
}
