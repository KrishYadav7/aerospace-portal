package tech.aerogyan.store

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Properties

/**
 * Resumable download into [part] (+ "<part>.meta": url, ETag, Last-Modified, total). A second call continues where
 * the first stopped: Range: bytes=<have>- with If-Range = the ETag (or Last-Modified) of the first answer, so a file
 * that changed on the server in between is fetched whole (200) instead of being glued to the old half.
 * A server that ignores Range (200) starts over from 0. A part file that already has the full size is not asked for.
 */
class Downloader(
    private val userAgent: String,
    /** checked on every answer, after redirects: is this host one we trust? */
    private val hostOk: (URL) -> Boolean,
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 45_000,
) {
    class Cancelled : IOException("cancelled")
    class BadHost(url: URL) : IOException("untrusted host ${url.host}")
    class HttpError(val code: Int) : IOException("HTTP $code")

    fun interface Progress {
        fun onProgress(done: Long, total: Long)
    }

    /** Downloads [url] to [part]; returns the number of bytes. [expectedSize] (> 0) bounds the file. */
    fun download(url: String, part: File, expectedSize: Long, isCancelled: () -> Boolean, progress: Progress): Long {
        val metaFile = File(part.path + ".meta")
        val meta = Properties()
        if (metaFile.exists()) runCatching { metaFile.inputStream().use { meta.load(it) } }
        if (meta.getProperty("url") != url) { // another file was here: start clean
            part.delete()
            meta.clear()
        }
        var have = if (part.exists()) part.length() else 0L
        if (expectedSize > 0 && have > expectedSize) {
            part.delete(); have = 0
        }
        if (expectedSize > 0 && have == expectedSize) {
            progress.onProgress(have, expectedSize)
            return have
        }
        val validator = meta.getProperty("etag")?.takeIf { it.isNotBlank() } ?: meta.getProperty("lastModified")?.takeIf { it.isNotBlank() }
        if (have > 0 && validator == null) { // nothing to prove the half is from the same file
            part.delete(); have = 0
        }
        if (isCancelled()) throw Cancelled()
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", userAgent)
            setRequestProperty("Accept-Encoding", "identity")
            if (have > 0) {
                setRequestProperty("Range", "bytes=$have-")
                setRequestProperty("If-Range", validator)
            }
        }
        try {
            val code = conn.responseCode
            if (!hostOk(conn.url)) throw BadHost(conn.url)
            val append: Boolean
            val total: Long
            when (code) {
                HttpURLConnection.HTTP_PARTIAL -> {
                    val cr = conn.getHeaderField("Content-Range").orEmpty() // bytes 10-99/100
                    val start = Regex("""bytes (\d+)-""").find(cr)?.groupValues?.get(1)?.toLongOrNull()
                    if (start != have) { // not where we are: start over
                        conn.disconnect()
                        part.delete(); metaFile.delete()
                        return download(url, part, expectedSize, isCancelled, progress)
                    }
                    append = true
                    total = cr.substringAfter('/', "").toLongOrNull() ?: (have + conn.contentLengthLong.coerceAtLeast(0))
                }
                HttpURLConnection.HTTP_OK -> {
                    append = false
                    have = 0
                    total = conn.contentLengthLong.takeIf { it > 0 } ?: expectedSize
                }
                416 -> { // the part is complete (or the file changed): verify what we have, else start over
                    conn.disconnect()
                    if (expectedSize > 0 && part.length() == expectedSize) return expectedSize
                    part.delete(); metaFile.delete()
                    return download(url, part, expectedSize, isCancelled, progress)
                }
                else -> {
                    // an Express-style 500 to a range past the end of a complete file
                    if (have > 0 && expectedSize > 0 && have == expectedSize) return have
                    throw HttpError(code)
                }
            }
            if (expectedSize > 0 && total > 0 && total != expectedSize) throw HttpError(-2) // not the listed file
            meta.setProperty("url", url)
            val etag = conn.getHeaderField("ETag")
            if (etag != null) meta.setProperty("etag", etag) else meta.remove("etag")
            val lastModified = conn.getHeaderField("Last-Modified")
            if (lastModified != null) meta.setProperty("lastModified", lastModified) else meta.remove("lastModified")
            meta.setProperty("total", total.toString())
            metaFile.outputStream().use { meta.store(it, null) }

            var done = have
            var lastReport = 0L
            conn.inputStream.use { input ->
                FileOutputStream(part, append).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (isCancelled()) throw Cancelled()
                        val n = try {
                            input.read(buf)
                        } catch (e: InterruptedIOException) {
                            if (isCancelled()) throw Cancelled() else throw e
                        }
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (expectedSize > 0 && done > expectedSize) throw HttpError(-3) // longer than listed
                        val now = System.currentTimeMillis()
                        if (now - lastReport > 250) {
                            lastReport = now
                            progress.onProgress(done, total)
                        }
                    }
                }
            }
            progress.onProgress(done, total)
            if (total > 0 && done != total) throw IOException("incomplete: $done of $total")
            return done
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        fun cleanup(part: File) {
            part.delete()
            File(part.path + ".meta").delete()
        }
    }
}
