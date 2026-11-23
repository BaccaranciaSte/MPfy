package com.baccarancia.mpfy

import com.baccarancia.mpfy.Json.list
import com.baccarancia.mpfy.Json.long
import com.baccarancia.mpfy.Json.map
import com.baccarancia.mpfy.Json.str
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/*
 * The car's library, free of Android classes: the snapshot the page sends (setBrowseSnapshot, or
 * from bridge 7 setBrowsePage and setBrowseIndex), the tree Android Auto browses, its search, and
 * what a car tap queues. AutoLibrary turns the nodes into MediaItems.
 */

/** A cover: the source that has it, and its large and small ids. */
data class Art(val sourceId: String, val large: String, val small: String) {
  fun uri(size: String): String = Artwork.contentUri(sourceId, if (size == "small") small else large, size)
}

data class SnapVersion(val sourceId: String, val trackId: String, val fileHash: String, val offsetMs: Long, val away: Boolean = false)

data class SnapTrack(
  val id: String,
  val title: String,
  val artist: String,
  val albumArtist: String,
  val albumId: String,
  val trackNo: Int?,
  val durationMs: Long,
  val art: Art?,
  val versions: List<SnapVersion>,
)

/** An album, an artist or a playlist: its songs in their order. */
data class SnapGroup(val id: String, val name: String, val artist: String, val year: Int?, val art: Art?, val tracks: List<String>)

data class SnapLiked(val id: String, val ids: List<String>)

data class SnapRecent(val kind: String, val id: String)

/**
 * A run of the library's songs in its order: a page as the page sends it (its slot number and the
 * page's hash of its content), or every song of a whole snapshot (slot 0, no hash).
 */
class SnapPage(val n: Int, val hash: String, val tracks: List<SnapTrack>) {
  /** Each song's title and artist as search compares them, made once per page. */
  val searchKeys: List<Pair<String, String>> by lazy { tracks.map { Search.norm(it.title) to Search.norm(it.artist) } }
}

/**
 * What a snapshot says besides its songs: the levels, the albums, artists, playlists, liked songs
 * and recents; in pages also the order of the pages and the page's hash of this index (empty once
 * the heart changed the liked songs here; null for a whole snapshot).
 */
class SnapIndex(
  val at: Long,
  val wifi: String,
  val cellular: String,
  val pages: List<Int>,
  val albums: List<SnapGroup>,
  val artists: List<SnapGroup>,
  val playlists: List<SnapGroup>,
  val liked: List<SnapLiked>,
  val recent: List<SnapRecent>,
  val hash: String?,
) {
  val albumById: Map<String, SnapGroup> by lazy { albums.associateBy { it.id } }
  val artistById: Map<String, SnapGroup> by lazy { artists.associateBy { it.id } }
  val playlistById: Map<String, SnapGroup> by lazy { playlists.associateBy { it.id } }

  /** Each album's name as search compares it. */
  val albumKeys: Map<String, String> by lazy { albums.associate { it.id to Search.norm(it.name) } }

  fun withLiked(l: List<SnapLiked>) = SnapIndex(at, wifi, cellular, pages, albums, artists, playlists, l, recent, if (hash == null) null else "")

  /** The index as the page sends it (format mpfy-browse-index). */
  fun toJson(): String {
    val o = LinkedHashMap<String, Any?>()
    o["format"] = Snapshot.INDEX_FORMAT
    o["v"] = 1
    o["at"] = at
    o["h"] = hash ?: ""
    o["quality"] = linkedMapOf("wifi" to wifi, "cellular" to cellular)
    o["pages"] = pages
    Snapshot.groupsTo(o, this)
    return Json.write(o)
  }
}

/** Songs in pages, read as one list. */
private class Concat(private val pages: List<SnapPage>) : AbstractList<SnapTrack>() {
  private val starts = IntArray(pages.size + 1).also { s -> pages.forEachIndexed { i, p -> s[i + 1] = s[i] + p.tracks.size } }
  override val size: Int get() = starts[pages.size]

