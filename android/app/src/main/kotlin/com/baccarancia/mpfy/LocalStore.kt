package com.baccarancia.mpfy

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.File

/**
 * One MediaStore row in the cache. [state]: new (to read), probing (being read: a row left so by
 * a dead process is unreadable at the next start), ok, skipped (not audio, or too short),
 * unreadable, excluded (its folder is not music). [goneAt]: the row left MediaStore at that time
 * (kept a day, for a retag written as a new file). [away]: its volume is not mounted, or the
 * permission is off. [facts]: what reading the file found (JSON), kept through every state; its
 * lyrics live apart ([LocalStore.lyrics]), read only when the track is built.
 */
data class FileRec(
  val key: Long = 0,
  val volume: String,
  val mediaId: Long,
  val relPath: String,
  val name: String,
  val size: Long,
  val mtime: Long,
  val added: Long,
  val gen: Long?,
  val dataPath: String?,
  val state: String,
  val goneAt: Long? = null,
  val away: Boolean = false,
  val trackId: String? = null,
  val facts: String? = null,
  val coverId: String? = null,
  val tries: Int = 0,
) {
  val present: Boolean get() = goneAt == null && !away

  fun row() = Row(volume, mediaId, relPath, name, size, mtime, added, gen, dataPath)
}

/**
 * One track of Locale: the facts the core gets for it (JSON, `was` included), their hash, and
 * where the feed is: [fed] once the core acked them; [batch] and [sentHash] while a batch is in
 * flight (`-` for a drop). An absent track waits for its drop to be acked, then goes.
 */
data class TrackRec(
  val trackId: String,
  val facts: String,
  val factsHash: String,
  val coverId: String?,
  val added: Long,
  val present: Boolean,
  val fed: Boolean,
  val sentHash: String?,
  val batch: Long?,
)

/** The index's cache. Used from one thread; every change made inside [tx] lands whole or not at all. */
interface LocalStore : AutoCloseable {
  companion object {
    const val NEW = "new"
    const val PROBING = "probing"
    const val OK = "ok"
    const val SKIPPED = "skipped"
    const val UNREADABLE = "unreadable"
    const val EXCLUDED = "excluded"
  }

  fun <T> tx(block: () -> T): T

  fun meta(key: String): String?

  fun setMeta(key: String, value: String?)

  /** The row of that MediaStore id now (not gone). */
  fun file(volume: String, mediaId: Long): FileRec?

  fun fileByKey(key: Long): FileRec?

  /** Every row of a volume, gone ones too. */
  fun filesOf(volume: String): List<FileRec>

  /** The volumes with rows MediaStore listed last (not gone, not away). */
  fun volumes(): Set<String>

  /** Rows of the volume that MediaStore listed last (not gone, not away). */
  fun presentCount(volume: String): Int

  /** Gone rows of that name, size and time: a file moved or a database rebuilt. */
  fun goneLike(volume: String, name: String, size: Long, mtime: Long): List<FileRec>

  /** Every row at that path, gone ones too. */
  fun samePath(volume: String, relPath: String, name: String): List<FileRec>

  /** The rows of a folder (not gone). */
  fun folder(volume: String, relPath: String): List<FileRec>

  fun filesOfTrack(trackId: String): List<FileRec>

  /** The newest row to read, leaving out [skip]. */
  fun nextNew(skip: Set<Long>): FileRec?

  fun withState(state: String): List<FileRec>

  fun goneBefore(time: Long): List<FileRec>

  /** Rows to read or being read, on mounted volumes. */
  fun countToRead(): Int

  fun insert(f: FileRec): Long

  /** Writes every field of [f] but its lyrics. */
  fun update(f: FileRec)

  /** The lyrics reading the file found (JSON), or null. */
  fun lyrics(key: Long): String?

  fun setLyrics(key: Long, json: String?)

  fun delete(key: Long)

  fun track(trackId: String): TrackRec?

