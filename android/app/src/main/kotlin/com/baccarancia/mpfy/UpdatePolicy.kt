package com.baccarancia.mpfy

import com.baccarancia.mpfy.Json.bool
import com.baccarancia.mpfy.Json.long
import com.baccarancia.mpfy.Json.str
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest

/*
 * In-app updates, free of Android classes: what latest.json must say, when to look, the files kept
 * between two starts, and the steps from "available" to the system's install confirm. Updates.kt
 * carries them out.
 */

/** A newer release as latest.json names it, already checked against this install. */
data class UpdateInfo(
  val versionCode: Long,
  val versionName: String,
  val url: String,
  val size: Long,
  val sha256: String,
  val signer: String,
  val minSdk: Long,
)

/** A downloaded and verified APK waiting to be installed (prefs.updatePending); [settings]: a trip to "Installa app sconosciute" is under way. */
data class UpdatePending(val versionCode: Long, val versionName: String, val size: Long, val sha256: String, val settings: Boolean) {
  fun toJson(): String = Json.write(
    linkedMapOf("versionCode" to versionCode, "versionName" to versionName, "size" to size, "sha256" to sha256, "settings" to settings),
  )

  companion object {
    fun parse(text: String?): UpdatePending? {
      val o = text?.let { Json.obj(it) } ?: return null
      val v = o.long("versionCode") ?: return null
      val size = o.long("size") ?: return null
      val sha = o.str("sha256")?.takeIf { UpdateRules.isHex64(it) } ?: return null
      return UpdatePending(v, o.str("versionName") ?: "", size, sha, o.bool("settings") == true)
    }

    fun of(info: UpdateInfo) = UpdatePending(info.versionCode, info.versionName, info.size, info.sha256, false)
  }
}

object UpdateRules {
  const val CHECK_URL = "https://github.com/BaccaranciaSte/MPfy/releases/latest/download/latest.json"
  const val MAX_JSON_BYTES = 16 * 1024
  const val MAX_APK_BYTES = 209_715_200L
  const val DAY_MS = 24L * 3600 * 1000
  private const val RELEASES = "/BaccaranciaSte/MPfy/releases/download/"
  private val HEX64 = Regex("[0-9a-f]{64}")
  private val NAME = Regex("\\d+\\.\\d+\\.\\d+")

  fun isHex64(s: String?) = s != null && HEX64.matches(s)

  /** The launch intent's updateUrl, taken only by a debuggable build: http://127.0.0.1:<port>/... or https://...; else null. */
  fun override(url: String?, debuggable: Boolean): String? {
    if (!debuggable || url.isNullOrEmpty()) return null
    val u = parse(url) ?: return null
    if (u.rawUserInfo != null || u.rawFragment != null) return null
    return when {
      u.scheme == "http" && u.host == "127.0.0.1" && u.port in 1..65535 -> url
      u.scheme == "https" && !u.host.isNullOrEmpty() -> url
      else -> null
    }
  }

  fun checkUrl(override: String?): String = override ?: CHECK_URL

  private fun parse(url: String): URI? = try {
    URI(url)
  } catch (e: Exception) {
    null
  }

  private fun port(u: URI) = if (u.port >= 0) u.port else if (u.scheme == "https") 443 else 80

  /** The APK's URL: this repo's release downloads, or with the override its own scheme, host and port. */
  fun urlAllowed(url: String, override: String?): Boolean {
    val u = parse(url) ?: return false
    if (u.rawUserInfo != null || u.rawFragment != null || u.host.isNullOrEmpty()) return false
    val path = u.rawPath ?: return false
    if (!path.endsWith(".apk")) return false
    if (u.scheme == "https" && u.host == "github.com" && port(u) == 443 && path.startsWith(RELEASES)) return true
    val o = override?.let { parse(it) } ?: return false
    return u.scheme == o.scheme && u.host == o.host && port(u) == port(o)
  }

