package com.baccarancia.mpfy

import com.baccarancia.mpfy.Json.list
import com.baccarancia.mpfy.Json.long
import com.baccarancia.mpfy.Json.str

/** What a fake file holds: its id (the hash of its bytes), its length in seconds (null: not known), its album tag and its picture. */
internal data class Content(
  val id: String,
  val duration: Double? = 200.0,
  val album: String? = "Album",
  val cover: String? = null,
  val lyricsBytes: Int = 0,
  val outcome: Probe.Outcome = Probe.Outcome.OK,
)

/** MediaStore in memory: volumes, rows and their contents, a version and a generation per volume, and counters of what was read. */
internal class FakeMediaStore(var api30: Boolean = true) : MediaRows {
  class Vol(var version: String, var generation: Long = 1) {
    val rows = LinkedHashMap<Long, Row>()
  }

  val vols = LinkedHashMap<String, Vol>()
  val mounted = LinkedHashSet<String>()
  val contents = HashMap<Pair<String, Long>, Content>()
  var rowsRead = 0
  var listings = 0
  var idListings = 0
  var counts = 0
  var binderCalls = 0
  private var nextId = 1000L
  private var nextVersion = 1

  fun volume(name: String): Vol = vols.getOrPut(name) { Vol("v${nextVersion++}").also { mounted.add(name) } }

  private fun bump(v: Vol): Long = ++v.generation

  fun add(volume: String, relPath: String, name: String, content: Content, size: Long = 5_000_000, mtime: Long = 1_700_000_000_000, added: Long = mtime): Row {
    val v = volume(volume)
    val id = nextId++
    val g = bump(v)
    val row = Row(volume, id, relPath, name, size, mtime, added, if (api30) g else null, null)
    v.rows[id] = row
    contents[volume to id] = content
    return row
  }

  /** New bytes in place: the same id, a new size and time, what the file now holds. */
  fun rewrite(row: Row, content: Content, size: Long = row.size + 1000, mtime: Long = row.mtime + 60_000): Row {
    val v = volume(row.volume)
    val next = row.copy(size = size, mtime = mtime, generation = if (api30) bump(v) else null)
    v.rows[row.mediaId] = next
    contents[row.volume to row.mediaId] = content
    return next
  }

  fun delete(row: Row) {
    val v = volume(row.volume)
    v.rows.remove(row.mediaId)
    bump(v)
  }

  /** Moved by a file manager: a new id and path, the same name, size and time. */
  fun move(row: Row, relPath: String): Row {
    val content = contents.getValue(row.volume to row.mediaId)
    delete(row)
    return add(row.volume, relPath, row.name, content, row.size, row.mtime, added = row.added + 5_000)
  }

  /** Renamed in place: the same id. */
  fun rename(row: Row, relPath: String, name: String): Row {
    val v = volume(row.volume)
    val next = row.copy(relPath = relPath, name = name, generation = if (api30) bump(v) else null)
    v.rows[row.mediaId] = next
    return next
  }

  /** MediaStore rebuilt its database: new version, new ids, every DATE_ADDED new. */
  fun rebuild(volume: String, now: Long = 1_800_000_000_000) {
    val v = volume(volume)
    v.version = "v${nextVersion++}"
    v.generation = 1
    val old = v.rows.values.toList()
    v.rows.clear()
    for ((i, r) in old.withIndex()) {
      val id = nextId++
      val g = bump(v)
      v.rows[id] = r.copy(mediaId = id, added = now + i, generation = if (api30) g else null)
      contents[volume to id] = contents.getValue(volume to r.mediaId)
    }
  }

  fun row(volume: String, name: String): Row = volume(volume).rows.values.single { it.name == name }

  fun resetCounters() {
    rowsRead = 0
    listings = 0
    idListings = 0
    counts = 0
    binderCalls = 0
  }

  override fun volumes(): List<String> {
    binderCalls++
    return mounted.toList()
  }

  override fun version(volume: String): String {
    binderCalls++
    return vols.getValue(volume).version
  }

  override fun generation(volume: String): Long? {
    binderCalls++
    return if (api30) vols.getValue(volume).generation else null
  }