  fun putTrack(t: TrackRec)

  fun deleteTrack(trackId: String)

  /** Tracks to send (not fed, not in flight), present or absent, newest first. */
  fun unsent(present: Boolean, limit: Int): List<TrackRec>

  /** Tracks in flight in a batch up to [batch]. */
  fun inFlightUpTo(batch: Long): List<TrackRec>

  /** Tracks in flight in a batch after [batch] are to send again. */
  fun unsendAfter(batch: Long)

  /** Every track is to send again (a full resend). */
  fun unsendAll()

  fun countUnfed(): Int

  /** Tracks to send now (neither fed nor in flight). */
  fun countUnsent(): Int

  /** A file or a track names this cover. */
  fun coverUsed(coverId: String): Boolean
}

/** The cache in `filesDir/local/index.db` (SQLite, WAL: a commit appends, nothing is rewritten whole). */
class SqlLocalStore(file: File) : LocalStore {
  private val db: SQLiteDatabase

  init {
    file.parentFile?.mkdirs()
    db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING)
    if (db.version < 1) {
      db.beginTransaction()
      try {
        db.execSQL(
          "CREATE TABLE files (key INTEGER PRIMARY KEY AUTOINCREMENT, volume TEXT NOT NULL, media_id INTEGER NOT NULL, rel_path TEXT NOT NULL, " +
            "name TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, added INTEGER NOT NULL, gen INTEGER, data_path TEXT, " +
            "state TEXT NOT NULL, gone_at INTEGER, away INTEGER NOT NULL DEFAULT 0, track_id TEXT, facts TEXT, cover_id TEXT, tries INTEGER NOT NULL DEFAULT 0, lyrics TEXT)",
        )
        // One row per MediaStore id while it is listed; gone rows may share an id with a new one.
        db.execSQL("CREATE UNIQUE INDEX files_media ON files (volume, media_id) WHERE gone_at IS NULL")
        db.execSQL("CREATE INDEX files_track ON files (track_id)")
        db.execSQL("CREATE INDEX files_stamp ON files (name, size, mtime)")
        db.execSQL("CREATE INDEX files_path ON files (volume, rel_path, name)")
        db.execSQL("CREATE INDEX files_state ON files (state, added)")
        db.execSQL("CREATE INDEX files_gone ON files (gone_at)")
        db.execSQL("CREATE INDEX files_cover ON files (cover_id)")
        db.execSQL(
          "CREATE TABLE tracks (track_id TEXT PRIMARY KEY, facts TEXT NOT NULL, facts_hash TEXT NOT NULL, cover_id TEXT, added INTEGER NOT NULL, " +
            "present INTEGER NOT NULL, fed INTEGER NOT NULL, sent_hash TEXT, batch INTEGER)",
        )
        db.execSQL("CREATE INDEX tracks_fed ON tracks (fed, batch)")
        db.execSQL("CREATE INDEX tracks_cover ON tracks (cover_id)")
        db.execSQL("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.version = 1
        db.setTransactionSuccessful()
      } finally {
        db.endTransaction()
      }
    }
  }

  override fun <T> tx(block: () -> T): T {
    db.beginTransactionNonExclusive()
    try {
      val r = block()
      db.setTransactionSuccessful()
      return r
    } finally {
      db.endTransaction()
    }
  }

