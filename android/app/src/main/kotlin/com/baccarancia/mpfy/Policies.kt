package com.baccarancia.mpfy

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs

/*
 * Decisions kept free of Android classes, so the JVM unit tests (src/test) can check them; the
 * services, the Activity and the managers only carry them out.
 */

/**
 * Audio levels and the cache keys built on them. A download is one version of a track
 * at one level, "trackId:fileHash:level"; the first app stored "trackId:level", which reads as
 * "trackId:trackId:level". A stream is "stream:sourceId:trackId:fileHash:level": no download is
 * ever written under it, and two sources' transcodes never share bytes.
 */
object Levels {
  val ALL = setOf("low", "normal", "high", "max")

  // When a version has complete downloads at several levels, the best one plays.
  private val BEST_FIRST = listOf("max", "high", "normal", "low")

  private const val STREAM_PREFIX = "stream:"

  // What may go into a key or a URL path: never a ':' or a '/'.
  private val ID = Regex("[0-9A-Za-z_-]{1,64}")

  fun isId(s: String?): Boolean = s != null && ID.matches(s)

  data class Download(val trackId: String, val fileHash: String, val level: String)

  data class Stream(val sourceId: String, val trackId: String, val fileHash: String, val level: String)

  fun key(trackId: String, fileHash: String, level: String) = "$trackId:$fileHash:$level"

  fun streamKey(sourceId: String, trackId: String, fileHash: String, level: String) = "$STREAM_PREFIX$sourceId:$trackId:$fileHash:$level"

  fun isStream(key: String) = key.startsWith(STREAM_PREFIX)

  /** A download key, three parts or the older two; null for anything else (stream keys included). */
  fun parse(key: String): Download? {
    if (isStream(key)) return null
    val p = key.split(':')
    return when (p.size) {
      2 -> if (isId(p[0]) && p[1] in ALL) Download(p[0], p[0], p[1]) else null
      3 -> if (isId(p[0]) && isId(p[1]) && p[2] in ALL) Download(p[0], p[1], p[2]) else null
      else -> null
    }
  }

  fun parseStream(key: String): Stream? {
    if (!isStream(key)) return null
    val p = key.substring(STREAM_PREFIX.length).split(':')
    if (p.size != 4 || !isId(p[0]) || !isId(p[1]) || !isId(p[2]) || p[3] !in ALL) return null
    return Stream(p[0], p[1], p[2], p[3])
  }

  /** The level a download key names, or null when it is not a download key. */
  fun ofKey(key: String): String? = parse(key)?.level

  /** The level any key names, stream keys included. */
  fun levelOfAnyKey(key: String): String? = parse(key)?.level ?: parseStream(key)?.level

  /** The level of an X-MPfy-Quality value, or null when it names none. */
  fun ofHeader(value: String?): String? = value?.trim()?.lowercase()?.takeIf { it in ALL }

  fun rank(level: String?): Int = when (level) {
    "low" -> 1
    "normal" -> 2
    "high" -> 3
    "max" -> 4
    else -> 0
  }

  /** The key [completed] holds for this version at [level]: three parts, or the older two when the file is the first upload. */
  fun downloaded(trackId: String, fileHash: String, level: String, completed: Set<String>): String? {
    val k = key(trackId, fileHash, level)
    if (k in completed) return k
    if (fileHash == trackId) {
      val old = "$trackId:$level"
      if (old in completed) return old
    }
    return null
  }

  /** The key of the best level this version is downloaded at, or null. */
  fun bestDownload(trackId: String, fileHash: String, completed: Set<String>): String? {
    for (level in BEST_FIRST) downloaded(trackId, fileHash, level, completed)?.let { return it }
    return null
  }

  /**
   * The cache key a version plays from: its complete download at the level asked, else at another
   * level (a download is stored at the level its source served), else its stream key, so a stream
   * never mixes its bytes with those of a partial download or of another file.
   */
  fun playKey(sourceId: String, trackId: String, fileHash: String, asked: String, completed: Set<String>): String =
    downloaded(trackId, fileHash, asked, completed)
      ?: bestDownload(trackId, fileHash, completed)
      ?: streamKey(sourceId, trackId, fileHash, asked)

  /**
   * A download stored under [stored] whose source answered with level [served]: null when the
   * bytes belong under that key (or the source did not say), else the key they belong under, with
   * the same file. A download already moved once is not moved again ([moved]): it fails, so a
   * transcode evicted meanwhile can never bounce it between levels forever.
   */
  fun moveTo(stored: String, served: String?, moved: Boolean): String? {
    val d = parse(stored) ?: return null
    val got = ofHeader(served) ?: return null
    if (got == d.level || moved) return null
    return key(d.trackId, d.fileHash, got)
  }

  /** The keys among [keys] that removeDownload([selectors]) removes. */
  fun toRemove(keys: Collection<String>, selectors: Collection<DownloadSelector>): List<String> =
    keys.filter { k -> selectors.any { it.matches(k) } }.distinct()
}

