use crate::{RuntimeState, mutate_state};
use action_inbox_canister::acknowledge_actions::{Response::*, *};
use canister_api_macros::update;
use subtle::ConstantTimeEq;

#[update(candid = true, msgpack = true)]
fn acknowledge_actions(args: Args) -> Response {
    mutate_state(|state| acknowledge_actions_impl(args, state))
}

fn acknowledge_actions_impl(args: Args, state: &mut RuntimeState) -> Response {
    let fingerprint = args.consumer_key_fingerprint.as_ref();
    // `through_id` is a legacy wire label. It authorizes only this exact action id.
    let action_id = args.through_id;
    if fingerprint.len() != 32 {
        return InvalidRequest("consumer_key_fingerprint must be exactly 32 bytes".to_string());
    }

    // Never authorize against a partial stable index. Each hostile call can advance at most the same
    // bounded migration unit as the background job, then fails closed until migration completes.
    if state.data.inbox.migration_in_progress() {
        let now = state.env.now();
        state.data.inbox.run_migration_step(now);
        return InvalidRequest("action inbox migration is in progress; retry".to_string());
    }

    if let Some(remaining) = state.data.inbox.remaining_if_action_missing(fingerprint, action_id) {
        return Success(SuccessResult {
            acknowledged: 0,
            remaining: remaining.min(u32::MAX as usize) as u32,
        });
    }

    let Some(acknowledgement_secret) = args.acknowledgement_secret.as_deref() else {
        return InvalidRequest(
            "acknowledgement_secret is required for a live action; decrypt it from that action's envelope".to_string(),
        );
    };
    if acknowledgement_secret.len() != ACKNOWLEDGEMENT_SECRET_BYTES {
        return InvalidRequest(format!(
            "acknowledgement_secret must be exactly {ACKNOWLEDGEMENT_SECRET_BYTES} bytes"
        ));
    }
    let Some(expected_hash) = state.data.inbox.acknowledgement_secret_hash(fingerprint, action_id) else {
        return InvalidRequest("through_id must identify an exact live action with acknowledgement-secret support".to_string());
    };
    let supplied_hash = acknowledgement_secret_hash(state.env.canister_id(), fingerprint, acknowledgement_secret);
    if !bool::from(expected_hash.ct_eq(&supplied_hash)) {
        return NotAuthorized;
    }

    let result = state.data.inbox.acknowledge_exact(fingerprint, action_id);
    Success(SuccessResult {
        acknowledged: result.removed.min(u32::MAX as usize) as u32,
        remaining: result.remaining.min(u32::MAX as usize) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::inbox::{Inbox, PendingAction};
    use ecies_payload::key_fingerprint;
    use p256::ecdsa::signature::{Signer, Verifier};
    use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
    use p256::pkcs8::EncodePublicKey;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use serde_bytes::ByteBuf;
    use utils::env::test::TestEnv;

    fn empty_state() -> RuntimeState {
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let mut data = Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true);
        data.inbox = Inbox::new_for_test();
        RuntimeState::new(Box::new(env), data)
    }

    fn signed_args(canister_id: candid::Principal, action_id: u64) -> (Args, VerifyingKey) {
        let mut rng = StdRng::seed_from_u64(13);
        let signing_key = SigningKey::random(&mut rng);
        let verifying_key = *signing_key.verifying_key();
        let public_key_pem = verifying_key.to_public_key_pem(Default::default()).unwrap();
        let fingerprint = key_fingerprint(&public_key_pem).unwrap();
        let preimage = acknowledgement_preimage(canister_id, &fingerprint, action_id);
        let signature: Signature = signing_key.sign(&preimage);
        (
            Args {
                consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
                consumer_public_key_pem: public_key_pem,
                through_id: action_id,
                signature: ByteBuf::from(signature.to_vec()),
                acknowledgement_secret: None,
            },
            verifying_key,
        )
    }

    fn secret_args(fingerprint: &[u8], action_id: u64, secret: Option<&[u8]>) -> Args {
        Args {
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            // These are deliberately malformed: replicated acknowledgement must never parse them.
            consumer_public_key_pem: "ignored legacy field".to_string(),
            through_id: action_id,
            signature: ByteBuf::from(vec![9]),
            acknowledgement_secret: secret.map(|value| ByteBuf::from(value.to_vec())),
        }
    }

    fn deposit_secret_action(state: &mut RuntimeState, fingerprint: &[u8], idempotency_id: u64, secret: &[u8]) -> u64 {
        let hash = acknowledgement_secret_hash(state.env.canister_id(), fingerprint, secret);
        let mut identity = [0u8; 32];
        identity[..8].copy_from_slice(&idempotency_id.to_be_bytes());
        state
            .data
            .inbox
            .deposit_batch(
                vec![PendingAction {
                    fingerprint: fingerprint.to_vec(),
                    idempotency_key: ByteBuf::from(identity.to_vec()),
                    payload_hash: ByteBuf::from(vec![4; 32]),
                    card_context_hash: ByteBuf::from(vec![6; 32]),
                    app_id: 1,
                    app_revision: 2,
                    action_id: "sample.action".to_string(),
                    acknowledgement_secret_hash: ByteBuf::from(hash.to_vec()),
                    ephemeral_public_key: ByteBuf::from(vec![1; 65]),
                    ciphertext: ByteBuf::from(vec![2; 16]),
                    signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
                    signing_key_id: ByteBuf::from(vec![7; 32]),
                    oc_signature: ByteBuf::from(vec![3; 64]),
                    created_at: 1,
                }],
                1,
            )
            .unwrap();
        state
            .data
            .inbox
            .query(fingerprint, 0, 100, state.env.now())
            .last()
            .unwrap()
            .id
    }

    #[test]
    fn acknowledgement_proof_is_bound_to_canister_key_and_action_id() {
        let canister = candid::Principal::from_slice(&[1, 2, 3]);
        let (args, verifying_key) = signed_args(canister, 42);
        let preimage = acknowledgement_preimage(canister, args.consumer_key_fingerprint.as_ref(), 42);
        let signature = Signature::from_slice(args.signature.as_ref()).unwrap();
        assert!(verifying_key.verify(&preimage, &signature).is_ok());
        assert!(
            verifying_key
                .verify(
                    &acknowledgement_preimage(canister, args.consumer_key_fingerprint.as_ref(), 43),
                    &signature,
                )
                .is_err()
        );
        assert!(
            verifying_key
                .verify(
                    &acknowledgement_preimage(
                        candid::Principal::from_slice(&[9]),
                        args.consumer_key_fingerprint.as_ref(),
                        42,
                    ),
                    &signature,
                )
                .is_err()
        );
    }

    #[test]
    fn empty_queue_is_short_circuited_before_public_key_parsing() {
        let mut state = empty_state();
        let response = acknowledge_actions_impl(
            Args {
                consumer_key_fingerprint: ByteBuf::from(vec![7; 32]),
                consumer_public_key_pem: "deliberately invalid".to_string(),
                through_id: u64::MAX,
                signature: ByteBuf::from(vec![9; 64]),
                acknowledgement_secret: None,
            },
            &mut state,
        );
        assert!(matches!(
            response,
            Success(SuccessResult {
                acknowledged: 0,
                remaining: 0
            })
        ));
    }

    #[test]
    fn absent_action_is_cheap_but_a_live_action_still_requires_proof() {
        let mut state = empty_state();
        let fingerprint = vec![7; 32];
        state
            .data
            .inbox
            .deposit_batch(
                vec![PendingAction {
                    fingerprint: fingerprint.clone(),
                    idempotency_key: ByteBuf::from(vec![1; 32]),
                    payload_hash: ByteBuf::from(vec![4; 32]),
                    card_context_hash: ByteBuf::from(vec![6; 32]),
                    app_id: 1,
                    app_revision: 2,
                    action_id: "sample.action".to_string(),
                    acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
                    ephemeral_public_key: ByteBuf::from(vec![1; 65]),
                    ciphertext: ByteBuf::from(vec![2; 16]),
                    signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
                    signing_key_id: ByteBuf::from(vec![7; 32]),
                    oc_signature: ByteBuf::from(vec![3; 64]),
                    created_at: 1,
                }],
                1,
            )
            .unwrap();
        let invalid = |action_id| Args {
            consumer_key_fingerprint: ByteBuf::from(fingerprint.clone()),
            consumer_public_key_pem: "deliberately invalid".to_string(),
            through_id: action_id,
            signature: ByteBuf::from(vec![9; 64]),
            acknowledgement_secret: None,
        };

        assert!(matches!(
            acknowledge_actions_impl(invalid(0), &mut state),
            Success(SuccessResult {
                acknowledged: 0,
                remaining: 1
            })
        ));
        assert!(matches!(
            acknowledge_actions_impl(invalid(1), &mut state),
            InvalidRequest(message) if message.contains("acknowledgement_secret")
        ));
    }

    #[test]
    fn live_action_rejects_direct_replicated_signature_proof_without_a_capability() {
        let mut state = empty_state();
        let (args, _) = signed_args(state.env.canister_id(), 1);
        state
            .data
            .inbox
            .deposit_batch(
                vec![PendingAction {
                    fingerprint: args.consumer_key_fingerprint.to_vec(),
                    idempotency_key: ByteBuf::from(vec![77; 32]),
                    payload_hash: ByteBuf::from(vec![4; 32]),
                    card_context_hash: ByteBuf::from(vec![6; 32]),
                    app_id: 1,
                    app_revision: 2,
                    action_id: "sample.action".to_string(),
                    acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
                    ephemeral_public_key: ByteBuf::from(vec![1; 65]),
                    ciphertext: ByteBuf::from(vec![2; 16]),
                    signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
                    signing_key_id: ByteBuf::from(vec![7; 32]),
                    oc_signature: ByteBuf::from(vec![3; 64]),
                    created_at: 1,
                }],
                1,
            )
            .unwrap();

        assert!(matches!(
            acknowledge_actions_impl(args, &mut state),
            InvalidRequest(message) if message.contains("acknowledgement_secret")
        ));
    }

    #[test]
    fn valid_secret_acknowledges_without_reading_legacy_pem_or_signature_and_replay_is_cheap() {
        let mut state = empty_state();
        let fingerprint = [21; 32];
        let secret = [22; ACKNOWLEDGEMENT_SECRET_BYTES];
        let id = deposit_secret_action(&mut state, &fingerprint, 1, &secret);

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, id, Some(&secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 1,
                remaining: 0
            })
        ));
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, id, None), &mut state),
            Success(SuccessResult {
                acknowledged: 0,
                remaining: 0
            })
        ));
    }

    #[test]
    fn repeated_invalid_secrets_never_lock_out_the_valid_holder() {
        let mut state = empty_state();
        let fingerprint = [31; 32];
        let secret = [32; ACKNOWLEDGEMENT_SECRET_BYTES];
        let id = deposit_secret_action(&mut state, &fingerprint, 2, &secret);

        for value in 0..64u8 {
            let mut wrong = [0; ACKNOWLEDGEMENT_SECRET_BYTES];
            wrong[0] = value;
            assert!(matches!(
                acknowledge_actions_impl(secret_args(&fingerprint, id, Some(&wrong)), &mut state),
                NotAuthorized
            ));
        }
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, id, Some(&secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 1,
                remaining: 0
            })
        ));
    }

    #[test]
    fn secret_is_bound_to_the_exact_fingerprint_and_action_id() {
        let mut state = empty_state();
        let fingerprint_a = [41; 32];
        let fingerprint_b = [42; 32];
        let first_secret = [43; ACKNOWLEDGEMENT_SECRET_BYTES];
        let second_secret = [44; ACKNOWLEDGEMENT_SECRET_BYTES];
        let other_secret = [45; ACKNOWLEDGEMENT_SECRET_BYTES];
        let first_id = deposit_secret_action(&mut state, &fingerprint_a, 3, &first_secret);
        let second_id = deposit_secret_action(&mut state, &fingerprint_a, 4, &second_secret);
        let other_id = deposit_secret_action(&mut state, &fingerprint_b, 5, &other_secret);

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint_a, second_id, Some(&first_secret)), &mut state),
            NotAuthorized
        ));
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint_b, other_id, Some(&first_secret)), &mut state),
            NotAuthorized
        ));
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint_a, first_id, Some(&first_secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 1,
                remaining: 1
            })
        ));
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint_a, second_id, Some(&second_secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 1,
                remaining: 0
            })
        ));
    }

    #[test]
    fn a_later_action_secret_cannot_delete_an_earlier_action_not_selected_by_the_consumer() {
        let mut state = empty_state();
        let fingerprint = [51; 32];
        let earlier_secret = [52; ACKNOWLEDGEMENT_SECRET_BYTES];
        let later_secret = [53; ACKNOWLEDGEMENT_SECRET_BYTES];
        let earlier_id = deposit_secret_action(&mut state, &fingerprint, 6, &earlier_secret);
        let later_id = deposit_secret_action(&mut state, &fingerprint, 7, &later_secret);

        // Model a consumer that selects later action B without first processing action A.
        let adversarial_page = state.data.inbox.query(&fingerprint, earlier_id, 100, state.env.now());
        assert_eq!(
            adversarial_page.iter().map(|action| action.id).collect::<Vec<_>>(),
            vec![later_id]
        );

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, later_id, Some(&later_secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 1,
                remaining: 1
            })
        ));
        let remaining = state.data.inbox.query(&fingerprint, 0, 100, state.env.now());
        assert_eq!(remaining.iter().map(|action| action.id).collect::<Vec<_>>(), vec![earlier_id]);
        assert_eq!(
            state.data.inbox.acknowledgement_secret_hash(&fingerprint, earlier_id),
            Some(acknowledgement_secret_hash(
                state.env.canister_id(),
                &fingerprint,
                &earlier_secret
            ))
        );
    }

    #[test]
    fn malformed_secret_and_non_exact_action_id_fail_closed_without_mutating_the_queue() {
        let mut state = empty_state();
        let fingerprint = [61; 32];
        let secret = [62; ACKNOWLEDGEMENT_SECRET_BYTES];
        let id = deposit_secret_action(&mut state, &fingerprint, 8, &secret);

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, id, Some(&secret[..31])), &mut state),
            InvalidRequest(message) if message.contains("exactly 32 bytes")
        ));
        assert!(matches!(
            acknowledge_actions_impl(secret_args(&fingerprint, id + 1, Some(&secret)), &mut state),
            Success(SuccessResult {
                acknowledged: 0,
                remaining: 1
            })
        ));
        assert_eq!(state.data.inbox.query(&fingerprint, 0, 100, state.env.now()).len(), 1);
    }

    #[test]
    fn acknowledgement_runs_one_bounded_migration_step_then_fails_closed() {
        let mut state = empty_state();
        state.data.inbox.force_incomplete_migration_for_test();

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&[71; 32], 1, None), &mut state),
            InvalidRequest(message) if message.contains("migration is in progress")
        ));
        assert!(state.data.inbox.migration_in_progress());
    }

    #[test]
    fn acknowledgement_that_finishes_migration_still_retries_before_authorization() {
        let mut state = empty_state();
        state.data.inbox.force_empty_migration_for_test();

        assert!(matches!(
            acknowledge_actions_impl(secret_args(&[72; 32], 1, None), &mut state),
            InvalidRequest(message) if message.contains("migration is in progress")
        ));
        assert!(!state.data.inbox.migration_in_progress());
    }
}
