package com.baccarancia.mpfy

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateInfoTest {
  private val signer = "eebd3974aeb11734bac7aa96c1dead16fde3ad4887b9a54d3d973158d51ea50e"
  private val other = "cae2bf403038ec0b6f14e0116b3736c3ffc25c291f6afca38b8b9e035931625e"
  private val sha = "a".repeat(64)

  private fun latest(edit: (MutableMap<String, Any?>) -> Unit = {}): MutableMap<String, Any?> {
    val o = linkedMapOf<String, Any?>(
      "format" to "mpfy-update", "v" to 1, "versionCode" to 2, "versionName" to "2.1.0",
      "url" to "https://github.com/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk",
      "size" to 41234567, "sha256" to sha, "signer" to signer, "minSdk" to 29,
    )
    edit(o)
    return o
  }

  // Through its text, as the app reads it.
  private fun info(o: Map<String, Any?>, installed: Long = 1, signers: Set<String> = setOf(signer), sdk: Int = 29, override: String? = null) =
    UpdateRules.info(Json.obj(Json.write(o))!!, installed, signers, sdk, override)

  @Test
  fun aValidNewerReleaseIsAnUpdate() {
    val i = info(latest())!!
    assertEquals(2L, i.versionCode)
    assertEquals("2.1.0", i.versionName)
    assertEquals(41234567L, i.size)
    assertEquals(sha, i.sha256)
  }

  @Test
  fun everyFieldOutOfItsRuleMeansNoUpdate() {
    val bad = listOf<(MutableMap<String, Any?>) -> Unit>(
      { it["format"] = "other" },
      { it["v"] = 2 },
      { it["versionCode"] = 1 },
      { it["versionCode"] = 0 },
      { it["versionCode"] = 2.5 },
      { it["versionCode"] = "2" },
      { it["versionName"] = "2.1" },
      { it["versionName"] = "v2.1.0" },
      { it["size"] = 0 },
      { it["size"] = 209_715_201 },
      { it["sha256"] = "A".repeat(64) },
      { it["sha256"] = "a".repeat(63) },
      { it["signer"] = "zz" },
      { it["minSdk"] = 30 },
      { it.remove("minSdk") },
      { it["url"] = "http://github.com/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk" },
      { it["url"] = "https://github.com/Someone/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk" },
      { it["url"] = "https://github.com.evil.example/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk" },
      { it["url"] = "https://github.com/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.zip" },
      { it["url"] = "https://user@github.com/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk" },
      { it["url"] = "https://github.com:8443/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk" },
      { it["url"] = "http://127.0.0.1:8099/MPfy-2.apk" },
    )
    for ((n, b) in bad.withIndex()) assertNull("case $n", info(latest(b)))
    assertNotNull(info(latest { it["minSdk"] = 28 }))
  }

  @Test
  fun aCopySignedWithAnotherKeyNeverSeesTheUpdate() {
    // A debug build: its signers do not hold the release key latest.json names.
    assertNull(info(latest(), signers = setOf(other)))
    assertNull(info(latest(), signers = emptySet()))
    assertNotNull(info(latest(), signers = setOf(other, signer)))
  }

  @Test
  fun theOverrideIsTakenOnlyByADebuggableBuildAndOnlyForLoopbackOrHttps() {
    assertEquals("http://127.0.0.1:8099/latest.json", UpdateRules.override("http://127.0.0.1:8099/latest.json", true))
    assertEquals("https://example.org/x/latest.json", UpdateRules.override("https://example.org/x/latest.json", true))
    assertNull(UpdateRules.override("http://127.0.0.1:8099/latest.json", false))
    assertNull(UpdateRules.override("http://localhost:8099/latest.json", true))
    assertNull(UpdateRules.override("http://192.168.1.2:8099/latest.json", true))
    assertNull(UpdateRules.override("http://127.0.0.1/latest.json", true))
    assertNull(UpdateRules.override("ftp://127.0.0.1:21/x", true))
    assertNull(UpdateRules.override("", true))
    assertEquals(UpdateRules.CHECK_URL, UpdateRules.checkUrl(null))
    assertEquals("http://127.0.0.1:8099/latest.json", UpdateRules.checkUrl("http://127.0.0.1:8099/latest.json"))
  }

  @Test
  fun withTheOverrideTheApkMayComeFromItsOwnOriginOnly() {
    val ov = "http://127.0.0.1:8099/latest.json"
    assertNotNull(info(latest { it["url"] = "http://127.0.0.1:8099/MPfy-2.apk" }, override = ov))
    assertNull(info(latest { it["url"] = "http://127.0.0.1:8098/MPfy-2.apk" }, override = ov))
    assertNull(info(latest { it["url"] = "https://127.0.0.1:8099/MPfy-2.apk" }, override = ov))
    assertNull(info(latest { it["url"] = "http://127.0.0.1:8099/MPfy-2.txt" }, override = ov))
    // The release channel stays allowed with an override too.
    assertNotNull(info(latest(), override = ov))
  }

  @Test
  fun eachAnswerOfACheckMeansItsOutcome() {
    val ok = Json.write(latest())
    fun out(status: Int, body: String?) = UpdateRules.outcome(status, body, 1, setOf(signer), 29, null)
    assertTrue(out(200, ok) is UpdateRules.Check.Newer)
    assertEquals(UpdateRules.Check.None, out(404, null))
    assertEquals(UpdateRules.Check.None, out(403, null))
    assertEquals(UpdateRules.Check.Failed, out(500, null))
    assertEquals(UpdateRules.Check.Failed, out(503, null))
    assertEquals(UpdateRules.Check.Failed, out(200, "{\"format\": "))
    assertEquals(UpdateRules.Check.None, out(200, null))
    assertEquals(UpdateRules.Check.None, out(200, "[]"))
    assertEquals(UpdateRules.Check.None, out(200, Json.write(latest { it["versionCode"] = 1 })))
  }

  @Test
  fun aCheckIsDueADayAfterTheLastOne() {
    val day = UpdateRules.DAY_MS
    assertTrue(UpdateRules.due(1_000, 0))
    assertFalse(UpdateRules.due(10 * day, 10 * day - 1))
    assertFalse(UpdateRules.due(10 * day + day - 1, 10 * day))
    assertTrue(UpdateRules.due(11 * day, 10 * day))
    assertTrue(UpdateRules.due(5 * day, 10 * day))
    assertEquals(day - 5_000, UpdateRules.nextIn(10 * day + 5_000, 10 * day))
    assertEquals(0L, UpdateRules.nextIn(12 * day, 10 * day))
  }

  @Test
  fun signerSetsMustBeEqualAndNotEmpty() {
    assertTrue(UpdateRules.sameSigners(setOf(signer), setOf(signer)))
    assertFalse(UpdateRules.sameSigners(setOf(signer), setOf(other)))
    assertFalse(UpdateRules.sameSigners(setOf(signer, other), setOf(signer)))
    assertFalse(UpdateRules.sameSigners(emptySet(), emptySet()))
    assertEquals("a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3", UpdateRules.sha256Hex("123".toByteArray()))
  }
}

