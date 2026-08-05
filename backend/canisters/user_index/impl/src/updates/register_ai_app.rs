use crate::guards::caller_can_register_ai_app;
use crate::model::ai_app_registry::{MAX_AI_APPS, MAX_UNPUBLISHED_APPS_PER_OWNER, RegisterAiAppError, canonical_app_name};
use crate::model::ai_app_user_keys::canonicalize_p256_public_key;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use std::collections::HashSet;
use types::{AiActionDefinition, AiActionRule, AiAppManifest, AiAppSurface, UserId};
use url::Url;
use user_index_canister::register_ai_app::{Response::*, *};

// Exposed over candid as well as msgpack so that an external app can register its manifest with a
// plain candid call from a deploy script.
#[update(guard = "caller_can_register_ai_app", candid = true, msgpack = true)]
fn register_ai_app(args: Args) -> Response {
    mutate_state(|state| register_ai_app_impl(args, state))
}

fn register_ai_app_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Registered accounts retain normal create/upsert behavior. Governance may still bootstrap a
    // standalone local registrar. Any other test-mode principal receives only the decode-safe
    // migration path below: exact-name update of its own already-live row, never allocation.
    let (owner, existing_standalone_only): (UserId, bool) = if let Some(user) = state.data.users.get_by_principal(&caller) {
        (user.user_id, false)
    } else if state.data.test_mode && state.is_caller_governance_principal() {
        (caller.into(), false)
    } else if state.data.test_mode {
        (caller.into(), true)
    } else {
        return InvalidRequest("caller is not a registered user".to_string());
    };

    let mut manifest = args.manifest;
    if let Err(message) = validate(&mut manifest, state.data.test_mode) {
        return InvalidRequest(message);
    }

    let now = state.env.now();
    // Unpublished names are bounded, expiring drafts rather than exclusive namespace claims. Only
    // canister-vouched + governance-published names are globally exclusive in production.
    let result = if existing_standalone_only {
        state.data.ai_apps.update_existing_owned_app(owner, manifest, now)
    } else {
        state.data.ai_apps.register(owner, manifest, now, state.data.test_mode)
    };
    match result {
        Ok(registration) => Success(registration),
        Err(RegisterAiAppError::InvalidName) => InvalidRequest(invalid_name_message()),
        Err(RegisterAiAppError::ExistingAppNotFound) => {
            InvalidRequest("standalone local registrar may update only its existing app".to_string())
        }
        Err(RegisterAiAppError::NameTakenByPublishedApp) => {
            InvalidRequest("a verified app already owns this canonical name".to_string())
        }
        Err(RegisterAiAppError::UnpublishedOwnerQuotaExceeded) => InvalidRequest(format!(
            "an owner may have at most {MAX_UNPUBLISHED_APPS_PER_OWNER} unpublished app reservations"
        )),
        Err(RegisterAiAppError::RegistryFull) => {
            InvalidRequest(format!("the app registry is at its {MAX_AI_APPS}-entry capacity"))
        }
    }
}

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 500;
const MAX_ICON_URL_LENGTH: usize = 2000;
const MAX_CONSUMER_PUBLIC_KEY_LENGTH: usize = 2000;
const MAX_ACTIONS: usize = 20;
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_MANIFEST_RULES: usize = 100;
const MAX_MANIFEST_KEYWORDS: usize = 2_000;