  override fun get(index: Int): SnapTrack {
    if (index < 0 || index >= size) throw IndexOutOfBoundsException("$index of $size")
    var lo = 0
    var hi = pages.size - 1
    while (lo < hi) {
      val mid = (lo + hi + 1) ushr 1
      if (starts[mid] <= index) lo = mid else hi = mid - 1
    }
    return pages[lo].tracks[index - starts[lo]]
  }

  override fun iterator(): Iterator<SnapTrack> = pages.asSequence().flatMap { it.tracks.asSequence() }.iterator()
}

/**
 * The car's library: its index and its songs, in one page (a whole snapshot, bridges 4 to 6) or
 * in the pages the index names, in its order (bridge 7). trackById finds a song on any page.
 */
class Snapshot(val index: SnapIndex, val pages: List<SnapPage>, val trackById: Map<String, SnapTrack>) {
  constructor(
    at: Long,
    wifi: String,
    cellular: String,
    tracks: List<SnapTrack>,
    albums: List<SnapGroup>,
    artists: List<SnapGroup>,
    playlists: List<SnapGroup>,
    liked: List<SnapLiked>,
    recent: List<SnapRecent>,
  ) : this(SnapIndex(at, wifi, cellular, emptyList(), albums, artists, playlists, liked, recent, null), listOf(SnapPage(0, "", tracks)), tracks.associateBy { it.id })

  val at: Long get() = index.at
  val wifi: String get() = index.wifi
  val cellular: String get() = index.cellular
  val albums: List<SnapGroup> get() = index.albums
  val artists: List<SnapGroup> get() = index.artists
  val playlists: List<SnapGroup> get() = index.playlists
  val liked: List<SnapLiked> get() = index.liked
  val recent: List<SnapRecent> get() = index.recent
  val albumById: Map<String, SnapGroup> get() = index.albumById
  val artistById: Map<String, SnapGroup> get() = index.artistById
  val playlistById: Map<String, SnapGroup> get() = index.playlistById

  /** Every song, in the library's order. */
  val tracks: List<SnapTrack> = if (pages.size == 1) pages[0].tracks else Concat(pages)

  /** Sent in pages (bridge 7): what the heart changes is written to the index. */
  val paged: Boolean get() = index.hash != null

  fun withLiked(l: List<SnapLiked>) = Snapshot(index.withLiked(l), pages, trackById)

  /** The level the car streams at: mobile data's on a cellular network, Wi-Fi's otherwise. */
  fun levelFor(netType: String): String = if (netType == "cellular") cellular else wifi

  /** The whole snapshot (format mpfy-browse). */
  fun toJson(): String {
    val o = LinkedHashMap<String, Any?>()
    o["format"] = FORMAT
    o["v"] = 1
    o["at"] = at
    o["quality"] = linkedMapOf("wifi" to wifi, "cellular" to cellular)
    o["tracks"] = tracksJson(tracks)
    groupsTo(o, index)
    return Json.write(o)
  }

