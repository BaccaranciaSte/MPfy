package com.baccarancia.mpfy

import java.security.SecureRandom

/**
 * Who set the list the player holds. The page names its lists (16 hex) and keeps the name while it
 * reorders the same list; a list set by anyone else (the car, a resumption) gets a new name, "n"
 * plus 15 hex, which tells the page to take that list over instead of overwriting it. An empty
 * player has no name. Main thread.
 */
class QueueOwner(private val newId: () -> String = ::randomForeignId) {
  private var current: String? = null

  /** The page's setQueue, with the name of its list: its own, or one it took over (null from an older page). */
  fun pageSet(id: String?) {
    current = id?.takeIf { PAGE.matches(it) }
  }

  /** A list set by the car or a resumption: a new name. */
  fun otherSet(): String = newId().also { current = it }

  /** The name to report for a player holding [itemCount] items. */
  fun idFor(itemCount: Int): String? = if (itemCount == 0) null else current

  companion object {
    private val PAGE = Regex("[0-9a-f]{16}|n[0-9a-f]{15}")
    private val rng = SecureRandom()

    fun randomForeignId(): String = "n" + ByteArray(8).also { rng.nextBytes(it) }.joinToString("") { "%02x".format(it) }.substring(0, 15)
  }
}
