use crate::guards::caller_is_governance_principal;
use crate::mutate_state;
use canister_api_macros::proposal;
use canister_tracing_macros::trace;
use serde_bytes::ByteBuf;
use user_index_canister::stage_action_signing_key::{Response::*, *};

const ACTION_SIGNING_KEY_STAGE_ENTROPY_PURPOSE: &[u8] = b"user-index/action-signing-key-stage/v1";

/// First half of the deliberate rotation ceremony. The staged public key is discoverable but can
/// never sign until consumers independently add its key id to their configured pin allowlists and
/// governance later invokes `activate_action_signing_key` for that exact id.
#[proposal(guard = "caller_is_governance_principal")]
#[trace]
fn stage_action_signing_key(_args: Args) -> Response {
    mutate_state(|state| {
        let now = state.env.now();
        let mut rng = match crate::pr2_entropy::output_rng(state, ACTION_SIGNING_KEY_STAGE_ENTROPY_PURPOSE) {
            Ok(rng) => rng,
            Err(error) => return Error(error.to_string()),
        };
        match state.data.action_signing_keyring.stage(&mut rng, now) {
            Ok(key_id) => Success(SuccessResult {
                key_id: ByteBuf::from(key_id.to_vec()),
            }),
            Err(error) => Error(error),
        }
    })
}
