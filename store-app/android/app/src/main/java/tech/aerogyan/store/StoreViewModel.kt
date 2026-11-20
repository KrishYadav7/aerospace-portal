package tech.aerogyan.store

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class StoreViewModel(private val app: Application) : AndroidViewModel(app) {
    private val repo = Repo.get(app)
    val prefs = Prefs(app)

    val catalog: StateFlow<StoreCatalog?> = repo.catalog
    val installed: StateFlow<Map<String, Installed>> = repo.installed
    val offline: StateFlow<Boolean> = repo.offline
    val tasks: StateFlow<Map<String, Task>> = Tasks.all

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    private val _role = MutableStateFlow(prefs.role)
    val role: StateFlow<String> = _role

    /** the app waiting for "Allow from this source" */
    private val _pending = MutableStateFlow<StoreApp?>(null)
    val pending: StateFlow<StoreApp?> = _pending

    private val _canInstall = MutableStateFlow(Installer.canInstall(app))
    val canInstall: StateFlow<Boolean> = _canInstall

    val deviceSdk: Int = Build.VERSION.SDK_INT

    init {
        refresh()
        // after a restart: work that is still queued / running shows on its card again
        viewModelScope.launch {
            WorkManager.getInstance(app).getWorkInfosByTagFlow("install").collect { infos ->
                for (w in infos) {
                    val id = w.tags.firstOrNull { it.startsWith("app:") }?.removePrefix("app:") ?: continue
                    if (!w.state.isFinished && Tasks.get(id) == null) {
                        Tasks.set(id, Task.Queued(waitingForWifi = w.state == WorkInfo.State.ENQUEUED && !InstallWorker.onUnmetered(app)))
                    }
                }
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _loading.value = true
            repo.refresh()
            _loading.value = false
        }
    }

    /** on every return to the store: what is installed now, may it install, a pending install to continue */
    fun onResume() {
        repo.refreshInstalled()
        _canInstall.value = Installer.canInstall(app)
        val p = _pending.value
        if (p != null && _canInstall.value) {
            _pending.value = null
            InstallWorker.enqueue(app, p)
        }
    }

    fun setRole(r: String) {
        prefs.role = r
        _role.value = r
    }

    fun install(a: StoreApp) {
        if (!Installer.canInstall(app)) {
            _pending.value = a
            return
        }
        InstallWorker.enqueue(app, a)
    }

    fun dismissPending() {
        _pending.value = null
    }

    fun cancel(a: StoreApp) = InstallWorker.cancel(app, a.id)

    /** every update; the store's own last (installing it restarts the store, WorkManager carries on with the rest) */
    fun updateAll(list: List<StoreApp>) {
        val ordered = list.sortedBy { if (it.kind == "store") 1 else 0 }
        if (!Installer.canInstall(app)) {
            _pending.value = ordered.firstOrNull()
            return
        }
        ordered.forEach { InstallWorker.enqueue(app, it) }
    }

    fun open(a: StoreApp) {
        val pkg = a.android?.packageName ?: return openWeb(a)
        val launch = app.packageManager.getLaunchIntentForPackage(pkg)
        if (launch == null) {
            Toast.makeText(app, app.getString(R.string.err_cannot_open), Toast.LENGTH_SHORT).show()
            return
        }
        app.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun openWeb(a: StoreApp) {
        val url = a.web ?: return
        try {
            app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(app, app.getString(R.string.err_no_browser), Toast.LENGTH_SHORT).show()
        }
    }

    fun uninstall(a: StoreApp) {
        val pkg = a.android?.packageName ?: return
        try {
            app.startActivity(Installer.uninstallIntent(pkg))
        } catch (_: ActivityNotFoundException) {
        }
    }
}
