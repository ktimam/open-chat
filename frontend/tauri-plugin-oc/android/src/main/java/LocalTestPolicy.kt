package com.ocplugin.app

import android.content.Context

internal fun isUnofficialLocalTest(context: Context): Boolean {
    // Preserve the tested native app transport/FCM policy for the distinct release package.
    val resource = when (context.packageName) {
        "dev.openchatfork.localtest" -> "openchat_local_test"
        "io.github.ktimam.openchatprivate" -> "openchat_private"
        else -> return false
    }
    val id = context.resources.getIdentifier(resource, "bool", context.packageName)
    return id != 0 && context.resources.getBoolean(id)
}
