package com.baccarancia.mpfy

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The car's snapshot in the process, kept on disk so Android Auto browses with the UI closed:
 * whole in filesDir/browse.json (bridges 4 to 6), or in pages in filesDir/browse/ (index.json and
 * page-<n>.json, bridge 7), each file written as the page sent it. Replaced by the page's newer
 * ones, told to the browsers that follow a node.
 */
object Browse {
  private const val TAG = "MPfyBrowse"
  private const val FILE = "browse.json"
  private const val DIR = "browse"
  private const val INDEX = "index.json"
  private val PAGE_FILE = Regex("page-(\\d+)\\.json")
  private const val NOTIFY_MS = 300L
  val state = BrowseState()
  private val io = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private var app: Context? = null
  private val loaded: SettableFuture<Unit> = SettableFuture.create()
  private var loading = false

  /** The library session, while the PlaybackService runs. Main thread. */
  var session: MediaLibraryService.MediaLibrarySession? = null

  // Nodes a browser follows (onSubscribe); those no one follows any more go at the next notice.
  private val followed = ConcurrentHashMap.newKeySet<String>()

  fun init(ctx: Context) {
    if (app == null) app = ctx.applicationContext
  }

  private fun pageFile(dir: File, n: Int) = File(dir, "page-$n.json")