  companion object {
    const val FORMAT = "mpfy-browse"
    const val PAGE_FORMAT = "mpfy-browse-page"
    const val INDEX_FORMAT = "mpfy-browse-index"
    /** Songs the car holds at most: a whole snapshot, or all the pages together. */
    const val MAX_TRACKS = 20_000
    /** A whole snapshot, or one page, at most. */
    const val MAX_CHARS = 4 * 1024 * 1024
    /** An index at most (its groups name every song, the liked ones again). */
    const val MAX_INDEX_CHARS = 16 * 1024 * 1024
    const val PAGE_TRACKS = 2_000
    /** Slot numbers run from 0 to this, excluded. */
    const val MAX_PAGES = 256
    private val HEX = Regex("[0-9a-f]{1,64}")
    private val SOURCE = Regex("[0-9a-f]{8}")
    private val COVER = Regex("[0-9a-f]{24}")
    private val KINDS = setOf("album", "playlist", "artist", "liked")

    fun isHex(s: String?) = s != null && HEX.matches(s)

    private class Bad : Exception()

    /** The whole snapshot, or null when the text does not have its shape. */
    fun parse(text: String): Snapshot? {
      if (text.length > MAX_CHARS) return null
      return guarded(text) { o ->
        need(o.str("format") == FORMAT && o.long("v") == 1L)
        val trackObjs = objs(o, "tracks")
        need(trackObjs.size <= MAX_TRACKS)
        val tracks = trackObjs.map { track(it) }
        Snapshot(readIndex(o, emptyList(), null), listOf(SnapPage(0, "", tracks)), tracks.associateBy { it.id })
      }
    }

    /** One page (bridge 7), or null when the text does not have its shape. */
    fun parsePage(text: String): SnapPage? {
      if (text.length > MAX_CHARS) return null
      return guarded(text) { o ->
        need(o.str("format") == PAGE_FORMAT && o.long("v") == 1L)
        val n = req(o.long("n"))
        need(n in 0 until MAX_PAGES)
        val trackObjs = objs(o, "tracks")
        need(trackObjs.size in 1..PAGE_TRACKS)
        SnapPage(n.toInt(), hexOf(o, "h"), trackObjs.map { track(it) })
      }
    }

    /** The index (bridge 7), or null when the text does not have its shape. */
    fun parseIndex(text: String): SnapIndex? {
      if (text.length > MAX_INDEX_CHARS) return null
      return guarded(text) { o ->
        need(o.str("format") == INDEX_FORMAT && o.long("v") == 1L)
        val h = req(o.str("h"))
        need(h.isEmpty() || isHex(h))
        val pages = req(o.list("pages")).map { (it as? Long)?.takeIf { n -> n in 0 until MAX_PAGES }?.toInt() ?: throw Bad() }
        need(pages.toSet().size == pages.size)
        readIndex(o, pages, h)
      }
    }

    private fun <T> guarded(text: String, read: (Map<String, Any?>) -> T): T? {
      val o = Json.obj(text) ?: return null
      return try {
        read(o)
      } catch (e: Bad) {
        null
      } catch (e: ClassCastException) {
        null
      }
    }

    private fun need(ok: Boolean) {
      if (!ok) throw Bad()
    }

    private fun <T> req(v: T?): T = v ?: throw Bad()

    @Suppress("UNCHECKED_CAST")
    private fun objs(o: Map<String, Any?>, k: String): List<Map<String, Any?>> =
      req(o.list(k)).map { req(it as? Map<String, Any?>) }

    private fun ids(v: Any?): List<String> = req(v as? List<*>).map { x -> (x as? String)?.takeIf { isHex(it) } ?: throw Bad() }

    private fun hexOf(o: Map<String, Any?>, k: String): String = req(o.str(k)?.takeIf { isHex(it) })

    private fun intOrNull(o: Map<String, Any?>, k: String): Int? {
      if (!o.containsKey(k) || o[k] == null) return null
      val n = req(o.long(k))
      need(n in Int.MIN_VALUE..Int.MAX_VALUE)
      return n.toInt()
    }

    private fun art(v: Any?): Art? {
      if (v == null) return null
      val a = req(v as? List<*>)
      need(a.size == 3)
      val s = req(a[0] as? String)
      val l = req(a[1] as? String)
      val m = req(a[2] as? String)
      need(SOURCE.matches(s) && COVER.matches(l) && COVER.matches(m))
      return Art(s, l, m)
    }

    private fun track(t: Map<String, Any?>): SnapTrack {
      val d = req(t.long("d"))
      need(d >= 0)
      val versions = objs(t, "v").map { v ->
        val s = req(v.str("s")?.takeIf { Levels.isId(it) })
        val tr = req(v.str("tr")?.takeIf { Levels.isId(it) })
        val f = req(v.str("f")?.takeIf { Levels.isId(it) })
        // "a": 1 when its original is on a memory card that is away from its source.
        if (v["a"] != null) need(v.long("a") == 1L)
        SnapVersion(s, tr, f, if (v["o"] == null) 0L else req(v.long("o")), v["a"] != null)
      }
      val al = req(t.str("al"))
      need(al.isEmpty() || isHex(al))
      return SnapTrack(hexOf(t, "id"), req(t.str("t")), req(t.str("a")), req(t.str("aa")), al, intOrNull(t, "n"), d, art(t["art"]), versions)
    }

    /** What a whole snapshot and an index share: the time, the levels and the groups. */
    private fun readIndex(o: Map<String, Any?>, pages: List<Int>, hash: String?): SnapIndex {
      val at = if (o["at"] == null) 0L else req(o.long("at"))
      val q = req(o.map("quality"))
      val wifi = req(q.str("wifi")?.takeIf { it in Levels.ALL })
      val cell = req(q.str("cellular")?.takeIf { it in Levels.ALL })
      val albums = objs(o, "albums").map { a ->
        SnapGroup(hexOf(a, "id"), req(a.str("n")), req(a.str("a")), intOrNull(a, "y"), art(a["art"]), ids(a["tr"]))
      }
      val artists = objs(o, "artists").map { a -> SnapGroup(hexOf(a, "id"), req(a.str("n")), "", null, art(a["art"]), ids(a["tr"])) }
      val playlists = objs(o, "playlists").map { a -> SnapGroup(hexOf(a, "id"), req(a.str("n")), "", null, art(a["art"]), ids(a["tr"])) }
      val liked = objs(o, "liked").map { l -> SnapLiked(hexOf(l, "id"), ids(l["ids"])) }
      val recent = objs(o, "recent").map { r ->
        val k = req(r.str("k")?.takeIf { it in KINDS })
        val id = req(r.str("id"))
        need(if (k == "liked") id.isEmpty() else isHex(id))
        SnapRecent(k, id)
      }
      return SnapIndex(at, wifi, cell, pages, albums, artists, playlists, liked, recent, hash)
    }

    private fun artJson(a: Art?): Any? = a?.let { listOf(it.sourceId, it.large, it.small) }

    fun tracksJson(tracks: List<SnapTrack>): List<Any?> = tracks.map { t ->
      linkedMapOf(
        "id" to t.id, "t" to t.title, "a" to t.artist, "aa" to t.albumArtist, "al" to t.albumId, "n" to t.trackNo,
        "d" to t.durationMs, "art" to artJson(t.art),
        "v" to t.versions.map { v -> linkedMapOf<String, Any?>("s" to v.sourceId, "tr" to v.trackId, "f" to v.fileHash, "o" to v.offsetMs).also { if (v.away) it["a"] = 1L } },
      )
    }

    internal fun groupsTo(o: MutableMap<String, Any?>, i: SnapIndex) {
      o["albums"] = i.albums.map { linkedMapOf("id" to it.id, "n" to it.name, "a" to it.artist, "y" to it.year, "art" to artJson(it.art), "tr" to it.tracks) }
      o["artists"] = i.artists.map { linkedMapOf("id" to it.id, "n" to it.name, "art" to artJson(it.art), "tr" to it.tracks) }
      o["playlists"] = i.playlists.map { linkedMapOf("id" to it.id, "n" to it.name, "art" to artJson(it.art), "tr" to it.tracks) }
      o["liked"] = i.liked.map { linkedMapOf("id" to it.id, "ids" to it.ids) }
      o["recent"] = i.recent.map { linkedMapOf("k" to it.kind, "id" to it.id) }
    }
  }
}

