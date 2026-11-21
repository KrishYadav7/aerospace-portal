package tech.aerogyan.store

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/** What the downloaded APK says about itself (ApkInspector reads it with PackageManager). */
data class ApkFacts(
    val packageName: String,
    val versionCode: Long,
    val versionName: String?,
    val minSdk: Int,
    /** SHA-256 of every CURRENT signing certificate (lowercase hex) */
    val signers: List<String>,
)

/** What the catalogue promised for the file. */
data class Expected(
    val packageName: String,
    val url: String?,
    val sha256: String?,
    val versionCode: Long?,
)

enum class Reason {
    BAD_URL,            // not https on one of our hosts
    NO_HASH,            // the catalogue has no SHA-256 for it yet
    HASH_MISMATCH,      // the file is not the one the catalogue describes
    NOT_APK,            // Android could not read it as an app
    NOT_OURS,           // a package the store never installs
    PACKAGE_MISMATCH,   // another app than the one asked for
    WRONG_SIGNER,       // not signed with the pinned key
    OLDER_THAN_LISTED,  // the server sent an older build than it lists (a rollback)
    NOT_NEWER,          // same or older than what is installed (a downgrade)
    NEEDS_NEWER_ANDROID,
    BELOW_MINIMUM,      // older than the lowest version the signed trust manifest allows (a known-bad build)
}

sealed class Verdict {
    object Ok : Verdict()
    data class Rejected(val reason: Reason, val detail: String) : Verdict()
}

/**
 * Every check between "downloaded" and "installed". Pure Kotlin, so every rule has a unit test (VerifierTest).
 * A file that fails any check is deleted and never handed to the system installer.
 */
object Verifier {

    /** Before downloading: only https from our own hosts, and only packages we pin. */
    fun checkBeforeDownload(expected: Expected): Verdict {
        if (!Pins.isTrustedUrl(expected.url)) return Verdict.Rejected(Reason.BAD_URL, expected.url.orEmpty())
        if (Pins.signersFor(expected.packageName).isEmpty()) return Verdict.Rejected(Reason.NOT_OURS, expected.packageName)
        val min = Pins.minVersionCode(expected.packageName)
        if (min != null && expected.versionCode != null && expected.versionCode < min) {
            return Verdict.Rejected(Reason.BELOW_MINIMUM, "${expected.versionCode} < $min")
        }
        if (expected.sha256.isNullOrBlank()) return Verdict.Rejected(Reason.NO_HASH, expected.packageName)
        return Verdict.Ok
    }

    /**
     * After downloading. [fileSha256] is the hash of the file on disk, [facts] what Android read from it (null: not an
     * app), [installedVersionCode] the version on the phone (null: not installed).
     */
    fun verify(expected: Expected, fileSha256: String, facts: ApkFacts?, installedVersionCode: Long?, deviceSdk: Int): Verdict {
        checkBeforeDownload(expected).let { if (it != Verdict.Ok) return it }
        val want = expected.sha256!!.lowercase()
        if (!fileSha256.equals(want, ignoreCase = true)) {
            return Verdict.Rejected(Reason.HASH_MISMATCH, "sha256 $fileSha256, catalogue $want")
        }
        if (facts == null) return Verdict.Rejected(Reason.NOT_APK, "")
        if (facts.packageName != expected.packageName) {
            return Verdict.Rejected(Reason.PACKAGE_MISMATCH, "${facts.packageName} ≠ ${expected.packageName}")
        }
        val pinned = Pins.signersFor(facts.packageName)
        if (pinned.isEmpty()) return Verdict.Rejected(Reason.NOT_OURS, facts.packageName)
        val signers = facts.signers.map { Pins.normalize(it) }
        if (signers.isEmpty() || signers.any { it !in pinned }) {
            return Verdict.Rejected(Reason.WRONG_SIGNER, signers.joinToString())
        }
        val listed = expected.versionCode
        if (listed != null && facts.versionCode < listed) {
            return Verdict.Rejected(Reason.OLDER_THAN_LISTED, "${facts.versionCode} < $listed")
        }
        val min = Pins.minVersionCode(facts.packageName)
        if (min != null && facts.versionCode < min) {
            return Verdict.Rejected(Reason.BELOW_MINIMUM, "${facts.versionCode} < $min")
        }
        if (installedVersionCode != null && facts.versionCode <= installedVersionCode) {
            return Verdict.Rejected(Reason.NOT_NEWER, "${facts.versionCode} ≤ $installedVersionCode")
        }
        if (facts.minSdk > deviceSdk) return Verdict.Rejected(Reason.NEEDS_NEWER_ANDROID, "${facts.minSdk} > $deviceSdk")
        return Verdict.Ok
    }

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
