use crate::guards::caller_is_openchat_user;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::{AiActionDefinition, AiActionRule};
use url::Url;
use user_index_canister::register_ai_action::{Response::*, *};

#[update(guard = "caller_is_openchat_user", msgpack = true)]
#[trace]
fn register_ai_action(args: Args) -> Response {
    mutate_state(|state| register_ai_action_impl(args, state))
}

fn register_ai_action_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    let Some(owner) = state.data.users.get_by_principal(&caller) else {
        return InvalidRequest("caller is not a registered user".to_string());
    };
    let owner_id = owner.user_id;

    if let Err(message) = validate_action_definition(&args.definition) {
        return InvalidRequest(message);
    }

    let now = state.env.now();
    let registration = state.data.ai_actions.register(owner_id, args.definition, now);
    Success(registration)
}

/// Validates a single action definition. Shared with `register_ai_app`, which applies exactly the
/// same rules to each action embedded in an app manifest.
pub(crate) fn validate_action_definition(definition: &AiActionDefinition) -> Result<(), String> {
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
