package tech.aerogyan.store

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant

/**
 * The signed trust manifest (⭐ 1.0.2): signature, expiry, rollback, what it adds to the pins, and the store that keeps it.
 * Vectors in resources/trust/ come from ../trust-vectors.mjs (TEST keys); real.json is legacy-node/store/trust.json.
 */
class TrustTest {
    private val testKey = "V3J1DFg10ohKzPUodQ3/lSyxM7bvHKoloaR8nXdRgu4="       // test key 1 (id a629fa3a8de68ff9)
    private val otherKey = "SmNLQfCoBHsrTYCgxle0L0ageBbRR3TknmbiGx3dx4A="      // test key 2 (not pinned below)
    private val keys = listOf(testKey)
    private val now = Instant.parse("2026-11-22T00:00:00Z").toEpochMilli()
    private val sha = "1aceb4c23bbde60952f5dceb352dc7c25b4f400056fde982e8c125284ea53171"
    private val shodhSigner = "ab".repeat(32)

    private fun res(name: String): String = javaClass.classLoader!!.getResource("trust/$name")!!.readText()
    private fun valid() = Trust.verify(res("valid.json"), keys, now)
    private fun reason(v: Verdict): Reason? = (v as? Verdict.Rejected)?.reason

    private fun rejects(name: String, k: List<String> = keys, nowMillis: Long = now, minVersion: Long = 0, why: String) {
        try {
            Trust.verify(res(name), k, nowMillis, minVersion)
            fail("$name was accepted")
        } catch (e: TrustException) {
            assertTrue("$name: '${e.message}' should say '$why'", e.message!!.contains(why))
        }
    }

    @After fun reset() {
        Pins.manifest = null
    }

    // ---------------------------------------------------------------- Trust.verify

    @Test fun theRealManifestVerifiesWithThePinnedKey() {
        assertEquals(listOf("jfHxceRb/EeLxGp5rv+cbP+b+vgsnFtyQGtB5EJc9pA="), Pins.TRUST_KEYS)
        val m = Trust.verify(res("real.json"), nowMillis = now)              // default keys = Pins.TRUST_KEYS
        assertTrue(m.version > 1_700_000_000L)
        assertTrue("ganit.aerogyan.tech" in m.hosts)
        assertTrue("aerogyan.tech" in m.hosts)
        assertEquals(setOf(Pins.GANIT), m.packages["tech.aerogyan.ganit"]!!.signers)
        assertEquals(setOf("310290068a24bea0781c838214068a3bff1c24b7eaf05aa5050bfe9c7c014778"), m.packages["tech.aerogyan.ganit"]!!.signers)
        assertEquals("Ganit", m.packages["tech.aerogyan.ganit"]!!.name)
        // it agrees with every built-in pin
        for ((pkg, fp) in listOf("tech.aerogyan.app" to Pins.AEROGYAN, "tech.aerogyan.medico" to Pins.MEDICO, "tech.aerogyan.store" to Pins.STORE,
            "tech.aerogyan.office.sheets" to Pins.AEROGYAN)) {
            assertTrue(pkg, fp in m.packages[pkg]!!.signers)
        }
        for (h in Pins.HOSTS) assertTrue(h, h in m.hosts)
        // and not with a test key
        rejects("real.json", keys, why = "not pinned")
    }

    @Test fun keyIdIsTheFirst16HexOfSha256() {
        assertEquals("45fb28bf80b97f29", Trust.keyIdOf(java.util.Base64.getDecoder().decode(Pins.TRUST_KEYS[0])))
        assertEquals("a629fa3a8de68ff9", Trust.keyIdOf(java.util.Base64.getDecoder().decode(testKey)))
    }

    @Test fun aValidManifestAddsAProductAndAMinimum() {
        val m = valid()
        assertEquals(100L, m.version)
        assertTrue("shodh.aerogyan.tech" in m.hosts)
        assertEquals(setOf(shodhSigner), m.packages["tech.aerogyan.shodh"]!!.signers)
        assertEquals("Shodh", m.packages["tech.aerogyan.shodh"]!!.name)
        assertEquals(5L, m.packages["tech.aerogyan.ganak"]!!.minVersionCode)
        assertNull(m.packages["tech.aerogyan.app"]!!.minVersionCode)
        assertTrue(m.expiresAt > Instant.parse("2100-01-01T00:00:00Z").toEpochMilli())
    }

