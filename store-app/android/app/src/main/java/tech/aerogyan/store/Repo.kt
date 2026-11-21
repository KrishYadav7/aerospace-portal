package tech.aerogyan.store

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The catalogue (GET <base>/api/store?for=android, kept on disk for an offline start) and what is installed.
 * One per process (Repo.get).
 */
class Repo private constructor(private val app: Context) {
    private val cacheFile = File(app.filesDir, "catalogue.json")

    private val _catalog = MutableStateFlow<StoreCatalog?>(null)
    val catalog: StateFlow<StoreCatalog?> = _catalog

    private val _installed = MutableStateFlow<Map<String, Installed>>(emptyMap())
    val installed: StateFlow<Map<String, Installed>> = _installed

    /** the last fetch failed (the cached catalogue is shown) */
    private val _offline = MutableStateFlow(false)
    val offline: StateFlow<Boolean> = _offline

    /** the signed trust manifest (stored / bundled / from the server) — loaded first: the parser filters icons by host */
    private val trust = TrustStore(
        File(app.filesDir, "trust.json"),
        bundled = { app.assets.open("trust.json").use { it.readBytes().toString(Charsets.UTF_8) } },
        lastSeen = object : TrustStore.VersionMemory {
            private val p = app.getSharedPreferences("trust", Context.MODE_PRIVATE)
            override fun get(): Long = p.getLong("lastSeenVersion", 0L)
            override fun set(v: Long) { p.edit().putLong("lastSeenVersion", v).commit() }
        },
    )

    init {
        runCatching { trust.load() }
        runCatching { if (cacheFile.exists()) _catalog.value = CatalogParser.parse(cacheFile.readText()) }
    }

    val userAgent: String get() = "AeroGyanStore/${BuildConfig.VERSION_NAME} (Android ${android.os.Build.VERSION.RELEASE})"

    /** Fetches the catalogue; on failure keeps the last good one. Returns it (or null when there never was one). */
    suspend fun refresh(): StoreCatalog? = withContext(Dispatchers.IO) {
        refreshTrust()
        try {
            val url = URL(BuildConfig.STORE_BASE.trimEnd('/') + "/api/store?for=android")
            val c = url.openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.setRequestProperty("User-Agent", userAgent)
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("Cache-Control", "no-cache")
            val text = try {
                if (c.responseCode != 200) throw java.io.IOException("HTTP ${c.responseCode}")
                c.inputStream.bufferedReader().use { it.readText() }
            } finally {
                c.disconnect()
            }
            val parsed = CatalogParser.parse(text)
            val tmp = File(cacheFile.path + ".tmp")
            tmp.writeText(text)
            tmp.renameTo(cacheFile)
            _catalog.value = parsed
            _offline.value = false
        } catch (e: Exception) {
            _offline.value = true
        }
        refreshInstalled()
        _catalog.value
    }

    /**
     * GET <base>/api/store/trust: a newer validly signed manifest replaces ours. Any failure (404, network, bad
     * signature, a rollback, too big) keeps what we have.
     */
    private fun refreshTrust() {
        try {
            val c = URL(BuildConfig.STORE_BASE.trimEnd('/') + "/api/store/trust").openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.setRequestProperty("User-Agent", userAgent)
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("Cache-Control", "no-cache")
            val text = try {
                if (c.responseCode != 200) return
                if (c.contentLengthLong > TrustStore.MAX_BYTES) return
                val out = java.io.ByteArrayOutputStream()
                c.inputStream.use { input ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > TrustStore.MAX_BYTES) return
                    }
                }
                out.toByteArray().toString(Charsets.UTF_8)
            } finally {
                c.disconnect()
            }
            trust.offer(text)
        } catch (_: Exception) {
            // offline or no manifest on this server: the stored / bundled one (and the built-in pins) stay
        }
    }

    /** Reads the installed version of every catalogue package (and the store itself). */
    fun refreshInstalled() {
        val pkgs = (_catalog.value?.apps.orEmpty().mapNotNull { it.android?.packageName } + app.packageName).toSet()
        val out = HashMap<String, Installed>()
        for (p in pkgs) ApkInspector.installed(app, p)?.let { out[p] = it }
        _installed.value = out
    }

    fun setCatalogForTest(c: StoreCatalog) {
        _catalog.value = c
    }

    companion object {
        @Volatile private var instance: Repo? = null
        fun get(context: Context): Repo = instance ?: synchronized(this) {
            instance ?: Repo(context.applicationContext).also { instance = it }
        }
    }
}
