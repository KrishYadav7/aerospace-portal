# AeroGyan Store — R8 rules. WorkManager, Compose and AndroidX bring their own consumer rules.
# Keep line numbers for readable crash traces.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# BouncyCastle (only Ed25519Signer / Ed25519PublicKeyParameters are used, no JCA provider, no reflection):
# its unused parts reference JDK classes Android does not have.
-dontwarn javax.naming.**
-dontwarn java.lang.management.**
-dontwarn org.bouncycastle.jsse.**
