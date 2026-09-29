package android.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import fixtures.Probe

open class Activity : Context()

open class Application : Context() {
    open fun onCreate() { Probe.events.add("super.onCreate") }

    interface ActivityLifecycleCallbacks {
        fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?)
        fun onActivityStarted(activity: Activity)
        fun onActivityResumed(activity: Activity)
        fun onActivityPaused(activity: Activity)
        fun onActivityStopped(activity: Activity)
        fun onActivitySaveInstanceState(activity: Activity, outState: Bundle)
        fun onActivityDestroyed(activity: Activity)
    }

    fun registerActivityLifecycleCallbacks(callbacks: ActivityLifecycleCallbacks) {
        Probe.events.add("activityLifecycle")
        Probe.lifecycleCallbacks.add(callbacks)
    }
}

// Records the exact Android factory arguments supplied by the real production code.
data class PendingIntent(
    val kind: String,
    val requestCode: Int,
    val intent: Intent,
    val flags: Int,
) {
    companion object {
        const val FLAG_UPDATE_CURRENT = 0x08000000
        const val FLAG_IMMUTABLE = 0x04000000

        fun getBroadcast(context: Context, requestCode: Int, intent: Intent, flags: Int) =
            PendingIntent("broadcast", requestCode, intent, flags).also {
                check(context.packageName == intent.component.packageName)
            }

        fun getActivity(context: Context, requestCode: Int, intent: Intent, flags: Int) =
            PendingIntent("activity", requestCode, intent, flags).also {
                check(context.packageName == intent.component.packageName)
            }
    }
}
