package com.baccarancia.mpfy

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.content.IntentCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * In-app updates from the GitHub releases: looks for latest.json while MainActivity is started,
 * downloads and checks the APK, and hands it to PackageInstaller (the system asks the person). The
 * decisions are UpdateMachine's and UpdateRules'. Main thread unless it says otherwise.
 */
object Updates : UpdateMachine.Host {
  private const val TAG = "MPfyUpdates"
  private const val PREFS = "mpfy"
  private const val K_CHECKED_AT = "updateCheckedAt"
  private const val K_PENDING = "updatePending"
  private const val K_URL = "updateUrl"
  const val ACTION_STATUS = "com.baccarancia.mpfy.UPDATE_STATUS"
  private const val PROGRESS_EVERY_MS = 250L

  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()
  private var app: Context? = null
  private val machine = UpdateMachine(this)
  private var checking = false
  private var activity: WeakReference<Activity>? = null
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

  /** getUpdate(): { state, versionName, progress }. Any thread. */
  @Volatile
  var json: String = "{\"state\":\"none\",\"versionName\":\"\",\"progress\":0}"
    private set

  fun addListener(l: (String) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (String) -> Unit) {
    listeners.remove(l)
  }

  private fun prefs() = app!!.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun dir() = File(app!!.cacheDir, "updates")

  private fun debuggable() = (app!!.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  @Suppress("DEPRECATION")
  private fun installedCode(): Long = app!!.packageManager.getPackageInfo(app!!.packageName, 0).longVersionCode

  /** At process start: only the pending APK that is still newer stays. */
  fun init(ctx: Context) {
    if (app != null) return
    app = ctx.applicationContext
    val p = UpdatePending.parse(prefs().getString(K_PENDING, null))
    io.execute {
      val kept = try {
        dir().mkdirs()
        UpdateFiles.cleanup(dir(), p, installedCode())
      } catch (e: Exception) {
        Log.w(TAG, "cleanup", e)
        null
      }
      main.post {
        if (kept == null && p != null) prefs().edit().remove(K_PENDING).apply()
        machine.started(kept)
      }
    }
  }

  /** The launch intent's updateUrl (debuggable builds only): stored, an empty one clears it. */
  fun takeOverride(intent: Intent?): Boolean {
    if (!debuggable() || intent?.hasExtra(K_URL) != true) return false
    val v = intent.getStringExtra(K_URL) ?: ""
    if (v.isEmpty()) {
      prefs().edit().remove(K_URL).apply()
    } else if (UpdateRules.override(v, true) != null) {
      prefs().edit().putString(K_URL, v).apply()
    } else {
      Log.w(TAG, "updateUrl refused")
      return false
    }
    Log.i(TAG, if (v.isEmpty()) "update URL back to the release channel" else "update URL: $v")
    return true
  }

  private fun override(): String? = UpdateRules.override(prefs().getString(K_URL, null), debuggable())

  /** A check is due (the last one a day old). */
  fun due(): Boolean = UpdateRules.due(System.currentTimeMillis(), prefs().getLong(K_CHECKED_AT, 0))

  /** How long until the next check is due. */
  fun nextCheckIn(): Long = UpdateRules.nextIn(System.currentTimeMillis(), prefs().getLong(K_CHECKED_AT, 0))

  /** Looks for latest.json, only in state none or available. */
  fun check() {
    if (checking || !machine.canCheck()) return
    checking = true
    prefs().edit().putLong(K_CHECKED_AT, System.currentTimeMillis()).apply()
    val url = UpdateRules.checkUrl(override())
    val ov = override()
    io.execute {
      val result = try {
        val (status, body) = fetchJson(url)
        UpdateRules.outcome(status, body, installedCode(), installedSigners(), Build.VERSION.SDK_INT, ov)
      } catch (e: IOException) {
        Log.i(TAG, "check failed: ${e.javaClass.simpleName}")
        UpdateRules.Check.Failed
      } catch (e: Exception) {
        Log.w(TAG, "check failed", e)
        UpdateRules.Check.Failed
      }
      main.post {
        checking = false
        when (result) {
          is UpdateRules.Check.Newer -> Log.i(TAG, "update available: ${result.info.versionName} (${result.info.versionCode})")
          UpdateRules.Check.None -> Log.i(TAG, "no update")
          UpdateRules.Check.Failed -> {}
        }
        machine.checked(result)
      }
    }
  }

  private fun connect(url: String): HttpURLConnection {
    val c = URL(url).openConnection() as HttpURLConnection
    c.instanceFollowRedirects = true
    c.connectTimeout = 10_000
    c.readTimeout = 20_000
    c.useCaches = false
    c.setRequestProperty("User-Agent", "MPfy/${versionName()}")
    return c
  }

  private fun versionName(): String = runCatching { app!!.packageManager.getPackageInfo(app!!.packageName, 0).versionName }.getOrNull() ?: ""

  /** The status, and the body when it is at most 16 KiB (null when larger). */
  private fun fetchJson(url: String): Pair<Int, String?> {
    val c = connect(url)
    try {
      val status = c.responseCode
      if (status != 200) return status to null
      val out = ByteArrayOutputStream()
      c.inputStream.use { input ->
        val buf = ByteArray(4096)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          out.write(buf, 0, n)
          if (out.size() > UpdateRules.MAX_JSON_BYTES) return status to null
        }
      }
      return status to String(out.toByteArray(), Charsets.UTF_8)
    } finally {
      c.disconnect()
    }
  }

