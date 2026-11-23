package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the phone's music access is asked for, and how: the system's dialog, or the app's page in the settings. */
class MediaAccessTest {
  private val dialog = MusicAccess.Step.DIALOG
  private val settings = MusicAccess.Step.SETTINGS
  private val nothing = MusicAccess.Step.NOTHING

  @Test
  fun theFirstShowAsksOnlyWhenNeverAskedAndNotGranted() {
    assertEquals(dialog, MusicAccess.step("first", granted = false, asked = false, rationale = false))
    assertEquals(nothing, MusicAccess.step("first", granted = false, asked = true, rationale = false))
    assertEquals(nothing, MusicAccess.step("first", granted = false, asked = true, rationale = true))
    assertEquals(nothing, MusicAccess.step("first", granted = true, asked = false, rationale = false))
  }

  @Test
  fun theSettingsRowAsksWhileAndroidMayStillShowTheDialogElseOpensTheSettings() {
    // Never asked (an upgrade that has not shown the app yet), or refused once: the dialog.
    assertEquals(dialog, MusicAccess.step("settings", granted = false, asked = false, rationale = false))
    assertEquals(dialog, MusicAccess.step("settings", granted = false, asked = true, rationale = true))
    // Refused for good: Android would not show it, so the app's page where "Musica e audio" is turned on.
    assertEquals(settings, MusicAccess.step("settings", granted = false, asked = true, rationale = false))
    assertEquals(nothing, MusicAccess.step("settings", granted = true, asked = true, rationale = false))
  }

  @Test
  fun anythingElseDoesNothing() {
    assertEquals(nothing, MusicAccess.step("", granted = false, asked = false, rationale = false))
    assertEquals(nothing, MusicAccess.step("always", granted = false, asked = true, rationale = false))
  }

  @Test
  fun aNoThatCameBackAtOnceWasNeverOnScreen() {
    // Android answers by itself, in a few milliseconds, when it will not show the dialog any more.
    assertTrue(MusicAccess.unseen(granted = false, rationale = false, ms = 40))
    assertFalse(MusicAccess.unseen(granted = false, rationale = false, ms = 2_000))
    assertFalse(MusicAccess.unseen(granted = false, rationale = true, ms = 40))
    assertFalse(MusicAccess.unseen(granted = true, rationale = false, ms = 40))
  }

  @Test
  fun thePageReadsGrantedOrOff() {
    assertEquals("granted", MusicAccess.state(true))
    assertEquals("off", MusicAccess.state(false))
  }
}
