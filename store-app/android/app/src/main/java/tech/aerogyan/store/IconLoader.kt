package tech.aerogyan.store

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** App icons: memory (LRU) → disk (cacheDir/icons, a week) → https from our own hosts only. */
object IconLoader {
    private val mem = LruCache<String, Bitmap>(80)
    private val locks = HashMap<String, Mutex>()

    private fun key(url: String) = MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

    fun cached(url: String): Bitmap? = mem.get(url)

    suspend fun load(context: Context, url: String): Bitmap? {
        mem.get(url)?.let { return it }
        if (!Pins.isTrustedUrl(url)) return null
        val lock = synchronized(locks) { locks.getOrPut(url) { Mutex() } }
        return lock.withLock {
            mem.get(url) ?: withContext(Dispatchers.IO) {
                val dir = File(context.cacheDir, "icons").apply { mkdirs() }
                val f = File(dir, key(url) + ".png")
                val fresh = f.exists() && System.currentTimeMillis() - f.lastModified() < 7L * 24 * 3600 * 1000
                if (!fresh) {
                    try {
                        val c = URL(url).openConnection() as HttpURLConnection
                        c.connectTimeout = 10_000
                        c.readTimeout = 20_000
                        c.setRequestProperty("User-Agent", Repo.get(context).userAgent)
                        try {
                            if (c.responseCode == 200 && Pins.isTrustedUrl(c.url.toString())) {
                                val bytes = c.inputStream.use { it.readBytes() }
                                if (bytes.size in 1..2_000_000) {
                                    val tmp = File(dir, f.name + ".tmp")
                                    tmp.writeBytes(bytes)
                                    tmp.renameTo(f)
                                }
                            }
                        } finally {
                            c.disconnect()
                        }
                    } catch (_: Exception) { /* keep an old copy if there is one */ }
                }
                val bmp = if (f.exists()) BitmapFactory.decodeFile(f.path) else null
                bmp?.also { mem.put(url, it) }
            }
        }
    }
}