  fun startUpdate() = machine.startUpdate()

  /** MainActivity is in front: the install steps may run. */
  fun resumed(a: Activity) {
    activity = WeakReference(a)
    machine.resumed()
  }

  fun paused() {
    activity = null
    machine.paused()
  }

  fun stopped() = machine.stopped()

  // --- UpdateMachine.Host ---

  override fun emit(state: UpdateMachine.State, versionName: String, progress: Double, failed: Boolean) {
    val o = JSONObject().put("state", state.wire).put("versionName", versionName).put("progress", progress)
    json = o.toString()
    o.put("type", "update")
    if (failed) o.put("failed", true)
    val e = o.toString()
    for (l in listeners) l(e)
  }

  override fun pending(): UpdatePending? = UpdatePending.parse(prefs().getString(K_PENDING, null))

  override fun setPending(p: UpdatePending?) {
    // commit(): the next process start must find it, whatever happens to this one.
    if (p == null) prefs().edit().remove(K_PENDING).commit() else prefs().edit().putString(K_PENDING, p.toJson()).commit()
  }

  override fun apkExists(versionCode: Long): Boolean = File(dir(), UpdateFiles.apkName(versionCode)).isFile

  override fun deleteFiles() {
    val d = dir()
    io.execute { UpdateFiles.clearAll(d) }
  }

  override fun download(info: UpdateInfo) {
    val d = dir()
    io.execute {
      val ok = try {
        d.mkdirs()
        fetchApk(info, d)
        true
      } catch (e: Exception) {
        Log.w(TAG, "download failed: ${e.javaClass.simpleName} ${e.message}")
        File(d, UpdateFiles.partName(info.versionCode)).delete()
        false
      }
      main.post { machine.downloaded(ok) }
    }
  }

