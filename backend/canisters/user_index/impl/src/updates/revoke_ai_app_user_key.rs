use crate::model::ai_app_call_throttle::AiAppCallKind;
use crate::updates::remove_my_ai_app_key::invalidate_pending_ai_app_link_state;
use crate::updates::set_my_ai_app_key::validate_user_public_key;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use types::{AiAppId, TimestampMillis};
use user_index_canister::revoke_ai_app_user_key::{Response::*, *};

// Domain-separated challenge the caller must sign with the private key matching the PEM it wants
// revoked (see the endpoint comment for why this replaces bare PEM knowledge).
const REVOKE_CHALLENGE_DOMAIN: &[u8] = b"oc-revoke-ai-app-user-key-v3\0";

// Accept signatures timestamped within this window of the canister clock. A generous past window
// tolerates slow calls; a small future slack tolerates client clock skew. Stateless (no nonce
// store) — the timestamp is the only replay bound.
const REVOKE_PAST_WINDOW_MS: TimestampMillis = 5 * 60 * 1000;
const REVOKE_FUTURE_SLACK_MS: TimestampMillis = 60 * 1000;
const MAX_PUBLIC_KEY_BYTES: usize = 2_000;
const SIGNATURE_BYTES: usize = 64;

const APP_SUBJECT_BYTES: usize = 32;

fn validate_revoke_shape(app_subject: &[u8], public_key: &str, signature: &[u8]) -> Result<(), OCErrorCode> {
    if app_subject.len() != APP_SUBJECT_BYTES {
        Err(OCErrorCode::InvalidRequest)
    } else if public_key.is_empty() || public_key.len() > MAX_PUBLIC_KEY_BYTES {
        Err(OCErrorCode::InvalidPublicKey)
    } else if signature.len() != SIGNATURE_BYTES {
        Err(OCErrorCode::InvalidSignature)
    } else {
        Ok(())
    }
}

// Canonical challenge preimage, byte-for-byte reproduced by the client before signing:
//   domain || canister-id raw bytes || app-subject32 || app-id (u32 LE) || key-version (u64 LE)
//   || public-key PEM bytes || timestamp (u64 LE).
// Binding the complete tuple prevents cross-canister, cross-account, cross-app, and post-relink
// replay; binding the exact PEM ties the signature to the key; the timestamp bounds replay time.
fn revoke_challenge_preimage(
    canister_id_bytes: &[u8],
    app_subject: &[u8; APP_SUBJECT_BYTES],
    app_id: AiAppId,
    key_version: u64,
    public_key: &str,
    timestamp: TimestampMillis,
) -> Vec<u8> {
    let mut preimage =
        Vec::with_capacity(REVOKE_CHALLENGE_DOMAIN.len() + canister_id_bytes.len() + APP_SUBJECT_BYTES + public_key.len() + 24);
    preimage.extend_from_slice(REVOKE_CHALLENGE_DOMAIN);
    preimage.extend_from_slice(canister_id_bytes);
    preimage.extend_from_slice(app_subject);
    preimage.extend_from_slice(&app_id.to_le_bytes());
    preimage.extend_from_slice(&key_version.to_le_bytes());
    preimage.extend_from_slice(public_key.as_bytes());
    preimage.extend_from_slice(&timestamp.to_le_bytes());
    preimage
}

// The CONSUMER-APP side of a one-sided disconnect: when a user disconnects inside the app (the app
// deletes its private key), the app calls this so OpenChat drops the now-useless public key too.
// With the key gone, the in-chat propose flow re-detects "not linked" and re-offers the pairing
// sheet — the user is prompted to reconnect right where they are.
//
// Deliberately NO caller guard, and exposed over candid as well as msgpack (external apps call it
// with whatever principal they have). Authorization is a time-bounded signature made by the private
// key corresponding to the exact registered PEM; knowledge of public material alone is insufficient.
#[update(candid = true, msgpack = true)]
// Do not add `#[trace]`: the public key and proof signature are security-sensitive request
// material and test-mode trace output is publicly readable.
fn revoke_ai_app_user_key(args: Args) -> Response {
    mutate_state(|state| revoke_ai_app_user_key_impl(args, state))
}

