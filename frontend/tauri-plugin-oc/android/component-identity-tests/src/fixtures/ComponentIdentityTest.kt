package fixtures

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.oclabs.openchat.BuildConfig
import com.oclabs.openchat.MainActivity
import com.oclabs.openchat.MyApplication
import com.oclabs.openchat.NotificationDismissReceiver
import com.ocplugin.app.IntentsManager
import com.ocplugin.app.data.Notification
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class ComponentIdentityTest(
    private val differentId: Boolean,
    private val sdk: Int,
    private val localTest: Boolean,
) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "differentId={0}, sdk={1}, localTest={2}")
        fun scenarios(): Collection<Array<Any>> = listOf(false, true).flatMap { differentId ->
            listOf(22, 36).flatMap { sdk ->
                listOf(false, true).map { localTest -> arrayOf<Any>(differentId, sdk, localTest) }
            }
        }
    }

    private val notification = Notification(
        42L,
        """{"id":42,"contextId":7,"type":"DM","body":"image \"quoted\"","image":"content://fixture/image"}""",
    )

    @Before
    fun resetProcessFixture() {
        // Model a new process without adding a production reset/test-only API.
        IntentsManager::class.java.getDeclaredField("componentClasses").apply {
            isAccessible = true
        }.set(null, null)
        Probe.applicationId = if (differentId) "test.installed.application" else MainActivity::class.java.packageName
        Probe.activityConstructions = 0
        Probe.events.clear()
        Probe.lifecycleCallbacks.clear()
        Probe.logs.clear()
        Probe.firebaseAvailable = true
        Probe.onFirebase = null
        Probe.onDatabase = null
        Build.VERSION.SDK_INT = sdk
        BuildConfig.UNOFFICIAL_LOCAL_TEST = localTest
        MyApplication::class.java.getDeclaredField("isAppInForeground").apply {
            isAccessible = true
        }.setBoolean(null, false)
    }

    @Test
    fun everyPathFailsClearlyBeforeApplicationRegistration() {
        val context = Context()
        val paths: List<() -> Any> = listOf(
            { IntentsManager.buildDeleteIntentForSummary(context) },
            { IntentsManager.buildPendingIntentForNotification(context, notification) },
            { IntentsManager.buildDeleteIntentNotification(context, notification) },
            { IntentsManager.buildNotificationShortcutIntent(context, notification) },
        )
        paths.forEach { createIntent ->
            val error = assertThrows(IllegalStateException::class.java) { createIntent() }
            assertTrue(error.message!!.contains("IntentsManager.registerComponents"))
            assertTrue(error.message!!.contains("Application.onCreate"))
        }
        assertEquals(0, Probe.activityConstructions)
    }

    @Test
    fun coldApplicationRegistersBeforeServicesWithoutCreatingAnActivity() {
        // Actual MyApplication.onCreate must already have registered components
        // when either service dependency is reached, even on a background start.
        Probe.onFirebase = ::assertAllFourPaths
        Probe.onDatabase = ::assertAllFourPaths
        val application = MyApplication()
        application.onCreate()
        assertEquals(startupEvents(), Probe.events)
        assertEquals(0, Probe.activityConstructions)
        assertFalse(MyApplication.isAppInForeground)
        assertEquals(1, Probe.lifecycleCallbacks.size)
        if (localTest) assertTrue("local-test startup must not initialize Firebase or log its failure", Probe.logs.isEmpty())
        else assertEquals(listOf("debug" to "Firebase initialized: test"), Probe.logs.map { it.first to it.third })
        assertAllFourPaths(application)
    }

    @Test
    fun onlyMainActivityStartStopControlsForegroundVisibility() {
        assertTrue(
            "the production foreground flag must retain volatile cross-thread publication",
            java.lang.reflect.Modifier.isVolatile(
                MyApplication::class.java.getDeclaredField("isAppInForeground").modifiers,
            ),
        )
        MyApplication().onCreate()
        val callbacks = Probe.lifecycleCallbacks.single()
        val main = MainActivity()
        val other = Activity() // For example, a native incoming-call screen.

        callbacks.onActivityCreated(main, null)
        callbacks.onActivityCreated(other, Bundle())
        callbacks.onActivityResumed(main)
        callbacks.onActivityStarted(other)
        callbacks.onActivityResumed(other)
        callbacks.onActivitySaveInstanceState(main, Bundle())
        assertFalse("non-main activity startup must not mark the chat/web layer visible", MyApplication.isAppInForeground)

        callbacks.onActivityStarted(main)
        assertTrue(MyApplication.isAppInForeground)
        callbacks.onActivityStarted(other)
        callbacks.onActivityPaused(main)
        callbacks.onActivityPaused(other)
        callbacks.onActivityStopped(other)
        callbacks.onActivityDestroyed(other)
        assertTrue("another activity stopping must not hide the main activity", MyApplication.isAppInForeground)

        val backgroundValue = AtomicReference<Boolean?>()
        val background = Thread { backgroundValue.set(MyApplication.isAppInForeground) }
        background.start()
        background.join(1000)
        assertFalse("background visibility read did not complete", background.isAlive)
        assertEquals(true, backgroundValue.get())

        callbacks.onActivityStopped(main)
        assertFalse(MyApplication.isAppInForeground)
        callbacks.onActivityResumed(other)
        callbacks.onActivityDestroyed(main)
        assertFalse("non-start callbacks must not re-enable foreground routing", MyApplication.isAppInForeground)
    }

    @Test
    fun firebaseUnavailableDoesNotSkipDatabaseOrComponentRegistration() {
        Probe.firebaseAvailable = false
        Probe.onFirebase = ::assertAllFourPaths
        Probe.onDatabase = ::assertAllFourPaths
        val application = MyApplication()
        application.onCreate()
        assertEquals(startupEvents(), Probe.events)
        assertEquals(1, Probe.lifecycleCallbacks.size)
        assertEquals(0, Probe.activityConstructions)
        assertFalse(MyApplication.isAppInForeground)
        if (localTest) assertTrue("local-test startup must never attempt Firebase", Probe.logs.isEmpty())
        else assertEquals(listOf("error" to "Firebase failed to initialize!"), Probe.logs.map { it.first to it.third })
        assertAllFourPaths(application)
    }

    @Test
    fun registeredClassesAreAvailableOnABackgroundThread() {
        val application = MyApplication()
        application.onCreate()
        val failure = AtomicReference<Throwable?>()
        val background = Thread {
            try { assertAllFourPaths(application) } catch (error: Throwable) { failure.set(error) }
        }
        background.start()
        background.join(1000)
        assertFalse("background intent creation did not complete", background.isAlive)
        failure.get()?.let { throw AssertionError("background intent creation failed", it) }
        assertEquals(0, Probe.activityConstructions)
    }

    private fun startupEvents(): List<String> =
        if (localTest) listOf("super.onCreate", "database", "activityLifecycle")
        else listOf("super.onCreate", "firebase", "database", "activityLifecycle")

    private fun assertAllFourPaths(context: Context) {
        val immutableUpdate = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun assertTarget(intent: Intent, target: Class<*>) {
            assertEquals(Probe.applicationId, intent.component.packageName)
            assertEquals(target.name, intent.component.className)
            assertEquals(differentId, intent.component.packageName != target.packageName)
        }

        val summary = IntentsManager.buildDeleteIntentForSummary(context)
        assertEquals("broadcast", summary.kind)
        assertEquals(-1, summary.requestCode)
        assertEquals(immutableUpdate, summary.flags)
        assertTarget(summary.intent, NotificationDismissReceiver::class.java)
        assertEquals(mapOf("summaryDismiss" to true), summary.intent.extras)
        assertEquals(0, summary.intent.flags)
        assertNull(summary.intent.action)

        val tap = IntentsManager.buildPendingIntentForNotification(context, notification)
        assertEquals("activity", tap.kind)
        assertEquals(42, tap.requestCode)
        assertEquals(if (sdk >= 23) immutableUpdate else PendingIntent.FLAG_UPDATE_CURRENT, tap.flags)
        assertTarget(tap.intent, MainActivity::class.java)
        assertEquals(mapOf("notificationPayload" to notification.payload), tap.intent.extras)
        assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP, tap.intent.flags)
        assertNull(tap.intent.action)

        val dismiss = IntentsManager.buildDeleteIntentNotification(context, notification)
        assertEquals("broadcast", dismiss.kind)
        assertEquals(42, dismiss.requestCode)
        assertEquals(immutableUpdate, dismiss.flags)
        assertTarget(dismiss.intent, NotificationDismissReceiver::class.java)
        assertEquals(mapOf("notificationPayload" to notification.payload), dismiss.intent.extras)
        assertEquals(0, dismiss.intent.flags)
        assertNull(dismiss.intent.action)

        val shortcut = IntentsManager.buildNotificationShortcutIntent(context, notification)
        assertTarget(shortcut, MainActivity::class.java)
        assertEquals(mapOf("notificationPayload" to notification.payload), shortcut.extras)
        assertEquals(Intent.ACTION_VIEW, shortcut.action)
        assertEquals(0, shortcut.flags)
    }
}
