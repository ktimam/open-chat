use crate::{RuntimeState, mutate_state};
use ic_cdk_timers::TimerId;
use rand::rngs::StdRng;
use std::cell::Cell;
use std::time::Duration;
use types::{
    PR2_ENTROPY_RESEED_WATCHDOG_MS, Pr2EntropyCommitmentMode, Pr2EntropyLifecycleId, Pr2EntropyReseedAdmission,
    Pr2EntropyReseedTicket, Pr2EntropyReseedWatchdog,
};

const ACTION_SIGNING_KEY_INIT_PURPOSE: &[u8] = b"user-index/action-signing-key/init/v1";
const SCOPED_IDENTITY_KEY_INIT_PURPOSE: &[u8] = b"user-index/ai-app-scoped-identity/init/v1";

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) const TEST_CANISTER_VERSION: u64 = 1;

#[cfg(target_arch = "wasm32")]
fn lifecycle_version_salt() -> u64 {
    ic_cdk::api::canister_version()
}

#[cfg(not(target_arch = "wasm32"))]
fn lifecycle_version_salt() -> u64 {
    TEST_CANISTER_VERSION
}

/// Advances the logical lifecycle synchronously, revokes only short-lived bearers, then schedules
/// one bounded PR2-only raw_rand reseed. Long-lived signing/scoped keys and the durable outbox are
/// deliberately preserved.
pub(crate) fn start_after_lifecycle() {
    let version_salt = lifecycle_version_salt();
    match mutate_state(|state| advance_lifecycle(state, version_salt)) {
        Ok(_) => schedule(Duration::ZERO),
        Err(error) => tracing::error!(version_salt, error, "PR2 entropy lifecycle advance failed closed"),
    }
}

pub(crate) fn advance_lifecycle(state: &mut RuntimeState, version_salt: u64) -> Result<Pr2EntropyLifecycleId, &'static str> {
    state.data.ai_app_link_codes.invalidate_all();
    state.data.ai_app_card_tokens.invalidate_all_bearers();
    state.data.ai_app_chat_link_tokens.invalidate_active_bearers();
    state.data.pr2_entropy.advance_lifecycle(version_salt)
}

pub(crate) fn is_ready(state: &RuntimeState) -> bool {
    state.data.pr2_entropy.is_ready()
}

pub(crate) fn output_rng(state: &mut RuntimeState, purpose: &[u8]) -> Result<StdRng, &'static str> {
    let canister_id = state.env.canister_id();
    state.data.pr2_entropy.output_rng(canister_id, purpose)
}

fn schedule(delay: Duration) {
    if TIMER_ID.get().is_some() {
        return;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(delay, async { attempt_reseed() })));
}

fn attempt_reseed() {
    TIMER_ID.set(None);
    let now = canister_time::now_millis();
    let admission = mutate_state(|state| state.data.pr2_entropy.begin_reseed(now));
    match admission {
        Pr2EntropyReseedAdmission::Unavailable | Pr2EntropyReseedAdmission::Ready => {}
        Pr2EntropyReseedAdmission::InProgress {
            ticket,
            watchdog_delay_ms,
        } => schedule_watchdog(ticket, watchdog_delay_ms),
        Pr2EntropyReseedAdmission::RetryAfter(delay_ms) => schedule(Duration::from_millis(delay_ms)),
        Pr2EntropyReseedAdmission::Started(ticket) => {
            schedule_watchdog(ticket, PR2_ENTROPY_RESEED_WATCHDOG_MS);
            ic_cdk::futures::spawn_migratory(finish_reseed(ticket));
        }
    }
}

fn schedule_watchdog(ticket: Pr2EntropyReseedTicket, delay_ms: u64) {
    let _ = ic_cdk_timers::set_timer(Duration::from_millis(delay_ms), async move {
        check_watchdog(ticket);
    });
}

fn check_watchdog(ticket: Pr2EntropyReseedTicket) {
    let now = canister_time::now_millis();
    let outcome = mutate_state(|state| state.data.pr2_entropy.check_reseed_watchdog(ticket, now));
    match outcome {
        Pr2EntropyReseedWatchdog::Stale => {}
        Pr2EntropyReseedWatchdog::Pending(delay_ms) => schedule_watchdog(ticket, delay_ms),
        Pr2EntropyReseedWatchdog::Expired => schedule(Duration::ZERO),
    }
}