  override fun meta(key: String): String? = db.rawQuery("SELECT value FROM meta WHERE key = ?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }

  override fun setMeta(key: String, value: String?) {
    if (value == null) {
      db.delete("meta", "key = ?", arrayOf(key))
    } else {
      db.insertWithOnConflict("meta", null, ContentValues().apply {
        put("key", key)
        put("value", value)
      }, SQLiteDatabase.CONFLICT_REPLACE)
    }
  }

  private val fileCols = "key, volume, media_id, rel_path, name, size, mtime, added, gen, data_path, state, gone_at, away, track_id, facts, cover_id, tries"

  private fun Cursor.file() = FileRec(
    key = getLong(0),
    volume = getString(1),
    mediaId = getLong(2),
    relPath = getString(3),
    name = getString(4),
    size = getLong(5),
    mtime = getLong(6),
    added = getLong(7),
    gen = if (isNull(8)) null else getLong(8),
    dataPath = if (isNull(9)) null else getString(9),
    state = getString(10),
    goneAt = if (isNull(11)) null else getLong(11),
    away = getInt(12) != 0,
    trackId = if (isNull(13)) null else getString(13),
    facts = if (isNull(14)) null else getString(14),
    coverId = if (isNull(15)) null else getString(15),
    tries = getInt(16),
  )

  private fun files(where: String, vararg args: String): List<FileRec> =
    db.rawQuery("SELECT $fileCols FROM files WHERE $where", args).use { c ->
      val out = ArrayList<FileRec>(c.count)
      while (c.moveToNext()) out.add(c.file())
      out
    }

  private fun count(sql: String, vararg args: String): Int = db.rawQuery(sql, args).use { if (it.moveToFirst()) it.getInt(0) else 0 }

  override fun file(volume: String, mediaId: Long): FileRec? = files("volume = ? AND media_id = ? AND gone_at IS NULL", volume, mediaId.toString()).firstOrNull()

  override fun fileByKey(key: Long): FileRec? = files("key = ?", key.toString()).firstOrNull()

  override fun filesOf(volume: String): List<FileRec> = files("volume = ?", volume)

  override fun volumes(): Set<String> = db.rawQuery("SELECT DISTINCT volume FROM files WHERE gone_at IS NULL AND away = 0", null).use { c ->
    val out = HashSet<String>()
    while (c.moveToNext()) out.add(c.getString(0))
    out
  }

  override fun presentCount(volume: String): Int = count("SELECT COUNT(*) FROM files WHERE volume = ? AND gone_at IS NULL AND away = 0", volume)

  override fun goneLike(volume: String, name: String, size: Long, mtime: Long): List<FileRec> =
    files("name = ? AND size = ? AND mtime = ? AND volume = ? AND gone_at IS NOT NULL", name, size.toString(), mtime.toString(), volume)

  override fun samePath(volume: String, relPath: String, name: String): List<FileRec> = files("volume = ? AND rel_path = ? AND name = ?", volume, relPath, name)

  override fun folder(volume: String, relPath: String): List<FileRec> = files("volume = ? AND rel_path = ? AND gone_at IS NULL", volume, relPath)

  override fun filesOfTrack(trackId: String): List<FileRec> = files("track_id = ?", trackId)

  override fun nextNew(skip: Set<Long>): FileRec? {
    val out = files("state = '${LocalStore.NEW}' AND gone_at IS NULL AND away = 0 ORDER BY added DESC, key ASC LIMIT ${skip.size + 1}")
    return out.firstOrNull { it.key !in skip }
  }

  override fun withState(state: String): List<FileRec> = files("state = ?", state)

  override fun goneBefore(time: Long): List<FileRec> = files("gone_at IS NOT NULL AND gone_at < ?", time.toString())

  override fun countToRead(): Int =
    count("SELECT COUNT(*) FROM files WHERE state IN ('${LocalStore.NEW}', '${LocalStore.PROBING}') AND gone_at IS NULL AND away = 0")

  private fun values(f: FileRec) = ContentValues().apply {
    put("volume", f.volume)
    put("media_id", f.mediaId)
    put("rel_path", f.relPath)
    put("name", f.name)
    put("size", f.size)
    put("mtime", f.mtime)
    put("added", f.added)
    put("gen", f.gen)
    put("data_path", f.dataPath)
    put("state", f.state)
    put("gone_at", f.goneAt)
    put("away", if (f.away) 1 else 0)
    put("track_id", f.trackId)
    put("facts", f.facts)
    put("cover_id", f.coverId)
    put("tries", f.tries)
  }

  override fun insert(f: FileRec): Long = db.insertOrThrow("files", null, values(f))

  override fun update(f: FileRec) {
    db.update("files", values(f), "key = ?", arrayOf(f.key.toString()))
  }

  override fun delete(key: Long) {
    db.delete("files", "key = ?", arrayOf(key.toString()))
  }

  override fun lyrics(key: Long): String? = db.rawQuery("SELECT lyrics FROM files WHERE key = ?", arrayOf(key.toString())).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }

  override fun setLyrics(key: Long, json: String?) {
    db.update("files", ContentValues().apply { put("lyrics", json) }, "key = ?", arrayOf(key.toString()))
  }

  private val trackCols = "track_id, facts, facts_hash, cover_id, added, present, fed, sent_hash, batch"

  private fun Cursor.track() = TrackRec(
    trackId = getString(0),
    facts = getString(1),
    factsHash = getString(2),
    coverId = if (isNull(3)) null else getString(3),
    added = getLong(4),
    present = getInt(5) != 0,
    fed = getInt(6) != 0,
    sentHash = if (isNull(7)) null else getString(7),
    batch = if (isNull(8)) null else getLong(8),
  )

  private fun tracks(where: String, vararg args: String): List<TrackRec> =
    db.rawQuery("SELECT $trackCols FROM tracks WHERE $where", args).use { c ->
      val out = ArrayList<TrackRec>(c.count)
      while (c.moveToNext()) out.add(c.track())
      out
    }

  override fun track(trackId: String): TrackRec? = tracks("track_id = ?", trackId).firstOrNull()

  override fun putTrack(t: TrackRec) {
    db.insertWithOnConflict("tracks", null, ContentValues().apply {
      put("track_id", t.trackId)
      put("facts", t.facts)
      put("facts_hash", t.factsHash)
      put("cover_id", t.coverId)
      put("added", t.added)
      put("present", if (t.present) 1 else 0)
      put("fed", if (t.fed) 1 else 0)
      put("sent_hash", t.sentHash)
      put("batch", t.batch)
    }, SQLiteDatabase.CONFLICT_REPLACE)
  }

  override fun deleteTrack(trackId: String) {
    db.delete("tracks", "track_id = ?", arrayOf(trackId))
  }

  override fun unsent(present: Boolean, limit: Int): List<TrackRec> =
    tracks("fed = 0 AND batch IS NULL AND present = ? ORDER BY added DESC, track_id ASC LIMIT $limit", if (present) "1" else "0")

  override fun inFlightUpTo(batch: Long): List<TrackRec> = tracks("fed = 0 AND batch IS NOT NULL AND batch <= ?", batch.toString())

  override fun unsendAfter(batch: Long) {
    db.execSQL("UPDATE tracks SET batch = NULL WHERE fed = 0 AND batch > ?", arrayOf(batch))
  }

  override fun unsendAll() {
    db.execSQL("UPDATE tracks SET fed = 0, batch = NULL, sent_hash = NULL")
  }

  override fun countUnfed(): Int = count("SELECT COUNT(*) FROM tracks WHERE fed = 0")

  override fun countUnsent(): Int = count("SELECT COUNT(*) FROM tracks WHERE fed = 0 AND batch IS NULL")

  override fun coverUsed(coverId: String): Boolean =
    count("SELECT (SELECT COUNT(*) FROM files WHERE cover_id = ?) + (SELECT COUNT(*) FROM tracks WHERE cover_id = ?)", coverId, coverId) > 0

  /** The earliest-added readable file of a track on a mounted volume; any thread (WAL readers do not wait). */
  fun playable(trackId: String): FileRec? =
    files("track_id = ? AND state = '${LocalStore.OK}' AND gone_at IS NULL AND away = 0 ORDER BY added ASC, key ASC LIMIT 1", trackId).firstOrNull()

  override fun close() {
    db.close()
  }
}