/** One item of removeDownload: every download of a track, or every level of one of its versions. */
sealed class DownloadSelector {
  abstract fun matches(key: String): Boolean

  data class Track(val trackId: String) : DownloadSelector() {
    override fun matches(key: String) = Levels.parse(key)?.trackId == trackId
  }

  data class Version(val trackId: String, val fileHash: String) : DownloadSelector() {
    override fun matches(key: String) = Levels.parse(key)?.let { it.trackId == trackId && it.fileHash == fileHash } == true
  }
}

/** One file of a song on one source, as the page sends it in setQueue. */
data class Version(val sourceId: String, val trackId: String, val fileHash: String, val url: String, val offsetMs: Long) {
  /** The same file on the same source. */
  val id: String get() = "$sourceId:$trackId:$fileHash"

  /** Whether [key] names this version: a stream key its source and file, a download key its file. */
  fun isNamedBy(key: String): Boolean {
    Levels.parseStream(key)?.let { return it.sourceId == sourceId && it.trackId == trackId && it.fileHash == fileHash }
    Levels.parse(key)?.let { return it.trackId == trackId && it.fileHash == fileHash }
    return false
  }
}

object VersionOrder {
  /**
   * The phone's own file first (no network, no data, the original), then versions with a finished
   * download (best level first), then the page's order: the same rule for the items the page did
   * not order (the car, a resumed queue).
   */
  fun order(versions: List<Version>, completed: Set<String>): List<Version> {
    val seen = HashSet<String>()
    val unique = versions.filter { seen.add(it.id) }
    val phone = unique.filter { it.sourceId == LocalSource.ID }
    val rest = unique.filter { it.sourceId != LocalSource.ID }
    val down = rest.mapNotNull { v -> Levels.bestDownload(v.trackId, v.fileHash, completed)?.let { v to Levels.rank(Levels.ofKey(it)) } }
    val first = down.sortedByDescending { it.second }.map { it.first }
    return phone + first + rest.filter { v -> first.none { it === v } }
  }

  fun keyOf(v: Version, asked: String, completed: Set<String>): String =
    Levels.playKey(v.sourceId, v.trackId, v.fileHash, asked, completed)

  /**
   * After a failure of [current]: the versions rotated so the next one not tried yet is first
   * ([A, B, C] with A failing gives [B, C, A]), or null when every other one was tried.
   */
  fun rotate(versions: List<Version>, current: Version, tried: Set<String>): List<Version>? {
    val i = versions.indexOfFirst { it.id != current.id && it.id !in tried }
    if (i < 0) return null
    return versions.subList(i, versions.size) + versions.subList(0, i)
  }

  /** Where the new version starts: the same moment of the song. */
  fun alignedPosition(positionMs: Long, from: Version, to: Version): Long =
    (positionMs - from.offsetMs + to.offsetMs).coerceAtLeast(0)

  /**
   * The page's new list for the item playing. Offsets count from each list's first version, so the
   * version playing must sit in the list it moves on from: when the page left it out (its source
   * went down), it goes last, its offset taken into the new list's terms through a version both
   * lists hold; with none in common it is taken as aligned with the new first one.
   */
  fun forPlaying(old: List<Version>, fresh: List<Version>, playing: Version): List<Version> {
    if (fresh.isEmpty()) return old
    if (fresh.any { it.id == playing.id }) return fresh
    val was = old.firstOrNull { it.id == playing.id } ?: playing
    for (f in fresh) {
      val o = old.firstOrNull { it.id == f.id } ?: continue
      return fresh + was.copy(offsetMs = was.offsetMs - o.offsetMs + f.offsetMs)
    }
    return fresh + was.copy(offsetMs = fresh[0].offsetMs)
  }

  /** The way on after the version a key names failed: the list rotated to the next untried one, and where to start in it. */
  data class Switch(val failed: Version, val versions: List<Version>, val atMs: Long)

  /** After the version [key] names failed at [positionMs]: [Switch], or null when no version is left. */
  fun next(versions: List<Version>, key: String, tried: Set<String>, positionMs: Long): Switch? {
    val cur = versions.firstOrNull { it.isNamedBy(key) } ?: return null
    val rotated = rotate(versions, cur, tried) ?: return null
    return Switch(cur, rotated, alignedPosition(positionMs, cur, rotated.first()))
  }
}

/**
 * Which versions each playing item has, by its cache key: setQueue fills it, the data sources read
 * it at each open, the service rotates it when a version fails. Process-wide, any thread.
 */
class VersionRegistry(private val max: Int = 2_000) {
  class Entry(val itemId: String, val level: String, val versions: List<Version>, val tried: Set<String> = emptySet()) {
    /** The version a read of this key moved to (the same file on another source), or null. */
    @Volatile var movedTo: String? = null

    /** The version [key] names, or null when the list does not hold it. */
    fun versionOf(key: String): Version? = versions.firstOrNull { it.isNamedBy(key) }

    /** A version the service has not tried yet, other than the one [key] names. */
    fun hasUntried(key: String): Boolean {
      val cur = versionOf(key)?.id
      return versions.any { it.id != cur && it.id !in tried }
    }
  }

