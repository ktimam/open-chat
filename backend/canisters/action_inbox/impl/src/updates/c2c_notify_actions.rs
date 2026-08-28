use crate::guards::caller_is_authorized_depositor;
use crate::model::inbox::{ActionCapacityScope, DepositBatchError, MAX_CIPHERTEXT_BYTES, PendingAction};
use crate::{RuntimeState, mutate_state};
use action_inbox_canister::c2c_notify_actions::{Response::*, *};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;

const MAX_DEPOSITS_PER_CALL: usize = 32;
const FINGERPRINT_BYTES: usize = 32;
const ACKNOWLEDGEMENT_SECRET_HASH_BYTES: usize = action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_HASH_BYTES;
const EPHEMERAL_PUBLIC_KEY_BYTES: usize = 65;
const SIGNATURE_BYTES: usize = 64;
const MAX_ACTION_ID_BYTES: usize = 128;

#[update(guard = "caller_is_authorized_depositor", candid = true, msgpack = true)]
fn c2c_notify_actions(args: Args) -> Response {
    mutate_state(|state| c2c_notify_actions_impl(args, state))
}

fn c2c_notify_actions_impl(args: Args, state: &mut RuntimeState) -> Response {
    if let Err(error) = validate_app_namespace(state.data.app_id, args.app_id) {
        return Error(OCErrorCode::InvalidRequest.with_message(error));
    }
    if let Err(error) = validate_deposit_batch(&args) {
        if matches!(error, DepositValidationError::AggregateBytes { .. }) {
            state.data.oversized_deposit_batches_rejected = state.data.oversized_deposit_batches_rejected.saturating_add(1);
        }
        return Error(OCErrorCode::InvalidRequest.with_message(error.message()));
    }
    let now = state.env.now();
    store_deposits(args.app_id, args.deposits, now, &mut state.data.inbox)
}

#[derive(Debug, Eq, PartialEq)]
enum DepositValidationError {
    Invalid(String),
    AggregateBytes { encoded_bytes: usize },
}

impl DepositValidationError {
    fn message(self) -> String {
        match self {
            Self::Invalid(message) => message,
            Self::AggregateBytes { encoded_bytes } => {
                format!("encoded deposit batch is {encoded_bytes} bytes; maximum is {MAX_DEPOSIT_BATCH_ENCODED_BYTES} bytes")
            }
        }
    }
}

fn validate_deposit_batch(args: &Args) -> Result<usize, DepositValidationError> {
    if args.deposits.is_empty() || args.deposits.len() > MAX_DEPOSITS_PER_CALL {
        return Err(DepositValidationError::Invalid(format!(
            "deposits must contain between 1 and {MAX_DEPOSITS_PER_CALL} items"
        )));
    }
    if let Some(error) = args.deposits.iter().find_map(validate_deposit) {
        return Err(DepositValidationError::Invalid(error));
    }
    let encoded_bytes = msgpack::serialize_to_vec(args)
        .expect("serializing a validated action deposit batch must succeed")
        .len();
    if encoded_bytes > MAX_DEPOSIT_BATCH_ENCODED_BYTES {
        Err(DepositValidationError::AggregateBytes { encoded_bytes })
    } else {
        Ok(encoded_bytes)
    }
}

fn validate_app_namespace(configured: types::AiAppId, supplied: types::AiAppId) -> Result<(), String> {
    if supplied == configured {
        Ok(())
    } else {
        Err(format!("app namespace mismatch: this inbox is bound to app {configured}"))
    }
}

