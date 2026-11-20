package tech.aerogyan.store

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** Resumable downloads against a local server: Range + If-Range, a server that ignores Range, cancel. */
class DownloaderTest {
    private lateinit var server: MockWebServer
    private var body = ByteArray(300_000) { (it % 251).toByte() }
    private var etag = "\"v1\""
    private var honourRange = true
    private var drop = false // close the connection halfway (a broken mobile connection)
    private val ranged = AtomicInteger()
    private val full = AtomicInteger()
    private lateinit var base: String
    private lateinit var dir: File

    @Before fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.getHeader("Range")
                val ifRange = request.getHeader("If-Range")
                val r = MockResponse().setHeader("ETag", etag)
                var start = 0
                if (honourRange && range != null && (ifRange == null || ifRange == etag)) {
                    start = range.removePrefix("bytes=").substringBefore('-').toInt()
                    ranged.incrementAndGet()
                    r.setResponseCode(206).setHeader("Content-Range", "bytes $start-${body.size - 1}/${body.size}")
                } else {
                    full.incrementAndGet()
                    r.setResponseCode(200)
                }
                r.setBody(Buffer().write(body, start, body.size - start))
                if (drop) r.setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                return r
            }
        }
        server.start()
        base = server.url("/").toString().trimEnd('/')
        dir = java.nio.file.Files.createTempDirectory("dl").toFile()
    }

    @After fun stop() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private fun dl() = Downloader("test", hostOk = { it.host == server.hostName }, connectTimeoutMs = 5000, readTimeoutMs = 5000)

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
        drop = true
        try {
            dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
            fail("the connection dropped")
        } catch (_: java.io.IOException) {
        }
        assertTrue("half a file: ${part.length()}", part.length() in 1 until body.size)
        drop = false
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertEquals(1, ranged.get())
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun startsOverWhenTheServerIgnoresRange() {
        val part = File(dir, "a.apk")
        drop = true
        runCatching { dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> } }
        drop = false
        honourRange = false // the live nginx before deploy/store/nginx-ranges.sh
        dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> }
        assertEquals(0, ranged.get())
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun aChangedFileIsFetchedWhole() {
        val part = File(dir, "a.apk")
        drop = true
        runCatching { dl().download("$base/f.apk", part, body.size.toLong(), { false }) { _, _ -> } }
        drop = false
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
