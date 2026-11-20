package tech.aerogyan.store

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import androidx.appcompat.app.AppCompatDelegate
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.Locale

class StoreApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Notify.channels(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { inForeground = true }
            override fun onStop(owner: LifecycleOwner) { inForeground = false }
        })
        UpdateWorker.schedule(this)
    }

    companion object {
        @Volatile var inForeground = false
    }
}

/** English or Hindi: the in-app choice (AppCompat per-app language), else the phone's language. */
object Lang {
    fun current(context: Context): Locale {
        val app = AppCompatDelegate.getApplicationLocales()
        if (!app.isEmpty) app[0]?.let { return it }
        val cfg: Configuration = context.resources.configuration
        return cfg.locales[0] ?: Locale.getDefault()
    }

    fun isHindi(context: Context) = current(context).language == "hi"
}