  /**
   * Reads the snapshot once, off the main thread (PlaybackService.onCreate, and before the first
   * page or index the page sends): the pages and their index when there is one, else browse.json.
   */
  @Synchronized
  fun load() {
    if (loading) return
    loading = true
    io.execute {
      try {
        val files = app!!.filesDir
        val dir = File(files, DIR)
        val idx = File(dir, INDEX)
        if (state.snapshot == null && idx.isFile) {
          val i = Snapshot.parseIndex(idx.readText())
          if (i != null) {
            for (n in i.pages) {
              val f = pageFile(dir, n)
              val p = if (f.isFile) Snapshot.parsePage(f.readText()) else null
              if (p != null && p.n == n) state.putPage(p) else Log.w(TAG, "page $n missing or unreadable: the page sends it again")
            }
            state.putIndex(i)
            Log.i(TAG, "snapshot loaded: ${state.snapshot?.tracks?.size} songs in ${i.pages.size} pages")
          } else {
            Log.w(TAG, "browse/index.json unreadable: kept for the next one")
          }
        }
        val f = File(files, FILE)
        if (state.snapshot == null && f.isFile) {
          val s = Snapshot.parse(f.readText())
          if (s != null) {
            if (state.snapshot == null) state.replace(s)
            Log.i(TAG, "snapshot loaded: ${s.tracks.size} songs")
          } else {
            Log.w(TAG, "browse.json unreadable: kept for the next one")
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "browse.json", e)
      } finally {
        loaded.set(Unit)
      }
    }
  }

  /** Done once the files were read (or there were none). */
  fun whenLoaded(): ListenableFuture<Unit> = loaded

  /** getBrowsePages: what the app holds in pages; { loading: true } while it is still reading them. */
  fun held(): String {
    load()
    return if (loaded.isDone) state.held() else "{\"loading\":true}"
  }

  /** setBrowseSnapshot: parsed off the main thread; anything without the shape is ignored. */
  fun offer(text: String) {
    load()
    io.execute {
      val s = Snapshot.parse(text)
      if (s == null) {
        Log.w(TAG, "snapshot ignored: not the expected shape (${text.length} chars)")
        return@execute
      }
      write(File(app?.filesDir ?: return@execute, FILE), text)
      state.replace(s)
      File(app!!.filesDir, DIR).listFiles()?.forEach { it.delete() }
      Log.i(TAG, "new snapshot: ${s.tracks.size} songs, ${s.albums.size} albums, ${s.playlists.size} playlists")
      main.post { notifyFollowed() }
    }
  }

  /** setBrowsePage: one page, parsed off the main thread; shown at once when its index is here. */
  fun offerPage(n: Int, text: String) {
    load()
    io.execute {
      val p = Snapshot.parsePage(text)
      if (p == null || p.n != n) {
        Log.w(TAG, "page $n ignored: not the expected shape (${text.length} chars)")
        return@execute
      }
      if (!state.putPage(p)) {
        Log.w(TAG, "page $n ignored: more songs than the car holds")
        return@execute
      }
      val dir = File(app?.filesDir ?: return@execute, DIR)
      dir.mkdirs()
      write(pageFile(dir, n), text)
      notifySoon()
    }
  }

  /** setBrowseIndex: the index, parsed off the main thread; the pages it does not name go. */
  fun offerIndex(text: String) {
    load()
    io.execute {
      val i = Snapshot.parseIndex(text)
      if (i == null) {
        Log.w(TAG, "index ignored: not the expected shape (${text.length} chars)")
        return@execute
      }
      val files = app?.filesDir ?: return@execute
      val dir = File(files, DIR)
      dir.mkdirs()
      write(File(dir, INDEX), text)
      state.putIndex(i)
      // Pages it does not name, those dropped now and any left by an earlier run.
      val named = i.pages.toHashSet()
      dir.listFiles()?.forEach { f -> PAGE_FILE.matchEntire(f.name)?.let { m -> if (m.groupValues[1].toIntOrNull() !in named) f.delete() } }
      File(files, FILE).delete()
      val s = state.snapshot
      Log.i(TAG, "new index: ${s?.tracks?.size} songs in ${s?.pages?.size} pages, ${i.albums.size} albums, ${i.playlists.size} playlists")
      notifySoon()
    }
  }

  /** The heart changed the liked list: browse.json, or the index, is written again. */
  fun persist(s: Snapshot) {
    io.execute {
      val files = app?.filesDir ?: return@execute
      if (s.paged) write(File(File(files, DIR), INDEX), s.index.toJson()) else write(File(files, FILE), s.toJson())
    }
  }

  /** Returns once every write asked before has landed (the device test puts the file back after it). */
  @androidx.annotation.VisibleForTesting
  fun flush() {
    io.submit {}.get()
  }

  private fun write(file: File, text: String) {
    try {
      val tmp = File(file.parentFile, "${file.name}.tmp")
      tmp.writeText(text)
      if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
    } catch (e: Exception) {
      Log.w(TAG, "${file.name} not written", e)
    }
  }

  // Pages come one after the other: the browsers hear of them once.
  private val notifyTask = Runnable { notifyFollowed() }

  private fun notifySoon() {
    main.removeCallbacks(notifyTask)
    main.postDelayed(notifyTask, NOTIFY_MS)
  }

  fun tree(labels: Labels): BrowseTree = BrowseTree(state.snapshot ?: EMPTY, labels)

  fun followed(parentId: String) {
    followed.add(parentId)
  }

  /** One node's children changed (the heart and "Mi piace"). Any thread. */
  fun notifyChanged(parentId: String) {
    main.post {
      val s = session ?: return@post
      val n = app?.let { tree(AutoLibrary.labels(it)).children(parentId, null)?.size } ?: 0
      s.notifyChildrenChanged(parentId, n, null)
    }
  }

  /** A new snapshot: every node someone follows. Main thread. */
  private fun notifyFollowed() {
    val s = session ?: return
    val ctx = app ?: return
    val t = tree(AutoLibrary.labels(ctx))
    for (id in followed.toList()) {
      if (s.getSubscribedControllers(id).isEmpty()) {
        followed.remove(id)
        continue
      }
      s.notifyChildrenChanged(id, t.children(id, null)?.size ?: 0, null)
    }
  }

  private val EMPTY = Snapshot(0, "max", "high", emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList())
}

/** The car's MediaItems: browse nodes, and the songs a tap queues. */
@OptIn(UnstableApi::class)
object AutoLibrary {
  val LIKE = SessionCommand(Likes.COMMAND, android.os.Bundle.EMPTY)