    @Test fun tamperedPayloadIsRejected() = rejects("tampered.json", why = "signature")

    @Test fun wrongKeyIsRejected() {
        rejects("wrong-key.json", why = "signature")                   // claims key 1, signed by key 2
        rejects("unpinned-key.json", why = "not pinned")               // key 2 under its own id
        // pinning key 2 as well makes the second one good (a key rotation)
        assertEquals(100L, Trust.verify(res("unpinned-key.json"), listOf(testKey, otherKey), now).version)
        rejects("valid.json", k = listOf(otherKey), why = "not pinned")
        rejects("valid.json", k = emptyList(), why = "not pinned")
        rejects("valid.json", k = listOf("not base64!", "AAAA"), why = "not pinned")
    }

    @Test fun keyIdMismatchIsRejected() = rejects("keyid-mismatch.json", why = "keyId")

    @Test fun expiredIsRejected() {
        rejects("expired.json", why = "expired")
        // the same file was fine on its day
        assertEquals(100L, Trust.verify(res("expired.json"), keys, Instant.parse("2020-01-01T12:00:00Z").toEpochMilli()).version)
        // the real one stops being trusted when it expires
        rejects("real.json", k = Pins.TRUST_KEYS, nowMillis = Instant.parse("2027-05-20T09:13:04Z").toEpochMilli(), why = "expired")
    }

    @Test fun rollbackIsRejectedAndEqualIsAccepted() {
        rejects("older.json", minVersion = 100, why = "rollback")
        assertEquals(100L, Trust.verify(res("valid.json"), keys, now, minVersion = 100).version)
        assertEquals(200L, Trust.verify(res("newer.json"), keys, now, minVersion = 100).version)
    }

    @Test fun garbageIsRejectedNeverCrashes() {
        val good = org.json.JSONObject(res("valid.json"))
        for (bad in listOf("", "null", "[]", "{}", "not json", "{\"format\":\"aerogyan-store-trust/1\"}",
            good.put("format", "aerogyan-store-trust/2").toString(),
            org.json.JSONObject(res("valid.json")).put("signature", "AAAA").toString(),
            org.json.JSONObject(res("valid.json")).put("signature", "!!!").toString(),
            org.json.JSONObject(res("valid.json")).put("payload", "%%%").toString(),
            org.json.JSONObject(res("valid.json")).put("payload", 5).toString())) {
            try {
                Trust.verify(bad, keys, now)
                fail("accepted: ${bad.take(60)}")
            } catch (_: TrustException) {
            }
        }
    }

    // ---------------------------------------------------------------- what Pins / Verifier make of it

    @Test fun aNewProductIsTrustedOnlyWithTheManifest() {
        val e = Expected("tech.aerogyan.shodh", "https://shodh.aerogyan.tech/download/android", sha, 3)
        val f = ApkFacts("tech.aerogyan.shodh", 3, "0.1.0", 24, listOf(shodhSigner))
        assertTrue(Pins.signersFor("tech.aerogyan.shodh").isEmpty())
        assertEquals(Reason.NOT_OURS, reason(Verifier.checkBeforeDownload(e.copy(url = "https://aerogyan.tech/download/shodh"))))
        assertEquals(Reason.NOT_OURS, reason(Verifier.verify(e.copy(url = "https://aerogyan.tech/download/shodh"), sha, f, null, 34)))
        assertNull(Pins.signerName("tech.aerogyan.shodh"))

        Pins.manifest = valid()
        assertEquals(setOf(shodhSigner), Pins.signersFor("tech.aerogyan.shodh"))
        assertEquals(Verdict.Ok, Verifier.checkBeforeDownload(e))
        assertEquals(Verdict.Ok, Verifier.verify(e, sha, f, null, 34))
        assertEquals("Shodh", Pins.signerName("tech.aerogyan.shodh"))
        // still only with its own key
        assertEquals(Reason.WRONG_SIGNER, reason(Verifier.verify(e, sha, f.copy(signers = listOf(Pins.AEROGYAN)), null, 34)))
        // the built-in pins stay (and keep their names)
        assertEquals(setOf(Pins.GANAK), Pins.signersFor("tech.aerogyan.ganak"))
        assertEquals("Ganak", Pins.signerName("tech.aerogyan.ganak"))
        assertEquals(setOf(Pins.AEROGYAN), Pins.signersFor("tech.aerogyan.office.sheets"))
        assertTrue(Pins.signersFor("com.evil.app").isEmpty())
        assertTrue(Pins.signersFor("tech.aerogyan.shodh2").isEmpty())

        Pins.manifest = null
        assertEquals(Reason.NOT_OURS, reason(Verifier.verify(e.copy(url = "https://aerogyan.tech/download/shodh"), sha, f, null, 34)))
    }

