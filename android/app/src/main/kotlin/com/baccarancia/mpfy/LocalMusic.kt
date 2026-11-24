package com.baccarancia.mpfy

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.os.storage.StorageManager
import android.provider.MediaStore
import android.util.Log
import android.util.Size
import androidx.core.content.ContextCompat
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** The cover of the folder a song without its own picture sits in. */
interface FolderArt {
  /** An id whose sizes exist, or null when the folder has no picture to give. */
  fun cover(file: FileRec): String?
}

/**
 * The index of the phone's music: MediaStore's audio rows met against the cache, each new file
 * read once, the tracks fed to the core in batches it acks. Pure logic over [LocalStore],
 * [MediaRows], [FileReader] and [FolderArt]; one thread calls it (LocalMusic's, or a test).
 *
 * A check reads nothing when MediaStore's version and generation did not move; a moved generation
 * reads only the rows modified since, and the id list only when the count says a row went. A
 * row whose name, size and time match a row that went (a move, a rebuilt database) takes its
 * facts without a read. The feed: every track whose facts or presence changed is sent (put or
 * drop); the core's ack marks it fed only for what was sent; at hello a token unlike ours means the
 * core lost its log (or we lost ours): a reset, every track, an end.
 */
class LocalIndex(
  private val store: LocalStore,
  private val media: MediaRows,
  private val reader: FileReader,
  private val folders: FolderArt,
  private val host: Host,
) {
  interface Host {
    fun now(): Long

    /** One message to the core; false when no core takes it now. */
    fun send(line: String): Boolean

    fun newToken(): String

    fun dropArt(coverId: String)

    fun log(line: String)

    fun readingStarted() {}

    fun readingEnded(files: Int, bytes: Long, ms: Long) {}

    /** The phone is charging: the loudness of its songs is measured only then. */
    fun charging(): Boolean = true
  }

  companion object {
    const val MAX_TRACKS = 200
    const val MAX_PUT_BYTES = 256 * 1024
    // Batches sent and not yet acked, at most.
    const val WINDOW = 4
    const val GONE_KEEP_MS = 24L * 3600 * 1000
    const val MAX_WAS = 8
    private const val DROP = "-"
    // Set once the length rule (LocalPolicy.tooShort) went over the rows read before it.
    private const val SHORT_RULE = "short_rule"
    private const val NEAR_S = 1.0
  }

  var granted = false
    private set
  private var connected = false
  private val inFlight = ArrayList<Long>()
  private var lastProgress = -1
  private var lastAccess: Boolean? = null
  // Rows read while they changed: left until the next check.
  private val deferred = HashSet<Long>()
  private val touchedFolders = LinkedHashSet<Pair<String, String>>()
  private val artCandidates = HashSet<String>()
  private var runFiles = 0
  private var runBytes = 0L
  private var runStart = -1L

  /** At start: a row a dead process was reading is unreadable until it changes; without the permission every row is away. */
  fun open(granted: Boolean) {
    this.granted = granted
    store.tx {
      for (f in store.withState(LocalStore.PROBING)) store.update(f.copy(state = LocalStore.UNREADABLE, tries = f.tries + 1))
    }
    if (!granted) awayAll()
  }

  /** The permission changed: false makes every row away (its track dropped); true waits for the check. */
  fun setAccess(granted: Boolean): Boolean {
    if (granted == this.granted) return false
    this.granted = granted
    deferred.clear()
    if (!granted) awayAll()
    sendAccess()
    return true
  }

  private fun awayAll() {
    for (v in store.volumes()) markAway(v)
  }

  private fun markAway(volume: String) {
    store.tx {
      val touched = HashSet<String>()
      for (f in store.filesOf(volume)) {
        if (f.goneAt != null || f.away) continue
        store.update(f.copy(away = true))
        f.trackId?.let(touched::add)
      }
      store.setMeta("away:$volume", "1")
      refresh(touched)
    }
  }

  // ------------------------------------------------------------------ the check

  fun check() {
    if (!granted) return
    deferred.clear()
    val now = host.now()
    var rows = 0
    var idLists = 0
    var counts = 0
    val vols = media.volumes()
    for (v in store.volumes() - vols.toSet()) markAway(v)
    purge(now)
    dropShort()
    for (v in vols) {
      val version = media.version(v)
      val known = store.meta("version:$v")
      val gen = media.generation(v)
      val stored = store.meta("gen:$v")?.toLongOrNull()
      val away = store.meta("away:$v") != null
      when {
        known != version -> rows += full(v, rebuild = known != null, version, gen, now)
        away || gen == null || stored == null -> rows += full(v, rebuild = false, version, gen, now)
        stored == gen -> continue
        else -> {
          val changed = media.rows(v, stored).toList()
          rows += changed.size
          val fresh = changed.count { store.file(v, it.mediaId) == null }
          val expected = store.presentCount(v) + fresh
          val count = media.count(v)
          counts++
          if (count > expected) {
            // The cache misses rows it was never told of: listed whole once.
            rows += full(v, rebuild = false, version, gen, now)
            continue
          }
          val ids = if (count < expected) media.ids(v).also { idLists++ } else null
          store.tx {
            val touched = HashSet<String>()
            if (ids != null) {
              val listed = HashSet<Long>(ids.size * 2).apply { for (id in ids) add(id) }
              for (f in store.filesOf(v)) if (f.present && f.mediaId !in listed) gone(f, now, touched)
            }
            for (r in changed) apply(r, store.file(v, r.mediaId), now, touched)
            store.setMeta("gen:$v", gen.toString())
            refresh(touched)
          }
        }
      }
    }
    host.log("check: ${vols.size} volumes, $rows rows, $idLists id lists, $counts counts, ${store.countToRead()} files to read")
  }

  /** The whole listing of a volume, met against the cache; the rows read. */
  private fun full(v: String, rebuild: Boolean, version: String, gen: Long?, now: Long): Int {
    val listed = media.rows(v, null).toList()
    store.tx {
      val touched = HashSet<String>()
      val cached = HashMap<Long, FileRec>()
      for (f in store.filesOf(v)) if (f.goneAt == null) cached[f.mediaId] = f
      if (rebuild) {
        // Every id is new: rows meet the cache by path, name, size and time, then by name, size and time.
        for (f in cached.values) gone(f, now, touched)
        for (r in listed) apply(r, null, now, touched)
      } else {
        val ids = HashSet<Long>(listed.size * 2).apply { for (r in listed) add(r.mediaId) }
        for (f in cached.values) if (f.mediaId !in ids) gone(f, now, touched)
        for (r in listed) apply(r, cached[r.mediaId], now, touched)
      }
      store.setMeta("version:$v", version)
      store.setMeta("gen:$v", gen?.toString())
      store.setMeta("away:$v", null)
      refresh(touched)
    }
    return listed.size
  }

  private fun gone(f: FileRec, now: Long, touched: MutableSet<String>) {
    store.update(f.copy(goneAt = now, away = false))
    f.trackId?.let(touched::add)
    if (f.state == LocalStore.OK) touchedFolders.add(f.volume to f.relPath)
  }

  /** One listed row against [f], the cache's row of the same id (null: none, or every id is new). */
  private fun apply(r: Row, f: FileRec?, now: Long, touched: MutableSet<String>) {
    val excluded = LocalPolicy.excluded(r.relPath)
    if (f != null) {
      var next = f.copy(relPath = r.relPath, name = r.name, gen = r.generation, dataPath = r.dataPath, away = false)
      if (f.size != r.size || f.mtime != r.mtime) {
        // New bytes: read again; the old track id stays on the row as the new track's alias.
        next = next.copy(size = r.size, mtime = r.mtime, state = if (excluded) LocalStore.EXCLUDED else LocalStore.NEW)
        if (f.state == LocalStore.OK) touchedFolders.add(f.volume to f.relPath)
      } else if (f.relPath != r.relPath || f.name != r.name) {
        next = moved(f, next, excluded)
      }
      if (next != f) store.update(next)
      if (f.away || next.state != f.state || next.facts != f.facts || next.name != f.name) f.trackId?.let(touched::add)
      return
    }
    // A row the cache does not hold under that id: a file moved, or a rebuilt database, or new.
    val from = store.goneLike(r.volume, r.name, r.size, r.mtime)
      .sortedWith(compareByDescending<FileRec> { it.relPath == r.relPath }.thenByDescending { it.goneAt ?: 0 })
      .firstOrNull()
    if (from != null) {
      var next = from.copy(mediaId = r.mediaId, relPath = r.relPath, name = r.name, gen = r.generation, dataPath = r.dataPath, goneAt = null, away = false)
      if (from.relPath != r.relPath) next = moved(from, next, excluded)
      store.update(next)
      next.trackId?.let(touched::add)
      return
    }
    store.insert(
      FileRec(
        volume = r.volume, mediaId = r.mediaId, relPath = r.relPath, name = r.name, size = r.size, mtime = r.mtime, added = r.added,
        gen = r.generation, dataPath = r.dataPath, state = if (excluded) LocalStore.EXCLUDED else LocalStore.NEW,
      ),
    )
  }

  /** The same bytes at another path: what the folder decided goes with the old folder. */
  private fun moved(old: FileRec, next: FileRec, excluded: Boolean): FileRec {
    var n = next
    if (excluded && n.state != LocalStore.EXCLUDED) {
      n = n.copy(state = LocalStore.EXCLUDED)
    } else if (!excluded && n.state == LocalStore.EXCLUDED) {
      n = n.copy(state = if (n.facts != null && n.trackId != null) LocalStore.OK else LocalStore.NEW)
    }
    val facts = Facts.parse(n.facts)
    if (facts?.coverFrom == "folder") {
      facts.coverId?.let(artCandidates::add)
      n = n.copy(facts = facts.with("coverId", null).with("coverFrom", null).json(), coverId = null)
    }
    if (old.state == LocalStore.OK) touchedFolders.add(old.volume to old.relPath)
    if (n.state == LocalStore.OK) touchedFolders.add(n.volume to n.relPath)
    return n
  }

  /**
   * Once, for rows read before the length rule: a readable row whose stored length is too short
   * is skipped now and its track dropped, with no read; one whose length was never known is read
   * again, as the platform may have said 0 for it (stored as unknown then). Nothing else is read.
   */
  private fun dropShort() {
    if (store.meta(SHORT_RULE) != null) return
    store.tx {
      val touched = HashSet<String>()
      for (f in store.withState(LocalStore.OK)) {
        val seconds = Facts.parse(f.facts)?.duration
        if (LocalPolicy.tooShort(seconds)) {
          store.update(f.copy(state = LocalStore.SKIPPED))
          f.trackId?.let(touched::add)
          touchedFolders.add(f.volume to f.relPath)
        } else if (seconds == null) {
          // Its track stays while it waits: the read gives the same facts, or skips it.
          store.update(f.copy(state = LocalStore.NEW))
        }
      }
      store.setMeta(SHORT_RULE, "1")
      refresh(touched)
    }
  }

  private fun purge(now: Long) {
    store.tx {
      for (f in store.goneBefore(now - GONE_KEEP_MS)) {
        store.delete(f.key)
        f.coverId?.let(artCandidates::add)
      }
    }
    dropUnusedArt()
  }

  // ------------------------------------------------------------------ reading files

  /** Reads the newest file waiting; false when none waits (then the folders' pictures are decided). */
  fun probeNext(): Boolean {
    if (!granted) return false
    val f = store.nextNew(deferred)
    if (f == null) {
      if (runStart >= 0) {
        host.readingEnded(runFiles, runBytes, host.now() - runStart)
        host.log("read $runFiles files, $runBytes bytes in ${(host.now() - runStart) / 1000} s")
        runStart = -1
      }
      folderPass()
      dropUnusedArt()
      return false
    }
    if (runStart < 0) {
      runStart = host.now()
      runFiles = 0
      runBytes = 0
      host.readingStarted()
    }
    store.tx { store.update(f.copy(state = LocalStore.PROBING)) }
    val p = try {
      reader.probe(f.row())
    } catch (e: Exception) {
      Probe(Probe.Outcome.UNREADABLE, null)
    }
    runFiles++
    runBytes += f.size
    store.tx {
      val cur = store.fileByKey(f.key) ?: return@tx
      val touched = HashSet<String>()
      cur.trackId?.let(touched::add)
      when (p.outcome) {
        Probe.Outcome.OK -> {
          val facts = p.facts!!
          // The lyrics apart from the facts: the cache's rows stay small, read whole only for a track.
          val kept = facts.with("was", aliases(cur, facts)).without("lyrics")
          store.update(cur.copy(state = LocalStore.OK, trackId = facts.id, facts = kept.json(), coverId = facts.coverId, tries = 0))
          store.setLyrics(cur.key, facts.map["lyrics"]?.let { Json.write(it) })
          if (cur.coverId != null && cur.coverId != facts.coverId) artCandidates.add(cur.coverId)
          touched.add(facts.id)
          touchedFolders.add(cur.volume to cur.relPath)
        }
        Probe.Outcome.SKIPPED -> store.update(cur.copy(state = LocalStore.SKIPPED))
        Probe.Outcome.UNREADABLE -> store.update(cur.copy(state = LocalStore.UNREADABLE, tries = cur.tries + 1))
        Probe.Outcome.CHANGING -> {
          store.update(cur.copy(state = LocalStore.NEW))
          deferred.add(cur.key)
        }
      }
      refresh(touched)
    }
    return true
  }

  // The files whose loudness is still to measure, listed once per pass (measureNext).
  private var toMeasure: ArrayDeque<Long>? = null

  fun charging(): Boolean = host.charging()

  /**
   * The loudness of the next song whose tags say nothing of it (no ReplayGain or R128 track gain):
   * the whole file decoded and measured (FileReader.loudness), kept in its facts as "scan" (a file
   * that cannot be measured: "none", not tried again until it changes), the track fed again. False
   * when none is left. LocalWork runs it after the reads, while the phone charges.
   */
  fun measureNext(): Boolean {
    if (!granted) return false
    val q = toMeasure ?: ArrayDeque(store.withState(LocalStore.OK).filter { it.present && needsMeasure(it) }.map { it.key }).also { toMeasure = it }
    while (q.isNotEmpty()) {
      val cur = store.fileByKey(q.removeFirst()) ?: continue
      if (cur.state != LocalStore.OK || !cur.present || !needsMeasure(cur)) continue
      val r = try {
        reader.loudness(cur.row())
      } catch (e: Exception) {
        null
      }
      store.tx {
        val now = store.fileByKey(cur.key) ?: return@tx
        if (now.state != LocalStore.OK || now.facts != cur.facts) return@tx
        val facts = Facts.parse(now.facts) ?: return@tx
        val scan = if (r != null) linkedMapOf<String, Any?>("lufs" to round2(r.lufs), "peak" to r.peak?.let(::round2)) else linkedMapOf<String, Any?>("none" to true)
        store.update(now.copy(facts = facts.with("scan", scan).json()))
        now.trackId?.let { refresh(setOf(it)) }
      }
      return true
    }
    toMeasure = null
    return false
  }

  private fun round2(v: Double): Double = Math.round(v * 100) / 100.0

  private fun needsMeasure(f: FileRec): Boolean {
    val m = Facts.parse(f.facts)?.map ?: return false
    if (m.containsKey("scan")) return false
    val rg = (m["tags"] as? Map<*, *>)?.get("rg") as? Map<*, *>
    return rg?.get("trackGain") == null && rg?.get("r128Track") == null
  }

  /**
   * The ids a file had before its bytes changed: the row's own old id (a file rewritten in place),
   * or the id of another row at the same path (a retag written as a new file, its old row gone
   * within the day or not yet seen gone), when the length is within a second: a retag never changes
   * the audio. At most eight, the oldest dropped.
   */
  private fun aliases(cur: FileRec, facts: Facts): List<String> {
    val id = facts.id
    val prev = Facts.parse(cur.facts)
    if (cur.trackId == id) return prev?.was ?: emptyList()
    val now = host.now()
    var from: Pair<String, Facts?>? = null
    if (cur.trackId != null && near(prev?.duration, facts.duration)) {
      from = cur.trackId to prev
    } else {
      val other = store.samePath(cur.volume, cur.relPath, cur.name)
        .filter { it.key != cur.key && it.trackId != null && it.trackId != id && (it.goneAt == null || it.goneAt >= now - GONE_KEEP_MS) }
        .map { it to Facts.parse(it.facts) }
        .filter { near(it.second?.duration, facts.duration) }
        .maxByOrNull { it.first.goneAt ?: Long.MAX_VALUE }
      if (other != null) from = other.first.trackId!! to other.second
    }
    if (from == null) return emptyList()
    return (from.second?.was.orEmpty() + from.first).filter { it != id }.distinct().takeLast(MAX_WAS)
  }

  private fun near(a: Double?, b: Double?) = a != null && b != null && Math.abs(a - b) <= NEAR_S

  /**
   * Folder art, once a folder's files are read: only for an album folder (two or more songs of
   * ours, every one with an album tag, all the same album), only for its songs without a picture
   * of their own, one call per folder per check. Anywhere else a folder's largest picture could be
   * a personal photo.
   */
  private fun folderPass() {
    if (touchedFolders.isEmpty()) return
    val list = touchedFolders.toList()
    touchedFolders.clear()
    for ((v, rel) in list) {
      val rows = store.folder(v, rel).filter { it.present && it.state == LocalStore.OK }
      val facts = rows.associate { it.key to Facts.parse(it.facts) }
      val albums = rows.map { facts[it.key]?.album?.trim() }
      val album = albums.firstOrNull()
      val isAlbum = rows.size >= 2 && !album.isNullOrEmpty() && albums.all { it == album }
      val bare = rows.filter { facts[it.key] != null && facts[it.key]?.coverFrom != "file" }
      if (bare.isEmpty()) continue
      val id = if (isAlbum) folders.cover(bare.first()) else null
      store.tx {
        val touched = HashSet<String>()
        for (r in bare) {
          val f = facts[r.key] ?: continue
          if (f.coverId == id) continue
          f.coverId?.let(artCandidates::add)
          val nf = if (id == null) f.with("coverId", null).with("coverFrom", null) else f.with("coverId", id).with("coverFrom", "folder")
          store.update(r.copy(facts = nf.json(), coverId = id))
          r.trackId?.let(touched::add)
        }
        refresh(touched)
      }
    }
  }

  private fun dropUnusedArt() {
    if (artCandidates.isEmpty()) return
    val list = artCandidates.toList()
    artCandidates.clear()
    for (id in list) if (!store.coverUsed(id)) host.dropArt(id)
  }

  // ------------------------------------------------------------------ tracks

  /** Brings each track in line with its files: present with the facts of its earliest-added readable file, or absent. */
  private fun refresh(ids: Collection<String>) {
    for (id in ids) {
      val files = store.filesOfTrack(id).filter { it.state == LocalStore.OK && it.present }
      val t = store.track(id)
      if (files.isEmpty()) {
        if (t == null || !t.present) continue
        if (!t.fed && t.batch == null && t.sentHash == null) {
          // Never sent since the last reset: nothing for the core to drop.
          store.deleteTrack(id)
          t.coverId?.let(artCandidates::add)
        } else {
          store.putTrack(t.copy(present = false, fed = false, batch = null))
        }
        continue
      }
      val first = files.minWithOrNull(compareBy<FileRec>({ it.added }, { it.key }))!!
      val facts = Facts.parse(first.facts) ?: continue
      val json = trackJson(first, facts, store.lyrics(first.key))
      val hash = sha16(json)
      if (t == null) {
        store.putTrack(TrackRec(id, json, hash, facts.coverId, first.added, present = true, fed = false, sentHash = null, batch = null))
      } else if (!t.present || t.factsHash != hash) {
        if (t.coverId != null && t.coverId != facts.coverId) artCandidates.add(t.coverId)
        store.putTrack(t.copy(facts = json, factsHash = hash, coverId = facts.coverId, added = first.added, present = true, fed = false, batch = null))
      }
    }
  }

  /** The facts the core gets for a track (F): the file's own fields, then what reading it found. */
  private fun trackJson(f: FileRec, facts: Facts, lyrics: String?): String {
    val m = facts.map
    val out: LinkedHashMap<String, Any?> =
      linkedMapOf(
        "id" to facts.id, "name" to f.name, "size" to f.size, "mtime" to f.mtime, "addedAt" to f.added,
        "tags" to m["tags"], "format" to m["format"], "codec" to m["codec"], "duration" to m["duration"], "bitrate" to m["bitrate"],
        "sampleRate" to m["sampleRate"], "bitDepth" to m["bitDepth"], "coverId" to m["coverId"], "lyrics" to lyrics?.let { Json.parse(it) }, "was" to facts.was,
      )
    // The measured loudness, only once there is one: the facts of every other song stay as they were.
    m["scan"]?.let { out["scan"] = it }
    return Json.write(out)
  }

  private fun sha16(s: String): String = CoverArt.hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))).substring(0, 16)

  /** The earliest-added readable file of a track on a mounted volume. */
  fun fileOf(trackId: String): FileRec? =
    store.filesOfTrack(trackId).filter { it.state == LocalStore.OK && it.present }.minWithOrNull(compareBy<FileRec>({ it.added }, { it.key }))

  // ------------------------------------------------------------------ the feed

  /** The core said where its feed is (once per worklet). */
  fun hello(token: String?, batch: Long) {
    connected = true
    inFlight.clear()
    lastProgress = -1
    lastAccess = null
    val mine = store.meta("feed_token")
    if (mine == null || token != mine) {
      val t = host.newToken()
      store.tx {
        store.unsendAll()
        store.setMeta("feed_token", t)
        store.setMeta("reset_open", "1")
        store.setMeta("end_batch", null)
      }
      sendAccess()
      sendProgress()
      host.send(Json.write(linkedMapOf("t" to "local", "op" to "reset", "token" to t)))
    } else {
      store.tx {
        applyAck(batch)
        store.unsendAfter(batch)
        val end = store.meta("end_batch")?.toLongOrNull()
        if (end != null && end > batch) store.setMeta("end_batch", null)
      }
      dropUnusedArt()
      sendAccess()
      sendProgress()
    }
  }

  /** The core applied every batch up to [batch] and synced it. */
  fun ack(token: String?, batch: Long) {
    if (token == null || token != store.meta("feed_token")) return
    store.tx { applyAck(batch) }
    inFlight.removeAll { it <= batch }
    dropUnusedArt()
  }

  private fun applyAck(n: Long) {
    for (t in store.inFlightUpTo(n)) {
      when {
        t.present && t.sentHash == t.factsHash -> store.putTrack(t.copy(fed = true))
        !t.present && t.sentHash == DROP -> {
          store.deleteTrack(t.trackId)
          t.coverId?.let(artCandidates::add)
        }
        else -> store.putTrack(t.copy(batch = null))
      }
    }
    val end = store.meta("end_batch")?.toLongOrNull()
    if (end != null && end <= n) {
      store.setMeta("reset_open", "0")
      store.setMeta("end_batch", null)
    }
  }

  /** The worklet went: nothing is sent until the next one says hello. */
  fun disconnect() {
    connected = false
    inFlight.clear()
  }

  val isConnected: Boolean get() = connected

  /** Sends what is due while fewer than [WINDOW] batches wait for their ack; the number of batches sent. */
  fun flush(): Int {
    if (!connected) return 0
    val token = store.meta("feed_token") ?: return 0
    var sent = 0
    while (inFlight.size < WINDOW) {
      val drops = store.unsent(false, MAX_TRACKS)
      if (drops.isNotEmpty()) {
        val n = nextBatch()
        store.tx { for (t in drops) store.putTrack(t.copy(batch = n, sentHash = DROP)) }
        send(Json.write(linkedMapOf("t" to "local", "op" to "drop", "token" to token, "batch" to n, "ids" to drops.map { it.trackId })), n)
        sent++
        continue
      }
      val puts = store.unsent(true, MAX_TRACKS)
      if (puts.isNotEmpty()) {
        val n = nextBatch()
        val head = "{\"t\":\"local\",\"op\":\"put\",\"token\":${Json.write(token)},\"batch\":$n,\"tracks\":["
        var bytes = TagReader.utf8Length(head) + 2
        val take = ArrayList<TrackRec>()
        for (t in puts) {
          val b = TagReader.utf8Length(t.facts) + if (take.isEmpty()) 0 else 1
          // A put holds at most 256 KB; a track larger than that alone goes in one of its own.
          if (take.isNotEmpty() && bytes + b > MAX_PUT_BYTES) break
          take.add(t)
          bytes += b
        }
        store.tx { for (t in take) store.putTrack(t.copy(batch = n, sentHash = t.factsHash)) }
        send(head + take.joinToString(",") { it.facts } + "]}", n)
        sent++
        continue
      }
      if (store.meta("reset_open") == "1" && store.meta("end_batch") == null) {
        val n = nextBatch()
        store.setMeta("end_batch", n.toString())
        send(Json.write(linkedMapOf("t" to "local", "op" to "end", "token" to token, "batch" to n)), n)
        sent++
        continue
      }
      break
    }
    sendProgress()
    return sent
  }

  private fun nextBatch(): Long {
    val n = store.meta("next_batch")?.toLongOrNull() ?: 1L
    store.setMeta("next_batch", (n + 1).toString())
    return n
  }

  private fun send(line: String, batch: Long) {
    inFlight.add(batch)
    host.send(line)
  }

  /** Tracks to send now (neither fed nor in flight). */
  fun unsent(): Int = store.countUnsent()

  /** Files still to read and tracks still to feed. */
  fun pending(): Int = store.countToRead() + store.countUnfed()

  private fun sendProgress() {
    if (!connected) return
    val p = pending()
    if (p == lastProgress) return
    lastProgress = p
    host.send(Json.write(linkedMapOf("t" to "local", "op" to "progress", "pending" to p)))
  }

  private fun sendAccess() {
    if (!connected || lastAccess == granted) return
    lastAccess = granted
    host.send(Json.write(linkedMapOf("t" to "local", "op" to "access", "granted" to granted)))
  }
}

