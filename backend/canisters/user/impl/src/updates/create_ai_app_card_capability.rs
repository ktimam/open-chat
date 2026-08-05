use crate::guards::caller_is_owner;
use canister_api_macros::update;
use user_canister::create_ai_app_card_capability::{Response::*, *};

// Direct chats have no enabled-AI-app policy yet. Exposing private app context here would bypass the
// explicit group/channel enablement boundary, so direct cards remain fail-closed for this phase.
#[update(guard = "caller_is_owner", msgpack = true)]
fn create_ai_app_card_capability(_args: Args) -> Response {
    AppUnavailable
}
