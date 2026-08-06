use crate::action_deposit_envelope;
use crate::guards::caller_is_local_child_canister;
use crate::updates::c2c_create_ai_app_card_capability::{
    authoritative_child_registration, validate_authoritative_child_context,
};
use crate::{RuntimeState, mutate_state, read_state};
use canister_api_macros::update;
use ct_codecs::{Base64UrlSafeNoPadding, Encoder};
use local_user_index_canister::c2c_deposit_action_confirmed::{Response::*, *};
use rand::RngCore;
use serde::Serialize;
use serde_bytes::ByteBuf;
use tracing::{error, info};
use types::CanisterId;

const ACTION_ENVELOPE_ENTROPY_PURPOSE: &[u8] = b"local-user-index/action-envelope/v4";

// A chat canister forwards an opaque payload plus immutable app/action provenance and user ids derived
// from authoritative membership. We validate a one-use GroupIndex authority, resolve the exact
// published route/key, wrap the payload in the plaintext context envelope (v4), and encrypt
// separately. UserIndex—not this shard—signs only after consuming the same authority.
#[update(guard = "caller_is_local_child_canister", msgpack = true)]
async fn c2c_deposit_action_confirmed(args: Args) -> Response {
    if let Err(error) = validate_pre_await_bounds(args.plaintext.len(), args.context.member_user_ids.len()) {
        return Error(error);
    }
    let (app_id, app_revision) = match verified_app_binding(&args.context) {
        Ok(binding) => binding,
        Err(error) => return Error(error),
    };
    let authority_context = match authority_context(&args.context) {
        Ok(context) => context,
        Err(error) => return Error(error),
    };
    let content_hash = args.context.content_hash.expect("verified app binding checked content hash");
    let confirmation_lease_generation = args.context.confirmation_lease_generation;
    let authority = args.authority.clone();
    let confirmed_by = args.context.confirmed_by;
    let caller = ic_cdk::api::msg_caller();
    let caller_registration = read_state(|state| authoritative_child_registration(state, caller));
    if let Err(error) = verify_chat_caller_and_members(&args.context, caller, caller_registration.kind) {
        return Error(error);
    }
    let authoritative_route = match resolve_authoritative_route(&args).await {
        Ok(route) => route,
        Err(response) => return response,
    };
    // The local child registry may change while route/key lookups are awaited. Revalidate the
    // exact captured caller, child kind, chat, confirmer, and member assertion before encryption.
    let current_registration = read_state(|state| authoritative_child_registration(state, caller));
    if current_registration != caller_registration {
        return Error("local child registration changed while action route was resolved".to_string());
    }
    if let Err(error) = verify_chat_caller_and_members(&args.context, caller, current_registration.kind) {
        return Error(error);
    }
    let (deposits, recipient_key_bindings, action_id) = match mutate_state(|state| prepare(args, authoritative_route, state)) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };
    let relay_args = user_index_canister::c2c_deposit_actions::Args {
        authority_context,
        content_hash,
        confirmation_lease_generation,
        authority,
        confirmed_by,
        app_id,
        app_revision,
        action_id,
        recipient_key_bindings,
        deposits,
    };
    if let Err(error) = validate_encoded_deposit_payload(&relay_args) {
        return Error(error);
    }

    // Keep observability aggregate-only. Destinations and per-user key fingerprints are linkable
    // routing metadata and must not be copied into logs/traces.
    let deposit_count = relay_args.deposits.len();

    let result =
        user_index_canister_c2c_client::c2c_deposit_actions(read_state(|state| state.data.user_index_canister_id), &relay_args)
            .await;
    if read_state(|state| authoritative_child_registration(state, caller)) != caller_registration {
        return OutcomeUnknown;
    }
    match result {
        Ok(user_index_canister::c2c_deposit_actions::Response::Success) => {
            info!(deposit_count, "action deposit batch stored");
            Success
        }
        Ok(user_index_canister::c2c_deposit_actions::Response::OutcomeUnknown) | Err(_) => {
            error!(deposit_count, "action deposit outcome unknown");
            OutcomeUnknown
        }
        Ok(user_index_canister::c2c_deposit_actions::Response::Error(_)) => {
            error!(deposit_count, "action deposit rejected by inbox");
            Error("action deposit rejected".to_string())
        }
    }
}

fn verified_app_binding(context: &ActionDepositContext) -> Result<(types::AiAppId, types::TimestampMillis), String> {
    if matches!(context.chat, types::Chat::Direct(_)) {
        return Err("app card confirmations are not supported in direct chats".to_string());
    }
    if !context.app_verified {
        return Err("app card provenance was not verified by the chat canister".to_string());
    }
    let app_id = context
        .app_id
        .ok_or_else(|| "legacy card has no trusted app provenance".to_string())?;
    let app_revision = context
        .app_revision
        .ok_or_else(|| "app-bound card has no manifest revision".to_string())?;
    if context.content_hash.is_none() {
        return Err("app-bound card has no canonical content commitment".to_string());
    }
    if context.confirmation_lease_generation == 0 {
        return Err("app-bound card has no durable confirmation lease".to_string());
    }
    Ok((app_id, app_revision))
}