/** The context a queue came from, as setQueue and getQueue carry it. */
data class QueueCtx(val kind: String, val id: String?) {
  fun toJson(): String = Json.write(linkedMapOf("k" to kind, "id" to id))

  companion object {
    val KINDS = setOf("album", "artist", "playlist", "liked", "search", "library")

    /** The page's { k, id } (id null for liked and library), or null. */
    fun of(o: Map<String, Any?>?): QueueCtx? {
      val k = o?.str("k")?.takeIf { it in KINDS } ?: return null
      if (k == "liked" || k == "library") return QueueCtx(k, null)
      return QueueCtx(k, o.str("id") ?: return null)
    }

    fun parse(text: String?): QueueCtx? = text?.let { of(Json.obj(it)) }
  }
}

/** The tree's ids: root, cat:<word>, al:/ar:/pl:<id> and tr:<ctx>:<ctxId>:<group id>. */
sealed class MediaId {
  object Root : MediaId()

  data class Cat(val name: String) : MediaId()

  data class Group(val kind: String, val id: String) : MediaId()

  data class Track(val ctx: String, val ctxId: String, val gid: String) : MediaId()

  companion object {
    const val ROOT = "root"
    val CATS = listOf("recent", "playlists", "albums", "artists", "liked", "library")
    private val SEARCH_HASH = Regex("[0-9a-f]{8}")

    fun parse(id: String?): MediaId? {
      if (id == null) return null
      if (id == ROOT) return Root
      val p = id.split(':')
      return when (p[0]) {
        "cat" -> if (p.size == 2 && p[1] in CATS) Cat(p[1]) else null
        "al", "ar", "pl" -> if (p.size == 2 && Snapshot.isHex(p[1])) Group(p[0], p[1]) else null
        "tr" -> {
          if (p.size != 4 || !Snapshot.isHex(p[3])) return null
          val ok = when (p[1]) {
            "al", "ar", "pl" -> Snapshot.isHex(p[2])
            "lk" -> p[2].isEmpty()
            "s" -> SEARCH_HASH.matches(p[2])
            else -> false
          }
          if (ok) Track(p[1], p[2], p[3]) else null
        }
        else -> null
      }
    }

    fun track(ctx: String, ctxId: String, gid: String) = "tr:$ctx:$ctxId:$gid"
  }
}

