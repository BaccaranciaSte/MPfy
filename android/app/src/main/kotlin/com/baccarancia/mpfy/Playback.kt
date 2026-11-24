package com.baccarancia.mpfy

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** What the PlaybackService and the bridge share in the process. */
object Playback {
  private const val TAG = "MPfyPlayback"
  val LEVELS = Levels.ALL
  // Level asked by the page, the cache key the item plays from, and its versions in order.
  private const val EXTRA_QUALITY = "mpfy.quality"
  private const val EXTRA_KEY = "mpfy.key"
  private const val EXTRA_VERSIONS = "mpfy.versions"
  // In MediaMetadata.extras, the only extras every item path keeps (buildUpon, Playback.build):
  // the like state of the song's group and the context it was queued from.
  private const val EXTRA_LIKED = "mpfy.liked"
  // The volume the item plays at, 0..1 ("Volume uniforme", web/js/loudness.js).
  private const val EXTRA_GAIN = "mpfy.gain"
  private const val EXTRA_LIKED_IDS = "mpfy.likedIds"
  private const val EXTRA_CTX = "mpfy.ctx"
  private const val QUEUE_FILE = "last-queue.json"
  private const val PREFS = "mpfy"

  /** Each playing item's versions, by its cache key. */
  val registry = VersionRegistry()

  /** True while MainActivity's bridge is connected: the page decides what a failed track does. */
  @Volatile
  var uiAttached = false

  /** Who set the list the player holds (queueId). Main thread. */
  val owner = QueueOwner()

  /**
   * The session's own player, which the page's commands act on directly: one order on the main
   * thread with the notification, the lock screen, Bluetooth and the car, and its real index.
   * Set by the PlaybackService; main thread.
   */
  var player: Player? = null

  /** A track that failed on every version: the page hears it. */
  fun interface ErrorListener {
    fun onFinalError(message: String, itemId: String?)
  }

  private val errorListeners = CopyOnWriteArrayList<ErrorListener>()

  fun addErrorListener(l: ErrorListener) {
    errorListeners.add(l)
  }

  fun removeErrorListener(l: ErrorListener) {
    errorListeners.remove(l)
  }

  fun finalError(message: String, itemId: String?) {
    for (l in errorListeners) l.onFinalError(message, itemId)
  }

  /** The level an X-MPfy-Quality response header names, or null. */
  fun servedLevel(headers: Map<String, List<String>>): String? =
    Levels.ofHeader(headers.entries.firstOrNull { it.key.equals("X-MPfy-Quality", ignoreCase = true) }?.value?.firstOrNull())

  fun keyOf(item: MediaItem): String? =
    item.requestMetadata.extras?.getString(EXTRA_KEY) ?: item.localConfiguration?.customCacheKey

  fun levelOf(item: MediaItem): String = item.requestMetadata.extras?.getString(EXTRA_QUALITY)?.takeIf { it in LEVELS } ?: "max"

  fun uriOf(item: MediaItem): Uri = item.localConfiguration?.uri ?: item.requestMetadata.mediaUri ?: Uri.EMPTY

  /** The level served for this item: the level of the download it plays from, or of its stream's response. */
  fun qualityOf(item: MediaItem): String? {
    val key = keyOf(item) ?: return null
    if (Downloads.isDownloaded(key)) Levels.ofKey(key)?.let { return it }
    return StreamCache.servedOf(key)
  }

  /** The version an item plays: the one its key names. */
  fun playingOf(item: MediaItem): Version? {
    val key = keyOf(item) ?: return null
    registry.get(key)?.versionOf(key)?.let { return it }
    return versionsOf(item).firstOrNull { it.isNamedBy(key) }
  }

  /** Only our own origin: the bridge never hands the player another host. */
  fun ownUri(url: String?): Uri {
    if (url.isNullOrEmpty()) return Uri.EMPTY
    val u = Uri.parse(url)
    return if (u.scheme == "http" && u.host == "127.0.0.1" && u.port == CORE_PORT) u else Uri.EMPTY
  }

  /** The artwork of every item, whatever path built it (Artwork.of): our content URI, or none. */
  fun artworkOf(url: String?): Uri? = Artwork.of(url)?.let { Uri.parse(it) }

