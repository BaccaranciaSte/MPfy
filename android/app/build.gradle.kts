plugins {
  id("com.android.application")
}

android {
  namespace = "com.baccarancia.mpfy"
  compileSdk = 36
  buildToolsVersion = "36.1.0" // installed; AGP 9.2's default 36.0.0 is not

  defaultConfig {
    applicationId = "com.baccarancia.mpfy"
    minSdk = 29
    targetSdk = 36
    versionCode = 13
    versionName = "1.1.1"
    // The phones are arm64 and the worklet's addons are linked for android-arm64 only. This also
    // drops the other three ABIs of libbare-kit.so that the AAR carries.
    ndk { abiFilters += "arm64-v8a" }
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  // The instrumented tests update the installed copy in place: they must be signed like it.
  // -Pmpfy.testBuildType=release (with MPFY_KEYSTORE) where a release-signed copy is installed.
  testBuildType = (findProperty("mpfy.testBuildType") as String?) ?: "debug"

  // The release key never lives in the repo: MPFY_KEYSTORE is its path, MPFY_KEYSTORE_PASS its password.
  // Every installed copy must come from this key, or later updates will not install over it.
  val releaseStore = System.getenv("MPFY_KEYSTORE")
  signingConfigs {
    if (releaseStore != null) {
      create("release") {
        storeFile = file(releaseStore)
        storeType = "PKCS12"
        storePassword = System.getenv("MPFY_KEYSTORE_PASS")
        keyAlias = "mpfy"
        keyPassword = System.getenv("MPFY_KEYSTORE_PASS")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      // -Pmpfy.diag=true: a release build that can be inspected (WebView DevTools, run-as), to chase a
      // bug on a phone that must keep its data. Never for the copies people install.
      isDebuggable = project.findProperty("mpfy.diag") == "true"
      signingConfig = if (releaseStore != null) signingConfigs.getByName("release") else null
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17 // built-in Kotlin's jvmTarget follows this
  }

  packaging {
    // Keep .so files uncompressed and page aligned in the APK (the default for minSdk >= 23).
    jniLibs { useLegacyPackaging = false }
  }
}

// The UI (web/ at the repo root, without its dev/ tools) goes into the APK as assets/web/...;
// the app copies it to filesDir/web-<versionCode> at the first start of each version
// (WebAssets.kt), where the worklet's client core serves it from.
abstract class CopyWebAssets : DefaultTask() {
  @get:InputDirectory
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val webDir: DirectoryProperty

  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

  @get:Inject
  abstract val fs: FileSystemOperations

  @TaskAction
  fun copy() {
    fs.sync {
      from(webDir) {
        exclude("dev/**", "**/*.mutant-backup", "**/*.bak", "**/*.orig", "**/.*")
      }
      into(outputDir.dir("web"))
    }
  }
}

val copyWebAssets = tasks.register<CopyWebAssets>("copyWebAssets") {
  webDir.set(rootProject.layout.projectDirectory.dir("../web"))
  outputDir.set(layout.buildDirectory.dir("generated/mpfy/webAssets"))
}

// The worklet bundle and its addons are built by `npm run build` in android/worklet,
// not by Gradle. Fail early with a clear message when they are missing, or when the bundle
// is older than the code it packs (an APK with yesterday's core).
val checkWorklet = tasks.register("checkWorklet") {
  val bundle = layout.projectDirectory.file("src/main/assets/app.bundle").asFile
  val libs = layout.projectDirectory.dir("src/main/jniLibs/arm64-v8a").asFile
  val repo = rootProject.layout.projectDirectory.dir("..").asFile
  val sources = listOf("client-core", "transport", "android/worklet/index.js", "package.json", "package-lock.json").map { File(repo, it) }
  doLast {
    check(bundle.isFile) { "Missing ${bundle}: run `npm run build` in android/worklet" }
    val names = libs.list()?.toSet() ?: emptySet()
    check("libc++_shared.so" in names) { "Missing libc++_shared.so in ${libs} (from NDK r30)" }
    check(names.any { it.startsWith("libudx-native.") }) { "Missing the linked addons in ${libs}: run `npm run build` in android/worklet" }
    val newer = sources.flatMap { f -> if (f.isDirectory) f.walkTopDown().filter { it.isFile && it.extension == "js" }.toList() else listOf(f) }
      .filter { it.isFile && it.lastModified() > bundle.lastModified() }
    check(newer.isEmpty()) { "${bundle.name} is older than ${newer.first().relativeTo(repo)}: run `npm run build` in android/worklet" }
  }
}
tasks.named("preBuild") { dependsOn(checkWorklet) }

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(copyWebAssets, CopyWebAssets::outputDir)
  }
}

// The worklet's JavaScript engine: "quickjs" (default) or "v8" (gradle.properties mpfy.jsEngine).
// With V8 the Mi A2 Lite (Android 10, Adreno 506) died at two starts out of four while drawing
// its first frame, right after the worklet started: the GPU driver could not map memory
// ("mmap failed errno 12", eglInitialize EGL_BAD_ALLOC, "Failed to create context"), most likely
// because of the large address space V8 reserves at start. QuickJS never did (six starts), is
// 43 MB smaller and streams at about 6 MB/s through the core. Both flavours have the same
// classes and API: depend on one only.
val jsEngine = providers.gradleProperty("mpfy.jsEngine").getOrElse("quickjs")
val bareKit = when (jsEngine) {
  "quickjs" -> "com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin-quickjs:v0.2.6"
  "v8" -> "com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin:v0.2.6"
  else -> error("mpfy.jsEngine must be quickjs or v8, not $jsEngine")
}

// Every JVM test by name in the build output, and one summary line per run.
tasks.withType<Test>().configureEach {
  testLogging {
    events("passed", "skipped", "failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
  afterSuite(
    KotlinClosure2<TestDescriptor, TestResult, Unit>({ d, r ->
      if (d.parent == null) {
        println("TESTS ${r.resultType}: ${r.testCount} run, ${r.successfulTestCount} passed, ${r.failedTestCount} failed, ${r.skippedTestCount} skipped")
      }
    }),
  )
}

dependencies {
  implementation(bareKit)
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

  implementation("androidx.core:core-ktx:1.18.0")
  implementation("androidx.activity:activity-ktx:1.13.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")

  implementation("androidx.media3:media3-exoplayer:1.11.1")
  implementation("androidx.media3:media3-session:1.11.1")
  implementation("androidx.media3:media3-datasource:1.11.1")
  implementation("androidx.media3:media3-database:1.11.1")

  // The QR scanner: the camera's picture (CameraX) and the decoder (ZXing core, Apache 2.0), both
  // on the phone alone: no Play Services, nothing that goes online.
  implementation("androidx.camera:camera-camera2:1.7.0")
  implementation("androidx.camera:camera-lifecycle:1.7.0")
  implementation("androidx.camera:camera-view:1.7.0")
  implementation("com.google.zxing:core:3.5.4")

  // JVM unit tests of the decisions in Policies.kt and of the manifest (src/test).
  testImplementation("junit:junit:4.13.2")

  // The car's library through a real MediaBrowser, on a phone (src/androidTest).
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
