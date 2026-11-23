package com.baccarancia.mpfy

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The links of the app's QR codes: what is one, what the page gets, and the intent that brings one. */
class CodeLinksTest {
  private val profile = "MPFY-P-N3K0-AP4M-1BQ5-N2CR-6P7D-S8ET-9FVA-GWBH-XCJY-DKZ0-EM1F-N2GP-3HQ4-JR5K"
  private val p = profile.replace("-", "")
  private val s1 = "MPFY-DVBR-2EWC-S3FX-DT4G-YEV5-HZW6-JAX7-KBY8"
  private val s2 = "mpfy-7k3q-9xwd-ab12-cdef-ghjk-mnpq-rstv-wxyz"
  private val s1n = s1.replace("-", "")
  private val s2n = s2.replace("-", "").uppercase()

  @Test
  fun aProfilesLinkCarriesItsProfileAndItsSourcesInOrder() {
    val link = CodeLinks.parse("mpfy://collega?p=$profile&s=$s1&s=$s2")
    assertEquals(CodeLinks.Link(p, listOf(s1n, s2n)), link)
    assertEquals("mpfy://collega?p=$p&s=$s1n&s=$s2n", link!!.text())
    // The same as the page writes it (web/js/links.js): codes without dashes.
    assertEquals(link, CodeLinks.parse(link.text()))
    // A profile with no source yet, any case, the same source twice once.
    assertEquals(CodeLinks.Link(p, emptyList()), CodeLinks.parse("mpfy://collega?p=$p"))
    assertEquals(listOf(s1n), CodeLinks.parse("MPFY://Collega/?p=$p&s=$s1&s=$s1n&x=1")!!.sources)
  }

  @Test
  fun aSourcesLinkCarriesExactlyOneSource() {
    val link = CodeLinks.parse("mpfy://fonte?s=$s1")
    assertEquals(CodeLinks.Link(null, listOf(s1n)), link)
    assertEquals("mpfy://fonte?s=$s1n", link!!.text())
    assertNull(CodeLinks.parse("mpfy://fonte?s=$s1&s=$s2"))
    assertNull(CodeLinks.parse("mpfy://fonte?p=$p&s=$s1"))
    assertNull(CodeLinks.parse("mpfy://fonte"))
  }

  @Test
  fun anythingElseIsNoLink() {
    val tooMany = "mpfy://collega?p=$p" + (10..30).joinToString("") { "&s=${s1n.dropLast(2)}$it" }
    for (t in listOf(
      s1, profile, "", "https://example.com/?p=$p", "mpfy://other?s=$s1", "mpfy://collega?s=$s1",
      "mpfy://collega?p=$p&p=$p", "mpfy://collega?p=$p&s=MPFY1234", "mpfy://collega?p=${p.dropLast(1)}U",
      "mpfy://collega?p=$p&s=$s1#x", "intent://collega?p=$p", tooMany,
    )) assertNull(t, CodeLinks.parse(t))
    assertNotNull(CodeLinks.parse("mpfy://collega?p=$p" + (10..29).joinToString("") { "&s=${s1n.dropLast(2)}$it" }))
  }

  @Test
  fun theScannerHandsThePageALinkOfOursOrABareCodeOnly() {
    assertEquals("mpfy://fonte?s=$s1n", CodeLinks.scanned(" mpfy://fonte?s=$s1 "))
    assertEquals(s1, CodeLinks.scanned(s1))
    assertEquals(profile, CodeLinks.scanned("  $profile\n"))
    assertNull(CodeLinks.scanned("https://example.com"))
    assertNull(CodeLinks.scanned("WIFI:S:casa;T:WPA;P:segreta;;"))
    assertNull(CodeLinks.scanned("mpfy://collega?p=MPFYP"))
  }

  @Test
  fun aViewIntentWithALinkOfOursGoesWhereTheCodeExtraGoes() {
    val view = "android.intent.action.VIEW"
    assertEquals("mpfy://collega?p=$p&s=$s1n", CodeLinks.codeOf(view, "mpfy://collega?p=$profile&s=$s1", null))
    assertEquals("mpfy://fonte?s=$s1n", CodeLinks.codeOf(view, "mpfy://fonte?s=$s1", null))
    // The extra "code" as before, first.
    assertEquals(s2, CodeLinks.codeOf(null, null, " $s2 "))
    assertEquals(s2, CodeLinks.codeOf(view, "mpfy://fonte?s=$s1", s2))
    // Not ours, or not a VIEW: nothing for the page.
    assertNull(CodeLinks.codeOf(view, "https://example.com/?s=$s1", null))
    assertNull(CodeLinks.codeOf(view, "mpfy://collega?s=$s1", null))
    assertNull(CodeLinks.codeOf("android.intent.action.MAIN", "mpfy://fonte?s=$s1", null))
    assertNull(CodeLinks.codeOf(null, null, "  "))
  }

  private val androidNs = "http://schemas.android.com/apk/res/android"

  private fun file(path: String): File = listOf(File(path), File("app/$path")).first { it.isFile }

  private fun activities(): Map<String, Element> {
    val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(file("src/main/AndroidManifest.xml"))
    val list = doc.getElementsByTagName("activity")
    return (0 until list.length).map { list.item(it) as Element }.associateBy { it.getAttributeNS(androidNs, "name") }
  }

  private fun Element.children(tag: String): List<Element> {
    val out = ArrayList<Element>()
    val nodes = childNodes
    for (i in 0 until nodes.length) (nodes.item(i) as? Element)?.takeIf { it.tagName == tag }?.let(out::add)
    return out
  }

  @Test
  fun theCameraAppOpensMainActivityWithTheLinksOfOurQrCodes() {
    val main = activities().getValue(".MainActivity")
    val filter = main.children("intent-filter").single { f -> f.children("action").any { it.getAttributeNS(androidNs, "name") == "android.intent.action.VIEW" } }
    val categories = filter.children("category").map { it.getAttributeNS(androidNs, "name") }.toSet()
    assertEquals(setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"), categories)
    val data = filter.children("data")
    assertEquals(setOf("mpfy"), data.mapNotNull { it.getAttributeNS(androidNs, "scheme").ifEmpty { null } }.toSet())
    assertEquals(setOf("collega", "fonte"), data.mapNotNull { it.getAttributeNS(androidNs, "host").ifEmpty { null } }.toSet())
    // The link reaches the page by the same road as the extra "code" (#aggiungi=), at start and later.
    val code = file("src/main/kotlin/com/baccarancia/mpfy/MainActivity.kt").readText()
    assertTrue(code.contains("CodeLinks.codeOf(i?.action, i?.dataString, i?.getStringExtra(\"code\"))"))
    assertTrue(code.contains("pendingCode = codeOf(intent)"))
    assertTrue(code.contains("val code = codeOf(intent) ?: return"))
  }

  @Test
  fun theScannerIsTheAppsOwnAndAsksForTheCameraOnly() {
    val scan = activities().getValue(".ScanActivity")
    assertEquals("false", scan.getAttributeNS(androidNs, "exported"))
    assertTrue(scan.children("intent-filter").isEmpty())
    val manifest = file("src/main/AndroidManifest.xml").readText()
    assertTrue(manifest.contains("android.permission.CAMERA"))
    // No Play Services and no ML Kit: the decoder is ZXing's core, on the phone.
    val gradle = file("build.gradle.kts").readText()
    assertTrue(gradle.contains("com.google.zxing:core:"))
    for (banned in listOf("play-services", "mlkit", "com.google.android.gms")) assertTrue(banned, !gradle.contains(banned))
  }
}