  private val map = object : LinkedHashMap<String, Entry>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) = size > max
  }

  @Synchronized
  fun put(key: String, entry: Entry) {
    map[key] = entry
  }

  @Synchronized
  fun get(key: String): Entry? = map[key]

  /** The item playing under [key] got a new list from the page: what was tried stays tried, and where its reads moved. */
  @Synchronized
  fun update(key: String, itemId: String, level: String, versions: List<Version>) {
    val old = map[key]?.takeIf { it.itemId == itemId }
    map[key] = Entry(itemId, level, versions, old?.tried ?: emptySet()).also { e ->
      e.movedTo = old?.movedTo?.takeIf { id -> versions.any { it.id == id } }
    }
  }
}

/**
 * When to retry a stream load that failed (StreamErrorPolicy). A representation that changed, or
 * an exhausted read while the item still has a version the service has not tried, goes to the
 * player at once (the service then moves on). Otherwise the usual rules on the cause: a source
 * that answered "no" (4xx) at once, "unavailable" (5xx, the core already waited 6 s for the link)
 * one more try, a connection that failed (the core waking up or restarting) the default six.
 */
object StreamRetry {
  /** Use the default policy. */
  const val DEFAULT = Long.MIN_VALUE

  fun delayFor(e: IOException, errorCount: Int): Long {
    if (e is RepresentationChangedException) return C.TIME_UNSET
    if (e is VersionsExhaustedException) {
      if (e.hasUntried) return C.TIME_UNSET
      return byCause(e.cause, errorCount)
    }
    return byCause(e, errorCount)
  }

  private fun byCause(e: Throwable?, errorCount: Int): Long {
    if (e is HttpStatusException) {
      if (e.status in 400..499) return C.TIME_UNSET
      if (errorCount > 1) return C.TIME_UNSET
      return 1_000
    }
    return DEFAULT
  }
}

/** Exceptions that end a read for good rather than ask for another try. */
object Interrupts {
  fun isCancel(e: IOException): Boolean = e is InterruptedIOException && e !is SocketTimeoutException
}

@OptIn(UnstableApi::class)
object DownloadPolicy {
  /**
   * Whether a download needs the core awake (and the progress poll): only one that is moving bytes
   * now. A queued one (waiting for its turn, for the network, or for a paused manager) needs
   * nothing, and counting it kept the worklet awake for good.
   */
  fun isActive(state: Int, notMetRequirements: Int): Boolean =
    state == Download.STATE_DOWNLOADING && notMetRequirements == 0

  /** Not finished yet: queued, downloading, stopped or restarting. */
  fun isUnfinished(state: Int): Boolean =
    state == Download.STATE_QUEUED || state == Download.STATE_DOWNLOADING ||
      state == Download.STATE_STOPPED || state == Download.STATE_RESTARTING

  /** A song of the phone's own music is its file already: a download of it is never asked for. */
  fun refuses(url: String?): Boolean = LocalSource.names(url)
}

/**
 * What a removal of downloads must reach besides what the manager shows. The manager stores an
 * added download on its own thread (one index write each) and shows it on the main thread only
 * later: a removal that came first (the switch turned on, then off) found neither the index nor
 * the manager's list holding it, and the song downloaded anyway with nothing left to remove it.
 * The manager's updates cannot say which hand-over they are about: the end of a removal can come
 * after the same song was handed over again, and the song then leaves the index while its new add
 * still waits. So no update changes what is kept here; only a removal does, and it reaches the
 * manager after every add before it. A removal also stops a download from moving to another
 * level ([mayMove]): the move would add it again under the new key. Main thread.
 */
class DownloadHandoff {
  // Last handed to the manager as an add, no removal since: the manager holds them, or will.
  private val handedOver = HashSet<String>()
  // Reached by a removal, not handed over since.
  private val dropped = HashSet<String>()

  /** [key] went to the manager: an add, or a move to another level. */
  fun handed(key: String) {
    handedOver.add(key)
    dropped.remove(key)
  }

  /**
   * The keys removeDownload([selectors]) removes: among [stored] (the index and the manager's
   * list) and those handed over since their last removal. They may not move any more.
   */
  fun toRemove(stored: Collection<String>, selectors: Collection<DownloadSelector>): List<String> {
    val keys = LinkedHashSet(stored)
    keys.addAll(handedOver)
    return Levels.toRemove(keys, selectors).also {
      handedOver.removeAll(it)
      dropped.addAll(it)
    }
  }

  /** "Elimina download": every key in [stored] and every one handed over goes. */
  fun dropAll(stored: Collection<String>) {
    dropped.addAll(stored)
    dropped.addAll(handedOver)
    handedOver.clear()
  }

  /** Whether the download under [key] may move to another level: not once a removal reached it. */
  fun mayMove(key: String): Boolean = key !in dropped
}

