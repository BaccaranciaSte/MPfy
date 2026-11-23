package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Cover ids as the source makes them, on vectors the source's own code wrote (src/test/vectors.mjs). */
class CoverArtTest {
  private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

  @Suppress("UNCHECKED_CAST")
  private val covers = Json.obj(javaClass.getResource("/local/vectors.json")!!.readText())!!["covers"] as List<Map<String, Any?>>

  @Test
  fun coverIdsEqualTheSources() {
    assertTrue(covers.size >= 10)
    for (v in covers) {
      val data = hex(v["hex"] as String)
      assertEquals(v["name"] as String, v["ext"], CoverArt.sniffImage(data))
      assertEquals(v["name"] as String, v["id"], CoverArt.coverId(data))
    }
  }

  @Test
  fun theSamePictureWithOtherMetadataIsOneCover() {
    val byName = covers.associateBy { it["name"] as String }
    assertEquals(byName.getValue("jpeg with exif and a comment")["id"], byName.getValue("the same jpeg, other exif and comment")["id"])
  }

  @Test
  fun nothingThatIsNotAPictureOrIsTooLargeHasAnId() {
    assertNull(CoverArt.coverId(ByteArray(0)))
    assertNull(CoverArt.coverId("GIF89a....".toByteArray()))
    val huge = ByteArray(CoverArt.MAX_COVER_BYTES + 1).also {
      it[0] = 0xff.toByte()
      it[1] = 0xd8.toByte()
      it[2] = 0xff.toByte()
    }
    assertNull(CoverArt.coverId(huge))
  }

  @Test
  fun sizesFitTheBoxKeepTheShapeAndNeverGrow() {
    assertEquals(640 to 320, CoverArt.fit(1000, 500, 640))
    assertEquals(80 to 160, CoverArt.fit(500, 1000, 160))
    assertEquals(100 to 80, CoverArt.fit(100, 80, 640))
    assertEquals(640 to 640, CoverArt.fit(3000, 3000, 640))
    assertEquals(160 to 1, CoverArt.fit(4000, 10, 160))
  }
}
