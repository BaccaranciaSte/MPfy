package com.baccarancia.mpfy

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.util.concurrent.Executors

/** When to retry a stream that failed: [StreamRetry], else the default policy (six tries). */
@OptIn(UnstableApi::class)
class StreamErrorPolicy : DefaultLoadErrorHandlingPolicy(6) {
  override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
    val d = StreamRetry.delayFor(info.exception, info.errorCount)
    return if (d == StreamRetry.DEFAULT) super.getRetryDelayMsFor(info) else d
  }
}

/**
 * Media3 library session with ExoPlayer: foreground only while playing, notification, lock
 * screen, Bluetooth and steering wheel buttons, audio focus, pause when the headphones are
 * unplugged, the heart, and Android Auto's library (browse, search, play) from the page's
 * snapshot, and what plays told to the core for the people of the sources ([ActivityReporter]).
 * Streams come from the client core on 127.0.0.1:47123, read through the downloads,
 * then the stream cache the whole-song prefetch fills, then the failover between sources.
 * When a version fails for good, the item moves on to its next one at the same moment of the song.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private var errorStreak = 0
  // A representation that changed again and again under one item is not followed for ever.
  private var changedItem: String? = null
  private var changedCount = 0
  // The heart now shown: null none, else whether it is filled.
  private var heartShown: Boolean? = null
  // Per app (package and uid, so the maps stay small): the root children limit it asked for, and
  // whether it is the car with the full command sets. Media3 never says goodbye for a browser the
  // platform connected, so nothing here waits for onDisconnected.
  private val rootLimits = HashMap<String, Int?>()
  private val cars = HashSet<String>()
  private val main = Handler(Looper.getMainLooper())
  private val carLease = CarLease(Keeper, { r, ms -> main.postDelayed(r, ms) }, { main.removeCallbacks(it) })
  // What plays, for the people of the sources: at each change and every minute while it plays.
  private val activity = ActivityReporter(
    CoreHttp,
    AwakeCall(Keeper, CoreHost, { SystemClock.elapsedRealtime() }, { Thread.sleep(it) }),
    { r -> reports.execute(r) },
    { r, ms -> main.postDelayed(r, ms) },
    { main.removeCallbacks(it) },
  )
  // New messages while the app is in the background and the music plays (bridge 6).
  private val chats = ChatNotifier(
    CoreHttp,
    AwakeCall(Keeper, CoreHost, { SystemClock.elapsedRealtime() }, { Thread.sleep(it) }),
    { r -> chatAsks.execute(r) },
    { r -> main.post(r) },
    { r, ms -> main.postDelayed(r, ms) },
    { main.removeCallbacks(it) },
    Chats,
    { ChatPolicy.active(Keeper.inForeground, session?.player?.isPlaying == true, Chats.enabled(), Chats.allowed()) },
  )
  private val onForeground: () -> Unit = { chats.update() }
  private val onMain by lazy { ContextCompat.getMainExecutor(this) }
  private val automotive by lazy { packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE) }

  override fun onCreate() {
    super.onCreate()
    CoreHost.init(this) // no-op: MPfyApp already did it
    Prefetch.init(this)
    Browse.init(this)
    Browse.load()
    Chats.notifier = chats
    Keeper.addForegroundListener(onForeground)
    // Downloads (read only) -> stream cache (read only: only the prefetch writes it) -> failover.
    val stream = CacheDataSource.Factory()
      .setCache(StreamCache.cache(this))
      .setUpstreamDataSourceFactory(FailoverDataSource.Factory())
      .setCacheWriteDataSinkFactory(null)
    val source = CacheDataSource.Factory()
      .setCache(Downloads.cache(this))
      .setUpstreamDataSourceFactory(stream)
      .setCacheWriteDataSinkFactory(null)
    // ADTS and header-less CBR files become seekable (a seek on unseekable media goes to 0).
    val extractors = DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)
    val media = DefaultMediaSourceFactory(this, extractors)
      .setDataSourceFactory(GuardedDataSource.Factory(source, StreamCache))
      .setLoadErrorHandlingPolicy(StreamErrorPolicy())
    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(media)
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus= */ true,
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    player.addListener(
      object : Player.Listener {
        override fun onEvents(p: Player, events: Player.Events) {
          Keeper.setPlayerBusy(PlayerPolicy.needsCore(p.playWhenReady, p.playbackState, p.isLoading))
          if (events.containsAny(
              Player.EVENT_MEDIA_ITEM_TRANSITION,
              Player.EVENT_TIMELINE_CHANGED,
              Player.EVENT_IS_PLAYING_CHANGED,
              Player.EVENT_POSITION_DISCONTINUITY,
            )
          ) {
            Playback.savePosition(this@PlaybackService, p.currentMediaItemIndex, p.currentPosition)
          }
          if (events.containsAny(
              Player.EVENT_MEDIA_ITEM_TRANSITION,
              Player.EVENT_TIMELINE_CHANGED,
              Player.EVENT_PLAYBACK_STATE_CHANGED,
              Player.EVENT_PLAY_WHEN_READY_CHANGED,
              Player.EVENT_REPEAT_MODE_CHANGED,
              Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,
            )
          ) {
            prefetch(p)
          }
          if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_MEDIA_METADATA_CHANGED)) {
            updateHeart()
          }
          if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION)) activity.update(activityOf(p))
          if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) chats.update()
          if (p.isPlaying) errorStreak = 0
        }

        override fun onPlayerError(error: PlaybackException) {
          Log.w(TAG, "playback error ${error.errorCodeName} on ${player.currentMediaItem?.mediaId}: ${error.cause?.message}")
          if (nextVersion(player, error)) return
          Playback.finalError(error.errorCodeName, player.currentMediaItem?.mediaId)
          if (!Playback.uiAttached) errorStreak++
          // An error keeps playWhenReady: it says whether the listener wanted playback.
          when (PlayerPolicy.afterError(Playback.uiAttached, errorStreak, player.hasNextMediaItem(), player.playWhenReady)) {
            PlayerPolicy.AfterError.NOTHING -> {}
            PlayerPolicy.AfterError.SKIP -> {
              player.seekToNextMediaItem()
              player.prepare()
            }
            PlayerPolicy.AfterError.SKIP_AND_PLAY -> {
              player.seekToNextMediaItem()
              player.prepare()
              player.play()
            }
          }
        }
      },
    )
    val notifications = DefaultMediaNotificationProvider.Builder(this)
      .setChannelName(R.string.channel_playback)
      .build()
    notifications.setSmallIcon(R.drawable.ic_stat_mpfy)
    setMediaNotificationProvider(notifications)
    // In the foreground only while playing (Media3 keeps it 10 minutes after a pause by
    // default). Play from the notification or a media button may start it again: the system
    // allows both.
    setForegroundServiceTimeoutMs(0)
    // Notification and lock screen artwork comes from the core too: same request headers.
    val artwork = DataSourceBitmapLoader.Builder(this)
      .setDataSourceFactory(DefaultDataSource.Factory(this, DefaultHttpDataSource.Factory().setUserAgent("MPfy").setDefaultRequestProperties(CoreHost.requestHeaders)))
      .build()
    // Covers are content URIs of ArtProvider (Playback.artworkOf): DefaultDataSource reads them.
    session = MediaLibrarySession.Builder(this, player, Callback())
      .setBitmapLoader(CacheBitmapLoader(artwork))
      .setSessionActivity(
        PendingIntent.getActivity(
          this,
          0,
          Intent(this, MainActivity::class.java),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      )
      .build()
    Browse.session = session
    Likes.queue = { id, liked, likedIds -> applyLiked(id, liked, likedIds) }
    Playback.player = player
    updateHeart()
  }

  /**
   * Every queue item of song [id] takes the new like state; the heart follows. Only the metadata
   * extras change, which item equality ignores: the player's own items carry the new state (the
   * heart reads it there) and controllers' copies follow at their next timeline change.
   */
  private fun applyLiked(id: String, liked: Boolean, likedIds: List<String>) {
    val p = session?.player ?: return
    for (i in 0 until p.mediaItemCount) {
      val item = p.getMediaItemAt(i)
      if (item.mediaId != id) continue
      if (Playback.likedOf(item) == liked && Playback.likedIdsOf(item) == likedIds) continue
      p.replaceMediaItem(i, Playback.withLiked(item, liked, likedIds))
    }
    heartShown = null
    updateHeart()
  }

  /** What the player plays now, as a report names it. */
  private fun activityOf(p: Player): ActivityState {
    val item = p.currentMediaItem ?: return ActivityState.NONE
    val m = item.mediaMetadata
    val title = m.title?.toString().orEmpty()
    if (title.isEmpty()) return ActivityState.NONE
    val track = ActivityTrack(
      trackId = ActivityState.trackIdOf(Playback.playingOf(item), Playback.versionsOf(item), item.mediaId),
      title = title,
      artist = m.artist?.toString().orEmpty(),
      album = m.albumTitle?.toString().orEmpty(),
      artistPage = ActivityState.artistPage(Playback.ctxOf(item)),
    )
    return ActivityState(track, p.isPlaying)
  }

  /** One heart in the notification and the lock screen, for the item playing. */
  private fun updateHeart() {
    val s = session ?: return
    val liked = s.player.currentMediaItem?.let { Playback.likedOf(it) }
    if (liked == heartShown) return
    heartShown = liked
    s.setMediaButtonPreferences(if (liked == null) ImmutableList.of() else ImmutableList.of(heartButton(liked)))
  }

  private fun heartButton(liked: Boolean): CommandButton =
    CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
      .setDisplayName(getString(if (liked) R.string.like_remove else R.string.like_add))
      .setCustomIconResId(if (liked) R.drawable.ic_heart_filled else R.drawable.ic_heart)
      .setSessionCommand(AutoLibrary.LIKE)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  /** The prefetch follows the item playing and the next one while the player means to play (none while stopped or failed). */
  private fun prefetch(p: Player) {
    if (p.playbackState == Player.STATE_IDLE || p.mediaItemCount == 0) {
      Prefetch.onPlayer(null, null, false)
      return
    }
    val i = p.nextMediaItemIndex
    val curItem = p.currentMediaItem
    val nextItem = if (i == C.INDEX_UNSET) null else p.getMediaItemAt(i)
    curItem?.let { Playback.ensureRegistered(it) }
    nextItem?.let { Playback.ensureRegistered(it) }
    val cur = curItem?.let { prefetchItem(it) }
    val next = nextItem?.let { prefetchItem(it) }
    Prefetch.onPlayer(cur, next, p.playWhenReady)
  }

  /** What the prefetch fetches of an item: its stream; a downloaded version is whole already. */
  private fun prefetchItem(item: MediaItem): PrefetchQueue.Item? {
    val key = Playback.keyOf(item) ?: return null
    val url = Playback.uriOf(item).toString()
    val downloaded = !Levels.isStream(key)
    if (!downloaded && url.isEmpty()) return null
    return PrefetchQueue.Item(item.mediaId, key, url, Playback.levelOf(item), downloaded)
  }

  /**
   * The item that failed plays on from its next version not tried yet, at the same
   * moment of the song; another representation of the same version plays again from where it was.
   * False when no version is left (the page is told).
   */
  private fun nextVersion(player: ExoPlayer, error: PlaybackException): Boolean {
    val idx = player.currentMediaItemIndex
    val item = player.currentMediaItem ?: return false
    val key = Playback.keyOf(item) ?: return false
    val entry = Playback.ensureRegistered(item) ?: return false
    val pos = player.currentPosition.coerceAtLeast(0)
    var cause: Throwable? = error
    var changed = false
    while (cause != null) {
      if (cause is RepresentationChangedException) changed = true
      cause = cause.cause
    }
    if (changed) {
      if (changedItem != item.mediaId) {
        changedItem = item.mediaId
        changedCount = 0
      }
      if (++changedCount <= 3) {
        Log.i(TAG, "another representation of ${item.mediaId}: again from $pos ms")
        player.seekTo(idx, pos)
        player.prepare()
        Prefetch.restart(key)
        return true
      }
    }
    // The failed version and the next one from the same list: their offsets count from the same first one.
    val s = VersionOrder.next(entry.versions, key, entry.tried, pos) ?: return false
    val fresh = Playback.build(item.mediaId, entry.level, item.mediaMetadata, s.versions, entry.tried + s.failed.id, register = true)
    Log.i(TAG, "${item.mediaId}: ${s.failed.sourceId} failed, on to ${s.versions.first().sourceId} at ${s.atMs} ms")
    player.replaceMediaItem(idx, fresh)
    player.seekTo(idx, s.atMs)
    player.prepare()
    return true
  }

  private fun isAuto(s: MediaSession, c: MediaSession.ControllerInfo) = Controllers.isCar(s.isAutoCompanionController(c), s.isAutomotiveController(c), automotive)

  private fun appKey(c: MediaSession.ControllerInfo) = "${c.packageName}:${c.uid}"

  /** A call from the car keeps the worklet awake a while longer. Main thread. */
  private fun fromCar(c: MediaSession.ControllerInfo) {
    if (appKey(c) in cars) carLease.touch()
  }

  /** A browse call of [c], answered on the main thread once browse.json was read. */
  private fun <T> withSnapshot(c: MediaSession.ControllerInfo, f: (BrowseTree) -> T): ListenableFuture<T> {
    fromCar(c)
    return Futures.transform(Browse.whenLoaded(), { f(Browse.tree(AutoLibrary.labels(this))) }, onMain)
  }

  private fun page(list: List<Node>, page: Int, pageSize: Int): List<MediaItem> {
    val from = page.toLong() * pageSize
    if (page < 0 || pageSize < 1 || from >= list.size) return emptyList()
    val to = minOf(list.size.toLong(), from + pageSize).toInt()
    return list.subList(from.toInt(), to).map { AutoLibrary.mediaItem(it) }
  }

  /** What a car tap on [id] queues; failed when there is nothing to play. */
  private fun carQueue(id: String): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
    Futures.transformAsync(Browse.whenLoaded(), {
      val snap = Browse.state.snapshot
      val e = snap?.let { Browse.tree(AutoLibrary.labels(this)).expand(id, Browse.state.searches) }
      if (snap == null || e == null) {
        Futures.immediateFailedFuture(UnsupportedOperationException("nothing to play for $id"))
      } else {
        Futures.immediateFuture(otherQueue(AutoLibrary.carItems(e, snap), e.start))
      }
    }, onMain)

  /** A list the page did not set: a new queueId, and it becomes the last queue. Main thread. */
  private fun otherQueue(items: List<MediaItem>, start: Int): MediaSession.MediaItemsWithStartPosition {
    val id = Playback.owner.otherSet()
    Playback.saveItems(this, items, start, id)
    Log.i(TAG, "a queue from outside the page: ${items.size} items from $start ($id)")
    return MediaSession.MediaItemsWithStartPosition(items, start, 0)
  }

  private inner class Callback : MediaLibrarySession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
      val auto = isAuto(session, controller)
      val verified = auto && Controllers.verified(
        controller.isPackageNameVerified,
        controller.packageName,
        if (controller.isPackageNameVerified) null else packageManager.getPackagesForUid(controller.uid),
      )
      val grant = Controllers.commandsFor(auto, verified, controller.isTrusted, session.isMediaNotificationController(controller))
      if (auto) {
        Log.i(TAG, "Android Auto connected (${controller.packageName}, verified $verified, trusted ${controller.isTrusted})")
        // The car shows covers and plays: the core stays awake while it keeps calling.
        if (verified) {
          cars.add(appKey(controller))
          carLease.touch()
        }
      }
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
        .setAvailableSessionCommands(AutoLibrary.sessionCommands(grant))
        .setAvailablePlayerCommands(AutoLibrary.playerCommands(grant))
        .build()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      fromCar(controller)
      if (customCommand.customAction != Likes.COMMAND) return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
      val cur = session.player.currentMediaItem ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
      val result = SettableFuture.create<SessionResult>()
      Likes.toggle(cur.mediaId, Playback.likedOf(cur), Playback.likedIdsOf(cur)) { ok ->
        result.set(SessionResult(if (ok) SessionResult.RESULT_SUCCESS else SessionError.ERROR_UNKNOWN))
      }
      return result
    }

    // Items coming from a MediaController may lose their URI (localConfiguration), and those of
    // another app may name any address: Playback rebuilds and checks them. A car id becomes that
    // song alone. (Untrusted controllers get read commands only: only our own, the notification,
    // trusted ones and a verified Android Auto get this far.)
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      fromCar(controller)
      if (mediaItems.none { it.mediaId.startsWith("tr:") }) {
        return Futures.immediateFuture(mediaItems.map { Playback.withLocalConfiguration(it) }.toMutableList())
      }
      return Futures.transform(Browse.whenLoaded(), {
        val snap = Browse.state.snapshot
        mediaItems.mapNotNull { item ->
          val m = MediaId.parse(item.mediaId) as? MediaId.Track
          if (m == null) Playback.withLocalConfiguration(item) else snap?.trackById?.get(m.gid)?.let { AutoLibrary.carItem(it, snap, null) }
        }.toMutableList()
      }, onMain)
    }

    // The car's ids and its voice search become their songs; anything else (the page's own items) as before.
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      fromCar(controller)
      val one = mediaItems.singleOrNull()
      if (one != null) {
        val id = one.mediaId
        if (id.startsWith("tr:") || id.startsWith("al:") || id.startsWith("ar:") || id.startsWith("pl:") || id == "cat:liked") return carQueue(id)
        val query = one.requestMetadata.searchQuery
        if (id.isEmpty() && query != null) {
          return Futures.transformAsync(Browse.whenLoaded(), {
            val snap = Browse.state.snapshot
            val found = snap?.let { Browse.tree(AutoLibrary.labels(this@PlaybackService)).search(query) }.orEmpty()
            if (snap == null || found.isEmpty()) {
              Futures.immediateFailedFuture(UnsupportedOperationException("nothing found"))
            } else {
              Futures.immediateFuture(otherQueue(found.map { AutoLibrary.carItem(it, snap, QueueCtx("search", query)) }, 0))
            }
          }, onMain)
        }
      }
      // The page's own list carries its queueId already (setQueue); one from another app gets a new one.
      val fromPage = controller.packageName == packageName && !mediaSession.isMediaNotificationController(controller)
      return Futures.transform(
        super.onSetMediaItems(mediaSession, controller, mediaItems, startIndex, startPositionMs),
        { r ->
          if (!fromPage && r.mediaItems.isNotEmpty()) Playback.owner.otherSet()
          r
        },
        onMain,
      )
    }

    // A media button with no queue loaded (the app was not running): the last queue, where it was.
    // isForPlayback false: System UI only wants what would play, for its resumption card.
    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      isForPlayback: Boolean,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val saved = Playback.loadQueue(this@PlaybackService)
        ?: return Futures.immediateFailedFuture(UnsupportedOperationException("no saved queue"))
      if (isForPlayback) {
        Log.i(TAG, "resuming the last queue (${saved.first.size} items) at ${saved.second}")
        Playback.owner.otherSet()
      }
      return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(saved.first, saved.second, saved.third))
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      fromCar(browser)
      rootLimits[appKey(browser)] = params?.extras?.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0)?.takeIf { it > 0 }
      val extras = Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      }
      val meta = MediaMetadata.Builder()
        .setTitle("MPfy")
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        .build()
      val root = MediaItem.Builder().setMediaId(MediaId.ROOT).setMediaMetadata(meta).build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, LibraryParams.Builder().setExtras(extras).build()))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val limit = rootLimits[appKey(browser)]
      return withSnapshot(browser) { t ->
        val list = t.children(parentId, limit)
        if (list == null) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) else LibraryResult.ofItemList(page(list, page, pageSize), params)
      }
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> = withSnapshot(browser) { t ->
      t.item(mediaId)?.let { LibraryResult.ofItem(AutoLibrary.mediaItem(it), null) } ?: LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
    }

    override fun onSubscribe(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> = withSnapshot(browser) { t ->
      if (t.item(parentId)?.playable == false) {
        Browse.followed(parentId)
        LibraryResult.ofVoid()
      } else {
        LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
      }
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> = withSnapshot(browser) { t ->
      session.notifySearchResultChanged(browser, query, t.searchNodes(query, Browse.state.searches).size, params)
      LibraryResult.ofVoid()
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = withSnapshot(browser) { t ->
      LibraryResult.ofItemList(page(t.searchNodes(query, Browse.state.searches), page, pageSize), params)
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onDestroy() {
    activity.stop()
    chats.stop()
    if (Chats.notifier === chats) Chats.notifier = null
    Keeper.removeForegroundListener(onForeground)
    Keeper.setPlayerBusy(false)
    Prefetch.onPlayer(null, null, false)
    carLease.close()
    Likes.queue = null
    Playback.player = null
    Browse.session = null
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }

  companion object {
    private const val TAG = "MPfyPlayback"

    // The reports leave on a thread of their own: one at a time, never on the main thread.
    private val reports = Executors.newSingleThreadExecutor { r -> Thread(r, "mpfy-activity").apply { isDaemon = true } }

    // The message notifier's requests, the same way, on a thread of their own.
    private val chatAsks = Executors.newSingleThreadExecutor { r -> Thread(r, "mpfy-chats").apply { isDaemon = true } }
  }
}
