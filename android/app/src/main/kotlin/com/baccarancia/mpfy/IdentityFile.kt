package com.baccarancia.mpfy

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The profile file, Documents/MPfy/<name>.mpfy: the identity the core sends after every
 * change, written again whole. The target is a file the person picked and the app adopted, or one
 * the app made through MediaStore. On Android 10 nothing is written: there any app with storage
 * access reads Documents. Uninstalling leaves only this file. Work runs on one background thread.
 */
object IdentityFile {
  private const val TAG = "MPfyIdentity"
  private const val PREFS = "mpfy"
  private const val K_URI = "identity.uri"
  private const val K_ADOPTED = "identity.adopted"
  private const val K_ASKED = "identity.asked" // the file name last asked for
  private const val K_NAME = "identity.name" // the name the file really has
  private const val DEBOUNCE_MS = 1_000L
  private const val MAX_READ = 256 * 1024
  private const val RW = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "MPfyIdentity").apply { isDaemon = true } }
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()
  private val picked = ConcurrentHashMap<String, Uri>()
  private var app: Context? = null
  @Volatile private var latest: Pair<String, String>? = null
  @Volatile private var hasProfile = false
  @Volatile private var state = "none"
  @Volatile private var fileName: String? = null

  /** From Android 11 scoped storage keeps other apps out of the file. */
  val supported: Boolean get() = Build.VERSION.SDK_INT >= 30

  private val writeTask = Runnable {
    val l = latest ?: return@Runnable
    worker.execute { write(l.first, l.second) }
  }

  fun init(ctx: Context) {
    app = ctx.applicationContext
    if (!supported) return
    val prefs = prefs()
    if (prefs.getString(K_URI, null) != null) {
      fileName = prefs.getString(K_NAME, null)
      state = if (fileName != null) "ok" else "none"
    }
  }

  fun addListener(l: (String) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (String) -> Unit) {
    listeners.remove(l)
  }

  /** getProfileFile(): { fileName, folder, state: ok | pending | error | none }. */
  fun json(): JSONObject {
    val s = if (!supported || !hasProfile) "none" else state
    return JSONObject()
      .put("fileName", if (s == "none") JSONObject.NULL else (fileName ?: JSONObject.NULL))
      .put("folder", IdentityNames.FOLDER)
      .put("state", s)
  }

  /** Main thread. */
  private fun report(name: String?, s: String) {
    if (name == fileName && s == state) return
    fileName = name
    state = s
    val e = json().put("type", "profileFileState").toString()
    for (l in listeners) l(e)
  }

  /** The core's profile event: whether a profile exists. */
  fun onProfile(exists: Boolean) {
    if (hasProfile == exists) return
    hasProfile = exists
    val e = json().put("type", "profileFileState").toString()
    for (l in listeners) l(e)
  }

  /** The core's identity event: the file is written again a second after the last change. Any thread. */
  fun onIdentity(name: String, text: String) {
    latest = name to text
    if (!hasProfile) onProfile(true)
    if (!supported) return
    main.post {
      if (state != "ok") report(fileName, "pending")
      main.removeCallbacks(writeTask)
      main.postDelayed(writeTask, DEBOUNCE_MS)
    }
  }

  private fun prefs() = app!!.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun write(rawName: String, text: String) {
    val ctx = app ?: return
    val want = IdentityNames.sanitize(rawName)
    val bytes = text.toByteArray(Charsets.UTF_8)
    val prefs = prefs()
    var uri = prefs.getString(K_URI, null)?.let(Uri::parse)
    if (uri != null) {
      if (prefs.getString(K_ASKED, null) != want) {
        val renamed = rename(ctx, uri, prefs.getBoolean(K_ADOPTED, false), want)
        if (renamed != null) {
          uri = renamed
          prefs.edit().putString(K_URI, renamed.toString()).putString(K_ASKED, want).apply()
        }
      }
      if (writeTo(ctx, uri, bytes)) {
        done(uri)
        return
      }
      Log.w(TAG, "the profile file could not be written: a new one")
    }
    val made = create(ctx, want, bytes)
    if (made == null) {
      main.post { report(fileName, "error") }
      return
    }
    prefs.edit().putString(K_URI, made.toString()).putBoolean(K_ADOPTED, false).putString(K_ASKED, want).apply()
    done(made)
  }

  /** Written: the name the file really has (an orphan of an earlier install may have taken ours). */
  private fun done(uri: Uri) {
    val ctx = app ?: return
    val name = nameOf(ctx, uri) ?: fileName
    prefs().edit().putString(K_NAME, name).apply()
    main.post { report(name, "ok") }
  }

  /** Every byte again: "rwt" truncates (plain "w" does not on these providers), then sync. */
  private fun writeTo(ctx: Context, uri: Uri, bytes: ByteArray): Boolean = try {
    val pfd = ctx.contentResolver.openFileDescriptor(uri, "rwt") ?: throw java.io.FileNotFoundException()
    ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { out ->
      out.write(bytes)
      out.flush()
      out.fd.sync()
    }
    true
  } catch (e: Exception) {
    Log.w(TAG, "write: ${e.javaClass.simpleName}")
    false
  }

  private fun create(ctx: Context, name: String, bytes: ByteArray): Uri? {
    val resolver = ctx.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.RELATIVE_PATH, IdentityNames.FOLDER)
      put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = try {
      resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
    } catch (e: Exception) {
      Log.w(TAG, "insert: ${e.javaClass.simpleName}")
      null
    } ?: return null
    if (!writeTo(ctx, uri, bytes)) {
      runCatching { resolver.delete(uri, null, null) }
      return null
    }
    return try {
      resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      Log.i(TAG, "profile file made in ${IdentityNames.FOLDER}")
      uri
    } catch (e: Exception) {
      runCatching { resolver.delete(uri, null, null) }
      null
    }
  }

  /** The file under its new name: its URI, or null when the rename failed (the old name stays). */
  private fun rename(ctx: Context, uri: Uri, adopted: Boolean, name: String): Uri? = try {
    if (adopted) {
      val moved = DocumentsContract.renameDocument(ctx.contentResolver, uri, name) ?: uri
      if (moved != uri) {
        ctx.contentResolver.takePersistableUriPermission(moved, RW)
        runCatching { ctx.contentResolver.releasePersistableUriPermission(uri, RW) }
      }
      moved
    } else {
      val n = ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME, name) }, null, null)
      if (n > 0) uri else null
    }
  } catch (e: Exception) {
    Log.w(TAG, "rename: ${e.javaClass.simpleName}")
    null
  }

  private fun nameOf(ctx: Context, uri: Uri): String? = try {
    ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /** Where "Dal file del telefono" opens: Documents/MPfy of the phone's own storage. */
  fun initialUri(): Uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:${IdentityNames.FOLDER}")

  /** The picker answered [requestId] with [uri] (null: cancelled): event profileFile with at most 256 KB of UTF-8. */
  fun onPicked(requestId: String, uri: Uri?, emit: (String) -> Unit) {
    val ctx = app ?: return
    if (uri == null) {
      emit(JSONObject().put("type", "profileFile").put("requestId", requestId).put("state", "cancelled").toString())
      return
    }
    worker.execute {
      val out = JSONObject().put("type", "profileFile").put("requestId", requestId)
      try {
        val buf = ByteArrayOutputStream()
        ctx.contentResolver.openInputStream(uri)?.use { input ->
          val chunk = ByteArray(16 * 1024)
          while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            buf.write(chunk, 0, n)
            if (buf.size() > MAX_READ) throw java.io.IOException("too big")
          }
        } ?: throw java.io.FileNotFoundException()
        picked[requestId] = uri
        out.put("state", "ok").put("name", nameOf(ctx, uri) ?: "").put("text", String(buf.toByteArray(), Charsets.UTF_8))
      } catch (e: Exception) {
        Log.w(TAG, "profile file not read: ${e.javaClass.simpleName}")
        out.put("state", "error")
      }
      emit(out.toString())
    }
  }

  /** After a successful import: future writes go to the picked file, when it lives on the phone. */
  fun adopt(requestId: String) {
    val uri = picked.remove(requestId) ?: return
    picked.clear()
    val ctx = app ?: return
    if (!supported) return
    worker.execute {
      if (!IdentityNames.canAdopt(uri.authority)) {
        Log.i(TAG, "a file of another provider is not written back: the next write makes a new one")
        return@execute
      }
      try {
        ctx.contentResolver.takePersistableUriPermission(uri, RW)
      } catch (e: Exception) {
        Log.w(TAG, "adopt: ${e.javaClass.simpleName}")
        return@execute
      }
      val name = nameOf(ctx, uri)
      val prefs = prefs()
      val old = prefs.getString(K_URI, null)?.let(Uri::parse)
      if (old != null && old != uri && prefs.getBoolean(K_ADOPTED, false)) {
        runCatching { ctx.contentResolver.releasePersistableUriPermission(old, RW) }
      }
      prefs.edit().putString(K_URI, uri.toString()).putBoolean(K_ADOPTED, true).putString(K_ASKED, name).putString(K_NAME, name).apply()
      main.post {
        report(name, "ok")
        // The file gets the identity as it is now (and the profile's name, when it differs).
        if (latest != null) {
          main.removeCallbacks(writeTask)
          main.postDelayed(writeTask, DEBOUNCE_MS)
        }
      }
    }
  }
}