/** The six category names, from the app's strings. */
data class Labels(
  val recent: String,
  val playlists: String,
  val albums: String,
  val artists: String,
  val liked: String,
  val library: String,
  val oneTrack: String,
  val nTracks: String,
)

/** What a browse node is, as Media3 media types. */
enum class NodeKind { FOLDER_MIXED, FOLDER_ALBUMS, FOLDER_ARTISTS, FOLDER_PLAYLISTS, ALBUM, ARTIST, PLAYLIST, MUSIC }

data class Node(
  val id: String,
  val title: String,
  val subtitle: String?,
  val kind: NodeKind,
  val artUri: String?,
  /** For a playable song: the song and its album's name. */
  val track: SnapTrack? = null,
  val album: String? = null,
) {
  val playable: Boolean get() = kind == NodeKind.MUSIC
}

/** What a car tap plays: the songs in order, where to start, and the context they came from. */
data class Expansion(val tracks: List<SnapTrack>, val start: Int, val ctx: QueueCtx?)

/** The last few searches, so a tapped result plays among its results. Any thread. */
class SearchMemory(private val max: Int = 4) {
  private val map = object : LinkedHashMap<String, Pair<String, List<String>>>(8, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<String, List<String>>>?) = size > max
  }

  @Synchronized
  fun put(hash: String, query: String, ids: List<String>) {
    map[hash] = query to ids
  }

  @Synchronized
  fun get(hash: String): Pair<String, List<String>>? = map[hash]
}

class BrowseTree(private val snap: Snapshot, private val labels: Labels) {
  fun rootNode() = Node(MediaId.ROOT, "MPfy", null, NodeKind.FOLDER_MIXED, null)

  /** Five tabs, or for a browser that allows only 1 to 4: Recenti, Playlist, Mi piace, Libreria (Album and Artisti inside), cut to the limit. */
  fun rootChildren(limit: Int?): List<Node> =
    if (limit != null && limit in 1..4) {
      listOf(cat("recent"), cat("playlists"), cat("liked"), cat("library")).take(limit)
    } else {
      listOf(cat("recent"), cat("playlists"), cat("albums"), cat("artists"), cat("liked"))
    }

  private fun cat(name: String): Node = when (name) {
    "recent" -> Node("cat:recent", labels.recent, null, NodeKind.FOLDER_MIXED, null)
    "playlists" -> Node("cat:playlists", labels.playlists, null, NodeKind.FOLDER_PLAYLISTS, null)
    "albums" -> Node("cat:albums", labels.albums, null, NodeKind.FOLDER_ALBUMS, null)
    "artists" -> Node("cat:artists", labels.artists, null, NodeKind.FOLDER_ARTISTS, null)
    "liked" -> Node("cat:liked", labels.liked, null, NodeKind.FOLDER_MIXED, null)
    else -> Node("cat:library", labels.library, null, NodeKind.FOLDER_MIXED, null)
  }

  private fun count(n: Int) = if (n == 1) labels.oneTrack else labels.nTracks.format(n)

