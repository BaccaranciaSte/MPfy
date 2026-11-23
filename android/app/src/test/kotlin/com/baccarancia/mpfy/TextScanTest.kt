package com.baccarancia.mpfy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The web's text rule on the app's own text: ASCII and the Italian accented letters only. */
class TextScanTest {
  private val italian = "\u00e0\u00e8\u00e9\u00ec\u00ed\u00f2\u00f3\u00f9\u00fa\u00c0\u00c8\u00c9\u00cc\u00cd\u00d2\u00d3\u00d9\u00da"

  private fun module(): File = listOf(File("."), File("app")).first { File(it, "src/main/AndroidManifest.xml").isFile }

  private fun allowed(c: Char) = c == '\n' || c == '\r' || c == '\t' || c in ' '..'~' || italian.indexOf(c) >= 0

  private fun texts(): List<File> {
    val m = module()
    val src = File(m, "src").walkTopDown().filter { it.isFile && (it.extension == "kt" || it.extension == "xml") }.toList()
    val more = listOf("build.gradle.kts", "../build.gradle.kts", "../settings.gradle.kts", "../gradle.properties", "../worklet/index.js", "../worklet/clean-libs.mjs", "../worklet/package.json", "../release.sh", "../../README.md")
      .map { File(m, it) }.filter { it.isFile }
    return src + more
  }

  @Test
  fun theAppsTextHoldsNoOtherCharacter() {
    val files = texts()
    assertTrue("the Kotlin sources", files.count { it.extension == "kt" } > 15)
    assertTrue("the resources", files.any { it.invariantSeparatorsPath.endsWith("res/values/strings.xml") })
    assertTrue("the worklet", files.any { it.name == "index.js" })
    assertTrue("the release script", files.any { it.name == "release.sh" })
    assertTrue("the README", files.any { it.name == "README.md" })
    assertTrue("the tests", files.any { it.name == "BrowseTreeTest.kt" })
    val bad = ArrayList<String>()
    for (f in files) {
      f.readText(Charsets.UTF_8).lineSequence().forEachIndexed { i, line ->
        line.firstOrNull { !allowed(it) }?.let { bad.add("${f.path}:${i + 1}: U+%04X".format(it.code)) }
      }
    }
    assertEquals(emptyList<String>(), bad)
  }

  @Test
  fun theRuleCatchesDashesQuotesEllipsesArrowsAndPictographs() {
    val banned = "\u2014\u2013\u201c\u201d\u2018\u2019\u2026\u00b7\u2192\u2713\ud83c\u00a0"
    for (c in banned) assertFalse("U+%04X".format(c.code), allowed(c))
    for (c in "Gi\u00e0 pi\u00f9, \u00e8 \u00c8") assertTrue(allowed(c))
  }
}