fn authority_context(context: &ActionDepositContext) -> Result<types::AiAppCardContext, String> {
    let (app_id, app_revision) = verified_app_binding(context)?;
    if context.action_id.is_empty() {
        return Err("app-bound card has no action id".to_string());
    }
    Ok(types::AiAppCardContext {
        user_id: context.confirmed_by,
        chat: context.chat,
        chat_key: action_deposit_envelope::chat_key(&context.chat, &context.member_user_ids)?,
        thread_root_message_index: context.thread_root_message_index,
        message_id: context.message_id,
        app_id,
        app_revision,
        action_id: context.action_id.clone(),
    })
}

fn verify_chat_caller_and_members(
    context: &ActionDepositContext,
    caller: candid::Principal,
    caller_kind: crate::updates::c2c_create_ai_app_card_capability::AuthoritativeChildKind,
) -> Result<(), String> {
    let mut members = Vec::new();
    for user_id in context.member_user_ids.iter().copied() {
        if !members.contains(&user_id) {
            members.push(user_id);
        }
    }
    if members.is_empty() || members.len() > MAX_ASSERTED_CHAT_MEMBERS {
        return Err("invalid authoritative member set for action deposit".to_string());
    }
    validate_authoritative_child_context(context.confirmed_by, context.chat, &members, caller, caller_kind)
}

fn validate_encoded_deposit_payload<T: Serialize>(args: &T) -> Result<usize, String> {
    let encoded_bytes = msgpack::serialize_to_vec(args)
        .map_err(|error| format!("failed to encode action deposit relay: {error}"))?
        .len();
    if encoded_bytes > action_inbox_canister::c2c_notify_actions::MAX_DEPOSIT_BATCH_ENCODED_BYTES {
        Err(format!(
            "encoded action deposit relay is {encoded_bytes} bytes; maximum is {} bytes",
            action_inbox_canister::c2c_notify_actions::MAX_DEPOSIT_BATCH_ENCODED_BYTES
        ))
    } else {
        Ok(encoded_bytes)
    }
}

// Bound on fan-out recipients per confirm. Generous for the intended surface (both sides of a direct
// chat; small groups) while capping the per-confirm encrypt/sign work an abusive card could demand.
const MAX_DEPOSIT_RECIPIENTS: usize = user_index_canister::c2c_deposit_actions::MAX_RECIPIENT_KEY_BINDINGS;
// Group/community canisters send one item beyond the per-user fan-out cap as an overflow sentinel.
// App-level delivery has one registry key and remains available in larger chats; per-user delivery
// rejects the sentinel after resolving the exact key mode.
const MAX_ASSERTED_CHAT_MEMBERS: usize =
    local_user_index_canister::c2c_deposit_action_confirmed::MAX_ASSERTED_ACTION_CARD_MEMBERS;
const MAX_CONFIRM_PAYLOAD_BYTES: usize = 16 * 1024;

fn validate_pre_await_bounds(payload_bytes: usize, raw_member_count: usize) -> Result<(), String> {
    if payload_bytes > MAX_CONFIRM_PAYLOAD_BYTES {
        return Err(format!(
            "confirm payload is {payload_bytes} bytes; maximum is {MAX_CONFIRM_PAYLOAD_BYTES}"
        ));
    }
    // Check the raw vector before any contains/dedup loop. Even duplicate-heavy input is bounded.
    if raw_member_count > MAX_ASSERTED_CHAT_MEMBERS {
        return Err(format!(
            "too many asserted chat members; maximum is {MAX_ASSERTED_CHAT_MEMBERS}"
        ));
    }
    Ok(())
}

struct ManifestRoute {
    inbox_canister_id: CanisterId,
    recipients: Vec<ManifestRecipient>,
    external_context: user_index_canister::c2c_redeem_ai_app_card_capability::AppScopedCardContext,
}

struct ManifestRecipient {
    user_ids: Vec<types::UserId>,
    public_key: String,
    consumer_queue_selector: Vec<u8>,
}