/**
 * When the index works: only while the process lives, the worklet is awake (the app in front or
 * music playing, Keeper) and something is marked. A change notification marks it and the check
 * runs 2 s after the last one, at most 10 s after the first; a suspended worklet pauses the reads
 * after the file they are on and checks at the resume only what was marked. Nothing runs on a
 * timer at rest.
 */
class LocalWork(private val index: LocalIndex, private val sched: Scheduler) {
  fun interface Cancel {
    fun cancel()
  }

  interface Scheduler {
    /** A clock for the waits (never the wall clock's jumps). */
    fun now(): Long

    fun post(task: Runnable)

    fun later(ms: Long, task: Runnable): Cancel
  }

  companion object {
    const val QUIET_MS = 2_000L
    const val MAX_WAIT_MS = 10_000L
    const val FEED_MS = 2_000L
    const val KEEP_INDEX_MS = 30L * 24 * 3600 * 1000
    // Not charging: the loudness measure looks again after this.
    const val MEASURE_WAIT_MS = 10L * 60 * 1000

    /** The index of a phone whose permission has been off since [offSince] is kept for 30 days, then deleted. */
    fun keepIndex(offSince: Long?, now: Long): Boolean = offSince == null || now - offSince < KEEP_INDEX_MS
  }

  private var granted = false
  private var awake = true
  private var dirty = false
  private var firstDirty = 0L
  private var checkTask: Cancel? = null
  private var probing = false
  // The reads stopped at a suspension with files still waiting.
  private var paused = false
  private var feedTask: Cancel? = null
  private var measuring = false
  private var measureTask: Cancel? = null

