use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::updates::register_ai_action::validate_action_definition;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::{AiAppManifest, UserId};
use url::Url;
use user_index_canister::register_ai_app::{Response::*, *};

// Exposed over candid as well as msgpack so that an external app can register its manifest with a
// plain candid call from a deploy script.
#[update(guard = "caller_is_openchat_user_or_test_mode", candid = true, msgpack = true)]
#[trace]
fn register_ai_app(args: Args) -> Response {
    mutate_state(|state| register_ai_app_impl(args, state))
}

fn register_ai_app_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Owner resolution: a registered user's UserId when the caller is one, otherwise (test_mode
    // only, so a deploy script's standalone principal works locally) the caller principal itself.
    let owner: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode {
        caller.into()
    } else {
        return InvalidRequest("caller is not a registered user".to_string());
    };

    if let Err(message) = validate(&args.manifest) {
        return InvalidRequest(message);
    }

    let now = state.env.now();
    // App names are globally unique. In test_mode a registration whose name is currently owned by a
    // different owner RE-OWNS the existing entry (a dev convenience: local re-deploys under a fresh
    // identity keep the app's id, and with it any per-chat enablement). In production the same
    // collision is rejected — transferring an app is a publish/governance concern, not something a
    // plain registration call may do.
    match state.data.ai_apps.register(owner, args.manifest, now, state.data.test_mode) {
        Ok(registration) => Success(registration),
        Err(_) => InvalidRequest("an app with this name is already registered".to_string()),
    }
}

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 500;
const MAX_ICON_URL_LENGTH: usize = 2000;
const MAX_CONSUMER_PUBLIC_KEY_LENGTH: usize = 2000;
const MAX_ACTIONS: usize = 20;

fn validate(manifest: &AiAppManifest) -> Result<(), String> {
    let name_length = manifest.name.chars().count();
    if manifest.name.trim().is_empty() || name_length > MAX_NAME_LENGTH {
        return Err(format!("name must be between 1 and {MAX_NAME_LENGTH} characters"));
    }
    if manifest.description.chars().count() > MAX_DESCRIPTION_LENGTH {
        return Err(format!("description must be at most {MAX_DESCRIPTION_LENGTH} characters"));
    }
    if let Some(icon_url) = &manifest.icon_url {
        if icon_url.chars().count() > MAX_ICON_URL_LENGTH {
            return Err(format!("icon_url must be at most {MAX_ICON_URL_LENGTH} characters"));
        }
        if Url::parse(icon_url).is_err() {
            return Err("icon_url must be a valid URL".to_string());
        }
    }
    // When the manifest declares per-user delivery keys the app-level key is never read (every
    // delivery targets the acting user's own registered key), so it may be empty. Otherwise the
    // usual rules stand: a non-empty PEM public key. A key that IS supplied must be valid PEM in
    // either mode — better to reject a malformed key than to silently carry it.
    let key_length = manifest.consumer_public_key.chars().count();
    if key_length == 0 {
        if !manifest.per_user_keys {
            return Err(format!(
                "consumer_public_key must be between 1 and {MAX_CONSUMER_PUBLIC_KEY_LENGTH} characters"
            ));
        }
    } else {
        if key_length > MAX_CONSUMER_PUBLIC_KEY_LENGTH {
            return Err(format!(
                "consumer_public_key must be at most {MAX_CONSUMER_PUBLIC_KEY_LENGTH} characters"
            ));
        }
        if !manifest.consumer_public_key.contains("BEGIN PUBLIC KEY") {
            return Err("consumer_public_key must be a PEM encoded public key".to_string());
        }
    }
    if manifest.actions.len() > MAX_ACTIONS {
        return Err(format!("actions must contain at most {MAX_ACTIONS} entries"));
    }
    for (index, action) in manifest.actions.iter().enumerate() {
        // Each embedded action must satisfy exactly the same rules as a standalone registration.
        validate_action_definition(action).map_err(|message| format!("actions[{index}]: {message}"))?;
    }
    Ok(())
}