  /** latest.json as an update for this install ([signers]: its set of signer SHA-256 digests), or null when it names none. */
  fun info(o: Map<String, Any?>, installedCode: Long, signers: Set<String>, sdk: Int, override: String?): UpdateInfo? {
    if (o.str("format") != "mpfy-update" || o.long("v") != 1L) return null
    val code = o.long("versionCode") ?: return null
    if (code <= installedCode) return null
    val name = o.str("versionName")?.takeIf { NAME.matches(it) } ?: return null
    val size = o.long("size")?.takeIf { it in 1..MAX_APK_BYTES } ?: return null
    val sha = o.str("sha256")?.takeIf { isHex64(it) } ?: return null
    val signer = o.str("signer")?.takeIf { isHex64(it) && it in signers } ?: return null
    val minSdk = o.long("minSdk")?.takeIf { it <= sdk } ?: return null
    val url = o.str("url")?.takeIf { urlAllowed(it, override) } ?: return null
    return UpdateInfo(code, name, url, size, sha, signer, minSdk)
  }

  sealed class Check {
    data class Newer(val info: UpdateInfo) : Check()

    /** Nothing newer for this install, or an answer that names nothing valid. */
    object None : Check()

    /** No answer worth acting on: the state stays as it is. */
    object Failed : Check()
  }

  /** What one check's answer means. [body] null: the body was larger than [MAX_JSON_BYTES]. */
  fun outcome(status: Int, body: String?, installedCode: Long, signers: Set<String>, sdk: Int, override: String?): Check {
    if (status in 500..599) return Check.Failed
    if (status != 200 || body == null) return Check.None
    val parsed = try {
      Json.parse(body)
    } catch (e: Json.Error) {
      return Check.Failed
    }
    @Suppress("UNCHECKED_CAST")
    val o = parsed as? Map<String, Any?> ?: return Check.None
    return info(o, installedCode, signers, sdk, override)?.let { Check.Newer(it) } ?: Check.None
  }

  /** A check is due when the last one is a day old (or the clock went back). */
  fun due(now: Long, checkedAt: Long): Boolean = checkedAt <= 0 || now < checkedAt || now - checkedAt >= DAY_MS

  /** How long until the next check is due. */
  fun nextIn(now: Long, checkedAt: Long): Long = if (due(now, checkedAt)) 0 else checkedAt + DAY_MS - now

  /** The same signers: one set of SHA-256 digests equal to the other, never empty. */
  fun sameSigners(a: Set<String>, b: Set<String>): Boolean = a.isNotEmpty() && a == b

  fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

/** The files in cacheDir/updates. */
object UpdateFiles {
  fun apkName(versionCode: Long) = "MPfy-$versionCode.apk"

  fun partName(versionCode: Long) = "MPfy-$versionCode.apk.part"

  /** The file has exactly [size] bytes and that SHA-256. */
  fun matches(f: File, size: Long, sha256: String): Boolean {
    if (!f.isFile || f.length() != size) return false
    return try {
      val md = MessageDigest.getInstance("SHA-256")
      f.inputStream().use { input ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          md.update(buf, 0, n)
        }
      }
      md.digest().joinToString("") { "%02x".format(it) } == sha256
    } catch (e: IOException) {
      false
    }
  }

  /**
   * At process start: only the pending APK stays, when it is still newer than what is installed;
   * every other file goes. The pending record that is still good, or null (cleared).
   */
  fun cleanup(dir: File, pending: UpdatePending?, installedCode: Long): UpdatePending? {
    val keep = pending?.takeIf { it.versionCode > installedCode && File(dir, apkName(it.versionCode)).isFile }
    val keepName = keep?.let { apkName(it.versionCode) }
    dir.listFiles()?.forEach { f -> if (f.name != keepName) f.deleteRecursively() }
    return keep
  }

  /** When a download starts: everything else goes. */
  fun clearAll(dir: File) {
    dir.listFiles()?.forEach { it.deleteRecursively() }
  }
}

/** One PackageInstaller session: created, written and committed. */
object InstallSession {
  /**
   * A session that fails while it is written (no space for the copy, say) is abandoned, never left
   * with its partial copy until the system expires it. Once committed it is the installer's.
   */
  fun run(create: () -> Int, write: (Int) -> Unit, commit: (Int) -> Unit, abandon: (Int) -> Unit) {
    val id = create()
    try {
      write(id)
    } catch (e: Exception) {
      runCatching { abandon(id) }
      throw e
    }
    commit(id)
  }
}

