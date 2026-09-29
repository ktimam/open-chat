package android.util

import fixtures.Probe

object Log {
    fun d(tag: String, message: String): Int {
        Probe.logs.add(Triple("debug", tag, message))
        return 0
    }

    fun e(tag: String, message: String): Int {
        Probe.logs.add(Triple("error", tag, message))
        return 0
    }
}