  fun start(granted: Boolean) {
    this.granted = granted
    index.open(granted)
    if (granted) {
      dirty = true
      sched.post { runCheck() }
    }
  }

  fun onAccess(granted: Boolean) {
    if (!index.setAccess(granted)) return
    this.granted = granted
    if (granted) {
      dirty = true
      sched.post { runCheck() }
    } else {
      checkTask?.cancel()
      checkTask = null
      dirty = false
    }
    flush()
  }

  fun onMediaChange() {
    if (!granted) return
    val now = sched.now()
    if (!dirty) {
      dirty = true
      firstDirty = now
    }
    if (!awake) return
    checkTask?.cancel()
    val wait = minOf(QUIET_MS, firstDirty + MAX_WAIT_MS - now).coerceAtLeast(0)
    checkTask = sched.later(wait) {
      checkTask = null
      runCheck()
    }
  }

  fun onAwake(awake: Boolean) {
    if (this.awake == awake) return
    this.awake = awake
    if (!awake) {
      checkTask?.cancel()
      checkTask = null
      return
    }
    if (granted && dirty) {
      sched.post { runCheck() }
    } else if (paused) {
      paused = false
      probeSoon()
    }
    flush()
    measureSoon()
  }

  fun onHello(token: String?, batch: Long) {
    index.hello(token, batch)
    flush()
  }

