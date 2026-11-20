package tech.aerogyan.store

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import tech.aerogyan.store.ui.StoreRoot
import tech.aerogyan.store.ui.StoreTheme

class MainActivity : AppCompatActivity() {
    private val vm: StoreViewModel by viewModels()
    private val openTab = mutableStateOf<String?>(null)

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        openTab.value = intent?.getStringExtra(Notify.EXTRA_OPEN_TAB)
        setContent {
            StoreTheme {
                StoreRoot(
                    vm = vm,
                    openTab = openTab.value,
                    onTabOpened = { openTab.value = null },
                    onOnboarded = { maybeAskNotifications() },
                    openUnknownSources = { startActivity(Installer.unknownSourcesIntent(this)) },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Notify.EXTRA_OPEN_TAB)?.let { openTab.value = it }
    }

    override fun onResume() {
        super.onResume()
        vm.onResume()
    }

    /** Android 13+: ask once, after the first-run question, for the "updates available" notice. */
    private fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT < 33 || vm.prefs.askedNotifications) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        vm.prefs.askedNotifications = true
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
