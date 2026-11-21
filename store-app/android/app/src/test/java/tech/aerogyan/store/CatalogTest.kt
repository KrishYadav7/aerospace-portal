package tech.aerogyan.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The catalogue as GET /api/store sends it (fixture modelled on backend/internal/media/store_test.go), and the states. */
class CatalogTest {
    private val catalog = CatalogParser.parse(javaClass.classLoader!!.getResource("catalog.json")!!.readText())

    @Test fun parsesEveryEntry() {
        assertEquals(listOf("store", "aerogyan", "pack-students", "medico", "drishya", "ganak", "office-sheets", "office-courses"), catalog.apps.map { it.id })
        val main = catalog.byId("aerogyan")!!
        assertEquals("एरोज्ञान", main.title(true))
        assertEquals("AeroGyan", main.title(false))
        assertEquals("मुख्य ऐप।", main.about(true))
        val f = main.android!!
        assertEquals("tech.aerogyan.app", f.packageName)
        assertEquals(20L, f.versionCode)
        assertEquals(24, f.minSdk)
        assertEquals("1aceb4c23bbde60952f5dceb352dc7c25b4f400056fde982e8c125284ea53171", f.sha256)
        assertEquals("Faster PDFs.", f.notes)
        assertTrue(main.featured)
        assertEquals("tech.aerogyan.store", catalog.self!!.android!!.packageName)
        // an upper-case hash is lowered
        assertEquals("a".repeat(64), catalog.self!!.android!!.sha256)
    }

    @Test fun untrustedOrMissingFieldsAreDropped() {
        assertNull("an icon on another host is not loaded", catalog.byId("medico")!!.icon)
        assertNull("no versionCode stays null (compare by name)", catalog.byId("medico")!!.android!!.versionCode)
        assertNull(catalog.byId("office-courses")!!.android!!.sha256)
        val dr = catalog.byId("drishya")!!
        assertTrue(dr.webOnly)
        assertTrue(dr.needsComputer)
        assertEquals(listOf("432 Excel functions", "Charts"), catalog.byId("office-sheets")!!.features)
        assertEquals(listOf("office-sheets"), catalog.byId("pack-students")!!.includes)
    }

    @Test fun statesOnAPhone() {
        fun st(id: String, inst: Installed?, sdk: Int = 34) = States.state(catalog.byId(id)!!, inst, sdk)
        assertEquals(AppState.NOT_INSTALLED, st("aerogyan", null))
        assertEquals(AppState.UPDATE, st("aerogyan", Installed(19, "1.0.19", false)))
        assertEquals(AppState.INSTALLED, st("aerogyan", Installed(20, "1.0.20", false)))
        assertEquals(AppState.INSTALLED, st("aerogyan", Installed(25, "1.0.25", false))) // newer than listed: never offer a downgrade
        assertEquals(AppState.WEB_ONLY, st("drishya", null))
        assertEquals(AppState.COMING_SOON, st("ganak", null))
        assertEquals(AppState.INCOMPATIBLE, st("office-courses", null, 29))
        assertEquals(AppState.NOT_INSTALLED, st("office-courses", null, 30))
        // no versionCode in the catalogue: the version names decide
        assertEquals(AppState.UPDATE, st("medico", Installed(7, "0.9.3", false)))
        assertEquals(AppState.INSTALLED, st("medico", Installed(7, "1.0.0", false)))
        assertEquals(AppState.INSTALLED, st("medico", Installed(9, "1.0.1", false)))
    }

    @Test fun versionNames() {
        assertTrue(States.compareVersions("1.0.10", "1.0.9") > 0)
        assertTrue(States.compareVersions("1.0.0", "1.0.0-rc.2") > 0)
        assertTrue(States.compareVersions("1.0.0-rc.3", "1.0.0-rc.2") > 0)
        assertEquals(0, States.compareVersions("1.0", "1.0.0"))
        assertTrue(States.compareVersions("2", "1.9.9") > 0)
        assertTrue(States.compareVersions(null, "0.0.1") < 0)
    }

