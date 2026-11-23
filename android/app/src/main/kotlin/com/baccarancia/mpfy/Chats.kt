package com.baccarancia.mpfy

import java.io.IOException

/*
 * The message notifications (bridge 6). While no Activity is visible, the player plays,
 * "Notifiche dei messaggi" is on and the system lets the app notify, the conversation list of the
 * core is asked every 10 s (GET /local/chat/conversations, the worklet held with the tag "chat").
 * When it starts it takes each conversation's last message as known; afterwards a conversation
 * with unread messages, not silenced, whose last message is new and not yours, gets its
 * notification: one per conversation, replaced by the next. A message deleted for everyone tells
 * nothing new (the one before it is not new), and a notification whose message is no longer its
 * conversation's last one (deleted, or answered from another device), or whose conversation was
 * listed and is no more, is taken back at the next read. It stops as soon as one condition
 * fails. Nothing runs when MPfy does not: no push, no other service. Free of Android classes:
 * PlaybackService feeds it the player's state and draws the notifications ([ChatNotes]).
 */

/** One conversation as the list tells it: its id, a group's name, the unread count, silenced, its last message. */
data class ChatConv(
  val id: String,
  val group: String?,
  val unread: Int,
  val muted: Boolean,
  val lastId: String?,
  val lastMine: Boolean,
  val lastName: String,
  val lastPreview: String,
  val lastAt: Long = 0L,
) {
  /** Its last message comes after o's (by time, then id, as the core orders them). */
  fun lastAfter(o: ChatConv): Boolean = lastAt > o.lastAt || (lastAt == o.lastAt && (lastId ?: "") > (o.lastId ?: ""))

  companion object {
    private val HEX32 = Regex("^[0-9a-f]{32}$")

    /** The conversations of an answer of GET /local/chat/conversations, or null when it is not one. */
    fun list(json: String): List<ChatConv>? {
      val root = Json.obj(json) ?: return null
      val arr = root["conversations"] as? List<*> ?: return null
      return arr.mapNotNull { c ->
        val m = c as? Map<*, *> ?: return@mapNotNull null
        val id = m["id"] as? String ?: return@mapNotNull null
        if (!HEX32.matches(id)) return@mapNotNull null
        val last = m["last"] as? Map<*, *>
        ChatConv(
          id = id,
          group = if (m["kind"] == "group") (m["name"] as? String ?: m["display"] as? String ?: "") else null,
          unread = (m["unread"] as? Number)?.toInt() ?: 0,
          muted = m["muted"] == true,
          lastId = last?.get("id") as? String,
          lastMine = last?.get("mine") == true,
          lastName = last?.get("name") as? String ?: "",
          lastPreview = last?.get("preview") as? String ?: "",
          lastAt = (last?.get("at") as? Number)?.toLong() ?: 0L,
        )
      }
    }
  }
}

/**
 * What a notification shows: tag "chat", the id of the conversation, its texts and the extra "chat";
 * msg the message it tells (kept with it, so a later read knows when that message is gone).
 */
data class ChatNote(val cid: String, val title: String, val text: String, val subText: String?, val number: Int, val msg: String? = null) {
  val tag: String get() = TAG
  val id: Int get() = idOf(cid)

  companion object {
    const val TAG = "chat"
    const val EXTRA = "chat"

    /** The extras a notification keeps of what it tells: its conversation and its message. */
    const val X_CHAT = "mpfy.chat"
    const val X_MSG = "mpfy.msg"

    /** The notification of a conversation: the first 8 hex of its id as an Int. */
    fun idOf(cid: String): Int = cid.take(8).toLong(16).toInt()

    /** "Nuovo messaggio da <nome>", the preview, a group's name under it, the unread count. */
    fun of(c: ChatConv): ChatNote = ChatNote(c.id, "Nuovo messaggio da ${c.lastName}", c.lastPreview, c.group?.takeIf { it.isNotEmpty() }, c.unread, c.lastId)

    /** The page opened conversation cid: its notification goes. */
    fun seen(notes: ChatNotes, cid: String) = notes.cancel(TAG, idOf(cid))

    /**
     * The notifications to take back after a read (their ids): one whose message is no longer the
     * last of its conversation (deleted for everyone, or answered from another device), or whose
     * conversation was listed since the start ([listed]) and is not any more (its messages all
     * deleted, the person removed). One a newer message replaces now stays, and so does one that
     * does not say what it tells (made by an earlier version) or whose conversation was not listed
     * yet (the core may still be reading it).
     */
    fun stale(shown: List<ChatShown>, list: List<ChatConv>, fresh: List<ChatConv>, listed: (String) -> Boolean): List<Int> {
      val replaced = fresh.map { idOf(it.id) }.toSet()
      val byId = list.associateBy { it.id }
      return shown.filter { s ->
        val cid = s.cid
        val now = if (cid == null) null else byId[cid]
        when {
          s.id in replaced || cid == null -> false
          now == null -> listed(cid)
          else -> s.msg != null && now.lastId != s.msg
        }
      }.map { it.id }
    }
  }
}

