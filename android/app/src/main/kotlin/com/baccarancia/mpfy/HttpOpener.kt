package com.baccarancia.mpfy

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI

/**
 * HTTP/1.1 GET to the core over a plain socket: one request per connection (the core closes it
 * after the response), so [Upstream.abort] is a socket close, which unblocks a read in progress
 * at once from any thread, on Android and on the JVM of the tests alike.
 */
class HttpOpener(
  private val headers: Map<String, String>,
  private val connectMs: Int = CONNECT_MS,
  private val readMs: Int = READ_MS,
) : Opener {
  override fun open(url: String, headers: Map<String, String>): Upstream = open(url, headers, Abort())

  /** [abort] closes the socket: a connect or a wait for the head in progress ends at once. */
  override fun open(url: String, headers: Map<String, String>, abort: Abort): Upstream {
    val u = URI(url)
    val host = u.host
    if (u.scheme != "http" || host == null) throw IOException("not an http URL")
    val port = if (u.port < 0) 80 else u.port
    val path = u.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
    val target = if (u.rawQuery == null) path else "$path?${u.rawQuery}"
    val lines = ArrayList<String>()
    lines.add("GET $target HTTP/1.1")
    lines.add("Host: $host:$port")
    lines.add("User-Agent: MPfy")
    lines.add("Accept-Encoding: identity")
    lines.add("Connection: close")
    for ((k, v) in this.headers + headers) {
      if (k.any { it < ' ' } || v.any { it < ' ' }) throw IOException("bad header")
      lines.add("$k: $v")
    }
    val request = lines.joinToString(CRLF, postfix = CRLF + CRLF)
    val socket = Socket()
    abort.set { runCatching { socket.close() } }
    try {
      if (abort.isFired) throw IOException("aborted")
      socket.tcpNoDelay = true
      socket.connect(InetSocketAddress(host, port), connectMs)
      socket.soTimeout = readMs // also the wait for the head: the core's 6 s link wait plus a round trip
      val out = socket.getOutputStream()
      out.write(request.toByteArray(Charsets.ISO_8859_1))
      out.flush()
      val input = BufferedInputStream(socket.getInputStream(), 16 * 1024)
      // The core took the request: a head that never comes, or a cut one, is the source's silence.
      val head = try {
        readHead(input)
      } catch (e: IOException) {
        throw NoAnswerException(e)
      }
      return SocketResponse(socket, input, head)
    } catch (e: IOException) {
      runCatching { socket.close() }
      throw e
    }
  }

  private class Head(val status: Int, val fields: Map<String, String>)

  private fun readHead(input: InputStream): Head {
    val buf = ByteArrayOutputStream()
    var last4 = 0
    while (true) {
      val b = input.read()
      if (b < 0) throw EOFException("no response")
      buf.write(b)
      last4 = (last4 shl 8) or b
      if (last4 == END_OF_HEAD) break
      if (buf.size() > MAX_HEAD) throw IOException("response head too long")
    }
    val lines = String(buf.toByteArray(), Charsets.ISO_8859_1).split(CRLF)
    val first = lines[0].split(' ')
    if (first.size < 2 || !first[0].startsWith("HTTP/1.")) throw IOException("bad status line")
    val status = first[1].toIntOrNull()?.takeIf { it in 100..599 } ?: throw IOException("bad status line")
    val fields = HashMap<String, String>()
    for (line in lines.drop(1)) {
      val i = line.indexOf(':')
      if (i <= 0) continue
      fields.putIfAbsent(line.substring(0, i).trim().lowercase(), line.substring(i + 1).trim())
    }
    return Head(status, fields)
  }

  private class SocketResponse(private val socket: Socket, private val input: InputStream, head: Head) : Upstream {
    override val status = head.status
    override val etag: String? = head.fields["etag"]
    override val quality: String? = head.fields["x-mpfy-quality"]
    private val chunked = head.fields["transfer-encoding"]?.lowercase()?.contains("chunked") == true
    override val length: Long = if (chunked) -1 else head.fields["content-length"]?.toLongOrNull() ?: -1
    override val totalSize: Long = head.fields["content-range"]?.substringAfterLast('/')?.trim()?.toLongOrNull() ?: -1
    private var left = length
    private var chunkLeft = 0L
    private var ended = false
    @Volatile private var aborted = false

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (aborted) throw IOException("aborted")
      if (ended) return -1
      val n = try {
        when {
          chunked -> readChunked(buffer, offset, length)
          left == 0L -> -1
          left > 0 -> input.read(buffer, offset, minOf(length.toLong(), left).toInt()).also { if (it > 0) left -= it }
          else -> input.read(buffer, offset, length)
        }
      } catch (e: IOException) {
        if (aborted) throw IOException("aborted")
        throw e
      }
      if (aborted) throw IOException("aborted")
      if (n < 0) ended = true
      return n
    }

    private fun readChunked(buffer: ByteArray, offset: Int, length: Int): Int {
      if (chunkLeft == 0L) {
        val size = line().substringBefore(';').trim().toLongOrNull(16) ?: throw IOException("bad chunk")
        if (size == 0L) {
          while (line().isNotEmpty()) {
            // trailers
          }
          return -1
        }
        chunkLeft = size
      }
      val n = input.read(buffer, offset, minOf(length.toLong(), chunkLeft).toInt())
      if (n < 0) throw EOFException("cut in a chunk")
      chunkLeft -= n
      if (chunkLeft == 0L) line()
      return n
    }

    private fun line(): String {
      val sb = StringBuilder()
      while (true) {
        val b = input.read()
        if (b < 0) throw EOFException("cut in a chunk head")
        if (b == LF) return sb.toString().trimEnd(CR)
        if (sb.length > 1024) throw IOException("chunk head too long")
        sb.append(b.toChar())
      }
    }

    override fun abort() {
      aborted = true
      runCatching { socket.close() }
    }

    override fun close() = abort()
  }

  companion object {
    const val CONNECT_MS = 6_000

    // Also the wait for the head: the core's 6 s link wait plus a round trip.
    const val READ_MS = 8_000
    private const val MAX_HEAD = 64 * 1024
    private const val CR = '\r'
    private const val LF = '\n'.code
    private const val CRLF = "\r\n"
    private const val END_OF_HEAD = 0x0d0a0d0a
  }
}
