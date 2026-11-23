package com.baccarancia.mpfy

import android.content.pm.PackageInstaller
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** The items the player gets, on Android's own classes (Bundle, Uri, MediaItem). */
@RunWith(AndroidJUnit4::class)
class PlaybackItemsTest {
  private val src = "a3435d00"
  private val track = "0123456789abcdef01234567"
  private val cover = "fedcba9876543210fedcba98"

  private fun queueItem(): JSONObject = JSONObject()
    .put("id", track)
    .put("title", "Last Scene")
    .put("artist", "NEA")
    .put("album", "Blue Regret")
    .put("albumArtist", "NEA")
    .put("trackNo", 3)
    .put("artworkUrl", "$ORIGIN/s/$src/api/cover/$cover?size=large")
    .put("url", "$ORIGIN/s/$src/api/stream/$track?q=high&f=$track")
    .put("quality", "high")
    .put("durationMs", 245_300)
    .put("versions", JSONArray().put(JSONObject().put("sourceId", src).put("trackId", track).put("fileHash", track).put("url", "$ORIGIN/s/$src/api/stream/$track?q=high&f=$track").put("offsetMs", 0)))
    .put("liked", true)
    .put("likedIds", JSONArray().put(track))
    .put("ctx", JSONObject().put("k", "album").put("id", "00000000000000a1"))

  private fun checkFields(item: MediaItem) {
    val m = item.mediaMetadata
    assertEquals(track, item.mediaId)
    assertEquals("Last Scene", m.title.toString())
    assertEquals("NEA", m.artist.toString())
    assertEquals("Blue Regret", m.albumTitle.toString())
    assertEquals("NEA", m.albumArtist.toString())
    assertEquals(3, m.trackNumber)
    assertEquals(245_300L, m.durationMs)
    assertEquals(MediaMetadata.MEDIA_TYPE_MUSIC, m.mediaType)
    assertEquals(true, m.isPlayable)
    assertEquals(false, m.isBrowsable)
    assertEquals(Uri.parse("content://com.baccarancia.mpfy.art/cover/$src/$cover/large"), m.artworkUri)
    assertEquals(true, Playback.likedOf(item))
    assertEquals(listOf(track), Playback.likedIdsOf(item))
    assertEquals(QueueCtx("album", "00000000000000a1"), Playback.ctxOf(item))
  }

  @Test
  fun aQueueItemCarriesTheBluetoothMetadataAndOurArtwork() {
    val item = Playback.itemOf(queueItem(), register = false)
    checkFields(item)
    assertEquals("high", Playback.levelOf(item))
  }

  @Test
  fun anItemPassedThroughAControllerKeepsItsArtworkMetadataLikeAndContext() {
    val item = Playback.itemOf(queueItem(), register = false)
    // What reaches the session from a MediaController: a bundle, without the local configuration.
    val sent = MediaItem.fromBundle(item.buildUpon().setUri(null as Uri?).build().toBundle())
    assertNull(sent.localConfiguration)
    val back = Playback.withLocalConfiguration(sent)
    checkFields(back)
    assertEquals(Playback.keyOf(item), Playback.keyOf(back))
    assertEquals(item.localConfiguration!!.uri, back.localConfiguration!!.uri)
  }

  @Test
  fun artworkFromAnotherAppOrHostIsDropped() {
    for (art in listOf("content://media/external/images/media/12", "https://example.org/a.jpg", "http://127.0.0.1:47124/s/$src/api/cover/$cover")) {
      val item = Playback.itemOf(queueItem().put("artworkUrl", art), register = false)
      assertNull(art, item.mediaMetadata.artworkUri)
      val sent = item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setArtworkUri(Uri.parse(art)).build()).build()
      assertNull(art, Playback.withLocalConfiguration(sent).mediaMetadata.artworkUri)
    }
    val small = Playback.itemOf(queueItem().put("artworkUrl", "$ORIGIN/s/$src/api/cover/$cover?size=small"), register = false)
    assertEquals("content://com.baccarancia.mpfy.art/cover/$src/$cover/small", small.mediaMetadata.artworkUri.toString())
  }

  @Test
  fun aLikeChangeKeepsTheStreamAndTheContext() {
    val item = Playback.itemOf(queueItem(), register = false)
    val un = Playback.withLiked(item, false, emptyList())
    assertEquals(false, Playback.likedOf(un))
    assertEquals(emptyList<String>(), Playback.likedIdsOf(un))
    assertEquals(item.localConfiguration, un.localConfiguration)
    assertEquals(Playback.keyOf(item), Playback.keyOf(un))
    assertEquals(Playback.versionsOf(item), Playback.versionsOf(un))
    assertEquals(QueueCtx("album", "00000000000000a1"), Playback.ctxOf(un))
    assertEquals(item.mediaMetadata.artworkUri, un.mediaMetadata.artworkUri)
  }

  @Test
  fun aLibraryContextHasNoId() {
    val item = Playback.itemOf(queueItem().put("ctx", JSONObject().put("k", "library").put("id", JSONObject.NULL)), register = false)
    assertEquals(QueueCtx("library", null), Playback.ctxOf(item))
    val none = Playback.itemOf(queueItem().put("ctx", JSONObject.NULL), register = false)
    assertNull(Playback.ctxOf(none))
  }

  @Test
  fun theInstallerStatusCodesAreAndroids() {
    assertEquals(PackageInstaller.STATUS_PENDING_USER_ACTION, UpdateMachine.STATUS_PENDING_USER_ACTION)
    assertEquals(PackageInstaller.STATUS_SUCCESS, UpdateMachine.STATUS_SUCCESS)
    assertEquals(PackageInstaller.STATUS_FAILURE_ABORTED, UpdateMachine.STATUS_FAILURE_ABORTED)
  }
}