  /**
   * One queue item of setQueue: { id, title, artist, album, albumArtist, trackNo, artworkUrl, url,
   * quality, durationMs, versions: [{ sourceId, trackId, fileHash, url, offsetMs }], liked,
   * likedIds, ctx }. Versions with a finished download go first; the item plays from its first
   * version's key. [register]: put its versions in the registry now (the session does it for the
   * items it receives).
   */
  fun itemOf(o: JSONObject, register: Boolean): MediaItem {
    val id = o.optString("id")
    val q = o.optString("quality").takeIf { it in LEVELS } ?: "max"
    val trackNo = if (o.opt("trackNo") is Number) o.optInt("trackNo") else null
    val likedIds = o.optJSONArray("likedIds")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { Levels.isId(it) } }.orEmpty()
    val ctx = o.optJSONObject("ctx")?.let { c -> QueueCtx.of(mapOf("k" to c.optString("k"), "id" to (if (c.isNull("id")) null else c.optString("id")))) }
    val meta = metadata(
      o.optString("title"), o.optString("artist"), o.optString("album"), o.optString("albumArtist").ifEmpty { null }, trackNo,
      o.optLong("durationMs", 0), artworkOf(o.optString("artworkUrl")), o.optBoolean("liked", false), likedIds, ctx,
      gain = o.optDouble("gain", 1.0).takeIf { it.isFinite() && it > 0.0 && it <= 1.0 }?.toFloat() ?: 1f,
    )
    val versions = VersionOrder.order(versionsOf(o, id), Downloads.completedKeys)
    return build(id, q, meta, versions, emptySet(), register)
  }

  /** The metadata the session publishes: title, artist, album, album artist, track number, duration and cover (Bluetooth, lock screen, the car). */
  fun metadata(
    title: String,
    artist: String,
    album: String,
    albumArtist: String?,
    trackNo: Int?,
    durationMs: Long,
    art: Uri?,
    liked: Boolean,
    likedIds: List<String>,
    ctx: QueueCtx?,
    gain: Float = 1f,
  ): MediaMetadata {
    val b = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setAlbumTitle(album)
      .setAlbumArtist(albumArtist)
      .setTrackNumber(trackNo?.takeIf { it > 0 })
      .setArtworkUri(art)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
      .setIsPlayable(true)
      .setIsBrowsable(false)
      .setExtras(extrasOf(liked, likedIds, ctx, gain))
    if (durationMs > 0) b.setDurationMs(durationMs)
    return b.build()
  }

  private fun extrasOf(liked: Boolean, likedIds: List<String>, ctx: QueueCtx?, gain: Float = 1f) = Bundle().apply {
    putBoolean(EXTRA_LIKED, liked)
    putStringArrayList(EXTRA_LIKED_IDS, ArrayList(likedIds))
    if (ctx != null) putString(EXTRA_CTX, ctx.toJson())
    if (gain < 1f) putFloat(EXTRA_GAIN, gain)
  }

  /** The volume an item plays at (1: as it is). */
  fun gainOf(item: MediaItem?): Float = item?.mediaMetadata?.extras?.getFloat(EXTRA_GAIN, 1f)?.takeIf { it > 0f && it <= 1f } ?: 1f

  fun likedOf(item: MediaItem): Boolean = item.mediaMetadata.extras?.getBoolean(EXTRA_LIKED, false) == true

  fun likedIdsOf(item: MediaItem): List<String> = item.mediaMetadata.extras?.getStringArrayList(EXTRA_LIKED_IDS).orEmpty()

  fun ctxOf(item: MediaItem): QueueCtx? = QueueCtx.parse(item.mediaMetadata.extras?.getString(EXTRA_CTX))

  /** The same item with another like state (its stream and versions untouched). */
  fun withLiked(item: MediaItem, liked: Boolean, likedIds: List<String>): MediaItem {
    val old = item.mediaMetadata.extras
    val extras = if (old != null) Bundle(old) else Bundle()
    extras.putBoolean(EXTRA_LIKED, liked)
    extras.putStringArrayList(EXTRA_LIKED_IDS, ArrayList(likedIds))
    return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
  }

  /** The versions of a setQueue item; an item of an older queue is one version, its file the track's own. */
  private fun versionsOf(o: JSONObject, id: String): List<Version> {
    val arr = o.optJSONArray("versions")
    if (arr != null && arr.length() > 0) return parseVersions(arr)
    val u = ownUri(o.optString("url"))
    val seg = u.pathSegments
    if (seg.size >= 5 && seg[0] == "s" && seg[2] == "api" && seg[3] == "stream" && Levels.isId(seg[1]) && Levels.isId(id)) {
      return listOf(Version(seg[1], id, id, u.toString(), 0))
    }
    return emptyList()
  }

  private fun parseVersions(arr: JSONArray): List<Version> {
    val out = ArrayList<Version>()
    for (i in 0 until arr.length()) {
      val v = arr.optJSONObject(i) ?: continue
      val sourceId = v.optString("sourceId")
      val trackId = v.optString("trackId")
      val fileHash = v.optString("fileHash").ifEmpty { trackId }
      if (!Levels.isId(sourceId) || !Levels.isId(trackId) || !Levels.isId(fileHash)) continue
      val url = ownUri(v.optString("url")).let { if (it == Uri.EMPTY) "" else it.toString() }
      out.add(Version(sourceId, trackId, fileHash, url, v.optLong("offsetMs", 0)))
    }
    return out
  }

  private fun versionsJson(versions: List<Version>): String {
    val arr = JSONArray()
    for (v in versions) {
      arr.put(JSONObject().put("sourceId", v.sourceId).put("trackId", v.trackId).put("fileHash", v.fileHash).put("url", v.url).put("offsetMs", v.offsetMs))
    }
    return arr.toString()
  }

  /** The versions an item carries, in its order. */
  fun versionsOf(item: MediaItem): List<Version> {
    val s = item.requestMetadata.extras?.getString(EXTRA_VERSIONS) ?: return emptyList()
    return runCatching { parseVersions(JSONArray(s)) }.getOrDefault(emptyList())
  }

  /** The item with these versions, in this order, playing the first one's key. */
  fun build(id: String, q: String, meta: MediaMetadata, versions: List<Version>, tried: Set<String>, register: Boolean): MediaItem {
    val first = versions.firstOrNull()
    val key = if (first != null) VersionOrder.keyOf(first, q, Downloads.completedKeys) else "none:$id"
    // At the item's level, whatever level the page's URL asked (a list given to the item playing).
    val uri = first?.let { v -> Uri.parse(streamUrl(ORIGIN, v, q)) } ?: Uri.EMPTY
    if (register && first != null) registry.put(key, VersionRegistry.Entry(id, q, versions, tried))
    val extras = Bundle().apply {
      putString(EXTRA_QUALITY, q)
      putString(EXTRA_KEY, key)
      putString(EXTRA_VERSIONS, versionsJson(versions))
    }
    return MediaItem.Builder()
      .setMediaId(id)
      .setUri(uri)
      .setCustomCacheKey(key)
      .setMediaMetadata(meta)
      .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).setExtras(extras).build())
      .build()
  }

  /**
   * An item as the session receives it from a MediaController: its URI may be lost (it is rebuilt
   * from requestMetadata), and a controller of another app may name any address, so the stream and
   * the artwork go through [ownUri] again, the cache key is chosen again and the versions registered.
   */
  fun withLocalConfiguration(item: MediaItem): MediaItem {
    val q = levelOf(item)
    var versions = versionsOf(item)
    if (versions.isEmpty()) {
      // An item of an older app: one version from its URI.
      val o = JSONObject().put("url", (item.localConfiguration?.uri ?: item.requestMetadata.mediaUri)?.toString() ?: "")
      versions = versionsOf(o, item.mediaId)
    }
    val meta = item.mediaMetadata.buildUpon().setArtworkUri(artworkOf(item.mediaMetadata.artworkUri?.toString())).build()
    return build(item.mediaId, q, meta, VersionOrder.order(versions, Downloads.completedKeys), emptySet(), register = true)
  }

  /** An item that goes into the player: its versions, as it carries them, become its key's entry. */
  fun register(item: MediaItem) {
    val key = keyOf(item) ?: return
    val versions = versionsOf(item)
    if (versions.isNotEmpty()) registry.put(key, VersionRegistry.Entry(item.mediaId, levelOf(item), versions))
  }

  /** An item of a long queue the registry dropped meanwhile: its versions come back from the item itself. */
  fun ensureRegistered(item: MediaItem): VersionRegistry.Entry? {
    val key = keyOf(item) ?: return null
    registry.get(key)?.let { return it }
    val versions = versionsOf(item)
    if (versions.isEmpty()) return null
    return VersionRegistry.Entry(item.mediaId, levelOf(item), versions).also { registry.put(key, it) }
  }

  /**
   * The item playing keeps playing, at its key's level; the page's new order of its versions
   * replaces the old one (tried ones stay tried), with the version playing kept in it.
   */
  fun updatePlaying(playing: MediaItem, fresh: MediaItem) {
    val key = keyOf(playing) ?: return
    val entry = registry.get(key)
    val level = entry?.level ?: levelOf(playing)
    val old = entry?.versions ?: versionsOf(playing)
    val news = VersionOrder.order(versionsOf(fresh), Downloads.completedKeys)
    if (news.isEmpty()) return
    val now = old.firstOrNull { it.isNamedBy(key) }
    registry.update(key, playing.mediaId, level, if (now != null) VersionOrder.forPlaying(old, news, now) else news)
  }

  fun itemsOf(arr: JSONArray, register: Boolean): List<MediaItem> = (0 until arr.length()).map { itemOf(arr.getJSONObject(it), register) }

  // --- the last queue, for a media button pressed while the app is not running ---

  private val saver = Executors.newSingleThreadExecutor()
  @Volatile private var pendingQueue: String? = null

  /** A list the page did not set (the car): kept as the last queue too, in setQueue's shape. */
  fun saveItems(context: Context, items: List<MediaItem>, index: Int, queueId: String?) {
    val arr = JSONArray()
    for (item in items) {
      val m = item.mediaMetadata
      val o = JSONObject()
        .put("id", item.mediaId)
        .put("title", m.title?.toString() ?: "")
        .put("artist", m.artist?.toString() ?: "")
        .put("album", m.albumTitle?.toString() ?: "")
        .put("albumArtist", m.albumArtist?.toString() ?: "")
        .put("trackNo", m.trackNumber ?: JSONObject.NULL)
        .put("artworkUrl", m.artworkUri?.toString() ?: "")
        .put("quality", levelOf(item))
        .put("durationMs", m.durationMs ?: 0L)
        .put("versions", JSONArray(versionsJson(versionsOf(item))))
        .put("liked", likedOf(item))
        .put("likedIds", JSONArray(likedIdsOf(item)))
        .put("ctx", ctxOf(item)?.let { c -> JSONObject().put("k", c.kind).put("id", c.id ?: JSONObject.NULL) } ?: JSONObject.NULL)
      arr.put(o)
    }
    saveQueue(context, JSONObject().put("queueId", queueId ?: JSONObject.NULL).put("items", arr).put("index", index).toString())
  }

  /** Keeps the last setQueue (only the newest is written; off the caller's thread). */
  fun saveQueue(context: Context, json: String) {
    pendingQueue = json
    val file = File(context.filesDir, QUEUE_FILE)
    saver.execute {
      val text = pendingQueue ?: return@execute
      pendingQueue = null
      try {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) file.writeText(text)
      } catch (e: Exception) {
        Log.w(TAG, "queue not saved", e)
      }
    }
  }

  fun savePosition(context: Context, index: Int, positionMs: Long) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putInt("resumeIndex", index).putLong("resumePositionMs", positionMs).apply()
  }

  /** The saved queue, its index and position, or null. */
  fun loadQueue(context: Context): Triple<List<MediaItem>, Int, Long>? {
    val file = File(context.filesDir, QUEUE_FILE)
    if (!file.isFile) return null
    return try {
      val o = JSONObject(file.readText())
      val items = itemsOf(o.getJSONArray("items"), register = true)
      if (items.isEmpty()) return null
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val index = prefs.getInt("resumeIndex", o.optInt("index", 0)).coerceIn(0, items.size - 1)
      Triple(items, index, prefs.getLong("resumePositionMs", 0).coerceAtLeast(0))
    } catch (e: Exception) {
      Log.w(TAG, "saved queue unreadable", e)
      null
    }
  }
}