  private fun albumNode(a: SnapGroup) = Node("al:${a.id}", a.name, a.artist, NodeKind.ALBUM, a.art?.uri("large"))

  private fun artistNode(a: SnapGroup) = Node("ar:${a.id}", a.name, null, NodeKind.ARTIST, a.art?.uri("large"))

  private fun playlistNode(p: SnapGroup) = Node("pl:${p.id}", p.name, count(present(p.tracks).size), NodeKind.PLAYLIST, p.art?.uri("large"))

  fun trackNode(id: String, t: SnapTrack) =
    Node(id, t.title, t.artist, NodeKind.MUSIC, t.art?.uri("small"), t, snap.albumById[t.albumId]?.name ?: "")

  private fun present(ids: List<String>): List<SnapTrack> = ids.mapNotNull { snap.trackById[it] }

  private fun tracksOf(ctx: String, ctxId: String, ids: List<String>) = present(ids).map { trackNode(MediaId.track(ctx, ctxId, it.id), it) }

  private fun likedIds(): List<String> = snap.liked.map { it.id }

  /** A node's children, or null when the id names nothing browsable. */
  fun children(id: String, rootLimit: Int?): List<Node>? = when (val m = MediaId.parse(id)) {
    MediaId.Root -> rootChildren(rootLimit)
    is MediaId.Cat -> when (m.name) {
      "library" -> listOf(cat("albums"), cat("artists"))
      "recent" -> snap.recent.mapNotNull { r ->
        when (r.kind) {
          "album" -> snap.albumById[r.id]?.let { albumNode(it) }
          "artist" -> snap.artistById[r.id]?.let { artistNode(it) }
          "playlist" -> snap.playlistById[r.id]?.let { playlistNode(it) }
          else -> cat("liked")
        }
      }
      "playlists" -> snap.playlists.map { playlistNode(it) }
      "albums" -> snap.albums.map { albumNode(it) }
      "artists" -> snap.artists.map { artistNode(it) }
      else -> tracksOf("lk", "", likedIds())
    }
    is MediaId.Group -> when (m.kind) {
      "al" -> snap.albumById[m.id]?.let { tracksOf("al", it.id, it.tracks) }
      "ar" -> snap.artistById[m.id]?.let { tracksOf("ar", it.id, it.tracks) }
      else -> snap.playlistById[m.id]?.let { tracksOf("pl", it.id, it.tracks) }
    }
    else -> null
  }

  /** Any id of the tree, or null. */
  fun item(id: String): Node? = when (val m = MediaId.parse(id)) {
    null -> null
    MediaId.Root -> rootNode()
    is MediaId.Cat -> cat(m.name)
    is MediaId.Group -> when (m.kind) {
      "al" -> snap.albumById[m.id]?.let { albumNode(it) }
      "ar" -> snap.artistById[m.id]?.let { artistNode(it) }
      else -> snap.playlistById[m.id]?.let { playlistNode(it) }
    }
    is MediaId.Track -> snap.trackById[m.gid]?.let { trackNode(id, it) }
  }

  /** The songs a car tap on [id] queues, or null when there is nothing to play. */
  fun expand(id: String, searches: SearchMemory): Expansion? {
    when (val m = MediaId.parse(id)) {
      is MediaId.Track -> {
        val t = snap.trackById[m.gid] ?: return null
        val ctx: Pair<List<String>, QueueCtx>? = when (m.ctx) {
          "al" -> snap.albumById[m.ctxId]?.let { it.tracks to QueueCtx("album", it.id) }
          "ar" -> snap.artistById[m.ctxId]?.let { it.tracks to QueueCtx("artist", it.id) }
          "pl" -> snap.playlistById[m.ctxId]?.let { it.tracks to QueueCtx("playlist", it.id) }
          "lk" -> likedIds() to QueueCtx("liked", null)
          else -> searches.get(m.ctxId)?.let { (q, ids) -> ids to QueueCtx("search", q) }
        }
        val list = ctx?.let { present(it.first) }.orEmpty()
        val start = list.indexOfFirst { it.id == t.id }
        if (ctx == null || start < 0) return Expansion(listOf(t), 0, null)
        return Expansion(list, start, ctx.second)
      }
      is MediaId.Group -> {
        val g = when (m.kind) {
          "al" -> snap.albumById[m.id]?.let { it to QueueCtx("album", it.id) }
          "ar" -> snap.artistById[m.id]?.let { it to QueueCtx("artist", it.id) }
          else -> snap.playlistById[m.id]?.let { it to QueueCtx("playlist", it.id) }
        } ?: return null
        val list = present(g.first.tracks)
        return if (list.isEmpty()) null else Expansion(list, 0, g.second)
      }
      is MediaId.Cat -> {
        if (m.name != "liked") return null
        val list = present(likedIds())
        return if (list.isEmpty()) null else Expansion(list, 0, QueueCtx("liked", null))
      }
      else -> return null
    }
  }

