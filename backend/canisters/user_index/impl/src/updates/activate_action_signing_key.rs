use crate::guards::caller_is_governance_principal;
use crate::mutate_state;
use canister_api_macros::proposal;
use canister_tracing_macros::trace;
use user_index_canister::activate_action_signing_key::{Response::*, *};

/// Second, explicit half of rotation. There is intentionally no automatic staged-to-active path:
/// governance performs this only after the staged key id has reached consumer pin allowlists.
#[proposal(guard = "caller_is_governance_principal")]
#[trace]
fn activate_action_signing_key(args: Args) -> Response {
    let Ok(key_id) = <[u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES]>::try_from(args.key_id.as_ref()) else {
        return InvalidKeyId;
    };
    mutate_state(|state| {
        let now = state.env.now();
        match state.data.action_signing_keyring.activate(&key_id, now) {
            Ok(()) => Success,
            Err(_) => NotStaged,
        }
    })
}
