pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
    // Bare Kit's Kotlin bindings are published only on JitPack. Restrict JitPack to that group.
    maven("https://jitpack.io") {
      content { includeGroup("com.github.holepunchto.bare-kit-kotlin") }
    }
  }
}

rootProject.name = "MPfy"
include(":app")
