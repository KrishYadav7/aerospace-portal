package tech.aerogyan.store

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Base64
import java.util.Locale

/** What the signed manifest says about one Android package. */
data class PackageTrust(
    val product: String?,
    val name: String?,
    /** SHA-256 of the signing certificate(s), lowercase hex */
    val signers: Set<String>,
    val minVersionCode: Long?,
)

/** A verified trust manifest (legacy-node/store/trust.json, served at <base>/api/store/trust). */
data class TrustManifest(
    val version: Long,
    /** epoch milliseconds */
    val expiresAt: Long,
    val hosts: Set<String>,
    val packages: Map<String, PackageTrust>,
) {
    fun validAt(nowMillis: Long): Boolean = expiresAt > nowMillis
}

class TrustException(message: String) : Exception(message)

/**
 * The signed trust manifest (⭐ 1.0.2, docs/store-trust.md). The store pins the catalogue's Ed25519 public key(s)
 * ([Pins.TRUST_KEYS]); whatever a validly signed, unexpired, not-rolled-back manifest lists — download hosts, each
 * package's signing-certificate SHA-256, minimum versions — is trusted IN ADDITION to the built-in pins. The private
 * key lives only on the owner's laptop, so a server compromise cannot add a host or a signer.
 *
 * Same rules, same order as verify() in tools/sign-catalog.mjs. Pure Kotlin (BouncyCastle: Android below 13 has no
 * Ed25519), tested in TrustTest.
 */
object Trust {
    const val FORMAT = "aerogyan-store-trust/1"
    private val PREFIX = "AeroGyan-Store-Trust/1\n".toByteArray(Charsets.UTF_8)
    private val HEX64 = Regex("[0-9a-f]{64}")
    private val PKG = Regex("[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+")
    private val HOST = Regex("(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?")
    private const val MAX_SAFE = 9007199254740991L       // Number.MAX_SAFE_INTEGER, as the signer checks

    /** first 16 lowercase hex chars of SHA-256(raw 32-byte public key) */
    fun keyIdOf(raw: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(raw).joinToString("") { "%02x".format(it) }.substring(0, 16)

    /** Verifies [envelopeJson] and returns what it trusts, or throws [TrustException] with the reason. */
    fun verify(
        envelopeJson: String,
        keys: List<String> = Pins.TRUST_KEYS,
        nowMillis: Long = System.currentTimeMillis(),
        minVersion: Long = 0,
    ): TrustManifest {
        try {
            return verifyOrThrow(envelopeJson, keys, nowMillis, minVersion)
        } catch (e: TrustException) {
            throw e
        } catch (e: Exception) {
            throw TrustException("unreadable manifest (${e.javaClass.simpleName})")
        }
    }

    private fun verifyOrThrow(envelopeJson: String, keys: List<String>, nowMillis: Long, minVersion: Long): TrustManifest {
        // 1. the envelope and a pinned key
        val env = JSONObject(envelopeJson)
        if (env.opt("format") != FORMAT) throw TrustException("not an AeroGyan store trust manifest")
        val keyId = env.opt("keyId") as? String ?: throw TrustException("no keyId")
        val key = keys.firstNotNullOfOrNull { b64 ->
            val raw = runCatching { Base64.getDecoder().decode(b64.trim()) }.getOrNull()
            if (raw != null && raw.size == 32 && keyIdOf(raw) == keyId) raw else null
        } ?: throw TrustException("signed with key $keyId, which is not pinned")

        // 2. the signature over exactly the decoded payload bytes
        val payload = Base64.getDecoder().decode(env.opt("payload") as? String ?: throw TrustException("no payload"))
        val sig = Base64.getDecoder().decode(env.opt("signature") as? String ?: throw TrustException("no signature"))
        if (sig.size != 64) throw TrustException("the signature does not verify")
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(key, 0))
        signer.update(PREFIX, 0, PREFIX.size)
        signer.update(payload, 0, payload.size)
        if (!signer.verifySignature(sig)) throw TrustException("the signature does not verify")

        // 3. the payload
        val p = JSONObject(String(payload, Charsets.UTF_8))
        if (p.opt("type") != "aerogyan-store-trust" || wholeNumber(p.opt("schema")) != 1L) throw TrustException("unknown manifest type")
        if (p.opt("keyId") != keyId) throw TrustException("keyId inside ≠ outside")
        val version = wholeNumber(p.opt("version"))?.takeIf { it >= 1 } ?: throw TrustException("bad version")
        val expires = parseTime(p.opt("expiresAt") as? String) ?: throw TrustException("bad expiresAt")
        if (expires <= nowMillis) throw TrustException("expired ${p.opt("expiresAt")}")
        // 4. rollback
        if (version < minVersion) throw TrustException("version $version is older than $minVersion (a rollback)")

        val hosts = LinkedHashSet<String>()
        p.optJSONArray("hosts")?.let { a ->
            for (i in 0 until a.length()) {
                val h = (a.opt(i) as? String)?.trim()?.lowercase(Locale.ROOT) ?: continue
                if (HOST.matches(h)) hosts += h
            }
        }
        val packages = LinkedHashMap<String, PackageTrust>()
        p.optJSONObject("android")?.optJSONObject("packages")?.let { o ->
            for (pkg in o.keys()) {
                if (!PKG.matches(pkg)) continue
                val v = o.optJSONObject(pkg) ?: continue
                val signers = LinkedHashSet<String>()
                v.optJSONArray("signers")?.let { a ->
                    for (i in 0 until a.length()) {
                        val s = (a.opt(i) as? String)?.lowercase(Locale.ROOT) ?: continue
                        if (HEX64.matches(s)) signers += s
                    }
                }
                packages[pkg] = PackageTrust(
                    product = (v.opt("product") as? String)?.take(64),
                    name = (v.opt("name") as? String)?.trim()?.take(80)?.takeIf { it.isNotEmpty() },
                    signers = signers,
                    minVersionCode = wholeNumber(v.opt("minVersionCode"))?.takeIf { it >= 1 },
                )
            }
        }
        return TrustManifest(version, expires, hosts, packages)
    }

    /** a JSON number that is a whole, safe integer (as Number.isSafeInteger), else null */
    private fun wholeNumber(v: Any?): Long? {
        if (v !is Number) return null
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || Math.abs(d) > MAX_SAFE) return null
        return v.toLong()
    }

    private fun parseTime(s: String?): Long? {
        if (s.isNullOrBlank()) return null
        return runCatching { Instant.parse(s).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(s).toInstant().toEpochMilli() }.getOrNull()
    }
}
