package com.baccarancia.mpfy

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Holds and waits like CoreHost.gate, writing down the order of everything. */
private class FakeGate(private val log: MutableList<String>, private val principal: String? = Fixture.SRC_A) : CoreGate {
  override fun isSource(sourceId: String) = true

  override fun principal() = principal

  override fun <T> use(tag: String, sourceId: String, block: (up: Boolean) -> T): T {
    log.add("hold $tag")
    log.add("wait $sourceId")
    try {
      return block(true)
    } finally {
      log.add("release $tag")
    }
  }
}

private class FakeEffects(private val log: MutableList<String>) : LikeEffects {
  val told = ArrayList<String>()
  var written: Snapshot? = null

  override fun setLiked(id: String, liked: Boolean, likedIds: List<String>) {
    log.add("setLiked $id $liked $likedIds")
  }

  override fun snapshotChanged(s: Snapshot) {
    written = s
    log.add("written")
  }

  override fun childrenChanged(parentId: String) {
    log.add("children $parentId")
  }

  override fun told(id: String, liked: Boolean, likedIds: List<String>, ok: Boolean, wasLiked: Boolean) {
    told.add("$id $liked $likedIds $ok")
  }
}

class LikeActionTest {
  private val log = ArrayList<String>()
  private val statuses = ArrayList<Int>()
  private val http = CoreRequests { method, url, timeoutMs ->
    log.add("$method $url $timeoutMs")
    if (statuses.isEmpty()) 200 else statuses.removeAt(0)
  }
  private val browse = BrowseState().also { it.replace(Fixture.parsed()) }
  private val effects = FakeEffects(log)
  private val action = LikeAction(FakeGate(log), http, browse, effects, origin = "http://core")
  private val p = Fixture.SRC_A
  private val g = Fixture.t(2)

  @Test
  fun aLikeIsOnePutOfTheGroupIdOnThePrincipal() {
    assertTrue(action.toggle(g, false, emptyList()))
    assertEquals("PUT http://core/s/$p/api/likes/$g 10000", log.first { it.startsWith("PUT") })
    assertEquals(1, log.count { it.startsWith("PUT") || it.startsWith("DELETE") })
    assertEquals(listOf("$g true [$g] true"), effects.told)
    assertEquals(listOf(g), browse.likedOf(g))
  }

  @Test
  fun anUnlikeIsADeletePerLikedMemberOrOfTheGroupIdWhenNoneIsNamed() {
    val a = Fixture.t(1)
    val b = Fixture.t(11)
    assertTrue(action.toggle(a, true, listOf(a, b)))
    assertEquals(listOf("DELETE http://core/s/$p/api/likes/$a 10000", "DELETE http://core/s/$p/api/likes/$b 10000"), log.filter { it.startsWith("DELETE") })
    assertEquals(listOf("$a false [] true"), effects.told)
    log.clear()
    assertTrue(action.toggle(g, true, emptyList()))
    assertEquals(listOf("DELETE http://core/s/$p/api/likes/$g 10000"), log.filter { it.startsWith("DELETE") })
  }

  @Test
  fun successOnlyWhenEveryAnswerIs2xx() {
    val a = Fixture.t(1)
    statuses.addAll(listOf(204, 502))
    assertFalse(action.toggle(a, true, listOf(a, Fixture.t(11))))
    assertEquals(listOf("$a true [$a, ${Fixture.t(11)}] false"), effects.told)
    // Nothing changed anywhere.
    assertEquals(listOf(a, Fixture.t(11)), browse.likedOf(a))
    assertTrue(log.none { it.startsWith("setLiked") || it.startsWith("children") || it == "written" })
    statuses.add(404)
    assertFalse(action.toggle(g, false, emptyList()))
    assertEquals(null, browse.likedOf(g))
  }

  @Test
  fun noAnswerOrNoPrincipalIsAFailure() {
    val dead = LikeAction(FakeGate(log), { _, _, _ -> throw IOException("refused") }, browse, effects, origin = "http://core")
    assertFalse(dead.toggle(g, false, emptyList()))
    assertFalse(LikeAction(FakeGate(log, principal = null), http, browse, effects, origin = "http://core").toggle(g, false, emptyList()))
    assertEquals(listOf("$g false [] false", "$g false [] false"), effects.told)
    // No principal: nothing is sent and nothing is held.
    assertEquals(listOf("hold like:$g", "wait $p", "release like:$g"), log)
  }

