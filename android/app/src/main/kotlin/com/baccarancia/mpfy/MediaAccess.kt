package com.baccarancia.mpfy

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat

/** When the phone's music access is asked for, and how. Free of Android classes. */
object MusicAccess {
  enum class Step { NOTHING, DIALOG, SETTINGS }

  /** A "no" back this fast was never on screen: Android refused by itself. */
  const val UNSEEN_MS = 400L

  /**
   * [mode] "first" (the app shows for the first time, an upgrade included): the system's dialog
   * only when it was never shown and access is not granted. "settings" (the row in Impostazioni,
   * Home's button): the dialog while Android may still show it (never asked, or refused once),
   * else the app's page in the system settings, where "Musica e audio" is turned on.
   */
  fun step(mode: String, granted: Boolean, asked: Boolean, rationale: Boolean): Step = when {
    granted -> Step.NOTHING
    mode == "first" -> if (asked) Step.NOTHING else Step.DIALOG
    mode == "settings" -> if (!asked || rationale) Step.DIALOG else Step.SETTINGS
    else -> Step.NOTHING
  }

  /** The dialog's "no" came back in [ms] with no reason to show: it was never on screen. */
  fun unseen(granted: Boolean, rationale: Boolean, ms: Long): Boolean = !granted && !rationale && ms < UNSEEN_MS

  /** What getMusicAccess() says. */
  fun state(granted: Boolean): String = if (granted) "granted" else "off"
}

/**
 * The phone's music access on Android: the permission of this Android version, whether its dialog
 * was ever shown (kept in the app's preferences, apart from the index, which does not exist before
 * the first grant), and the app's page in the system settings.
 */
object MediaAccess {
  private const val PREFS = "mpfy"
  private const val K_ASKED = "music.asked"

  val permission: String
    get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

  fun granted(ctx: Context): Boolean = ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

  fun asked(ctx: Context): Boolean = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(K_ASKED, false)

  fun markAsked(ctx: Context) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(K_ASKED, true).apply()
  }

  fun step(activity: Activity, mode: String): MusicAccess.Step =
    MusicAccess.step(mode, granted(activity), asked(activity), activity.shouldShowRequestPermissionRationale(permission))

  /** The app's page in the system settings. */
  fun openSettings(activity: Activity): Boolean = try {
    activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
    true
  } catch (e: Exception) {
    false
  }
}
