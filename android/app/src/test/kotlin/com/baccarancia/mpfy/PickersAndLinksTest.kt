package com.baccarancia.mpfy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PickerSlotTest {
  @Test
  fun aDoubleTapOpensOnePickerAndItsAnswerGoesToTheFirstRequest() {
    val slot = PickerSlot()
    assertTrue(slot.open("r1"))
    // The second tap, before the picker covered the page: turned down (the caller answers it cancelled).
    assertFalse(slot.open("r2"))
    assertFalse(slot.open("r3"))
    assertEquals("r1", slot.answer())
    assertNull(slot.answer())
  }

  @Test
  fun afterThePickerAnsweredAnotherTapOpensIt() {
    // Picked, or cancelled: the next tap is a new pick and works at once.
    val slot = PickerSlot()
    assertTrue(slot.open("r1"))
    assertEquals("r1", slot.answer())
    assertTrue(slot.open("r2"))
    assertEquals("r2", slot.pending)
  }

  @Test
  fun aPickerThatCouldNotOpenFreesTheSlot() {
    val slot = PickerSlot()
    assertTrue(slot.open("r1"))
    slot.failed("r2") // not the one holding it
    assertEquals("r1", slot.pending)
    slot.failed("r1")
    assertNull(slot.pending)
    assertTrue(slot.open("r3"))
  }

  @Test
  fun theActivityOpensOnePickerOfEachKindAtATime() {
    val code = Sources.read("MainActivity.kt")
    for ((method, slot, answer) in listOf(
      Triple("override fun pickFolder(", "folderPicker", "Folders.walk(this, requestId, null)"),
      Triple("override fun pickProfileFile(", "profilePicker", "IdentityFile.onPicked(requestId, null)"),
    )) {
      val body = Sources.body(code, method)
      // Before anything is launched, the slot; a request turned down is answered cancelled.
      val guard = body.indexOf("if (!$slot.open(requestId)) {")
      assertTrue(method, guard >= 0 && guard < body.indexOf(".launch("))
      assertTrue(method, body.indexOf(answer) in guard until body.indexOf(".launch("))
      assertTrue(method, body.contains("$slot.failed(requestId)"))
      assertTrue(method, code.contains("val rid = $slot.answer() ?: return@registerForActivityResult"))
    }
    assertFalse(code.contains("folderRequest"))
    assertFalse(code.contains("profileRequest"))
  }
}

class OnceWithinTest {
  @Test
  fun theSameLinkTwiceWithinASecondOpensOnce() {
    val once = OnceWithin(1_000)
    assertTrue(once.allow("https://example.org/a", 50_000))
    assertFalse(once.allow("https://example.org/a", 50_150))
    assertFalse(once.allow("https://example.org/a", 50_999))
    // A second later it is a new tap.
    assertTrue(once.allow("https://example.org/a", 51_000))
  }

  @Test
  fun anotherLinkOpensAtOnce() {
    val once = OnceWithin(1_000)
    assertTrue(once.allow("https://example.org/a", 50_000))
    assertTrue(once.allow("https://example.org/b", 50_100))
    assertTrue(once.allow("https://example.org/a", 50_200))
  }

  @Test
  fun aClockThatWentBackDoesNotBlock() {
    val once = OnceWithin(1_000)
    assertTrue(once.allow("https://example.org/a", 50_000))
    assertTrue(once.allow("https://example.org/a", 10_000))
  }

  @Test
  fun everyLinkTheAppOpensGoesThroughOneGuard() {
    val activity = Sources.read("MainActivity.kt")
    val open = Sources.body(activity, "override fun openLink(")
    assertTrue(open.indexOf("links.allow(") in 0 until open.indexOf("startActivity("))
    // The page's links (openExternal) and a link the WebView was asked to follow.
    assertTrue(Sources.body(activity, "override fun shouldOverrideUrlLoading(", indent = 4).contains("openLink(u)"))
    assertEquals(1, activity.split("Intent.ACTION_VIEW").size - 1)
    val bridge = Sources.read("MPfyBridge.kt")
    assertTrue(Sources.body(bridge, "fun openExternal(").contains("host.openLink(u)"))
    assertFalse(bridge.contains("ACTION_VIEW"))
  }
}