async fn resolve_authoritative_route(args: &Args) -> Result<ManifestRoute, Response> {
    let mut member_user_ids = Vec::new();
    for user_id in args.context.member_user_ids.iter().copied() {
        if !member_user_ids.contains(&user_id) {
            member_user_ids.push(user_id);
        }
    }
    if member_user_ids.is_empty() || !member_user_ids.contains(&args.context.confirmed_by) {
        return Err(Error("authoritative member list does not contain the confirmer".to_string()));
    }
    let context = authority_context(&args.context).map_err(Error)?;
    let content_hash = args
        .context
        .content_hash
        .ok_or_else(|| Error("app-bound card has no content hash".to_string()))?;
    let confirm_payload_hash = types::ai_app_card_confirm_payload_hash_v1(args.plaintext.as_ref()).map_err(Error)?;
    let user_index_canister_id = read_state(|state| state.data.user_index_canister_id);
    let route = match user_index_canister_c2c_client::c2c_ai_app_confirmed_action_route(
        user_index_canister_id,
        &user_index_canister::c2c_ai_app_confirmed_action_route::Args {
            context,
            content_hash,
            confirm_payload_hash,
            confirmation_lease_generation: args.context.confirmation_lease_generation,
            created_at: args.created_at,
            authority: args.authority.clone(),
        },
    )
    .await
    {
        Ok(user_index_canister::c2c_ai_app_confirmed_action_route::Response::Success(result)) => result,
        Ok(user_index_canister::c2c_ai_app_confirmed_action_route::Response::AppUnavailable) => {
            return Err(Error("producing app action route is unavailable or stale".to_string()));
        }
        Ok(_) => return Err(Error("confirmed action authority is invalid or stale".to_string())),
        Err(_) => return Err(Error("confirmed action route is unavailable".to_string())),
    };
    authoritative_manifest_route(route, args.context.confirmed_by).map_err(Error)
}

fn authoritative_manifest_route(
    route: user_index_canister::c2c_ai_app_confirmed_action_route::SuccessResult,
    confirmed_by: types::UserId,
) -> Result<ManifestRoute, String> {
    if route.consumer_queue_selector_version != 1 || route.consumer_queue_selector.len() != 32 {
        return Err("producing app route has an invalid consumer queue selector".to_string());
    }
    let selector = route.consumer_queue_selector.to_vec();
    let supplied_keys: Vec<(Option<types::UserId>, String, Vec<u8>)> = if route.per_user_keys {
        let key = route
            .confirmer_key
            .filter(|key| key.user_id == confirmed_by)
            .ok_or_else(|| "confirmer has no registered key for the producing app".to_string())?;
        vec![(Some(key.user_id), key.public_key, selector)]
    } else {
        vec![(
            None,
            route
                .consumer_public_key
                .clone()
                .filter(|key| !key.is_empty())
                .ok_or_else(|| "producing app action route has no delivery key".to_string())?,
            selector,
        )]
    };
    let mut recipients: Vec<ManifestRecipient> = Vec::new();
    for (user_id, public_key, consumer_queue_selector) in supplied_keys {
        if public_key.is_empty() {
            continue;
        }
        if let Some(existing) = recipients.iter_mut().find(|recipient| recipient.public_key == public_key) {
            if existing.consumer_queue_selector != consumer_queue_selector {
                return Err("one recipient key was paired with conflicting queue selectors".to_string());
            }
            if let Some(user_id) = user_id
                && !existing.user_ids.contains(&user_id)
            {
                existing.user_ids.push(user_id);
            }
        } else {
            recipients.push(ManifestRecipient {
                user_ids: user_id.into_iter().collect(),
                public_key,
                consumer_queue_selector,
            });
        }
    }
    if recipients.is_empty() {
        return Err("producing app has no delivery key".to_string());
    }
    if recipients.len() > MAX_DEPOSIT_RECIPIENTS {
        return Err(format!("too many recipients; maximum is {MAX_DEPOSIT_RECIPIENTS}"));
    }
    Ok(ManifestRoute {
        inbox_canister_id: route.inbox_canister_id,
        recipients,
        external_context: route.external_context,
    })
}

// Kept sync so the rng + signing key are touched without holding canister state across the await.
fn prepare(
    args: Args,
    authoritative_route: ManifestRoute,
    state: &mut RuntimeState,
) -> Result<
    (
        Vec<user_index_canister::c2c_deposit_actions::UnsignedActionDeposit>,
        Vec<user_index_canister::c2c_deposit_actions::RecipientKeyBinding>,
        String,
    ),
    Response,
