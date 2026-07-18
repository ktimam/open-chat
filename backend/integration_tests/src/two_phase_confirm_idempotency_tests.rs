use crate::client;
use crate::env::ENV;
use crate::utils::{generate_seed, now_millis, tick_many};
use crate::wasms;
use crate::{TestEnv, User};
use candid::Principal;
use oc_error_codes::OCErrorCode;
use p256_key_pair::P256KeyPair;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde_bytes::ByteBuf;
use std::ops::Deref;
use testing::rng::{random_from_u128, random_string};
use types::{ActionCardContentInitial, ActionCardResponse, ActionCardRow, CanisterId, ChatId, MessageContentInitial, MessageId};

// When NEITHER a per-card inbox override NOR the LUI's global inbox is configured, a routing-bearing
// confirm must FAIL (the deposit has nowhere to go) and leave the card Pending — so once an inbox is
// configured a retry of the SAME card succeeds. A fresh env guarantees the LUI starts unconfigured
// (the global inbox setting is canister-wide and would otherwise leak in from a pooled env).
#[test]
fn misconfigured_confirm_leaves_card_pending_then_succeeds() {
    let seed = generate_seed();
    let mut wrapper = ENV.deref().get_with_seed(seed);
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user = client::register_diamond_user(env, canister_ids, *controller);
    let group_id = client::user::happy_path::create_group(env, &user, &random_string(), true, true);
    tick_many(env, 3);
    let group_lui = client::group::happy_path::local_user_index(env, group_id);

    let mut rng = StdRng::seed_from_u64(9_001);
    let recipient_pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let fingerprint = ecies_payload::key_fingerprint(&recipient_pem).unwrap();

    // Post a routing-bearing card with NO per-card override; the global inbox is also unset.
    let message_id = post_card(env, &user, group_id, recipient_pem.clone(), None);

    // First confirm: nowhere to deposit -> C2C error mentioning NotConfigured; card stays Pending.
    let misconfigured = confirm(env, &user, group_id, message_id);
    match misconfigured {
        group_canister::respond_to_action_card::Response::Error(e) => {
            assert!(e.matches_code(OCErrorCode::C2CError), "expected C2CError, got {e:?}");
            assert!(
                format!("{e:?}").contains("NotConfigured"),
                "error should mention NotConfigured, got {e:?}"
            );
        }
        other => panic!("expected Error(C2CError/NotConfigured), got {other:?}"),
    }

    // Configure a global inbox on the LUI, then retry the SAME card.
    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);
    let _: local_user_index_canister::set_action_inbox_canister::Response = client::execute_msgpack_update(
        env,
        user.principal,
        group_lui,
        "set_action_inbox_canister_msgpack",
        &local_user_index_canister::set_action_inbox_canister::Args { canister_id: inbox },
    );

    // The retry succeeds — which is only possible because the first (failed) confirm left the card
    // Pending rather than committing it Confirmed.
    let retried = confirm(env, &user, group_id, message_id);
    assert!(
        matches!(retried, group_canister::respond_to_action_card::Response::Success(_)),
        "retry after configuring the inbox must Succeed, got {retried:?}"
    );
    tick_many(env, 10);

    assert_eq!(
        count_actions(env, user.principal, inbox, &fingerprint),
        1,
        "the retried confirm must deposit exactly one action"
    );
}