class UpdateFilesTest {
  private fun tmp(): File = Files.createTempDirectory("mpfy-updates").toFile()

  @Test
  fun aFileMatchesOnlyWithItsSizeAndSha256() {
    val d = tmp()
    try {
      val f = File(d, "MPfy-2.apk")
      f.writeText("123")
      val sha = "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3"
      assertTrue(UpdateFiles.matches(f, 3, sha))
      assertFalse(UpdateFiles.matches(f, 4, sha))
      assertFalse(UpdateFiles.matches(f, 3, "b".repeat(64)))
      f.writeText("124")
      assertFalse(UpdateFiles.matches(f, 3, sha))
      assertFalse(UpdateFiles.matches(File(d, "none.apk"), 3, sha))
    } finally {
      d.deleteRecursively()
    }
  }

  @Test
  fun atStartOnlyThePendingApkStaysWhileItIsNewer() {
    val d = tmp()
    try {
      for (n in listOf("MPfy-3.apk", "MPfy-2.apk", "MPfy-4.apk.part", "junk")) File(d, n).writeText("x")
      val p = UpdatePending(3, "2.2.0", 1, "a".repeat(64), false)
      assertEquals(p, UpdateFiles.cleanup(d, p, installedCode = 2))
      assertEquals(listOf("MPfy-3.apk"), d.list()!!.toList())
      // Installed meanwhile: the record and the file go.
      assertNull(UpdateFiles.cleanup(d, p, installedCode = 3))
      assertEquals(emptyList<String>(), d.list()!!.toList())
      // The record names a file that is gone.
      assertNull(UpdateFiles.cleanup(d, p, installedCode = 1))
      File(d, "MPfy-3.apk").writeText("x")
      assertNull(UpdateFiles.cleanup(d, null, installedCode = 1))
      assertEquals(emptyList<String>(), d.list()!!.toList())
    } finally {
      d.deleteRecursively()
    }
  }

