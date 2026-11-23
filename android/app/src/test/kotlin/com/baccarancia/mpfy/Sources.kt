package com.baccarancia.mpfy

import java.io.File
import org.junit.Assert.assertTrue

/** The app's own sources, for the checks of what calls what (the device run checks behaviour). */
internal object Sources {
  fun read(name: String): String =
    listOf(File("src/main/kotlin/com/baccarancia/mpfy/$name"), File("app/src/main/kotlin/com/baccarancia/mpfy/$name")).first { it.isFile }.readText()

  /**
   * The body of the member that starts at [signature] in [code], up to its closing brace at
   * [indent] spaces (2 for a class member, 4 for one of an inner class).
   */
  fun body(code: String, signature: String, indent: Int = 2): String {
    val start = code.indexOf(signature)
    assertTrue("missing: $signature", start >= 0)
    val end = code.indexOf("\n" + " ".repeat(indent) + "}\n", start)
    assertTrue("no end for: $signature", end > start)
    return code.substring(start, end)
  }
}
