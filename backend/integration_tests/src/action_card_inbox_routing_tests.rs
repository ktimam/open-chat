use crate::TestEnv;
use crate::client;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{
    card_content_fixture, confirm_raw, fetch_actions, inbox_deposit_fixture, link_key, new_recipient, post_card,
    publish_per_user_app, register_per_user_app, setup,
};
use crate::utils::tick_many;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;
use types::{AiAppRegistration, Chat, MessageId};

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
    let mut rng = StdRng::seed_from_u64(7_901);
    let recipient = new_recipient(&mut rng);
    let selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        recipient.pk_pem.clone(),
    );
    let message_id = post_card(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.group_id,
        &fixture.app,
        None,
        vec![],
        None,
    );

    let mut changed_manifest = fixture.app.manifest.clone();
    changed_manifest.description.push_str(" (new revision)");
    let updated: user_index_canister::register_ai_app::Response = client::execute_msgpack_update(
        env,
        fixture.user_a.principal,
        canister_ids.user_index,
        "register_ai_app_msgpack",
        &user_index_canister::register_ai_app::Args {
            manifest: changed_manifest,
        },
    );
    let user_index_canister::register_ai_app::Response::Success(updated) = updated else {
        panic!("owner must be able to create the newer app revision: {updated:?}")
    };
    assert_eq!(updated.id, fixture.app.id);
    assert!(updated.updated > fixture.app.updated);
    assert!(!updated.published, "a changed manifest must require fresh verification");

    let response = confirm_raw(env, &fixture.user_a, fixture.group_id, message_id);
    assert!(
        matches!(response, group_canister::respond_to_action_card::Response::Error(_)),
        "a card bound to the stale revision must fail before dispatch: {response:?}"
    );
    tick_many(env, 10);
    assert!(fetch_actions(env, fixture.user_a.principal, fixture.inbox, &selector).is_empty());
}

// Routing is part of the published app contract. Neither a card-carried canister id nor the LUI's
// legacy global setting may supply a missing manifest inbox, otherwise an untrusted card author can
// redirect encrypted confirmations to a canister of their choosing.
#[test]
fn missing_manifest_inbox_rejects_provenance_before_card_or_global_routing() {
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

    let selector_a = [93u8; 32];
    let selector_b = [94u8; 32];

    let message_id = MessageId::from(8_001u64);
    let provenance: user_index_canister::create_ai_app_card_provenance::Response = client::execute_msgpack_update(
        env,
        fixture.user_a.principal,
        canister_ids.user_index,
        "create_ai_app_card_provenance_msgpack",
        &user_index_canister::create_ai_app_card_provenance::Args {
            app_id: app.id,
            app_revision: app.updated,
            action_id: app.manifest.actions[0].name.clone(),
            content: card_content_fixture(),
            chat: Chat::Group(fixture.group_id),
            thread_root_message_index: None,
            message_id,
        },
    );
    assert!(
        matches!(
            provenance,
            user_index_canister::create_ai_app_card_provenance::Response::AppUnavailable
        ),
        "an app without a manifest inbox must fail before a routable card can enter chat: {provenance:?}"
    );
    assert!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &selector_a).is_empty(),
        "the card-carried/global fallback must not receive a deposit"
    );
    assert!(
        fetch_actions(env, fixture.user_b.principal, fixture.inbox, &selector_b).is_empty(),
        "the card-carried/global fallback must not receive a confirmed-action delivery"
    );
}