  @Test
  fun thePendingRecordSurvivesItsText() {
    val p = UpdatePending(7, "2.3.1", 123, "c".repeat(64), true)
    assertEquals(p, UpdatePending.parse(p.toJson()))
    assertNull(UpdatePending.parse("{"))
    assertNull(UpdatePending.parse(null))
  }
}

/** Records what the machine asks; the test answers like the slow work would. */
private class FakeHost : UpdateMachine.Host {
  val events = ArrayList<String>()
  var pendingRec: UpdatePending? = null
  val files = HashSet<Long>()
  var downloads = 0
  var verifies = ArrayList<Pair<UpdatePending, Boolean>>()
  var installAllowed = true
  var settingsOpened = 0
  var commits = ArrayList<UpdatePending>()
  var confirms = ArrayList<Any>()

  override fun emit(state: UpdateMachine.State, versionName: String, progress: Double, failed: Boolean) {
    events.add(state.wire + (if (failed) "!" else "") + (if (state == UpdateMachine.State.DOWNLOADING) " $progress" else ""))
  }

  override fun pending() = pendingRec

  override fun setPending(p: UpdatePending?) {
    pendingRec = p
  }

  override fun apkExists(versionCode: Long) = versionCode in files

  override fun deleteFiles() {
    files.clear()
  }

  override fun download(info: UpdateInfo) {
    downloads++
  }

  override fun verify(p: UpdatePending, full: Boolean) {
    verifies.add(p to full)
  }

  override fun canInstall() = installAllowed

  override fun openInstallSettings(): Boolean {
    settingsOpened++
    return true
  }

  override fun commit(p: UpdatePending) {
    commits.add(p)
  }

  override fun startConfirm(confirm: Any): Boolean {
    confirms.add(confirm)
    return true
  }
}

class UpdateMachineTest {
  private val info = UpdateInfo(2, "2.1.0", "https://github.com/BaccaranciaSte/MPfy/releases/download/v2.1.0/MPfy-2.1.0.apk", 100, "a".repeat(64), "b".repeat(64), 29)
  private val host = FakeHost()
  private val m = UpdateMachine(host)

  private fun available() {
    m.checked(UpdateRules.Check.Newer(info))
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
  }

  /** Download done and both checks passed. */
  private fun downloadedAndVerified() {
    m.startUpdate()
    assertEquals(UpdateMachine.State.DOWNLOADING, m.state)
    host.files.add(2)
    m.downloaded(true)
    assertEquals(true, host.verifies.last().second)
    m.verified(true)
  }

  @Test
  fun aNewerReleaseMakesItAvailableAndNoneTakesItAway() {
    assertEquals(UpdateMachine.State.NONE, m.state)
    available()
    m.checked(UpdateRules.Check.None)
    assertEquals(UpdateMachine.State.NONE, m.state)
    assertEquals(listOf("available", "none"), host.events)
  }

  @Test
  fun aFailedCheckKeepsTheStateAsItIs() {
    available()
    m.checked(UpdateRules.Check.Failed)
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals(listOf("available"), host.events)
  }

