package com.baccarancia.mpfy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Uploads with the screen off. While the page says its upload queue has work, the
 * worklet is not suspended ([Keeper]) and, when the batch starts with the app in front, a dataSync
 * foreground service keeps the process alive with the notification "Caricamento su <fonte>".
 * The queue lives in the page: a page that goes away ends its uploads ([UploadState]).
 * Main thread.
 */
object Uploads {
  private const val TAG = "MPfyUploads"
  private val main = Handler(Looper.getMainLooper())
  private var app: Context? = null
  // Sources the uploads of this batch go to, seen in their requests.
  private val targets = LinkedHashSet<String>()
  internal val state = UploadState()

  @Volatile
  var active = false
    private set

  // Told when uploads start or end (MainActivity keeps the page awake meanwhile). Main thread.
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<(Boolean) -> Unit>()

  fun addListener(l: (Boolean) -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: (Boolean) -> Unit) {
    listeners.remove(l)
  }

  fun init(ctx: Context) {
    app = ctx.applicationContext
  }

  /** [page] (its bridge) says whether its upload queue has work. */
  fun set(page: Any, on: Boolean) {
    if (state.say(page, on)) changed()
  }

  /** [page] went away: its renderer died or its Activity ended, and the uploads with it. */
  fun gone(page: Any) {
    if (state.gone(page)) changed()
  }

  private fun changed() {
    val on = state.active
    active = on
    if (on) targets.clear()
    Log.i(TAG, if (on) "uploading" else "uploads over")
    Keeper.setUploading(on)
    for (l in listeners) l(on)
    val ctx = app ?: return
    if (on) {
      if (Keeper.inForeground) UploadService.start(ctx)
    } else {
      UploadService.stop(ctx)
    }
  }

  /** An Activity became visible while uploads go on: the service, if it was not started. */
  fun onForeground(ctx: Context) {
    if (active) UploadService.start(ctx)
  }

  /** The WebView sent a request; an upload's tells its source. Any thread. */
  fun noteRequest(path: String?) {
    val id = UploadPolicy.targetOf(path) ?: return
    main.post {
      if (active && targets.add(id)) app?.let { UploadService.refresh(it) }
    }
  }

  fun title(): String = UploadPolicy.title(targets.map { Links.nameOf(it) ?: "" })
}

class UploadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Started with startForegroundService: it must go to the foreground even to stop at once.
    try {
      startForeground(ID, notification(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } catch (e: Exception) {
      Log.w(TAG, "not in the foreground", e)
      Uploads.state.started()
      stopSelf(startId)
      return START_NOT_STICKY
    }
    Uploads.state.started()
    running = true
    // Uploads that ended while this start was on its way: stopped here, now that it may be.
    // With startId, a later start still on its way keeps it.
    if (!Uploads.active) stopSelf(startId)
    return START_NOT_STICKY
  }

  // Android 15 caps dataSync services at 6 hours a day.
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val TAG = "MPfyUploads"
    private const val ID = 2002
    private const val CHANNEL = "uploads"
    @Volatile private var running = false

    fun start(ctx: Context) {
      Uploads.state.starting()
      try {
        ContextCompat.startForegroundService(ctx, Intent(ctx, UploadService::class.java))
      } catch (e: Exception) {
        Uploads.state.started()
        Log.w(TAG, "upload service not started", e)
      }
    }

    /** A start still on its way is left to stop itself (onStartCommand). */
    fun stop(ctx: Context) {
      if (Uploads.state.mayStop) ctx.stopService(Intent(ctx, UploadService::class.java))
    }

    fun refresh(ctx: Context) {
      if (!running) return
      runCatching { ctx.getSystemService(NotificationManager::class.java).notify(ID, notification(ctx)) }
    }

    private fun notification(ctx: Context): Notification {
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.channel_uploads), NotificationManager.IMPORTANCE_LOW))
      }
      val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      return Notification.Builder(ctx, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_mpfy)
        .setContentTitle(Uploads.title())
        .setProgress(0, 0, true)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setContentIntent(open)
        .build()
    }
  }
}
