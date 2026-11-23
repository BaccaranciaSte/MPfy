package com.baccarancia.mpfy

import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** What the app declares to Android, checked from the sources (the device run checks behaviour). */
class WiringTest {
  private val androidNs = "http://schemas.android.com/apk/res/android"

  private fun manifest(): File =
    listOf(File("src/main/AndroidManifest.xml"), File("app/src/main/AndroidManifest.xml")).first { it.isFile }

  private fun applicationMetaData(): Map<String, String> {
    val f = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
    val doc = f.newDocumentBuilder().parse(manifest())
    val app = doc.getElementsByTagName("application").item(0) as Element
    val out = HashMap<String, String>()
    val nodes = app.childNodes
    for (i in 0 until nodes.length) {
      val e = nodes.item(i) as? Element ?: continue
      if (e.tagName == "meta-data") out[e.getAttributeNS(androidNs, "name")] = e.getAttributeNS(androidNs, "value")
    }
    return out
  }

  @Test
  fun theWebViewSendsNoMetricsAndMakesNoSafeBrowsingLookups() {
    val meta = applicationMetaData()
    assertEquals("true", meta["android.webkit.WebView.MetricsOptOut"])
    assertEquals("false", meta["android.webkit.WebView.EnableSafeBrowsing"])
  }

  @Test
  fun uploadsKeepTheProcessWithADataSyncService() {
    val f = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
    val doc = f.newDocumentBuilder().parse(manifest())
    val services = doc.getElementsByTagName("service")
    val types = HashMap<String, String>()
    for (i in 0 until services.length) {
      val e = services.item(i) as Element
      types[e.getAttributeNS(androidNs, "name")] = e.getAttributeNS(androidNs, "foregroundServiceType")
    }
    assertEquals("dataSync", types[".UploadService"])
    val perms = doc.getElementsByTagName("uses-permission")
    val names = (0 until perms.length).map { (perms.item(it) as Element).getAttributeNS(androidNs, "name") }
    assertTrue("android.permission.FOREGROUND_SERVICE_DATA_SYNC" in names)
  }

  @Test
  fun theClipboardIsNeverReadBack() {
    // Reading the clip would read another app's, and Android 12 and later say so on screen: the
    // app looks at the clip's description only.
    val dir = listOf(File("src/main/kotlin"), File("app/src/main/kotlin")).first { it.isDirectory }
    val reads = Regex("""\bprimaryClip\b(?!Description)|getPrimaryClip\s*\(""")
    val found = dir.walkTopDown().filter { it.isFile && it.extension == "kt" }.flatMap { f ->
      f.readLines().mapIndexedNotNull { i, line -> if (reads.containsMatchIn(line)) "${f.name}:${i + 1}" else null }
    }.toList()
    assertEquals(emptyList<String>(), found)
    assertTrue(File(dir, "com/baccarancia/mpfy/MPfyBridge.kt").readText().contains("primaryClipDescription"))
  }

  private fun doc() = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(manifest())

