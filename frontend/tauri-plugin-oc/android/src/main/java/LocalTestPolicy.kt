package com.ocplugin.app

import android.content.Context

internal fun isUnofficialLocalTest(context: Context): Boolean {
    if (context.packageName != "dev.openchatfork.localtest") return false
    val id = context.resources.getIdentifier("openchat_local_test", "bool", context.packageName)
    return id != 0 && context.resources.getBoolean(id)
}
