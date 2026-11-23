package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
  @Test
  fun valuesAreReadWithTheirTypes() {
    val o = Json.parse("{ \"a\": 1, \"b\": -2.5e3, \"c\": [true, false, null], \"d\": { \"e\": \"x\" }, \"f\": 9007199254740993 }") as Map<*, *>
    assertEquals(1L, o["a"])
    assertEquals(-2500.0, o["b"])
    assertEquals(listOf(true, false, null), o["c"])
    assertEquals(mapOf("e" to "x"), o["d"])
    assertEquals(9007199254740993L, o["f"])
  }

  @Test
  fun escapesAreDecodedAndWrittenBack() {
    val text = "[\"a\\\"\\\\\\/\\n\\t\\u00e9\\u2028\"]"
    val s = (Json.parse(text) as List<*>)[0] as String
    assertEquals("a\"\\/\n\t\u00e9\u2028", s)
    assertEquals(s, (Json.parse(Json.write(listOf(s))) as List<*>)[0])
    assertTrue(Json.write(listOf(s)).contains("\\u2028"))
  }

  @Test
  fun anythingNotStrictJsonIsRefused() {
    val bad = listOf("", "{", "[1,]", "{\"a\":1,}", "01", "1.", "-", "\"a", "tru", "{a:1}", "[1] 2", "\"\\x\"", "NaN", "\"tab\tinside\"")
    for (b in bad) assertTrue(b, runCatching { Json.parse(b) }.isFailure)
    assertNull(Json.obj("[1]"))
    assertNull(Json.obj("{"))
    assertTrue(runCatching { Json.parse("[".repeat(100)) }.isFailure)
  }

  @Test
  fun writingKeepsOrderAndIntegralNumbers() {
    assertEquals("{\"b\":1,\"a\":[2,2.5,null,\"x\"]}", Json.write(linkedMapOf("b" to 1, "a" to listOf(2L, 2.5, null, "x"))))
    assertEquals("[3]", Json.write(listOf(3.0)))
  }
}
