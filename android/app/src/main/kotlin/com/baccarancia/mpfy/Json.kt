package com.baccarancia.mpfy

/**
 * A strict JSON reader and writer free of Android classes: org.json is only a stub in the JVM
 * tests, and the snapshot and latest.json are decided there. Objects are LinkedHashMaps, arrays
 * lists, integral numbers Long, other numbers Double.
 */
object Json {
  class Error(message: String) : Exception(message)

  private const val MAX_DEPTH = 64

  fun parse(text: String): Any? {
    val r = Reader(text)
    r.space()
    val v = r.value(0)
    r.space()
    if (r.i != text.length) throw Error("text after the value at ${r.i}")
    return v
  }

  /** The parsed object, or null when [text] is not one. */
  @Suppress("UNCHECKED_CAST")
  fun obj(text: String): Map<String, Any?>? = runCatching { parse(text) as? Map<String, Any?> }.getOrNull()

  private class Reader(val s: String) {
    var i = 0

    fun space() {
      while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
    }

    fun value(depth: Int): Any? {
      if (depth > MAX_DEPTH) throw Error("too deep")
      if (i >= s.length) throw Error("unexpected end")
      return when (val c = s[i]) {
        '{' -> obj(depth)
        '[' -> arr(depth)
        '"' -> str()
        't' -> word("true", true)
        'f' -> word("false", false)
        'n' -> word("null", null)
        else -> if (c == '-' || c in '0'..'9') num() else throw Error("unexpected '$c' at $i")
      }
    }

    private fun word(w: String, v: Any?): Any? {
      if (!s.startsWith(w, i)) throw Error("bad literal at $i")
      i += w.length
      return v
    }

    private fun obj(depth: Int): Map<String, Any?> {
      i++
      val m = LinkedHashMap<String, Any?>()
      space()
      if (i < s.length && s[i] == '}') {
        i++
        return m
      }
      while (true) {
        space()
        if (i >= s.length || s[i] != '"') throw Error("expected a key at $i")
        val k = str()
        space()
        if (i >= s.length || s[i] != ':') throw Error("expected ':' at $i")
        i++
        space()
        m[k] = value(depth + 1)
        space()
        if (i >= s.length) throw Error("unexpected end")
        when (s[i++]) {
          ',' -> continue
          '}' -> return m
          else -> throw Error("expected ',' or '}' at ${i - 1}")
        }
      }
    }

    private fun arr(depth: Int): List<Any?> {
      i++
      val a = ArrayList<Any?>()
      space()
      if (i < s.length && s[i] == ']') {
        i++
        return a
      }
      while (true) {
        space()
        a.add(value(depth + 1))
        space()
        if (i >= s.length) throw Error("unexpected end")
        when (s[i++]) {
          ',' -> continue
          ']' -> return a
          else -> throw Error("expected ',' or ']' at ${i - 1}")
        }
      }
    }

    private fun str(): String {
      i++
      val b = StringBuilder()
      while (true) {
        if (i >= s.length) throw Error("unterminated string")
        val c = s[i++]
        when {
          c == '"' -> return b.toString()
          c == '\\' -> {
            if (i >= s.length) throw Error("unterminated escape")
            when (val e = s[i++]) {
              '"' -> b.append('"')
              '\\' -> b.append('\\')
              '/' -> b.append('/')
              'b' -> b.append('\b')
              'f' -> b.append('\u000c')
              'n' -> b.append('\n')
              'r' -> b.append('\r')
              't' -> b.append('\t')
              'u' -> {
                if (i + 4 > s.length) throw Error("bad \\u escape")
                val h = s.substring(i, i + 4).toIntOrNull(16) ?: throw Error("bad \\u escape")
                b.append(h.toChar())
                i += 4
              }
              else -> throw Error("bad escape '\\$e'")
            }
          }
          c < ' ' -> throw Error("control character in a string")
          else -> b.append(c)
        }
      }
    }

    private fun num(): Any {
      val start = i
      if (s[i] == '-') i++
      if (i >= s.length) throw Error("bad number")
      if (s[i] == '0') {
        i++
      } else if (s[i] in '1'..'9') {
        while (i < s.length && s[i] in '0'..'9') i++
      } else {
        throw Error("bad number")
      }
      var integral = true
      if (i < s.length && s[i] == '.') {
        integral = false
        i++
        if (i >= s.length || s[i] !in '0'..'9') throw Error("bad number")
        while (i < s.length && s[i] in '0'..'9') i++
      }
      if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
        integral = false
        i++
        if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
        if (i >= s.length || s[i] !in '0'..'9') throw Error("bad number")
        while (i < s.length && s[i] in '0'..'9') i++
      }
      val t = s.substring(start, i)
      if (integral) t.toLongOrNull()?.let { return it }
      return t.toDouble()
    }
  }

  /** Maps, lists, strings, numbers, booleans and null as JSON text. */
  fun write(v: Any?): String = StringBuilder().also { writeTo(it, v) }.toString()

  private fun writeTo(b: StringBuilder, v: Any?) {
    when (v) {
      null -> b.append("null")
      is String -> quote(b, v)
      is Boolean -> b.append(if (v) "true" else "false")
      is Int, is Long -> b.append(v.toString())
      is Number -> {
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite()) b.append("null")
        else if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append(d.toLong().toString())
        else b.append(d.toString())
      }
      is Map<*, *> -> {
        b.append('{')
        var first = true
        for ((k, x) in v) {
          if (!first) b.append(',')
          first = false
          quote(b, k.toString())
          b.append(':')
          writeTo(b, x)
        }
        b.append('}')
      }
      is Iterable<*> -> {
        b.append('[')
        var first = true
        for (x in v) {
          if (!first) b.append(',')
          first = false
          writeTo(b, x)
        }
        b.append(']')
      }
      else -> quote(b, v.toString())
    }
  }

  private fun quote(b: StringBuilder, s: String) {
    b.append('"')
    for (c in s) {
      when {
        c == '"' -> b.append("\\\"")
        c == '\\' -> b.append("\\\\")
        c == '\n' -> b.append("\\n")
        c == '\r' -> b.append("\\r")
        c == '\t' -> b.append("\\t")
        c < ' ' || c == '\u2028' || c == '\u2029' -> b.append("\\u%04x".format(c.code))
        else -> b.append(c)
      }
    }
    b.append('"')
  }

  // Typed reads of a parsed object; null when the field is missing or of another type.
  fun Map<String, Any?>.str(k: String): String? = this[k] as? String

  fun Map<String, Any?>.long(k: String): Long? = this[k] as? Long

  fun Map<String, Any?>.bool(k: String): Boolean? = this[k] as? Boolean

  @Suppress("UNCHECKED_CAST")
  fun Map<String, Any?>.map(k: String): Map<String, Any?>? = this[k] as? Map<String, Any?>

  fun Map<String, Any?>.list(k: String): List<Any?>? = this[k] as? List<Any?>
}