fn revoke_ai_app_user_key_impl(args: Args, state: &mut RuntimeState) -> Response {
    // Revoke has its own bounded bucket for authenticated principals, independent from claim.
    // Anonymous callers cannot share a bucket without recreating a global lockout; their input,
    // crypto parsing and reverse-index lookup are therefore strictly bounded instead.
    let caller = state.env.caller();
    let now = state.env.now();
    if let Err(retry_after_ms) = state.data.ai_app_call_throttle.check(AiAppCallKind::Revoke, caller, now) {
        return Error(OCErrorCode::Throttled.with_message(retry_after_ms));
    }

    if let Err(error_code) = validate_revoke_shape(&args.app_subject, &args.public_key, args.signature.as_ref()) {
        state
            .data
            .ai_app_call_throttle
            .record_failure(AiAppCallKind::Revoke, caller, now);
        return Error(error_code.into());
    }

    if !state
        .data
        .ai_apps
        .get(args.app_id)
        .is_some_and(|app| app.published && app.manifest.per_user_keys && app.manifest.app_canister_id == Some(caller))
    {
        state
            .data
            .ai_app_call_throttle
            .record_failure(AiAppCallKind::Revoke, caller, now);
        return Error(OCErrorCode::InitiatorNotAuthorized.into());
    }
    let Ok(canonical_submitted_key) = validate_user_public_key(&args.public_key) else {
        return Error(OCErrorCode::InvalidPublicKey.into());
    };
    let app_subject: [u8; APP_SUBJECT_BYTES] = args.app_subject.as_slice().try_into().expect("validated app subject length");
    let candidates = match state.data.ai_app_user_keys.bindings_for_public_key(&canonical_submitted_key) {
        Ok(candidates) => candidates,
        Err(error) => return Error(OCErrorCode::Throttled.with_message(error.message())),
    };
    let mut matched_user = None;
    for (candidate_user, candidate_app) in candidates {
        if candidate_app != args.app_id {
            continue;
        }
        let Ok(candidate_subject) =
            state
                .data
                .ai_app_scoped_identity_key
                .app_subject(state.env.canister_id(), args.app_id, caller, candidate_user)
        else {
            return Error(OCErrorCode::C2CError.into());
        };
        if candidate_subject == app_subject {
            if matched_user.replace(candidate_user).is_some() {
                return Error(OCErrorCode::Impossible.into());
            }
        }
    }
    let Some(user_id) = matched_user else {
        return KeyNotFound;
    };
    if state.data.ai_app_user_keys.binding_version(user_id, args.app_id) != Some(args.key_version) {
        return KeyNotFound;
    }

    // Reject stale or too-far-future timestamps before touching any keys.
    if now.saturating_sub(args.timestamp) > REVOKE_PAST_WINDOW_MS || args.timestamp.saturating_sub(now) > REVOKE_FUTURE_SLACK_MS
    {
        state
            .data
            .ai_app_call_throttle
            .record_failure(AiAppCallKind::Revoke, caller, now);
        return Error(OCErrorCode::Expired.into());
    }

    // Proof-of-possession: verify the signature over the canonical challenge using the PEM being
    // revoked. Any parse/verify failure maps to an error (never a silent success) and is throttled.
    let preimage = revoke_challenge_preimage(
        state.env.canister_id().as_slice(),
        &app_subject,
        args.app_id,
        args.key_version,
        &args.public_key,
        args.timestamp,
    );
    let verifying_key = match VerifyingKey::from_public_key_pem(&args.public_key) {
        Ok(vk) => vk,
        Err(_) => {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::Revoke, caller, now);
            return Error(OCErrorCode::InvalidPublicKey.into());
        }
    };
    let signature = match Signature::from_slice(&args.signature) {
        Ok(sig) => sig,
        Err(_) => {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::Revoke, caller, now);
            return Error(OCErrorCode::InvalidSignature.into());
        }
    };
    if verifying_key.verify(&preimage, &signature).is_err() {
        state
            .data
            .ai_app_call_throttle
            .record_failure(AiAppCallKind::Revoke, caller, now);
        return Error(OCErrorCode::InvalidSignature.into());
    }

    // Delete only the tuple authorized in the signed challenge. A shared public key registered by
    // other users/apps is unrelated and must remain intact.
    match state.data.ai_app_user_keys.remove(user_id, args.app_id) {
        Ok(true) => {
            invalidate_pending_ai_app_link_state(user_id, args.app_id, state);
            Success
        }
        Ok(false) => {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::Revoke, caller, now);
            KeyNotFound
        }
        Err(error) => Error(OCErrorCode::Throttled.with_message(error.message())),
    }
}

#[cfg(test)]
mod shape_tests {
    use super::*;

    #[test]
    fn revoke_inputs_are_strictly_bounded_before_crypto_work() {
        assert!(validate_revoke_shape(&[0; 31], "pem", &[0; 64]).is_err());
        assert!(validate_revoke_shape(&[0; 33], "pem", &[0; 64]).is_err());
        assert!(validate_revoke_shape(&[0; 32], "", &[0; 64]).is_err());
        assert!(validate_revoke_shape(&[0; 32], &"x".repeat(MAX_PUBLIC_KEY_BYTES + 1), &[0; 64]).is_err());
        assert!(validate_revoke_shape(&[0; 32], "pem", &[0; 63]).is_err());
        assert!(validate_revoke_shape(&[0; 32], "pem", &[0; 65]).is_err());
        assert!(validate_revoke_shape(&[0; 32], "pem", &[0; 64]).is_ok());
    }

    #[test]
    fn challenge_is_bound_to_user_app_and_binding_epoch() {
        let canister = candid::Principal::from_slice(&[1]);
        let subject_a = [2; 32];
        let subject_b = [3; 32];
        let base = revoke_challenge_preimage(canister.as_slice(), &subject_a, 7, 1, "pem", 10);
        assert_ne!(
            base,
            revoke_challenge_preimage(canister.as_slice(), &subject_b, 7, 1, "pem", 10)
        );
        assert_ne!(
            base,
            revoke_challenge_preimage(canister.as_slice(), &subject_a, 8, 1, "pem", 10)
        );
        assert_ne!(
            base,
            revoke_challenge_preimage(canister.as_slice(), &subject_a, 7, 2, "pem", 10)
        );
    }
}
