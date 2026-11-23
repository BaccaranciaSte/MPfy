package com.baccarancia.mpfy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Cover ids as the source makes them (server/media.mjs): the first 24 hex of the SHA-256 of the
 * parts of the picture that make the picture, metadata left out, so the same picture has the same
 * id on the phone and on a source. Checked against the source's own code on shared vectors.
 */
object CoverArt {
  const val MAX_COVER_BYTES = 16 * 1024 * 1024
  const val SMALL = 160
  const val LARGE = 640

  fun sniffImage(d: ByteArray): String? {
    if (d.size >= 3 && d[0] == 0xff.toByte() && d[1] == 0xd8.toByte() && d[2] == 0xff.toByte()) return "jpg"
    if (d.size >= 8 && d[0] == 0x89.toByte() && ascii(d, 1, 3) == "PNG") return "png"
    if (d.size >= 12 && ascii(d, 0, 4) == "RIFF" && ascii(d, 8, 4) == "WEBP") return "webp"
    return null
  }

  /** The id of a picture, or null when the bytes are no JPEG, PNG or WebP, or pass 16 MB. */
  fun coverId(d: ByteArray): String? {
    if (d.isEmpty() || d.size > MAX_COVER_BYTES) return null
    val ext = sniffImage(d) ?: return null
    val md = MessageDigest.getInstance("SHA-256")
    for ((start, end) in hashParts(d, ext)) md.update(d, start, end - start)
    return hex(md.digest()).substring(0, 24)
  }

  /**
   * The regions of [d] the id is made of, as (start, end) pairs, the end excluded. JPEG: APP1 (EXIF, XMP), APP12,
   * APP13 and COM leave; PNG: text, time and EXIF chunks; WebP: EXIF and XMP chunks and the RIFF
   * size. Anything that does not walk cleanly is hashed whole.
   */
  fun hashParts(d: ByteArray, ext: String): List<Pair<Int, Int>> {
    val parts = when (ext) {
      "jpg" -> jpegParts(d)
      "png" -> pngParts(d)
      "webp" -> webpParts(d)
      else -> null
    }
    return parts ?: listOf(0 to d.size)
  }

  private val JPEG_DROP = setOf(0xe1, 0xec, 0xed, 0xfe)

  private fun jpegParts(d: ByteArray): List<Pair<Int, Int>>? {
    val parts = arrayListOf(0 to 2)
    var i = 2
    while (i + 4 <= d.size) {
      if (u8(d, i) != 0xff) return null
      val marker = u8(d, i + 1)
      if (marker == 0xff) {
        i++
        continue
      }
      if (marker == 0xda) {
        parts.add(i to d.size)
        return parts
      }
      val len = (u8(d, i + 2) shl 8) or u8(d, i + 3)
      if (len < 2 || i + 2 + len > d.size) return null
      if (marker !in JPEG_DROP) parts.add(i to i + 2 + len)
      i += 2 + len
    }
    return null
  }

  private val PNG_DROP = setOf("tEXt", "zTXt", "iTXt", "tIME", "eXIf")

  private fun pngParts(d: ByteArray): List<Pair<Int, Int>>? {
    val parts = arrayListOf(0 to 8)
    var i = 8L
    while (i + 12 <= d.size) {
      val len = u32be(d, i.toInt())
      val type = ascii(d, i.toInt() + 4, 4)
      val end = i + 12 + len
      if (end > d.size) return null
      if (type !in PNG_DROP) parts.add(i.toInt() to end.toInt())
      if (type == "IEND") return parts
      i = end
    }
    return null
  }

  private fun webpParts(d: ByteArray): List<Pair<Int, Int>>? {
    val parts = arrayListOf(0 to 4, 8 to 12)
    var i = 12L
    while (i + 8 <= d.size) {
      val type = ascii(d, i.toInt(), 4)
      val len = u32le(d, i.toInt() + 4)
      if (i + 8 + len > d.size) return null
      if (type != "EXIF" && type != "XMP ") parts.add(i.toInt() to (i + 8 + len).toInt())
      i += 8 + len + (len and 1)
    }
    return parts
  }

  /** The size of a picture of [w] x [h] scaled to fit in [px] x [px], its shape kept, never enlarged. */
  fun fit(w: Int, h: Int, px: Int): Pair<Int, Int> {
    val bw = minOf(px, w)
    val bh = minOf(px, h)
    val scale = minOf(bw.toDouble() / w, bh.toDouble() / h)
    return maxOf(1, Math.round(w * scale).toInt()) to maxOf(1, Math.round(h * scale).toInt())
  }