/** A notification in the tray now: its id, its conversation and the message it tells (null when it does not say). */
data class ChatShown(val id: Int, val cid: String?, val msg: String?)

/** Shows and takes back the notifications (the Android side, or a fake in the tests). */
interface ChatNotes {
  fun show(note: ChatNote)

  fun cancel(tag: String, id: Int)

  /** The message notifications in the tray now. */
  fun shown(): List<ChatShown> = emptyList()
}

/** When the notifier runs: in the background, playing, turned on, and allowed by the system. */
object ChatPolicy {
  fun active(inForeground: Boolean, playing: Boolean, enabled: Boolean, allowed: Boolean): Boolean = !inForeground && playing && enabled && allowed
}

/** The last message known of each conversation: what is new since the list was first read. */
class ChatWatch {
  private var known: MutableMap<String, ChatConv>? = null

  val started: Boolean get() = known != null

  /** Whether conversation cid was in a list read since the start. */
  fun listed(cid: String): Boolean = known?.containsKey(cid) == true

  /** The conversations to notify now (none at the first read, which only learns what is there). */
  fun next(list: List<ChatConv>): List<ChatConv> {
    val k = known
    if (k == null) {
      known = list.associateBy { it.id }.toMutableMap()
      return emptyList()
    }
    val out = ArrayList<ChatConv>()
    for (c in list) {
      val was = k[c.id]
      k[c.id] = c
      if (c.lastId == null || c.lastId == was?.lastId) continue
      // A last message older than the one known: the newer ones were deleted, nothing is new.
      if (was?.lastId != null && !c.lastAfter(was)) continue
      if (c.unread > 0 && !c.muted && !c.lastMine) out.add(c)
    }
    return out
  }

  fun reset() {
    known = null
  }
}

/**
 * Asks the core every [everyMs] while [conditions] hold. [update] (main thread) after any change of
 * them; [worker] runs the request off the main thread, [main] brings the answer back to it.
 */
class ChatNotifier(
  private val http: CoreJson,
  private val awake: AwakeCall,
  private val worker: (Runnable) -> Unit,
  private val main: (Runnable) -> Unit,
  private val later: (Runnable, Long) -> Unit,
  private val cancel: (Runnable) -> Unit,
  private val notes: ChatNotes,
  private val conditions: () -> Boolean,
  private val origin: String = ORIGIN,
  private val everyMs: Long = EVERY_MS,
) {
  private val watch = ChatWatch()
  private var running = false
  private var asking = false

  private val beat: Runnable = object : Runnable {
    override fun run() {
      if (!running) return
      if (!conditions()) {
        stop()
        return
      }
      ask()
      later(this, everyMs)
    }
  }

  /** The conditions may have changed: starts (at once) or stops. Main thread. */
  fun update() {
    val want = conditions()
    if (want == running) return
    if (want) {
      running = true
      watch.reset()
      ask()
      later(beat, everyMs)
    } else {
      stop()
    }
  }

  /** Stops asking; the next start learns the conversations again. Main thread. */
  fun stop() {
    running = false
    cancel(beat)
    watch.reset()
  }

  val active: Boolean get() = running

  private fun ask() {
    if (asking) return
    asking = true
    worker(
      Runnable {
        val answer = try {
          awake.run(TAG) { ready -> if (ready) http.json("GET", "$origin/local/chat/conversations", null, TIMEOUT_MS) else null }
        } catch (e: IOException) {
          null
        } catch (e: RuntimeException) {
          null
        }
        main(
          Runnable {
            asking = false
            if (!running || answer == null || answer.first != 200) return@Runnable
            val list = ChatConv.list(answer.second) ?: return@Runnable
            val fresh = watch.next(list)
            for (id in ChatNote.stale(notes.shown(), list, fresh, watch::listed)) notes.cancel(ChatNote.TAG, id)
            for (c in fresh) notes.show(ChatNote.of(c))
          },
        )
      },
    )
  }

  companion object {
    const val TAG = "chat"
    const val EVERY_MS = 10_000L
    const val TIMEOUT_MS = 8_000
  }
}

/** The page's address for the conversation of a tapped notification. */
object ChatLinks {
  private val CID = Regex("^[0-9a-f]{32}$")

  /** The conversation id of an intent's extra, or null when it is not one. */
  fun cidOf(extra: String?): String? = extra?.trim()?.takeIf { CID.matches(it) }

  /** The first address of the page: a code to add (encoded) first, else a conversation, else Home. */
  fun startUrl(origin: String, encodedCode: String?, cid: String?): String = when {
    encodedCode != null -> "$origin/#aggiungi=$encodedCode"
    cid != null -> "$origin/#chat=$cid"
    else -> "$origin/"
  }
}
