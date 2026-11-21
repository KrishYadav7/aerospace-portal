package tech.aerogyan.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every rule between "downloaded" and "installed". */
class VerifierTest {
    private val sha = "1aceb4c23bbde60952f5dceb352dc7c25b4f400056fde982e8c125284ea53171"
    private val expected = Expected("tech.aerogyan.app", "https://aerogyan.tech/download/android", sha, 20)
    private val good = ApkFacts("tech.aerogyan.app", 20, "1.0.20", 24, listOf(Pins.AEROGYAN))

    private fun reason(v: Verdict): Reason? = (v as? Verdict.Rejected)?.reason

    @Test fun goodFileIsAccepted() {
        assertEquals(Verdict.Ok, Verifier.verify(expected, sha, good, null, 34))
        // an update over an older install
        assertEquals(Verdict.Ok, Verifier.verify(expected, sha.uppercase(), good, 19, 34))
    }

    @Test fun wrongHashIsRejected() {
        assertEquals(Reason.HASH_MISMATCH, reason(Verifier.verify(expected, "0".repeat(64), good, null, 34)))
    }

    @Test fun missingHashIsRejectedBeforeDownload() {
        val e = expected.copy(sha256 = null)
        assertEquals(Reason.NO_HASH, reason(Verifier.checkBeforeDownload(e)))
        assertEquals(Reason.NO_HASH, reason(Verifier.verify(e, sha, good, null, 34)))
    }

