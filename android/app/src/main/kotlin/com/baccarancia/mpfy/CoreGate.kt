package com.baccarancia.mpfy

/*
 * Requests to the core from outside the page (the heart, the covers) and Android Auto's hold on
 * the worklet, free of Android classes: CoreHost and Keeper carry them out.
 */

/** Keeps the worklet awake (a suspended one resumes at once) until released with the same tag. Any thread. */
interface Holder {
  fun hold(tag: String)

  fun release(tag: String)
}

/** The core as a request needs it. Any thread. */
interface CoreState {
  /** The core listens on [ORIGIN]. */
  val listening: Boolean

  /** Since when the worklet runs (started or resumed, elapsed ms); null while it is suspended or gone. */
  val awakeSince: Long?

  /** The core said which sources it has (its first list came). */
  val listed: Boolean

  fun isSource(sourceId: String): Boolean

  fun isUp(sourceId: String): Boolean

  /** The source with principal: true in the last list, or null. */
  val principal: String?

  /** Where the person's data lives (the last sources event's home): the principal, "0000" (the phone's own store), or null. */
  val home: String? get() = principal
}

/** The core must be usable for one request: the worklet held awake and, for a while, its link to the source up. */
interface CoreGate {
  /** Whether [sourceId] is one of the core's sources (a list not come yet is waited for, a while). */
  fun isSource(sourceId: String): Boolean

  /** The principal source, the same way; null when there is none. */
  fun principal(): String?

  /** Where the person's data lives (the heart's likes go there), the same way: the principal, or "0000" while the phone's own store holds it. */
  fun home(): String? = principal()

  /** Runs [block] with the worklet held awake, once the link to [sourceId] is up ([up] true) or the wait is over. */
  fun <T> use(tag: String, sourceId: String, block: (up: Boolean) -> T): T
}

/**
 * The worklet held awake for one request, and up to [waitMs] for the core and the source's link
 * first. A suspended worklet keeps its last flags (ready, the links up), so only the worklet's own
 * word that it resumed counts as awake; a link still down [waitMs] after the worklet woke is not
 * waited for again, so a source that is simply off costs no wait.
 */
class HeldGate(
  private val holder: Holder,
  private val core: CoreState,
  private val clock: () -> Long,
  private val sleep: (Long) -> Unit,
  private val waitMs: Long = 15_000,
) : CoreGate {
  override fun isSource(sourceId: String): Boolean = listed() && core.isSource(sourceId)

  override fun principal(): String? = if (listed()) core.principal else null

  override fun home(): String? = if (listed()) core.home else null

  override fun <T> use(tag: String, sourceId: String, block: (up: Boolean) -> T): T {
    holder.hold(tag)
    try {
      return block(await(sourceId))
    } finally {
      holder.release(tag)
    }
  }

  /** True once the link is up; false when the wait is over first, or the source is gone. */
  fun await(sourceId: String): Boolean {
    val end = clock() + waitMs
    while (true) {
      val now = clock()
      val since = core.awakeSince
      if (since != null && core.listening) {
        if (core.listed && !core.isSource(sourceId)) return false
        if (core.isUp(sourceId)) return true
        if (now - since >= waitMs) return false
      }
      if (now >= end || !pause()) return false
    }
  }

  // The core lists its sources right after it starts: only a process just started waits here.
  private fun listed(): Boolean {
    val end = clock() + waitMs
    while (!core.listed && clock() < end) if (!pause()) break
    return core.listed
  }

  private fun pause(): Boolean = try {
    sleep(STEP_MS)
    true
  } catch (e: InterruptedException) {
    Thread.currentThread().interrupt()
    false
  }

  companion object {
    const val STEP_MS = 100L
  }
}

/**
 * Android Auto's hold on the worklet (covers and playback need the core). A browser the platform
 * connected, which is how Android Auto browses, never says goodbye to Media3, so the hold is a lease:
 * taken at the car's first call, renewed by each one, let go [leaseMs] after the last. Main thread.
 */
class CarLease(
  private val holder: Holder,
  private val later: (Runnable, Long) -> Unit,
  private val cancel: (Runnable) -> Unit,
  private val leaseMs: Long = LEASE_MS,
) {
  var held = false
    private set

  private val end = Runnable { close() }

  /** A call from the car. */
  fun touch() {
    if (!held) {
      held = true
      holder.hold(TAG)
    }
    cancel(end)
    later(end, leaseMs)
  }

  fun close() {
    cancel(end)
    if (!held) return
    held = false
    holder.release(TAG)
  }

  companion object {
    const val TAG = "auto"
    const val LEASE_MS = 5 * 60_000L
  }
}