object PlayerPolicy {
  /**
   * The player needs the core while it plays or means to (buffering to play), and while it loads:
   * a paused ExoPlayer keeps buffering ahead, and a worklet suspended under it made those loads
   * time out into a playback error minutes later.
   */
  fun needsCore(playWhenReady: Boolean, playbackState: Int, isLoading: Boolean): Boolean =
    isLoading || (playWhenReady && (playbackState == Player.STATE_READY || playbackState == Player.STATE_BUFFERING))

  enum class AfterError { NOTHING, SKIP, SKIP_AND_PLAY }

  /**
   * What the service does about a track that failed on every version. With the page attached the
   * page decides (another source, or the next track). Without it (the app swiped away), the next
   * track, a few times in a row at most, and it plays only when the listener wanted playback: a
   * paused player that failed while buffering ahead stays paused.
   */
  fun afterError(uiAttached: Boolean, errorStreak: Int, hasNext: Boolean, playWhenReady: Boolean): AfterError = when {
    uiAttached || errorStreak > 3 || !hasNext -> AfterError.NOTHING
    playWhenReady -> AfterError.SKIP_AND_PLAY
    else -> AfterError.SKIP
  }
}

/**
 * The page's list (setQueue) on the player, all of it in one go on the main thread, where the
 * notification, the lock screen, Bluetooth and the car act on the same player: none of them ever
 * finds a list half replaced, and the ranges come from the player's own index at that moment.
 * When the item playing is the page's current one, it goes on and only the items around it
 * change. An edit ([apply] keep) the page made before it saw the player move on keeps the item
 * playing where the new list holds it. Otherwise the list loads afresh at the page's index.
 */
object PageQueue {
  /** The player as the page's list needs it, [T] its items. Main thread. */
  interface Target<T> {
    val count: Int

    /** The index of the item playing, -1 with none. */
    val current: Int

    /** The item playing can go on: prepared, with no error and not at the end. */
    val canGoOn: Boolean

    fun idAt(index: Int): String

    fun clear()

    fun remove(from: Int, to: Int)

    fun add(index: Int, items: List<T>)

    /** The item playing goes on, with the page's copy of it (its versions in the page's order). */
    fun goOn(fresh: T)

    fun load(items: List<T>, index: Int, positionMs: Long)

    fun setPlayWhenReady(play: Boolean)
  }

  /**
   * Where in [ids] the item [playing] goes on, or -1 when the list loads afresh: at the page's
   * [index] when it is there; for an edit ([keep]), else where the new list holds it, the nearest
   * to [index] (the later one on a tie: the player moves on more often than back).
   */
  fun keepAt(playing: String?, canGoOn: Boolean, ids: List<String>, index: Int, keep: Boolean): Int {
    if (playing == null || !canGoOn || ids.isEmpty()) return -1
    val idx = index.coerceIn(0, ids.size - 1)
    if (ids[idx] == playing) return idx
    if (!keep) return -1
    var best = -1
    for (i in ids.indices) {
      if (ids[i] != playing) continue
      if (best < 0 || abs(i - idx) <= abs(best - idx)) best = i
    }
    return best
  }

  fun <T> apply(t: Target<T>, items: List<T>, idOf: (T) -> String, index: Int, positionMs: Long, playWhenReady: Boolean, keep: Boolean) {
    if (items.isEmpty()) {
      t.clear()
      return
    }
    val ci = t.current
    val playing = if (ci in 0 until t.count) t.idAt(ci) else null
    val at = keepAt(playing, t.canGoOn, items.map(idOf), index, keep)
    if (at < 0) {
      t.load(items, index.coerceIn(0, items.size - 1), positionMs)
    } else {
      t.goOn(items[at])
      val n = t.count
      if (ci + 1 < n) t.remove(ci + 1, n)
      if (at + 1 < items.size) t.add(t.count, items.subList(at + 1, items.size))
      if (ci > 0) t.remove(0, ci)
      if (at > 0) t.add(0, items.subList(0, at))
    }
    t.setPlayWhenReady(playWhenReady)
  }
}

/** The prefetch: when it waits, when it gives up on an item, and how far ahead of the player it reads. */
object PrefetchPolicy {
  /** Waits before a span is fetched again after an IOException; none left: the item is given up. */
  val RETRY_MS = listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L)

  /** The first span from a source whose link is not measured yet (in this process, since the last network change). */
  const val FIRST_SPAN = 256L * 1024

  /** A link at least this fast (bytes a second) fetches the rest of a song in one request. */
  const val FAST = 1L shl 20

  /**
   * On a slower link the fetch reaches at most this much of the link's own time past where the
   * player reads, within [MIN_AHEAD] and [MAX_AHEAD]: on a thin or crowded link a skip throws that
   * much away at most, and the link carries the part about to be heard.
   */
  const val AHEAD_MS = 8_000L
  const val MIN_AHEAD = 256L * 1024
  const val MAX_AHEAD = 4L shl 20

  /** A span that read less than this from the network says nothing of the link. */
  const val MIN_MEASURE = 64L * 1024

  /** The player opening a song this far past what its running fetch has: the fetch is behind the play position. */
  const val SLACK = 256L * 1024

  /** On a metered network a source that fell back to a higher level than asked is not fetched whole. */
  fun stopsOnServed(metered: Boolean, asked: String, served: String?): Boolean =
    metered && Levels.rank(Levels.ofHeader(served)) > Levels.rank(asked)

  /** How far past the player's position a fetch may reach on a link of [rate] bytes a second (null: not measured yet); -1: to the end. */
  fun ahead(rate: Long?): Long = when {
    rate == null -> FIRST_SPAN
    rate >= FAST -> -1
    else -> (rate * AHEAD_MS / 1000).coerceIn(MIN_AHEAD, MAX_AHEAD)
  }
}

