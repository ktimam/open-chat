use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{Milliseconds, TimestampMillis};

const WINDOW: Milliseconds = 60 * 60 * 1000; // failures are counted over a sliding 1-hour window

// Per-caller cap: generous for a human retyping a code, useless for brute force. An attacker can
// mint fresh self-authenticating principals, which is what the GLOBAL cap is for — it bounds the
// total probe rate of the whole 6-digit code space / registered-PEM space regardless of principal
// churn, at the cost that a sustained attack also locks out legitimate retries for the window
// (retry-after is returned so clients can back off).
const MAX_FAILURES_PER_CALLER: usize = 10;
const MAX_FAILURES_GLOBAL: usize = 1_000;

/// Failure throttle for the two bearer-authorized AI-app endpoints (`claim_ai_app_link_code`,
/// `revoke_ai_app_user_key`). Only FAILED attempts count — successful claims/revokes are never
/// throttled — so the caps only bite on guessing. Heap state, serialized across upgrades like the
/// other models; pruning happens inline on every touch so memory stays bounded by recent activity.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppCallThrottle {
    failures: HashMap<Principal, Vec<TimestampMillis>>,
    global: Vec<TimestampMillis>,
}

impl AiAppCallThrottle {
    /// Returns Err(retry_after_ms) when the caller (or the canister globally) has too many recent
    /// failures. Does NOT record anything — call `record_failure` when the attempt actually fails.
    pub fn check(&mut self, caller: Principal, now: TimestampMillis) -> Result<(), Milliseconds> {
        self.prune(now);
        if self.global.len() >= MAX_FAILURES_GLOBAL {
            return Err(Self::retry_after(&self.global, now));
        }
        if let Some(failures) = self.failures.get(&caller) {
            if failures.len() >= MAX_FAILURES_PER_CALLER {
                return Err(Self::retry_after(failures, now));
            }
        }
        Ok(())
    }

    pub fn record_failure(&mut self, caller: Principal, now: TimestampMillis) {
        self.failures.entry(caller).or_default().push(now);
        self.global.push(now);
    }

    fn prune(&mut self, now: TimestampMillis) {
        let cutoff = now.saturating_sub(WINDOW);
        self.global.retain(|t| *t > cutoff);
        self.failures.retain(|_, timestamps| {
            timestamps.retain(|t| *t > cutoff);
            !timestamps.is_empty()
        });
    }

    // Ms until the OLDEST counted failure ages out of the window — the earliest moment a retry
    // can succeed.
    fn retry_after(timestamps: &[TimestampMillis], now: TimestampMillis) -> Milliseconds {
        timestamps.iter().min().map_or(WINDOW, |oldest| (oldest + WINDOW).saturating_sub(now))
    }
}
