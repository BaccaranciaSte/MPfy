package com.baccarancia.mpfy

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.FilterInputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * "Carica cartella": the folder the person picked is walked, and its songs, archives
 * and pictures are served to the page at http://127.0.0.1:47123/__native/file/<id>, from the
 * WebView's own request interception only: nothing outside the WebView reaches a file (the core
 * answers 404 there). The page reads them with Range requests and uploads them.
 */
object Folders {
  private const val TAG = "MPfyFolders"
  private const val PREFIX = "/__native/file/"

  private class Picked(val uri: Uri, val size: Long, val mime: String, val requestId: String)

  private val files = ConcurrentHashMap<String, Picked>()
  private val trees = ConcurrentHashMap<String, Uri>()
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "MPfyFolders").apply { isDaemon = true } }

  /** Read grants on folders that an earlier process kept: their uploads are over. */
  fun init(ctx: Context) {
    val app = ctx.applicationContext
    worker.execute {
      for (p in app.contentResolver.persistedUriPermissions) {
        if (DocumentsContract.isTreeUri(p.uri)) runCatching { app.contentResolver.releasePersistableUriPermission(p.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
      }
    }
  }

  /** The picker answered [requestId] with [tree] (null: cancelled); events "folder" as files are found. */
  fun walk(ctx: Context, requestId: String, tree: Uri?, emit: (String) -> Unit) {
    val app = ctx.applicationContext
    if (tree == null) {
      emit(event(requestId, "cancelled").toString())
      return
    }
    worker.execute {
      try {
        runCatching { app.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        trees[requestId] = tree
        val root = DocumentsContract.getTreeDocumentId(tree)
        val folderName = nameOf(app, DocumentsContract.buildDocumentUriUsingTree(tree, root)) ?: ""
        val walker = Walker(app, tree, requestId, emit)
        walker.dir(root, folderName, 0)
        walker.flush()
        if (walker.count >= NativeFiles.MAX_FILES) Log.w(TAG, "folder cut at ${NativeFiles.MAX_FILES} files")
        emit(event(requestId, "done").put("folderName", folderName).put("count", walker.count).toString())
      } catch (e: Exception) {
        Log.w(TAG, "folder not read: ${e.javaClass.simpleName}")
        emit(event(requestId, "error").toString())
      }
    }
  }

  private fun event(requestId: String, state: String) = JSONObject().put("type", "folder").put("requestId", requestId).put("state", state)

  private class Walker(val ctx: Context, val tree: Uri, val requestId: String, val emit: (String) -> Unit) {
    var count = 0
    private var batch = JSONArray()

    fun flush() {
      if (batch.length() == 0) return
      emit(event(requestId, "files").put("files", batch).toString())
      batch = JSONArray()
    }

    fun dir(docId: String, path: String, depth: Int) {
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
      val cols = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      )
      class Row(val id: String, val name: String, val mime: String?, val size: Long, val modified: Long)
      val rows = ArrayList<Row>()
      ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
        while (c.moveToNext()) {
          val id = c.getString(0) ?: continue
          val name = c.getString(1) ?: continue
          rows.add(Row(id, name, c.getString(2), if (c.isNull(3)) -1 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4)))
        }
      }
      rows.sortWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
      for (r in rows) {
        if (count >= NativeFiles.MAX_FILES) return
        if (r.mime == DocumentsContract.Document.MIME_TYPE_DIR || !NativeFiles.keeps(r.name)) continue
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, r.id)
        val size = if (r.size >= 0) r.size else sizeOf(ctx, uri)
        if (size < 0) continue
        // By extension: providers guess (an .m4a said to be audio/mpeg).
        val mime = NativeFiles.mimeOf(r.name)
        val fid = MPfyBridge.newRequestId()
        files[fid] = Picked(uri, size, mime, requestId)
        batch.put(
          JSONObject().put("id", fid).put("name", r.name).put("relPath", "$path/${r.name}")
            .put("size", size).put("mime", mime).put("lastModified", r.modified),
        )
        count++
        if (batch.length() >= NativeFiles.BATCH) flush()
      }
      if (depth >= NativeFiles.MAX_DEPTH) return
      for (r in rows) {
        if (r.mime == DocumentsContract.Document.MIME_TYPE_DIR) dir(r.id, "$path/${r.name}", depth + 1)
      }
    }
  }

  private fun sizeOf(ctx: Context, uri: Uri): Long = try {
    ctx.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1
  } catch (e: Exception) {
    -1
  }

  private fun nameOf(ctx: Context, uri: Uri): String? = try {
    ctx.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /** The folder's uploads are over: its file URLs stop working. */
  fun release(ctx: Context, requestId: String) {
    files.entries.removeIf { it.value.requestId == requestId }
    val tree = trees.remove(requestId) ?: return
    if (trees.values.none { it == tree }) {
      runCatching { ctx.applicationContext.contentResolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
  }

  fun isFileRequest(path: String?): Boolean = path != null && path.startsWith("/__native/")

  /**
   * A request of the page (or its service worker) for /__native/...: GET only, Range served as
   * 206. The WebView applies a Range to an intercepted body itself: it skips to the range's first
   * byte and sizes it from available(). So a range gets the file from byte 0, cut after its last
   * byte, never a body that starts at the range.
   */
  fun serve(ctx: Context, method: String?, path: String?, range: String?): WebResourceResponse {
    if (method != "GET") return plain(405, "Method Not Allowed")
    val id = path?.takeIf { it.startsWith(PREFIX) }?.substring(PREFIX.length)
    val f = id?.let { files[it] } ?: return plain(404, "Not Found")
    val headers = HashMap<String, String>()
    headers["Accept-Ranges"] = "bytes"
    headers["Cache-Control"] = "no-store"
    return try {
      when (val ask = NativeFiles.range(range, f.size)) {
        is NativeFiles.Ask.Part -> {
          headers["Content-Range"] = "bytes ${ask.first}-${ask.last}/${f.size}"
          headers["Content-Length"] = (ask.last - ask.first + 1).toString()
          WebResourceResponse(f.mime, null, 206, "Partial Content", headers, open(ctx, f.uri, ask.last + 1))
        }
        NativeFiles.Ask.Unsatisfiable -> {
          headers["Content-Range"] = "bytes */${f.size}"
          WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", headers, ByteArrayInputStream(ByteArray(0)))
        }
        NativeFiles.Ask.Whole -> {
          headers["Content-Length"] = f.size.toString()
          WebResourceResponse(f.mime, null, 200, "OK", headers, open(ctx, f.uri, f.size))
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "file $id not served: ${e.javaClass.simpleName}")
      plain(404, "Not Found")
    }
  }

  private fun plain(status: Int, reason: String) =
    WebResourceResponse("text/plain", "utf-8", status, reason, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

  /** The file from byte 0, ending at byte [end] (exclusive). */
  private fun open(ctx: Context, uri: Uri, end: Long): InputStream {
    val pfd = ctx.applicationContext.contentResolver.openFileDescriptor(uri, "r") ?: throw FileNotFoundException()
    return Window(ParcelFileDescriptor.AutoCloseInputStream(pfd), end)
  }

  /** A stream that ends at [end]; skip() lands exactly where asked, as the WebView expects. */
  private class Window(input: InputStream, private val end: Long) : FilterInputStream(input) {
    private var pos = 0L

    override fun read(): Int {
      if (pos >= end) return -1
      val b = super.read()
      if (b >= 0) pos++
      return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (pos >= end) return -1
      val n = super.read(b, off, minOf(len.toLong(), end - pos).toInt())
      if (n > 0) pos += n
      return n
    }

    override fun skip(n: Long): Long {
      if (n <= 0) return 0
      val want = minOf(n, end - pos)
      var done = 0L
      while (done < want) {
        val s = super.skip(want - done)
        if (s <= 0) {
          if (super.read() < 0) break
          done++
        } else {
          done += s
        }
      }
      pos += done
      return done
    }

    override fun available(): Int = minOf(super.available().toLong(), end - pos).toInt()
  }
}
