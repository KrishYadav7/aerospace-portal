package tech.aerogyan.store

import android.content.Context
import android.content.SharedPreferences

/** The store's few settings (backed up; no account, no secrets). */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("store", Context.MODE_PRIVATE)

    /** student | professor | everyone; "" until the first-run question is answered */
    var role: String
        get() = p.getString("role", "").orEmpty()
        set(v) = p.edit().putString("role", v).apply()

    val onboarded: Boolean get() = role.isNotEmpty()

    /** big downloads (above [BIG_BYTES]) wait for Wi-Fi */
    var wifiOnlyBig: Boolean
        get() = p.getBoolean("wifiOnlyBig", true)
        set(v) = p.edit().putBoolean("wifiOnlyBig", v).apply()

    /** install updates by themselves on Wi-Fi (silent for apps the store installed) */
    var autoUpdate: Boolean
        get() = p.getBoolean("autoUpdate", false)
        set(v) = p.edit().putBoolean("autoUpdate", v).apply()

    /** the daily "N updates available" notification */
    var notifyUpdates: Boolean
        get() = p.getBoolean("notifyUpdates", true)
        set(v) = p.edit().putBoolean("notifyUpdates", v).apply()

    /** the updates last announced (so the same ones are not announced every day) */
    var lastAnnounced: String
        get() = p.getString("lastAnnounced", "").orEmpty()
        set(v) = p.edit().putString("lastAnnounced", v).apply()

    var askedNotifications: Boolean
        get() = p.getBoolean("askedNotifications", false)
        set(v) = p.edit().putBoolean("askedNotifications", v).apply()

    companion object {
        const val BIG_BYTES = 50L * 1024 * 1024
    }
}