  @Test
  fun aTapBeforeTheCoreListedItsSourcesWaitsForThePrincipal() {
    // A process a media button just started: the core has not said which source is the principal.
    val core = StubCore().apply {
      listed = false
      sources += p
      up += p
    }
    val time = FakeTime()
    time.at(time.now + 2_000) {
      core.listed = true
      core.principal = p
    }
    val gate = HeldGate(HoldLog(log), core, { time.now }, { time.sleep(it) })
    assertTrue(LikeAction(gate, http, browse, effects, origin = "http://core").toggle(g, false, emptyList()))
    assertEquals(listOf("hold like:$g", "PUT http://core/s/$p/api/likes/$g 10000", "release like:$g"), log.filter { !it.startsWith("setLiked") && it != "written" && !it.startsWith("children") })
  }

  @Test
  fun theCoreIsHeldBeforeTheFirstRequestAndReleasedAfterTheLast() {
    val a = Fixture.t(1)
    assertTrue(action.toggle(a, true, listOf(a, Fixture.t(11))))
    val hold = log.indexOf("hold like:$a")
    val wait = log.indexOf("wait $p")
    val first = log.indexOfFirst { it.startsWith("DELETE") }
    val last = log.indexOfLast { it.startsWith("DELETE") }
    val release = log.indexOf("release like:$a")
    assertTrue(log.toString(), hold in 0 until wait && wait < first && last < release)
  }

  @Test
  fun aSuccessUpdatesTheQueueTheLikedListOnDiskAndTheCarsLikedTab() {
    val s4 = Fixture.t(4)
    assertTrue(action.toggle(s4, false, emptyList()))
    assertTrue(log.contains("setLiked $s4 true [$s4]"))
    assertEquals(listOf(s4, Fixture.t(3), Fixture.t(1)), effects.written!!.liked.map { it.id })
    assertEquals(effects.written, browse.snapshot)
    assertTrue(log.indexOf("written") < log.indexOf("children cat:liked"))
    assertTrue(action.toggle(s4, true, listOf(s4)))
    assertEquals(listOf(Fixture.t(3), Fixture.t(1)), effects.written!!.liked.map { it.id })
    assertEquals(2, log.count { it == "children cat:liked" })
  }
}

/** The core as CoreHost reports it: what Links holds. */
internal class LinksCore : CoreState {
  override val listening = true
  override val awakeSince: Long? = 0L
  override val listed: Boolean get() = Links.listed
  override val principal: String? get() = Links.principal
  override val home: String? get() = Links.home

  override fun isSource(sourceId: String) = Links.isSource(sourceId)

  override fun isUp(sourceId: String) = Links.isUp(sourceId)
}

/** The heart goes where the person's data lives: the principal, or the phone's own store before a move. */
class HomeHeartTest {
  private val log = ArrayList<String>()
  private val sent = ArrayList<String>()
  private val http = CoreRequests { method, url, _ ->
    sent.add("$method $url")
    204
  }
  private val browse = BrowseState().also { it.replace(Fixture.parsed()) }
  private val effects = FakeEffects(log)
  private val g = Fixture.t(2)
  private val time = FakeTime()
  private val gate = HeldGate(HoldLog(log), LinksCore(), { time.now }, { time.sleep(it) })

  @Test
  fun withThePhonesStoreAsTheHomeTheHeartGoesToItsAddress() {
    // A principal is there, but the phone's store still holds the person's data (the move is due).
    Links.update(listOf(Links.Source(Fixture.SRC_A, "A", true)), Fixture.SRC_A, LocalSource.ID)
    assertEquals(LocalSource.ID, gate.home())
    assertEquals(Fixture.SRC_A, gate.principal())
    // The core answers that address itself: the gate does not wait for any link.
    assertTrue(gate.use("like:$g", LocalSource.ID) { up -> up })
    assertTrue(LikeAction(gate, http, browse, effects, origin = "http://core").toggle(g, false, emptyList()))
    assertEquals(listOf("PUT http://core/s/0000/api/likes/$g"), sent)
  }

  @Test
  fun withARealHomeTheHeartGoesThere() {
    Links.update(listOf(Links.Source(Fixture.SRC_A, "A", true), Links.Source(Fixture.SRC_B, "B", true)), Fixture.SRC_B, Fixture.SRC_B)
    assertEquals(Fixture.SRC_B, gate.home())
    assertTrue(LikeAction(gate, http, browse, effects, origin = "http://core").toggle(g, false, emptyList()))
    assertEquals(listOf("PUT http://core/s/${Fixture.SRC_B}/api/likes/$g"), sent)
  }

