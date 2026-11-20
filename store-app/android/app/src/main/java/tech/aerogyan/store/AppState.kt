package tech.aerogyan.store

/** What the phone has of a package. */
data class Installed(
    val versionCode: Long,
    val versionName: String?,
    /** the store is the installer of record (updates can then be silent on Android 12+) */
    val byStore: Boolean,
)

/** What the card's button offers. */
enum class AppState {
    WEB_ONLY,       // no Android app (Drishya): open in the browser, say it needs a computer
    COMING_SOON,    // an Android app is planned but no file is published yet
    INCOMPATIBLE,   // needs a newer Android
    NOT_INSTALLED,  // Install
    UPDATE,         // Update
    INSTALLED,      // Open
}

object States {
    /** 1.0.10 > 1.0.9; "1.0.0-rc.2" < "1.0.0"; missing parts are 0. */
    fun compareVersions(a: String?, b: String?): Int {
        fun parts(v: String?): Pair<List<Int>, Int> {
            val s = v.orEmpty().trim().removePrefix("v")
            val main = s.substringBefore('-')
            val nums = main.split('.').map { p -> p.takeWhile { it.isDigit() }.toIntOrNull() ?: 0 }
            val rc = if (s.contains('-')) s.substringAfter('-').filter { it.isDigit() }.toIntOrNull() ?: 0 else Int.MAX_VALUE
            return nums to rc
        }
        val (x, rx) = parts(a)
        val (y, ry) = parts(b)
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return rx.compareTo(ry)
    }

    /** Is the catalogue's file newer than what is installed? versionCode when the catalogue has one, else versionName. */
    fun isNewer(file: AndroidFile, installed: Installed): Boolean {
        val vc = file.versionCode
        return if (vc != null) vc > installed.versionCode else compareVersions(file.version, installed.versionName) > 0
    }

    fun state(app: StoreApp, installed: Installed?, deviceSdk: Int): AppState {
        val f = app.android ?: return AppState.WEB_ONLY
        if (installed != null) {
            return if (f.available && f.minSdk <= deviceSdk && isNewer(f, installed)) AppState.UPDATE else AppState.INSTALLED
        }
        if (!f.available) return AppState.COMING_SOON
        if (f.minSdk > deviceSdk) return AppState.INCOMPATIBLE
        return AppState.NOT_INSTALLED
    }

    /** "For you": the apps of the chosen role (everyone-apps for all). The store itself is never in the list. */
    fun forYou(apps: List<StoreApp>, role: String): List<StoreApp> = apps.filter { a ->
        a.kind != "store" && when (role) {
            "student" -> "student" in a.audience || "everyone" in a.audience
            "professor" -> "professor" in a.audience || "everyone" in a.audience
            else -> "everyone" in a.audience || a.kind == "app"
        }
    }.sortedBy { rank(it) }

    private fun rank(a: StoreApp) = when {
        a.featured -> 0
        a.kind == "app" -> 1
        a.kind == "pack" -> 2
        else -> 3
    }

    /** Everything that has an update, the store itself first (it updates itself before the others). */
    fun updates(apps: List<StoreApp>, installed: Map<String, Installed>, deviceSdk: Int): List<StoreApp> =
        apps.filter { a -> a.android?.let { state(a, installed[it.packageName], deviceSdk) } == AppState.UPDATE }
            .sortedBy { if (it.kind == "store") 0 else 1 }
}