> {
    let ManifestRoute {
        inbox_canister_id: target,
        recipients: supplied_recipients,
        external_context,
    } = authoritative_route;
    // This local destination is only diagnostic. UserIndex independently resolves the exact current
    // published app revision and chooses the authoritative destination at relay time.
    let (app_id, app_revision) = verified_app_binding(&args.context).map_err(Error)?;
    if external_context.app_id != app_id
        || external_context.app_revision != app_revision
        || external_context.action_id != args.context.action_id
    {
        return Err(Error(
            "app-scoped action context does not match the verified card".to_string(),
        ));
    }
    let content_hash = args
        .context
        .content_hash
        .ok_or_else(|| Error("verified card has no content hash".to_string()))?;
    let confirmation_lease_generation = args.context.confirmation_lease_generation;
    // Recipients come only from the vouched action/manifest or guarded per-member key lookup. Reject
    // an empty/oversized set so two-phase confirmation leaves the card retryable rather than dropping.
    let mut recipients: Vec<ManifestRecipient> = Vec::new();
    for recipient in supplied_recipients {
        if !recipient.public_key.is_empty()
            && recipient.consumer_queue_selector.len() == 32
            && !recipients.iter().any(|existing| {
                existing.public_key == recipient.public_key
                    && existing.consumer_queue_selector == recipient.consumer_queue_selector
            })
        {
            recipients.push(recipient);
        }
    }
    if recipients.is_empty() {
        return Err(Error("no recipient public key supplied".to_string()));
    }
    if recipients.len() > MAX_DEPOSIT_RECIPIENTS {
        return Err(Error(format!("too many recipients; maximum is {MAX_DEPOSIT_RECIPIENTS}")));
    }

    // Deterministic dedupe key: the STABLE identity of the confirmed card (chat + message id), NOT the
    // confirm payload. The short of it is that a user
    // retry, the platform's automatic c2c retry, AND a concurrent distinct-payload confirm all dedupe to
    // a single deposit per recipient fingerprint bucket.
    let idempotency_key = card_identity_digest(
        &args.context.chat,
        args.context.thread_root_message_index,
        args.context.message_id,
        &args.context.member_user_ids,
    )
    .map_err(Error)?;
    let payload_hash = types::ai_app_card_confirm_payload_hash_v1(args.plaintext.as_ref()).map_err(Error)?;
    let mut batch_rng = crate::pr2_entropy::output_rng(state, ACTION_ENVELOPE_ENTROPY_PURPOSE)
        .map_err(|_| Error("action envelope entropy unavailable".to_string()))?;

    let mut deposits = Vec::with_capacity(recipients.len());
    let mut recipient_key_bindings = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        // A malformed key among the recipients fails the WHOLE batch (atomic with two-phase confirm:
        // the card stays Pending and the user can retry) rather than silently dropping one member.
        let fingerprint = recipient.consumer_queue_selector;
        let mut acknowledgement_secret = [0u8; action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_BYTES];
        batch_rng.fill_bytes(&mut acknowledgement_secret);
        let encoded_acknowledgement_secret =
            Base64UrlSafeNoPadding::encode_to_string(acknowledgement_secret).map_err(|error| Error(error.to_string()))?;
        // Context + action payload are identical across recipients, but each encrypted envelope gets
        // an independent bearer secret so compromising one recipient cannot acknowledge another.
        let plaintext = action_deposit_envelope::wrap_plaintext(
            &external_context,
            &content_hash,
            confirmation_lease_generation,
            args.created_at,
            args.plaintext.as_ref(),
            &encoded_acknowledgement_secret,
        )
        .map_err(Error)?;
        let envelope = ecies_payload::encrypt(&plaintext, &recipient.public_key, &mut batch_rng).map_err(Error)?;
        deposits.push(user_index_canister::c2c_deposit_actions::UnsignedActionDeposit {
            idempotency_key: ByteBuf::from(idempotency_key.to_vec()),
            payload_hash: ByteBuf::from(payload_hash.to_vec()),
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            acknowledgement_secret_hash: ByteBuf::from(
                action_inbox_canister::acknowledge_actions::acknowledgement_secret_hash(
                    target,
                    &fingerprint,
                    &acknowledgement_secret,
                )
                .to_vec(),
            ),
            ephemeral_public_key: ByteBuf::from(envelope.ephemeral_public_key),
            ciphertext: ByteBuf::from(envelope.ciphertext),
            created_at: args.created_at,
        });
        recipient_key_bindings.push(user_index_canister::c2c_deposit_actions::RecipientKeyBinding {
            user_ids: recipient.user_ids,
            key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
        });
    }

    Ok((deposits, recipient_key_bindings, args.context.action_id))
}

// Versioned full-width identity for one logical card: canonical chat, optional thread root and
// message id. It deliberately excludes ciphertext because retries re-encrypt with fresh randomness.
// ActionInbox uses this full digest as its primary tombstone key and stores the exact payload hash,
// so an exact retry dedupes while a changed payload fails closed.
//
// The NUL after `chat_key` and the explicit none/some thread marker keep every field unambiguous.
const ACTION_CARD_IDENTITY_DOMAIN_V3: &[u8] = b"openchat/action-inbox/card-identity/v3\0";