// The action_inbox dedupes on (fingerprint, idempotency_id): the depositor queue may retry, and the
// two-phase confirm re-encrypts (fresh ephemeral key) on a user retry, so identity is the LOGICAL
// (message, payload) key, not the ciphertext. Depositing the same idempotency_id twice stores once.
#[test]
fn duplicate_deposit_id_dedupes_to_single_action() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user = client::register_diamond_user(env, canister_ids, *controller);
    let group_id = client::user::happy_path::create_group(env, &user, &random_string(), true, true);
    tick_many(env, 3);
    let group_lui = client::group::happy_path::local_user_index(env, group_id);

    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);

    let mut rng = StdRng::seed_from_u64(9_002);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let fingerprint = ecies_payload::key_fingerprint(&pem).unwrap();
    let created_at = now_millis(env);

    // Deposit directly as the authorized depositor (the group's LUI) so we control the idempotency_id.
    let deposit = |idempotency_id: u64| action_inbox_canister::c2c_notify_actions::ActionDeposit {
        idempotency_id,
        consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
        ephemeral_public_key: ByteBuf::from(vec![4u8; 65]),
        ciphertext: ByteBuf::from(b"opaque-ciphertext".to_vec()),
        oc_signature: ByteBuf::from(vec![0u8; 64]),
        created_at,
    };
    let notify = |env: &mut PocketIc, deposits: Vec<action_inbox_canister::c2c_notify_actions::ActionDeposit>| {
        let response: action_inbox_canister::c2c_notify_actions::Response = client::execute_msgpack_update(
            env,
            group_lui,
            inbox,
            "c2c_notify_actions_msgpack",
            &action_inbox_canister::c2c_notify_actions::Args { deposits },
        );
        assert!(
            matches!(response, action_inbox_canister::c2c_notify_actions::Response::Success),
            "c2c_notify_actions must Succeed, got {response:?}"
        );
    };

    // Same idempotency_id twice -> one stored action.
    notify(env, vec![deposit(1)]);
    notify(env, vec![deposit(1)]);
    assert_eq!(
        count_actions(env, user.principal, inbox, &fingerprint),
        1,
        "a repeated idempotency_id must be deduped to a single stored action"
    );

    // A DIFFERENT idempotency_id in the same bucket is a distinct action (dedupe is keyed, not blanket).
    notify(env, vec![deposit(2)]);
    assert_eq!(
        count_actions(env, user.principal, inbox, &fingerprint),
        2,
        "a distinct idempotency_id must add a new action"
    );
}

// Real path: confirming a routing-bearing card deposits exactly once; a redundant confirm of the
// now-Confirmed card neither deposits again nor errors into a second inbox entry.
#[test]
fn confirm_twice_via_card_deposits_once() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user = client::register_diamond_user(env, canister_ids, *controller);
    let group_id = client::user::happy_path::create_group(env, &user, &random_string(), true, true);
    tick_many(env, 3);
    let group_lui = client::group::happy_path::local_user_index(env, group_id);

    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);

    let mut rng = StdRng::seed_from_u64(9_003);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let fingerprint = ecies_payload::key_fingerprint(&pem).unwrap();

    // Per-card override routes deterministically to `inbox` regardless of the LUI global setting.
    let message_id = post_card(env, &user, group_id, pem, Some(inbox));

    let first = confirm(env, &user, group_id, message_id);
    assert!(
        matches!(first, group_canister::respond_to_action_card::Response::Success(_)),
        "first confirm must Succeed, got {first:?}"
    );
    tick_many(env, 10);
    assert_eq!(count_actions(env, user.principal, inbox, &fingerprint), 1, "one confirm -> one deposit");

    // The card is Confirmed now; a redundant confirm makes no state change and deposits nothing.
    let second = confirm(env, &user, group_id, message_id);
    assert!(
        !matches!(second, group_canister::respond_to_action_card::Response::Success(_)),
        "a redundant confirm must not Succeed again, got {second:?}"
    );
    tick_many(env, 10);
    assert_eq!(
        count_actions(env, user.principal, inbox, &fingerprint),
        1,
        "a redundant confirm must not add a second deposit"
    );
}

fn post_card(
    env: &mut PocketIc,
    user: &User,
    group_id: ChatId,
    recipient_pem: String,
    inbox_override: Option<CanisterId>,
) -> MessageId {
    let message_id = random_from_u128();
    let content = MessageContentInitial::ActionCard(ActionCardContentInitial {
        title: "Pay".to_string(),
        rows: vec![ActionCardRow {
            label: "Amount".to_string(),
            value: "$20".to_string(),
        }],
        confirm_label: "Confirm".to_string(),
        cancel_label: "Cancel".to_string(),
        action_id: "act-2pc".to_string(),
        disclosure: None,
        expires_at: None,
        recipient_public_key: Some(recipient_pem),
        recipient_public_keys: vec![],
        confirm_payload: Some(ByteBuf::from(br#"{"amount":"$20"}"#.to_vec())),
        inbox_canister_id: inbox_override,
    });
    client::group::happy_path::send_message(env, user, group_id, None, content, None, Some(message_id));
    message_id
}

fn confirm(
    env: &mut PocketIc,
    user: &User,
    group_id: ChatId,
    message_id: MessageId,
) -> group_canister::respond_to_action_card::Response {
    client::execute_msgpack_update(
        env,
        user.principal,
        group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Confirm,
        },
    )
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
