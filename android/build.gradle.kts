// AGP 9 compiles Kotlin itself (built-in Kotlin). It depends on an older Kotlin Gradle plugin;
// bare-kit-kotlin is compiled with Kotlin 2.4.20, so raise KGP the way the AGP 9.0 notes describe.
buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
  }
}

plugins {
  id("com.android.application") version "9.2.1" apply false
}
