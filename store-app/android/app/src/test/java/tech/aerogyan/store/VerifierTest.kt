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
        val f = File.createTempFile("v", ".bin")
        f.writeText("hello")
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", Verifier.sha256(f))
        f.delete()
    }
}