fn validate(manifest: &mut AiAppManifest, allow_loopback_http: bool) -> Result<(), String> {
    let encoded = msgpack::serialize_to_vec(&*manifest).map_err(|_| "manifest could not be encoded".to_string())?;
    if encoded.len() > MAX_MANIFEST_BYTES {
        return Err(format!("manifest must be at most {MAX_MANIFEST_BYTES} bytes"));
    }
    let name_length = manifest.name.chars().count();
    if name_length > MAX_NAME_LENGTH {
        return Err(format!("name must be between 1 and {MAX_NAME_LENGTH} characters"));
    }
    if canonical_app_name(&manifest.name).is_none() {
        return Err(invalid_name_message());
    }
    if manifest.app_canister_id == Some(candid::Principal::anonymous()) {
        return Err("app_canister_id must identify a non-anonymous canister".to_string());
    }
    if manifest.inbox_canister_id == Some(candid::Principal::anonymous()) {
        return Err("inbox_canister_id must identify a non-anonymous canister".to_string());
    }
    if manifest.description.chars().count() > MAX_DESCRIPTION_LENGTH {
        return Err(format!("description must be at most {MAX_DESCRIPTION_LENGTH} characters"));
    }
    if let Some(icon_url) = &manifest.icon_url {
        if icon_url.chars().count() > MAX_ICON_URL_LENGTH {
            return Err(format!("icon_url must be at most {MAX_ICON_URL_LENGTH} characters"));
        }
        let parsed = Url::parse(icon_url).map_err(|_| "icon_url must be a valid URL".to_string())?;
        if !is_allowed_app_url(&parsed, allow_loopback_http) {
            return Err("icon_url must use credential-free https (loopback http is test-mode only)".to_string());
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
        manifest.consumer_public_key = canonicalize_p256_public_key(&manifest.consumer_public_key)
            .map_err(|message| format!("consumer_public_key: {message}"))?;
    }
    if manifest.actions.len() > MAX_ACTIONS {
        return Err(format!("actions must contain at most {MAX_ACTIONS} entries"));
    }
    let mut action_names = HashSet::new();
    let mut total_rules = 0usize;
    let mut total_keywords = 0usize;
    for (index, action) in manifest.actions.iter_mut().enumerate() {
        if !action_names.insert(action.name.clone()) {
            return Err(format!("actions[{index}]: duplicate action name"));
        }
        validate_action_definition(action, allow_loopback_http).map_err(|message| format!("actions[{index}]: {message}"))?;
        total_rules = total_rules.saturating_add(action.rules.len());
        total_keywords = total_keywords.saturating_add(
            action
                .rules
                .iter()
                .filter_map(|rule| match rule {
                    AiActionRule::KeywordMap(rule) => {
                        Some(rule.map.iter().map(|mapping| mapping.keywords.len()).sum::<usize>())
                    }
                    _ => None,
                })
                .sum::<usize>(),
        );
        if total_rules > MAX_MANIFEST_RULES {
            return Err(format!("actions contain more than {MAX_MANIFEST_RULES} rules in aggregate"));
        }
        if total_keywords > MAX_MANIFEST_KEYWORDS {
            return Err(format!(
                "actions contain more than {MAX_MANIFEST_KEYWORDS} keywords in aggregate"
            ));
        }
    }
    if manifest.surfaces.len() > MAX_SURFACES {
        return Err(format!("surfaces must contain at most {MAX_SURFACES} entries"));
    }
    let mut surface_kinds = HashSet::new();
    for (index, surface) in manifest.surfaces.iter().enumerate() {
        if !surface_kinds.insert(surface.kind.as_str()) {
            return Err(format!("surfaces[{index}]: duplicate surface kind"));
        }
        validate_surface(surface, allow_loopback_http).map_err(|message| format!("surfaces[{index}]: {message}"))?;
    }
    Ok(())
}

fn invalid_name_message() -> String {
    format!("name must be 1-{MAX_NAME_LENGTH} ASCII letters/digits with internal spaces, hyphens, underscores, or dots")
}

const MAX_SURFACES: usize = 10;
const MAX_SURFACE_KIND_LENGTH: usize = 64;
const MAX_SURFACE_URL_LENGTH: usize = 2000;

/// Validates a single UI surface declared in an app manifest.
fn validate_surface(surface: &AiAppSurface, allow_loopback_http: bool) -> Result<(), String> {
    let kind_length = surface.kind.chars().count();
    if kind_length == 0 || kind_length > MAX_SURFACE_KIND_LENGTH {
        return Err(format!("kind must be between 1 and {MAX_SURFACE_KIND_LENGTH} characters"));
    }
    let url_length = surface.url.chars().count();
    if url_length == 0 || url_length > MAX_SURFACE_URL_LENGTH {
        return Err(format!("url must be between 1 and {MAX_SURFACE_URL_LENGTH} characters"));
    }
    // External app URLs may contain only the public app id. Raw OpenChat chat/message/user
    // coordinates never belong in a URL; app-scoped card context travels over the private bridge.
    let substituted = surface.url.replace("{appId}", "1");
    if substituted.contains('{') || substituted.contains('}') {
        return Err("surface url contains an unsupported placeholder".to_string());
    }
    let parsed = Url::parse(&substituted).map_err(|_| "url must be a valid URL".to_string())?;
    // Every surface must use credential-free HTTPS so neither an embedded sheet nor an external
    // navigation can be redirected through plaintext or URL credentials. Loopback HTTP is accepted
    // only while the canister is explicitly in test mode for local development.
    if !is_allowed_app_url(&parsed, allow_loopback_http) {
        return Err("surface url must use credential-free https (loopback http is test-mode only)".to_string());
    }
    Ok(())
}

/// https on any host, or http only on a loopback host (local dev). Mirrors the client-side
/// deriveCardOrigin gate (frontend/app/src/utils/cardBridge.ts).
fn is_allowed_app_url(url: &Url, allow_loopback_http: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" if allow_loopback_http => url
            .host_str()
            .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "::1" | "[::1]")),
        _ => false,
    }
}