fn store_deposits(
    app_id: types::AiAppId,
    deposits: Vec<ActionDeposit>,
    now: types::TimestampMillis,
    inbox: &mut crate::model::inbox::Inbox,
) -> Response {
    let pending = deposits
        .into_iter()
        .map(|deposit| PendingAction {
            fingerprint: deposit.consumer_key_fingerprint.into_vec(),
            idempotency_key: deposit.idempotency_key,
            payload_hash: deposit.payload_hash,
            card_context_hash: deposit.card_context_hash,
            app_id,
            app_revision: deposit.app_revision,
            action_id: deposit.action_id,
            acknowledgement_secret_hash: deposit.acknowledgement_secret_hash,
            ephemeral_public_key: deposit.ephemeral_public_key,
            ciphertext: deposit.ciphertext,
            signature_version: deposit.signature_version,
            signing_key_id: deposit.signing_key_id,
            oc_signature: deposit.oc_signature,
            created_at: deposit.created_at,
        })
        .collect();
    match inbox.deposit_batch(pending, now) {
        Ok(_) => Success,
        Err(DepositBatchError::MigrationInProgress) => Error(OCErrorCode::Throttled.with_message(
            "action inbox migration is in progress; retry after bounded maintenance advances".to_string(),
        )),
        Err(DepositBatchError::IdempotencyConflict) => Error(
            OCErrorCode::InvalidRequest.with_message(
                "full idempotency identity already belongs to a different confirmation attempt".to_string(),
            ),
        ),
        Err(DepositBatchError::TombstoneCapacity { required, available }) => {
            Error(OCErrorCode::Throttled.with_message(format!(
                "idempotency tombstone capacity exhausted: {required} new keys required, {available} available; retry after expiry pruning"
            )))
        }
        Err(DepositBatchError::ActionCountCapacity {
            scope,
            required,
            available,
        }) => Error(OCErrorCode::Throttled.with_message(format!(
            "{} action count capacity exhausted: {required} new actions required, {available} available; acknowledge or wait for expiry",
            capacity_scope(scope)
        ))),
        Err(DepositBatchError::ActionByteCapacity {
            scope,
            required,
            available,
        }) => Error(OCErrorCode::Throttled.with_message(format!(
            "{} action byte capacity exhausted: {required} new bytes required, {available} available; acknowledge or wait for expiry",
            capacity_scope(scope)
        ))),
    }
}

fn capacity_scope(scope: ActionCapacityScope) -> &'static str {
    match scope {
        ActionCapacityScope::ConsumerKey => "consumer-key",
        ActionCapacityScope::App => "app",
    }
}

