package tech.aerogyan.store

import org.json.JSONArray
import org.json.JSONObject

/** The Android file of an app (GET /api/store → apps[].platforms.android). */
data class AndroidFile(
    val available: Boolean,
    val packageName: String,
    val minSdk: Int,
    val version: String,
    val versionCode: Long?,
    val size: Long,
    val sha256: String?,
    val url: String?,
    val fileName: String?,
    val updatedAt: String?,
    val notes: String?,
)

/** One entry of the catalogue. */
data class StoreApp(
    val id: String,
    val kind: String,          // store | app | pack | office
    val product: String,
    val name: String,
    val nameHi: String?,
    val short: String?,
    val line: String?,
    val lineHi: String?,
    val description: String?,
    val descriptionHi: String?,
    val features: List<String>,
    val audience: List<String>, // student | professor | everyone
    val category: String?,
    val color: String?,
    val icon: String?,
    val web: String?,
    val featured: Boolean,
    val needsComputer: Boolean,
    val includes: List<String>,
    val android: AndroidFile?,
) {
    fun title(hindi: Boolean): String = nameHi?.takeIf { hindi && it.isNotBlank() } ?: name
    fun subtitle(hindi: Boolean): String = lineHi?.takeIf { hindi && it.isNotBlank() } ?: line.orEmpty()
    fun about(hindi: Boolean): String {
        val d = descriptionHi?.takeIf { hindi && it.isNotBlank() } ?: description
        return d?.takeIf { it.isNotBlank() } ?: subtitle(hindi)
    }

    /** Web-only on a phone: no Android build at all (Drishya) — never pretend it installs. */
    val webOnly: Boolean get() = android == null

    fun matches(query: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        return listOfNotNull(name, nameHi, short, line, lineHi, category, android?.packageName)
            .any { it.lowercase().contains(q) } || features.any { it.lowercase().contains(q) }
    }
}

data class StoreCatalog(val generatedAt: String?, val apps: List<StoreApp>) {
    fun byId(id: String) = apps.firstOrNull { it.id == id }
    val self: StoreApp? get() = apps.firstOrNull { it.android?.packageName == "tech.aerogyan.store" }
}

object CatalogParser {
    private val HEX64 = Regex("[0-9a-f]{64}")

    fun parse(json: String): StoreCatalog {
        val root = JSONObject(json)
        if (!root.optBoolean("success", false)) throw IllegalArgumentException("catalogue says success=false")
        val list = root.optJSONArray("apps") ?: JSONArray()
        val apps = ArrayList<StoreApp>(list.length())
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            parseApp(o)?.let { apps += it }
        }
        return StoreCatalog(root.optStringOrNull("generatedAt"), apps)
    }

    private fun parseApp(o: JSONObject): StoreApp? {
        val id = o.optStringOrNull("id") ?: return null
        val name = o.optStringOrNull("name") ?: return null
        val plats = o.optJSONObject("platforms")
        val a = plats?.optJSONObject("android")
        val android = a?.let { parseAndroid(it) }
        return StoreApp(
            id = id,
            kind = o.optStringOrNull("kind") ?: "app",
            product = o.optStringOrNull("product") ?: id,
            name = name,
            nameHi = o.optStringOrNull("nameHi"),
            short = o.optStringOrNull("short"),
            line = o.optStringOrNull("line"),
            lineHi = o.optStringOrNull("lineHi"),
            description = o.optStringOrNull("description"),
            descriptionHi = o.optStringOrNull("descriptionHi"),
            features = o.optJSONArray("features").strings(),
            audience = o.optJSONArray("audience").strings().ifEmpty { listOf("everyone") },
            category = o.optStringOrNull("category"),
            color = o.optStringOrNull("color"),
            icon = o.optStringOrNull("icon")?.takeIf { Pins.isTrustedUrl(it) },
            web = o.optStringOrNull("web")?.takeIf { it.startsWith("https://") },
            featured = o.optBoolean("featured", false),
            needsComputer = o.optBoolean("needsComputer", false),
            includes = o.optJSONArray("includes").strings(),
            android = android,
        )
    }

    private fun parseAndroid(a: JSONObject): AndroidFile? {
        val pkg = a.optStringOrNull("package") ?: return null
        val vc = if (a.has("versionCode") && !a.isNull("versionCode")) a.optLong("versionCode", 0L).takeIf { it > 0 } else null
        val sha = a.optStringOrNull("sha256")?.lowercase()?.takeIf { HEX64.matches(it) }
        return AndroidFile(
            available = a.optBoolean("available", false),
            packageName = pkg,
            minSdk = a.optInt("minSdk", 0),
            version = a.optStringOrNull("version").orEmpty(),
            versionCode = vc,
            size = a.optLong("size", 0L),
            sha256 = sha,
            url = a.optStringOrNull("url"),
            fileName = a.optStringOrNull("fileName"),
            updatedAt = a.optStringOrNull("updatedAt"),
            notes = a.optStringOrNull("notes"),
        )
    }

    private fun JSONObject.optStringOrNull(k: String): String? =
        if (has(k) && !isNull(k)) optString(k, "").takeIf { it.isNotBlank() } else null

    private fun JSONArray?.strings(): List<String> {
        if (this == null) return emptyList()
        val out = ArrayList<String>(length())
        for (i in 0 until length()) optString(i, "").takeIf { it.isNotBlank() }?.let { out += it }
        return out
    }
}