  fun onAck(token: String?, batch: Long) {
    index.ack(token, batch)
    flush()
  }

  fun onWorkletGone() {
    index.disconnect()
  }

  private fun runCheck() {
    if (!granted || !awake || !dirty) return
    dirty = false
    paused = false
    checkTask?.cancel()
    checkTask = null
    try {
      index.check()
    } catch (e: Exception) {
      // Tried again at the next change or resume, never in a loop.
      dirty = true
      throw e
    }
    probeSoon()
    flush()
  }

  private fun probeSoon() {
    if (probing) return
    probing = true
    sched.post { probeStep() }
  }

  private fun probeStep() {
    probing = false
    if (!granted) return
    if (!awake) {
      paused = true
      return
    }
    if (index.probeNext()) {
      // A batch as soon as 200 tracks wait, else within two seconds: the first songs show at once.
      if (index.unsent() >= LocalIndex.MAX_TRACKS) flush() else feedSoon()
      probeSoon()
    } else {
      flush()
      measureSoon()
    }
  }

  // The loudness measure, one song a step, after the reads and only while the phone charges.
  private fun measureSoon() {
    if (measuring || measureTask != null) return
    measuring = true
    sched.post { measureStep() }
  }

  private fun measureStep() {
    measuring = false
    if (!granted || !awake || probing) return
    if (!index.charging()) {
      measureTask = sched.later(MEASURE_WAIT_MS) {
        measureTask = null
        measureSoon()
      }
      return
    }
    if (index.measureNext()) {
      feedSoon()
      measureSoon()
    }
  }

