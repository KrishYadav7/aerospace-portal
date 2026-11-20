package tech.aerogyan.store

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** What the store is doing for one app right now (the card shows it). */
sealed class Task {
    data class Queued(val waitingForWifi: Boolean) : Task()
    data class Downloading(val done: Long, val total: Long) : Task() {
        val fraction: Float get() = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f
    }
    object Verifying : Task()
    object Installing : Task()
    /** the system wants the user's OK (first install, or the store is not the installer of record) */
    object WaitingForUser : Task()
    data class Failed(val message: String) : Task()
}

/** One process-wide map app id → task; workers and the install receiver write, the screens read. */
object Tasks {
    private val _all = MutableStateFlow<Map<String, Task>>(emptyMap())
    val all: StateFlow<Map<String, Task>> = _all

    /** package → app id, for the install receiver */
    private val byPackage = HashMap<String, String>()

    fun set(appId: String, task: Task?) = _all.update { m -> if (task == null) m - appId else m + (appId to task) }
    fun get(appId: String): Task? = _all.value[appId]

    @Synchronized fun remember(pkg: String, appId: String) { byPackage[pkg] = appId }
    @Synchronized fun appFor(pkg: String): String? = byPackage[pkg]

    val busy: Boolean get() = _all.value.values.any { it !is Task.Failed }
}