  private fun fetchApk(info: UpdateInfo, d: File) {
    UpdateFiles.clearAll(d)
    val part = File(d, UpdateFiles.partName(info.versionCode))
    val c = connect(info.url)
    try {
      val status = c.responseCode
      if (status != 200) throw IOException("HTTP $status")
      var got = 0L
      var last = 0L
      FileOutputStream(part).use { out ->
        c.inputStream.use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            got += n
            if (got > info.size) throw IOException("more bytes than announced")
            out.write(buf, 0, n)
            val now = SystemClock.elapsedRealtime()
            if (now - last >= PROGRESS_EVERY_MS) {
              last = now
              val p = got.toDouble() / info.size
              main.post { machine.progressed(p) }
            }
          }
        }
        out.fd.sync()
      }
      if (got != info.size) throw IOException("short download: $got of ${info.size}")
      if (!part.renameTo(File(d, UpdateFiles.apkName(info.versionCode)))) throw IOException("rename failed")
    } finally {
      c.disconnect()
    }
  }

  override fun verify(p: UpdatePending, full: Boolean) {
    val f = File(dir(), UpdateFiles.apkName(p.versionCode))
    io.execute {
      val ok = try {
        UpdateFiles.matches(f, p.size, p.sha256) && (!full || archiveOk(f, p.versionCode))
      } catch (e: Exception) {
        Log.w(TAG, "verify", e)
        false
      }
      if (!ok) Log.w(TAG, "the downloaded APK did not pass the checks")
      main.post { machine.verified(ok) }
    }
  }

  /** The archive is this app, the version latest.json named and newer than ours, signed by the same keys. */
  @Suppress("DEPRECATION")
  private fun archiveOk(f: File, versionCode: Long): Boolean {
    val pm = app!!.packageManager
    val info = archiveInfo(pm, f.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return false
    if (info.packageName != app!!.packageName) return false
    if (info.longVersionCode != versionCode || versionCode <= installedCode()) return false
    val digests = info.signingInfo?.apkContentsSigners?.map { UpdateRules.sha256Hex(it.toByteArray()) }?.toSet()
      ?: archiveInfo(pm, f.path, PackageManager.GET_SIGNATURES)?.signatures?.map { UpdateRules.sha256Hex(it.toByteArray()) }?.toSet()
      ?: return false
    return UpdateRules.sameSigners(digests, installedSigners())
  }

  private fun archiveInfo(pm: PackageManager, path: String, flags: Int): PackageInfo? =
    if (Build.VERSION.SDK_INT >= 33) {
      pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags.toLong()))
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageArchiveInfo(path, flags)
    }

  /** The SHA-256 digests of the installed package's signers. */
  private fun installedSigners(): Set<String> {
    val pm = app!!.packageManager
    val info = if (Build.VERSION.SDK_INT >= 33) {
      pm.getPackageInfo(app!!.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(app!!.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    }
    return info.signingInfo?.apkContentsSigners?.map { UpdateRules.sha256Hex(it.toByteArray()) }?.toSet().orEmpty()
  }

  override fun canInstall(): Boolean = app!!.packageManager.canRequestPackageInstalls()

  override fun openInstallSettings(): Boolean {
    val a = activity?.get() ?: return false
    return try {
      a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app!!.packageName}")))
      true
    } catch (e: Exception) {
      Log.w(TAG, "no unknown sources screen", e)
      false
    }
  }

  override fun commit(p: UpdatePending) {
    val ctx = app!!
    val f = File(dir(), UpdateFiles.apkName(p.versionCode))
    io.execute {
      try {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setSize(p.size)
        InstallSession.run(
          create = { installer.createSession(params) },
          write = { id ->
            installer.openSession(id).use { session ->
              session.openWrite("base.apk", 0, p.size).use { out ->
                f.inputStream().use { it.copyTo(out, 64 * 1024) }
                session.fsync(out)
              }
            }
          },
          commit = { id ->
            // Mutable and explicit: the installer adds its extras.
            val pi = PendingIntent.getBroadcast(
              ctx,
              id,
              Intent(ctx, UpdateReceiver::class.java).setAction(ACTION_STATUS),
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            installer.openSession(id).use { it.commit(pi.intentSender) }
          },
          abandon = { id -> installer.abandonSession(id) },
        )
        Log.i(TAG, "install session committed for ${p.versionName}")
      } catch (e: Exception) {
        Log.w(TAG, "install session failed", e)
        main.post { machine.installerStatus(PackageInstaller.STATUS_FAILURE, null, Keeper.inForeground) }
      }
    }
  }

  override fun startConfirm(confirm: Any): Boolean {
    val i = (confirm as? Intent)?.let { Intent(it).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) } ?: return false
    return try {
      (activity?.get() ?: app!!).startActivity(i)
      true
    } catch (e: Exception) {
      Log.w(TAG, "the system confirm did not start", e)
      false
    }
  }

  /** UpdateReceiver: the installer's answer. */
  fun onStatus(status: Int, confirm: Intent?, message: String?) {
    Log.i(TAG, "installer status $status${message?.let { ": $it" } ?: ""}")
    machine.installerStatus(status, confirm, Keeper.inForeground)
  }
}

/** PackageInstaller's answers to our commit. Not exported: only our PendingIntent reaches it. */
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Updates.ACTION_STATUS) return
    Updates.init(context)
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val confirm = if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) else null
    Updates.onStatus(status, confirm, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
  }
}
