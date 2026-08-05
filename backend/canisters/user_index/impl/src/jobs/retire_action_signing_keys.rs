use crate::model::action_signing_keyring::{ActionSigningKeyring, MAX_ACTION_SIGNING_KEYS};
use crate::{RuntimeState, mutate_state};
use ic_cdk_timers::TimerId;
use std::cell::Cell;
use std::time::Duration;
use tracing::trace;
use types::TimestampMillis;

const RETIRE_INTERVAL: Duration = Duration::from_secs(60 * 60);

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

/// Started by the shared lifecycle initializer on both install and post-upgrade. The keyring is
/// capped at three entries, so every retirement pass has an explicit constant work bound.
pub(crate) fn start_job_if_required(_state: &RuntimeState) -> bool {
    if TIMER_ID.get().is_some() {
        return false;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(RETIRE_INTERVAL, run)));
    true
}

fn run() {
    trace!("'retire_action_signing_keys' job running");
    TIMER_ID.set(None);
    mutate_state(|state| {
        retire_expired(&mut state.data.action_signing_keyring, state.env.now());
    });
    // Never stop the timer after an idle pass: an active key may be rotated before the next pass.
    let _ = start_timer();
}

fn start_timer() -> bool {
    if TIMER_ID.get().is_some() {
        return false;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(RETIRE_INTERVAL, run)));
    true
}

fn retire_expired(keyring: &mut ActionSigningKeyring, now: TimestampMillis) -> usize {
    let retired = keyring.retire_expired(now);
    debug_assert!(retired <= MAX_ACTION_SIGNING_KEYS);
    retired
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::action_signing_keyring::RETAIN_VERIFY_ONLY_KEY_MILLIS;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    #[test]
    fn periodic_pass_retires_only_expired_verify_only_keys_with_a_constant_bound() {
        let mut rng = StdRng::seed_from_u64(73);
        let mut keyring = ActionSigningKeyring::default();
        keyring.ensure_initialized(&mut rng, 1).unwrap();
        let initial = *keyring.public_keys().next().unwrap().key_id;
        keyring.activate(&initial, 1).unwrap();
        let replacement = keyring.stage(&mut rng, 2).unwrap();
        keyring.activate(&replacement, 3).unwrap();

        assert_eq!(retire_expired(&mut keyring, 3 + RETAIN_VERIFY_ONLY_KEY_MILLIS - 1), 0);
        assert_eq!(keyring.public_keys().count(), 2);
        assert_eq!(retire_expired(&mut keyring, 3 + RETAIN_VERIFY_ONLY_KEY_MILLIS), 1);
        assert_eq!(keyring.public_keys().count(), 1);
        assert!(keyring.active_key().is_some());
    }

    #[test]
    fn retirement_schedule_is_hourly() {
        assert_eq!(RETIRE_INTERVAL, Duration::from_secs(60 * 60));
    }
}