  @Test
  fun aCheckDuringADownloadOrAnInstallIsIgnored() {
    available()
    m.startUpdate()
    assertFalse(m.canCheck())
    m.checked(UpdateRules.Check.None)
    assertEquals(UpdateMachine.State.DOWNLOADING, m.state)
    host.files.add(2)
    m.resumed()
    m.downloaded(true)
    m.verified(true)
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
    m.checked(UpdateRules.Check.None)
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
  }

  @Test
  fun aDownloadFailureGoesBackToAvailableWithFailed() {
    available()
    m.startUpdate()
    m.progressed(0.42)
    m.downloaded(false)
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals(listOf("available", "downloading 0.0", "downloading 0.42", "available!"), host.events)
    assertNull(host.pendingRec)
    // The next tap downloads again.
    m.startUpdate()
    assertEquals(2, host.downloads)
  }

  @Test
  fun aFailedCheckOfTheFileClearsEverythingAndSaysSo() {
    available()
    m.resumed()
    m.startUpdate()
    host.files.add(2)
    m.downloaded(true)
    m.verified(false)
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals("available!", host.events.last())
    assertNull(host.pendingRec)
    assertTrue(host.files.isEmpty())
    assertTrue(host.commits.isEmpty())
  }

  @Test
  fun aPendingApkThatFailsItsSecondCheckIsDroppedWithItsRecord() {
    available()
    downloadedAndVerified()
    assertNotNull(host.pendingRec)
    m.resumed()
    m.installerStatus(UpdateMachine.STATUS_FAILURE_ABORTED, null, inFront = true)
    m.startUpdate()
    assertEquals(UpdatePending.of(info) to false, host.verifies.last())
    m.verified(false)
    assertEquals("available!", host.events.last())
    assertNull(host.pendingRec)
    assertTrue(host.files.isEmpty())
    // The next tap downloads again.
    m.startUpdate()
    assertEquals(2, host.downloads)
  }

  @Test
  fun theInstallStepsRunOnlyWhileResumed() {
    available()
    downloadedAndVerified()
    // Finished in the background: back to the full ring, the APK pending.
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals(UpdatePending.of(info), host.pendingRec)
    assertTrue(host.commits.isEmpty())
    // The next resume of this process goes on by itself.
    m.resumed()
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
    assertEquals(listOf(UpdatePending.of(info)), host.commits)
  }

  @Test
  fun thePendingApkSurvivesARestartAndTheNextTapInstallsWithoutADownload() {
    available()
    downloadedAndVerified()
    // A new process: a new machine, the record and the file still there.
    val again = UpdateMachine(host)
    host.events.clear()
    again.started(host.pendingRec)
    assertEquals(UpdateMachine.State.AVAILABLE, again.state)
    again.resumed()
    // A resume alone does not install after a restart: it waits for the tap.
    assertTrue(host.commits.isEmpty())
    again.checked(UpdateRules.Check.Newer(info))
    again.startUpdate()
    assertEquals(1, host.downloads)
    assertEquals(UpdatePending.of(info) to false, host.verifies.last())
    again.verified(true)
    assertEquals(UpdateMachine.State.INSTALLING, again.state)
    assertEquals(1, host.commits.size)
  }

  @Test
  fun aNewerReleaseThanThePendingOneIsDownloaded() {
    available()
    downloadedAndVerified()
    val newer = info.copy(versionCode = 3, versionName = "2.2.0", sha256 = "c".repeat(64))
    m.checked(UpdateRules.Check.Newer(newer))
    m.startUpdate()
    assertEquals(2, host.downloads)
    assertNull(host.pendingRec)
    assertEquals(UpdateMachine.State.DOWNLOADING, m.state)
  }