    @Test fun wrongCertificateIsRejected() {
        // signed by Jivan Medico's key, but claims to be AeroGyan
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(expected, sha, good.copy(signers = listOf(Pins.MEDICO)), null, 34)))
        // an attacker's key
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(expected, sha, good.copy(signers = listOf("ab".repeat(32))), null, 34)))
        // two signers, one of them foreign
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(expected, sha, good.copy(signers = listOf(Pins.AEROGYAN, "cd".repeat(32))), null, 34)))
        // no signer at all
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(expected, sha, good.copy(signers = emptyList()), null, 34)))
        // the colon form of the right key is fine
        val colon = Pins.AEROGYAN.uppercase().chunked(2).joinToString(":")
        assertEquals(Verdict.Ok, Verifier.verify(expected, sha, good.copy(signers = listOf(colon)), null, 34))
    }

    @Test fun eachProductHasItsOwnKey() {
        val medico = Expected("tech.aerogyan.medico", "https://medico.aerogyan.tech/download/android", sha, null)
        val f = ApkFacts("tech.aerogyan.medico", 1, "1.0.0", 24, listOf(Pins.MEDICO))
        assertEquals(Verdict.Ok, Verifier.verify(medico, sha, f, null, 34))
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(medico, sha, f.copy(signers = listOf(Pins.AEROGYAN)), null, 34)))
        val store = Expected("tech.aerogyan.store", "https://aerogyan.tech/download/store/android", sha, 10002)
        val s = ApkFacts("tech.aerogyan.store", 10002, "1.0.2", 26, listOf(Pins.STORE))
        assertEquals(Verdict.Ok, Verifier.verify(store, sha, s, 10001, 34))
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(store, sha, s.copy(signers = listOf(Pins.AEROGYAN)), 10001, 34)))
        val office = Expected("tech.aerogyan.office.sheets", "https://aerogyan.tech/download/office/sheets/android", sha, 5)
        assertEquals(Verdict.Ok, Verifier.verify(office, sha, ApkFacts("tech.aerogyan.office.sheets", 5, "1.0.5", 24, listOf(Pins.AEROGYAN)), null, 34))
    }

    // ⭐ 1.0.1 — Sankalak, Shilp, IndPay and Ganit: each installs only with its own key; any other key (ours included) is refused
    @Test fun newProductsArePinnedToTheirOwnKeys() {
        val products = listOf(
            Triple("tech.aerogyan.sankalak", "https://sankalak.aerogyan.tech/download/android", "80f61bbc361870938647650cc009bb50811a341f1a8d93474539b46740e65791"),
            Triple("tech.aerogyan.shilp", "https://shilp.aerogyan.tech/download/android", "8463839a290414edea99120272bc6d3d8c367b63ab6d28eedad3d69611900035"),
            Triple("tech.aerogyan.indpay", "https://indpay.aerogyan.tech/download/android", "540c133a60eec3de967456d640f5ef8fdd93c880abedbcb670feb1107fbc0582"),
            // Ganit's files are at /dl/<file>
            Triple("tech.aerogyan.ganit", "https://ganit.aerogyan.tech/dl/Ganit-1.0.0.apk", "310290068a24bea0781c838214068a3bff1c24b7eaf05aa5050bfe9c7c014778"),
        )
        val everyKey = listOf(Pins.AEROGYAN, Pins.MEDICO, Pins.GANAK, Pins.STORE, Pins.SANKALAK, Pins.SHILP, Pins.INDPAY, Pins.GANIT)
        assertEquals("eight different keys", everyKey.size, everyKey.toSet().size)
        for ((pkg, url, fp) in products) {
            assertEquals(pkg, setOf(fp), Pins.signersFor(pkg))
            assertTrue(url, Pins.isTrustedUrl(url))
            val e = Expected(pkg, url, sha, 100)
            assertEquals(pkg, Verdict.Ok, Verifier.checkBeforeDownload(e))
            val f = ApkFacts(pkg, 100, "0.1.0", 24, listOf(fp))
            assertEquals(pkg, Verdict.Ok, Verifier.verify(e, sha, f, null, 34))
            // the colon / upper-case form of the right key (as apksigner prints it) is the same key
            assertEquals(pkg, Verdict.Ok, Verifier.verify(e, sha, f.copy(signers = listOf(fp.uppercase().chunked(2).joinToString(":"))), null, 34))
            // every other key we know, an attacker's key, a second foreign signer, no signer: refused
            for (other in everyKey.filter { it != fp } + listOf("ab".repeat(32), fp.dropLast(2) + "00")) {
                assertEquals("$pkg signed by $other", Reason.WRONG_SIGNER, reason(Verifier.verify(e, sha, f.copy(signers = listOf(other)), null, 34)))
            }
            assertEquals(pkg, Reason.WRONG_SIGNER, reason(Verifier.verify(e, sha, f.copy(signers = listOf(fp, "cd".repeat(32))), null, 34)))
            assertEquals(pkg, Reason.WRONG_SIGNER, reason(Verifier.verify(e, sha, f.copy(signers = emptyList()), null, 34)))
            // a correctly signed file of ANOTHER of our apps under this product's name
            assertEquals(pkg, Reason.PACKAGE_MISMATCH, reason(Verifier.verify(e, sha, ApkFacts("tech.aerogyan.ganak", 100, "1.0.0", 24, listOf(Pins.GANAK)), null, 34)))
            // the right key, but older than what the catalogue lists
            assertEquals(pkg, Reason.OLDER_THAN_LISTED, reason(Verifier.verify(e, sha, f.copy(versionCode = 99), null, 34)))
        }
        assertEquals("Sankalak", Pins.signerName("tech.aerogyan.sankalak"))
        assertEquals("Shilp", Pins.signerName("tech.aerogyan.shilp"))
        assertEquals("IndPay", Pins.signerName("tech.aerogyan.indpay"))
        assertEquals("Ganit", Pins.signerName("tech.aerogyan.ganit"))
        // Ganit and Ganak are different apps with different keys
        assertTrue(Pins.GANIT != Pins.GANAK && Pins.signersFor("tech.aerogyan.ganit") != Pins.signersFor("tech.aerogyan.ganak"))
        // look-alikes of the new names are not ours
        for (p in listOf("tech.aerogyan.indpay2", "tech.aerogyan.shilp.debug", "tech.aerogyan.Sankalak", "tech.aerogyan.indpa")) {
            assertTrue(p, Pins.signersFor(p).isEmpty())
        }
        // IndPay needs Android 8 (minSdk 26)
        val ip = Expected("tech.aerogyan.indpay", "https://indpay.aerogyan.tech/download/android", sha, 100)
        assertEquals(Reason.NEEDS_NEWER_ANDROID, reason(Verifier.verify(ip, sha, ApkFacts("tech.aerogyan.indpay", 100, "0.1.0", 26, listOf(Pins.INDPAY)), null, 25)))
        // new hosts only on https, default port, no look-alikes
        for (u in listOf("http://shilp.aerogyan.tech/x.apk", "https://indpay.aerogyan.tech.evil.example/x.apk", "https://sankalak.aerogyan.tech:8443/x.apk")) {
            assertEquals(u, Reason.BAD_URL, reason(Verifier.checkBeforeDownload(ip.copy(url = u))))
        }
    }

    @Test fun unknownPackageIsRejected() {
        val e = Expected("com.evil.app", "https://aerogyan.tech/download/android", sha, null)
        assertEquals(Reason.NOT_OURS, reason(Verifier.checkBeforeDownload(e)))
        assertEquals(Reason.NOT_OURS, reason(Verifier.verify(e, sha, good.copy(packageName = "com.evil.app"), null, 34)))
        // look-alikes
        for (p in listOf("tech.aerogyan.office.", "tech.aerogyan.office.Sheets", "tech.aerogyan.office.a.b", "tech.aerogyan.apps", "tech.aerogyan.pack.x-y")) {
            assertTrue(p, Pins.signersFor(p).isEmpty())
        }
    }

    @Test fun packageMismatchIsRejected() {
        // the catalogue asked for AeroGyan, the file is (correctly signed) Sheets
        val f = good.copy(packageName = "tech.aerogyan.office.sheets")
        assertEquals(Reason.PACKAGE_MISMATCH, reason(Verifier.verify(expected, sha, f, null, 34)))
    }

    @Test fun downgradesAreRejected() {
        // older than what is installed
        assertEquals(Reason.NOT_NEWER, reason(Verifier.verify(expected.copy(versionCode = 18), sha, good.copy(versionCode = 18), 19, 34)))
        // the same version again
        assertEquals(Reason.NOT_NEWER, reason(Verifier.verify(expected, sha, good, 20, 34)))
        // the server lists 20 but serves 19 (a rollback attack with a genuinely signed old build)
        assertEquals(Reason.OLDER_THAN_LISTED, reason(Verifier.verify(expected, sha, good.copy(versionCode = 19), null, 34)))
    }

    @Test fun minSdkIsChecked() {
        assertEquals(Reason.NEEDS_NEWER_ANDROID, reason(Verifier.verify(expected, sha, good.copy(minSdk = 35), null, 34)))
        assertEquals(Verdict.Ok, Verifier.verify(expected, sha, good.copy(minSdk = 34), null, 34))
    }

    @Test fun notAnApkIsRejected() {
        assertEquals(Reason.NOT_APK, reason(Verifier.verify(expected, sha, null, null, 34)))
    }

    @Test fun badUrlsAreRejected() {
        for (u in listOf(
            "http://aerogyan.tech/download/android",           // not https
            "https://evil.example/download/android",           // another host
            "https://aerogyan.tech.evil.example/x.apk",        // look-alike
            "https://evilaerogyan.tech/x.apk",
            "https://user@aerogyan.tech/x.apk",                // user info
            "https://aerogyan.tech:8443/x.apk",                // odd port
            "ftp://aerogyan.tech/x.apk", "", "not a url",
        )) {
            assertEquals(u, Reason.BAD_URL, reason(Verifier.checkBeforeDownload(expected.copy(url = u))))
        }
        assertEquals(Reason.BAD_URL, reason(Verifier.checkBeforeDownload(expected.copy(url = null))))
        for (u in listOf("https://aerogyan.tech/download/android", "https://AeroGyan.tech/x", "https://medico.aerogyan.tech/download/android",
            "https://ganak.aerogyan.tech/download/android", "https://aerogyan.tech:443/x")) {
            assertTrue(u, Pins.isTrustedUrl(u))
        }
    }

    @Test fun sha256OfAFile() {
        val f = File.createTempFile("verify", ".bin")
        f.writeText("hello")
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", Verifier.sha256(f))
        f.delete()
    }
}