  override fun rows(volume: String, sinceGeneration: Long?): Sequence<Row> {
    listings++
    val list = vols.getValue(volume).rows.values
      .filter { sinceGeneration == null || (it.generation ?: 0) > sinceGeneration }
      .sortedByDescending { it.added }
    rowsRead += list.size
    return list.asSequence()
  }

  override fun ids(volume: String): LongArray {
    idListings++
    return vols.getValue(volume).rows.keys.sorted().toLongArray()
  }

  override fun count(volume: String): Int {
    counts++
    return vols.getValue(volume).rows.size
  }
}

/** Reads a fake file: what the store says it holds, and the list of rows read. */
internal class FakeReader(private val ms: FakeMediaStore) : FileReader {
  val reads = ArrayList<Row>()
  /** Rows whose next read ends as given, once. */
  val once = HashMap<Long, Probe.Outcome>()
  /** A read that kills the process (a native crash in a parser). */
  var crashOn: Long? = null
  /** Called at each read (the time it takes, an event meanwhile). */
  var onRead: ((Row) -> Unit)? = null

  override fun probe(row: Row): Probe {
    reads.add(row)
    onRead?.invoke(row)
    if (crashOn == row.mediaId) throw ProcessDeath()
    once.remove(row.mediaId)?.let { return Probe(it, null) }
    val c = ms.contents.getValue(row.volume to row.mediaId)
    if (c.outcome != Probe.Outcome.OK) return Probe(c.outcome, null)
    val lyrics = if (c.lyricsBytes > 0) mapOf("synced" to emptyList<Any>(), "texts" to listOf("la ".repeat(c.lyricsBytes / 3)), "lrc" to null) else null
    val tags = linkedMapOf<String, Any?>("title" to row.name.substringBeforeLast('.'), "artist" to "Artist", "album" to c.album, "albumArtist" to null, "trackNo" to 1L, "discNo" to null, "year" to 2020L)
    return Probe(
      Probe.Outcome.OK,
      Facts.of(c.id, tags, "mp3", "audio/mpeg", c.duration, 320_000L, 44_100L, null, c.cover, if (c.cover != null) "file" else null, lyrics),
    )
  }

  fun names(): List<String> = reads.map { it.name }

  /** What a measure of each row gives (absent: it cannot be measured), and the rows measured. */
  val loud = HashMap<Long, R128Meter.Result>()
  val measured = ArrayList<Row>()

  override fun loudness(row: Row): R128Meter.Result? {
    measured.add(row)
    return loud[row.mediaId]
  }
}

internal class ProcessDeath : Error("the process died here")

internal class FakeFolders : FolderArt {
  val asked = ArrayList<String>()
  val covers = HashMap<String, String>()

  override fun cover(file: FileRec): String? {
    asked.add(file.relPath)
    return covers[file.relPath]
  }
}

/** The core's side of the feed, applied as the core applies it (in order, acked after each batch). */
internal class CoreFeed {
  var token: String? = null
  var batch = 0L
  val tracks = LinkedHashMap<String, Map<String, Any?>>()
  private var sinceReset: HashSet<String>? = null
  val messages = ArrayList<Map<String, Any?>>()
  var applied = 0
  /** When false, batches are applied but no ack goes back (lost in a crash). */
  var acks = true

  @Suppress("UNCHECKED_CAST")
  fun apply(m: Map<String, Any?>): Long? {
    if (m.str("t") != "local") return null
    val tok = m.str("token")
    when (m.str("op")) {
      "reset" -> {
        token = tok
        batch = 0
        sinceReset = HashSet()
        return null
      }
      "put" -> for (t in m.list("tracks")!!) {
        val f = t as Map<String, Any?>
        tracks[f.str("id")!!] = f
        sinceReset?.add(f.str("id")!!)
      }
      "drop" -> for (id in m.list("ids")!!) tracks.remove(id as String)
      "end" -> {
        val keep = sinceReset ?: emptySet()
        tracks.keys.retainAll(keep)
        sinceReset = null
      }
      else -> return null
    }
    if (tok != token) error("a batch for token $tok while the core holds $token")
    val n = m.long("batch")!!
    if (n <= batch) error("batch $n after $batch")
    batch = n
    return n
  }
}

/** The host of the index: a clock, the IPC (into [core]), tokens, art deleted. */
internal class IndexHost(var now: Long = 1_750_000_000_000) : LocalIndex.Host {
  val lines = ArrayList<String>()
  val core = CoreFeed()
  val dropped = ArrayList<String>()
  var tokens = 0
  var up = true