  /** Songs whose title, artist or album holds the query: title matches first, then artist, then album; at most 50. */
  fun search(query: String): List<SnapTrack> {
    val q = Search.norm(query)
    if (q.isEmpty()) return emptyList()
    val byTitle = ArrayList<SnapTrack>()
    val byArtist = ArrayList<SnapTrack>()
    val byAlbum = ArrayList<SnapTrack>()
    val albums = snap.index.albumKeys
    for (page in snap.pages) {
      val keys = page.searchKeys
      for ((i, t) in page.tracks.withIndex()) {
        val (title, artist) = keys[i]
        when {
          title.contains(q) -> byTitle.add(t)
          artist.contains(q) -> byArtist.add(t)
          (albums[t.albumId] ?: "").contains(q) -> byAlbum.add(t)
        }
      }
    }
    return (byTitle + byArtist + byAlbum).take(Search.MAX)
  }

  /** The results of [query] as tree nodes, remembered for the tap that plays one. */
  fun searchNodes(query: String, searches: SearchMemory): List<Node> {
    val found = search(query)
    val hash = Search.hash(query)
    searches.put(hash, query, found.map { it.id })
    return found.map { trackNode(MediaId.track("s", hash, it.id), it) }
  }
}

object Search {
  const val MAX = 50
  private val MARKS = Regex("\\p{M}+")
  private val SPACES = Regex("\\s+")