async fn finish_reseed(ticket: Pr2EntropyReseedTicket) {
    let raw_rand = ic_cdk_management_canister::raw_rand().await;
    let now = canister_time::now_millis();
    let retry = mutate_state(|state| {
        let canister_id = state.env.canister_id();
        let commitment_mode = Pr2EntropyCommitmentMode::from_test_mode(state.data.test_mode);
        match raw_rand {
            Ok(ref bytes) => {
                let was_current = state.data.pr2_entropy.is_active_reseed_ticket(ticket);
                if !state
                    .data
                    .pr2_entropy
                    .finish_reseed(ticket, canister_id, commitment_mode, bytes, now)
                {
                    return was_current;
                }
            }
            Err(_) => return state.data.pr2_entropy.fail_reseed(ticket, now),
        }

        // Existing valid keys are preserved by ensure_initialized. Missing keys are created only
        // from distinct purpose-separated PR2 streams after a fresh lifecycle reseed.
        let mut signing_rng = match state
            .data
            .pr2_entropy
            .output_rng(canister_id, ACTION_SIGNING_KEY_INIT_PURPOSE)
        {
            Ok(rng) => rng,
            Err(_) => {
                state.data.pr2_entropy.mark_unavailable();
                return true;
            }
        };
        if state
            .data
            .action_signing_keyring
            .ensure_initialized(&mut signing_rng, now)
            .is_err()
        {
            state.data.pr2_entropy.mark_unavailable();
            return true;
        }
        let mut scoped_rng = match state
            .data
            .pr2_entropy
            .output_rng(canister_id, SCOPED_IDENTITY_KEY_INIT_PURPOSE)
        {
            Ok(rng) => rng,
            Err(_) => {
                state.data.pr2_entropy.mark_unavailable();
                return true;
            }
        };
        if state
            .data
            .ai_app_scoped_identity_key
            .ensure_initialized(&mut scoped_rng)
            .is_err()
        {
            state.data.pr2_entropy.mark_unavailable();
            return true;
        }
        false
    });
    if retry {
        schedule(Duration::ZERO);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::action_delivery_outbox::{ActionDeliveryOutboxError, ActionDeliveryStart};
    use crate::model::ai_app_card_tokens::{Provenance, ProvenanceStatus, TOKEN_BYTES};
    use crate::model::ai_app_chat_link_tokens::{AiAppChatLinkToken, LookupResult, RedeemResult};
    use crate::{Data, RuntimeState};
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{AiAppCardContext, Chat, MessageId, UserId};
    use utils::env::test::TestEnv;

    #[test]
    fn lifecycle_transition_revokes_bearers_but_preserves_long_lived_keys_and_outbox() {
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let now = env.now;
        let user_id: UserId = env.caller.into();
        let group = candid::Principal::from_slice(&[8]).into();
        let context = AiAppCardContext {
            user_id,
            chat: Chat::Group(group),
            chat_key: format!("group:{group}"),
            thread_root_message_index: None,
            message_id: MessageId::from(1u64),
            app_id: 7,
            app_revision: 11,
            action_id: "generic.action".to_string(),
        };
        let link_code = "ab".repeat(32);
        let provenance = [0xCD; TOKEN_BYTES];
        let chat_link_token = [0xCE; crate::model::ai_app_chat_link_tokens::TOKEN_BYTES];
        let redeemed_chat_link_token = [0xCF; crate::model::ai_app_chat_link_tokens::TOKEN_BYTES];
        let mut data = Data::default();
        data.ai_app_link_codes
            .insert_bound(
                link_code.clone(),
                canister_id,
                user_id,
                7,
                11,
                candid::Principal::from_slice(&[9]),
                3,
                now + 1_000,
                now,
            )
            .unwrap();
        data.ai_app_chat_link_tokens
            .insert(
                canister_id,
                &redeemed_chat_link_token,
                AiAppChatLinkToken {
                    user_id,
                    chat: context.chat,
                    app_id: 7,
                    app_revision: 11,
                    app_canister_id: candid::Principal::from_slice(&[9]),
                    issuer_local_user_index_canister_id: candid::Principal::from_slice(&[10]),
                    app_user_key_fingerprint: [6; 32],
                    app_user_key_version: 3,
                    app_subject: [7; 32],
                    chat_handle: [8; 32],
                    expires_at: now + 1_000,
                },
                now,
            )
            .unwrap();
        assert!(matches!(
            data.ai_app_chat_link_tokens
                .redeem(canister_id, &redeemed_chat_link_token, now),
            RedeemResult::Success(_)
        ));
        data.ai_app_card_tokens
            .insert_provenance(
                canister_id,
                &provenance,
                Provenance {
                    context: context.clone(),
                    content_hash: [4; 32],
                    app_user_key_fingerprint: None,
                    app_user_key_version: None,
                    expires_at: now + 1_000,
                },
                now,
            )
            .unwrap();
        data.ai_app_chat_link_tokens
            .insert(
                canister_id,
                &chat_link_token,
                AiAppChatLinkToken {
                    user_id,
                    chat: context.chat,
                    app_id: 7,
                    app_revision: 11,
                    app_canister_id: candid::Principal::from_slice(&[9]),
                    issuer_local_user_index_canister_id: candid::Principal::from_slice(&[10]),
                    app_user_key_fingerprint: [6; 32],
                    app_user_key_version: 3,
                    app_subject: [7; 32],
                    chat_handle: [8; 32],
                    expires_at: now + 1_000,
                },
                now,
            )
            .unwrap();
        let mut key_rng = StdRng::seed_from_u64(91);
        data.action_signing_keyring.ensure_initialized(&mut key_rng, now).unwrap();
        data.ai_app_scoped_identity_key.ensure_initialized(&mut key_rng).unwrap();
        assert_eq!(
            data.action_delivery_outbox.start_in_slot([4; 32], [5; 32], 7, 1, now, now),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        let signing_keys_before = msgpack::serialize_to_vec(&data.action_signing_keyring).unwrap();
        let scoped_key_before = msgpack::serialize_to_vec(&data.ai_app_scoped_identity_key).unwrap();
        let outbox_before = msgpack::serialize_to_vec(&data.action_delivery_outbox).unwrap();
        let legacy_marker_before = data.pr2_bearer_canister_version;
        let old_lifecycle = data.pr2_entropy.lifecycle_id();
        let mut state = RuntimeState::new(Box::new(env), data);

        let new_lifecycle = advance_lifecycle(&mut state, TEST_CANISTER_VERSION + 1).unwrap();

        assert_ne!(Some(new_lifecycle), old_lifecycle);
        assert!(!state.data.ai_app_link_codes.contains_bound(&link_code, canister_id));
        assert_eq!(
            state
                .data
                .ai_app_card_tokens
                .provenance_status(canister_id, &provenance, &context, &[4; 32], now),
            ProvenanceStatus::NotFound
        );
        assert_eq!(
            state.data.ai_app_chat_link_tokens.lookup(canister_id, &chat_link_token, now),
            LookupResult::NotFound
        );
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .lookup(canister_id, &redeemed_chat_link_token, now),
            LookupResult::Redeemed(_)
        ));
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .redeem(canister_id, &redeemed_chat_link_token, now),
            RedeemResult::Replay(_)
        ));
        assert!(!state.data.pr2_entropy.is_ready());
        assert_eq!(state.data.pr2_bearer_canister_version, legacy_marker_before);
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.action_signing_keyring).unwrap(),
            signing_keys_before
        );
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.ai_app_scoped_identity_key).unwrap(),
            scoped_key_before
        );
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.action_delivery_outbox).unwrap(),
            outbox_before
        );
        assert_eq!(
            state
                .data
                .action_delivery_outbox
                .start_in_slot([4; 32], [5; 32], 7, 1, now, now),
            Ok(ActionDeliveryStart::Pending)
        );
        assert_eq!(
            state
                .data
                .action_delivery_outbox
                .start_in_slot([4; 32], [6; 32], 7, 1, now, now),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
    }
}
