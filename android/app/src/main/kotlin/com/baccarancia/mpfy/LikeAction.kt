package com.baccarancia.mpfy

import java.io.IOException

/** One request to the core with the app's token: the HTTP status; IOException when nothing answered. */
fun interface CoreRequests {
  fun send(method: String, url: String, timeoutMs: Int): Int
}

/** What a heart tap changes once the source said yes, and who hears about it. */
interface LikeEffects {
  /** Every queue item of [id] takes the new state (as setLiked from the page would). */
  fun setLiked(id: String, liked: Boolean, likedIds: List<String>)

  /** The car's snapshot changed: written to disk. */
  fun snapshotChanged(s: Snapshot)

  fun childrenChanged(parentId: String)

  /** The page hears the outcome (or, with no page, a failure is said with a toast). */
  fun told(id: String, liked: Boolean, likedIds: List<String>, ok: Boolean, wasLiked: Boolean)
}

/**
 * The heart of the notification, the lock screen and the car, where the person's data lives (the
 * home: the principal source, or the phone's own store, "0000", until its data moved there), with
 * the group semantics of the page: a like is one PUT of the song's group id, an unlike a DELETE of
 * each member that is liked. Success only when every answer is 2xx; otherwise nothing changes. The
 * home is read here, after the gate waited for the core's list (a process just started by a media
 * button has none yet). Blocking: run it off the main thread.
 */
class LikeAction(
  private val gate: CoreGate,
  private val http: CoreRequests,
  private val browse: BrowseState,
  private val effects: LikeEffects,
  private val origin: String = ORIGIN,
) {
  fun toggle(groupId: String, liked: Boolean, likedIds: List<String>): Boolean {
    val home = if (Levels.isId(groupId)) gate.home() else null
    val ok = home != null && Levels.isId(home) && send(groupId, liked, likedIds, home)
    if (!ok) {
      effects.told(groupId, liked, likedIds, false, liked)
      return false
    }
    val nowLiked = !liked
    val nowIds = if (nowLiked) listOf(groupId) else emptyList()
    effects.setLiked(groupId, nowLiked, nowIds)
    browse.likeDone(groupId, nowLiked, nowIds)?.let { effects.snapshotChanged(it) }
    effects.childrenChanged("cat:liked")
    effects.told(groupId, nowLiked, nowIds, true, liked)
    return true
  }

  private fun send(groupId: String, liked: Boolean, likedIds: List<String>, home: String): Boolean {
    val calls = if (!liked) listOf("PUT" to groupId) else likedIds.filter { Levels.isId(it) }.ifEmpty { listOf(groupId) }.map { "DELETE" to it }
    return try {
      gate.use("like:$groupId", home) { _ ->
        calls.all { (method, id) -> http.send(method, "$origin/s/$home/api/likes/$id", TIMEOUT_MS) in 200..299 }
      }
    } catch (e: IOException) {
      false
    }
  }

  companion object {
    const val TIMEOUT_MS = 10_000
  }
}

/**
 * Which commands a controller gets. Media3 trusts a controller only when it holds a system
 * permission or notification access, so a verified Android Auto would only browse: it gets the full
 * sets anyway, like the media notification and trusted controllers. Everyone else gets the
 * untrusted player commands, no library and no heart: the library is the person's own, like the
 * core's, which answers only this app.
 */
object Controllers {
  enum class Access { FULL, UNTRUSTED }

  data class Grant(val access: Access, val like: Boolean)

  /** Android Auto on the phone, or the car's own media app; Media3 tells both by package name, and the second means a car only on a car. */
  fun isCar(autoCompanion: Boolean, automotiveName: Boolean, automotive: Boolean) = autoCompanion || (automotiveName && automotive)

  /**
   * The controller's package name is its own. Media3 proves it on its own connections, but not for
   * a platform controller before Android 13, which is how Android Auto sends play, pause and the
   * heart: there the uid the system reports must own the name.
   */
  fun verified(mediaVerified: Boolean, packageName: String, uidPackages: Array<String>?) =
    mediaVerified || uidPackages?.contains(packageName) == true

  fun commandsFor(auto: Boolean, verified: Boolean, trusted: Boolean, notification: Boolean): Grant =
    if ((auto && verified) || notification || trusted) Grant(Access.FULL, true) else Grant(Access.UNTRUSTED, false)
}