  /** NFKD, combining marks out, lowercase, whitespace collapsed. */
  fun norm(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase().replace(SPACES, " ").trim()

  /** The first 8 hex of the SHA-256 of the normalized query. */
  fun hash(query: String): String =
    MessageDigest.getInstance("SHA-256").digest(norm(query).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.substring(0, 8)
}

/** The versions a car item plays: downloaded first (best level first), then those on a source up now, then the rest; at most 4. */
object CarVersions {
  const val MAX = 4

  fun order(t: SnapTrack, completed: Set<String>, isUp: (String) -> Boolean): List<Version> {
    val all = t.versions.map { Version(it.sourceId, it.trackId, it.fileHash, "", it.offsetMs) }.distinctBy { it.id }
    val downloaded = VersionOrder.order(all, completed).filter { Levels.bestDownload(it.trackId, it.fileHash, completed) != null }
    val rest = all.filter { v -> downloaded.none { it.id == v.id } }
    // A version whose original is on a card away from its source cannot play: with the down ones.
    val away = t.versions.filter { it.away }.map { Triple(it.sourceId, it.trackId, it.fileHash) }.toSet()
    val playable = { v: Version -> isUp(v.sourceId) && Triple(v.sourceId, v.trackId, v.fileHash) !in away }
    val up = rest.filter { playable(it) }
    val down = rest.filter { !playable(it) }
    return (downloaded + up + down).take(MAX)
  }
}

/**
 * The snapshot in use, its like map (setLiked from the page keeps it right between two
 * snapshots) and the last searches. Any thread.
 *
 * In pages (bridge 7): every page held by its slot, the index, and one lookup of every song held.
 * A page replaces its slot's songs alone: the lookup gains the new songs and loses only the old
 * ones that no other page has put since, so a song moving between two pages is never lost once
 * both have come; the other pages are not read again. A page waits for an index that names it,
 * and an index drops the pages it does not name. At most twice [maxTracks] songs are held (the old
 * pages and the new ones while the page moves them), [maxTracks] are shown.
 */
class BrowseState(private val maxTracks: Int = Snapshot.MAX_TRACKS) {
  @Volatile
  var snapshot: Snapshot? = null
    private set

  private val likedMap = HashMap<String, List<String>>()
  val searches = SearchMemory()

  private val pages = HashMap<Int, SnapPage>()
  private val byId = ConcurrentHashMap<String, SnapTrack>()
  private val byIdView: Map<String, SnapTrack> = Collections.unmodifiableMap(byId)
  private var index: SnapIndex? = null
  private var heldTracks = 0

  /** A whole snapshot: the pages and their index go. */
  @Synchronized
  fun replace(s: Snapshot) {
    pages.clear()
    byId.clear()
    heldTracks = 0
    index = null
    show(s)
  }

  private fun show(s: Snapshot) {
    snapshot = s
    likedMap.clear()
    for (l in s.liked) likedMap[l.id] = l.ids
  }

  /** A page: false when it would hold more songs than allowed (refused, nothing changes). */
  @Synchronized
  fun putPage(p: SnapPage): Boolean {
    val old = pages[p.n]
    val after = heldTracks - (old?.tracks?.size ?: 0) + p.tracks.size
    if (after > 2 * maxTracks) return false
    pages[p.n] = p
    heldTracks = after
    for (t in p.tracks) byId[t.id] = t
    if (old != null) forget(old)
    if (index != null) compose()
    return true
  }

  /** The index: shown with the pages it names that are here. The slots it drops, whose files can go. */
  @Synchronized
  fun putIndex(i: SnapIndex): List<Int> {
    val named = i.pages.toHashSet()
    val gone = pages.keys.filter { it !in named }
    for (n in gone) {
      val p = pages.remove(n) ?: continue
      heldTracks -= p.tracks.size
      forget(p)
    }
    index = i
    val s = compose()
    likedMap.clear()
    for (l in s.liked) likedMap[l.id] = l.ids
    return gone
  }

  /** The songs of a page that went, unless another page put the same id since. */
  private fun forget(p: SnapPage) {
    for (t in p.tracks) if (byId[t.id] === t) byId.remove(t.id)
  }

  private fun compose(): Snapshot {
    val i = index!!
    val shown = ArrayList<SnapPage>(i.pages.size)
    var total = 0
    for (n in i.pages) {
      val p = pages[n] ?: continue
      if (total + p.tracks.size > maxTracks) break
      shown.add(p)
      total += p.tracks.size
    }
    val s = Snapshot(i, shown, byIdView)
    snapshot = s
    return s
  }

  /** What the page needs to send only what moved: { index, pages: [{ n, h, first }] } in the index's order. */
  @Synchronized
  fun held(): String {
    val i = index ?: return Json.write(linkedMapOf("index" to null, "pages" to emptyList<Any>()))
    val list = i.pages.mapNotNull { n -> pages[n]?.let { p -> linkedMapOf("n" to n, "h" to p.hash, "first" to p.tracks[0].id) } }
    return Json.write(linkedMapOf("index" to i.hash, "pages" to list))
  }

  /** The page's word on one song: its liked member ids (none: not liked). */
  @Synchronized
  fun setLiked(id: String, liked: Boolean, likedIds: List<String>) {
    if (liked) likedMap[id] = likedIds.ifEmpty { listOf(id) } else likedMap.remove(id)
  }

  /** The heart changed a like: the map, and the liked list (newest first). The new snapshot, to be written. */
  @Synchronized
  fun likeDone(id: String, liked: Boolean, likedIds: List<String>): Snapshot? {
    setLiked(id, liked, likedIds)
    val s = snapshot ?: return null
    val rest = s.liked.filter { it.id != id }
    val next = s.withLiked(if (liked) listOf(SnapLiked(id, likedIds.ifEmpty { listOf(id) })) + rest else rest)
    if (index != null) index = next.index
    snapshot = next
    return next
  }

  /** The liked member ids of a song, or null when it is not liked. */
  @Synchronized
  fun likedOf(id: String): List<String>? = likedMap[id]
}
