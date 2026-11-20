package tech.aerogyan.store

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger

/** Resumable downloads against a tiny local server: Range + If-Range, a server that ignores Range, cancel. */
class DownloaderTest {
    private lateinit var server: HttpServer
    private var body = ByteArray(300_000) { (it % 251).toByte() }
    private var etag = "\"v1\""
    private var honourRange = true
    private var dropAfter = -1 // close the connection after this many bytes (a broken mobile connection)
    private val ranged = AtomicInteger()
    private val full = AtomicInteger()
    private lateinit var base: String
    private lateinit var dir: File

    @Before fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/f.apk") { ex ->
            val range = ex.requestHeaders.getFirst("Range")
            val ifRange = ex.requestHeaders.getFirst("If-Range")
            ex.responseHeaders.add("ETag", etag)
            var start = 0
            if (honourRange && range != null && (ifRange == null || ifRange == etag)) {
                start = range.removePrefix("bytes=").substringBefore('-').toInt()
                ranged.incrementAndGet()
                ex.responseHeaders.add("Content-Range", "bytes $start-${body.size - 1}/${body.size}")
                ex.sendResponseHeaders(206, (body.size - start).toLong())
            } else {
                full.incrementAndGet()
                ex.sendResponseHeaders(200, body.size.toLong())
            }
            try {
                ex.responseBody.use { out ->
                    val end = if (dropAfter >= 0) minOf(body.size, start + dropAfter) else body.size
                    out.write(body, start, end - start)
                    if (end < body.size) throw java.io.IOException("drop")
                }
            } catch (_: Exception) {
            } finally {
                ex.close()
            }
        }
        server.start()
        base = "http://127.0.0.1:${server.address.port}"
        dir = java.nio.file.Files.createTempDirectory("dl").toFile()
    }

    @After fun stop() {
        server.stop(0)
        dir.deleteRecursively()
    }

    private fun dl() = Downloader("test", hostOk = { it.host == "127.0.0.1" }, connectTimeoutMs = 5000, readTimeoutMs = 5000)

    @Test fun downloadsWhole() {
        val part = File(dir, "a.apk")
        var last = 0L
        val n = dl().download("$base/f.apk", part, body.size.toLong(), { false }) { d, _ -> last = d }
        assertEquals(body.size.toLong(), n)
        assertEquals(body.size.toLong(), last)
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun resumesWithIfRange() {
        val part = File(dir, "a.apk")
        dropAfter = 100_000
        try {
            dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
            fail("the connection dropped")
        } catch (_: java.io.IOException) {
        }
        assertTrue(part.length() in 1..100_000)
        dropAfter = -1
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertEquals(1, ranged.get())
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun startsOverWhenTheServerIgnoresRange() {
        val part = File(dir, "a.apk")
        dropAfter = 50_000
        runCatching { dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> } }
        dropAfter = -1
        honourRange = false // the live nginx before deploy/store/nginx-ranges.sh
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertEquals(0, ranged.get())
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun aChangedFileIsFetchedWhole() {
        val part = File(dir, "a.apk")
        dropAfter = 50_000
        runCatching { dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> } }
        dropAfter = -1
        etag = "\"v2\""
        body = ByteArray(body.size) { (it % 13).toByte() }
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertArrayEquals("If-Range did not match: the new file, never half old + half new", body, part.readBytes())
    }

    @Test fun aCompletePartIsNotFetchedAgain() {
        val part = File(dir, "a.apk")
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        val before = full.get() + ranged.get()
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertEquals(before, full.get() + ranged.get())
    }

    @Test fun cancelStops() {
        val part = File(dir, "a.apk")
        try {
            dl().download("$base/f.apk", part, body.size.toLong(), { true }) { _, _ -> }
            fail("cancelled")
        } catch (_: Downloader.Cancelled) {
        }
    }

    @Test fun aWrongSizeIsRefused() {
        val part = File(dir, "a.apk")
        try {
            dl().download("$base/f.apk", part, body.size + 5L, { false }) { _, _ -> }
            fail("the server's file is not the listed size")
        } catch (e: Downloader.HttpError) {
            assertEquals(-2, e.code)
        }
    }

    @Test fun anUntrustedHostIsRefused() {
        val part = File(dir, "a.apk")
        try {
            Downloader("t", hostOk = { false }).download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
            fail("host")
        } catch (_: Downloader.BadHost) {
        }
        assertEquals(0L, if (part.exists()) part.length() else 0L)
    }
}
