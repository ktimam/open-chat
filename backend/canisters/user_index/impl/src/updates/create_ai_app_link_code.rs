use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::model::ai_app_link_codes::InsertLinkCodeError;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use oc_error_codes::OCErrorCode;
use rand::Rng;
use types::Milliseconds;
use user_index_canister::create_ai_app_link_code::{Response::*, *};

const LINK_CODE_TTL: Milliseconds = 10 * MINUTE_IN_MS;
const MAX_CODE_GENERATION_ATTEMPTS: usize = 10;
const CLAIM_TOKEN_BYTES: usize = 32;
const LINK_CODE_ENTROPY_PURPOSE: &[u8] = b"user-index/link-code/v1";

// Do not add `#[trace]` here: a successful response contains a live bearer token and must not be
// copied into test-mode traces.
#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
fn create_ai_app_link_code(args: Args) -> Response {
    mutate_state(|state| create_ai_app_link_code_impl(args, state))
}

fn create_ai_app_link_code_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Link tokens are account-scoped. Local test mode must not fabricate an account from an
    // arbitrary caller principal; this keeps the four-browser development model faithful.
    let Some(user_id) = state.data.users.get_by_principal(&caller).map(|user| user.user_id) else {
        return Error(OCErrorCode::InitiatorNotFound.into());
    };

    let Some((app_revision, app_canister_id)) =
        state.data.ai_apps.get(args.app_id).and_then(|app| {
            (app.published && app.manifest.per_user_keys).then_some((app.updated, app.manifest.app_canister_id?))
        })
    else {
        return AppNotFound;
    };

    // A copy/paste-safe 256-bit token from a fresh-version, purpose-separated stream.
    let mut rng = match crate::pr2_entropy::output_rng(state, LINK_CODE_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => {
            return Error(OCErrorCode::C2CError.with_message("link token service temporarily unavailable"));
        }
    };
    let Some(code) = generate_unique_code(state, &mut rng) else {
        return Error(OCErrorCode::Impossible.with_message("can't generate unique link code"));
    };

    let now = state.env.now();
    let expires_at = now + LINK_CODE_TTL;
    let consent_epoch = state.data.ai_app_user_keys.binding_epoch(user_id, args.app_id);
    // Creating a new code for the same (user, app) pair replaces the old one.
    if let Err(error) = state.data.ai_app_link_codes.insert_bound(
        code.clone(),
        state.env.canister_id(),
        user_id,
        args.app_id,
        app_revision,
        app_canister_id,
        consent_epoch,
        expires_at,
        now,
    ) {
        let message = match error {
            InsertLinkCodeError::UserLimitReached => "too many outstanding link tokens for this user",
            InsertLinkCodeError::AppLimitReached => "too many outstanding link tokens for this app",
            InsertLinkCodeError::StoreFull => "AI-app link-token store is at capacity",
        };
        return Error(OCErrorCode::Throttled.with_message(message));
    }

    Success(SuccessResult { code, expires_at })
}

fn generate_unique_code(state: &mut RuntimeState, rng: &mut impl Rng) -> Option<String> {
    for _ in 0..MAX_CODE_GENERATION_ATTEMPTS {
        let code = generate_claim_token(rng);
        if !state.data.ai_app_link_codes.contains_bound(&code, state.env.canister_id()) {
            return Some(code);
        }
    }
    None
}

fn generate_claim_token(rng: &mut impl Rng) -> String {
    let mut bytes = [0u8; CLAIM_TOKEN_BYTES];
    rng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    #[test]
    fn claim_tokens_have_256_bits_of_lowercase_hex_entropy() {
        let mut rng = StdRng::seed_from_u64(17);
        let first = generate_claim_token(&mut rng);
        let second = generate_claim_token(&mut rng);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(first, second);
    }

    fn manifest(name: &str, per_user_keys: bool) -> AiAppManifest {
        AiAppManifest {
            name: name.to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: Some(candid::Principal::from_slice(&[8])),
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys,
            actions: Vec::new(),
            surfaces: Vec::new(),
        }
    }

    #[test]
    fn link_codes_are_only_created_for_published_per_user_apps() {
        let env = TestEnv::default();
        let owner: UserId = env.caller.into();
        let now = env.now;
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id: owner,
            username: "account-a".to_string(),
            ..Default::default()
        });
        let draft = data.ai_apps.register(owner, manifest("draft", true), now, true).unwrap();
        let app_level = data.ai_apps.register(owner, manifest("app-level", false), now, true).unwrap();
        let mut missing_canister_manifest = manifest("missing-canister", true);
        missing_canister_manifest.app_canister_id = None;
        let missing_canister = data.ai_apps.register(owner, missing_canister_manifest, now, true).unwrap();
        assert!(data.ai_apps.publish(app_level.id, now));
        assert!(data.ai_apps.publish(missing_canister.id, now));
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            create_ai_app_link_code_impl(Args { app_id: draft.id }, &mut state),
            AppNotFound
        ));
        assert!(matches!(
            create_ai_app_link_code_impl(Args { app_id: app_level.id }, &mut state),
            AppNotFound
        ));
        assert!(matches!(
            create_ai_app_link_code_impl(
                Args {
                    app_id: missing_canister.id
                },
                &mut state
            ),
            AppNotFound
        ));
        assert!(state.data.ai_apps.publish(draft.id, now));
        assert!(matches!(
            create_ai_app_link_code_impl(Args { app_id: draft.id }, &mut state),
            Success(_)
        ));
    }

    #[test]
    fn test_mode_does_not_create_link_codes_for_a_phantom_account() {
        let env = TestEnv::default();
        let owner: UserId = candid::Principal::from_slice(&[42]).into();
        let now = env.now;
        let mut data = Data::default();
        let app = data.ai_apps.register(owner, manifest("linked", true), now, true).unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            create_ai_app_link_code_impl(Args { app_id: app.id }, &mut state),
            Error(error) if error.matches_code(OCErrorCode::InitiatorNotFound)
        ));
    }
}
