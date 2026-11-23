package com.baccarancia.mpfy

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The message notifications (bridge 6): when the notifier runs, what it tells, what it never tells. */
class ChatsTest {
  private val giulia = "ab25e6e72ec668e6e39fbbb7ff239a74"
  private val group = "cac44b906c75b7bce7fd9f8b78224c35"
  private val muted = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

  private fun conv(id: String, lastId: String?, unread: Int, mine: Boolean = false, isMuted: Boolean = false, kind: String = "direct", name: String = "Giulia \u00b7 MZ0Y", at: Long = 1763380060000L): String {
    val last = if (lastId == null) "null" else Json.write(linkedMapOf("id" to lastId, "from" to "a7c1e0d2b3f4051627384950a1b2c3d4", "name" to name, "mine" to mine, "at" to at, "t" to "text", "text" to "ciao", "state" to "sent", "preview" to "stasera?"))
    val group = if (kind == "group") "\"Mi A2\"" else "null"
    return """{"id":"$id","kind":"$kind","with":null,"name":$group,"display":"x","sources":[],"ids":["$id"],"last":$last,"unread":$unread,"muted":$isMuted,"mutedUntil":null,"at":1}"""
  }

  private fun answer(vararg convs: String) = """{"supported":true,"v":"1","unread":0,"conversations":[${convs.joinToString(",")}]}"""

  private fun src(name: String): String {
    val dir = listOf(File("src/main/kotlin"), File("app/src/main/kotlin")).first { it.isDirectory }
    return File(dir, "com/baccarancia/mpfy/$name").readText()
  }

