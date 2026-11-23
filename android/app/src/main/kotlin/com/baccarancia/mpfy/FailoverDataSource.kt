package com.baccarancia.mpfy

import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService

/** The Media3 side of [FailoverReader]: what the stream cache reads from, for the player and the prefetch. */
@OptIn(UnstableApi::class)
class FailoverDataSource(private val reader: FailoverReader) : BaseDataSource(true) {
  private var spec: DataSpec? = null
  private var opened = false

  override fun open(dataSpec: DataSpec): Long {
    spec = dataSpec
    transferInitializing(dataSpec)
    val n = reader.open(dataSpec.key, dataSpec.uri.toString(), dataSpec.position, dataSpec.length)
    opened = true
    transferStarted(dataSpec)
    return if (n < 0) C.LENGTH_UNSET.toLong() else n
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val n = reader.read(buffer, offset, length)
    if (n < 0) return C.RESULT_END_OF_INPUT
    if (n > 0) bytesTransferred(n)
    return n
  }

  override fun getUri(): Uri? = spec?.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    reader.served?.let { mapOf("X-MPfy-Quality" to listOf(it)) } ?: emptyMap()

  override fun close() {
    spec = null
    reader.close()
    if (opened) {
      opened = false
      transferEnded()
    }
  }

  /** Stops it for good (a cancelled prefetch). */
  fun cancel() = reader.cancel()

  class Factory(
    private val onServed: (String, String) -> Unit = StreamCache::noteServed,
    private val created: (FailoverDataSource) -> Unit = {},
  ) : DataSource.Factory {
    override fun createDataSource(): DataSource = create(onServed).also(created)
  }

  companion object {
    /** The stall watchdogs of every reader. */
    val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "MPfyStallWatch").apply { isDaemon = true }
    }

    // The phone's own songs are read from their files here, everything else from the core.
    fun create(onServed: (String, String) -> Unit): FailoverDataSource = FailoverDataSource(
      FailoverReader(
        registry = Playback.registry,
        opener = LocalOpener(HttpOpener(CoreHost.requestHeaders), PhoneFiles),
        reps = LocalRepresentations(StreamCache),
        links = Links,
        timer = timer,
        origin = ORIGIN,
        onServed = onServed,
        onMoved = { key, from, to, position ->
          Log.i(TAG, "$key: ${from.sourceId} failed at byte $position, on with ${to.sourceId}")
        },
      ),
    )

    private const val TAG = "MPfyFailover"
  }
}

/**
 * The top of the player's chain. When another representation turned up under a key while this
 * load was reading it (from the network or from bytes the prefetch cached), the load reads no
 * further: two representations are never mixed in one play. It also tells [reads] where the
 * player reads each streamed song, which the prefetch follows.
 */
@OptIn(UnstableApi::class)
class GuardedDataSource(private val upstream: DataSource, private val reps: Representations, private val reads: PlayerReads? = null) : DataSource {
  private var key: String? = null
  private var generation = 0
  private var at: PlayerReads.At? = null

  override fun addTransferListener(transferListener: TransferListener) = upstream.addTransferListener(transferListener)

  override fun open(dataSpec: DataSpec): Long {
    val k = dataSpec.key
    at = null
    if (k != null && Levels.isStream(k)) {
      if (k == key) {
        if (reps.generation(k) != generation) throw RepresentationChangedException(k)
      } else {
        key = k
        generation = reps.generation(k)
      }
    }
    val n = upstream.open(dataSpec)
    if (k != null && Levels.isStream(k) && !LocalSource.isKey(k)) at = reads?.opened(k, dataSpec.position)
    return n
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val k = key
    if (k != null && reps.generation(k) != generation) throw RepresentationChangedException(k)
    val n = upstream.read(buffer, offset, length)
    if (n > 0) at?.read(n)
    return n
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    at = null
    upstream.close()
  }

  class Factory(private val upstream: DataSource.Factory, private val reps: Representations, private val reads: PlayerReads? = Prefetch.reads) : DataSource.Factory {
    override fun createDataSource(): DataSource = GuardedDataSource(upstream.createDataSource(), reps, reads)
  }
}