    @Test fun aNewHostIsTrustedOnlyWithTheManifest() {
        val e = Expected("tech.aerogyan.app", "https://shodh.aerogyan.tech/x.apk", sha, 20)
        assertFalse(Pins.isTrustedUrl("https://shodh.aerogyan.tech/x.apk"))
        assertEquals(Reason.BAD_URL, reason(Verifier.checkBeforeDownload(e)))
        Pins.manifest = valid()
        assertTrue(Pins.isTrustedUrl("https://shodh.aerogyan.tech/x.apk"))
        assertTrue(Pins.isTrustedUrl("https://Shodh.AeroGyan.tech:443/icon.png"))
        assertEquals(Verdict.Ok, Verifier.checkBeforeDownload(e))
        // the same rules as for the built-in hosts
        for (u in listOf("http://shodh.aerogyan.tech/x.apk", "https://user@shodh.aerogyan.tech/x.apk", "https://shodh.aerogyan.tech:8443/x.apk",
            "https://shodh.aerogyan.tech.evil.example/x.apk", "https://evil.example/x.apk")) {
            assertFalse(u, Pins.isTrustedUrl(u))
        }
        assertTrue(Pins.isTrustedUrl("https://aerogyan.tech/download/android"))
    }

    @Test fun belowTheMinimumIsRejected() {
        val e = Expected("tech.aerogyan.ganak", "https://ganak.aerogyan.tech/download/android", sha, 4)
        val f = ApkFacts("tech.aerogyan.ganak", 4, "0.0.4", 24, listOf(Pins.GANAK))
        assertEquals(Verdict.Ok, Verifier.verify(e, sha, f, null, 34))           // no manifest: no minimum
        assertNull(Pins.minVersionCode("tech.aerogyan.ganak"))
        Pins.manifest = valid()
        assertEquals(5L, Pins.minVersionCode("tech.aerogyan.ganak"))
        // the catalogue lists 4: refused before downloading
        assertEquals(Reason.BELOW_MINIMUM, reason(Verifier.checkBeforeDownload(e)))
        assertEquals(Reason.BELOW_MINIMUM, reason(Verifier.verify(e, sha, f, null, 34)))
        // the catalogue lists nothing, the file is 4
        assertEquals(Reason.BELOW_MINIMUM, reason(Verifier.verify(e.copy(versionCode = null), sha, f, null, 34)))
        // 5 and above are fine
        assertEquals(Verdict.Ok, Verifier.verify(e.copy(versionCode = 5), sha, f.copy(versionCode = 5), null, 34))
        assertEquals(Verdict.Ok, Verifier.verify(e.copy(versionCode = 6), sha, f.copy(versionCode = 6), 5, 34))
        // other packages have no minimum
        assertNull(Pins.minVersionCode("tech.aerogyan.app"))
    }

    @Test fun anExpiredManifestAddsNothing() {
        val m = valid()
        Pins.manifest = m.copy(expiresAt = System.currentTimeMillis() - 1000)
        assertNull(Pins.activeManifest())
        assertTrue(Pins.signersFor("tech.aerogyan.shodh").isEmpty())
        assertFalse(Pins.isTrustedUrl("https://shodh.aerogyan.tech/x.apk"))
        assertNull(Pins.minVersionCode("tech.aerogyan.ganak"))
        assertNull(Pins.signerName("tech.aerogyan.shodh"))
        assertEquals(Reason.NOT_OURS, reason(Verifier.checkBeforeDownload(Expected("tech.aerogyan.shodh", "https://aerogyan.tech/x.apk", sha, 1))))
        // built-in pins still apply
        assertEquals(setOf(Pins.GANIT), Pins.signersFor("tech.aerogyan.ganit"))
        Pins.manifest = m
        assertTrue(Pins.activeManifest() != null)
    }

