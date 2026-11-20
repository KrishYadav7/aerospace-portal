package tech.aerogyan.store

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notify {
    const val CH_UPDATES = "updates"
    const val CH_DOWNLOADS = "downloads"
    const val CH_INSTALL = "install"
    private const val ID_UPDATES = 1
    const val EXTRA_OPEN_TAB = "tech.aerogyan.store.OPEN_TAB"

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_UPDATES, context.getString(R.string.ch_updates), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = context.getString(R.string.ch_updates_desc) },
                NotificationChannel(CH_DOWNLOADS, context.getString(R.string.ch_downloads), NotificationManager.IMPORTANCE_LOW)
                    .apply { description = context.getString(R.string.ch_downloads_desc); setShowBadge(false) },
                NotificationChannel(CH_INSTALL, context.getString(R.string.ch_install), NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = context.getString(R.string.ch_install_desc) },
            )
        )
    }

    private fun openStore(context: Context, tab: String?): PendingIntent {
        val i = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (tab != null) i.putExtra(EXTRA_OPEN_TAB, tab)
        return PendingIntent.getActivity(context, tab.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @SuppressLint("MissingPermission")
    private fun post(context: Context, id: Int, n: Notification) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        try {
            nm.notify(id, n)
        } catch (_: SecurityException) {
        }
    }

    private fun idFor(appId: String) = 1000 + (appId.hashCode() and 0x7fff)

    /** The download's own notification (the worker's foreground notice). */
    fun progress(context: Context, appId: String, name: String, done: Long, total: Long): Notification {
        val pct = if (total > 0) (done * 100 / total).toInt() else 0
        return NotificationCompat.Builder(context, CH_DOWNLOADS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.n_downloading, name))
            .setContentText(if (total > 0) "${Format.size(done)} / ${Format.size(total)}" else context.getString(R.string.state_starting))
            .setProgress(100, pct, total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openStore(context, null))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun progressId(appId: String) = idFor(appId) + 40000

    fun updatesAvailable(context: Context, names: List<String>) {
        if (names.isEmpty()) {
            NotificationManagerCompat.from(context).cancel(ID_UPDATES); return
        }
        val n = NotificationCompat.Builder(context, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.resources.getQuantityString(R.plurals.n_updates, names.size, names.size))
            .setContentText(names.joinToString(", "))
            .setStyle(NotificationCompat.BigTextStyle().bigText(names.joinToString(", ")))
            .setContentIntent(openStore(context, "updates"))
            .setAutoCancel(true)
            .setNumber(names.size)
            .build()
        post(context, ID_UPDATES, n)
    }

    /** "Tap to finish installing X" — the system's confirmation, when the store was not on screen. */
    fun confirmInstall(context: Context, appId: String, name: String, confirm: Intent) {
        val pi = PendingIntent.getActivity(context, idFor(appId), confirm, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CH_INSTALL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.n_confirm_title, name))
            .setContentText(context.getString(R.string.n_confirm_text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        post(context, idFor(appId), n)
    }

    fun cancelConfirm(context: Context, appId: String) = NotificationManagerCompat.from(context).cancel(idFor(appId))

    fun installed(context: Context, appId: String, name: String) {
        val n = NotificationCompat.Builder(context, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.n_installed, name))
            .setContentIntent(openStore(context, null))
            .setAutoCancel(true)
            .build()
        post(context, idFor(appId), n)
    }

    fun failed(context: Context, appId: String, name: String, why: String) {
        val n = NotificationCompat.Builder(context, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.n_failed, name))
            .setContentText(why)
            .setStyle(NotificationCompat.BigTextStyle().bigText(why))
            .setContentIntent(openStore(context, null))
            .setAutoCancel(true)
            .build()
        post(context, idFor(appId), n)
    }

    fun foregroundType(): Int = if (Build.VERSION.SDK_INT >= 29) android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
}

object Format {
    /** API level → the Android version people know ("8.0", "14") */
    fun androidName(sdk: Int): String = when {
        sdk <= 21 -> "5.0"
        sdk == 22 -> "5.1"
        sdk == 23 -> "6.0"
        sdk == 24 -> "7.0"
        sdk == 25 -> "7.1"
        sdk == 26 -> "8.0"
        sdk == 27 -> "8.1"
        sdk == 28 -> "9"
        sdk == 29 -> "10"
        sdk == 30 -> "11"
        sdk == 31 || sdk == 32 -> "12"
        else -> (sdk - 20).toString() // 33 → 13, 34 → 14, 35 → 15, 36 → 16
    }

    fun size(bytes: Long): String = when {
        bytes <= 0 -> "—"
        bytes >= 1024L * 1024 * 1024 -> "%.1f GB".format(bytes / 1073741824.0)
        bytes >= 1024L * 1024 -> "%.1f MB".format(bytes / 1048576.0)
        else -> "${maxOf(1, bytes / 1024)} KB"
    }

    /** "2026-11-16T13:45:48.750Z" → "16 Nov 2026" (in the app's language) */
    fun date(iso: String?, locale: java.util.Locale): String {
        if (iso.isNullOrBlank() || iso.length < 10) return "—"
        return try {
            val d = java.time.LocalDate.parse(iso.substring(0, 10))
            d.format(java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy", locale))
        } catch (_: Exception) {
            iso.substring(0, 10)
        }
    }
}
