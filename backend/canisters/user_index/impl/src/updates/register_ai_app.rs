use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::{AiActionDefinition, AiActionRule, AiAppManifest, AiAppSurface, UserId};
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
        validate_action_definition(action).map_err(|message| format!("actions[{index}]: {message}"))?;
    }
    if manifest.surfaces.len() > MAX_SURFACES {
        return Err(format!("surfaces must contain at most {MAX_SURFACES} entries"));
    }
    for (index, surface) in manifest.surfaces.iter().enumerate() {
        validate_surface(surface).map_err(|message| format!("surfaces[{index}]: {message}"))?;
    }
    Ok(())
}

const MAX_SURFACES: usize = 10;
const MAX_SURFACE_KIND_LENGTH: usize = 64;
const MAX_SURFACE_URL_LENGTH: usize = 2000;

/// Validates a single UI surface declared in an app manifest.
fn validate_surface(surface: &AiAppSurface) -> Result<(), String> {
    let kind_length = surface.kind.chars().count();
    if kind_length == 0 || kind_length > MAX_SURFACE_KIND_LENGTH {
        return Err(format!("kind must be between 1 and {MAX_SURFACE_KIND_LENGTH} characters"));
    }
    let url_length = surface.url.chars().count();
    if url_length == 0 || url_length > MAX_SURFACE_URL_LENGTH {
        return Err(format!("url must be between 1 and {MAX_SURFACE_URL_LENGTH} characters"));
    }
    // The url is a template; substitute the placeholders with dummy values so that an otherwise
    // valid templated URL (e.g. ".../link?chat={chatKey}") passes URL parsing.
    let substituted = surface.url.replace("{chatKey}", "group:aaaaa-aa").replace("{appId}", "1");
    if Url::parse(&substituted).is_err() {
        return Err("url must be a valid URL".to_string());
    }
    Ok(())
}

/// Validates a single action definition embedded in an app manifest.
fn validate_action_definition(definition: &AiActionDefinition) -> Result<(), String> {
    if definition.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    if Url::parse(&definition.endpoint).is_err() {
        return Err("endpoint must be a valid URL".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(&definition.response_schema).is_err() {
        return Err("response_schema must be valid JSON".to_string());
    }
    validate_rules(&definition.rules)?;
    Ok(())
}

const MAX_RULES: usize = 20;
const MAX_RULE_STRING_LENGTH: usize = 64;
const MAX_INSTRUCTION_TEXT_LENGTH: usize = 1000;
const MAX_KEYWORD_MAPPINGS: usize = 50;
const MAX_KEYWORDS_PER_MAPPING: usize = 50;
const MAX_FROM_MESSAGE_MAX_LENGTH: u32 = 2000;

fn validate_rules(rules: &[AiActionRule]) -> Result<(), String> {
    if rules.len() > MAX_RULES {
        return Err(format!("rules must contain at most {MAX_RULES} entries"));
    }
    for rule in rules {
        match rule {
            AiActionRule::KeywordMap(r) => {
                validate_rule_string("keyword_map field", &r.field)?;
                if r.map.len() > MAX_KEYWORD_MAPPINGS {
                    return Err(format!("keyword_map map must contain at most {MAX_KEYWORD_MAPPINGS} mappings"));
                }
                for mapping in &r.map {
                    validate_rule_string("keyword_map value", &mapping.value)?;
                    if mapping.keywords.len() > MAX_KEYWORDS_PER_MAPPING {
                        return Err(format!(
                            "keyword_map mapping must contain at most {MAX_KEYWORDS_PER_MAPPING} keywords"
                        ));
                    }
                    for keyword in &mapping.keywords {
                        validate_rule_string("keyword_map keyword", keyword)?;
                    }
                }
            }
            AiActionRule::FromMessage(r) => {
                validate_rule_string("from_message field", &r.field)?;
                if r.max_length.is_some_and(|max_length| max_length > MAX_FROM_MESSAGE_MAX_LENGTH) {
                    return Err(format!("from_message max_length must be at most {MAX_FROM_MESSAGE_MAX_LENGTH}"));
                }
            }
            AiActionRule::Normalize(r) => {
                validate_rule_string("normalize field", &r.field)?;
            }
            AiActionRule::Instruction(r) => {
                if r.text.chars().count() > MAX_INSTRUCTION_TEXT_LENGTH {
                    return Err(format!(
                        "instruction text must be at most {MAX_INSTRUCTION_TEXT_LENGTH} characters"
                    ));
                }
            }
            AiActionRule::Context(_) => {}
        }
    }
    Ok(())
}

fn validate_rule_string(label: &str, value: &str) -> Result<(), String> {
    let length = value.chars().count();
    if length == 0 || length > MAX_RULE_STRING_LENGTH {
        return Err(format!("{label} must be between 1 and {MAX_RULE_STRING_LENGTH} characters"));
    }
    Ok(())
}
