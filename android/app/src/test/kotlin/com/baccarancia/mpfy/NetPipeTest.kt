package com.baccarancia.mpfy

import java.io.IOException
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lookups' HTTPS GETs for the phone's own songs, as the core asks for them and gets them back. */
class NetPipeTest {
  private class Call(val url: String, val headers: Map<String, String>, val cap: Long)

  private val calls = ArrayList<Call>()
  private val answers = HashMap<String, Fetched>()
  private var allowed = true
  private var now = 1_000_000L
  private val slept = ArrayList<Long>()
  private val fetch = Fetch { url, headers, cap ->
    calls.add(Call(url, headers, cap))
    answers[url] ?: throw IOException("no route")
  }
  private val sizes = CoverSizes { image -> if (image.size > 3) "small".toByteArray() to "large".toByteArray() else null }
  private val ua = NetRules.userAgent("1.0.0")
  private val pipe = NetPipe(fetch, sizes, { allowed }, ua, clock = { now }, sleep = { ms ->
    slept.add(ms)
    now += ms
  })

  private val mb = "https://musicbrainz.org/ws/2/recording?query=recording%3A%22x%22&fmt=json&limit=10"
  private val caa = "https://coverartarchive.org/release/0f6c1a3e-0000-4000-8000-000000000001/front-500"
  private val lrclib = "https://lrclib.net/api/get?track_name=x&artist_name=y&duration=200"
  private val jpeg = byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, -1, -39)

  private fun ok(text: String) = Fetched(200, null, null, text.toByteArray())

  @Test
  fun onlyTheThreeServicesAreAsked() {
    answers[mb] = ok("{}")
    answers[caa] = Fetched(200, null, null, jpeg)
    answers[lrclib] = ok("{}")
    assertEquals(200L, (pipe.answer(1L, "musicbrainz", mb, "json")["status"] as Number).toLong())
    assertEquals(200L, (pipe.answer(2L, "caa", caa, "cover")["status"] as Number).toLong())
    assertEquals(200L, (pipe.answer(3L, "lrclib", lrclib, "json")["status"] as Number).toLong())
    assertEquals(listOf(mb, caa, lrclib), calls.map { it.url })
    calls.clear()
    for ((service, url) in listOf(
      "musicbrainz" to "https://musicbrainz.org/oauth2/token",
      "musicbrainz" to "http://musicbrainz.org/ws/2/recording?query=x",
      "musicbrainz" to "https://musicbrainz.org.example.net/ws/2/recording",
      "musicbrainz" to "https://user@musicbrainz.org/ws/2/recording",
      "musicbrainz" to "https://musicbrainz.org:8443/ws/2/recording",
      "musicbrainz" to "https://musicbrainz.org/ws/2/../admin",
      "lrclib" to "https://lrclib.net/apix/get",
      "lrclib" to mb,
      "caa" to "https://archive.org/download/x/y.jpg",
      "caa" to "https://coverartarchive.org.example.net/release/x/front-500",
      "acoustid" to "https://api.acoustid.org/v2/lookup",
      "musicbrainz" to "not a url",
    )) {
      assertEquals("$service $url", "not_allowed", pipe.answer(9L, service, url, "json")["error"])
    }
    assertTrue(calls.isEmpty())
  }

  @Test
  fun aCoverFollowsTheArchivesRedirectsAndNothingElse() {
    val hop1 = "https://archive.org/download/mbid-x/mbid-x-500.jpg"
    val hop2 = "https://ia800100.us.archive.org/12/items/mbid-x/mbid-x-500.jpg"
    answers[caa] = Fetched(307, hop1, null, ByteArray(0))
    answers[hop1] = Fetched(302, hop2, null, ByteArray(0))
    answers[hop2] = Fetched(200, null, null, jpeg)
    val r = pipe.answer(4L, "caa", caa, "cover")
    assertEquals(listOf(caa, hop1, hop2), calls.map { it.url })
    @Suppress("UNCHECKED_CAST")
    val cover = r["cover"] as Map<String, Any?>
    assertEquals(CoverArt.coverId(jpeg), cover["coverId"])
    assertEquals(Base64.getEncoder().encodeToString("small".toByteArray()), cover["small"])
    assertEquals(Base64.getEncoder().encodeToString("large".toByteArray()), cover["large"])
    // Anywhere else, or plain http, or a musicbrainz answer sending us away: refused there.
    calls.clear()
    answers[caa] = Fetched(302, "https://cdn.example.net/x.jpg", null, ByteArray(0))
    assertEquals("not_allowed", pipe.answer(5L, "caa", caa, "cover")["error"])
    answers[caa] = Fetched(302, "http://archive.org/download/x.jpg", null, ByteArray(0))
    assertEquals("not_allowed", pipe.answer(6L, "caa", caa, "cover")["error"])
    answers[mb] = Fetched(301, "https://archive.org/download/x.jpg", null, ByteArray(0))
    assertEquals("not_allowed", pipe.answer(7L, "musicbrainz", mb, "json")["error"])
    assertEquals(listOf(caa, caa, mb), calls.map { it.url })
  }

  @Test
  fun aMeteredNetworkDataSaverOrBatterySaverRefuseAtOnce() {
    allowed = false
    answers[mb] = ok("{}")
    assertEquals("metered", pipe.answer(1L, "musicbrainz", mb, "json")["error"])
    assertEquals("metered", pipe.answer(2L, "lrclib", lrclib, "json")["error"])
    assertTrue(calls.isEmpty())
    // Only an unmetered network that is not a phone's mobile data, with neither saver on.
    assertTrue(NetRules.mayUse("wifi", metered = false, dataSaver = false, batterySaver = false))
    assertTrue(NetRules.mayUse("ethernet", metered = false, dataSaver = false, batterySaver = false))
    assertFalse(NetRules.mayUse("wifi", metered = true, dataSaver = false, batterySaver = false))
    assertFalse(NetRules.mayUse("cellular", metered = false, dataSaver = false, batterySaver = false))
    assertFalse(NetRules.mayUse("cellular", metered = true, dataSaver = false, batterySaver = false))
    assertFalse(NetRules.mayUse("none", metered = false, dataSaver = false, batterySaver = false))
    assertFalse(NetRules.mayUse("wifi", metered = false, dataSaver = true, batterySaver = false))
    assertFalse(NetRules.mayUse("wifi", metered = false, dataSaver = false, batterySaver = true))
  }

  @Test
  fun aRequestCarriesExactlyTheSourcesUserAgentAndAnAccept() {
    answers[mb] = ok("{}")
    answers[caa] = Fetched(307, "https://archive.org/download/x/y.jpg", null, ByteArray(0))
    answers["https://archive.org/download/x/y.jpg"] = Fetched(200, null, null, jpeg)
    pipe.answer(1L, "musicbrainz", mb, "json")
    pipe.answer(2L, "caa", caa, "cover")
    val ua = "MPfy/1.0.0 ( https://github.com/BaccaranciaSte/MPfy )"
    assertEquals(mapOf("User-Agent" to ua, "Accept" to "application/json"), calls[0].headers)
    assertEquals(mapOf("User-Agent" to ua, "Accept" to "image/*"), calls[1].headers)
    assertEquals(calls[1].headers, calls[2].headers)
  }

  @Test
  fun eachServiceHasTheSourcesCapAndABodyPastItIsTooLarge() {
    answers[mb] = Fetched(200, null, null, null)
    answers[caa] = Fetched(200, null, null, null)
    answers[lrclib] = Fetched(200, null, null, null)
    assertEquals("too_large", pipe.answer(1L, "musicbrainz", mb, "json")["error"])
    assertEquals("too_large", pipe.answer(2L, "caa", caa, "cover")["error"])
    assertEquals("too_large", pipe.answer(3L, "lrclib", lrclib, "json")["error"])
    assertEquals(listOf(4L shl 20, 16L shl 20, 1L shl 20), calls.map { it.cap })
  }

  @Test
  fun theAnswerTravelsBackAsTheCoreReadsIt() {
    answers[lrclib] = ok("{\"syncedLyrics\":null}")
    val r = pipe.answer(42L, "lrclib", lrclib, "json")
    assertEquals("net-reply", r["t"])
    assertEquals(42L, r["id"])
    assertEquals("{\"syncedLyrics\":null}", r["json"])
    // A miss, a busy service with its wait, a network that did not answer.
    answers[lrclib] = Fetched(404, null, null, ByteArray(0))
    assertEquals(404, pipe.answer(43L, "lrclib", lrclib, "json")["status"])
    answers[lrclib] = Fetched(429, null, "120", ByteArray(0))
    val busy = pipe.answer(44L, "lrclib", lrclib, "json")
    assertEquals(429, busy["status"])
    assertEquals("120", busy["retryAfter"])
    answers.remove(lrclib)
    assertEquals("network", pipe.answer(45L, "lrclib", lrclib, "json")["error"])
  }

  @Test
  fun aCoverThatIsNoPictureOrDoesNotDecodeIsNone() {
    answers[caa] = Fetched(200, null, null, "<html>".toByteArray())
    val a = pipe.answer(1L, "caa", caa, "cover")
    assertEquals(200, a["status"])
    assertTrue(a.containsKey("cover"))
    assertNull(a["cover"])
    answers[caa] = Fetched(200, null, null, byteArrayOf(-1, -40, -1))
    assertNull(pipe.answer(2L, "caa", caa, "cover")["cover"])
    answers[caa] = Fetched(404, null, null, ByteArray(0))
    assertEquals(404, pipe.answer(3L, "caa", caa, "cover")["status"])
  }

  @Test
  fun musicBrainzAndTheArchiveAreAskedThreeSecondsApartAtMost() {
    answers[mb] = ok("{}")
    answers[caa] = Fetched(404, null, null, ByteArray(0))
    answers[lrclib] = ok("{}")
    pipe.answer(1L, "musicbrainz", mb, "json")
    now += 1_000
    pipe.answer(2L, "musicbrainz", mb, "json")
    assertEquals(listOf(2_000L), slept)
    // Each service on its own, and LRCLIB is the core's to pace.
    pipe.answer(3L, "caa", caa, "cover")
    pipe.answer(4L, "lrclib", lrclib, "json")
    pipe.answer(5L, "lrclib", lrclib, "json")
    assertEquals(listOf(2_000L), slept)
    now += 500
    pipe.answer(6L, "caa", caa, "cover")
    assertEquals(listOf(2_000L, 2_500L), slept)
    // A refusal on the way is not a request: it moves nothing.
    allowed = false
    now += 10_000
    pipe.answer(7L, "musicbrainz", mb, "json")
    allowed = true
    pipe.answer(8L, "musicbrainz", mb, "json")
    assertEquals(listOf(2_000L, 2_500L), slept)
  }
}