    /** signs [payload] with test key 1 (its seed is in ../trust-vectors.mjs), as tools/sign-catalog.mjs sign() does */
    private fun signTest(payload: String): String {
        val seed = java.security.MessageDigest.getInstance("SHA-256").digest("aerogyan-store-trust-TEST-key-1".toByteArray())
        val priv = org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(seed, 0)
        assertEquals(testKey, java.util.Base64.getEncoder().encodeToString(priv.generatePublicKey().encoded))
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val signer = org.bouncycastle.crypto.signers.Ed25519Signer()
        signer.init(true, priv)
        val msg = "AeroGyan-Store-Trust/1\n".toByteArray(Charsets.UTF_8) + bytes
        signer.update(msg, 0, msg.size)
        val b64 = java.util.Base64.getEncoder()
        return org.json.JSONObject().put("format", "aerogyan-store-trust/1").put("keyId", "a629fa3a8de68ff9")
            .put("payload", b64.encodeToString(bytes)).put("signature", b64.encodeToString(signer.generateSignature())).toString()
    }

    @Test fun badEntriesAreDropped() {
        val payload = """{"type":"aerogyan-store-trust","schema":1,"version":7,"keyId":"a629fa3a8de68ff9","expiresAt":"2126-01-01T00:00:00Z",
            "hosts":["New.AeroGyan.tech","evil host","https://x.example","1.2.3.4","a..b","", 5, "-bad.example","ok-host.example"],
            "android":{"packages":{
              "tech.aerogyan.good":{"name":"Good","signers":["${"AB".repeat(32)}","xyz","${"cd".repeat(31)}", 7],"minVersionCode":12},
              "Tech.Bad":{"signers":["${"ab".repeat(32)}"]}, "nodots":{"signers":["${"ab".repeat(32)}"]},
              "tech.aerogyan.odd":{"signers":["${"ef".repeat(32)}"],"minVersionCode":"9"},
              "tech.aerogyan.none":{"signers":"not a list"}}},
            "desktop":{"apps":{}},"products":["x"],"future":{"field":true}}"""
        val m = Trust.verify(signTest(payload), keys, now)
        assertEquals(7L, m.version)
        assertEquals(setOf("new.aerogyan.tech", "ok-host.example"), m.hosts)
        assertEquals(setOf("tech.aerogyan.good", "tech.aerogyan.odd", "tech.aerogyan.none"), m.packages.keys)
        assertEquals(setOf("ab".repeat(32)), m.packages["tech.aerogyan.good"]!!.signers)
        assertEquals(12L, m.packages["tech.aerogyan.good"]!!.minVersionCode)
        assertNull(m.packages["tech.aerogyan.odd"]!!.minVersionCode)
        assertTrue(m.packages["tech.aerogyan.none"]!!.signers.isEmpty())
        // a package with no usable signer adds nothing
        Pins.manifest = m
        assertTrue(Pins.signersFor("tech.aerogyan.none").isEmpty())
        assertNull(Pins.signerName("tech.aerogyan.none"))
        assertEquals("Good", Pins.signerName("tech.aerogyan.good"))
    }

    @Test fun payloadRulesMatchTheSigner() {
        val base = """"keyId":"a629fa3a8de68ff9","expiresAt":"2126-01-01T00:00:00Z","hosts":[]"""
        assertEquals(1L, Trust.verify(signTest("""{"type":"aerogyan-store-trust","schema":1,"version":1,$base}"""), keys, now).version)
        // ~1.8e9 and beyond Int: a Long
        assertEquals(1795252384L, Trust.verify(signTest("""{"type":"aerogyan-store-trust","schema":1,"version":1795252384,$base}"""), keys, now).version)
        assertEquals(4_000_000_000L, Trust.verify(signTest("""{"type":"aerogyan-store-trust","schema":1,"version":4000000000,$base}"""), keys, now).version)
        for ((bad, why) in listOf(
            """{"type":"aerogyan-store-trust","schema":1,"version":0,$base}""" to "bad version",
            """{"type":"aerogyan-store-trust","schema":1,"version":-3,$base}""" to "bad version",
            """{"type":"aerogyan-store-trust","schema":1,"version":1.5,$base}""" to "bad version",
            """{"type":"aerogyan-store-trust","schema":1,"version":"5",$base}""" to "bad version",
            """{"type":"aerogyan-store-trust","schema":1,$base}""" to "bad version",
            """{"type":"aerogyan-store-trust","schema":2,"version":1,$base}""" to "unknown manifest type",
            """{"type":"other","schema":1,"version":1,$base}""" to "unknown manifest type",
            """{"type":"aerogyan-store-trust","schema":1,"version":1,"keyId":"a629fa3a8de68ff9","expiresAt":"soon","hosts":[]}""" to "expiresAt",
            """{"type":"aerogyan-store-trust","schema":1,"version":1,"keyId":"a629fa3a8de68ff9","hosts":[]}""" to "expiresAt",
            """{"type":"aerogyan-store-trust","schema":1,"version":1,"keyId":"a629fa3a8de68ff9","expiresAt":"2026-11-21T23:59:59Z"}""" to "expired",
            """[1,2]""" to "unreadable",
        )) {
            try {
                Trust.verify(signTest(bad), keys, now)
                fail("accepted $bad")
            } catch (e: TrustException) {
                assertTrue("$bad: ${e.message}", e.message!!.contains(why))
            }
        }
    }