  override fun now(): Long = now

  override fun send(line: String): Boolean {
    if (!up) return false
    lines.add(line)
    return true
  }

  override fun newToken(): String = "tok${++tokens}"

  override fun dropArt(coverId: String) {
    dropped.add(coverId)
  }

  override fun log(line: String) {}

  var charging = true

  override fun charging(): Boolean = charging

  @Suppress("UNCHECKED_CAST")
  fun sent(from: Int = 0): List<Map<String, Any?>> = lines.drop(from).map { Json.parse(it) as Map<String, Any?> }

  /** Delivers every line not delivered yet to the core, acks what it applied, and flushes again until nothing moves. */
  fun pump(ix: LocalIndex) {
    while (true) {
      ix.flush()
      if (core.applied == lines.size) return
      while (core.applied < lines.size) {
        val m = sent(core.applied).first()
        core.applied++
        core.messages.add(m)
        val n = core.apply(m)
        if (n != null && core.acks) ix.ack(core.token, n)
      }
    }
  }

  fun ops(from: Int = 0): List<String> = sent(from).filter { it.str("t") == "local" }.map { it.str("op")!! }
}

/** Runs tasks by a clock that moves only when told. */
internal class FakeScheduler(private val host: IndexHost) : LocalWork.Scheduler {
  private class Task(val at: Long, val seq: Long, val run: Runnable) {
    var cancelled = false
  }

  private val tasks = ArrayList<Task>()
  private var seq = 0L

  override fun now(): Long = host.now

  override fun post(task: Runnable) {
    tasks.add(Task(host.now, seq++, task))
  }

  override fun later(ms: Long, task: Runnable): LocalWork.Cancel {
    val t = Task(host.now + ms, seq++, task)
    tasks.add(t)
    return LocalWork.Cancel { t.cancelled = true }
  }

  /** Runs everything due now, including what those tasks post. */
  fun run() {
    while (true) {
      val next = tasks.filter { !it.cancelled && it.at <= host.now }.minWithOrNull(compareBy({ it.at }, { it.seq })) ?: break
      tasks.remove(next)
      next.run.run()
    }
    tasks.removeAll { it.cancelled }
  }

  /** Moves the clock by [ms], running each task at its time. */
  fun advance(ms: Long) {
    val end = host.now + ms
    while (true) {
      val next = tasks.filter { !it.cancelled && it.at <= end }.minWithOrNull(compareBy({ it.at }, { it.seq })) ?: break
      if (next.at > host.now) host.now = next.at
      tasks.remove(next)
      next.run.run()
    }
    host.now = end
    tasks.removeAll { it.cancelled }
  }

  fun waiting(): Int = tasks.count { !it.cancelled }
}

/** The cache in memory, with the semantics of the SQLite one; a crash keeps everything committed. */
internal class MemoryStore : LocalStore {
  private val files = LinkedHashMap<Long, FileRec>()
  private val tracks = LinkedHashMap<String, TrackRec>()
  private val meta = HashMap<String, String>()
  private var nextKey = 1L
  private var depth = 0
  private var undo: Triple<Map<Long, FileRec>, Map<String, TrackRec>, Map<String, String>>? = null
  private var undoLyrics: Map<Long, String>? = null

  override fun <T> tx(block: () -> T): T {
    if (depth == 0) {
      undo = Triple(LinkedHashMap(files), LinkedHashMap(tracks), HashMap(meta))
      undoLyrics = HashMap(lyrics)
    }
    depth++
    try {
      val r = block()
      depth--
      if (depth == 0) undo = null
      return r
    } catch (e: Throwable) {
      depth--
      if (depth == 0) {
        val u = undo!!
        files.clear()
        files.putAll(u.first)
        tracks.clear()
        tracks.putAll(u.second)
        meta.clear()
        meta.putAll(u.third)
        lyrics.clear()
        lyrics.putAll(undoLyrics!!)
        undo = null
      }
      throw e
    }
  }

  override fun meta(key: String): String? = meta[key]

  override fun setMeta(key: String, value: String?) {
    if (value == null) meta.remove(key) else meta[key] = value
  }

