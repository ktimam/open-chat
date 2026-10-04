package com.ocplugin.app.privateapps

/** Pure elapsed-time policy; retention is never authority to receive or send app data. */
internal class LocalAppLeasePolicy {
    private data class Lease(val owner: String, val started: Long, var deadline: Long, var extended: Boolean = false)
    private val leases = mutableMapOf<String, Lease>()
    private var lastNow = -1L

    private fun scope(owner: String): String? =
        Regex("^(handoff|setup):[0-9a-f]{32}$").matchEntire(owner)?.groupValues?.get(1)

    private fun prune(now: Long): Boolean {
        if (now < 0 || now < lastNow) { leases.clear(); lastNow = now; return false }
        lastNow = now
        leases.entries.removeAll { now >= it.value.deadline }
        return true
    }

    @Synchronized fun start(owner: String, now: Long, remainingMs: Long): Boolean {
        if (!prune(now)) return false
        val kind = scope(owner) ?: return false
        val maximum = if (kind == "handoff") 120_000L else 600_000L
        if (remainingMs !in 1..maximum || now > Long.MAX_VALUE - 720_000L || leases.containsKey(kind)) return false
        leases[kind] = Lease(owner, now, now + remainingMs)
        return true
    }

    @Synchronized fun extend(owner: String, now: Long, remainingMs: Long): Boolean {
        if (!prune(now) || remainingMs !in 1..600_000L || scope(owner) != "handoff") return false
        val lease = leases["handoff"]?.takeIf { it.owner == owner && !it.extended } ?: return false
        lease.deadline = minOf(now + remainingMs, lease.started + 720_000L)
        lease.extended = true
        return true
    }

    @Synchronized fun active(owner: String, now: Long): Boolean {
        if (!prune(now)) return false
        return leases[scope(owner)]?.owner == owner
    }

    @Synchronized fun release(owner: String) {
        val kind = scope(owner) ?: return
        if (leases[kind]?.owner == owner) leases.remove(kind)
    }

    @Synchronized fun remaining(now: Long): Long? {
        if (!prune(now)) return null
        return leases.values.minOfOrNull { it.deadline - now }
    }

    @Synchronized fun clear() { leases.clear() }
}
