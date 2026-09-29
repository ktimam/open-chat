package fixtures

import android.app.Application
import android.content.Context

object Probe {
    var applicationId = "test.installed.application"
    var activityConstructions = 0
    val events = mutableListOf<String>()
    val lifecycleCallbacks = mutableListOf<Application.ActivityLifecycleCallbacks>()
    val logs = mutableListOf<Triple<String, String, String>>()
    var firebaseAvailable = true
    var onFirebase: ((Context) -> Unit)? = null
    var onDatabase: ((Context) -> Unit)? = null
}
