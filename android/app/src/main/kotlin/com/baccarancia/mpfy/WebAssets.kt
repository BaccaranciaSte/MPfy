package com.baccarancia.mpfy

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * The UI files ship in the APK as assets/web/... (copied there by the copyWebAssets Gradle task)
 * and are served by the client core from filesDir/web-<versionCode>. They are copied
 * there at the first start of each version. A stamp with the install time is kept next to them,
 * so a reinstalled build with the same versionCode (development) gets its own files too.
 */
object WebAssets {
  private const val TAG = "MPfyWeb"
  private const val STAMP = ".mpfy-assets" // hidden: the core never serves dot files

  fun ensure(context: Context): File {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val code = info.longVersionCode
    val stamp = "$code:${info.lastUpdateTime}"
    val files = context.filesDir
    val dir = File(files, "web-$code")
    val stampFile = File(dir, STAMP)
    if (dir.isDirectory && stampFile.isFile && runCatching { stampFile.readText() }.getOrNull() == stamp) {
      removeOthers(files, dir)
      return dir
    }
    val began = System.currentTimeMillis()
    val tmp = File(files, "web-$code.tmp")
    tmp.deleteRecursively()
    val count = copyTree(context.assets, "web", tmp)
    if (count == 0) throw IOException("no web assets in the APK")
    File(tmp, STAMP).writeText(stamp)
    dir.deleteRecursively()
    if (!tmp.renameTo(dir)) throw IOException("cannot rename $tmp to $dir")
    removeOthers(files, dir)
    Log.i(TAG, "web files copied: $count in ${System.currentTimeMillis() - began} ms to ${dir.name}")
    return dir
  }

  private fun copyTree(assets: AssetManager, path: String, dest: File): Int {
    val children = assets.list(path) ?: emptyArray()
    if (children.isEmpty()) {
      // A file (the UI has no empty folders).
      dest.parentFile?.mkdirs()
      assets.open(path).use { input -> dest.outputStream().use { input.copyTo(it) } }
      return 1
    }
    dest.mkdirs()
    var n = 0
    for (name in children) n += copyTree(assets, "$path/$name", File(dest, name))
    return n
  }

  /** Older versions of the UI, and a copy left half done by a process that died meanwhile. */
  private fun removeOthers(files: File, keep: File) {
    val others = files.listFiles { f -> f.isDirectory && f.name.startsWith("web-") && f != keep } ?: return
    for (f in others) {
      f.deleteRecursively()
      Log.i(TAG, "removed ${f.name}")
    }
  }
}
