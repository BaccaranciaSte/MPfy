package com.baccarancia.mpfy

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.tan

/**
 * The integrated loudness of decoded audio (EBU R128, ITU-R BS.1770-4), as the source measures it
 * with ffmpeg's ebur128 (server/ffmpeg.mjs loudnessArgs), and its sample peak. K-weighting (a high
 * shelf, then a high pass, per channel), the weighted mean square of 400 ms blocks every 100 ms,
 * the absolute gate at -70 LUFS, then the relative gate 10 LU under the mean of what passed it.
 * Samples are interleaved floats in -1..1.
 */
class R128Meter(sampleRate: Int, private val channels: Int) {
  data class Result(val lufs: Double, val peak: Double?)

  private val step = max(1, sampleRate / 10)
  private val shelf = highShelf(sampleRate.toDouble())
  private val pass = highPass(sampleRate.toDouble())
  // Per channel: the two states of each biquad (transposed direct form II).
  private val state = Array(channels) { DoubleArray(4) }
  // L, R, C 1.0; the low-frequency channel left out; the surrounds 1.41 (Android's 5.1 order).
  private val weights = DoubleArray(channels) { c -> if (channels > 3 && c == 3) 0.0 else if (channels > 3 && c >= 4) 1.41 else 1.0 }
  private var sum = 0.0
  private var n = 0
  private val parts = ArrayList<Double>()
  private var peak = 0.0

  fun push(samples: FloatArray, frames: Int) {
    var i = 0
    for (f in 0 until frames) {
      var e = 0.0
      for (c in 0 until channels) {
        val x = samples[i++].toDouble()
        val a = abs(x)
        if (a > peak) peak = a
        if (weights[c] == 0.0) continue
        val y = biquad(pass, state[c], 2, biquad(shelf, state[c], 0, x))
        e += weights[c] * y * y
      }
      sum += e
      if (++n == step) {
        parts.add(sum / step)
        sum = 0.0
        n = 0
      }
    }
  }

  /** Null for less than 400 ms of audio, or nothing over the absolute gate (silence). */
  fun result(): Result? {
    if (parts.size < 4) return null
    val blocks = DoubleArray(parts.size - 3) { (parts[it] + parts[it + 1] + parts[it + 2] + parts[it + 3]) / 4 }
    val loud = blocks.filter { it > 0 && lk(it) > -70.0 }
    if (loud.isEmpty()) return null
    val gate = lk(loud.average()) - 10.0
    val kept = loud.filter { lk(it) > gate }
    if (kept.isEmpty()) return null
    return Result(lk(kept.average()), if (peak > 0) 20 * log10(peak) else null)
  }

  private fun lk(e: Double) = -0.691 + 10 * log10(e)

  private fun biquad(k: DoubleArray, s: DoubleArray, at: Int, x: Double): Double {
    val y = k[0] * x + s[at]
    s[at] = k[1] * x - k[3] * y + s[at + 1]
    s[at + 1] = k[2] * x - k[4] * y
    return y
  }

  private companion object {
    // The K-weighting filters at any rate, as libebur128 derives them (at 48 kHz exactly the
    // coefficients BS.1770 gives): b0, b1, b2, a1, a2, normalized by a0.
    fun highShelf(fs: Double): DoubleArray {
      val f0 = 1681.974450955533
      val g = 3.999843853973347
      val q = 0.7071752369554196
      val k = tan(PI * f0 / fs)
      val vh = 10.0.pow(g / 20)
      val vb = vh.pow(0.4996667741545416)
      val a0 = 1 + k / q + k * k
      return doubleArrayOf((vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0)
    }

    fun highPass(fs: Double): DoubleArray {
      val f0 = 38.13547087602444
      val q = 0.5003270373238773
      val k = tan(PI * f0 / fs)
      val a0 = 1 + k / q + k * k
      return doubleArrayOf(1.0, -2.0, 1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0)
    }
  }
}
