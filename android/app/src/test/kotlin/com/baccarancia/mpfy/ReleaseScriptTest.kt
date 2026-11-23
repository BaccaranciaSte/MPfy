package com.baccarancia.mpfy

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * release.sh run for real in a throwaway repo whose gradlew fails the build: the Gradle daemon, which
 * saw the keystore password, is stopped all the same, and the version bump is undone. Needs Git Bash.
 */
class ReleaseScriptTest {
  private val bash = listOf("C:/Program Files/Git/bin/bash.exe", "/bin/bash", "/usr/bin/bash").map { File(it) }.firstOrNull { it.canExecute() }

  private fun script(): File = listOf(File("../release.sh"), File("release.sh")).first { it.isFile }

  private fun run(dir: File, vararg cmd: String): Int {
    val p = ProcessBuilder(*cmd).directory(dir).redirectErrorStream(true).start()
    val out = p.inputStream.bufferedReader().readText()
    assertTrue("${cmd.joinToString(" ")} hangs", p.waitFor(120, TimeUnit.SECONDS))
    println(out)
    return p.exitValue()
  }

  @Test
  fun aFailedBuildStopsTheGradleDaemonAndUndoesTheBump() {
    assumeTrue("no Git Bash", bash != null)
    val repo = Files.createTempDirectory("mpfy-release").toFile()
    try {
      val android = File(repo, "android").apply { mkdirs() }
      script().copyTo(File(android, "release.sh"))
      val gradle = File(android, "app/build.gradle.kts").apply {
        parentFile!!.mkdirs()
        writeText("android {\n  defaultConfig {\n    minSdk = 29\n    versionCode = 1\n    versionName = \"2.0.0\"\n  }\n}\n")
      }
      val util = File(repo, "web/js/util.js").apply {
        parentFile!!.mkdirs()
        writeText("export const APP_VERSION = '2.0.0';\n")
      }
      // A gradlew that writes down what it is asked and fails the build.
      File(android, "gradlew").writeText("#!/usr/bin/env bash\necho \"\$*\" >> \"\$(dirname \"\$0\")/../gradlew-calls.txt\"\n[ \"\$1\" = --stop ] && exit 0\nexit 1\n")
      File(repo, ".gitignore").writeText("gradlew-calls.txt\nstore.jks\n")
      val store = File(repo, "store.jks").apply { writeText("not a keystore") }
      val gradleBefore = gradle.readBytes()
      val utilBefore = util.readBytes()
      val git = arrayOf("-c", "user.name=test", "-c", "user.email=test@example.org", "-c", "core.autocrlf=false")
      assertTrue(run(repo, "git", "init", "-q") == 0)
      assertTrue(run(repo, "git", *git, "add", "-A") == 0)
      assertTrue(run(repo, "git", *git, "commit", "-q", "-m", "start") == 0)

      val pb = ProcessBuilder(bash!!.path, "android/release.sh", "2.1.0").directory(repo).redirectErrorStream(true)
      pb.environment()["MPFY_KEYSTORE"] = store.absolutePath.replace('\\', '/')
      pb.environment()["MPFY_KEYSTORE_PASS"] = "not-the-password"
      val p = pb.start()
      val out = p.inputStream.bufferedReader().readText()
      assertTrue("release.sh hangs", p.waitFor(120, TimeUnit.SECONDS))
      println(out)
      assertNotEquals(out, 0, p.exitValue())

      val calls = File(repo, "gradlew-calls.txt").readLines()
      assertTrue(out + calls, calls.any { it.startsWith("assembleRelease") })
      assertTrue("the daemon is stopped after a failed build: $calls", calls.last() == "--stop")
      assertArrayEquals("build.gradle.kts as it was", gradleBefore, gradle.readBytes())
      assertArrayEquals("util.js as it was", utilBefore, util.readBytes())
      assertTrue(out, out.contains("the version bump is undone"))
      assertTrue("nothing of the password on the screen", !out.contains("not-the-password"))
    } finally {
      repo.deleteRecursively()
    }
  }
}
