package com.baccarancia.mpfy

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class R128MeterTest {
  // `seconds` of a 997 Hz sine at `dbfs` (its peak) in every channel, then as much silence or a second level.
  private fun measure(rate: Int, channels: Int, parts: List<Pair<Double, Double?>>): R128Meter.Result? {
    val m = R128Meter(rate, channels)
    var t = 0L
    for ((seconds, dbfs) in parts) {
      val frames = (seconds * rate).toInt()
      val amp = if (dbfs == null) 0.0 else 10.0.pow(dbfs / 20)
      val buf = FloatArray(1024 * channels)
      var left = frames
      while (left > 0) {
        val n = minOf(1024, left)
        for (f in 0 until n) {
          val v = (amp * sin(2 * PI * 997 * (t + f) / rate)).toFloat()
          for (c in 0 until channels) buf[f * channels + c] = v
        }
        m.push(buf, n)
        t += n
        left -= n
      }
    }
    return m.result()
  }

  private fun near(want: Double, got: Double?, tol: Double) = assertTrue("want $want, got $got", got != null && abs(want - got) <= tol)

  @Test
  fun aStereoSineAtMinus23DbfsIsMinus23Lufs() {
    for (rate in listOf(44_100, 48_000, 96_000)) near(-23.0, measure(rate, 2, listOf(10.0 to -23.0))?.lufs, 0.1)
    // One channel: 3 dB less.
    near(-26.01, measure(48_000, 1, listOf(10.0 to -23.0))?.lufs, 0.1)
  }

  @Test
  fun silenceIsGatedOutAndQuietPartsUnder10LuAreLeftOut() {
    near(-20.0, measure(44_100, 2, listOf(10.0 to -20.0, 10.0 to null))?.lufs, 0.1)
    near(-20.0, measure(44_100, 2, listOf(10.0 to -20.0, 10.0 to -45.0))?.lufs, 0.2)
    assertNull(measure(44_100, 2, listOf(5.0 to null)))
    assertNull(measure(44_100, 2, listOf(0.3 to -10.0)))
  }

  @Test
  fun thePeakIsTheLargestSample() {
    near(-6.02, measure(48_000, 2, listOf(2.0 to -6.0206))?.peak, 0.02)
  }
}
