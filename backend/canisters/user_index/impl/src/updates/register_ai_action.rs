use crate::guards::caller_is_openchat_user;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::AiActionDefinition;
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

    if let Err(message) = validate(&args.definition) {
        return InvalidRequest(message);
    }

    let now = state.env.now();
    let registration = state.data.ai_actions.register(owner_id, args.definition, now);
    Success(registration)
}

fn validate(definition: &AiActionDefinition) -> Result<(), String> {
    if definition.name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    if Url::parse(&definition.endpoint).is_err() {
        return Err("endpoint must be a valid URL".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(&definition.response_schema).is_err() {
        return Err("response_schema must be valid JSON".to_string());
    }
    Ok(())
}
