package tech.aerogyan.store

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.IOException
import java.net.URL
import java.util.Collections
import java.util.concurrent.TimeUnit

/**
 * Download → verify → install for one app, as WorkManager work: it survives the screen going off and the app
 * being closed, waits for a network (or Wi-Fi for big files), retries with back-off on a bad connection and
 * resumes the download where it stopped.
 */
class InstallWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val appId get() = inputData.getString(KEY_APP).orEmpty()

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val name = Repo.get(applicationContext).catalog.value?.byId(appId)?.title(Lang.isHindi(applicationContext)) ?: appId
        return ForegroundInfo(Notify.progressId(appId), Notify.progress(applicationContext, appId, name, 0, 0), Notify.foregroundType())
    }

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val id = appId
        val repo = Repo.get(ctx)
        val hindi = Lang.isHindi(ctx)
        val catalog = repo.catalog.value ?: repo.refresh()
        val app = catalog?.byId(id)
        val f = app?.android
        if (app == null || f == null || !f.available) {
            Tasks.set(id, Task.Failed(ctx.getString(R.string.err_not_in_catalogue)))
            return Result.failure()
        }
        val name = app.title(hindi)
        val expected = Expected(f.packageName, f.url, f.sha256, f.versionCode)
        Verifier.checkBeforeDownload(expected).let {
            if (it is Verdict.Rejected) {
                Tasks.set(id, Task.Failed(Messages.reason(ctx, it.reason)))
                return Result.failure()
            }
        }
        // an automatic update only for apps the store installed (silent) — the others wait for a tap
        if (inputData.getBoolean(KEY_AUTO, false)) {
            val inst = ApkInspector.installed(ctx, f.packageName)
            if (inst == null || !inst.byStore || !States.isNewer(f, inst)) {
                Tasks.set(id, null)
                return Result.success()
            }
        }
        try {
            setForeground(getForegroundInfo())
        } catch (_: Throwable) { /* not allowed right now (Android 12+ background start): download anyway */ }

        val dir = File(ctx.cacheDir, "apk").apply { mkdirs() }
        val part = File(dir, "$id.apk")
        Tasks.set(id, Task.Downloading(if (part.exists()) part.length() else 0, f.size))
        val dl = Downloader(repo.userAgent, hostOk = { u: URL -> Pins.isTrustedUrl(u.toString()) })
        var lastNote = 0L
        try {
            dl.download(f.url!!, part, f.size, isCancelled = { isStopped }) { done, total ->
                Tasks.set(id, Task.Downloading(done, if (total > 0) total else f.size))
                val now = System.currentTimeMillis()
                if (now - lastNote > 1000) {
                    lastNote = now
                    try {
                        NotificationManagerCompat.from(ctx).notify(Notify.progressId(id), Notify.progress(ctx, id, name, done, total))
                    } catch (_: SecurityException) {
                    }
                }
            }
        } catch (e: Downloader.Cancelled) {
            return stopped(id, part)
        } catch (e: Downloader.BadHost) {
            Downloader.cleanup(part)
            Tasks.set(id, Task.Failed(Messages.reason(ctx, Reason.BAD_URL)))
            return Result.failure()
        } catch (e: IOException) {
            if (isStopped) return stopped(id, part)
            if (e is Downloader.HttpError && (e.code == -2 || e.code == -3 || e.code == 404 || e.code == 410)) {
                Downloader.cleanup(part)
                Tasks.set(id, Task.Failed(ctx.getString(R.string.err_download_changed)))
                return Result.failure()
            }
            return if (runAttemptCount < MAX_TRIES) {
                Tasks.set(id, Task.Queued(waitingForWifi = false))
                Result.retry()
            } else {
                Tasks.set(id, Task.Failed(ctx.getString(R.string.err_network)))
                if (!StoreApplication.inForeground) Notify.failed(ctx, id, name, ctx.getString(R.string.err_network))
                Result.failure()
            }
        } finally {
            NotificationManagerCompat.from(ctx).cancel(Notify.progressId(id))
        }

        Tasks.set(id, Task.Verifying)
        val sha = Verifier.sha256(part)
        val facts = ApkInspector.inspect(ctx, part)
        val installed = ApkInspector.installed(ctx, f.packageName)
        val verdict = Verifier.verify(expected, sha, facts, installed?.versionCode, Build.VERSION.SDK_INT)
        if (verdict is Verdict.Rejected) {
            Downloader.cleanup(part)
            val msg = Messages.reason(ctx, verdict.reason)
            Tasks.set(id, Task.Failed(msg))
            if (!StoreApplication.inForeground) Notify.failed(ctx, id, name, msg)
            return Result.failure()
        }
        Tasks.set(id, Task.Installing)
        return try {
            Installer.install(ctx, part, id, f.packageName)
            Result.success()
        } catch (e: Exception) {
            Downloader.cleanup(part)
            Tasks.set(id, Task.Failed(ctx.getString(R.string.err_install_generic)))
            Result.failure()
        }
    }

    private fun stopped(id: String, part: File): Result {
        if (userCancelled.remove(id)) {
            Downloader.cleanup(part)
            Tasks.set(id, null)
        } else {
            Tasks.set(id, Task.Queued(waitingForWifi = false)) // WorkManager stopped it (network lost): it comes back
        }
        return Result.retry()
    }

    companion object {
        const val KEY_APP = "app"
        const val KEY_AUTO = "auto"
        private const val MAX_TRIES = 6
        private val userCancelled: MutableSet<String> = Collections.synchronizedSet(HashSet())

        fun workName(appId: String) = "install-$appId"

        /** Queue an install / update. Big files wait for Wi-Fi when the setting says so; automatic updates always do. */
        fun enqueue(context: Context, app: StoreApp, auto: Boolean = false) {
            val f = app.android ?: return
            val prefs = Prefs(context)
            val big = prefs.wifiOnlyBig && f.size > Prefs.BIG_BYTES
            val wifi = big || auto
            val req = OneTimeWorkRequestBuilder<InstallWorker>()
                .setInputData(workDataOf(KEY_APP to app.id, KEY_AUTO to auto))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(if (wifi) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .addTag("install")
                .addTag("app:${app.id}")
                .apply { if (!wifi) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
                .build()
            userCancelled.remove(app.id)
            WorkManager.getInstance(context).enqueueUniqueWork(workName(app.id), ExistingWorkPolicy.KEEP, req)
            if (Tasks.get(app.id) == null || Tasks.get(app.id) is Task.Failed) {
                Tasks.set(app.id, Task.Queued(waitingForWifi = wifi && !onUnmetered(context)))
            }
        }

        fun cancel(context: Context, appId: String) {
            userCancelled.add(appId)
            WorkManager.getInstance(context).cancelUniqueWork(workName(appId))
            Downloader.cleanup(File(File(context.cacheDir, "apk"), "$appId.apk"))
            Tasks.set(appId, null)
        }

        fun onUnmetered(context: Context): Boolean {
            val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
            val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
            return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
    }
}

/** Once a day: fetch the catalogue, announce "N updates available", and (if switched on) update on Wi-Fi. */
class UpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val repo = Repo.get(ctx)
        val catalog = repo.refresh() ?: return Result.retry()
        if (repo.offline.value) return Result.retry()
        val prefs = Prefs(ctx)
        val updates = States.updates(catalog.apps, repo.installed.value, Build.VERSION.SDK_INT)
        val hindi = Lang.isHindi(ctx)
        if (prefs.autoUpdate) {
            for (a in updates) {
                val inst = repo.installed.value[a.android!!.packageName]
                if (inst?.byStore == true) InstallWorker.enqueue(ctx, a, auto = true)
            }
        }
        val key = updates.joinToString("|") { "${it.id}:${it.android?.versionCode ?: it.android?.version}" }
        if (prefs.notifyUpdates && key != prefs.lastAnnounced) {
            Notify.updatesAvailable(ctx, updates.map { it.title(hindi) })
            prefs.lastAnnounced = key
        }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<UpdateWorker>(24, TimeUnit.HOURS, 4, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("daily-update-check", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
