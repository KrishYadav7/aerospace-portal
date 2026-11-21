package tech.aerogyan.store

import java.io.File

/**
 * Keeps the signed trust manifest (⭐ 1.0.2): the copy on disk (filesDir/trust.json, the last good one from the
 * server), the one bundled in the APK (assets/trust.json, from legacy-node/store/trust.json at build time) and the
 * highest version ever accepted ([lastSeen], never lowered — an older manifest is a rollback and is refused).
 * Puts the one in use into [Pins.manifest]. Every failure keeps what we have (and the built-in pins always apply).
 */
class TrustStore(
    private val file: File,
    private val bundled: () -> String?,
    private val lastSeen: VersionMemory,
    private val keys: List<String> = Pins.TRUST_KEYS,
) {
    /** The highest manifest version ever accepted (persisted). */
    interface VersionMemory {
        fun get(): Long
        fun set(v: Long)
    }

    @Volatile var current: TrustManifest? = null
        private set

    /** The last reason a manifest was refused (no secrets in it: versions, key ids, "expired …"). */
    @Volatile var lastError: String? = null
        private set

    /** At start: the stored and the bundled manifest, the highest valid version ≥ lastSeen wins. */
    @Synchronized
    fun load(nowMillis: Long = System.currentTimeMillis()): TrustManifest? {
        val min = lastSeen.get()
        var best: TrustManifest? = null
        var bestText: String? = null
        var fromBundle = false
        for ((text, isBundle) in listOf(readStored() to false, runCatching { bundled() }.getOrNull() to true)) {
            if (text == null) continue
            try {
                val m = Trust.verify(text, keys, nowMillis, min)
                if (best == null || m.version > best.version) {
                    best = m; bestText = text; fromBundle = isBundle
                }
            } catch (e: TrustException) {
                lastError = e.message
            }
        }
        if (best != null) {
            if (fromBundle && bestText != null) runCatching { write(bestText) }   // a newer store release brought a newer one
            use(best)
        }
        return best
    }

    /**
     * A manifest from the server: kept (file + lastSeen + [Pins.manifest]) when it verifies, is not older than
     * lastSeen and is strictly newer than the one in use. Returns true when it replaced it.
     */
    @Synchronized
    fun offer(text: String, nowMillis: Long = System.currentTimeMillis()): Boolean {
        val m = try {
            Trust.verify(text, keys, nowMillis, maxOf(lastSeen.get(), current?.version ?: 0))
        } catch (e: TrustException) {
            lastError = e.message
            return false
        }
        val cur = current
        if (cur != null && cur.validAt(nowMillis) && m.version <= cur.version) return false
        try {
            write(text)
        } catch (_: Exception) {
            // could not save it: still use it for this run
        }
        use(m)
        return true
    }

    private fun use(m: TrustManifest) {
        if (m.version > lastSeen.get()) lastSeen.set(m.version)
        current = m
        Pins.manifest = m
    }

    private fun readStored(): String? = runCatching { if (file.isFile && file.length() <= MAX_BYTES) file.readText() else null }.getOrNull()

    private fun write(text: String) {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
        }
    }

    companion object {
        const val MAX_BYTES = 256L * 1024
    }
}
