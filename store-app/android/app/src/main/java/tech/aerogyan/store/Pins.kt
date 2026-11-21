package tech.aerogyan.store

import java.net.URI
import java.util.Locale

/**
 * What the store trusts — compiled in, never taken from the server. A compromised server can change the catalogue,
 * but it cannot make the store install an app that is not signed by one of these keys, nor download from another host.
 *
 * Fingerprints are the SHA-256 of the signing certificate (lowercase hex, no colons). A package may list more than one
 * so a future key rotation can add the new key in a store update before the apps move to it.
 */
object Pins {
    const val AEROGYAN = "74a1df87c347394e78ca4b67c6730f07d683cfd3f9198d3e0e0a45a178ac4480"
    const val MEDICO = "6214a862d32cc3716f655400a4a2ab725f6f31840b8f8a65c97349c826f5b55b"
    const val GANAK = "4c7195adb92278c062e04f908ea970d3344f87878233471b8fcaa1afacfd0b59"
    // ⭐ 1.0.1 (2026-11-21) — each read from the live APK's v2 signing block (and the site's assetlinks.json) before pinning
    const val SANKALAK = "80f61bbc361870938647650cc009bb50811a341f1a8d93474539b46740e65791"
    const val SHILP = "8463839a290414edea99120272bc6d3d8c367b63ab6d28eedad3d69611900035"
    const val INDPAY = "540c133a60eec3de967456d640f5ef8fdd93c880abedbcb670feb1107fbc0582"
    const val GANIT = "310290068a24bea0781c838214068a3bff1c24b7eaf05aa5050bfe9c7c014778"
    const val STORE = "0968c5016f2f7732d6f12dd14adf018de261e031214a006cf98927877ed2a8f3"

    /** Hosts the store downloads from (https only). */
    val HOSTS: Set<String> = setOf("aerogyan.tech", "medico.aerogyan.tech", "drishya.aerogyan.tech", "ganak.aerogyan.tech",
        "sankalak.aerogyan.tech", "shilp.aerogyan.tech", "indpay.aerogyan.tech", "ganit.aerogyan.tech")

    private val exact: Map<String, Set<String>> = mapOf(
        "tech.aerogyan.app" to setOf(AEROGYAN),
        "tech.aerogyan.medico" to setOf(MEDICO),
        "tech.aerogyan.ganak" to setOf(GANAK),
        "tech.aerogyan.sankalak" to setOf(SANKALAK),
        "tech.aerogyan.shilp" to setOf(SHILP),
        "tech.aerogyan.indpay" to setOf(INDPAY),
        "tech.aerogyan.ganit" to setOf(GANIT),
        "tech.aerogyan.store" to setOf(STORE),
    )
    private val SLUG = Regex("[a-z][a-z0-9]{0,31}")

    /** The pinned certificate fingerprints for a package, or empty when the store must never install it. */
    fun signersFor(pkg: String): Set<String> {
        exact[pkg]?.let { return it }
        for (prefix in listOf("tech.aerogyan.office.", "tech.aerogyan.pack.")) {
            if (pkg.startsWith(prefix) && SLUG.matches(pkg.removePrefix(prefix))) return setOf(AEROGYAN)
        }
        return emptySet()
    }

    /** Who signs the package, for "Verified: signed by …". */
    fun signerName(pkg: String): String? = when (signersFor(pkg).firstOrNull()) {
        AEROGYAN -> "AeroGyan"
        MEDICO -> "Jivan Medico"
        GANAK -> "Ganak"
        SANKALAK -> "Sankalak"
        SHILP -> "Shilp"
        INDPAY -> "IndPay"
        GANIT -> "Ganit"
        STORE -> "AeroGyan Store"
        else -> null
    }

    /** https on one of HOSTS, no user info, default port. */
    fun isTrustedUrl(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        return try {
            val u = URI(url)
            u.scheme?.lowercase(Locale.ROOT) == "https" &&
                u.host?.lowercase(Locale.ROOT) in HOSTS &&
                u.rawUserInfo == null &&
                (u.port == -1 || u.port == 443)
        } catch (_: Exception) {
            false
        }
    }

    /** "AB:CD…" or "abcd…" → "abcd…" */
    fun normalize(fp: String): String = fp.replace(":", "").trim().lowercase(Locale.ROOT)
}