  private fun feedSoon() {
    if (feedTask != null) return
    feedTask = sched.later(FEED_MS) {
      feedTask = null
      flush()
    }
  }

  private fun flush() {
    feedTask?.cancel()
    feedTask = null
    index.flush()
  }
}

/**
 * The phone's music on Android: the permission, MediaStore's change notifications, the volumes
 * that come and go, one background thread for the index, and the feed over CoreHost's IPC. Logs
 * counts and times only (tag MPfyLocal), never a name or a path.
 */
object LocalMusic {
  private const val TAG = "MPfyLocal"

  private val exec = ScheduledThreadPoolExecutor(1) { r ->
    Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
      r.run()
    }, "MPfyLocal").apply { isDaemon = true }
  }
  private val main = Handler(Looper.getMainLooper())
  private lateinit var app: Context

  @Volatile
  private var store: SqlLocalStore? = null
  private var work: LocalWork? = null
  private var art: ArtStore? = null
  private var granted = false
  private var watching = false
  // The core's last hello on this worklet: replayed to an index made after it (a grant later on).
  private var worklet = -1L
  private var hello: Pair<String?, Long>? = null
  private var chargeAtStart: Int? = null

  /** Where the index keeps its covers (read only for the core). */
  fun artDir(ctx: Context): File = File(ctx.filesDir, "local/art")

  private fun dir() = File(app.filesDir, "local")

  fun init(context: Context) {
    if (::app.isInitialized) return
    app = context.applicationContext
    exec.execute { guarded { boot() } }
    // Back from the system settings, where "Musica e audio" may have been turned on.
    Keeper.addForegroundListener { if (Keeper.inForeground) refreshAccess() }
  }

  private fun permitted(): Boolean {
    val p = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    return ContextCompat.checkSelfPermission(app, p) == PackageManager.PERMISSION_GRANTED
  }

  private fun boot() {
    granted = permitted()
    val db = File(dir(), "index.db")
    if (!granted && !db.exists()) {
      Log.i(TAG, "no permission and no index")
      return
    }
    val s = SqlLocalStore(db)
    if (!granted) {
      val now = System.currentTimeMillis()
      val off = s.meta("off_since")?.toLongOrNull()
      if (off == null) {
        s.setMeta("off_since", now.toString())
      } else if (!LocalWork.keepIndex(off, now)) {
        // Thirty days without the permission: what the index knew of the person's music goes.
        s.close()
        dir().deleteRecursively()
        Log.i(TAG, "index deleted after 30 days without the permission")
        return
      }
    } else {
      s.setMeta("off_since", null)
    }
    start(s)
  }

  private fun start(s: SqlLocalStore) {
    store = s
    val a = ArtStore(artDir(app))
    art = a
    val ix = LocalIndex(s, StoreRows(app), FileProbe(LocalProbe(app), a), FolderCovers(app, a), host)
    val w = LocalWork(ix, scheduler)
    work = w
    w.start(granted)
    if (granted) watch()
    hello?.let { (t, b) -> w.onHello(t, b) }
  }

  /** The permission may have changed (the dialog answered, back from the settings). Any thread. */
  fun refreshAccess() {
    exec.execute {
      guarded {
        if (!::app.isInitialized) return@guarded
        val g = permitted()
        if (g == granted) return@guarded
        granted = g
        Log.i(TAG, "permission ${if (g) "granted" else "off"}")
        val w = work
        if (w == null) {
          if (g) start(SqlLocalStore(File(dir(), "index.db")).also { it.setMeta("off_since", null) })
          return@guarded
        }
        store?.setMeta("off_since", if (g) null else System.currentTimeMillis().toString())
        w.onAccess(g)
        if (g) watch() else unwatch()
      }
    }
  }

  private val observer = object : ContentObserver(main) {
    override fun onChange(selfChange: Boolean) {
      exec.execute { guarded { work?.onMediaChange() } }
    }
  }

  // A volume that comes or goes changes no audio row: told here, while the process lives.
  private val volumes = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      exec.execute { guarded { work?.onMediaChange() } }
    }
  }

  private fun watch() {
    if (watching) return
    watching = true
    main.post {
      app.contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer)
      val filter = IntentFilter().apply {
        for (a in listOf(Intent.ACTION_MEDIA_MOUNTED, Intent.ACTION_MEDIA_UNMOUNTED, Intent.ACTION_MEDIA_EJECT, Intent.ACTION_MEDIA_REMOVED, Intent.ACTION_MEDIA_BAD_REMOVAL)) addAction(a)
        addDataScheme("file")
      }
      ContextCompat.registerReceiver(app, volumes, filter, ContextCompat.RECEIVER_EXPORTED)
    }
  }

  private fun unwatch() {
    if (!watching) return
    watching = false
    main.post {
      runCatching { app.contentResolver.unregisterContentObserver(observer) }
      runCatching { app.unregisterReceiver(volumes) }
    }
  }

  // ------------------------------------------------------------------ the worklet (CoreHost)

  /** The worklet was suspended or resumed (or a new one started awake). */
  fun onAwake(awake: Boolean) {
    exec.execute { guarded { work?.onAwake(awake) } }
  }

  /** The worklet [number] says where the core's feed is. */
  fun onHello(number: Long, token: String?, batch: Long) {
    exec.execute {
      guarded {
        worklet = number
        hello = token to batch
        val w = work
        if (w != null) {
          w.onHello(token, batch)
        } else {
          // No index (never granted): the core learns the permission is off, and that nothing waits.
          CoreHost.sendTo(number, Json.write(linkedMapOf("t" to "local", "op" to "access", "granted" to false)))
          CoreHost.sendTo(number, Json.write(linkedMapOf("t" to "local", "op" to "progress", "pending" to 0)))
        }
      }
    }
  }

  fun onAck(token: String?, batch: Long) {
    exec.execute { guarded { work?.onAck(token, batch) } }
  }

  fun onWorkletGone() {
    exec.execute {
      guarded {
        worklet = -1
        hello = null
        work?.onWorkletGone()
      }
    }
  }

  /** The content URI of a track's file (the earliest-added readable one on a mounted volume), or null. Any thread. */
  fun uriOf(trackId: String): Uri? {
    val f = store?.playable(trackId) ?: return null
    return ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(f.volume), f.mediaId)
  }

  private val host = object : LocalIndex.Host {
    private val random = SecureRandom()

    override fun now(): Long = System.currentTimeMillis()

    override fun send(line: String): Boolean = CoreHost.sendTo(worklet, line)

    override fun newToken(): String = CoverArt.hex(ByteArray(16).also { random.nextBytes(it) })

    override fun dropArt(coverId: String) {
      art?.delete(coverId)
    }

    override fun log(line: String) {
      Log.i(TAG, line)
    }

    override fun readingStarted() {
      chargeAtStart = charge()
    }

    override fun charging(): Boolean = app.getSystemService(BatteryManager::class.java)?.isCharging == true

    override fun readingEnded(files: Int, bytes: Long, ms: Long) {
      val before = chargeAtStart
      val after = charge()
      if (before != null && after != null) Log.i(TAG, "battery charge counter $before -> $after uAh while reading $files files")
    }
  }

  private fun charge(): Int? =
    app.getSystemService(BatteryManager::class.java)?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)?.takeIf { it > 0 && it != Int.MIN_VALUE }

  private val scheduler = object : LocalWork.Scheduler {
    override fun now(): Long = SystemClock.elapsedRealtime()

    override fun post(task: Runnable) {
      exec.execute { guarded { task.run() } }
    }

    override fun later(ms: Long, task: Runnable): LocalWork.Cancel {
      val f = exec.schedule({ guarded { task.run() } }, ms, TimeUnit.MILLISECONDS)
      return LocalWork.Cancel { f.cancel(false) }
    }
  }

  private inline fun guarded(block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      Log.w(TAG, "index: ${e.javaClass.simpleName}")
    }
  }
}

