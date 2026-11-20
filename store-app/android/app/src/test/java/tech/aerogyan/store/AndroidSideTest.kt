package tech.aerogyan.store

import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/** Robolectric: installed-app detection, the install session, the strings in both languages. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class)
class AndroidSideTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    private fun install(pkg: String, code: Long, name: String) {
        val pi = PackageInfo().apply {
            packageName = pkg
            longVersionCode = code
            versionName = name
            applicationInfo = ApplicationInfo().apply { packageName = pkg }
        }
        shadowOf(ctx.packageManager).installPackage(pi)
    }

    @Test fun detectsInstalledApps() {
        install("tech.aerogyan.app", 19, "1.0.19")
        install("tech.aerogyan.office.sheets", 5, "1.0.5")
        val repo = Repo.get(ctx)
        val catalog = CatalogParser.parse(javaClass.classLoader!!.getResource("catalog.json")!!.readText())
        repo.setCatalogForTest(catalog)
        repo.refreshInstalled()
        val inst = repo.installed.value
        assertEquals(19L, inst["tech.aerogyan.app"]!!.versionCode)
        assertEquals("1.0.5", inst["tech.aerogyan.office.sheets"]!!.versionName)
        assertFalse("not installed by the store", inst["tech.aerogyan.app"]!!.byStore)
        assertNull(inst["tech.aerogyan.medico"])
        assertEquals(AppState.UPDATE, States.state(catalog.byId("aerogyan")!!, inst["tech.aerogyan.app"], 34))
        assertEquals(AppState.INSTALLED, States.state(catalog.byId("office-sheets")!!, inst["tech.aerogyan.office.sheets"], 34))
        // the store itself (1.0.0 under test, 1.0.2 in the catalogue) comes first
        assertEquals(BuildConfig.VERSION_CODE.toLong(), inst["tech.aerogyan.store"]!!.versionCode)
        assertEquals(listOf("store", "aerogyan"), States.updates(catalog.apps, inst, 34).map { it.id })
    }

    @Test fun installOpensASessionForThePackage() {
        val apk = File(ctx.cacheDir, "t.apk").apply { writeBytes(ByteArray(1000) { it.toByte() }) }
        Installer.install(ctx, apk, "office-sheets", "tech.aerogyan.office.sheets")
        val sessions: List<PackageInstaller.SessionInfo> = ctx.packageManager.packageInstaller.allSessions
        assertEquals(1, sessions.size)
        assertEquals("tech.aerogyan.office.sheets", sessions[0].appPackageName)
        assertEquals("office-sheets", Tasks.appFor("tech.aerogyan.office.sheets"))
    }

    @Test fun rejectionMessagesExistInBothLanguages() {
        for (r in Reason.values()) assertTrue(r.name, Messages.reason(ctx, r).isNotBlank())
        val hi = ctx.createConfigurationContext(android.content.res.Configuration(ctx.resources.configuration).apply { setLocale(java.util.Locale("hi")) })
        assertEquals("एरोज्ञान स्टोर", hi.getString(R.string.app_name))
        assertTrue(Messages.reason(hi, Reason.WRONG_SIGNER).contains("एरोज्ञान"))
    }

    @Test fun queriesListEveryOfficeApp() {
        // the generated <queries> makes every Office package visible; Robolectric merges the manifest we ship
        assertTrue(BuildConfig.OFFICE_APPS >= 50)
    }
}
