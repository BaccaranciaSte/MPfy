package com.baccarancia.mpfy

import android.content.ComponentName
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaBrowser
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android Auto's view of the app without Google services: a Media3 MediaBrowser connects to the
 * PlaybackService with the UI closed, browses, searches, plays from the tree and opens a cover. It
 * reads the snapshot already on the phone and never writes one; without one the cases that need
 * songs are skipped. Playback needs the media volume at 0 (the test refuses otherwise).
 */
@RunWith(AndroidJUnit4::class)
class CarBrowserTest {
  companion object {
    private const val TAG = "MPfyCarTest"
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler

    @BeforeClass
    @JvmStatic
    fun looper() {
      thread = HandlerThread("car-browser").also { it.start() }
      handler = Handler(thread.looper)
    }

    @AfterClass
    @JvmStatic
    fun end() {
      thread.quitSafely()
    }
  }

  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private val browsers = ArrayList<MediaBrowser>()
  private val searchResults = LinkedBlockingQueue<Pair<String, Int>>()
  private var played = false

  /** Runs [block] on the browsers' looper and waits for it. */
  private fun <T> on(block: () -> T): T {
    val task = FutureTask(Callable { block() })
    handler.post(task)
    return task.get(30, TimeUnit.SECONDS)
  }

  private fun <T> ListenableFuture<T>.await(): T = get(30, TimeUnit.SECONDS)

  private fun connect(): MediaBrowser {
    val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
    val listener = object : MediaBrowser.Listener {
      override fun onSearchResultChanged(browser: MediaBrowser, query: String, itemCount: Int, params: LibraryParams?) {
        searchResults.add(query to itemCount)
      }
    }
    val b = on { MediaBrowser.Builder(ctx, token).setApplicationLooper(thread.looper).setListener(listener).buildAsync() }.await()
    browsers.add(b)
    return b
  }

  @After
  fun release() {
    for (b in browsers) {
      on {
        if (played) {
          b.stop()
          b.clearMediaItems()
        }
        b.release()
      }
    }
    browsers.clear()
  }