fn validate_deposit(deposit: &ActionDeposit) -> Option<String> {
    if deposit.idempotency_key.len() != ACTION_IDENTITY_BYTES || deposit.payload_hash.len() != ACTION_PAYLOAD_HASH_BYTES {
        Some(format!(
            "idempotency_key and payload_hash must be exactly {ACTION_IDENTITY_BYTES} and {ACTION_PAYLOAD_HASH_BYTES} bytes"
        ))
    } else if deposit.card_context_hash.len() != ACTION_CARD_CONTEXT_HASH_BYTES {
        Some(format!(
            "card_context_hash must be exactly {ACTION_CARD_CONTEXT_HASH_BYTES} bytes"
        ))
    } else if deposit.consumer_key_fingerprint.len() != FINGERPRINT_BYTES {
        Some(format!("consumer_key_fingerprint must be exactly {FINGERPRINT_BYTES} bytes"))
    } else if deposit.acknowledgement_secret_hash.len() != ACKNOWLEDGEMENT_SECRET_HASH_BYTES {
        Some(format!(
            "acknowledgement_secret_hash must be exactly {ACKNOWLEDGEMENT_SECRET_HASH_BYTES} bytes"
        ))
    } else if deposit.ephemeral_public_key.len() != EPHEMERAL_PUBLIC_KEY_BYTES {
        Some(format!(
            "ephemeral_public_key must be exactly {EPHEMERAL_PUBLIC_KEY_BYTES} bytes"
        ))
    } else if deposit.ciphertext.is_empty() || deposit.ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        Some(format!("ciphertext must be between 1 and {MAX_CIPHERTEXT_BYTES} bytes"))
    } else if deposit.action_id.is_empty() || deposit.action_id.len() > MAX_ACTION_ID_BYTES {
        Some(format!("action_id must be between 1 and {MAX_ACTION_ID_BYTES} bytes"))
    } else if deposit.signature_version != ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4 {
        Some(format!(
            "signature_version must be {}",
            ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4
        ))
    } else if deposit.signing_key_id.len() != ACTION_SIGNING_KEY_ID_BYTES {
        Some(format!("signing_key_id must be exactly {ACTION_SIGNING_KEY_ID_BYTES} bytes"))
    } else if deposit.oc_signature.len() != SIGNATURE_BYTES {
        Some(format!("oc_signature must be exactly {SIGNATURE_BYTES} bytes"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use serde_bytes::ByteBuf;
    use serde_json::Value;
    use utils::env::test::TestEnv;

    fn valid_deposit() -> ActionDeposit {
        ActionDeposit {
            idempotency_key: ByteBuf::from(vec![6; 32]),
            payload_hash: ByteBuf::from(vec![7; 32]),
            card_context_hash: ByteBuf::from(vec![8; 32]),
            app_revision: 2,
            action_id: "sample.action".to_string(),
            consumer_key_fingerprint: ByteBuf::from(vec![1; 32]),
            acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
            ephemeral_public_key: ByteBuf::from(vec![2; 65]),
            ciphertext: ByteBuf::from(vec![3]),
            signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
            signing_key_id: ByteBuf::from(vec![9; ACTION_SIGNING_KEY_ID_BYTES]),
            oc_signature: ByteBuf::from(vec![4; 64]),
            created_at: 1,
        }
    }

    fn valid_deposit_for(fingerprint: u8, idempotency_id: u64) -> ActionDeposit {
        let mut deposit = valid_deposit();
        deposit.consumer_key_fingerprint = ByteBuf::from(vec![fingerprint; 32]);
        let mut identity = [0u8; ACTION_IDENTITY_BYTES];
        identity[..8].copy_from_slice(&idempotency_id.to_be_bytes());
        deposit.idempotency_key = ByteBuf::from(identity.to_vec());
        deposit
    }

    #[test]
    fn deposit_shape_validation_is_strict_and_adjacent_valid_payload_passes() {
        let valid = valid_deposit();
        assert_eq!(validate_deposit(&valid), None);

        let mut bad_fingerprint = valid_deposit();
        bad_fingerprint.consumer_key_fingerprint = ByteBuf::from(vec![1; 31]);
        assert!(validate_deposit(&bad_fingerprint).unwrap().contains("32 bytes"));

        let mut bad_card_context = valid_deposit();
        bad_card_context.card_context_hash = ByteBuf::from(vec![8; 31]);
        assert!(validate_deposit(&bad_card_context).unwrap().contains("card_context_hash"));

        for invalid_len in [0, 31, 33] {
            let mut bad_identity = valid_deposit();
            bad_identity.idempotency_key = ByteBuf::from(vec![6; invalid_len]);
            assert!(validate_deposit(&bad_identity).unwrap().contains("exactly 32 and 32 bytes"));

            let mut bad_payload_hash = valid_deposit();
            bad_payload_hash.payload_hash = ByteBuf::from(vec![7; invalid_len]);
            assert!(
                validate_deposit(&bad_payload_hash)
                    .unwrap()
                    .contains("exactly 32 and 32 bytes")
            );
        }

        let mut half_empty_identity = valid_deposit();
        half_empty_identity.idempotency_key = ByteBuf::new();
        assert!(validate_deposit(&half_empty_identity).is_some());

        let mut half_empty_payload = valid_deposit();
        half_empty_payload.payload_hash = ByteBuf::new();
        assert!(validate_deposit(&half_empty_payload).is_some());

        let mut both_empty = valid_deposit();
        both_empty.idempotency_key = ByteBuf::new();
        both_empty.payload_hash = ByteBuf::new();
        assert!(validate_deposit(&both_empty).is_some());

        let mut bad_acknowledgement_secret_hash = valid_deposit();
        bad_acknowledgement_secret_hash.acknowledgement_secret_hash = ByteBuf::from(vec![5; 31]);
        assert!(
            validate_deposit(&bad_acknowledgement_secret_hash)
                .unwrap()
                .contains("32 bytes")
        );

        let mut bad_ephemeral = valid_deposit();
        bad_ephemeral.ephemeral_public_key = ByteBuf::from(vec![2; 64]);
        assert!(validate_deposit(&bad_ephemeral).unwrap().contains("65 bytes"));

        let mut empty_ciphertext = valid_deposit();
        empty_ciphertext.ciphertext = ByteBuf::new();
        assert!(validate_deposit(&empty_ciphertext).unwrap().contains("ciphertext"));

        let mut maximum_ciphertext = valid_deposit();
        maximum_ciphertext.ciphertext = ByteBuf::from(vec![3; MAX_CIPHERTEXT_BYTES]);
        assert_eq!(validate_deposit(&maximum_ciphertext), None);

        let mut oversized_ciphertext = valid_deposit();
        oversized_ciphertext.ciphertext = ByteBuf::from(vec![3; MAX_CIPHERTEXT_BYTES + 1]);
        assert!(
            validate_deposit(&oversized_ciphertext)
                .unwrap()
                .contains(&MAX_CIPHERTEXT_BYTES.to_string())
        );

        let mut bad_signature = valid_deposit();
        bad_signature.oc_signature = ByteBuf::from(vec![4; 63]);
        assert!(validate_deposit(&bad_signature).unwrap().contains("64 bytes"));
    }

    #[test]
    fn deposit_missing_acknowledgement_hash_decodes_then_rejects_the_whole_batch_before_storage() {
        let mut encoded_shape = serde_json::to_value(Args {
            app_id: 7,
            deposits: vec![valid_deposit()],
        })
        .unwrap();
        let Value::Object(deposit) = &mut encoded_shape["deposits"][0] else {
            panic!("serialized deposit must be an object")
        };
        assert!(deposit.remove("acknowledgement_secret_hash").is_some());
        let encoded = msgpack::serialize_to_vec(encoded_shape).unwrap();
        let decoded: Args = msgpack::deserialize(encoded.as_slice()).unwrap();
        assert!(decoded.deposits[0].acknowledgement_secret_hash.is_empty());

        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let mut data = Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true);
        data.inbox = crate::model::inbox::Inbox::new_for_test();
        let mut state = RuntimeState::new(Box::new(env), data);
        let response = c2c_notify_actions_impl(decoded, &mut state);

        assert!(matches!(response, Error(error) if error.matches_code(OCErrorCode::InvalidRequest)));
        assert_eq!(state.data.inbox.action_count(), 0);
        assert_eq!(state.data.inbox.seen_count(), 0);
    }

    #[test]
    fn aggregate_deposit_payload_over_one_mib_is_rejected_before_storage() {
        fn resize_to_encoded_bytes(args: &mut Args, target: usize) {
            for _ in 0..8 {
                let current = msgpack::serialize_to_vec(&*args).unwrap().len();
                if current == target {
                    return;
                }
                let ciphertext = &mut args.deposits.last_mut().unwrap().ciphertext;
                let ciphertext_len = ciphertext.len();
                if current < target {
                    ciphertext.resize(ciphertext_len + target - current, 3);
                } else {
                    ciphertext.resize(ciphertext_len - (current - target), 3);
                }
            }
            assert_eq!(msgpack::serialize_to_vec(&*args).unwrap().len(), target);
        }

        let mut args = Args {
            app_id: 7,
            deposits: (0..16)
                .map(|id| {
                    let mut deposit = valid_deposit_for(id + 1, id as u64 + 1);
                    deposit.ciphertext = ByteBuf::from(vec![3; if id < 15 { MAX_CIPHERTEXT_BYTES } else { 1 }]);
                    deposit
                })
                .collect(),
        };
        resize_to_encoded_bytes(&mut args, MAX_DEPOSIT_BATCH_ENCODED_BYTES);
        assert_eq!(validate_deposit_batch(&args), Ok(MAX_DEPOSIT_BATCH_ENCODED_BYTES));
        let mut exact_inbox = crate::model::inbox::Inbox::new_for_test();
        assert!(matches!(
            store_deposits(7, args.deposits.clone(), 1, &mut exact_inbox),
            Success
        ));
        assert_eq!(exact_inbox.action_count(), 16);
        assert_eq!(exact_inbox.seen_count(), 16);

        args.deposits.last_mut().unwrap().ciphertext.push(3);
        assert_eq!(
            validate_deposit_batch(&args),
            Err(DepositValidationError::AggregateBytes {
                encoded_bytes: MAX_DEPOSIT_BATCH_ENCODED_BYTES + 1,
            })
        );
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let mut data = Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true);
        data.inbox = crate::model::inbox::Inbox::new_for_test();
        let mut state = RuntimeState::new(Box::new(env), data);
        let response = c2c_notify_actions_impl(args, &mut state);
        assert!(matches!(response, Error(error) if error.matches_code(OCErrorCode::InvalidRequest)));
        assert_eq!(state.data.inbox.action_count(), 0);
        assert_eq!(state.data.inbox.seen_count(), 0);
        assert_eq!(state.data.oversized_deposit_batches_rejected, 1);
    }

    #[test]
    fn aggregate_accounting_includes_max_integer_and_vector_overhead() {
        let args = Args {
            app_id: u32::MAX,
            deposits: (0..MAX_DEPOSITS_PER_CALL)
                .map(|id| {
                    let mut deposit = valid_deposit_for(id as u8 + 1, u64::MAX);
                    deposit.created_at = u64::MAX;
                    deposit
                })
                .collect(),
        };
        let actual = msgpack::serialize_to_vec(&args).unwrap().len();
        assert_eq!(validate_deposit_batch(&args), Ok(actual));
        assert!(actual < MAX_DEPOSIT_BATCH_ENCODED_BYTES);
    }

    #[test]
    fn capacity_preflight_rejects_the_whole_batch_and_duplicate_retry_is_success() {
        let mut inbox = crate::model::inbox::Inbox::new_for_test_with_tombstone_limits(1, 1);
        let response = store_deposits(7, vec![valid_deposit_for(1, 1), valid_deposit_for(2, 2)], 1, &mut inbox);
        assert!(matches!(response, Error(error) if error.matches_code(OCErrorCode::Throttled)));
        assert_eq!(inbox.seen_count(), 0);
        assert_eq!(inbox.action_count(), 0);

        assert!(matches!(
            store_deposits(7, vec![valid_deposit_for(1, 1)], 2, &mut inbox),
            Success
        ));
        assert!(matches!(
            store_deposits(7, vec![valid_deposit_for(1, 1)], 3, &mut inbox),
            Success
        ));
        assert_eq!(inbox.seen_count(), 1);
        assert_eq!(inbox.action_count(), 1);
    }

    #[test]
    fn action_capacity_is_retryable_and_never_evicts_a_live_action() {
        let mut inbox = crate::model::inbox::Inbox::new_for_test_with_action_limits(10, 1, u64::MAX, u64::MAX);

        assert!(matches!(
            store_deposits(7, vec![valid_deposit_for(1, 1)], 1, &mut inbox),
            Success
        ));

        let response = store_deposits(7, vec![valid_deposit_for(2, 2)], 2, &mut inbox);
        assert!(matches!(response, Error(error) if error.matches_code(OCErrorCode::Throttled)));
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
        assert_eq!(inbox.query(&[1; 32], 0, 100, 2).len(), 1);
        assert!(inbox.query(&[2; 32], 0, 100, 2).is_empty());

        assert!(matches!(
            store_deposits(7, vec![valid_deposit_for(1, 1)], 3, &mut inbox),
            Success
        ));
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
    }

    #[test]
    fn app_namespace_mismatch_fails_closed_and_matching_namespace_passes() {
        assert!(validate_app_namespace(7, 8).unwrap_err().contains("bound to app 7"));
        assert_eq!(validate_app_namespace(7, 7), Ok(()));
    }
}