    // ---------------------------------------------------------------- TrustStore

    private class Memory(var v: Long = 0) : TrustStore.VersionMemory {
        override fun get() = v
        override fun set(v: Long) { this.v = v }
    }

    private fun tmpFile(): File = File(Files.createTempDirectory("trust").toFile(), "trust.json")

    @Test fun storeLoadsTheHighestValidAndNeverRollsBack() {
        val file = tmpFile()
        val mem = Memory()
        // nothing stored: the bundled one
        var s = TrustStore(file, { res("valid.json") }, mem, keys)
        assertEquals(100L, s.load(now)!!.version)
        assertEquals(100L, mem.v)
        assertEquals(100L, Pins.manifest!!.version)
        assertEquals(res("valid.json"), file.readText())                         // kept on disk too
        // the server offers older, equal, garbage, newer
        assertFalse(s.offer(res("older.json"), now))
        assertFalse(s.offer(res("valid.json"), now))
        assertFalse(s.offer(res("tampered.json"), now))
        assertFalse(s.offer("<html>404</html>", now))
        assertEquals(100L, Pins.manifest!!.version)
        assertTrue(s.offer(res("newer.json"), now))
        assertEquals(200L, mem.v)
        assertEquals(200L, Pins.manifest!!.version)
        assertEquals(res("newer.json"), file.readText())
        assertFalse(File(file.path + ".tmp").exists())

        // next start: stored 200 beats bundled 100
        Pins.manifest = null
        s = TrustStore(file, { res("valid.json") }, mem, keys)
        assertEquals(200L, s.load(now)!!.version)
        assertEquals(200L, Pins.manifest!!.version)

        // someone puts an old (validly signed) file in place: refused, lastSeen stays
        file.writeText(res("older.json"))
        Pins.manifest = null
        s = TrustStore(file, { res("older.json") }, mem, keys)
        assertNull(s.load(now))
        assertNull(Pins.manifest)
        assertEquals(200L, mem.v)
        assertTrue(s.lastError!!.contains("rollback"))
        // the equal version is fine again
        assertTrue(s.offer(res("newer.json"), now))
        assertEquals(200L, Pins.manifest!!.version)
    }

    @Test fun storeSurvivesMissingAndBrokenFiles() {
        val file = tmpFile()
        val mem = Memory()
        val s = TrustStore(file, { throw java.io.FileNotFoundException("trust.json") }, mem, keys)
        assertNull(s.load(now))
        assertNull(Pins.manifest)
        file.writeText("{ broken")
        assertNull(s.load(now))
        assertEquals(0L, mem.v)
        // an expired stored one with a valid bundled one: the bundled one
        file.writeText(res("expired.json"))
        val s2 = TrustStore(file, { res("valid.json") }, mem, keys)
        assertEquals(100L, s2.load(now)!!.version)
        // the real bundled manifest with the real key
        Pins.manifest = null
        val s3 = TrustStore(tmpFile(), { res("real.json") }, Memory(), Pins.TRUST_KEYS)
        assertTrue(s3.load(now)!!.version > 1_700_000_000L)
        assertTrue(Pins.isTrustedUrl("https://ganit.aerogyan.tech/dl/Ganit-1.0.0.apk"))
    }
}