  @Test
  fun unknownSourcesGoesToSettingsAndOnTheWayBack() {
    host.installAllowed = false
    available()
    m.resumed()
    downloadedAndVerified()
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
    assertEquals(1, host.settingsOpened)
    assertTrue(host.pendingRec!!.settings)
    m.paused()
    // Not granted: available, no toast, the APK kept; the next tap comes straight back to this step.
    m.resumed()
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals("available", host.events.last())
    assertFalse(host.pendingRec!!.settings)
    assertTrue(2L in host.files)
    m.startUpdate()
    assertEquals(1, host.downloads)
    m.verified(true)
    assertEquals(2, host.settingsOpened)
    // Granted this time, even after a restart: checked again, then committed.
    m.paused()
    host.installAllowed = true
    val again = UpdateMachine(host)
    again.started(host.pendingRec)
    again.resumed()
    assertEquals(UpdateMachine.State.INSTALLING, again.state)
    assertEquals(false, host.verifies.last().second)
    again.verified(true)
    assertEquals(1, host.commits.size)
  }

  @Test
  fun aConfirmAskedInTheBackgroundIsHeldAndStartedAtResume() {
    available()
    m.resumed()
    downloadedAndVerified()
    assertEquals(1, host.commits.size)
    m.paused()
    val confirm = Any()
    m.installerStatus(UpdateMachine.STATUS_PENDING_USER_ACTION, confirm, inFront = false)
    assertTrue(host.confirms.isEmpty())
    m.resumed()
    assertEquals(listOf(confirm), host.confirms)
    // In front: at once.
    val second = Any()
    m.installerStatus(UpdateMachine.STATUS_PENDING_USER_ACTION, second, inFront = true)
    assertEquals(listOf(confirm, second), host.confirms)
  }

  @Test
  fun aConfirmLeftWithHomeGivesTheButtonBackAndTheNextTapAsksAgain() {
    available()
    m.resumed()
    downloadedAndVerified()
    assertEquals(1, host.commits.size)
    val confirm = Any()
    m.installerStatus(UpdateMachine.STATUS_PENDING_USER_ACTION, confirm, inFront = true)
    assertEquals(listOf(confirm), host.confirms)
    // Under the confirm's dialog the app is only paused: its answer is awaited.
    m.paused()
    m.resumed()
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
    // Home instead of an answer: the installer says nothing, so the button comes back.
    m.paused()
    m.stopped()
    m.resumed()
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals("available", host.events.last())
    assertEquals(UpdatePending.of(info), host.pendingRec)
    assertTrue(2L in host.files)
    m.startUpdate()
    assertEquals(1, host.downloads)
    m.verified(true)
    assertEquals(2, host.commits.size)
    assertEquals(UpdateMachine.State.INSTALLING, m.state)
  }

  @Test
  fun aCancelKeepsTheApkAndAnyOtherFailureSaysSo() {
    available()
    m.resumed()
    downloadedAndVerified()
    m.installerStatus(UpdateMachine.STATUS_FAILURE_ABORTED, null, inFront = true)
    assertEquals(UpdateMachine.State.AVAILABLE, m.state)
    assertEquals("available", host.events.last())
    assertNotNull(host.pendingRec)
    m.startUpdate()
    m.verified(true)
    assertEquals(2, host.commits.size)
    m.installerStatus(1, null, inFront = true)
    assertEquals("available!", host.events.last())
    assertNull(host.pendingRec)
    m.installerStatus(UpdateMachine.STATUS_SUCCESS, null, inFront = true)
    assertEquals("available!", host.events.last())
  }

  @Test
  fun aTapOutsideAvailableDoesNothing() {
    m.startUpdate()
    assertEquals(0, host.downloads)
    available()
    m.startUpdate()
    m.startUpdate()
    assertEquals(1, host.downloads)
  }
}

class InstallSessionTest {
  private val log = ArrayList<String>()

  private fun run(write: (Int) -> Unit) =
    InstallSession.run({ 7 }, write, { log.add("commit $it") }, { log.add("abandon $it") })

  @Test
  fun aSessionThatFailsWhileWrittenIsAbandoned() {
    try {
      run { throw java.io.IOException("no space left") }
      throw AssertionError("expected the IOException")
    } catch (e: java.io.IOException) {
      assertEquals("no space left", e.message)
    }
    assertEquals(listOf("abandon 7"), log)
  }

  @Test
  fun aWrittenSessionIsCommittedAndNeverAbandoned() {
    run { log.add("write $it") }
    assertEquals(listOf("write 7", "commit 7"), log)
  }
}
