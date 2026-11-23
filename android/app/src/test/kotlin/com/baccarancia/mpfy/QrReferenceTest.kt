package com.baccarancia.mpfy

import com.google.zxing.BinaryBitmap
import com.google.zxing.EncodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.BitMatrix
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.decoder.Decoder
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page draws its QR codes with its own encoder (web/js/qr.js); web/dev/qr-reference.json holds
 * what it gives for a few texts (the page's unit checks compare it bit for bit). Here ZXing, which
 * shares no code with it, reads each matrix back to its text, from the bare modules and from a
 * picture of it with its quiet zone, and its own encoder gives the same modules at the same level
 * (M), version and mask.
 */
class QrReferenceTest {
  private class Ref(val text: String, val version: Int, val mask: Int, val rows: List<String>)

  @Suppress("UNCHECKED_CAST")
  private fun refs(): List<Ref> {
    val f = listOf(File("../../web/dev/qr-reference.json"), File("../web/dev/qr-reference.json")).first { it.isFile }
    return (Json.parse(f.readText()) as List<Map<String, Any?>>).map {
      Ref(it["text"] as String, (it["version"] as Number).toInt(), (it["mask"] as Number).toInt(), it["rows"] as List<String>)
    }
  }

  private fun modules(r: Ref): BitMatrix {
    val n = r.rows.size
    val m = BitMatrix(n)
    for (y in 0 until n) for (x in 0 until n) if (r.rows[y][x] == '1') m.set(x, y)
    return m
  }

  @Test
  fun theReferencesCoverSmallAndLargeVersions() {
    val versions = refs().map { it.version }
    assertTrue(versions.any { it < 7 } && versions.any { it >= 10 })
    for (r in refs()) assertEquals(r.version * 4 + 17, r.rows.size)
  }

  @Test
  fun zxingReadsEachMatrixBackToItsText() {
    for (r in refs()) {
      val result = Decoder().decode(modules(r))
      assertEquals(r.text, result.text)
      assertEquals("M", result.ecLevel)
    }
  }

  @Test
  fun aPictureOfEachCodeWithItsQuietZoneScans() {
    val scale = 4
    for (r in refs()) {
      val n = r.rows.size
      val side = (n + 8) * scale
      val px = IntArray(side * side) { 0xFFFFFF }
      for (y in 0 until n) for (x in 0 until n) if (r.rows[y][x] == '1') {
        for (dy in 0 until scale) for (dx in 0 until scale) px[((y + 4) * scale + dy) * side + (x + 4) * scale + dx] = 0
      }
      val text = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(side, side, px)))).text
      assertEquals(r.text, text)
    }
  }

  @Test
  fun zxingsEncoderGivesTheSameModulesAtTheSameMask() {
    for (r in refs()) {
      val code = Encoder.encode(r.text, ErrorCorrectionLevel.M, mapOf(EncodeHintType.QR_MASK_PATTERN to r.mask))
      assertEquals(r.text, r.version, code.version.versionNumber)
      val m = code.matrix
      val rows = (0 until m.height).map { y -> (0 until m.width).joinToString("") { x -> if (m.get(x, y).toInt() == 1) "1" else "0" } }
      assertEquals(r.text, r.rows, rows)
    }
  }
}