  override fun file(volume: String, mediaId: Long): FileRec? = files.values.firstOrNull { it.volume == volume && it.mediaId == mediaId && it.goneAt == null }

  override fun fileByKey(key: Long): FileRec? = files[key]

  override fun filesOf(volume: String): List<FileRec> = files.values.filter { it.volume == volume }

  override fun volumes(): Set<String> = files.values.filter { it.goneAt == null && !it.away }.map { it.volume }.toSet()

  override fun presentCount(volume: String): Int = files.values.count { it.volume == volume && it.goneAt == null && !it.away }

  override fun goneLike(volume: String, name: String, size: Long, mtime: Long): List<FileRec> =
    files.values.filter { it.volume == volume && it.goneAt != null && it.name == name && it.size == size && it.mtime == mtime }

  override fun samePath(volume: String, relPath: String, name: String): List<FileRec> =
    files.values.filter { it.volume == volume && it.relPath == relPath && it.name == name }

  override fun folder(volume: String, relPath: String): List<FileRec> = files.values.filter { it.volume == volume && it.relPath == relPath && it.goneAt == null }

  override fun filesOfTrack(trackId: String): List<FileRec> = files.values.filter { it.trackId == trackId }

  override fun nextNew(skip: Set<Long>): FileRec? =
    files.values.filter { it.state == LocalStore.NEW && it.goneAt == null && !it.away && it.key !in skip }
      .sortedWith(compareByDescending<FileRec> { it.added }.thenBy { it.key }).firstOrNull()

  override fun withState(state: String): List<FileRec> = files.values.filter { it.state == state }

  override fun goneBefore(time: Long): List<FileRec> = files.values.filter { it.goneAt != null && it.goneAt < time }

  override fun countToRead(): Int = files.values.count { (it.state == LocalStore.NEW || it.state == LocalStore.PROBING) && it.goneAt == null && !it.away }

  override fun insert(f: FileRec): Long {
    if (f.goneAt == null) check(file(f.volume, f.mediaId) == null) { "two rows for ${f.volume}/${f.mediaId}" }
    val k = nextKey++
    files[k] = f.copy(key = k)
    return k
  }

  override fun update(f: FileRec) {
    check(files.containsKey(f.key))
    if (f.goneAt == null) check(files.values.none { it.key != f.key && it.volume == f.volume && it.mediaId == f.mediaId && it.goneAt == null }) { "two rows for ${f.volume}/${f.mediaId}" }
    files[f.key] = f
  }

  override fun delete(key: Long) {
    files.remove(key)
    lyrics.remove(key)
  }

  private val lyrics = HashMap<Long, String>()

  override fun lyrics(key: Long): String? = lyrics[key]

  override fun setLyrics(key: Long, json: String?) {
    if (json == null) lyrics.remove(key) else lyrics[key] = json
  }

  override fun track(trackId: String): TrackRec? = tracks[trackId]

  override fun putTrack(t: TrackRec) {
    tracks[t.trackId] = t
  }

  override fun deleteTrack(trackId: String) {
    tracks.remove(trackId)
  }

  override fun unsent(present: Boolean, limit: Int): List<TrackRec> =
    tracks.values.filter { !it.fed && it.batch == null && it.present == present }
      .sortedWith(compareByDescending<TrackRec> { it.added }.thenBy { it.trackId }).take(limit)

  override fun inFlightUpTo(batch: Long): List<TrackRec> = tracks.values.filter { !it.fed && it.batch != null && it.batch <= batch }

  override fun unsendAfter(batch: Long) {
    for (t in tracks.values.toList()) if (!t.fed && t.batch != null && t.batch > batch) tracks[t.trackId] = t.copy(batch = null)
  }

  override fun unsendAll() {
    for (t in tracks.values.toList()) tracks[t.trackId] = t.copy(fed = false, batch = null, sentHash = null)
  }

  override fun countUnfed(): Int = tracks.values.count { !it.fed }

  override fun countUnsent(): Int = tracks.values.count { !it.fed && it.batch == null }

  override fun coverUsed(coverId: String): Boolean = files.values.any { it.coverId == coverId } || tracks.values.any { it.coverId == coverId }

  override fun close() {}

  fun allFiles(): List<FileRec> = files.values.toList()

  fun allTracks(): List<TrackRec> = tracks.values.toList()
}
