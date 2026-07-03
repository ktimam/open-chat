use crate::client;
use crate::env::ENV;
use crate::utils::tick_many;
use crate::wasms;
use crate::{TestEnv, User};
use candid::Principal;
use p256_key_pair::P256KeyPair;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde_bytes::ByteBuf;
use std::ops::Deref;
use testing::rng::{random_from_u128, random_string};
use types::{ActionCardContentInitial, ActionCardResponse, ActionCardRow, CanisterId, ChatId, MessageContentInitial};

// #1: a confirmed ActionCard that declares a per-app `inbox_canister_id` must have its deposit routed
// to THAT inbox, while a card with no override falls back to the LUI's globally configured inbox.
// The deposit is opaque ciphertext keyed by the sha256 fingerprint of the recipient public key, so we
// assert by counting deposits per fingerprint in each inbox (no decryption needed).
#[test]
fn action_card_deposit_routes_to_per_app_inbox() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();

    let sender = client::register_diamond_user(env, canister_ids, *controller);
    let group_id = client::user::happy_path::create_group(env, &sender, &random_string(), true, true);
    tick_many(env, 3);

    // The LUI that forwards + deposits (the group's local_user_index) and its platform signing key.
    let group_lui = client::group::happy_path::local_user_index(env, group_id);
    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );

    // Two inboxes, both authorizing the group's LUI as a depositor.
    let per_app_inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem.clone());
    let global_inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);

    // Point the group's LUI at the GLOBAL inbox (test_mode lets any caller set it).
    let _: local_user_index_canister::set_action_inbox_canister::Response = client::execute_msgpack_update(
        env,
        sender.principal,
        group_lui,
        "set_action_inbox_canister_msgpack",
        &local_user_index_canister::set_action_inbox_canister::Args { canister_id: global_inbox },
    );

    // Two distinct recipient keys so the two deposits have distinct fingerprints.
    let mut rng = StdRng::seed_from_u64(1);
    let pem_override = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let fp_override = ecies_payload::key_fingerprint(&pem_override).unwrap();
    let pem_global = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let fp_global = ecies_payload::key_fingerprint(&pem_global).unwrap();

    // 1. Card WITH a per-app inbox override -> lands in the per-app inbox, NOT the global one.
    post_and_confirm_card(env, &sender, group_id, pem_override, Some(per_app_inbox));
    assert_eq!(
        count_actions(env, sender.principal, per_app_inbox, &fp_override),
        1,
        "override card must land in the per-app inbox"
    );
    assert_eq!(
        count_actions(env, sender.principal, global_inbox, &fp_override),
        0,
        "override card must NOT land in the global inbox"
    );

    // 2. Card WITHOUT an override -> falls back to the globally configured inbox.
    post_and_confirm_card(env, &sender, group_id, pem_global, None);
    assert_eq!(
        count_actions(env, sender.principal, global_inbox, &fp_global),
        1,
        "no-override card must fall back to the global inbox"
    );
    assert_eq!(
        count_actions(env, sender.principal, per_app_inbox, &fp_global),
        0,
        "no-override card must NOT land in the per-app inbox"
    );
}

fn install_inbox(
    env: &mut PocketIc,
    controller: Principal,
    canister_ids: &crate::CanisterIds,
    depositor_lui: CanisterId,
    oc_pem: String,
) -> CanisterId {
    let inbox = client::create_canister(env, controller);
    client::install_canister(
        env,
        controller,
        inbox,
        wasms::ACTION_INBOX.clone(),
        action_inbox_canister::init::Args {
            user_index_canister_id: canister_ids.user_index,
            cycles_dispenser_canister_id: canister_ids.cycles_dispenser,
            deployment_operators: vec![controller],
            authorized_depositors: vec![depositor_lui],
            oc_signing_public_key_pem: oc_pem,
            wasm_version: wasms::ACTION_INBOX.version,
            test_mode: true,
        },
    );
    inbox
}

fn post_and_confirm_card(
    env: &mut PocketIc,
    sender: &User,
    group_id: ChatId,
    recipient_pem: String,
    inbox_override: Option<CanisterId>,
) {
    let message_id = random_from_u128();
    let content = MessageContentInitial::ActionCard(ActionCardContentInitial {
        title: "Pay".to_string(),
        rows: vec![ActionCardRow {
            label: "Amount".to_string(),
            value: "$20".to_string(),
        }],
        confirm_label: "Confirm".to_string(),
        cancel_label: "Cancel".to_string(),
        action_id: "act-1".to_string(),
        disclosure: None,
        expires_at: None,
        recipient_public_key: Some(recipient_pem),
        confirm_payload: Some(ByteBuf::from(b"opaque".to_vec())),
        inbox_canister_id: inbox_override,
    });
    client::group::happy_path::send_message(env, sender, group_id, None, content, None, Some(message_id));

    let response: group_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        sender.principal,
        group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Confirm,
        },
    );
    assert!(
        matches!(response, group_canister::respond_to_action_card::Response::Success(_)),
        "confirm failed: {response:?}"
    );
    tick_many(env, 10);
}

fn count_actions(env: &PocketIc, sender: Principal, inbox: CanisterId, fingerprint: &[u8; 32]) -> usize {
    let response = client::action_inbox::actions(
        env,
        sender,
        inbox,
        &action_inbox_canister::actions::Args {
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            since_id: 0,
            max_results: 100,
        },
    );
    match response {
        action_inbox_canister::actions::Response::Success(result) => result.actions.len(),
    }
}
