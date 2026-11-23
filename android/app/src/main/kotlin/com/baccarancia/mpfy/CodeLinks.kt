package com.baccarancia.mpfy

import android.content.Intent
import java.util.Locale

/**
 * The links the app's QR codes carry, which the scanner reads and the phone's own camera app opens
 * the app with:
 *   mpfy://collega?p=<profile code>&s=<source code>&s=...   a profile and the sources it uses
 *   mpfy://fonte?s=<source code>                            one source
 * A code goes in with or without its dashes, in any case. The page gets the link back whole, in
 * this form, and parses it again (web/js/links.js); anything else (another scheme, a host of
 * someone else's, a code that is not one) never reaches it.
 */
object CodeLinks {
  /** More sources than this in one link: not a link of ours. */
  const val MAX_SOURCES = 20

  data class Link(val profile: String?, val sources: List<String>) {
    /** The link as the page reads it, the codes without their dashes. */
    fun text(): String =
      if (profile == null) "mpfy://fonte?s=${sources.single()}" else "mpfy://collega?p=$profile" + sources.joinToString("") { "&s=$it" }
  }

  private val LINK = Regex("^mpfy://(collega|fonte)/?\\?([^#\\s]*)$", RegexOption.IGNORE_CASE)
  // Crockford base32 as the codes are typed: I, L and O are read as 1 and 0, U is never one.
  private val CODE_CHARS = Regex("^[0-9A-TV-Z]+$")

  /** A code as written in a link, or typed: uppercase, without spaces and dashes. */
  private fun squeeze(code: String): String = code.uppercase(Locale.ROOT).replace(Regex("[\\s\\-_]"), "")

  /** The squeezed code when [code] is a profile code (56 characters, 61 with MPFYP), else null. */
  fun profileCode(code: String): String? {
    val s = squeeze(code)
    val ok = (s.length == 56 || (s.length == 61 && s.startsWith("MPFYP"))) && CODE_CHARS.matches(s)
    return s.takeIf { ok }
  }

  /** The squeezed code when [code] is a source code (32 characters, 36 with MPFY), else null. */
  fun sourceCode(code: String): String? {
    val s = squeeze(code)
    val ok = (s.length == 32 || (s.length == 36 && s.startsWith("MPFY"))) && CODE_CHARS.matches(s)
    return s.takeIf { ok }
  }

  /** A link of ours, or null. Any p or s that is not a code of its kind makes the whole link null. */
  fun parse(raw: String): Link? {
    val m = LINK.matchEntire(raw.trim()) ?: return null
    val collega = m.groupValues[1].equals("collega", ignoreCase = true)
    var profile: String? = null
    val sources = ArrayList<String>()
    for (part in m.groupValues[2].split('&')) {
      if (part.isEmpty()) continue
      val eq = part.indexOf('=')
      if (eq < 0) continue
      val key = part.substring(0, eq).lowercase(Locale.ROOT)
      val value = part.substring(eq + 1)
      when (key) {
        "p" -> {
          if (!collega || profile != null) return null
          profile = profileCode(value) ?: return null
        }
        "s" -> {
          val s = sourceCode(value) ?: return null
          if (s !in sources) sources.add(s)
        }
      }
    }
    if (sources.size > MAX_SOURCES) return null
    if (collega) return profile?.let { Link(it, sources) }
    return if (sources.size == 1) Link(null, sources) else null
  }

  /** What the scanner hands the page: a link of ours (in its own form) or a bare code as read; null for anything else. */
  fun scanned(text: String): String? {
    parse(text)?.let { return it.text() }
    val t = text.trim()
    return t.takeIf { profileCode(it) != null || sourceCode(it) != null }
  }

  /**
   * The code MainActivity opens the add screen with (#aggiungi=): the extra "code" as given, else
   * the link of a VIEW intent (the camera app, a tapped link) when it is one of ours.
   */
  fun codeOf(action: String?, data: String?, extra: String?): String? {
    extra?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    if (action != Intent.ACTION_VIEW || data == null) return null
    return parse(data)?.text()
  }
}
