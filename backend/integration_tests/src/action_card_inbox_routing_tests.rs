use crate::TestEnv;
use crate::client;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{
    confirm_raw, fetch_actions, inbox_deposit_fixture, new_recipient, post_card, publish_per_user_app, register_per_user_app,
    set_key, setup,
};
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde_bytes::ByteBuf;
use std::ops::Deref;
use types::{ActionCardResponse, AiAppCardContext, AiAppRegistration, Chat, MessageId};

fn card_identity(chat_key: &str, thread_root_message_index: Option<u32>, message_id: u64) -> [u8; 32] {
    const DOMAIN: &[u8] = b"openchat/action-inbox/card-identity/v3\0";
    let mut canonical = Vec::with_capacity(DOMAIN.len() + chat_key.len() + 1 + 5 + 8);
    canonical.extend_from_slice(DOMAIN);
    canonical.extend_from_slice(chat_key.as_bytes());
    canonical.push(0);
    match thread_root_message_index {
        None => canonical.push(0),
        Some(index) => {
            canonical.push(1);
            canonical.extend_from_slice(&index.to_be_bytes());
        }
    }
    canonical.extend_from_slice(&message_id.to_be_bytes());
    sha256::sha256(&canonical)
}

#[test]
fn publication_and_inbox_both_reject_a_cross_app_namespace() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);

    let other = register_per_user_app(
        env,
        canister_ids.user_index,
        *controller,
        &fixture.user_b,
        Some(fixture.inbox),
    );
    let publication: user_index_canister::publish_ai_app::Response = client::execute_msgpack_update(
        env,
        fixture.user_b.principal,
        canister_ids.user_index,
        "publish_ai_app_msgpack",
        &user_index_canister::publish_ai_app::Args { app_id: other.id },
    );
    assert!(
        matches!(publication, user_index_canister::publish_ai_app::Response::NotVerified),
        "an inbox bound to app A must not vouch for app B: {publication:?}"
    );

    let fingerprint = [91u8; 32];
    let response: action_inbox_canister::c2c_notify_actions::Response = client::execute_msgpack_update(
        env,
        canister_ids.user_index,
        fixture.inbox,
        "c2c_notify_actions_msgpack",
        &action_inbox_canister::c2c_notify_actions::Args {
            app_id: other.id,
            deposits: vec![inbox_deposit_fixture(fingerprint, [6; 32], [7; 32], 1)],
        },
    );
    assert!(
        matches!(response, action_inbox_canister::c2c_notify_actions::Response::Error(_)),
        "even the authorized relay cannot cross the configured app namespace: {response:?}"
    );
    assert!(fetch_actions(env, fixture.user_a.principal, fixture.inbox, &fingerprint).is_empty());
}

#[test]
fn user_index_rejects_a_stale_revision_before_using_relay_authority() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let fingerprint = [92u8; 32];
    let stale_revision = fixture.app.updated.saturating_sub(1);
    let group_chat = Chat::Group(fixture.group_id.into());
    let chat_key = format!("group:{}", fixture.group_id);
    let message_id = MessageId::from(1u64);
    let response: user_index_canister::c2c_deposit_actions::Response = client::execute_msgpack_update(
        env,
        fixture.group_lui,
        canister_ids.user_index,
        "c2c_deposit_actions_msgpack",
        &user_index_canister::c2c_deposit_actions::Args {
            authority_context: AiAppCardContext {
                user_id: fixture.user_a.user_id,
                chat: group_chat,
                chat_key: chat_key.clone(),
                thread_root_message_index: None,
                message_id,
                app_id: fixture.app.id,
                app_revision: stale_revision,
                action_id: fixture.app.manifest.actions[0].name.clone(),
            },
            content_hash: [3; 32],
            confirmation_lease_generation: 1,
            authority: ByteBuf::from(vec![
                4;
                group_index_canister::ai_app_card_authority::AI_APP_CARD_AUTHORITY_TOKEN_BYTES
            ]),
            confirmed_by: fixture.user_a.user_id,
            app_id: fixture.app.id,
            app_revision: stale_revision,
            action_id: fixture.app.manifest.actions[0].name.clone(),
            recipient_key_bindings: vec![user_index_canister::c2c_deposit_actions::RecipientKeyBinding {
                user_ids: vec![fixture.user_a.user_id],
                key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            }],
            deposits: vec![user_index_canister::c2c_deposit_actions::UnsignedActionDeposit {
                idempotency_key: ByteBuf::from(card_identity(&chat_key, None, message_id.as_u64()).to_vec()),
                payload_hash: ByteBuf::from(vec![7; 32]),
                consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
                acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
                ephemeral_public_key: ByteBuf::from(vec![2; 65]),
                ciphertext: ByteBuf::from(vec![3]),
                created_at: 1,
            }],
        },
    );
    assert!(
        matches!(response, user_index_canister::c2c_deposit_actions::Response::Error(_)),
        "a stale revision must fail at UserIndex before dispatch: {response:?}"
    );
    assert!(fetch_actions(env, fixture.user_a.principal, fixture.inbox, &fingerprint).is_empty());
}

// Routing is part of the published app contract. Neither a card-carried canister id nor the LUI's
// legacy global setting may supply a missing manifest inbox, otherwise an untrusted card author can
// redirect encrypted confirmations to a canister of their choosing.
#[test]
fn missing_manifest_inbox_does_not_fall_back_to_card_or_global_routing() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);

    let app: AiAppRegistration = publish_per_user_app(env, canister_ids.user_index, *controller, &fixture.user_a, None);
    client::group::happy_path::set_ai_app_enabled(env, fixture.user_a.principal, fixture.group_id, app.id, true);

    let configured: local_user_index_canister::set_action_inbox_canister::Response = client::execute_msgpack_update(
        env,
        fixture.user_a.principal,
        fixture.group_lui,
        "set_action_inbox_canister_msgpack",
        &local_user_index_canister::set_action_inbox_canister::Args {
            canister_id: fixture.inbox,
        },
    );
    assert!(matches!(
        configured,
        local_user_index_canister::set_action_inbox_canister::Response::Success
    ));

    let mut rng = StdRng::seed_from_u64(8_001);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);
    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        app.id,
        recipient_a.pk_pem.clone(),
    );
    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_b,
        app.id,
        recipient_b.pk_pem.clone(),
    );

    let message_id = post_card(
        env,
        &fixture.user_a,
        fixture.group_id,
        &app,
        Some(recipient_a.pk_pem.clone()),
        vec![recipient_b.pk_pem.clone()],
        Some(fixture.inbox),
    );
    let response = confirm_raw(env, &fixture.user_b, fixture.group_id, message_id);
    assert!(
        matches!(response, group_canister::respond_to_action_card::Response::Error(_)),
        "an app without a manifest inbox must fail closed: {response:?}"
    );
    assert!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_a.fingerprint).is_empty(),
        "the card-carried/global fallback must not receive a deposit"
    );
    assert!(
        fetch_actions(env, fixture.user_b.principal, fixture.inbox, &recipient_b.fingerprint).is_empty(),
        "the card-carried/global fallback must not receive a fan-out deposit"
    );

    let cancel = client::execute_msgpack_update::<_, group_canister::respond_to_action_card::Response>(
        env,
        fixture.user_b.principal,
        fixture.group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Cancel,
            confirm_payload_override: None,
            confirmation_grant: None,
        },
    );
    assert!(
        matches!(cancel, group_canister::respond_to_action_card::Response::Success(_)),
        "a failed confirm must release its reservation and leave the card cancellable: {cancel:?}"
    );
}