  fun hex(b: ByteArray): String {
    val s = StringBuilder(b.size * 2)
    for (x in b) {
      val v = x.toInt() and 0xff
      s.append("0123456789abcdef"[v shr 4]).append("0123456789abcdef"[v and 0xf])
    }
    return s.toString()
  }

  private fun u8(d: ByteArray, i: Int) = d[i].toInt() and 0xff

  private fun u32be(d: ByteArray, i: Int): Long =
    (u8(d, i).toLong() shl 24) or (u8(d, i + 1).toLong() shl 16) or (u8(d, i + 2).toLong() shl 8) or u8(d, i + 3).toLong()

  private fun u32le(d: ByteArray, i: Int): Long =
    (u8(d, i + 3).toLong() shl 24) or (u8(d, i + 2).toLong() shl 16) or (u8(d, i + 1).toLong() shl 8) or u8(d, i).toLong()

  private fun ascii(d: ByteArray, start: Int, len: Int): String {
    val s = StringBuilder(len)
    for (i in start until minOf(d.size, start + len)) s.append((d[i].toInt() and 0xff).toChar())
    return s.toString()
  }
}

/** Where a probe puts the picture it found: decoded once, written in the two sizes. */
interface ArtSink {
  fun has(coverId: String): Boolean

  /** Makes the sizes of [image] under [coverId]; false when it does not decode. */
  fun put(coverId: String, image: ByteArray): Boolean
}

/**
 * The phone's covers in `filesDir/local/art`: `<coverId>.small.jpg` and `.large.jpg`, 160 and
 * 640 px boxes as the source's, JPEG quality 85, each written whole under a temporary name and
 * renamed, so the core never serves half a file. Art is per picture: an album of 14 tracks with
 * the same picture is one pair of files.
 */
class ArtStore(val dir: File) : ArtSink {
  companion object {
    private const val TAG = "MPfyLocal"
    private const val QUALITY = 85
  }

  private fun file(coverId: String, size: String) = File(dir, "$coverId.$size.jpg")

  override fun has(coverId: String): Boolean = file(coverId, "small").isFile && file(coverId, "large").isFile

  override fun put(coverId: String, image: ByteArray): Boolean {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(image, 0, image.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= CoverArt.LARGE && bounds.outHeight / (sample * 2) >= CoverArt.LARGE) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(image, 0, image.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return false
    return try {
      write(coverId, bmp)
    } finally {
      bmp.recycle()
    }
  }

  /** A picture the system drew (a folder's art): its id is the hash of the JPEG made from it. */
  fun putBitmap(bmp: Bitmap): String? {
    val (w, h) = CoverArt.fit(bmp.width, bmp.height, CoverArt.LARGE)
    val large = if (w == bmp.width && h == bmp.height) bmp else Bitmap.createScaledBitmap(bmp, w, h, true)
    try {
      val jpeg = encode(large) ?: return null
      val id = CoverArt.coverId(jpeg) ?: return null
      if (has(id)) return id
      dir.mkdirs()
      if (!atomic(file(id, "large"), jpeg)) return null
      val small = scaled(large, CoverArt.SMALL)
      try {
        val bytes = encode(small) ?: return null
        if (!atomic(file(id, "small"), bytes)) return null
      } finally {
        if (small !== large) small.recycle()
      }
      return id
    } finally {
      if (large !== bmp) large.recycle()
    }
  }

  private fun write(coverId: String, bmp: Bitmap): Boolean {
    dir.mkdirs()
    for ((name, px) in listOf("large" to CoverArt.LARGE, "small" to CoverArt.SMALL)) {
      val b = scaled(bmp, px)
      try {
        val bytes = encode(b) ?: return false
        if (!atomic(file(coverId, name), bytes)) return false
      } finally {
        if (b !== bmp) b.recycle()
      }
    }
    return true
  }

  private fun scaled(bmp: Bitmap, px: Int): Bitmap {
    val (w, h) = CoverArt.fit(bmp.width, bmp.height, px)
    return if (w == bmp.width && h == bmp.height) bmp else Bitmap.createScaledBitmap(bmp, w, h, true)
  }

  private fun encode(bmp: Bitmap): ByteArray? {
    val out = ByteArrayOutputStream()
    return if (bmp.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)) out.toByteArray() else null
  }

  private fun atomic(target: File, bytes: ByteArray): Boolean {
    val tmp = File(dir, target.name + ".tmp")
    return try {
      FileOutputStream(tmp).use {
        it.write(bytes)
        it.fd.sync()
      }
      tmp.renameTo(target)
    } catch (e: Exception) {
      Log.w(TAG, "cover not written: ${e.javaClass.simpleName}")
      tmp.delete()
      false
    }
  }

  fun delete(coverId: String) {
    file(coverId, "small").delete()
    file(coverId, "large").delete()
  }
}