/// Validates a single action definition embedded in an app manifest.
fn validate_action_definition(definition: &mut AiActionDefinition, allow_loopback_http: bool) -> Result<(), String> {
    validate_bounded_string("name", &definition.name, 1, 64)?;
    validate_bounded_string("description", &definition.description, 0, 500)?;
    validate_bounded_string("prompt_template", &definition.prompt_template, 1, 16_384)?;
    validate_bounded_string("response_schema", &definition.response_schema, 1, 16_384)?;
    validate_bounded_string("endpoint", &definition.endpoint, 1, 2_000)?;
    let endpoint = Url::parse(&definition.endpoint).map_err(|_| "endpoint must be a valid URL".to_string())?;
    if !is_allowed_app_url(&endpoint, allow_loopback_http) {
        return Err("endpoint must use credential-free https (loopback http is test-mode only)".to_string());
    }
    let schema = serde_json::from_str::<serde_json::Value>(&definition.response_schema)
        .map_err(|_| "response_schema must be valid JSON".to_string())?;
    validate_response_schema(&schema)?;
    if let Some(key) = &mut definition.consumer_public_key {
        validate_bounded_string("consumer_public_key", key, 1, MAX_CONSUMER_PUBLIC_KEY_LENGTH)?;
        *key = canonicalize_p256_public_key(key).map_err(|message| format!("consumer_public_key: {message}"))?;
    }
    validate_bounded_string("card.title", &definition.card.title, 1, 200)?;
    validate_bounded_string("card.confirm_label", &definition.card.confirm_label, 1, 80)?;
    validate_bounded_string("card.cancel_label", &definition.card.cancel_label, 1, 80)?;
    if definition.card.rows.is_empty() || definition.card.rows.len() > 32 {
        return Err("card.rows must contain between 1 and 32 entries".to_string());
    }
    validate_display_string("card.title", &definition.card.title)?;
    validate_display_string("card.confirm_label", &definition.card.confirm_label)?;
    validate_display_string("card.cancel_label", &definition.card.cancel_label)?;
    let mut row_fields = HashSet::new();
    let mut row_labels = HashSet::new();
    for (index, row) in definition.card.rows.iter().enumerate() {
        validate_bounded_string(&format!("card.rows[{index}].field"), &row.field, 1, 64)?;
        validate_bounded_string(&format!("card.rows[{index}].label"), &row.label, 1, 128)?;
        validate_safe_field(&format!("card.rows[{index}].field"), &row.field)?;
        validate_display_string(&format!("card.rows[{index}].label"), &row.label)?;
        if row.label.trim() != row.label {
            return Err(format!("card.rows[{index}].label must not have surrounding whitespace"));
        }
        if row.label.starts_with("__oc_") {
            return Err(format!("card.rows[{index}].label uses a reserved prefix"));
        }
        if !row_fields.insert(row.field.as_str()) {
            return Err(format!("card.rows[{index}].field must be unique"));
        }
        if !row_labels.insert(row.label.as_str()) {
            return Err(format!("card.rows[{index}].label must be unique"));
        }
    }
    if let Some(disclosure) = &definition.card.disclosure {
        validate_bounded_string("card.disclosure", disclosure, 0, 1_000)?;
        validate_display_string("card.disclosure", disclosure)?;
    }
    validate_rules(&definition.rules)?;
    Ok(())
}

