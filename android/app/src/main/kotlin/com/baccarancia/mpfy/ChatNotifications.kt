package com.baccarancia.mpfy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The Android side of the message notifications ([ChatNotifier]): "Notifiche dei messaggi" kept in
 * the app's SharedPreferences (chat_notify, "1" unless turned off), the channel "Messaggi" at
 * default importance (sound as the system says, no heads-up), created at the first notification,
 * and one notification per conversation (tag "chat"), opening the app on that chat (the extra
 * "chat") and keeping the conversation and the message it tells in its own extras, read back from
 * the tray to take it back once that message is gone. The PlaybackService owns the notifier and
 * hands it over here, so a change of the setting reaches it.
 */
object Chats : ChatNotes {
  private const val TAG = "MPfyChats"
  private const val PREFS = "mpfy"
  const val K_NOTIFY = "chat_notify"
  const val CHANNEL = "messages"
  private val main = Handler(Looper.getMainLooper())
  private var app: Context? = null

  /** The notifier of the running PlaybackService, or null. Main thread. */
  var notifier: ChatNotifier? = null

  fun init(ctx: Context) {
    app = ctx.applicationContext
  }

  private fun prefs() = app?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** "Notifiche dei messaggi": on unless turned off. Any thread. */
  fun enabled(): Boolean = prefs()?.getString(K_NOTIFY, "1") != "0"

  /** Turns it on or off; the notifier follows at once. Any thread. */
  fun setEnabled(on: Boolean) {
    prefs()?.edit()?.putString(K_NOTIFY, if (on) "1" else "0")?.apply()
    main.post { notifier?.update() }
  }

  /** The system lets the app notify (the person's yes, asked once when downloads or uploads start). */
  fun allowed(): Boolean = app?.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true

  /** The page opened that conversation: its notification goes. Any thread. */
  fun seen(cid: String) = ChatNote.seen(this, cid)

  override fun show(note: ChatNote) {
    val ctx = app ?: return
    try {
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_DEFAULT))
      }
      val open = Intent(ctx, MainActivity::class.java)
        .putExtra(ChatNote.EXTRA, note.cid)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val pending = PendingIntent.getActivity(ctx, note.id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val b = Notification.Builder(ctx, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_mpfy)
        .setContentTitle(note.title)
        .setContentText(note.text)
        .setNumber(note.number)
        .setAutoCancel(true)
        .setContentIntent(pending)
        .setCategory(Notification.CATEGORY_MESSAGE)
        // What it tells, for the reads that follow (ChatNote.stale): taken back once that message is gone.
        .addExtras(
          Bundle().apply {
            putString(ChatNote.X_CHAT, note.cid)
            note.msg?.let { putString(ChatNote.X_MSG, it) }
          },
        )
      note.subText?.let { b.setSubText(it) }
      nm.notify(note.tag, note.id, b.build())
    } catch (e: RuntimeException) {
      Log.w(TAG, "message notification", e)
    }
  }

  override fun cancel(tag: String, id: Int) {
    val ctx = app ?: return
    runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(tag, id) }
  }

  /** The tray itself says what each message notification tells: it outlives the service and the app. */
  override fun shown(): List<ChatShown> {
    val ctx = app ?: return emptyList()
    return try {
      ctx.getSystemService(NotificationManager::class.java).activeNotifications
        .filter { it.tag == ChatNote.TAG }
        .map { ChatShown(it.id, it.notification.extras.getString(ChatNote.X_CHAT), it.notification.extras.getString(ChatNote.X_MSG)) }
    } catch (e: RuntimeException) {
      emptyList()
    }
  }
}
