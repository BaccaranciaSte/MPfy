package com.baccarancia.mpfy

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.Executors

/**
 * Covers for the notification, the lock screen, Bluetooth and Android Auto, which read artwork with
 * their own uid: content://com.baccarancia.mpfy.art/cover/<sourceId>/<coverId>/<small|large>.
 * Exported and read only; it serves only immutable covers named by unguessable ids (reachable only
 * through the token-protected library), fetched from the core and cached, and is never a proxy.
 */
class ArtProvider : ContentProvider() {
  private val fetcher by lazy {
    val dir = File(context!!.cacheDir, "art")
    dir.mkdirs()
    // Temporary files a process that died left behind.
    dir.listFiles { f -> f.name.endsWith(".tmp") }?.forEach { it.delete() }
    ArtFetcher(ArtCache(dir), HttpOpener(CoreHost.requestHeaders, connectMs = 8_000, readMs = 8_000), CoreHost.gate, timer)
  }

  override fun onCreate(): Boolean = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("read only")
    if (uri.authority != Artwork.AUTHORITY || uri.query != null) throw FileNotFoundException("no such cover")
    val key = Artwork.keyOf(uri.path) ?: throw FileNotFoundException("no such cover")
    val got = try {
      fetcher.open(key)
    } catch (e: FileNotFoundException) {
      Log.i(TAG, e.message ?: "cover not found")
      throw e
    }
    val pfd = ParcelFileDescriptor.open(got.file, ParcelFileDescriptor.MODE_READ_ONLY)
    // The original a source serves while the size is not made yet: read once, never kept.
    if (got.temp) got.file.delete()
    return pfd
  }

  override fun getType(uri: Uri): String {
    val key = Artwork.keyOf(uri.path) ?: return "image/jpeg"
    val f = File(File(context!!.cacheDir, "art"), key.fileName)
    return if (f.isFile) Artwork.typeOf(f) ?: "image/jpeg" else "image/jpeg"
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

  companion object {
    private const val TAG = "MPfyArt"
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "mpfy-art-timer").apply { isDaemon = true } }
  }
}