/**
 * A folder's picture for an album folder's songs without one. Android 10 to 12: the source's names
 * (cover, folder, front; .jpg, .png, .webp) read by path, the id from the picture's own bytes.
 * Android 13 and later (no photo permission asked): MediaProvider's album art for an audio file of
 * the folder, the folder's largest JPEG or PNG; its id is the hash of the JPEG made from it.
 */
class FolderCovers(context: Context, private val art: ArtStore) : FolderArt {
  private val ctx = context.applicationContext
  private val names = setOf("cover", "folder", "front")
  private val exts = setOf("jpg", "png", "webp")

  override fun cover(file: FileRec): String? = try {
    if (Build.VERSION.SDK_INT >= 33) thumbnail(file) else byName(file)
  } catch (e: Exception) {
    null
  }

  private fun thumbnail(file: FileRec): String? {
    val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(file.volume), file.mediaId)
    val bmp = ctx.contentResolver.loadThumbnail(uri, Size(CoverArt.LARGE, CoverArt.LARGE), null)
    return try {
      art.putBitmap(bmp)
    } finally {
      bmp.recycle()
    }
  }

  private fun byName(file: FileRec): String? {
    val dir = folderOf(file) ?: return null
    val pick = dir.listFiles()?.filter { f ->
      f.isFile && f.name.substringBeforeLast('.', "").lowercase() in names && f.name.substringAfterLast('.', "").lowercase() in exts
    }?.minByOrNull { it.name.lowercase() } ?: return null
    if (pick.length() <= 0 || pick.length() > CoverArt.MAX_COVER_BYTES) return null
    val bytes = pick.readBytes()
    val id = CoverArt.coverId(bytes) ?: return null
    if (art.has(id)) return id
    return if (art.put(id, bytes)) id else null
  }

  private fun folderOf(file: FileRec): File? {
    file.dataPath?.let { return File(it).parentFile }
    val root = if (file.volume == MediaStore.VOLUME_EXTERNAL_PRIMARY) {
      @Suppress("DEPRECATION")
      Environment.getExternalStorageDirectory()
    } else if (Build.VERSION.SDK_INT >= 30) {
      ctx.getSystemService(StorageManager::class.java).storageVolumes.firstOrNull { it.mediaStoreVolumeName == file.volume }?.directory
    } else {
      null
    }
    return root?.let { File(it, file.relPath) }
  }
}