/**
 * none -> available -> downloading -> installing -> (the process is replaced). Main thread; the
 * host does the slow work off it and answers through [checked], [progressed], [downloaded],
 * [verified] and [installerStatus].
 */
class UpdateMachine(private val host: Host) {
  enum class State(val wire: String) { NONE("none"), AVAILABLE("available"), DOWNLOADING("downloading"), INSTALLING("installing") }

  interface Host {
    fun emit(state: State, versionName: String, progress: Double, failed: Boolean)

    fun pending(): UpdatePending?

    fun setPending(p: UpdatePending?)

    fun apkExists(versionCode: Long): Boolean

    /** The APK and anything else in cacheDir/updates. */
    fun deleteFiles()

    /** Downloads [info] to its .apk; answers [downloaded]. */
    fun download(info: UpdateInfo)

    /** Size and SHA-256 of the pending APK, with [full] also the archive's package, version and signers; answers [verified]. */
    fun verify(p: UpdatePending, full: Boolean)

    fun canInstall(): Boolean

    /** Opens "Installa app sconosciute" for this app; false when it could not be opened. */
    fun openInstallSettings(): Boolean

    /** Writes the APK into a PackageInstaller session and commits it; the installer answers [installerStatus]. */
    fun commit(p: UpdatePending)

    /** Starts the system's confirm; false when it could not be started. */
    fun startConfirm(confirm: Any): Boolean
  }

  private enum class Step { AFTER_DOWNLOAD, BEFORE_INSTALL, AFTER_SETTINGS }

  var state = State.NONE
    private set
  var info: UpdateInfo? = null
    private set
  var progress = 0.0
    private set
  private var versionName = ""
  private var resumed = false
  // A download that ended in the background: the install steps follow at the next resume.
  private var installOnResume = false
  private var heldConfirm: Any? = null
  private var step: Step? = null
  // The system confirm is up and unanswered; [confirmLeft]: the app went to the background meanwhile.
  private var confirmShown = false
  private var confirmLeft = false

  /** After the leftovers were cleaned at process start: a verified APK waiting makes the update available. */
  fun started(p: UpdatePending?) {
    if (p != null && state == State.NONE) {
      versionName = p.versionName
      set(State.AVAILABLE)
    }
  }

  fun canCheck() = state == State.NONE || state == State.AVAILABLE

  fun checked(result: UpdateRules.Check) {
    if (!canCheck()) return
    when (result) {
      UpdateRules.Check.Failed -> return
      UpdateRules.Check.None -> {
        info = null
        if (host.pending() != null) {
          host.setPending(null)
          host.deleteFiles()
        }
        installOnResume = false
        set(State.NONE)
      }
      is UpdateRules.Check.Newer -> {
        info = result.info
        versionName = result.info.versionName
        set(State.AVAILABLE)
      }
    }
  }

  /** The person tapped the button. */
  fun startUpdate() {
    if (state != State.AVAILABLE) return
    val p = host.pending()
    val i = info
    if (p != null && host.apkExists(p.versionCode) && (i == null || (i.versionCode == p.versionCode && i.sha256 == p.sha256 && i.size == p.size))) {
      installOnResume = false
      set(State.INSTALLING)
      verify(p, Step.BEFORE_INSTALL)
      return
    }
    if (i == null) return
    if (p != null) host.setPending(null)
    host.deleteFiles()
    installOnResume = false
    progress = 0.0
    set(State.DOWNLOADING)
    host.download(i)
  }

  fun progressed(p: Double) {
    if (state != State.DOWNLOADING) return
    progress = p.coerceIn(0.0, 1.0)
    emit(false)
  }

  fun downloaded(ok: Boolean) {
    if (state != State.DOWNLOADING) return
    val i = info
    if (!ok || i == null) {
      fail()
      return
    }
    progress = 1.0
    emit(false)
    verify(UpdatePending.of(i), Step.AFTER_DOWNLOAD)
  }