fn card_identity_digest(
    chat: &types::Chat,
    thread_root_message_index: Option<types::MessageIndex>,
    message_id: types::MessageId,
    member_user_ids: &[types::UserId],
) -> Result<[u8; 32], String> {
    let mut dedupe_input = ACTION_CARD_IDENTITY_DOMAIN_V3.to_vec();
    dedupe_input.extend_from_slice(action_deposit_envelope::chat_key(chat, member_user_ids)?.as_bytes());
    dedupe_input.push(0);
    match thread_root_message_index {
        None => dedupe_input.push(0),
        Some(index) => {
            dedupe_input.push(1);
            dedupe_input.extend_from_slice(&u32::from(index).to_be_bytes());
        }
    }
    dedupe_input.extend_from_slice(&message_id.as_u64().to_be_bytes());
    Ok(sha256::sha256(&dedupe_input))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_ASSERTED_CHAT_MEMBERS, MAX_CONFIRM_PAYLOAD_BYTES, ManifestRecipient, ManifestRoute, authoritative_manifest_route,
        card_identity_digest, prepare, validate_encoded_deposit_payload, validate_pre_await_bounds, verified_app_binding,
        verify_chat_caller_and_members,
    };
    use crate::updates::c2c_create_ai_app_card_capability::AuthoritativeChildKind;
    use crate::{Data, RuntimeState};
    use action_inbox_canister::c2c_notify_actions::MAX_DEPOSIT_BATCH_ENCODED_BYTES;
    use candid::Principal;
    use local_user_index_canister::c2c_deposit_action_confirmed::{ActionDepositContext, Args as DepositArgs};
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use serde_bytes::ByteBuf;
    use types::{AiAppCardContext, AiAppMemberKey, ChannelId, Chat, MessageId, MessageIndex, UserId};
    use user_index_canister::c2c_deposit_actions::{Args as RelayArgs, UnsignedActionDeposit};
    use utils::env::test::TestEnv;

    fn group_chat() -> Chat {
        Chat::Group(Principal::from_slice(&[1, 2, 3]).into())
    }

    fn verified_context(chat: Chat) -> ActionDepositContext {
        let confirmed_by = UserId::from(Principal::from_slice(&[4, 5, 6]));
        ActionDepositContext {
            chat,
            message_id: MessageId::from(1u64),
            thread_root_message_index: None,
            confirmed_by,
            app_id: Some(7),
            app_revision: Some(11),
            app_verified: true,
            content_hash: Some([1; 32]),
            confirmation_lease_generation: 1,
            action_id: "sample.action".to_string(),
            member_user_ids: vec![confirmed_by],
        }
    }

    #[test]
    fn deposit_context_requires_server_verified_app_binding() {
        let mut context = verified_context(group_chat());
        assert_eq!(verified_app_binding(&context), Ok((7, 11)));

        context.app_verified = false;
        assert!(verified_app_binding(&context).is_err());

        context.app_verified = true;
        context.app_revision = None;
        assert!(verified_app_binding(&context).is_err());
    }

    #[test]
    fn direct_app_card_delivery_is_explicitly_out_of_scope() {
        let peer = UserId::from(Principal::from_slice(&[9]));
        assert!(verified_app_binding(&verified_context(Chat::Direct(peer.into()))).is_err());
    }

    fn unsigned_deposit(id: u64) -> UnsignedActionDeposit {
        let mut identity = [6u8; 32];
        identity[24..].copy_from_slice(&id.to_be_bytes());
        UnsignedActionDeposit {
            idempotency_key: ByteBuf::from(identity.to_vec()),
            payload_hash: ByteBuf::from(vec![7; 32]),
            consumer_key_fingerprint: ByteBuf::from(vec![1; 32]),
            acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
            ephemeral_public_key: ByteBuf::from(vec![2; 65]),
            ciphertext: ByteBuf::from(vec![3; 128 * 1024]),
            created_at: u64::MAX,
        }
    }

    fn relay_args(deposits: Vec<UnsignedActionDeposit>) -> RelayArgs {
        let confirmed_by = UserId::from(Principal::from_slice(&[1]));
        let group = Principal::from_slice(&[2]);
        RelayArgs {
            authority_context: AiAppCardContext {
                user_id: confirmed_by,
                chat: Chat::Group(group.into()),
                chat_key: format!("group:{group}"),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
                app_id: u32::MAX,
                app_revision: u64::MAX,
                action_id: "sample.action".to_string(),
            },
            content_hash: [8; 32],
            confirmation_lease_generation: 1,
            authority: ByteBuf::from(vec![9; 32]),
            confirmed_by,
            app_id: u32::MAX,
            app_revision: u64::MAX,
            action_id: "sample.action".to_string(),
            recipient_key_bindings: Vec::new(),
            deposits,
        }
    }

    #[test]
    fn local_relay_rejects_aggregate_bytes_before_the_outbound_await() {
        let oversized = relay_args((0..8).map(unsigned_deposit).collect());
        assert!(validate_encoded_deposit_payload(&oversized).is_err());

        let adjacent = relay_args((0..7).map(unsigned_deposit).collect());
        let encoded = validate_encoded_deposit_payload(&adjacent).unwrap();
        assert!(encoded < MAX_DEPOSIT_BATCH_ENCODED_BYTES);
    }

    // The regression guard for the deposit-before-commit TOCTOU: the id is a function of the card
    // identity ALONE (the signature carries no payload), so two confirms of the SAME card that carry
    // DIFFERENT `confirm_payload_override`s derive the SAME idempotency id and dedupe in the inbox.
    #[test]
    fn same_card_yields_same_id() {
        let a = card_identity_digest(&group_chat(), None, MessageId::from(42u64), &[]).unwrap();
        let b = card_identity_digest(&group_chat(), None, MessageId::from(42u64), &[]).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_message_id_yields_different_id() {
        let a = card_identity_digest(&group_chat(), None, MessageId::from(1u64), &[]).unwrap();
        let b = card_identity_digest(&group_chat(), None, MessageId::from(2u64), &[]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn main_timeline_and_distinct_thread_roots_have_distinct_full_identities() {
        let message_id = MessageId::from(42u64);
        let main = card_identity_digest(&group_chat(), None, message_id, &[]).unwrap();
        let thread_a = card_identity_digest(&group_chat(), Some(MessageIndex::from(7u32)), message_id, &[]).unwrap();
        let thread_b = card_identity_digest(&group_chat(), Some(MessageIndex::from(8u32)), message_id, &[]).unwrap();
        let retry = card_identity_digest(&group_chat(), Some(MessageIndex::from(7u32)), message_id, &[]).unwrap();

        assert_ne!(main, thread_a);
        assert_ne!(main, thread_b);
        assert_ne!(thread_a, thread_b);
        assert_eq!(thread_a, retry);
    }

    // Same underlying principal + message id but a different chat KIND must not collide — the chat_key
    // prefix ("group:" vs "direct:") separates them, so distinct cards never share an inbox dedupe key.
    #[test]
    fn different_chat_kinds_yield_different_ids() {
        let shared = UserId::from(Principal::from_slice(&[9, 9, 9]));
        let other = UserId::from(Principal::from_slice(&[8, 8, 8]));
        let shared_principal = Principal::from(shared);
        let message_id = MessageId::from(7u64);
        let group = card_identity_digest(&Chat::Group(shared_principal.into()), None, message_id, &[]).unwrap();
        let direct = card_identity_digest(&Chat::Direct(shared.into()), None, message_id, &[other, shared]).unwrap();
        let channel = card_identity_digest(
            &Chat::Channel(shared_principal.into(), ChannelId::from(7u32)),
            None,
            message_id,
            &[],
        )
        .unwrap();
        assert_ne!(group, direct);
        assert_ne!(group, channel);
        assert_ne!(direct, channel);
    }

    // A direct chat is stored from each participant's perspective: Alice's user canister calls it
    // `Direct(Bob)`, while Bob's calls it `Direct(Alice)`. Both copies are the same logical card and
    // must therefore share the inbox idempotency id.
    #[test]
    fn direct_chat_participant_perspectives_yield_same_id() {
        let alice = UserId::from(Principal::from_slice(&[1, 1, 1]));
        let bob = UserId::from(Principal::from_slice(&[2, 2, 2]));

        let alice_view = card_identity_digest(&Chat::Direct(bob.into()), None, MessageId::from(7u64), &[alice, bob]).unwrap();
        let bob_view = card_identity_digest(&Chat::Direct(alice.into()), None, MessageId::from(7u64), &[bob, alice]).unwrap();

        assert_eq!(alice_view, bob_view);
    }

    #[test]
    fn distinct_direct_participant_pairs_yield_different_ids() {
        let alice = UserId::from(Principal::from_slice(&[1, 1, 1]));
        let bob = UserId::from(Principal::from_slice(&[2, 2, 2]));
        let carol = UserId::from(Principal::from_slice(&[3, 3, 3]));
        let message_id = MessageId::from(7u64);

        let alice_bob = card_identity_digest(&Chat::Direct(bob.into()), None, message_id, &[alice, bob]).unwrap();
        let alice_carol = card_identity_digest(&Chat::Direct(carol.into()), None, message_id, &[alice, carol]).unwrap();

        assert_ne!(alice_bob, alice_carol);
    }

    #[test]
    fn distinct_direct_message_ids_yield_different_ids() {
        let alice = UserId::from(Principal::from_slice(&[1, 1, 1]));
        let bob = UserId::from(Principal::from_slice(&[2, 2, 2]));
        let chat = Chat::Direct(bob.into());

        let first = card_identity_digest(&chat, None, MessageId::from(7u64), &[alice, bob]).unwrap();
        let second = card_identity_digest(&chat, None, MessageId::from(8u64), &[bob, alice]).unwrap();

        assert_ne!(first, second);
    }

    #[test]
    fn malformed_direct_member_sets_are_rejected() {
        let alice = UserId::from(Principal::from_slice(&[1, 1, 1]));
        let bob = UserId::from(Principal::from_slice(&[2, 2, 2]));
        let mallory = UserId::from(Principal::from_slice(&[3, 3, 3]));

        assert!(card_identity_digest(&Chat::Direct(bob.into()), None, MessageId::from(7u64), &[alice]).is_err());
        assert!(card_identity_digest(&Chat::Direct(bob.into()), None, MessageId::from(7u64), &[alice, alice]).is_err());
        assert!(card_identity_digest(&Chat::Direct(bob.into()), None, MessageId::from(7u64), &[alice, bob, mallory],).is_err());
        assert!(card_identity_digest(&Chat::Direct(mallory.into()), None, MessageId::from(7u64), &[alice, bob]).is_err());
    }

    #[test]
    fn full_digest_is_the_only_idempotency_identity() {
        let digest = card_identity_digest(&group_chat(), None, MessageId::from(42u64), &[]).unwrap();
        assert_eq!(digest.len(), 32);
        assert_ne!(digest, [0; 32]);
    }

    fn route(per_user_keys: bool, confirmer: UserId) -> user_index_canister::c2c_ai_app_confirmed_action_route::SuccessResult {
        user_index_canister::c2c_ai_app_confirmed_action_route::SuccessResult {
            inbox_canister_id: Principal::from_slice(&[9]).into(),
            consumer_queue_selector: ByteBuf::from(vec![4; 32]),
            consumer_queue_selector_version: 1,
            per_user_keys,
            consumer_public_key: (!per_user_keys).then(|| "ACTION_KEY".to_string()),
            confirmer_key: per_user_keys.then(|| AiAppMemberKey {
                user_id: confirmer,
                public_key: "MEMBER_KEY".to_string(),
            }),
            external_context: user_index_canister::c2c_redeem_ai_app_card_capability::AppScopedCardContext {
                context_version: user_index_canister::c2c_redeem_ai_app_card_capability::APP_SCOPED_CARD_CONTEXT_VERSION_V1,
                app_subject: ByteBuf::from(vec![1; 32]),
                chat_handle: ByteBuf::from(vec![2; 32]),
                message_handle: ByteBuf::from(vec![3; 32]),
                app_id: 7,
                app_revision: 11,
                action_id: "sample.action".to_string(),
            },
        }
    }

    #[test]
    fn published_app_route_ignores_card_supplied_routing() {
        let confirmer: UserId = Principal::from_slice(&[20]).into();
        let route = authoritative_manifest_route(route(false, confirmer), confirmer).unwrap();
        assert_eq!(route.recipients.len(), 1);
        assert_eq!(route.recipients[0].public_key, "ACTION_KEY");
        assert_eq!(route.recipients[0].consumer_queue_selector, vec![4; 32]);
        assert!(route.recipients[0].user_ids.is_empty());
        assert_eq!(route.inbox_canister_id, Principal::from_slice(&[9]).into());
        assert_eq!(route.external_context.app_subject.as_ref(), &[1; 32]);
    }

    #[test]
    fn per_user_route_delivers_only_to_the_confirmers_private_account() {
        let member_b: UserId = Principal::from_slice(&[22]).into();
        let prepared_route = authoritative_manifest_route(route(true, member_b), member_b).unwrap();
        assert_eq!(prepared_route.recipients.len(), 1);
        assert_eq!(prepared_route.recipients[0].public_key, "MEMBER_KEY");
        assert_eq!(prepared_route.recipients[0].user_ids, vec![member_b]);
        let mut missing = route(true, member_b);
        missing.confirmer_key = None;
        assert!(authoritative_manifest_route(missing, member_b).is_err());
    }

    #[test]
    fn local_child_cannot_spoof_a_different_group_or_channel_context() {
        let context = verified_context(group_chat());
        assert!(verify_chat_caller_and_members(&context, context.chat.canister_id(), AuthoritativeChildKind::Group,).is_ok());
        assert!(
            verify_chat_caller_and_members(&context, Principal::from_slice(&[99]), AuthoritativeChildKind::Group,).is_err()
        );
        assert!(verify_chat_caller_and_members(&context, context.chat.canister_id(), AuthoritativeChildKind::User,).is_err());

        let mut missing_confirmer = context.clone();
        missing_confirmer.member_user_ids = vec![Principal::from_slice(&[77]).into()];
        assert!(
            verify_chat_caller_and_members(
                &missing_confirmer,
                missing_confirmer.chat.canister_id(),
                AuthoritativeChildKind::Group,
            )
            .is_err()
        );
    }

    #[test]
    fn payload_and_raw_member_bounds_are_enforced_before_awaits() {
        assert!(validate_pre_await_bounds(MAX_CONFIRM_PAYLOAD_BYTES, MAX_ASSERTED_CHAT_MEMBERS).is_ok());
        assert!(validate_pre_await_bounds(MAX_CONFIRM_PAYLOAD_BYTES + 1, 1).is_err());
        assert!(validate_pre_await_bounds(1, MAX_ASSERTED_CHAT_MEMBERS + 1).is_err());
    }

    #[test]
    fn restored_lui_snapshot_blocks_then_reseeds_unique_envelope_material() {
        let confirmed_by = UserId::from(Principal::from_slice(&[4, 5, 6]));
        let inbox = Principal::from_slice(&[9]);
        let mut recipient_rng = StdRng::seed_from_u64(0x51);
        let recipient_key_pair = P256KeyPair::new(&mut recipient_rng);
        let recipient_public_key = recipient_key_pair.public_key_pem().to_string();
        let data = || {
            Data::new(
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                inbox,
                1,
                Vec::new(),
                recipient_key_pair.secret_key_der().to_vec(),
                None,
                true,
            )
        };
        let args = |message_id: u64, plaintext: &'static [u8]| DepositArgs {
            consumer_public_key_pem: String::new(),
            consumer_public_key_pems: Vec::new(),
            plaintext: ByteBuf::from(plaintext.to_vec()),
            created_at: 10_000,
            inbox_canister_id: None,
            context: ActionDepositContext {
                chat: group_chat(),
                message_id: MessageId::from(message_id),
                thread_root_message_index: None,
                confirmed_by,
                app_id: Some(7),
                app_revision: Some(11),
                app_verified: true,
                content_hash: Some([1; 32]),
                confirmation_lease_generation: 1,
                action_id: "sample.action".to_string(),
                member_user_ids: vec![confirmed_by],
            },
            authority: ByteBuf::from(vec![7; 32]),
        };
        let route = || ManifestRoute {
            inbox_canister_id: inbox,
            recipients: vec![ManifestRecipient {
                user_ids: vec![confirmed_by],
                public_key: recipient_public_key.clone(),
                consumer_queue_selector: vec![4; 32],
            }],
            external_context: user_index_canister::c2c_redeem_ai_app_card_capability::AppScopedCardContext {
                context_version: user_index_canister::c2c_redeem_ai_app_card_capability::APP_SCOPED_CARD_CONTEXT_VERSION_V1,
                app_subject: ByteBuf::from(vec![1; 32]),
                chat_handle: ByteBuf::from(vec![2; 32]),
                message_handle: ByteBuf::from(vec![3; 32]),
                app_id: 7,
                app_revision: 11,
                action_id: "sample.action".to_string(),
            },
        };

        let reseed_current_lifecycle = |state: &mut RuntimeState, raw_rand: [u8; 32]| {
            let now = state.env.now();
            let canister_id = state.env.canister_id();
            let types::Pr2EntropyReseedAdmission::Started(ticket) = state.data.pr2_entropy.begin_reseed(now) else {
                panic!("entropy reseed must start")
            };
            let commitment_mode = types::Pr2EntropyCommitmentMode::from_test_mode(state.data.test_mode);
            assert!(
                state
                    .data
                    .pr2_entropy
                    .finish_reseed(ticket, canister_id, commitment_mode, &raw_rand, now)
            );
        };

        let mut before_restore = RuntimeState::new(Box::new(TestEnv::default()), data());
        crate::pr2_entropy::advance_lifecycle(&mut before_restore, 12).unwrap();
        reseed_current_lifecycle(&mut before_restore, [12; 32]);
        let snapshot = msgpack::serialize_to_vec(&before_restore.data.pr2_entropy).unwrap();
        let first = prepare(args(1, br#"{"record":1}"#), route(), &mut before_restore)
            .unwrap()
            .0
            .remove(0);

        let mut after_restore = RuntimeState::new(Box::new(TestEnv::default()), data());
        after_restore.data.pr2_entropy = msgpack::deserialize(&snapshot[..]).unwrap();
        crate::pr2_entropy::advance_lifecycle(&mut after_restore, 13).unwrap();
        assert!(matches!(
            prepare(args(2, br#"{"record":2}"#), route(), &mut after_restore),
            Err(local_user_index_canister::c2c_deposit_action_confirmed::Response::Error(message))
                if message == "action envelope entropy unavailable"
        ));

        reseed_current_lifecycle(&mut after_restore, [13; 32]);
        let second = prepare(args(2, br#"{"record":2}"#), route(), &mut after_restore)
            .unwrap()
            .0
            .remove(0);
        let third = prepare(args(3, br#"{"record":3}"#), route(), &mut after_restore)
            .unwrap()
            .0
            .remove(0);

        assert_ne!(
            first.idempotency_key, second.idempotency_key,
            "fixture records must be distinct"
        );
        assert_ne!(
            first.ephemeral_public_key, second.ephemeral_public_key,
            "restoring an RNG snapshot must not repeat the ECIES ephemeral key"
        );
        assert_ne!(
            first.acknowledgement_secret_hash, second.acknowledgement_secret_hash,
            "restoring an RNG snapshot must not repeat acknowledgement authority"
        );
        assert_ne!(second.ephemeral_public_key, third.ephemeral_public_key);
        assert_ne!(second.acknowledgement_secret_hash, third.acknowledgement_secret_hash);
        assert_eq!(first.consumer_key_fingerprint.as_ref(), &[4; 32]);
        assert_eq!(second.consumer_key_fingerprint.as_ref(), &[4; 32]);
        assert_eq!(third.consumer_key_fingerprint.as_ref(), &[4; 32]);
    }

    #[test]
    fn app_level_route_requires_an_exact_vouched_delivery_key() {
        let confirmer: UserId = Principal::from_slice(&[20]).into();
        let mut route = route(false, confirmer);
        route.consumer_public_key = None;
        assert!(authoritative_manifest_route(route, confirmer).is_err());
    }
}