    @Test fun forYouByRole() {
        val student = States.forYou(catalog.apps, "student").map { it.id }
        val prof = States.forYou(catalog.apps, "professor").map { it.id }
        val everyone = States.forYou(catalog.apps, "everyone").map { it.id }
        assertFalse("the store itself is never listed", "store" in student + prof + everyone)
        assertEquals("aerogyan", student.first()) // featured first
        assertTrue("pack-students" in student && "office-sheets" in student && "medico" in student)
        assertFalse("office-courses" in student)
        assertTrue("office-courses" in prof && "office-sheets" in prof && "ganak" in prof)
        assertFalse("pack-students" in prof)
        assertTrue("medico" in everyone && "drishya" in everyone)
        assertFalse("office-courses" in everyone)
    }

    @Test fun updatesListTheStoreFirst() {
        val inst = mapOf(
            "tech.aerogyan.app" to Installed(19, "1.0.19", true),
            "tech.aerogyan.store" to Installed(10001, "1.0.1", false),
            "tech.aerogyan.office.sheets" to Installed(5, "1.0.5", true),
        )
        assertEquals(listOf("store", "aerogyan"), States.updates(catalog.apps, inst, 34).map { it.id })
    }

    // ⭐ 1.0.1 — Sankalak, Shilp and IndPay as /api/store sends them (store_test.go TestStoreNewProducts): icons from
    // aerogyan.tech load, IndPay before its first APK is "coming soon", Sankalak with its file is installable
    @Test fun newProducts() {
        val c = CatalogParser.parse("""{"success":true,"apps":[
 {"id":"sankalak","kind":"app","product":"sankalak","name":"Sankalak","nameHi":"संकलक","audience":["student","professor"],"icon":"https://aerogyan.tech/store/icons/sankalak-192.png","web":"https://sankalak.aerogyan.tech/",
  "platforms":{"android":{"available":true,"package":"tech.aerogyan.sankalak","minSdk":24,"signers":["80f61bbc361870938647650cc009bb50811a341f1a8d93474539b46740e65791"],"version":"1.0.0","size":705228,"sha256":"4740c20c6092cfc1ccff7388c5275d776f488f62f2655af3d5dba1be44cf10c9","url":"https://sankalak.aerogyan.tech/download/android","fileName":"Sankalak-1.0.0.apk"}}},
 {"id":"shilp","kind":"app","product":"shilp","name":"Shilp","nameHi":"शिल्प","audience":["student","professor"],"icon":"https://aerogyan.tech/store/icons/shilp-192.png","web":"https://shilp.aerogyan.tech/",
  "platforms":{"android":{"available":true,"package":"tech.aerogyan.shilp","minSdk":24,"version":"1.0.0","size":613576,"sha256":"bf3f49cd05d1161afa409d5a2b3248da1454958e234a56a5ab1ad7c5ba25b003","url":"https://shilp.aerogyan.tech/download/android"}}},
 {"id":"indpay","kind":"app","product":"indpay","name":"IndPay","nameHi":"इंडपे","audience":["everyone"],"icon":"https://aerogyan.tech/store/icons/indpay-192.png","web":"https://indpay.aerogyan.tech/",
  "platforms":{"android":{"available":false,"package":"tech.aerogyan.indpay","minSdk":26,"signers":["540c133a60eec3de967456d640f5ef8fdd93c880abedbcb670feb1107fbc0582"]}}}
]}""")
        assertEquals(listOf("sankalak", "shilp", "indpay"), c.apps.map { it.id })
        for (a in c.apps) assertEquals(a.id, "https://aerogyan.tech/store/icons/${a.id}-192.png", a.icon)
        fun st(id: String, inst: Installed?, sdk: Int = 34) = States.state(c.byId(id)!!, inst, sdk)
        assertEquals(AppState.NOT_INSTALLED, st("sankalak", null))
        assertEquals(AppState.INSTALLED, st("sankalak", Installed(10000, "1.0.0", false)))
        assertEquals(AppState.UPDATE, st("shilp", Installed(1, "0.9.0", false)))
        assertEquals(AppState.COMING_SOON, st("indpay", null))
        assertEquals("tech.aerogyan.indpay", c.byId("indpay")!!.android!!.packageName)
        assertTrue("indpay" in States.forYou(c.apps, "everyone").map { it.id })
        assertTrue("sankalak" in States.forYou(c.apps, "student").map { it.id })
    }

    @Test fun search() {
        assertTrue(catalog.byId("office-sheets")!!.matches("excel"))
        assertTrue(catalog.byId("office-sheets")!!.matches("शीट"))
        assertFalse(catalog.byId("office-sheets")!!.matches("medico"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun failedAnswerIsAnError() {
        CatalogParser.parse("""{"success":false,"message":"down"}""")
    }
}