/**
 * What the prefetch fetches, and when: the item playing from where the player reads it, then the
 * next one from its start, only while the player means to play (a paused one fetches nothing, and
 * a core put to sleep under it would make it give up). The part of a song behind the play position
 * is fetched only once the player asks for it (a seek back); a downloaded item is whole already and
 * a song of the phone is its own file, so neither is fetched. A fast link fetches the rest of a
 * song in one request; on a slower one the fetch goes in spans that stay a window ahead of the
 * player, so a skip throws little away. Each span measures its source's link. [Runner] does the
 * fetching, sees the cache and the player, and keeps the clock. One thread, the main one in the
 * app, except where it says.
 */
class PrefetchQueue(private val runner: Runner) {
  /** One item of the player: group id, cache key, stream URL and level asked; a [downloaded] one needs nothing. */
  data class Item(val itemId: String, val key: String, val url: String, val level: String, val downloaded: Boolean = false)

  /** One fetch of [length] bytes of an item from byte [from] (-1: to its end); once cancelled it reads nothing more. */
  class Job(val item: Item, val attempt: Int, val from: Long = 0, val length: Long = -1) {
    @Volatile var cancelled = false
      private set

    /** The source served a higher level than asked on a metered network. */
    @Volatile var metered = false

    /** Bytes of the span in the cache so far, fetched or found there. Any thread. */
    @Volatile var done = 0L
    private val hooks = CopyOnWriteArrayList<() -> Unit>()

    /** [hook] runs at the cancel, at once when it already happened. Any thread. */
    fun onCancel(hook: () -> Unit) {
      hooks.add(hook)
      if (cancelled) hook()
    }

    /** Any thread. */
    fun cancel() {
      cancelled = true
      for (h in hooks) h()
    }
  }

  /** What a span did: [fetched] bytes from the network in [ms], and [covered] bytes of the span in the cache at its end. */
  data class Result(val fetched: Long, val ms: Long, val covered: Long)

  interface Runner {
    /** Fetches the job's span off this thread; [ended] follows on this thread. */
    fun start(job: Job)

    fun later(ms: Long, task: Runnable)

    fun cancelLater(task: Runnable)

    fun log(line: String)

    /** The byte the player reads [key] at now, or -1 when it has not opened it. */
    fun playerAt(key: String): Long = -1

    /** Calls [playerMoved] once the player reads [key] at [position] or past it. */
    fun wakeAt(key: String, position: Long) {}

    /** The bytes of [key] in the cache from [position] on, with no gap. */
    fun cachedFrom(key: String, position: Long): Long = 0

    /** The size of [key]'s resource, or -1 while it is not known. */
    fun sizeOf(key: String): Long = -1
  }

  // Bytes [from, to) of a key fetched in this process, with no gap; to = Long.MAX_VALUE: to its end.
  private class Reach(val from: Long, val to: Long)

  private var current: Item? = null
  private var next: Item? = null
  private var playing = false
  @Volatile var running: Job? = null
    private set
  private var retry: Runnable? = null
  private val reach = HashMap<String, Reach>()
  // Keys given up on, until they get a fresh try.
  private val givenUp = HashSet<String>()
  // Each source's link in bytes a second, as its spans measured it.
  private val rates = HashMap<String, Long>()
  // The player position each key's fetch waits for (asked once).
  private val waking = HashMap<String, Long>()
  private var clearing = false

  /** The player's current and next items (cur null: nothing in the player) and whether it means to play. */
  fun onPlayer(cur: Item?, nxt: Item?, playing: Boolean) {
    val before = current
    val wasPlaying = this.playing
    if (cur == null) {
      stopAll()
      return
    }
    current = cur
    next = nxt
    this.playing = playing
    if (before?.key != cur.key) {
      givenUp.remove(cur.key) // the item starts again: a fresh try
      cancelRetry()
      waking.clear()
    }
    if (!playing) {
      // Paused: what was fetched stays cached, the rest waits for play.
      cancelRetry()
      running?.cancel()
      running = null
      return
    }
    if (!wasPlaying) {
      givenUp.remove(cur.key)
      nxt?.let { givenUp.remove(it.key) }
    }
    // The fetch goes on with the current item, or with the next one while the current stays; any
    // other (a skip) stops now, an open still waiting for its answer included.
    val r = running
    if (r != null && r.item.key != cur.key && !(before?.key == cur.key && r.item.key == nxt?.key)) {
      r.cancel()
      running = null
    }
    pump()
  }