  @Test
  fun aCoreThatNamesNoHomeKeepsThePrincipal() {
    Links.update(listOf(Links.Source(Fixture.SRC_A, "A", true)), Fixture.SRC_A)
    assertEquals(Fixture.SRC_A, gate.home())
    // A home that is none of the core's sources is none.
    Links.update(listOf(Links.Source(Fixture.SRC_A, "A", true)), Fixture.SRC_A, "deadbeef")
    assertEquals(null, gate.home())
  }
}

class ControllersTest {
  private fun grant(auto: Boolean = false, verified: Boolean = false, trusted: Boolean = false, notification: Boolean = false) =
    Controllers.commandsFor(auto, verified, trusted, notification)

  @Test
  fun aVerifiedAndroidAutoGetsEverythingAndTheHeartEvenUntrusted() {
    assertEquals(Controllers.Grant(Controllers.Access.FULL, true), grant(auto = true, verified = true, trusted = false))
  }

  @Test
  fun anUnverifiedControllerWithAutosNameGetsTheUntrustedSets() {
    assertEquals(Controllers.Grant(Controllers.Access.UNTRUSTED, false), grant(auto = true, verified = false))
  }

  @Test
  fun theNotificationAndTrustedControllersGetTheDefaultsAndTheHeart() {
    assertEquals(Controllers.Grant(Controllers.Access.FULL, true), grant(notification = true))
    assertEquals(Controllers.Grant(Controllers.Access.FULL, true), grant(trusted = true))
    assertEquals(Controllers.Grant(Controllers.Access.FULL, true), grant(trusted = true, verified = true))
  }

  @Test
  fun aPlatformControllerIsVerifiedWhenTheUidTheSystemReportsOwnsItsName() {
    val auto = "com.google.android.projection.gearhead"
    assertTrue(Controllers.verified(true, auto, null))
    assertTrue(Controllers.verified(false, auto, arrayOf(auto)))
    assertTrue(Controllers.verified(false, auto, arrayOf("com.example.shared", auto)))
    assertFalse(Controllers.verified(false, auto, arrayOf("com.example.other")))
    assertFalse(Controllers.verified(false, auto, null))
    // So Android Auto's own controller plays and likes on Android 10 to 12, where Media3 proves nothing for it.
    assertEquals(Controllers.Grant(Controllers.Access.FULL, true), grant(auto = true, verified = Controllers.verified(false, auto, arrayOf(auto))))
    assertEquals(Controllers.Grant(Controllers.Access.UNTRUSTED, false), grant(auto = true, verified = Controllers.verified(false, auto, arrayOf("com.example.other"))))
  }

  @Test
  fun theCarsOwnMediaAppCountsOnlyOnACar() {
    assertTrue(Controllers.isCar(autoCompanion = true, automotiveName = false, automotive = false))
    assertTrue(Controllers.isCar(autoCompanion = false, automotiveName = true, automotive = true))
    assertFalse(Controllers.isCar(autoCompanion = false, automotiveName = true, automotive = false))
    assertFalse(Controllers.isCar(autoCompanion = false, automotiveName = false, automotive = true))
  }

  @Test
  fun everyOtherControllerGetsTheUntrustedSets() {
    assertEquals(Controllers.Grant(Controllers.Access.UNTRUSTED, false), grant())
    assertEquals(Controllers.Grant(Controllers.Access.UNTRUSTED, false), grant(verified = true))
  }
}

class QueueOwnerTest {
  private var n = 0
  private val owner = QueueOwner { "n" + "%015x".format(++n) }

  @Test
  fun thePagesQueueIdIsKept() {
    owner.pageSet("0123456789abcdef")
    assertEquals("0123456789abcdef", owner.idFor(3))
    // A list it took over keeps that name when the page sends it back.
    owner.pageSet("n00000000000007f")
    assertEquals("n00000000000007f", owner.idFor(3))
    owner.pageSet("not an id")
    assertEquals(null, owner.idFor(3))
  }

  @Test
  fun aQueueSetByAControllerGetsANewNId() {
    owner.pageSet("0123456789abcdef")
    val a = owner.otherSet()
    assertTrue(Regex("n[0-9a-f]{15}").matches(a))
    assertEquals(a, owner.idFor(1))
    assertTrue(owner.otherSet() != a)
    assertTrue(Regex("n[0-9a-f]{15}").matches(QueueOwner.randomForeignId()))
  }

  @Test
  fun anEmptyPlayerHasNoQueueId() {
    owner.pageSet("0123456789abcdef")
    assertEquals(null, owner.idFor(0))
    owner.otherSet()
    assertEquals(null, owner.idFor(0))
    assertEquals(null, QueueOwner().idFor(5))
  }
}
