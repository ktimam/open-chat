use crate::guards::caller_is_local_child_canister;
use crate::{RuntimeState, mutate_state};
use action_inbox_canister::c2c_notify_actions::ActionDeposit;
use canister_api_macros::update;
use canister_tracing_macros::trace;
use jwt::sign_bytes;
use local_user_index_canister::c2c_deposit_action_confirmed::{Response::*, *};
use serde_bytes::ByteBuf;
use types::CanisterId;

// A chat canister forwards an opaque confirmed-action payload + the recipient consumer's public key. We
// encrypt the payload to that key, sign it with the platform key for provenance, and deposit it to the
// action_inbox canister. OpenChat never sees the plaintext nor interprets it.
#[update(guard = "caller_is_local_child_canister", msgpack = true)]
#[trace]
async fn c2c_deposit_action_confirmed(args: Args) -> Response {
    let (target, deposit) = match mutate_state(|state| prepare(args, state)) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };

    match action_inbox_canister_c2c_client::c2c_notify_actions(
        target,
        &action_inbox_canister::c2c_notify_actions::Args { deposits: vec![deposit] },
    )
    .await
    {
        Ok(action_inbox_canister::c2c_notify_actions::Response::Success) => Success,
        Ok(action_inbox_canister::c2c_notify_actions::Response::Error(error)) => Error(format!("{error:?}")),
        Err(error) => Error(format!("{error:?}")),
    }
}

// Kept sync so the rng + signing key are touched without holding canister state across the await.
fn prepare(args: Args, state: &mut RuntimeState) -> Result<(CanisterId, ActionDeposit), Response> {
    let Some(target) = state.data.action_inbox_canister_id else {
        return Err(NotConfigured);
    };

    let envelope =
        ecies_payload::encrypt(args.plaintext.as_ref(), &args.consumer_public_key_pem, state.env.rng()).map_err(Error)?;
    let fingerprint = ecies_payload::key_fingerprint(&args.consumer_public_key_pem).map_err(Error)?;

    let secret_key_der = state.data.oc_key_pair.secret_key_der();
    let signature =
        sign_bytes(&envelope.signing_preimage(), secret_key_der, state.env.rng()).map_err(|e| Error(format!("{e:?}")))?;

    // Deterministic dedupe key: the ciphertext is unique per deposit (fresh random ephemeral key), so a c2c
    // retry of the same built deposit carries the same id and is deduped by the inbox.
    let digest = sha256::sha256(&envelope.ciphertext);
    let idempotency_id = u64::from_le_bytes(digest[..8].try_into().unwrap());

    Ok((
        target,
        ActionDeposit {
            idempotency_id,
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            ephemeral_public_key: ByteBuf::from(envelope.ephemeral_public_key),
            ciphertext: ByteBuf::from(envelope.ciphertext),
            oc_signature: ByteBuf::from(signature),
            created_at: args.created_at,
        },
    ))
}