  private fun verify(p: UpdatePending, s: Step) {
    step = s
    host.verify(p, full = s == Step.AFTER_DOWNLOAD)
  }

  fun verified(ok: Boolean) {
    val s = step ?: return
    step = null
    if (!ok) {
      host.setPending(null)
      fail()
      return
    }
    when (s) {
      Step.AFTER_DOWNLOAD -> {
        info?.let { host.setPending(UpdatePending.of(it)) }
        if (resumed) {
          installSteps()
        } else {
          installOnResume = true
          set(State.AVAILABLE)
        }
      }
      Step.BEFORE_INSTALL -> if (resumed) installSteps() else set(State.AVAILABLE)
      Step.AFTER_SETTINGS -> commit()
    }
  }

  /** Only while the app is in front (Android blocks a background start of the system confirm). */
  private fun installSteps() {
    val p = host.pending() ?: return fail()
    if (!host.canInstall()) {
      host.setPending(p.copy(settings = true))
      set(State.INSTALLING)
      if (!host.openInstallSettings()) {
        host.setPending(p.copy(settings = false))
        set(State.AVAILABLE)
      }
      return
    }
    commit()
  }

  private fun commit() {
    val p = host.pending() ?: return fail()
    confirmShown = false
    set(State.INSTALLING)
    host.commit(p)
  }

  private fun showConfirm(c: Any): Boolean {
    if (!host.startConfirm(c)) return false
    confirmShown = true
    confirmLeft = false
    return true
  }

  fun resumed() {
    resumed = true
    heldConfirm?.let { c ->
      heldConfirm = null
      if (!showConfirm(c)) set(State.AVAILABLE)
      return
    }
    if (state == State.INSTALLING && confirmShown && confirmLeft) {
      // The confirm was left with Home: the installer says nothing until it is answered, from its
      // own task in recents. The full ring again with the APK kept; the next tap asks again.
      confirmShown = false
      confirmLeft = false
      set(State.AVAILABLE)
      return
    }
    val p = host.pending()
    if (p != null && p.settings) {
      host.setPending(p.copy(settings = false))
      versionName = p.versionName
      if (host.canInstall() && host.apkExists(p.versionCode)) {
        set(State.INSTALLING)
        verify(p, Step.AFTER_SETTINGS)
      } else {
        // Not granted: no toast, the APK kept; the next tap comes straight back here.
        set(State.AVAILABLE)
      }
      return
    }
    if (installOnResume && state == State.AVAILABLE && p != null) {
      installOnResume = false
      installSteps()
    }
  }

  fun paused() {
    resumed = false
  }

  /** MainActivity went to the background (not just under the confirm's dialog). */
  fun stopped() {
    if (confirmShown) confirmLeft = true
  }

  /** PackageInstaller's answer. [confirm]: the system confirm of a pending user action; [inFront]: an Activity of the app is visible. */
  fun installerStatus(status: Int, confirm: Any?, inFront: Boolean) {
    if (status != STATUS_PENDING_USER_ACTION) confirmShown = false
    when (status) {
      STATUS_PENDING_USER_ACTION -> when {
        confirm == null -> fail(clear = true)
        inFront && showConfirm(confirm) -> {}
        else -> heldConfirm = confirm
      }
      STATUS_SUCCESS -> {}
      STATUS_FAILURE_ABORTED -> set(State.AVAILABLE)
      else -> fail(clear = true)
    }
  }

  private fun fail(clear: Boolean = false) {
    if (clear) host.setPending(null)
    host.deleteFiles()
    installOnResume = false
    set(State.AVAILABLE, failed = true)
  }

  private fun set(s: State, failed: Boolean = false) {
    state = s
    emit(failed)
  }

  private fun emit(failed: Boolean) = host.emit(state, versionName, if (state == State.DOWNLOADING) progress else 0.0, failed)

  companion object {
    // PackageInstaller's status codes.
    const val STATUS_PENDING_USER_ACTION = -1
    const val STATUS_SUCCESS = 0
    const val STATUS_FAILURE_ABORTED = 3
  }
}
