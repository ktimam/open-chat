use crate::model::ai_app_chat_link_tokens::{AiAppChatLinkToken, LookupResult, RedeemResult, TOKEN_BYTES};
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use subtle::ConstantTimeEq;
use types::Chat;
use user_index_canister::c2c_redeem_ai_app_chat_link_token::{Response::*, *};

const APP_SUBJECT_BYTES: usize = 32;

// No static caller guard: authorization is the exact app canister pinned into the token.
// Bearer and private context must never be traced.
#[update(candid = true, msgpack = true)]
fn c2c_redeem_ai_app_chat_link_token(args: Args) -> Response {
    mutate_state(|state| redeem_impl(args, state))
}

fn redeem_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    let now = state.env.now();
    if args.expected_app_subject.len() != APP_SUBJECT_BYTES {
        if let Err(retry_after_ms) = state.data.ai_app_call_throttle.check_chat_link_redeem_caller(caller, now) {
            return Error(OCErrorCode::Throttled.with_message(retry_after_ms));
        }
        state
            .data
            .ai_app_call_throttle
            .record_chat_link_redeem_caller_failure(caller, now);
        return InvalidRequest(format!("expected_app_subject must contain exactly {APP_SUBJECT_BYTES} bytes"));
    }
    let expected_subject: [u8; APP_SUBJECT_BYTES] = args
        .expected_app_subject
        .as_ref()
        .try_into()
        .expect("expected subject length was validated");
    if let Err(retry_after_ms) = state
        .data
        .ai_app_call_throttle
        .check_chat_link_redeem(caller, expected_subject, now)
    {
        return Error(OCErrorCode::Throttled.with_message(retry_after_ms));
    }
    if args.token.len() != TOKEN_BYTES {
        state
            .data
            .ai_app_call_throttle
            .record_chat_link_redeem_failure(caller, expected_subject, now);
        return InvalidRequest(format!("token must contain exactly {TOKEN_BYTES} bytes"));
    }
    let this_canister_id = state.env.canister_id();
    let (token, already_redeemed) = match state.data.ai_app_chat_link_tokens.lookup(this_canister_id, &args.token, now) {
        LookupResult::Valid(entry) => (entry, false),
        LookupResult::Redeemed(entry) => (entry, true),
        LookupResult::Expired => return TokenExpired,
        LookupResult::NotFound => {
            state
                .data
                .ai_app_call_throttle
                .record_chat_link_redeem_failure(caller, expected_subject, now);
            return TokenNotFound;
        }
    };

    // Authentication and subject selection are deliberately before consumption. A malicious app
    // or a browser signed into the wrong app account cannot burn the legitimate user's token.
    if caller != token.app_canister_id {
        state
            .data
            .ai_app_call_throttle
            .record_chat_link_redeem_failure(caller, expected_subject, now);
        return NotAuthorized;
    }
    if !bool::from(expected_subject.ct_eq(&token.app_subject)) {
        state
            .data
            .ai_app_call_throttle
            .record_chat_link_redeem_failure(caller, expected_subject, now);
        return SubjectMismatch;
    }
    if !binding_is_current(&token, state) {
        return AppUnavailable;
    }
    if already_redeemed {
        return Success(success_result(&token));
    }
    if !crate::pr2_entropy::is_ready(state) {
        return Error(OCErrorCode::C2CError.with_message("chat-link token service temporarily unavailable"));
    }

    match state.data.ai_app_chat_link_tokens.redeem(this_canister_id, &args.token, now) {
        RedeemResult::Success(consumed) if consumed == token => Success(success_result(&consumed)),
        RedeemResult::Replay(receipt) if receipt == token => Success(success_result(&receipt)),
        RedeemResult::Expired => TokenExpired,
        RedeemResult::ReceiptCapacity => Error(OCErrorCode::Throttled.with_message("chat-link receipt capacity reached")),
        RedeemResult::NotFound | RedeemResult::Success(_) | RedeemResult::Replay(_) => TokenNotFound,
    }
}

fn success_result(token: &AiAppChatLinkToken) -> SuccessResult {
    SuccessResult {
        app_subject: ByteBuf::from(token.app_subject.to_vec()),
        subject_version: APP_SUBJECT_VERSION_V1,
        app_id: token.app_id,
        app_revision: token.app_revision,
        app_canister_id: token.app_canister_id,
        app_user_key_version: token.app_user_key_version,
        chat_handle: ByteBuf::from(token.chat_handle.to_vec()),
        chat_handle_version: CHAT_HANDLE_VERSION_V1,
    }
}