fn validate_bounded_string(label: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let length = value.chars().count();
    if length < min || length > max || (min > 0 && value.trim().is_empty()) {
        return Err(format!("{label} must be between {min} and {max} characters"));
    }
    Ok(())
}

const MAX_RULES: usize = 20;
const MAX_RULE_STRING_LENGTH: usize = 64;
const MAX_INSTRUCTION_TEXT_LENGTH: usize = 1000;
const MAX_KEYWORD_MAPPINGS: usize = 50;
const MAX_KEYWORDS_PER_MAPPING: usize = 50;
const MAX_ACTION_KEYWORDS: usize = 500;
const MAX_FROM_MESSAGE_MAX_LENGTH: u32 = 2000;
const MAX_SCHEMA_DEPTH: usize = 16;
const MAX_SCHEMA_NODES: usize = 512;
const MAX_SCHEMA_PROPERTIES: usize = 64;

fn validate_rules(rules: &[AiActionRule]) -> Result<(), String> {
    if rules.len() > MAX_RULES {
        return Err(format!("rules must contain at most {MAX_RULES} entries"));
    }
    let mut total_keywords = 0usize;
    for rule in rules {
        match rule {
            AiActionRule::KeywordMap(r) => {
                validate_rule_string("keyword_map field", &r.field)?;
                validate_safe_field("keyword_map field", &r.field)?;
                if r.map.len() > MAX_KEYWORD_MAPPINGS {
                    return Err(format!(
                        "keyword_map map must contain at most {MAX_KEYWORD_MAPPINGS} mappings"
                    ));
                }
                for mapping in &r.map {
                    validate_rule_string("keyword_map value", &mapping.value)?;
                    validate_display_string("keyword_map value", &mapping.value)?;
                    if mapping.keywords.len() > MAX_KEYWORDS_PER_MAPPING {
                        return Err(format!(
                            "keyword_map mapping must contain at most {MAX_KEYWORDS_PER_MAPPING} keywords"
                        ));
                    }
                    for keyword in &mapping.keywords {
                        validate_rule_string("keyword_map keyword", keyword)?;
                        validate_display_string("keyword_map keyword", keyword)?;
                    }
                    total_keywords = total_keywords.saturating_add(mapping.keywords.len());
                    if total_keywords > MAX_ACTION_KEYWORDS {
                        return Err(format!("rules contain more than {MAX_ACTION_KEYWORDS} keywords in aggregate"));
                    }
                }
            }
            AiActionRule::FromMessage(r) => {
                validate_rule_string("from_message field", &r.field)?;
                validate_safe_field("from_message field", &r.field)?;
                if r.max_length
                    .is_some_and(|max_length| max_length > MAX_FROM_MESSAGE_MAX_LENGTH)
                {
                    return Err(format!(
                        "from_message max_length must be at most {MAX_FROM_MESSAGE_MAX_LENGTH}"
                    ));
                }
            }
            AiActionRule::Normalize(r) => {
                validate_rule_string("normalize field", &r.field)?;
                validate_safe_field("normalize field", &r.field)?;
            }
            AiActionRule::Instruction(r) => {
                if r.text.chars().count() > MAX_INSTRUCTION_TEXT_LENGTH {
                    return Err(format!(
                        "instruction text must be at most {MAX_INSTRUCTION_TEXT_LENGTH} characters"
                    ));
                }
                if contains_bidi_or_format_control(&r.text) {
                    return Err("instruction text must not contain bidi or format controls".to_string());
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

fn validate_safe_field(label: &str, value: &str) -> Result<(), String> {
    let mut chars = value.chars();
    let first = chars.next();
    let valid = first.is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && !matches!(value, "__proto__" | "prototype" | "constructor");
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{label} must start with an ASCII letter, contain only ASCII letters/digits/underscore, and not be prototype-sensitive"
        ))
    }
}

fn contains_bidi_or_format_control(value: &str) -> bool {
    value.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                '\u{061C}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{206F}'
                    | '\u{FEFF}'
            )
    })
}

