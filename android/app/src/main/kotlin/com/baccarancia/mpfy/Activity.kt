package com.baccarancia.mpfy

import java.io.IOException

/*
 * What the phone plays, told to the core (PUT /local/activity { track, playing }), which passes
 * it on to the people of the sources as "now playing" and the recent plays. The native player
 * reports it (bridge 5): the page's timers stop in the background while the music plays on, and
 * Android Auto plays through the same service. Free of Android classes: PlaybackService feeds it
 * the player's state, CoreHttp and Keeper carry the requests out.
 */

/** A JSON request to the core with the app's token: the status and the answer (UTF-8). IOException when nothing answered. */
fun interface CoreJson {
  fun json(method: String, url: String, body: String?, timeoutMs: Int): Pair<Int, String>
}

/**
 * The song a report names: the trackId of the version playing (null: a song only on the phone,
 * never reported), its texts, whether it came from an artist's page.
 */
data class ActivityTrack(val trackId: String?, val title: String, val artist: String, val album: String, val artistPage: Boolean)

/** What the player does: the song and whether it plays now; no song with an empty player. */
data class ActivityState(val track: ActivityTrack?, val playing: Boolean) {
  /** A song a report may name: one with a version on a real source. */
  private val named: ActivityTrack? get() = track?.takeIf { it.trackId != null }

  /** It plays a song a report may name: the heartbeat runs only then. */
  val reported: Boolean get() = named != null && playing

  /** The request's body: { track: { trackId, title, artist, album, artistPage } | null, playing }; a song only on the phone says nothing plays. */
  fun body(): String {
    val t = named?.let { linkedMapOf("trackId" to it.trackId, "title" to it.title, "artist" to it.artist, "album" to it.album, "artistPage" to it.artistPage) }
    return Json.write(linkedMapOf("track" to t, "playing" to (t != null && playing)))
  }

  companion object {
    val NONE = ActivityState(null, false)

    /**
     * The version the item plays (the one its key names), else its first version, else the item's
     * own id. The phone's own file is never named: a version of the same song on a source is (the
     * first one), and a song only on the phone has none (null).
     */
    fun trackIdOf(playing: Version?, versions: List<Version>, itemId: String): String? {
      val onSource = versions.filter { it.sourceId != LocalSource.ID }
      if (playing != null && playing.sourceId != LocalSource.ID) return playing.trackId
      if (versions.isNotEmpty()) return onSource.firstOrNull()?.trackId
      return if (playing != null) null else itemId
    }

    /** The play started from an artist's page: the item's context (its ctx extra) is an artist. */
    fun artistPage(ctx: QueueCtx?): Boolean = ctx?.kind == "artist"
  }
}

/**
 * The worklet held awake for one call ([Holder], tag by tag), after waiting up to [waitMs] for the
 * core to listen awake (a suspended worklet resumes at the hold). No wait for any source's link:
 * the core passes the call on to its sources itself.
 */
class AwakeCall(
  private val holder: Holder,
  private val core: CoreState,
  private val clock: () -> Long,
  private val sleep: (Long) -> Unit,
  private val waitMs: Long = 15_000,
) {
  /** [block] with the worklet held; [wait] false: at once, with whatever the core is now. */
  fun <T> run(tag: String, wait: Boolean = true, block: (ready: Boolean) -> T): T {
    holder.hold(tag)
    try {
      return block(if (wait) await() else core.awakeSince != null && core.listening)
    } finally {
      holder.release(tag)
    }
  }

  /** True once the core listens and the worklet runs; false when [waitMs] went by first. */
  fun await(): Boolean {
    val end = clock() + waitMs
    while (true) {
      if (core.awakeSince != null && core.listening) return true
      if (clock() >= end) return false
      try {
        sleep(HeldGate.STEP_MS)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        return false
      }
    }
  }
}

/**
 * Tells the core what plays: at each change the player reports (it starts or stops playing, the
 * item changes) and every [everyMs] while it plays. One request at a time, off the main thread
 * ([worker]); the latest state replaces one still waiting. [update] and [stop] run on the main
 * thread, as [later] and [cancel] do.
 */
class ActivityReporter(
  private val http: CoreJson,
  private val awake: AwakeCall,
  private val worker: (Runnable) -> Unit,
  private val later: (Runnable, Long) -> Unit,
  private val cancel: (Runnable) -> Unit,
  private val origin: String = ORIGIN,
  private val everyMs: Long = HEARTBEAT_MS,
) {
  private class Pending(val body: String, val timeoutMs: Int, val wait: Boolean)

  private val lock = Any()
  private var running = false
  private var waiting: Pending? = null
  private var last: ActivityState? = null

  private val beat: Runnable = object : Runnable {
    override fun run() {
      val s = last ?: return
      if (!s.reported) return
      post(Pending(s.body(), TIMEOUT_MS, true))
      later(this, everyMs)
    }
  }

  /** The player's state now: reported, and the heartbeat follows it (only while it plays a song a report may name). */
  fun update(state: ActivityState) {
    last = state
    cancel(beat)
    if (state.reported) later(beat, everyMs)
    post(Pending(state.body(), TIMEOUT_MS, true))
  }

  /** The service goes: nothing plays any more, said once, best effort ([STOP_TIMEOUT_MS], no wait for the core). */
  fun stop() {
    cancel(beat)
    last = null
    post(Pending(ActivityState.NONE.body(), STOP_TIMEOUT_MS, false))
  }

  private fun post(p: Pending) {
    synchronized(lock) {
      if (running) {
        waiting = p
        return
      }
      running = true
    }
    worker(Runnable { drain(p) })
  }

  private fun drain(first: Pending) {
    var p: Pending? = first
    while (p != null) {
      send(p)
      p = synchronized(lock) {
        val w = waiting
        waiting = null
        if (w == null) running = false
        w
      }
    }
  }

  private fun send(p: Pending) {
    try {
      awake.run(TAG, p.wait) { ready -> if (ready || !p.wait) http.json("PUT", "$origin/local/activity", p.body, p.timeoutMs) }
    } catch (e: IOException) {
      // The core is away: the next report says it again.
    } catch (e: RuntimeException) {
      // Nothing of a report is worth stopping the player for.
    }
  }

  companion object {
    const val TAG = "activity"
    const val HEARTBEAT_MS = 60_000L
    const val TIMEOUT_MS = 10_000
    const val STOP_TIMEOUT_MS = 1_000
  }
}