fn binding_is_current(token: &AiAppChatLinkToken, state: &RuntimeState) -> bool {
    let Some(app) = state.data.ai_apps.get(token.app_id) else {
        return false;
    };
    if !app.published
        || !app.manifest.per_user_keys
        || app.updated != token.app_revision
        || app.manifest.app_canister_id != Some(token.app_canister_id)
    {
        return false;
    }
    let Some(key) = state
        .data
        .ai_app_user_keys
        .keys_for_users(token.app_id, &[token.user_id])
        .ok()
        .and_then(|keys| keys.into_iter().next())
    else {
        return false;
    };
    if sha256::sha256(key.public_key.as_bytes()) != token.app_user_key_fingerprint
        || state.data.ai_app_user_keys.binding_version(token.user_id, token.app_id) != Some(token.app_user_key_version)
    {
        return false;
    }
    let Ok(current_subject) = state.data.ai_app_scoped_identity_key.app_subject(
        state.env.canister_id(),
        token.app_id,
        token.app_canister_id,
        token.user_id,
    ) else {
        return false;
    };
    if current_subject != token.app_subject {
        return false;
    }
    let current_handle = match token.chat {
        Chat::Direct(other) => state.data.ai_app_scoped_identity_key.direct_chat_handle(
            state.env.canister_id(),
            token.app_id,
            token.app_canister_id,
            token.user_id,
            other.into(),
        ),
        chat => state.data.ai_app_scoped_identity_key.chat_handle(
            state.env.canister_id(),
            token.app_id,
            token.app_canister_id,
            chat,
        ),
    };
    current_handle == Ok(token.chat_handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::ai_app_chat_link_tokens::AiAppChatLinkToken;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    fn setup(caller: candid::Principal, ttl: u64) -> (RuntimeState, [u8; TOKEN_BYTES], [u8; 32]) {
        let mut env = TestEnv::default();
        let user_id: UserId = candid::Principal::from_slice(&[7]).into();
        let app_canister = candid::Principal::from_slice(&[8]);
        env.caller = caller;
        let now = env.now;
        let mut data = Data::default();
        data.ai_app_scoped_identity_key
            .ensure_initialized(&mut StdRng::seed_from_u64(51))
            .unwrap();
        let app = data
            .ai_apps
            .register(
                user_id,
                AiAppManifest {
                    name: "redeem-app".to_string(),
                    description: String::new(),
                    icon_url: None,
                    app_canister_id: Some(app_canister),
                    inbox_canister_id: None,
                    consumer_public_key: String::new(),
                    per_user_keys: true,
                    actions: Vec::new(),
                    surfaces: Vec::new(),
                },
                now,
                true,
            )
            .unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let key = P256KeyPair::new(&mut StdRng::seed_from_u64(52)).public_key_pem().to_string();
        data.ai_app_user_keys.set(user_id, app.id, key.clone()).unwrap();
        let subject = data
            .ai_app_scoped_identity_key
            .app_subject(env.canister_id, app.id, app_canister, user_id)
            .unwrap();
        let chat = Chat::Group(candid::Principal::from_slice(&[20]).into());
        let handle = data
            .ai_app_scoped_identity_key
            .chat_handle(env.canister_id, app.id, app_canister, chat)
            .unwrap();
        let raw = [0xAB; TOKEN_BYTES];
        data.ai_app_chat_link_tokens
            .insert(
                env.canister_id,
                &raw,
                AiAppChatLinkToken {
                    user_id,
                    chat,
                    app_id: app.id,
                    app_revision: app.updated,
                    app_canister_id: app_canister,
                    issuer_local_user_index_canister_id: candid::Principal::from_slice(&[10]),
                    app_user_key_fingerprint: sha256::sha256(key.as_bytes()),
                    app_user_key_version: data.ai_app_user_keys.binding_version(user_id, app.id).unwrap(),
                    app_subject: subject,
                    chat_handle: handle,
                    expires_at: now + ttl,
                },
                now,
            )
            .unwrap();
        (RuntimeState::new(Box::new(env), data), raw, subject)
    }

    #[test]
    fn wrong_app_and_wrong_subject_do_not_consume_but_success_and_replay_do() {
        let (mut wrong_app_state, raw, subject) = setup(candid::Principal::from_slice(&[9]), 10_000);
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(subject.to_vec()),
                },
                &mut wrong_app_state,
            ),
            NotAuthorized
        ));
        assert!(matches!(
            wrong_app_state.data.ai_app_chat_link_tokens.lookup(
                wrong_app_state.env.canister_id(),
                &raw,
                wrong_app_state.env.now(),
            ),
            LookupResult::Valid(_)
        ));

        let (mut state, raw, subject) = setup(candid::Principal::from_slice(&[8]), 10_000);
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(vec![3; 32]),
                },
                &mut state,
            ),
            SubjectMismatch
        ));
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .lookup(state.env.canister_id(), &raw, state.env.now()),
            LookupResult::Valid(_)
        ));
        let expected_key_version =
            match state
                .data
                .ai_app_chat_link_tokens
                .lookup(state.env.canister_id(), &raw, state.env.now())
            {
                LookupResult::Valid(token) => token.app_user_key_version,
                _ => panic!("active token"),
            };
        let first = match redeem_impl(
            Args {
                token: ByteBuf::from(raw.to_vec()),
                expected_app_subject: ByteBuf::from(subject.to_vec()),
            },
            &mut state,
        ) {
            Success(result) => {
                assert_eq!(result.app_user_key_version, expected_key_version);
                result
            }
            response => panic!("unexpected redemption response: {response:?}"),
        };
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .lookup(state.env.canister_id(), &raw, state.env.now()),
            LookupResult::Redeemed(_)
        ));
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(vec![3; 32]),
                },
                &mut state,
            ),
            SubjectMismatch
        ));
        let mut wrong_env = TestEnv::default();
        wrong_env.caller = candid::Principal::from_slice(&[9]);
        state.env = Box::new(wrong_env);
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(subject.to_vec()),
                },
                &mut state,
            ),
            NotAuthorized
        ));
        let mut correct_env = TestEnv::default();
        correct_env.caller = candid::Principal::from_slice(&[8]);
        state.env = Box::new(correct_env);
        match redeem_impl(
            Args {
                token: ByteBuf::from(raw.to_vec()),
                expected_app_subject: ByteBuf::from(subject.to_vec()),
            },
            &mut state,
        ) {
            Success(replayed) => assert_eq!(replayed, first),
            response => panic!("unexpected replay response: {response:?}"),
        }
    }

    #[test]
    fn expiry_is_terminal_and_removes_the_active_bearer() {
        let (mut state, raw, subject) = setup(candid::Principal::from_slice(&[8]), 0);
        let args = Args {
            token: ByteBuf::from(raw.to_vec()),
            expected_app_subject: ByteBuf::from(subject.to_vec()),
        };
        assert!(matches!(redeem_impl(args, &mut state), TokenExpired));
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .lookup(state.env.canister_id(), &raw, state.env.now()),
            LookupResult::NotFound
        ));
    }

    #[test]
    fn same_pem_after_remove_and_relink_is_a_new_epoch_and_does_not_consume() {
        let (mut state, raw, subject) = setup(candid::Principal::from_slice(&[8]), 10_000);
        let token = match state
            .data
            .ai_app_chat_link_tokens
            .lookup(state.env.canister_id(), &raw, state.env.now())
        {
            LookupResult::Valid(token) => token,
            _ => panic!("active token"),
        };
        let pem = state
            .data
            .ai_app_user_keys
            .keys_for_users(token.app_id, &[token.user_id])
            .unwrap()
            .pop()
            .unwrap()
            .public_key;
        state.data.ai_app_user_keys.remove(token.user_id, token.app_id).unwrap();
        state
            .data
            .ai_app_user_keys
            .set(token.user_id, token.app_id, pem.clone())
            .unwrap();
        assert_eq!(sha256::sha256(pem.as_bytes()), token.app_user_key_fingerprint);
        assert_ne!(
            state.data.ai_app_user_keys.binding_version(token.user_id, token.app_id),
            Some(token.app_user_key_version)
        );
        assert_eq!(
            state
                .data
                .ai_app_scoped_identity_key
                .app_subject(state.env.canister_id(), token.app_id, token.app_canister_id, token.user_id,)
                .unwrap(),
            subject
        );
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(subject.to_vec()),
                },
                &mut state,
            ),
            AppUnavailable
        ));
        assert!(matches!(
            state
                .data
                .ai_app_chat_link_tokens
                .lookup(state.env.canister_id(), &raw, state.env.now()),
            LookupResult::Valid(_)
        ));
    }

    #[test]
    fn one_subjects_misses_cannot_throttle_another_subjects_redemption() {
        let (mut state, raw, subject_a) = setup(candid::Principal::from_slice(&[8]), 10_000);
        let subject_b = [0xCD; APP_SUBJECT_BYTES];
        for _ in 0..10 {
            assert!(matches!(
                redeem_impl(
                    Args {
                        token: ByteBuf::from(vec![0xEE; TOKEN_BYTES]),
                        expected_app_subject: ByteBuf::from(subject_b.to_vec()),
                    },
                    &mut state,
                ),
                TokenNotFound
            ));
        }
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(vec![0xEE; TOKEN_BYTES]),
                    expected_app_subject: ByteBuf::from(subject_b.to_vec()),
                },
                &mut state,
            ),
            Error(_)
        ));
        assert!(matches!(
            redeem_impl(
                Args {
                    token: ByteBuf::from(raw.to_vec()),
                    expected_app_subject: ByteBuf::from(subject_a.to_vec()),
                },
                &mut state,
            ),
            Success(_)
        ));
    }
}
