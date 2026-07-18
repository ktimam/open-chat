use crate::action_deposit_envelope;
use crate::guards::caller_is_local_child_canister;
use crate::{RuntimeState, mutate_state};
use action_inbox_canister::c2c_notify_actions::ActionDeposit;
use canister_api_macros::update;
use canister_tracing_macros::trace;
use jwt::sign_bytes;
use local_user_index_canister::c2c_deposit_action_confirmed::{Response::*, *};
use serde_bytes::ByteBuf;
use tracing::{error, info};
use types::CanisterId;

// A chat canister forwards an opaque confirmed-action payload + the recipient consumers' public keys + the
// context of the confirmation (which chat/message/user). We wrap the payload in the plaintext context
// envelope (v2), encrypt it separately to EACH key (fan-out: one envelope per recipient, so every chat
// member with a registered app key gets the confirmed action in their own inbox bucket), sign each with
// the platform key for provenance (v2 preimage, which binds `created_at`), and deposit the whole batch to
// the action_inbox canister in ONE atomic call. OpenChat never interprets the payload.
#[update(guard = "caller_is_local_child_canister", msgpack = true)]
#[trace]
async fn c2c_deposit_action_confirmed(args: Args) -> Response {
    let (target, deposits) = match mutate_state(|state| prepare(args, state)) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };

    // Observability: a confirmed-action deposit is routed to `target` and keyed by the consumer key
    // fingerprints. Recording both (and the store outcome) lets a deposit that "succeeds" for the confirming
    // user yet never surfaces in a consumer's inbox be traced to a routing/key mismatch rather than a
    // silent drop. Fingerprints are public hashes (the on-chain routing keys), not secrets.
    let fingerprints: String = deposits
        .iter()
        .map(|d| d.consumer_key_fingerprint.iter().map(|b| format!("{b:02x}")).collect::<String>())
        .collect::<Vec<_>>()
        .join(",");

    match action_inbox_canister_c2c_client::c2c_notify_actions(
        target,
        &action_inbox_canister::c2c_notify_actions::Args { deposits },
    )
    .await
    {
        Ok(action_inbox_canister::c2c_notify_actions::Response::Success) => {
            info!(%target, %fingerprints, "action deposit batch stored");
            Success
        }
        Ok(action_inbox_canister::c2c_notify_actions::Response::Error(error)) => {
            error!(%target, %fingerprints, ?error, "action deposit rejected by inbox");
            Error(format!("{error:?}"))
        }
        Err(error) => {
            error!(%target, %fingerprints, ?error, "action deposit call failed");
            Error(format!("{error:?}"))
        }
    }
}

// Bound on fan-out recipients per confirm. Generous for the intended surface (both sides of a direct
// chat; small groups) while capping the per-confirm encrypt/sign work an abusive card could demand.
const MAX_DEPOSIT_RECIPIENTS: usize = 8;

// Kept sync so the rng + signing key are touched without holding canister state across the await.
fn prepare(args: Args, state: &mut RuntimeState) -> Result<(CanisterId, Vec<ActionDeposit>), Response> {
    // Per-card inbox override (app-declared, carried on the card) wins; otherwise the globally
    // configured action_inbox. Routing only — the envelope/encryption/signature below are identical
    // regardless of target, so the E2E provenance is unchanged.
    let Some(target) = args.inbox_canister_id.or(state.data.action_inbox_canister_id) else {
        return Err(NotConfigured);
    };

    // Effective recipient set: the legacy single key + the fan-out list, deduped preserving order
    // (legacy first), truncated to the bound. Rejected when empty — a routing-bearing confirm with
    // no usable recipient must fail loudly (two-phase confirm then leaves the card Pending).
    let mut recipients: Vec<&String> = Vec::new();
    for pem in std::iter::once(&args.consumer_public_key_pem).chain(args.consumer_public_key_pems.iter()) {
        if !pem.is_empty() && !recipients.iter().any(|r| *r == pem) {
            recipients.push(pem);
        }
    }
    recipients.truncate(MAX_DEPOSIT_RECIPIENTS);
    if recipients.is_empty() {
        return Err(Error("no recipient public key supplied".to_string()));
    }

    // Envelope plaintext v2: wrap the opaque payload with the confirmation context before encrypting.
    // The SAME plaintext (context + payload) goes to every recipient; only the encryption differs.
    let plaintext = action_deposit_envelope::wrap_plaintext(&args.context, args.created_at, args.plaintext.as_ref());

    // Deterministic dedupe key: the LOGICAL identity of the confirmed card — its message id plus the
    // opaque confirm payload — NOT the ciphertext (which is unique per attempt: fresh random ephemeral
    // key). Two-phase confirm leaves the card Pending on a failed deposit, so a user RETRY re-encrypts
    // with a new ephemeral key; keying on the ciphertext would have made every retry a fresh inbox entry.
    // Keying on (message_id, payload) means a retry — or the platform's automatic c2c retry — dedupes to
    // a single entry within EACH recipient's fingerprint bucket (the inbox scopes `seen` per fingerprint,
    // so one shared id across the fan-out batch dedupes independently per recipient).
    let mut dedupe_input = args.plaintext.as_ref().to_vec();
    dedupe_input.extend_from_slice(&args.context.message_id.as_u64().to_be_bytes());
    let digest = sha256::sha256(&dedupe_input);
    let idempotency_id = u64::from_le_bytes(digest[..8].try_into().unwrap());

    let secret_key_der = state.data.oc_key_pair.secret_key_der();
    let mut deposits = Vec::with_capacity(recipients.len());
    for pem in recipients {
        // A malformed key among the recipients fails the WHOLE batch (atomic with two-phase confirm:
        // the card stays Pending and the user can retry) rather than silently dropping one member.
        let envelope = ecies_payload::encrypt(&plaintext, pem, state.env.rng()).map_err(Error)?;
        let fingerprint = ecies_payload::key_fingerprint(pem).map_err(Error)?;
        let signature = sign_bytes(&envelope.signing_preimage(args.created_at), secret_key_der, state.env.rng())
            .map_err(|e| Error(format!("{e:?}")))?;
        deposits.push(ActionDeposit {
            idempotency_id,
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            ephemeral_public_key: ByteBuf::from(envelope.ephemeral_public_key),
            ciphertext: ByteBuf::from(envelope.ciphertext),
            oc_signature: ByteBuf::from(signature),
            created_at: args.created_at,
        });
    }

    Ok((target, deposits))
}
