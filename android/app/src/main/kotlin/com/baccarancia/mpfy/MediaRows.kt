package com.baccarancia.mpfy

import android.content.Context
import android.database.Cursor
import android.os.Build
import android.provider.MediaStore
import java.util.Locale

/** One audio row of MediaStore as the index reads it. Times in milliseconds. */
data class Row(
  val volume: String,
  val mediaId: Long,
  val relPath: String,
  val name: String,
  val size: Long,
  val mtime: Long,
  val added: Long,
  val generation: Long?,
  val dataPath: String?,
)

/** MediaStore as the index sees it; a fake in the JVM tests. Called on the index's thread only. */
interface MediaRows {
  /** The external volumes mounted now. */
  fun volumes(): List<String>

  /** Changes when MediaStore rebuilt the volume's database (every id and DATE_ADDED new). */
  fun version(volume: String): String

  /** The volume's generation, null below API 30. */
  fun generation(volume: String): Long?

  /** The selection's rows, newest first; with [sinceGeneration], only those modified after it. */
  fun rows(volume: String, sinceGeneration: Long?): Sequence<Row>

  /** Every id of the selection, sorted. */
  fun ids(volume: String): LongArray

  /** How many rows the selection holds. */
  fun count(volume: String): Int
}

/**
 * What is not music although MediaStore calls it audio, by its folder: apps' own media under
 * `Android/`, the recorders' and the phone's own sounds, chat apps' audio at the root of old
 * installs. The recorders' folder names vary by vendor: they are all here. And by its length:
 * shorter than [MIN_SECONDS] (a voice command, a sound sample, a ringtone in Download), or a
 * length known to be 0; a file whose length is not known at all stays.
 */
object LocalPolicy {
  const val MIN_SECONDS = 20.0

  /** Whether a file of this length is not a song; [seconds] null: not known, kept. */
  fun tooShort(seconds: Double?): Boolean = seconds != null && seconds < MIN_SECONDS

  private val FOLDERS = setOf(
    "recordings", "call", "call recordings", "callrecordings", "voice recorder", "voicerecorder", "sound recorder",
    "sound_recorder", "recorder", "ringtones", "notifications", "alarms", "podcasts", "audiobooks",
  )
  private val ROOTS = setOf("android", "whatsapp", "telegram")

  fun excluded(relPath: String): Boolean {
    val parts = relPath.split('/').filter { it.isNotEmpty() }.map { it.lowercase(Locale.ROOT) }
    if (parts.isEmpty()) return false
    if (parts[0] in ROOTS) return true
    return parts.any { it in FOLDERS }
  }
}

/**
 * The audio rows of every external volume, with the selection that leaves out what MediaStore
 * itself marks as not music (pending, ringtones, notifications, alarms, podcasts, audiobooks,
 * recordings). Not IS_MUSIC: what vendors put in it varies. Counts what it reads, for the log.
 */
class StoreRows(context: Context) : MediaRows {
  private val ctx = context.applicationContext
  private val resolver = ctx.contentResolver

  @Volatile
  var rowsRead = 0L
    private set

  @Volatile
  var idsRead = 0L
    private set

  private val selection: String = buildString {
    append("${MediaStore.MediaColumns.IS_PENDING} = 0")
    for (c in listOf(MediaStore.Audio.AudioColumns.IS_RINGTONE, MediaStore.Audio.AudioColumns.IS_NOTIFICATION, MediaStore.Audio.AudioColumns.IS_ALARM, MediaStore.Audio.AudioColumns.IS_PODCAST, MediaStore.Audio.AudioColumns.IS_AUDIOBOOK)) {
      append(" AND ").append(c).append(" = 0")
    }
    if (Build.VERSION.SDK_INT >= 31) append(" AND ${MediaStore.Audio.AudioColumns.IS_RECORDING} = 0")
  }

  private fun uri(volume: String) = MediaStore.Audio.Media.getContentUri(volume)

  override fun volumes(): List<String> = MediaStore.getExternalVolumeNames(ctx).sorted()

  override fun version(volume: String): String =
    if (Build.VERSION.SDK_INT >= 30) MediaStore.getVersion(ctx, volume) else MediaStore.getVersion(ctx)

  override fun generation(volume: String): Long? =
    if (Build.VERSION.SDK_INT >= 30) MediaStore.getGeneration(ctx, volume) else null

  override fun rows(volume: String, sinceGeneration: Long?): Sequence<Row> {
    val gen = Build.VERSION.SDK_INT >= 30
    val cols = arrayListOf(
      MediaStore.MediaColumns._ID,
      MediaStore.MediaColumns.RELATIVE_PATH,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.DATE_MODIFIED,
      MediaStore.MediaColumns.DATE_ADDED,
    )
    if (gen) cols.add(MediaStore.MediaColumns.GENERATION_MODIFIED)
    // Android 10 only: the path, for an .lrc beside the song.
    @Suppress("DEPRECATION")
    if (!gen) cols.add(MediaStore.MediaColumns.DATA)
    var sel = selection
    var args: Array<String>? = null
    if (sinceGeneration != null && gen) {
      sel += " AND ${MediaStore.MediaColumns.GENERATION_MODIFIED} > ?"
      args = arrayOf(sinceGeneration.toString())
    }
    val out = ArrayList<Row>()
    resolver.query(uri(volume), cols.toTypedArray(), sel, args, "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use { c ->
      while (c.moveToNext()) {
        out.add(
          Row(
            volume = volume,
            mediaId = c.getLong(0),
            relPath = c.getString(1) ?: "",
            name = c.getString(2) ?: "",
            size = c.getLong(3),
            mtime = c.getLong(4) * 1000,
            added = c.getLong(5) * 1000,
            generation = if (gen) c.getLong(6) else null,
            dataPath = if (gen) null else c.getString(6),
          ),
        )
      }
    }
    rowsRead += out.size
    return out.asSequence()
  }

  override fun ids(volume: String): LongArray {
    resolver.query(uri(volume), arrayOf(MediaStore.MediaColumns._ID), selection, null, "${MediaStore.MediaColumns._ID} ASC")?.use { c ->
      val out = LongArray(c.count)
      var i = 0
      while (c.moveToNext() && i < out.size) out[i++] = c.getLong(0)
      idsRead += i
      return out.copyOf(i)
    }
    return LongArray(0)
  }

  override fun count(volume: String): Int {
    // An aggregate over an allowed column: one row back instead of every id.
    try {
      resolver.query(uri(volume), arrayOf("COUNT(${MediaStore.MediaColumns._ID})"), selection, null, null)?.use { c ->
        if (c.moveToFirst()) return c.getInt(0)
      }
    } catch (e: Exception) {
      // A provider that refuses the aggregate: counted from the ids.
    }
    return resolver.query(uri(volume), arrayOf(MediaStore.MediaColumns._ID), selection, null, null)?.use(Cursor::getCount) ?: 0
  }
}
