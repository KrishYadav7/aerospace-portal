package tech.aerogyan.store

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File

/** Reads a downloaded APK with PackageManager: package, version, minSdk and the CURRENT signing certificates. */
object ApkInspector {

    fun inspect(context: Context, apk: File): ApkFacts? {
        val pm = context.packageManager
        val path = apk.absolutePath
        val info: PackageInfo = try {
            if (Build.VERSION.SDK_INT >= 28) {
                val flags = PackageManager.GET_SIGNING_CERTIFICATES
                if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags.toLong()))
                else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(path, flags)
            } else {
                @Suppress("DEPRECATION") pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
            }
        } catch (_: Exception) {
            null
        } ?: return null
        val ai = info.applicationInfo
        if (ai != null) { // needed by some Android versions before the archive's details can be read
            ai.sourceDir = path
            ai.publicSourceDir = path
        }
        val certs: Array<Signature> = if (Build.VERSION.SDK_INT >= 28) {
            val si = info.signingInfo ?: return null
            if (si.hasMultipleSigners()) {
                si.apkContentsSigners ?: emptyArray()
            } else {
                // the history is oldest → current; the last one signs this APK
                si.signingCertificateHistory?.lastOrNull()?.let { arrayOf(it) } ?: emptyArray()
            }
        } else {
            @Suppress("DEPRECATION") info.signatures ?: emptyArray()
        }
        return ApkFacts(
            packageName = info.packageName ?: return null,
            versionCode = PackageInfoCompat.getLongVersionCode(info),
            versionName = info.versionName,
            minSdk = ai?.minSdkVersion ?: 0,
            signers = certs.map { Verifier.sha256(it.toByteArray()) },
        )
    }

    /** The installed version of a package, or null. */
    fun installed(context: Context, pkg: String): Installed? {
        val pm = context.packageManager
        return try {
            val info = if (Build.VERSION.SDK_INT >= 33) pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
            else @Suppress("DEPRECATION") pm.getPackageInfo(pkg, 0)
            Installed(PackageInfoCompat.getLongVersionCode(info), info.versionName, installerOf(context, pkg) == context.packageName)
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun installerOf(context: Context, pkg: String): String? = try {
        if (Build.VERSION.SDK_INT >= 30) context.packageManager.getInstallSourceInfo(pkg).installingPackageName
        else @Suppress("DEPRECATION") context.packageManager.getInstallerPackageName(pkg)
    } catch (_: Exception) {
        null
    }
}