  private fun autoRoot(b: MediaBrowser): LibraryResult<MediaItem> {
    val extras = Bundle().apply { putInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 4) }
    return on { b.getLibraryRoot(LibraryParams.Builder().setExtras(extras).build()) }.await()
  }

  private fun children(b: MediaBrowser, id: String): LibraryResult<com.google.common.collect.ImmutableList<MediaItem>> =
    on { b.getChildren(id, 0, 500, null) }.await()

  private fun ids(r: LibraryResult<com.google.common.collect.ImmutableList<MediaItem>>): List<String> {
    assertEquals(LibraryResult.RESULT_SUCCESS, r.resultCode)
    return r.value!!.map { it.mediaId }
  }

  /** The snapshot on the phone, read by the service when it starts (a browser starts it). */
  private fun snapshot(): Snapshot? {
    if (browsers.isEmpty()) connect()
    Browse.whenLoaded().get(30, TimeUnit.SECONDS)
    return Browse.state.snapshot
  }

  /** An album of the snapshot with at least two songs, or null. */
  private fun albumWithSongs(s: Snapshot): SnapGroup? = s.albums.firstOrNull { a -> a.tracks.count { it in s.trackById } >= 2 }

  @Test
  fun theRootIsMPfyWithGridFoldersAndListSongs() {
    val b = connect()
    val r = autoRoot(b)
    assertEquals(LibraryResult.RESULT_SUCCESS, r.resultCode)
    val root = r.value!!
    assertEquals("root", root.mediaId)
    assertEquals("MPfy", root.mediaMetadata.title.toString())
    assertEquals(true, root.mediaMetadata.isBrowsable)
    val extras = r.params!!.extras
    assertEquals(MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM, extras.getInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE))
    assertEquals(MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM, extras.getInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE))
  }

  @Test
  fun androidAutoSeesFourTabsAndABrowserWithoutALimitFive() {
    val car = connect()
    autoRoot(car)
    val four = children(car, "root")
    assertEquals(listOf("cat:recent", "cat:playlists", "cat:liked", "cat:library"), ids(four))
    assertEquals(listOf("Recenti", "Playlist", "Mi piace", "Libreria"), four.value!!.map { it.mediaMetadata.title.toString() })
    assertTrue(four.value!!.all { it.mediaMetadata.isBrowsable == true && it.mediaMetadata.isPlayable == false })
    assertEquals(listOf("cat:albums", "cat:artists"), ids(children(car, "cat:library")))
    val other = connect()
    on { other.getLibraryRoot(null) }.await()
    assertEquals(listOf("cat:recent", "cat:playlists", "cat:albums", "cat:artists", "cat:liked"), ids(children(other, "root")))
  }

  @Test
  fun everyCategoryAnswersAndAnUnknownIdIsABadValue() {
    val b = connect()
    autoRoot(b)
    for (id in listOf("cat:recent", "cat:playlists", "cat:albums", "cat:artists", "cat:liked", "cat:library")) {
      val r = children(b, id)
      assertEquals(id, LibraryResult.RESULT_SUCCESS, r.resultCode)
      Log.i(TAG, "$id: ${r.value!!.size} children")
      val item = on { b.getItem(id) }.await()
      assertEquals(id, item.value!!.mediaId)
    }
    assertEquals(SessionError.ERROR_BAD_VALUE, children(b, "al:zz").resultCode)
    assertEquals(SessionError.ERROR_BAD_VALUE, on { b.getItem("nothing") }.await().resultCode)
  }

  @Test
  fun anAlbumListsItsSongsAsPlayableItems() {
    val s = snapshot()
    assumeTrue("no snapshot on this phone", s != null)
    val album = albumWithSongs(s!!)
    assumeTrue("no album with two songs", album != null)
    val b = connect()
    autoRoot(b)
    assertTrue(ids(children(b, "cat:albums")).contains("al:${album!!.id}"))
    val songs = children(b, "al:${album.id}").value!!
    val present = album.tracks.filter { it in s.trackById }
    assertEquals(present.map { "tr:al:${album.id}:$it" }, songs.map { it.mediaId })
    for (it in songs) {
      assertEquals(true, it.mediaMetadata.isPlayable)
      assertEquals(false, it.mediaMetadata.isBrowsable)
      val art = it.mediaMetadata.artworkUri?.toString()
      if (art != null) assertTrue(art, art.startsWith("content://com.baccarancia.mpfy.art/cover/") && art.endsWith("/small"))
    }
    assertEquals(s.trackById.getValue(present[0]).title, songs[0].mediaMetadata.title.toString())
  }

  @Test
  fun searchFindsSongsAndRemembersThemForTheTap() {
    val s = snapshot()
    assumeTrue("no snapshot on this phone", s != null && s.tracks.isNotEmpty())
    val t = s!!.tracks.first { it.title.isNotBlank() }
    val b = connect()
    autoRoot(b)
    val query = t.title.uppercase()
    searchResults.clear()
    assertEquals(LibraryResult.RESULT_SUCCESS, on { b.search(query, null) }.await().resultCode)
    val told = searchResults.poll(20, TimeUnit.SECONDS)
    assertNotNull("no search result notice", told)
    assertEquals(query, told!!.first)
    assertTrue(told.second >= 1)
    val found = on { b.getSearchResult(query, 0, 50, null) }.await().value!!
    assertEquals(told.second, found.size)
    val hash = Search.hash(query)
    assertTrue(found.all { it.mediaId.startsWith("tr:s:$hash:") })
    assertTrue(found.any { it.mediaId.endsWith(":${t.id}") })
    assertEquals(0, on { b.getSearchResult("   ", 0, 50, null) }.await().value!!.size)
  }

  @Test
  fun aSongTappedInTheCarPlaysItsAlbumFromThereWithGroupIdsAndANewQueueId() {
    val s = snapshot()
    assumeTrue("no snapshot on this phone", s != null)
    val album = albumWithSongs(s!!)
    assumeTrue("no album with two songs", album != null)
    val audio = ctx.getSystemService(AudioManager::class.java)
    assertEquals("the media volume must be 0 before anything plays", 0, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
    val present = album!!.tracks.filter { it in s.trackById }
    val gid = present[1]
    val b = connect()
    autoRoot(b)
    played = true
    on {
      b.setMediaItem(MediaItem.Builder().setMediaId("tr:al:${album.id}:$gid").build())
      b.prepare()
      b.play()
    }
    val end = SystemClock.elapsedRealtime() + 20_000
    while (on { b.mediaItemCount } != present.size && SystemClock.elapsedRealtime() < end) SystemClock.sleep(100)
    val queue = on { (0 until b.mediaItemCount).map { b.getMediaItemAt(it) } }
    assertEquals(present, queue.map { it.mediaId })
    assertEquals(1, on { b.currentMediaItemIndex })
    val cur = queue[1]
    val t = s.trackById.getValue(gid)
    assertEquals(t.title, cur.mediaMetadata.title.toString())
    assertEquals(t.artist, cur.mediaMetadata.artist.toString())
    assertEquals(album.name, cur.mediaMetadata.albumTitle.toString())
    t.art?.let { assertEquals(it.uri("large"), cur.mediaMetadata.artworkUri.toString()) }
    var queueId: String? = null
    InstrumentationRegistry.getInstrumentation().runOnMainSync { queueId = Playback.owner.idFor(present.size) }
    assertTrue("queueId $queueId", Regex("n[0-9a-f]{15}").matches(queueId ?: ""))
    // It plays (the sources are on the PC), then pauses.
    val playUntil = SystemClock.elapsedRealtime() + 25_000
    while (!on { b.isPlaying } && SystemClock.elapsedRealtime() < playUntil) SystemClock.sleep(200)
    Log.i(TAG, "playing: ${on { b.isPlaying }}, state ${on { b.playbackState }}")
    assertTrue("it never played", on { b.isPlaying })
    on { b.pause() }
    SystemClock.sleep(500)
    assertFalse(on { b.playWhenReady })
    assertFalse(on { b.isPlaying })
    assertEquals(Player.STATE_READY, on { b.playbackState })
  }

  /**
   * A song nobody liked is liked and unliked again, so the principal ends as it was; browse.json,
   * which every heart rewrites, gets its own bytes back.
   */
  @Test
  fun theHeartLikesTheSongPlayingOnThePrincipalAndUnlikesItAgain() {
    val s = snapshot()
    assumeTrue("no snapshot on this phone", s != null)
    val album = s!!.albums.firstOrNull { a -> a.tracks.count { it in s.trackById } >= 2 && a.tracks.any { it in s.trackById && Browse.state.likedOf(it) == null } }
    assumeTrue("no album with two songs, one of them not liked", album != null)
    val upUntil = SystemClock.elapsedRealtime() + 30_000
    while (Links.principal?.let { Links.isUp(it) } != true && SystemClock.elapsedRealtime() < upUntil) SystemClock.sleep(200)
    val principal = Links.principal
    assumeTrue("no principal up", principal != null && Links.isUp(principal))
    val audio = ctx.getSystemService(AudioManager::class.java)
    assertEquals("the media volume must be 0 before anything plays", 0, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
    val gid = album!!.tracks.first { it in s.trackById && Browse.state.likedOf(it) == null }
    val file = File(ctx.filesDir, "browse.json")
    assumeTrue("no browse.json", file.isFile)
    val saved = file.readBytes()
    try {
      heartRounds(album.id, gid)
    } finally {
      // A round that failed halfway leaves no like behind.
      if (Browse.state.likedOf(gid) != null) {
        runCatching { browsers.lastOrNull()?.let { b -> on { b.sendCustomCommand(AutoLibrary.LIKE, Bundle.EMPTY) }.await() } }
      }
      Browse.flush()
      val tmp = File(ctx.filesDir, "browse.json.test")
      tmp.writeBytes(saved)
      assertTrue(tmp.renameTo(file))
    }
    assertTrue("browse.json is as it was", saved.contentEquals(file.readBytes()))
  }

  private fun heartRounds(albumId: String, gid: String) {
    val b = connect()
    autoRoot(b)
    played = true
    on {
      b.setMediaItem(MediaItem.Builder().setMediaId("tr:al:$albumId:$gid").build())
      b.prepare()
    }
    val end = SystemClock.elapsedRealtime() + 20_000
    while (on { b.currentMediaItem?.mediaId } != gid && SystemClock.elapsedRealtime() < end) SystemClock.sleep(100)
    // The player's own item: a change of the extras alone reaches the controllers' copies only at their next timeline change.
    fun playing(): MediaItem? {
      var item: MediaItem? = null
      InstrumentationRegistry.getInstrumentation().runOnMainSync { item = Browse.session?.player?.currentMediaItem }
      return item
    }
    fun liked() = playing()?.let { Playback.likedOf(it) }
    fun heart() = on { b.mediaButtonPreferences.firstOrNull { it.sessionCommand == AutoLibrary.LIKE } }
    val before = liked()!!
    assertFalse("the song is not liked to begin with", before)
    assertEquals("Aggiungi a Mi piace", heart()!!.displayName.toString())
    for (round in 1..2) {
      val want = round == 1
      val r = on { b.sendCustomCommand(AutoLibrary.LIKE, Bundle.EMPTY) }.await()
      assertEquals("round $round", androidx.media3.session.SessionResult.RESULT_SUCCESS, r.resultCode)
      val until = SystemClock.elapsedRealtime() + 10_000
      while (liked() != want && SystemClock.elapsedRealtime() < until) SystemClock.sleep(100)
      assertEquals("round $round", want, liked())
      assertEquals(if (want) listOf(gid) else emptyList<String>(), Playback.likedIdsOf(playing()!!))
      assertEquals(if (want) "Rimuovi da Mi piace" else "Aggiungi a Mi piace", heart()!!.displayName.toString())
      // The car's Mi piace follows with the page closed.
      assertEquals(want, Browse.state.snapshot!!.liked.firstOrNull()?.id == gid)
      assertEquals(want, Browse.state.likedOf(gid) != null)
    }
  }

  /** The heart's and the covers' gate after a suspension: the worklet's last flags do not count, its resume does. */
  @Test
  fun aSuspendedCoreIsAwakeAgainBeforeARequestGoes() {
    val s = snapshot()
    val until = SystemClock.elapsedRealtime() + 30_000
    fun upSource() = s?.tracks?.flatMap { t -> t.versions.map { it.sourceId } }?.firstOrNull { Links.isUp(it) }
    while ((CoreHost.awakeSince == null || upSource() == null) && SystemClock.elapsedRealtime() < until) SystemClock.sleep(200)
    val src = upSource()
    assumeTrue("no source up", src != null)
    InstrumentationRegistry.getInstrumentation().runOnMainSync { CoreHost.suspend() }
    assertEquals("suspended, so not awake", null, CoreHost.awakeSince)
    var awakeWhenSent: Long? = null
    val began = SystemClock.elapsedRealtime()
    val up = CoreHost.gate.use("test", src!!) { u ->
      awakeWhenSent = CoreHost.awakeSince
      u
    }
    Log.i(TAG, "gate after a suspension: up $up in ${SystemClock.elapsedRealtime() - began} ms")
    assertNotNull("the request went before the worklet resumed", awakeWhenSent)
    assertTrue(up)
  }

  @Test
  fun aCoverOpensThroughTheContentResolver() {
    val s = snapshot()
    val art = s?.albums?.firstNotNullOfOrNull { it.art } ?: s?.tracks?.firstNotNullOfOrNull { it.art }
    assumeTrue("no cover in the snapshot", art != null)
    for (size in listOf("large", "small")) {
      val uri = android.net.Uri.parse(art!!.uri(size))
      val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
      assertTrue("$size: ${bytes.size} bytes", bytes.size > 100)
      assertNotNull(size, Artwork.typeOf(bytes))
      assertTrue(ctx.contentResolver.getType(uri)!!.startsWith("image/"))
    }
    // Anything but a cover path is not there.
    val bad = android.net.Uri.parse("content://com.baccarancia.mpfy.art/cover/${art!!.sourceId}/x/large")
    assertTrue(runCatching { ctx.contentResolver.openInputStream(bad)!!.close() }.isFailure)
  }

  @Test
  fun theCarAndTheNotificationGetTheHeartAndThePlayerCommands() {
    val full = Controllers.commandsFor(auto = true, verified = true, trusted = false, notification = false)
    assertTrue(AutoLibrary.sessionCommands(full).contains(AutoLibrary.LIKE))
    assertTrue(AutoLibrary.playerCommands(full).contains(Player.COMMAND_SET_MEDIA_ITEM))
    assertTrue(AutoLibrary.playerCommands(full).contains(Player.COMMAND_PLAY_PAUSE))
    val untrusted = Controllers.commandsFor(auto = true, verified = false, trusted = false, notification = false)
    assertFalse(AutoLibrary.sessionCommands(untrusted).contains(AutoLibrary.LIKE))
    assertFalse(AutoLibrary.playerCommands(untrusted).contains(Player.COMMAND_SET_MEDIA_ITEM))
    assertFalse(AutoLibrary.playerCommands(untrusted).contains(Player.COMMAND_PLAY_PAUSE))
    // The library is the person's own: any other app gets none of it, not even to read.
    val library = listOf(
      SessionCommand.COMMAND_CODE_LIBRARY_GET_LIBRARY_ROOT,
      SessionCommand.COMMAND_CODE_LIBRARY_SUBSCRIBE,
      SessionCommand.COMMAND_CODE_LIBRARY_GET_CHILDREN,
      SessionCommand.COMMAND_CODE_LIBRARY_GET_ITEM,
      SessionCommand.COMMAND_CODE_LIBRARY_SEARCH,
      SessionCommand.COMMAND_CODE_LIBRARY_GET_SEARCH_RESULT,
    )
    for (code in library) {
      assertFalse("untrusted $code", AutoLibrary.sessionCommands(untrusted).contains(code))
      assertTrue("full $code", AutoLibrary.sessionCommands(full).contains(code))
    }
    // This app's own browser is trusted: it holds the heart.
    val b = connect()
    assertTrue(on { b.isSessionCommandAvailable(AutoLibrary.LIKE) })
    assertTrue(on { b.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM) })
  }
}