  /**
   * The player opened [key] ([opened]: a new play, a seek, a file's head read first) or read past
   * where [Runner.wakeAt] asked. A fetch of the item playing that reads behind the play position
   * stops and goes on from there.
   */
  fun playerMoved(key: String, opened: Boolean) {
    waking.remove(key)
    val r = running
    if (opened && r != null && r.item.key == key && key == current?.key) {
      val at = runner.playerAt(key)
      val reached = r.from + r.done
      if (at > reached + PrefetchPolicy.SLACK) {
        runner.log("$key: the player reads at byte $at, past the fetch at $reached: on from there")
        r.cancel()
        running = null
      }
    }
    pump()
  }

  /** An item prepared again with the same key (its representation changed): from scratch. */
  fun restart(key: String) {
    givenUp.remove(key)
    reach.remove(key)
    pump()
  }

  /** Another representation turned up under [key]: its fetch stops now. Any thread. */
  fun cancelRunning(key: String) {
    running?.takeIf { it.item.key == key }?.cancel()
  }

  /** ... and the key waits for its item to be prepared again. */
  fun dropped(key: String) {
    givenUp.add(key)
    reach.remove(key)
  }

  /** Another network: its links are measured again, and what gave up meanwhile gets a fresh try. */
  fun networkBack() {
    rates.clear()
    val cur = current ?: return
    givenUp.remove(cur.key)
    next?.let { givenUp.remove(it.key) }
    pump()
  }

  /** "Svuota cache": the fetch stops while the cache is cleared. */
  fun clearing() {
    clearing = true
    cancelRetry()
    running?.cancel()
    running = null
  }

  /** After the clear: only [kept] keeps its bytes. */
  fun cleared(kept: Set<String>) {
    clearing = false
    reach.keys.retainAll(kept)
    pump()
  }

  /** The job stopped: [error] null when its span is in the cache now, [result] what it read. */
  fun ended(job: Job, error: Exception?, result: Result? = null) {
    if (running === job) running = null
    val key = job.item.key
    when {
      job.metered -> {
        runner.log("$key: the source served a higher level on a metered network, streaming it instead")
        givenUp.add(key)
      }
      job.cancelled -> {}
      error == null -> {
        note(job, result)
        if (result != null) measure(key, result)
      }
      error is RepresentationChangedException -> givenUp.add(key)
      else -> {
        val wait = PrefetchPolicy.RETRY_MS.getOrNull(job.attempt)
        if (wait == null) {
          runner.log("$key: given up: ${error.message}")
          givenUp.add(key)
        } else {
          runner.log("$key: ${error.message}; again in ${wait / 1000} s")
          val again = Runnable {
            retry = null
            val i = listOfNotNull(current, next).firstOrNull { it.key == key }
            val j = if (i != null && wanted(i) && running == null && !clearing && playing) plan(i, i.key == current?.key, job.attempt + 1) else null
            if (j != null) start(j) else pump()
          }
          retry = again
          runner.later(wait, again)
          return
        }
      }
    }
    pump()
  }

  // What the span added to what is known of its key.
  private fun note(job: Job, result: Result?) {
    val covered = result?.covered ?: job.length
    // Asked to the end, or fewer bytes than asked: the song's end is in.
    val to = if (job.length < 0 || covered < job.length) Long.MAX_VALUE else job.from + covered
    val old = reach[job.item.key]
    reach[job.item.key] = if (old != null && job.from in old.from..old.to) Reach(old.from, maxOf(old.to, to)) else Reach(job.from, to)
    runner.log(if (to == Long.MAX_VALUE) "${job.item.key}: in from byte ${job.from} to the end" else "${job.item.key}: in to byte $to")
  }

  private fun measure(key: String, r: Result) {
    if (r.fetched < PrefetchPolicy.MIN_MEASURE) return
    val source = sourceOf(key)
    val m = r.fetched * 1000 / maxOf(1L, r.ms)
    rates[source] = rates[source]?.let { (it + m) / 2 } ?: m
  }

  private fun sourceOf(key: String) = Levels.parseStream(key)?.sourceId ?: ""

  private fun stopAll() {
    cancelRetry()
    running?.cancel()
    running = null
    current = null
    next = null
    playing = false
  }

  private fun cancelRetry() {
    retry?.let { runner.cancelLater(it) }
    retry = null
  }

  private fun wanted(i: Item?): Boolean = i != null && !i.downloaded && !LocalSource.isKey(i.key) && i.key !in givenUp

