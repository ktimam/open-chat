package com.ocplugin.app.privateapps

import org.junit.Assert.*
import org.junit.Test

class LocalAppLeasePolicyTest {
    private val handoff = "handoff:" + "a".repeat(32)
    private val newer = "handoff:" + "b".repeat(32)
    private val setup = "setup:" + "c".repeat(32)

    @Test fun concurrentNamespacesAndStaleCloseAreIndependent() {
        val p = LocalAppLeasePolicy()
        assertTrue(p.start(handoff, 0, 120_000)); assertTrue(p.start(setup, 0, 600_000))
        assertFalse(p.start(newer, 1, 120_000))
        p.release(handoff); assertTrue(p.active(setup, 2))
        assertTrue(p.start(newer, 3, 120_000)); p.release(handoff)
        assertTrue(p.active(newer, 4)); assertTrue(p.active(setup, 4))
    }
    @Test fun claimExtendsOnlyExistingHandoffOnceAndDeadlineIsInclusive() {
        val p = LocalAppLeasePolicy(); assertTrue(p.start(handoff, 10, 120_000))
        assertTrue(p.extend(handoff, 120_009, 600_000))
        assertFalse(p.extend(handoff, 120_009, 600_000))
        assertTrue(p.active(handoff, 720_008)); assertFalse(p.active(handoff, 720_009))
        assertFalse(p.extend(handoff, 720_009, 1))
    }
    @Test fun expiredMissingStoppedAndSetupOwnersCannotExtend() {
        val p = LocalAppLeasePolicy()
        assertFalse(p.extend(handoff, 0, 1)); assertTrue(p.start(handoff, 1, 10))
        assertFalse(p.extend(handoff, 11, 600_000))
        assertTrue(p.start(setup, 12, 600_000)); assertFalse(p.extend(setup, 13, 1))
        p.clear(); assertFalse(p.active(setup, 14)); assertFalse(p.extend(setup, 14, 1))
    }
    @Test fun invalidOwnerBoundsOverflowAndClockRollbackFailClosed() {
        val p = LocalAppLeasePolicy()
        for (owner in listOf("auth:" + "a".repeat(32), "handoff:" + "A".repeat(32), handoff + "x")) assertFalse(p.start(owner, 0, 1))
        assertFalse(p.start(handoff, 0, 0)); assertFalse(p.start(handoff, 0, 120_001))
        assertFalse(p.start(setup, 0, 600_001)); assertFalse(p.start(handoff, Long.MAX_VALUE, 1))
        val rollback = LocalAppLeasePolicy(); assertTrue(rollback.start(handoff, 10, 100))
        assertFalse(rollback.active(handoff, 9)); assertFalse(rollback.active(handoff, 10))
    }
    @Test fun independentExpiryKeepsOtherOwnerAndEmptyRegistryStops() {
        val p = LocalAppLeasePolicy(); p.start(handoff, 0, 5); p.start(setup, 0, 10)
        assertEquals(5L, p.remaining(0)); assertFalse(p.active(handoff, 5)); assertTrue(p.active(setup, 5))
        assertEquals(5L, p.remaining(5)); assertNull(p.remaining(10))
    }
}
