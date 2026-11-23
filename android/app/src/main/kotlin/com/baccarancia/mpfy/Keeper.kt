package com.baccarancia.mpfy

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Decides when the worklet may sleep (battery): when no Activity is visible, the player
 * neither plays nor loads, no download moves bytes, no upload is under way and nothing holds it
 * (the heart, a cover for the car, a connected Android Auto), the worklet is suspended after
 * [SUSPEND_AFTER_MS]; any of them resumes it at once. Every method runs on, or posts to, the main
 * thread.
 */
object Keeper : Holder {
  private const val TAG = "MPfyKeeper"
  const val SUSPEND_AFTER_MS = 60_000L

  private val main = Handler(Looper.getMainLooper())
  private var started = 0
  private var playerBusy = false
  private var downloading = false
  private var uploading = false
  // Who holds the worklet awake for a request of its own, and how many times.
  private val holds = HashMap<String, Int>()
  private val suspendTask = Runnable {
    Log.i(TAG, "in the background with nothing playing, loading or uploading for ${SUSPEND_AFTER_MS / 1000} s: suspending the worklet")
    CoreHost.suspend()
  }

  /** True while an Activity of the app is visible. Main thread only. */
  val inForeground: Boolean get() = started > 0

  // Told when the app comes to the front or leaves it (the message notifier). Main thread.
  private val foregroundListeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

  fun addForegroundListener(l: () -> Unit) {
    foregroundListeners.add(l)
  }

  fun removeForegroundListener(l: () -> Unit) {
    foregroundListeners.remove(l)
  }

  private fun foregroundChanged() {
    for (l in foregroundListeners) l()
  }

  fun init(app: Application) {
    app.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
          started++
          if (started == 1) {
            Downloads.onForeground(activity)
            Uploads.onForeground(activity)
          }
          update()
          if (started == 1) foregroundChanged()
        }

        override fun onActivityStopped(activity: Activity) {
          started = (started - 1).coerceAtLeast(0)
          update()
          if (started == 0) foregroundChanged()
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
      },
    )
  }

  /** The player plays, means to, or loads (PlayerPolicy.needsCore). */
  fun setPlayerBusy(value: Boolean) = main.post {
    if (playerBusy == value) return@post
    playerBusy = value
    update()
  }

  fun setDownloading(value: Boolean) = main.post {
    if (downloading == value) return@post
    downloading = value
    update()
  }

  /** The page's upload queue has work (setUploading): counted like a download that moves bytes. */
  fun setUploading(value: Boolean) = main.post {
    if (uploading == value) return@post
    uploading = value
    update()
  }

  /** Keeps the worklet awake (a suspended one resumes at once) until [release] with the same tag. Any thread. */
  override fun hold(tag: String) {
    main.post {
      holds[tag] = (holds[tag] ?: 0) + 1
      update()
    }
  }

  override fun release(tag: String) {
    main.post {
      val n = (holds[tag] ?: 0) - 1
      if (n > 0) holds[tag] = n else holds.remove(tag)
      update()
    }
  }

  /** Re-applies the policy; also called after a new worklet started. Main thread. */
  fun update() {
    main.removeCallbacks(suspendTask)
    if (started > 0 || playerBusy || downloading || uploading || holds.isNotEmpty()) {
      CoreHost.resume()
    } else {
      main.postDelayed(suspendTask, SUSPEND_AFTER_MS)
    }
  }
}