fn validate_display_string(label: &str, value: &str) -> Result<(), String> {
    if contains_bidi_or_format_control(value) {
        Err(format!(
            "{label} must not contain control, bidi, or invisible format characters"
        ))
    } else {
        Ok(())
    }
}

fn validate_response_schema(schema: &serde_json::Value) -> Result<(), String> {
    let mut nodes = 0usize;
    validate_schema_node(schema, 0, &mut nodes)
}

fn validate_schema_node(value: &serde_json::Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(format!("response_schema must be at most {MAX_SCHEMA_DEPTH} levels deep"));
    }
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_SCHEMA_NODES {
        return Err(format!("response_schema must contain at most {MAX_SCHEMA_NODES} values"));
    }
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                validate_schema_node(value, depth + 1, nodes)?;
            }
        }
        serde_json::Value::Object(object) => {
            if object.contains_key("pattern") {
                return Err(
                    "response_schema patterns are unsupported because they cannot be evaluated with a bounded matcher"
                        .to_string(),
                );
            }
            if let Some(properties) = object.get("properties") {
                let properties = properties
                    .as_object()
                    .ok_or_else(|| "response_schema properties must be an object".to_string())?;
                if properties.len() > MAX_SCHEMA_PROPERTIES {
                    return Err(format!(
                        "response_schema properties must contain at most {MAX_SCHEMA_PROPERTIES} fields"
                    ));
                }
                for field in properties.keys() {
                    validate_safe_field("response_schema property", field)?;
                }
                if let Some(required) = object.get("required") {
                    let required = required
                        .as_array()
                        .ok_or_else(|| "response_schema required must be an array".to_string())?;
                    let mut seen = HashSet::new();
                    for field in required {
                        let field = field
                            .as_str()
                            .ok_or_else(|| "response_schema required entries must be strings".to_string())?;
                        validate_safe_field("response_schema required field", field)?;
                        if !properties.contains_key(field) {
                            return Err("response_schema required fields must be declared in properties".to_string());
                        }
                        if !seen.insert(field) {
                            return Err("response_schema required fields must be unique".to_string());
                        }
                    }
                }
            }
            for child in object.values() {
                validate_schema_node(child, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use candid::Principal;
    use utils::env::test::TestEnv;

    const VALID_P256_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEL4Rj13upzgERFkEaivsNjEA/HvCr\nm+J36bnO257UvRzwEW+OpmmEQt6fZ5lO3So6wXPtuziuv/FXrA6S7sni8g==\n-----END PUBLIC KEY-----\n";
    const MALFORMED_PEM: &str = "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n";
    const ED25519_SPKI_PEM: &str =
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n";

    fn action() -> AiActionDefinition {
        AiActionDefinition {
            name: "sample.action".to_string(),
            description: "Neutral sample".to_string(),
            prompt_template: "Return structured data".to_string(),
            response_schema: "{\"type\":\"object\"}".to_string(),
            card: types::AiActionCardTemplate {
                title: "Review operation".to_string(),
                confirm_label: "Confirm".to_string(),
                cancel_label: "Cancel".to_string(),
                rows: vec![types::AiActionCardRowTemplate {
                    field: "value".to_string(),
                    label: "Value".to_string(),
                }],
                disclosure: Some("This sends the reviewed fields.".to_string()),
            },
            endpoint: "https://app.example/actions".to_string(),
            consumer_public_key: None,
            rules: Vec::new(),
            accepts_image: false,
        }
    }

    fn surface(kind: &str, url: &str, display: types::SurfaceDisplay) -> AiAppSurface {
        AiAppSurface {
            kind: kind.to_string(),
            url: url.to_string(),
            display,
        }
    }

    fn manifest() -> AiAppManifest {
        AiAppManifest {
            name: "generic-app".to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: VALID_P256_SPKI_PEM.to_string(),
            per_user_keys: false,
            actions: Vec::new(),
            surfaces: Vec::new(),
        }
    }

    #[test]
    fn upgraded_test_mode_registrar_can_update_only_its_exact_existing_app() {
        let registrar = Principal::from_slice(&[41]);
        let other_owner: UserId = Principal::from_slice(&[42]).into();
        let mut env = TestEnv::default();
        env.caller = registrar;
        env.now = 100;
        let mut data = Data::default();
        data.test_mode = true;
        let existing = data.ai_apps.register(registrar.into(), manifest(), 10, true).unwrap();
        let mut other_manifest = manifest();
        other_manifest.name = "other-app".to_string();
        let other = data.ai_apps.register(other_owner, other_manifest.clone(), 10, true).unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        let mut changed = manifest();
        changed.description = "updated after upgrade".to_string();
        let updated = register_ai_app_impl(Args { manifest: changed }, &mut state);
        assert!(
            matches!(updated, Success(ref registration) if registration.id == existing.id && registration.owner == UserId::from(registrar))
        );
        assert_eq!(
            state.data.ai_apps.get(existing.id).unwrap().manifest.description,
            "updated after upgrade"
        );

        let mut new_manifest = manifest();
        new_manifest.name = "new-app".to_string();
        assert!(matches!(
            register_ai_app_impl(Args { manifest: new_manifest }, &mut state),
            InvalidRequest(message) if message.contains("only its existing app")
        ));
        assert!(
            state.data.ai_apps.get(other.id + 1).is_none(),
            "no new app id may be allocated"
        );

        assert!(matches!(
            register_ai_app_impl(Args { manifest: other_manifest }, &mut state),
            InvalidRequest(message) if message.contains("only its existing app")
        ));
        assert_eq!(state.data.ai_apps.get(other.id).unwrap().owner, other_owner);
    }

    #[test]
    fn manifest_and_action_keys_require_p256_spki_and_are_canonicalized() {
        for invalid in [MALFORMED_PEM, ED25519_SPKI_PEM] {
            let mut app = manifest();
            app.consumer_public_key = invalid.to_string();
            assert!(validate(&mut app, false).is_err());

            let mut value = action();
            value.consumer_public_key = Some(invalid.to_string());
            assert!(validate_action_definition(&mut value, false).is_err());
        }

        let mut app = manifest();
        app.consumer_public_key = VALID_P256_SPKI_PEM.replace('\n', "\r\n");
        assert!(validate(&mut app, false).is_ok());
        assert_eq!(app.consumer_public_key, VALID_P256_SPKI_PEM);

        let mut value = action();
        value.consumer_public_key = Some(VALID_P256_SPKI_PEM.replace('\n', "\r\n"));
        assert!(validate_action_definition(&mut value, false).is_ok());
        assert_eq!(value.consumer_public_key.as_deref(), Some(VALID_P256_SPKI_PEM));
    }

    #[test]
    fn anonymous_app_and_inbox_canister_ids_are_rejected() {
        let mut app = manifest();
        app.app_canister_id = Some(candid::Principal::anonymous());
        assert_eq!(
            validate(&mut app, false),
            Err("app_canister_id must identify a non-anonymous canister".to_string())
        );

        let mut app = manifest();
        app.inbox_canister_id = Some(candid::Principal::anonymous());
        assert_eq!(
            validate(&mut app, false),
            Err("inbox_canister_id must identify a non-anonymous canister".to_string())
        );
    }

    // An embedded (display "sheet") surface — the in-bubble card renderer — must be https on a real
    // host; plaintext http there is a downgrade vector and is rejected.
    #[test]
    fn sheet_surface_requires_https_on_a_real_host() {
        assert!(
            validate_surface(
                &surface("card", "http://app.example/chat/card", types::SurfaceDisplay::Sheet),
                false
            )
            .is_err()
        );
        assert!(
            validate_surface(
                &surface("card", "https://app.example/chat/card", types::SurfaceDisplay::Sheet),
                false
            )
            .is_ok()
        );
    }

    // Loopback http stays allowed so local dev (127.0.0.1 / localhost) can still register a card surface.
    #[test]
    fn loopback_http_is_test_mode_only() {
        let loopback_card = surface("card", "http://127.0.0.1:3000/chat/card", types::SurfaceDisplay::Sheet);
        let loopback_home = surface("home", "http://localhost:5341/", types::SurfaceDisplay::Sheet);
        assert!(
            validate_surface(&loopback_card, false).is_err(),
            "production must not target a client's localhost"
        );
        assert!(validate_surface(&loopback_home, false).is_err());
        assert!(validate_surface(&loopback_card, true).is_ok());
        assert!(validate_surface(&loopback_home, true).is_ok());
    }

    // External navigation is still app-controlled input and must not carry javascript/file/plaintext
    // network schemes into the browser/native URL handoff.
    #[test]
    fn external_surface_requires_https_or_loopback() {
        assert!(
            validate_surface(
                &surface(
                    "chat_link",
                    "https://app.example/link?chat={chatKey}",
                    types::SurfaceDisplay::External
                ),
                false
            )
            .is_err(),
            "raw chat placeholders must never leave OpenChat in an external URL"
        );
        assert!(
            validate_surface(
                &surface(
                    "chat_link",
                    "https://app.example/link?app={appId}",
                    types::SurfaceDisplay::External
                ),
                false
            )
            .is_ok()
        );
        assert!(
            validate_surface(
                &surface("chat_link", "http://app.example/link", types::SurfaceDisplay::External),
                false
            )
            .is_err()
        );
        assert!(
            validate_surface(
                &surface("chat_link", "javascript:alert(1)", types::SurfaceDisplay::External),
                false
            )
            .is_err()
        );
        assert!(
            validate_surface(
                &surface(
                    "chat_link",
                    "https://user:password@app.example/link",
                    types::SurfaceDisplay::External
                ),
                false
            )
            .is_err()
        );
    }

    // The pre-existing "must parse" check still applies regardless of display.
    #[test]
    fn surface_url_must_still_parse() {
        assert!(validate_surface(&surface("card", "not a url", types::SurfaceDisplay::Sheet), false).is_err());
    }

    #[test]
    fn action_and_card_fields_are_bounded() {
        let mut value = action();
        assert!(validate_action_definition(&mut value, false).is_ok());
        value.name = "n".repeat(65);
        assert!(validate_action_definition(&mut value, false).is_err());

        let mut value = action();
        value.prompt_template = "p".repeat(16_385);
        assert!(validate_action_definition(&mut value, false).is_err());

        let mut value = action();
        value.card.rows = (0..33)
            .map(|i| types::AiActionCardRowTemplate {
                field: format!("f{i}"),
                label: format!("Row {i}"),
            })
            .collect();
        assert!(validate_action_definition(&mut value, false).is_err());

        let mut value = action();
        value.card.disclosure = Some("d".repeat(1_001));
        assert!(validate_action_definition(&mut value, false).is_err());
    }

    fn keyword_rule(keyword_count: usize) -> AiActionRule {
        let mappings = (0..keyword_count.div_ceil(MAX_KEYWORDS_PER_MAPPING))
            .map(|mapping_index| {
                let start = mapping_index * MAX_KEYWORDS_PER_MAPPING;
                let count = (keyword_count - start).min(MAX_KEYWORDS_PER_MAPPING);
                types::KeywordMapping {
                    value: format!("v{mapping_index}"),
                    keywords: (0..count).map(|index| format!("k{mapping_index}_{index}")).collect(),
                }
            })
            .collect();
        AiActionRule::KeywordMap(types::KeywordMapRule {
            field: "category".to_string(),
            mode: types::RuleMode::Override,
            map: mappings,
        })
    }

    fn action_with_rules(name: &str, rules: Vec<AiActionRule>) -> AiActionDefinition {
        let mut value = action();
        value.name = name.to_string();
        value.rules = rules;
        value
    }

    #[test]
    fn schema_patterns_and_unsafe_or_ambiguous_fields_fail_closed() {
        let mut value = action();
        value.response_schema = r#"{"type":"object","properties":{"code":{"type":"string","pattern":"(a+)+$"}}}"#.to_string();
        assert!(
            validate_action_definition(&mut value, false)
                .unwrap_err()
                .contains("patterns are unsupported")
        );

        for field in ["__proto__", "prototype", "constructor", "has-dash", "9starts_with_digit"] {
            let mut value = action();
            value.card.rows[0].field = field.to_string();
            assert!(
                validate_action_definition(&mut value, false).is_err(),
                "accepted unsafe field {field}"
            );
        }

        let mut value = action();
        value.card.rows.push(types::AiActionCardRowTemplate {
            field: "value2".to_string(),
            label: "Value".to_string(),
        });
        assert!(
            validate_action_definition(&mut value, false)
                .unwrap_err()
                .contains("label must be unique")
        );

        let mut value = action();
        value.card.rows.push(types::AiActionCardRowTemplate {
            field: "value".to_string(),
            label: "Other".to_string(),
        });
        assert!(
            validate_action_definition(&mut value, false)
                .unwrap_err()
                .contains("field must be unique")
        );

        let mut value = action();
        value.card.rows[0].label = "Amount\u{202e}USD".to_string();
        assert!(validate_action_definition(&mut value, false).unwrap_err().contains("bidi"));

        let mut value = action();
        value.response_schema = r#"{"type":"object","properties":{"constructor":{"type":"string"}}}"#.to_string();
        assert!(validate_action_definition(&mut value, false).is_err());
    }

    #[test]
    fn rule_and_keyword_aggregate_limits_accept_at_limit_and_reject_above() {
        let instruction = || {
            AiActionRule::Instruction(types::InstructionRule {
                text: "bounded".to_string(),
            })
        };

        let mut at_rule_limit = manifest();
        at_rule_limit.actions = (0..5)
            .map(|index| action_with_rules(&format!("sample.rules.{index}"), (0..20).map(|_| instruction()).collect()))
            .collect();
        assert!(validate(&mut at_rule_limit, false).is_ok());

        let mut above_rule_limit = manifest();
        above_rule_limit.actions = (0..5)
            .map(|index| action_with_rules(&format!("sample.rules.{index}"), (0..20).map(|_| instruction()).collect()))
            .chain(std::iter::once(action_with_rules("sample.rules.extra", vec![instruction()])))
            .collect();
        assert!(validate(&mut above_rule_limit, false).unwrap_err().contains("100 rules"));

        let mut at_action_keyword_limit = action_with_rules("sample.keywords", vec![keyword_rule(MAX_ACTION_KEYWORDS)]);
        assert!(validate_action_definition(&mut at_action_keyword_limit, false).is_ok());
        let mut above_action_keyword_limit = action_with_rules("sample.keywords", vec![keyword_rule(MAX_ACTION_KEYWORDS + 1)]);
        assert!(
            validate_action_definition(&mut above_action_keyword_limit, false)
                .unwrap_err()
                .contains("500 keywords")
        );

        let mut at_manifest_keyword_limit = manifest();
        at_manifest_keyword_limit.actions = (0..4)
            .map(|index| action_with_rules(&format!("sample.keywords.{index}"), vec![keyword_rule(MAX_ACTION_KEYWORDS)]))
            .collect();
        assert!(validate(&mut at_manifest_keyword_limit, false).is_ok());

        let mut above_manifest_keyword_limit = manifest();
        above_manifest_keyword_limit.actions = (0..4)
            .map(|index| action_with_rules(&format!("sample.keywords.{index}"), vec![keyword_rule(MAX_ACTION_KEYWORDS)]))
            .chain(std::iter::once(action_with_rules(
                "sample.keywords.extra",
                vec![keyword_rule(1)],
            )))
            .collect();
        assert!(
            validate(&mut above_manifest_keyword_limit, false)
                .unwrap_err()
                .contains("2000 keywords")
        );
    }
}