  private fun named(tag: String): Map<String, Element> {
    val nodes = doc().getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }.associateBy { it.getAttributeNS(androidNs, "name") }
  }

  private fun source(name: String): String =
    listOf(File("src/main/kotlin/com/baccarancia/mpfy/$name"), File("app/src/main/kotlin/com/baccarancia/mpfy/$name")).first { it.isFile }.readText()

  private fun releaseScript(): String = listOf(File("../release.sh"), File("release.sh")).first { it.isFile }.readText()

  @Test
  fun updatesMayAskToInstallAndOnlyOurOwnIntentReachesTheReceiver() {
    assertTrue("android.permission.REQUEST_INSTALL_PACKAGES" in named("uses-permission"))
    val r = named("receiver").getValue(".UpdateReceiver")
    assertEquals("false", r.getAttributeNS(androidNs, "exported"))
  }

  @Test
  fun theArtworkProviderIsExportedReadOnlyUnderItsAuthority() {
    val p = named("provider").getValue(".ArtProvider")
    assertEquals("true", p.getAttributeNS(androidNs, "exported"))
    assertEquals(Artwork.AUTHORITY, p.getAttributeNS(androidNs, "authorities"))
    assertEquals("", p.getAttributeNS(androidNs, "writePermission"))
    val code = source("ArtProvider.kt")
    assertTrue(code.contains("if (mode != \"r\") throw FileNotFoundException"))
  }

  @Test
  fun thePlaybackServiceAnswersTheThreeServiceActions() {
    val svc = named("service").getValue(".PlaybackService")
    val actions = svc.getElementsByTagName("action")
    val names = (0 until actions.length).map { (actions.item(it) as Element).getAttributeNS(androidNs, "name") }.toSet()
    assertEquals(
      setOf("androidx.media3.session.MediaLibraryService", "android.media.browse.MediaBrowserService", "androidx.media3.session.MediaSessionService"),
      names,
    )
  }

  @Test
  fun androidAutoFindsAMediaAppWithItsIcon() {
    val app = doc().getElementsByTagName("application").item(0) as Element
    val meta = HashMap<String, String>()
    val nodes = app.childNodes
    for (i in 0 until nodes.length) {
      val e = nodes.item(i) as? Element ?: continue
      if (e.tagName == "meta-data") meta[e.getAttributeNS(androidNs, "name")] = e.getAttributeNS(androidNs, "resource")
    }
    assertEquals("@xml/automotive_app_desc", meta["com.google.android.gms.car.application"])
    assertEquals("@drawable/ic_stat_mpfy", meta["com.google.android.gms.car.notification.SmallIcon"])
    val desc = listOf(File("src/main/res/xml/automotive_app_desc.xml"), File("app/src/main/res/xml/automotive_app_desc.xml")).first { it.isFile }
    val d = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(desc).documentElement
    assertEquals("automotiveApp", d.tagName)
    val uses = d.getElementsByTagName("uses")
    assertEquals(1, uses.length)
    assertEquals("media", (uses.item(0) as Element).getAttribute("name"))
  }

  @Test
  fun downloadsAndUploadsBothAskForNotifications() {
    val code = source("MPfyBridge.kt")
    for (method in listOf("fun download(", "fun setUploading(")) {
      val start = code.indexOf(method)
      assertTrue(method, start >= 0)
      val body = code.substring(start, code.indexOf("\n  }\n", start))
      assertTrue(method, body.contains("host.askNotifications()"))
    }
  }

  @Test
  fun thePageCanAskTheInstalledVersion() {
    val code = source("MPfyBridge.kt")
    val start = code.indexOf("fun appVersion(): String")
    assertTrue(start >= 0)
    assertTrue(code.substring(start, code.indexOf('\n', start)).contains("getPackageInfo(activity.packageName, 0).versionName"))
  }

  @Test
  fun theCarsHoldOnTheWorkletIsALeaseEveryCarCallRenews() {
    val code = source("PlaybackService.kt")
    assertTrue(code.contains("CarLease(Keeper"))
    // Media3 never says goodbye for a browser the platform connected: nothing may wait for it.
    assertFalse(code.contains("override fun onDisconnected"))
    assertFalse(code.contains("Keeper.hold("))
    // Root, children, item, subscribe, search, search results; queue, items and the heart.
    assertTrue(code.contains("fromCar(browser)\n      rootLimits"))
    assertEquals(5, code.split("withSnapshot(browser) {").size - 1)
    assertEquals(3, code.split("\n      fromCar(controller)\n").size - 1)
  }

  @Test
  fun theReleaseScriptNeverShowsThePasswordAndPublishesOnlyByHand() {
    val sh = releaseScript()
    assertTrue(sh.contains("set -euo pipefail"))
    assertFalse(Regex("set\\s+-[a-z]*x").containsMatchIn(sh))
    assertFalse(sh.lines().any { l -> Regex("\\b(echo|printf)\\b").containsMatchIn(l) && (l.contains("MPFY_KEYSTORE_PASS") || l.contains("\$pass")) })
    assertFalse(Regex("\\btee\\b").containsMatchIn(sh))
    val tty = sh.indexOf("[ -t 0 ]")
    val create = sh.indexOf("gh release create")
    assertTrue(tty in 0 until create)
    assertTrue(sh.contains("apksigner.bat\" verify --print-certs"))
    assertTrue(sh.contains("release_digest=eebd3974aeb11734bac7aa96c1dead16fde3ad4887b9a54d3d973158d51ea50e"))
    assertTrue(sh.contains("Signer #1 certificate SHA-256 digest: \$release_digest"))
    assertTrue(sh.contains("dump badging"))
    // The password reaches the Gradle command only.
    assertEquals(1, Regex("MPFY_KEYSTORE_PASS=").findAll(sh).count())
  }

  @Test
  fun thePhonesMusicIsReadWithTheAudioPermissionOnly() {
    val perms = named("uses-permission")
    assertTrue("android.permission.READ_MEDIA_AUDIO" in perms)
    val legacy = perms.getValue("android.permission.READ_EXTERNAL_STORAGE")
    assertEquals("32", legacy.getAttributeNS(androidNs, "maxSdkVersion"))
    // A photo permission for a music player is an overreach and a second dialog; all files is never asked.
    assertFalse("android.permission.READ_MEDIA_IMAGES" in perms)
    assertFalse("android.permission.MANAGE_EXTERNAL_STORAGE" in perms)
    // Android 10 only: an .lrc beside a song is read by its path.
    val app = doc().getElementsByTagName("application").item(0) as Element
    assertEquals("true", app.getAttributeNS(androidNs, "requestLegacyExternalStorage"))
  }

  @Test
  fun theWebViewClientSurvivesItsRenderer() {
    // Without this override Android kills the whole process (music and core) when the renderer dies.
    val client = Class.forName("com.baccarancia.mpfy.MainActivity\$Client", false, javaClass.classLoader)
    assertNotNull(client.getDeclaredMethod("onRenderProcessGone", WebView::class.java, RenderProcessGoneDetail::class.java))
  }
}