  fun labels(ctx: Context) = Labels(
    ctx.getString(R.string.auto_recent),
    ctx.getString(R.string.auto_playlists),
    ctx.getString(R.string.auto_albums),
    ctx.getString(R.string.auto_artists),
    ctx.getString(R.string.auto_liked),
    ctx.getString(R.string.auto_library),
    ctx.getString(R.string.auto_one_track),
    ctx.getString(R.string.auto_tracks),
  )

  private fun typeOf(k: NodeKind): Int = when (k) {
    NodeKind.FOLDER_MIXED -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    NodeKind.FOLDER_ALBUMS -> MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS
    NodeKind.FOLDER_ARTISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS
    NodeKind.FOLDER_PLAYLISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS
    NodeKind.ALBUM -> MediaMetadata.MEDIA_TYPE_ALBUM
    NodeKind.ARTIST -> MediaMetadata.MEDIA_TYPE_ARTIST
    NodeKind.PLAYLIST -> MediaMetadata.MEDIA_TYPE_PLAYLIST
    NodeKind.MUSIC -> MediaMetadata.MEDIA_TYPE_MUSIC
  }

  fun mediaItem(n: Node): MediaItem {
    val m = MediaMetadata.Builder()
      .setTitle(n.title)
      .setSubtitle(n.subtitle)
      .setIsBrowsable(!n.playable)
      .setIsPlayable(n.playable)
      .setMediaType(typeOf(n.kind))
      .setArtworkUri(n.artUri?.let { Uri.parse(it) })
    if (n.kind == NodeKind.ALBUM) m.setArtist(n.subtitle).setAlbumTitle(n.title)
    n.track?.let { t ->
      m.setArtist(t.artist).setAlbumTitle(n.album).setAlbumArtist(t.albumArtist).setTrackNumber(t.trackNo?.takeIf { it > 0 })
      if (t.durationMs > 0) m.setDurationMs(t.durationMs)
    }
    return MediaItem.Builder().setMediaId(n.id).setMediaMetadata(m.build()).build()
  }

  /**
   * One song as the player plays it from the car: its group id as the media id, the metadata of
   * the page's items, its versions (downloaded, on a source up now, the rest) at the snapshot's
   * level for this network, its like state and context.
   */
  fun carItem(t: SnapTrack, snap: Snapshot, ctx: QueueCtx?): MediaItem {
    val level = snap.levelFor(Net.state.type)
    val versions = CarVersions.order(t, Downloads.completedKeys) { Links.isUp(it) }.map { it.copy(url = streamUrl(ORIGIN, it, level)) }
    val likedIds = Browse.state.likedOf(t.id)
    val meta = Playback.metadata(
      t.title, t.artist, snap.albumById[t.albumId]?.name ?: "", t.albumArtist.ifEmpty { null }, t.trackNo, t.durationMs,
      t.art?.uri("large")?.let { Uri.parse(it) }, likedIds != null, likedIds.orEmpty(), ctx,
    )
    return Playback.build(t.id, level, meta, versions, emptySet(), register = true)
  }

  fun carItems(e: Expansion, snap: Snapshot): List<MediaItem> = e.tracks.map { carItem(it, snap, e.ctx) }

  /** The commands a controller gets for its grant. */
  fun sessionCommands(g: Controllers.Grant): SessionCommands =
    if (g.access == Controllers.Access.FULL) {
      MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().apply { if (g.like) add(LIKE) }.build()
    } else {
      MediaSession.ConnectionResult.DEFAULT_UNTRUSTED_SESSION_COMMANDS
    }

  fun playerCommands(g: Controllers.Grant): Player.Commands =
    if (g.access == Controllers.Access.FULL) MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS else MediaSession.ConnectionResult.DEFAULT_UNTRUSTED_PLAYER_COMMANDS
}