  /**
   * The next span of [i]: the item playing ([isCurrent]) from where the player reads it, the next
   * one from its start; null when it is in the cache from there to its end, or when its window
   * ahead of the player is full (the item playing then waits for the player to come nearer).
   */
  private fun plan(i: Item, isCurrent: Boolean, attempt: Int): Job? {
    val key = i.key
    val at = if (isCurrent) runner.playerAt(key).coerceAtLeast(0) else 0L
    var start = at + runner.cachedFrom(key, at).coerceAtLeast(0)
    val r = reach[key]
    if (r != null && at >= r.from && at <= r.to) start = maxOf(start, r.to)
    if (start == Long.MAX_VALUE) return null
    val total = runner.sizeOf(key)
    if (total in 0..start) return null
    val ahead = PrefetchPolicy.ahead(rates[sourceOf(key)])
    if (ahead < 0) return Job(i, attempt, start, -1)
    if (start > at + ahead / 2) {
      if (isCurrent) wake(key, start - ahead / 2)
      return null
    }
    var length = at + ahead - start
    if (total >= 0) length = minOf(length, total - start)
    return Job(i, attempt, start, length)
  }

  private fun wake(key: String, position: Long) {
    if (waking[key] == position) return
    waking[key] = position
    runner.wakeAt(key, position)
  }

  private fun pump() {
    if (clearing || !playing || running != null || retry != null) return
    val cur = current ?: return
    val job = (if (wanted(cur)) plan(cur, true, 0) else null)
      ?: next?.takeIf { wanted(it) }?.let { plan(it, false, 0) }
      ?: return
    start(job)
  }

  private fun start(job: Job) {
    running = job
    runner.log("${job.item.key}: fetching ${if (job.length < 0) "from byte ${job.from} to the end" else "${job.length} bytes from byte ${job.from}"}")
    runner.start(job)
  }
}

/**
 * Whether uploads go on, and when the upload service may be stopped. A page says it (setUploading),
 * and its word goes with it when the page goes away: the queue lived in it. A start of the service
 * still on its way is never stopped from outside (Android ends the whole app when a service it was
 * told to start in the foreground stops before getting there); the service stops itself instead.
 * Main thread.
 */
class UploadState {
  private val pages = HashSet<Any>()
  private var starting = 0

  val active: Boolean get() = pages.isNotEmpty()

  /** [page] says whether its queue has work: true when [active] changed. */
  fun say(page: Any, on: Boolean): Boolean {
    val before = active
    if (on) pages.add(page) else pages.remove(page)
    return active != before
  }

  /** [page] went away, and its uploads with it: true when [active] changed. */
  fun gone(page: Any): Boolean = say(page, false)

  /** A start of the service was sent. */
  fun starting() {
    starting++
  }

  /** A start reached the service, or could not be sent. */
  fun started() {
    if (starting > 0) starting--
  }

  /** No start is on its way: the service may be stopped from outside. */
  val mayStop: Boolean get() = starting == 0
}

/** Android 13 and later show the download and upload notifications only with the person's yes, asked once. */
object NotificationAsk {
  const val SINCE_SDK = 33

  fun shouldAsk(sdk: Int, granted: Boolean, askedBefore: Boolean, inFront: Boolean): Boolean =
    sdk >= SINCE_SDK && !granted && !askedBefore && inFront
}

/**
 * The secret on the clipboard is cleared later only while the clip is still the one the app put
 * there, told by its description: reading the clip itself would read another app's clip (and
 * Android 12 and later would say so on screen).
 */
object SecretClip {
  const val LABEL = "MPfy"

  fun stillOurs(label: CharSequence?, timestamp: Long, ours: Long): Boolean =
    ours > 0 && timestamp == ours && label?.toString() == LABEL
}

/** The .mpfy identity file (the core's file name rule, applied again here) and who may hold it. */
object IdentityNames {
  const val FOLDER = "Documents/MPfy"
  private const val EXT = ".mpfy"
  private const val MAX_CHARS = 60
  private val BAD = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f-\\u009f]")

  // JavaScript's \s and trim(): the core strips exactly these.
  private const val JS_SPACES = "\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

  private fun isSpace(c: Char) = JS_SPACES.indexOf(c) >= 0

  /** The file name for a profile name: bad characters out, no leading dots or spaces, 60 characters, "MPfy" when empty. */
  fun forProfile(name: String?): String {
    var s = (name ?: "").replace(BAD, "")
    var i = 0
    while (i < s.length && (s[i] == '.' || isSpace(s[i]))) i++
    s = s.substring(i).trim(::isSpace)
    if (s.codePointCount(0, s.length) > MAX_CHARS) s = s.substring(0, s.offsetByCodePoints(0, MAX_CHARS))
    s = s.trim(::isSpace)
    return (s.ifEmpty { "MPfy" }) + EXT
  }

  /** A file name the core sent, checked again: the same rule on the name without its extension. */
  fun sanitize(fileName: String?): String {
    val f = fileName ?: ""
    val base = if (f.endsWith(EXT, ignoreCase = true)) f.substring(0, f.length - EXT.length) else f
    return forProfile(base)
  }

  /**
   * An imported file is written again in place only when it lives on the phone: anything picked
   * from another provider (a cloud drive) is left alone, and the next write makes a new file in
   * Documents/MPfy, so the identity never goes to a cloud by itself.
   */
  fun canAdopt(authority: String?): Boolean =
    authority in PHONE_PROVIDERS

  // The phone's storage, and its media provider (Recent, and a Documents root from Android 11).
  private val PHONE_PROVIDERS = setOf("com.android.externalstorage.documents", "com.android.providers.media.documents", "media")
}