  @Test
  fun theBridgeSaysSixOrLaterAndTheServiceAsksWhilePlaying() {
    val bridge = src("MPfyBridge.kt")
    assertTrue(Regex("""fun bridgeVersion\(\): String = "7"""").containsMatchIn(bridge))
    for (m in listOf("fun getChatNotify(): String", "fun setChatNotify(value: String): String", "fun chatSeen(cid: String)")) assertTrue(m, bridge.contains(m))
    assertTrue(bridge.contains("Chats.seen(cid)"))
    val service = src("PlaybackService.kt")
    assertTrue(service.contains("if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) chats.update()"))
    assertTrue(service.contains("ChatPolicy.active(Keeper.inForeground, session?.player?.isPlaying == true, Chats.enabled(), Chats.allowed())"))
    assertTrue(service.contains("chats.stop()"))
    val res = listOf(File("src/main/res/values/strings.xml"), File("app/src/main/res/values/strings.xml")).first { it.isFile }.readText()
    assertTrue(res.contains("<string name=\"channel_messages\">Messaggi</string>"))
    // The channel at default importance, created at the first notification; tag "chat".
    val notes = src("ChatNotifications.kt")
    assertTrue(notes.contains("NotificationChannel(CHANNEL, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_DEFAULT)"))
    assertTrue(notes.contains("nm.notify(note.tag, note.id, b.build())"))
    assertTrue(notes.contains(".setNumber(note.number)") && notes.contains(".setAutoCancel(true)") && notes.contains("R.drawable.ic_stat_mpfy"))
    assertTrue(notes.contains(".putExtra(ChatNote.EXTRA, note.cid)"))
    assertTrue(notes.contains("getString(K_NOTIFY, \"1\") != \"0\""))
    // What each notification tells, kept with it and read back from the tray.
    assertTrue(notes.contains("putString(ChatNote.X_CHAT, note.cid)") && notes.contains("note.msg?.let { putString(ChatNote.X_MSG, it) }"))
    assertTrue(notes.contains(".activeNotifications") && notes.contains(".filter { it.tag == ChatNote.TAG }"))
    assertTrue(notes.contains("it.notification.extras.getString(ChatNote.X_CHAT), it.notification.extras.getString(ChatNote.X_MSG)"))
  }

  @Test
  fun itRunsOnlyInTheBackgroundWhilePlayingTurnedOnAndAllowed() {
    assertTrue(ChatPolicy.active(inForeground = false, playing = true, enabled = true, allowed = true))
    assertFalse(ChatPolicy.active(inForeground = true, playing = true, enabled = true, allowed = true))
    assertFalse(ChatPolicy.active(inForeground = false, playing = false, enabled = true, allowed = true))
    assertFalse(ChatPolicy.active(inForeground = false, playing = true, enabled = false, allowed = true))
    assertFalse(ChatPolicy.active(inForeground = false, playing = true, enabled = true, allowed = false))
  }

  @Test
  fun theListReadsTheCoresAnswer() {
    val list = ChatConv.list(answer(conv(giulia, "11".repeat(16), 2), conv(group, null, 0, kind = "group")))!!
    assertEquals(2, list.size)
    assertEquals(ChatConv(giulia, null, 2, false, "11".repeat(16), false, "Giulia \u00b7 MZ0Y", "stasera?", 1763380060000L), list[0])
    assertEquals("Mi A2", list[1].group)
    assertNull(list[1].lastId)
    assertNull(ChatConv.list("not json"))
    assertEquals(0, ChatConv.list("""{"conversations":[{"id":"short"}]}""")!!.size)
  }

  @Test
  fun theFirstReadOnlyLearnsThenNewMessagesFromOthersNotify() {
    val w = ChatWatch()
    val a = "aa".repeat(16)
    val b = "bb".repeat(16)
    // Known at start: nothing is told, however unread.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, a, 3), conv(muted, a, 4, isMuted = true)))!!))
    // The same last message again: old, nothing.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, a, 3)))!!))
    // A new one from her: told, once.
    assertEquals(listOf(giulia), w.next(ChatConv.list(answer(conv(giulia, b, 4)))!!).map { it.id })
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, b, 4)))!!))
    // Silenced, yours, or read already: never.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(muted, b, 5, isMuted = true)))!!))
    // Yours (written on another device), even with older ones of hers still unread.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, "cc".repeat(16), 2, mine = true)))!!))
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, "dd".repeat(16), 0)))!!))
    // A conversation that was not there at the start: its first message is new.
    assertEquals(listOf(group), w.next(ChatConv.list(answer(conv(group, a, 1, kind = "group", name = "Marco")))!!).map { it.id })
  }

  @Test
  fun aMessageDeletedForEveryoneNeverNotifiesTheOneBeforeIt() {
    val w = ChatWatch()
    val a = "aa".repeat(16)
    val b = "bb".repeat(16)
    val c = "cc".repeat(16)
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, a, 1, at = 1000L)))!!))
    assertEquals(listOf(giulia), w.next(ChatConv.list(answer(conv(giulia, b, 2, at = 2000L)))!!).map { it.id })
    // Her newest deleted for everyone: the last is her older one again, still unread. Nothing new.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(giulia, a, 1, at = 1000L)))!!))
    // Then a new one: told.
    assertEquals(listOf(giulia), w.next(ChatConv.list(answer(conv(giulia, c, 2, at = 3000L)))!!).map { it.id })
    // A group emptied by deletions, then written to again.
    assertEquals(emptyList<ChatConv>(), w.next(ChatConv.list(answer(conv(group, null, 0, kind = "group")))!!))
    assertEquals(listOf(group), w.next(ChatConv.list(answer(conv(group, a, 1, kind = "group", at = 500L)))!!).map { it.id })
  }

  /** A tray: what the notifier shows and takes back, by id, with what each one tells. */
  private class Tray : ChatNotes {
    val now = LinkedHashMap<Int, ChatShown>()
    val log = ArrayList<String>()

    override fun show(note: ChatNote) {
      now[note.id] = ChatShown(note.id, note.cid, note.msg)
      log.add("show ${note.cid.take(4)} ${note.msg?.take(4)}")
    }

    override fun cancel(tag: String, id: Int) {
      if (now.remove(id) != null) log.add("cancel $tag ${"%08x".format(id).take(4)}")
    }

    override fun shown(): List<ChatShown> = now.values.toList()
  }

  @Test
  fun aNotificationWhoseMessageIsDeletedForEveryoneIsTakenBack() {
    val tray = Tray()
    val answers = ArrayDeque<String>()
    val timers = ArrayList<Runnable>()
    var on = true
    val notifier = ChatNotifier(
      http = CoreJson { _, _, _, _ -> 200 to answers.removeFirst() },
      awake = AwakeCall(HoldLog(ArrayList()), StubCore(), { 0L }, { }),
      worker = { it.run() },
      main = { it.run() },
      later = { r, _ -> timers.add(r) },
      cancel = { r -> timers.remove(r) },
      notes = tray,
      conditions = { on },
      origin = "http://core",
    )
    val read = { a: String ->
      answers.add(a)
      timers.removeAt(0).run()
    }
    val a = "aa".repeat(16)
    val b = "bb".repeat(16)
    val c = "cc".repeat(16)
    answers.add(answer(conv(giulia, a, 0, at = 1000L), conv(group, a, 0, kind = "group", at = 1000L)))
    notifier.update()
    // Her new message: told.
    read(answer(conv(giulia, b, 1, at = 2000L), conv(group, a, 0, kind = "group", at = 1000L)))
    assertEquals(listOf("show ab25 bbbb"), tray.log)
    // Deleted for everyone: the notification goes, nothing else is told.
    read(answer(conv(giulia, a, 0, at = 1000L), conv(group, a, 0, kind = "group", at = 1000L)))
    assertEquals(listOf("show ab25 bbbb", "cancel chat ab25"), tray.log)
    assertTrue(tray.now.isEmpty())
    // A newer one replaces the one it follows, taken back neither before nor after.
    read(answer(conv(giulia, b, 1, at = 2000L), conv(group, b, 1, kind = "group", name = "Marco", at = 2000L)))
    read(answer(conv(giulia, c, 2, at = 3000L), conv(group, b, 1, kind = "group", name = "Marco", at = 2000L)))
    assertEquals(listOf("show ab25 bbbb", "cancel chat ab25", "show ab25 bbbb", "show cac4 bbbb", "show ab25 cccc"), tray.log)
    assertEquals(setOf(ChatShown(ChatNote.idOf(giulia), giulia, c), ChatShown(ChatNote.idOf(group), group, b)), tray.now.values.toSet())
    // Her conversation gone from the list (every message of it deleted): its notification goes; the group's stays.
    read(answer(conv(group, b, 1, kind = "group", name = "Marco", at = 2000L)))
    assertEquals(setOf(ChatNote.idOf(group)), tray.now.keys)
    // Stopped (the app in front), the group's message deleted meanwhile: the first read after the
    // start takes it back. One whose conversation is not listed yet stays; one that does not say what
    // it tells stays.
    on = false
    timers.removeAt(0).run()
    assertFalse(notifier.active)
    tray.now[ChatNote.idOf(muted)] = ChatShown(ChatNote.idOf(muted), muted, a)
    tray.now[0x12345678] = ChatShown(0x12345678, null, null)
    on = true
    answers.add(answer(conv(group, a, 0, kind = "group", at = 1000L)))
    notifier.update()
    assertEquals(setOf(ChatNote.idOf(muted), 0x12345678), tray.now.keys)
  }

  @Test
  fun aNotificationPerConversationWithItsNumberAndItsChat() {
    val c = ChatConv.list(answer(conv(group, "aa".repeat(16), 7, kind = "group", name = "Marco")))!![0]
    val n = ChatNote.of(c)
    assertEquals("Nuovo messaggio da Marco", n.title)
    assertEquals("stasera?", n.text)
    assertEquals("Mi A2", n.subText)
    assertEquals(7, n.number)
    assertEquals("chat", n.tag)
    assertEquals("chat", ChatNote.EXTRA)
    assertEquals(group, n.cid)
    // The id: the conversation's first 8 hex as an Int (wrapping above 7fffffff).
    assertEquals(0xcac44b90L.toInt(), n.id)
    assertEquals(0x0f1e2d3c, ChatNote.idOf(muted))
    // A 1:1: no sub text.
    assertNull(ChatNote.of(ChatConv.list(answer(conv(giulia, "aa".repeat(16), 1)))!![0]).subText)
  }

  @Test
  fun chatSeenCancelsThatConversationsNotification() {
    val log = ArrayList<String>()
    val notes = object : ChatNotes {
      override fun show(note: ChatNote) {
        log.add("show ${note.id}")
      }

      override fun cancel(tag: String, id: Int) {
        log.add("cancel $tag $id")
      }
    }
    ChatNote.seen(notes, giulia)
    assertEquals(listOf("cancel chat ${0xab25e6e7L.toInt()}"), log)
  }

  @Test
  fun theNotifierAsksEveryTenSecondsHoldingTheWorkletAndStopsWhenAConditionFails() {
    val holds = ArrayList<String>()
    val shown = ArrayList<ChatNote>()
    val requests = ArrayList<String>()
    val answers = ArrayDeque(
      listOf(
        answer(conv(giulia, "aa".repeat(16), 2)),
        answer(conv(giulia, "bb".repeat(16), 3)),
        answer(conv(giulia, "bb".repeat(16), 3)),
      ),
    )
    val http = CoreJson { method, url, body, timeout ->
      requests.add("$method $url ${body ?: ""} $timeout")
      200 to answers.removeFirst()
    }
    val timers = ArrayList<Pair<Runnable, Long>>()
    var on = true
    val notifier = ChatNotifier(
      http = http,
      awake = AwakeCall(HoldLog(holds), StubCore(), { 0L }, { }),
      worker = { it.run() },
      main = { it.run() },
      later = { r, ms -> timers.add(r to ms) },
      cancel = { r -> timers.removeAll { it.first === r } },
      notes = object : ChatNotes {
        override fun show(note: ChatNote) {
          shown.add(note)
        }

        override fun cancel(tag: String, id: Int) {}
      },
      conditions = { on },
      origin = "http://core",
    )
    notifier.update()
    assertTrue(notifier.active)
    assertEquals(listOf("GET http://core/local/chat/conversations  8000"), requests)
    assertEquals(listOf("hold chat", "release chat"), holds)
    assertEquals(0, shown.size) // the start learns
    assertEquals(10_000L, timers.single().second)
    // Ten seconds later: a new message from her.
    timers.removeAt(0).first.run()
    assertEquals(1, shown.size)
    assertEquals(3, shown[0].number)
    assertEquals(10_000L, timers.single().second)
    // The same again: nothing more.
    timers.removeAt(0).first.run()
    assertEquals(1, shown.size)
    // The app comes to the front (a condition fails): it stops at the next beat, and update() too.
    on = false
    timers.removeAt(0).first.run()
    assertFalse(notifier.active)
    assertTrue(timers.isEmpty())
    assertEquals(3, requests.size)
  }

  @Test
  fun aCoreThatDoesNotAnswerTellsNothing() {
    val shown = ArrayList<ChatNote>()
    val http = CoreJson { _, _, _, _ -> throw IOException("away") }
    val notifier = ChatNotifier(
      http = http,
      awake = AwakeCall(HoldLog(ArrayList()), StubCore(), { 0L }, { }),
      worker = { it.run() },
      main = { it.run() },
      later = { _, _ -> },
      cancel = { },
      notes = object : ChatNotes {
        override fun show(note: ChatNote) {
          shown.add(note)
        }

        override fun cancel(tag: String, id: Int) {}
      },
      conditions = { true },
    )
    notifier.update()
    assertTrue(notifier.active)
    assertEquals(0, shown.size)
  }

  @Test
  fun aTappedNotificationOpensItsChat() {
    assertEquals(giulia, ChatLinks.cidOf(" $giulia "))
    assertNull(ChatLinks.cidOf("not-a-chat"))
    assertNull(ChatLinks.cidOf(null))
    assertEquals("http://127.0.0.1:47123/#chat=$giulia", ChatLinks.startUrl("http://127.0.0.1:47123", null, giulia))
    // A code to add goes first; the conversation follows once the page is there.
    assertEquals("http://127.0.0.1:47123/#aggiungi=MPFY-X", ChatLinks.startUrl("http://127.0.0.1:47123", "MPFY-X", giulia))
    assertEquals("http://127.0.0.1:47123/", ChatLinks.startUrl("http://127.0.0.1:47123", null, null))
    val activity = src("MainActivity.kt")
    assertTrue(activity.contains("evaluateJavascript(\"location.hash=\${JSONObject.quote(\"chat=\$cid\")}\", null)"))
  }
}
