package tech.aerogyan.store

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import java.io.File

/** Hands a VERIFIED APK to the system with the PackageInstaller session API. */
object Installer {
    const val EXTRA_APP_ID = "tech.aerogyan.store.APP_ID"
    const val EXTRA_PACKAGE = "tech.aerogyan.store.PACKAGE"
    const val EXTRA_FILE = "tech.aerogyan.store.FILE"

    /** May the store install apps at all ("Allow from this source")? */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    fun unknownSourcesIntent(context: Context): Intent =
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    /** Writes the APK into a session and commits it; the answer arrives at [InstallReceiver]. */
    fun install(context: Context, apk: File, appId: String, pkg: String) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(pkg)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 31) {
                // silent updates for apps the store installed (the system still asks for a first install)
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            if (Build.VERSION.SDK_INT >= 34) setRequestUpdateOwnership(true)
            if (Build.VERSION.SDK_INT >= 26) setInstallReason(android.content.pm.PackageManager.INSTALL_REASON_USER)
        }
        val id = pi.createSession(params)
        val session = pi.openSession(id)
        try {
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    input.copyTo(out, 64 * 1024)
                    session.fsync(out)
                }
            }
            Tasks.remember(pkg, appId)
            val intent = Intent(context, InstallReceiver::class.java)
                .putExtra(EXTRA_APP_ID, appId)
                .putExtra(EXTRA_PACKAGE, pkg)
                .putExtra(EXTRA_FILE, apk.absolutePath)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val sender = PendingIntent.getBroadcast(context, id, intent, flags)
            session.commit(sender.intentSender)
        } catch (e: Exception) {
            session.abandon()
            throw e
        } finally {
            session.close()
        }
    }

    fun uninstallIntent(pkg: String): Intent =
        Intent(Intent.ACTION_DELETE, Uri.parse("package:$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/** The system's answer to an install session. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val appId = intent.getStringExtra(Installer.EXTRA_APP_ID) ?: return
        val pkg = intent.getStringExtra(Installer.EXTRA_PACKAGE).orEmpty()
        val file = intent.getStringExtra(Installer.EXTRA_FILE)?.let { File(it) }
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val repo = Repo.get(context)
        val name = repo.catalog.value?.byId(appId)?.title(Lang.isHindi(context)) ?: pkg
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm == null) {
                    Tasks.set(appId, Task.Failed(context.getString(R.string.err_install_generic)))
                    return
                }
                Tasks.set(appId, Task.WaitingForUser)
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (StoreApplication.inForeground) {
                    try {
                        context.startActivity(confirm)
                        return
                    } catch (_: Exception) { /* fall through to the notification */ }
                }
                Notify.confirmInstall(context, appId, name, confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> {
                file?.let { Downloader.cleanup(it) }
                Tasks.set(appId, null)
                Notify.cancelConfirm(context, appId)
                repo.refreshInstalled()
                if (!StoreApplication.inForeground) Notify.installed(context, appId, name)
            }
            else -> {
                val msg = when (status) {
                    PackageInstaller.STATUS_FAILURE_ABORTED -> context.getString(R.string.err_install_cancelled)
                    PackageInstaller.STATUS_FAILURE_STORAGE -> context.getString(R.string.err_install_storage)
                    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> context.getString(R.string.err_install_incompatible)
                    PackageInstaller.STATUS_FAILURE_CONFLICT -> context.getString(R.string.err_install_conflict)
                    PackageInstaller.STATUS_FAILURE_BLOCKED -> context.getString(R.string.err_install_blocked)
                    else -> context.getString(R.string.err_install_generic)
                }
                // a cancelled confirmation is not an error worth a red line
                Tasks.set(appId, if (status == PackageInstaller.STATUS_FAILURE_ABORTED) null else Task.Failed(msg))
                Notify.cancelConfirm(context, appId)
                file?.let { Downloader.cleanup(it) }
                repo.refreshInstalled()
            }
        }
    }
}