/** The picked folders' files served to the page at /__native/file/<id>. */
object NativeFiles {
  private val AUDIO = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")
  private val ARCHIVES = setOf("zip", "7z", "rar")
  private val IMAGES = setOf("jpg", "jpeg", "png", "webp")
  const val MAX_DEPTH = 8
  const val MAX_FILES = 5_000
  const val BATCH = 50

  fun extensionOf(name: String): String = name.substringAfterLast('.', "").lowercase()

  /** Songs, archives and pictures, by extension; anything else in a folder is left out. */
  fun keeps(name: String): Boolean {
    val ext = extensionOf(name)
    return ext in AUDIO || ext in ARCHIVES || ext in IMAGES
  }

  /** The type a kept file is served with when its provider does not say. */
  fun mimeOf(name: String): String = when (extensionOf(name)) {
    "mp3" -> "audio/mpeg"
    "m4a" -> "audio/mp4"
    "aac" -> "audio/aac"
    "flac" -> "audio/flac"
    "ogg" -> "audio/ogg"
    "opus" -> "audio/ogg"
    "wav" -> "audio/wav"
    "zip" -> "application/zip"
    "7z" -> "application/x-7z-compressed"
    "rar" -> "application/vnd.rar"
    "jpg", "jpeg" -> "image/jpeg"
    "png" -> "image/png"
    "webp" -> "image/webp"
    else -> "application/octet-stream"
  }

  /** What a Range header asks of a file of [size] bytes. */
  sealed class Ask {
    object Whole : Ask()
    data class Part(val first: Long, val last: Long) : Ask()
    object Unsatisfiable : Ask()
  }

  /** "bytes=a-b" and "bytes=a-" are served as 206; no header, or one we do not read, the whole file. */
  fun range(header: String?, size: Long): Ask {
    val h = header?.trim() ?: return Ask.Whole
    val m = Regex("bytes=(\\d{1,18})-(\\d{0,18})", RegexOption.IGNORE_CASE).matchEntire(h) ?: return Ask.Whole
    val first = m.groupValues[1].toLong()
    if (first >= size) return Ask.Unsatisfiable
    val last = m.groupValues[2].takeIf { it.isNotEmpty() }?.toLong()?.coerceAtMost(size - 1) ?: (size - 1)
    if (last < first) return Ask.Unsatisfiable
    return Ask.Part(first, last)
  }
}

/** The upload notification's title: the one source the uploads go to, or none named. */
object UploadPolicy {
  fun title(targets: List<String>): String =
    if (targets.size == 1 && targets[0].isNotBlank()) "Caricamento su ${targets[0]}" else "Caricamento"

  /** The source an upload request goes to (/s/<id>/api/upload/... or /s/<id>/api/uploads...), or null. */
  fun targetOf(path: String?): String? {
    val m = Regex("^/s/([0-9A-Za-z_-]{1,64})/api/uploads?(/.*)?$").matchEntire(path ?: return null) ?: return null
    return m.groupValues[1]
  }
}

/**
 * When MainActivity loads the page: once the core is ready, again after a failed load, and on a new
 * WebView. A load that is due while the core is down waits for the next ready.
 */
class PageLoadGate {
  var loaded = false
    private set

  /** The core's ready state is [ready]: true when the page must be loaded now. */
  fun onReady(ready: Boolean): Boolean {
    if (!ready || loaded) return false
    loaded = true
    return true
  }

  /** A load is due again (a failed load, a new WebView): true when it must happen now. */
  fun reload(ready: Boolean): Boolean {
    loaded = ready
    return ready
  }
}

/**
 * One system picker of a kind on screen at a time. A double tap asked for two: the second opened
 * over the first, and whatever was picked in it was dropped for the first one's answer. A request
 * while one is open is turned down (the caller answers it cancelled); the slot frees when the
 * picker answers, picked or cancelled, or could not open. Main thread.
 */
class PickerSlot {
  /** The request the picker on screen answers, or null. */
  var pending: String? = null
    private set

  /** [requestId] asks for the picker: true when it may open (and holds the slot until [answer]). */
  fun open(requestId: String): Boolean {
    if (pending != null) return false
    pending = requestId
    return true
  }

  /** The picker for [requestId] could not open. */
  fun failed(requestId: String) {
    if (pending == requestId) pending = null
  }

  /** The picker answered: the request it answers, or null when none waited. */
  fun answer(): String? = pending.also { pending = null }
}

/** The same key twice within [windowMs] counts once: a link double tapped opens one page. */
class OnceWithin(private val windowMs: Long) {
  private var lastKey: String? = null
  private var lastAt = 0L

  /** Whether [key] goes ahead at [nowMs] (a monotonic clock). */
  fun allow(key: String, nowMs: Long): Boolean {
    if (key == lastKey && nowMs >= lastAt && nowMs - lastAt < windowMs) return false
    lastKey = key
    lastAt = nowMs
    return true
  }
}
