use crate::client;
use crate::env::ENV;
use crate::utils::tick_many;
use crate::wasms;
use crate::{TestEnv, User};
use candid::Principal;
use ecies_payload::EciesEnvelope;
use p256::SecretKey;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde_bytes::ByteBuf;
use std::ops::Deref;
use testing::rng::{random_from_u128, random_string};
use types::{
    ActionCardContentInitial, ActionCardResponse, ActionCardRow, AiAppId, AiAppManifest, CanisterId, ChatId,
    MessageContentInitial,
};

// Fan-out delivery: ONE confirm deposits one envelope PER recipient key carried on the card — so
// every chat member with a registered app key receives the confirmed action in their own inbox
// bucket, not just the proposer. This is what makes a confirmed action visible IMMEDIATELY to both
// members of a 2-person consumer-app account (e.g. IOU) with no key sharing: each member decrypts
// with their OWN key.

struct Recipient {
    pk_pem: String,
    sk_pem: String,
    fingerprint: [u8; 32],
}

fn new_recipient(rng: &mut StdRng) -> Recipient {
    let sk = SecretKey::random(rng);
    let pk_pem = sk.public_key().to_public_key_pem(Default::default()).unwrap();
    let sk_pem = sk.to_pkcs8_pem(Default::default()).unwrap().to_string();
    let fingerprint = ecies_payload::key_fingerprint(&pk_pem).unwrap();
    Recipient { pk_pem, sk_pem, fingerprint }
}

// A card proposed by A carrying BOTH members' keys (A in the legacy field, B in the fan-out list) is
// confirmed by B — the NON-proposer. The single confirm must land one deposit in EACH member's
// fingerprint bucket, each decryptable ONLY by that member's private key, both attributed to B.
#[test]
fn fan_out_confirm_deposits_to_every_recipient_key() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user_a = client::register_diamond_user(env, canister_ids, *controller);
    let user_b = client::register_diamond_user(env, canister_ids, *controller);

    let group_id = client::user::happy_path::create_group(env, &user_a, &random_string(), true, true);
    tick_many(env, 3);
    let group_lui = client::group::happy_path::local_user_index(env, group_id);
    client::local_user_index::happy_path::add_users_to_group(
        env,
        &user_a,
        group_lui,
        group_id,
        vec![(user_b.user_id, user_b.principal)],
    );

    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);

    let mut rng = StdRng::seed_from_u64(4242);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // A posts the card carrying BOTH keys; B (the partner) confirms it.
    let message_id = post_card(
        env,
        &user_a,
        group_id,
        Some(recipient_a.pk_pem.clone()),
        vec![recipient_b.pk_pem.clone()],
        inbox,
    );
    confirm(env, &user_b, group_id, message_id);

    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "the proposer's bucket must receive the fan-out deposit");
    assert_eq!(actions_b.len(), 1, "the partner's bucket must receive the fan-out deposit");

    // Each copy decrypts ONLY with its owner's key, and both attribute the confirm to B.
    for (own, other, actions, who) in [
        (&recipient_a, &recipient_b, &actions_a, "A"),
        (&recipient_b, &recipient_a, &actions_b, "B"),
    ] {
        let plaintext = decrypt(&actions[0], &own.sk_pem).unwrap_or_else(|e| panic!("{who} must decrypt own copy: {e}"));
        let json: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(
            json["context"]["confirmedBy"],
            user_b.user_id.to_string(),
            "{who}'s copy must attribute the confirm to B"
        );
        assert_eq!(json["payload"]["amount"], "$20", "{who}'s payload must round-trip");
        assert!(
            decrypt(&actions[0], &other.sk_pem).is_err(),
            "{who}'s copy must NOT decrypt with the other member's key"
        );
    }
}

// A card that repeats the SAME key in both fields dedupes to a single deposit (no double entry in
// the recipient's bucket).
#[test]
fn fan_out_dedupes_repeated_keys() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user_a = client::register_diamond_user(env, canister_ids, *controller);
    let group_id = client::user::happy_path::create_group(env, &user_a, &random_string(), true, true);
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

    let mut rng = StdRng::seed_from_u64(4243);
    let recipient = new_recipient(&mut rng);

    let message_id = post_card(
        env,
        &user_a,
        group_id,
        Some(recipient.pk_pem.clone()),
        vec![recipient.pk_pem.clone(), recipient.pk_pem.clone()],
        inbox,
    );
    confirm(env, &user_a, group_id, message_id);

    let actions = fetch_actions(env, user_a.principal, inbox, &recipient.fingerprint);
    assert_eq!(actions.len(), 1, "a repeated key must dedupe to a single deposit");
}

// The user_index `ai_app_user_keys` fan-out lookup: returns the registered keys of exactly the
// requested users for the app; users with no key are absent; an unknown app yields nothing.
#[test]
fn ai_app_user_keys_returns_only_requested_users_registered_keys() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user_a = client::register_diamond_user(env, canister_ids, *controller);
    let user_b = client::register_diamond_user(env, canister_ids, *controller);

    let app_id = register_per_user_app(env, user_a.principal, canister_ids.user_index);

    // A registers a delivery key; B registers none.
    let mut rng = StdRng::seed_from_u64(4244);
    let a_pem = new_recipient(&mut rng).pk_pem;
    let response: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        user_a.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id,
            public_key: a_pem.clone(),
        },
    );
    assert!(
        matches!(response, user_index_canister::set_my_ai_app_key::Response::Success),
        "set_my_ai_app_key failed: {response:?}"
    );

    // Lookup for [A, B]: exactly A's row comes back (B has no key).
    let keys = lookup_keys(env, user_b.principal, canister_ids.user_index, app_id, vec![
        user_a.user_id,
        user_b.user_id,
    ]);
    assert_eq!(keys.len(), 1, "only registered users appear: {keys:?}");
    assert_eq!(keys[0].user_id, user_a.user_id);
    assert_eq!(keys[0].public_key, a_pem);

    // Unknown app: nothing.
    let none = lookup_keys(env, user_b.principal, canister_ids.user_index, app_id + 999, vec![user_a.user_id]);
    assert!(none.is_empty(), "an unknown app must yield no keys");
}

fn lookup_keys(
    env: &mut PocketIc,
    caller: Principal,
    user_index: CanisterId,
    app_id: AiAppId,
    user_ids: Vec<types::UserId>,
) -> Vec<types::AiAppMemberKey> {
    let response: user_index_canister::ai_app_user_keys::Response = client::execute_msgpack_query(
        env,
        caller,
        user_index,
        "ai_app_user_keys_msgpack",
        &user_index_canister::ai_app_user_keys::Args { app_id, user_ids },
    );
    match response {
        user_index_canister::ai_app_user_keys::Response::Success(result) => result.keys,
    }
}

fn register_per_user_app(env: &mut PocketIc, sender: Principal, user_index: CanisterId) -> AiAppId {
    client::user_index::happy_path::register_ai_app(
        env,
        sender,
        user_index,
        AiAppManifest {
            name: random_string(),
            description: "fan-out test app".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        },
    )
}

fn decrypt(action: &action_inbox_canister::actions::StoredAction, recipient_sk_pem: &str) -> Result<Vec<u8>, String> {
    let envelope = EciesEnvelope {
        ephemeral_public_key: action.ephemeral_public_key.clone().into_vec(),
        ciphertext: action.ciphertext.clone().into_vec(),
    };
    ecies_payload::decrypt(&envelope, recipient_sk_pem)
}

fn fetch_actions(
    env: &PocketIc,
    sender: Principal,
    inbox: CanisterId,
    fingerprint: &[u8; 32],
) -> Vec<action_inbox_canister::actions::StoredAction> {
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
        action_inbox_canister::actions::Response::Success(result) => result.actions,
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

fn post_card(
    env: &mut PocketIc,
    user: &User,
    group_id: ChatId,
    recipient_pem: Option<String>,
    recipient_pems: Vec<String>,
    inbox: CanisterId,
) -> types::MessageId {
    let message_id = random_from_u128();
    let content = MessageContentInitial::ActionCard(ActionCardContentInitial {
        title: "Pay".to_string(),
        rows: vec![ActionCardRow {
            label: "Amount".to_string(),
            value: "$20".to_string(),
        }],
        confirm_label: "Confirm".to_string(),
        cancel_label: "Cancel".to_string(),
        action_id: "act-fanout".to_string(),
        disclosure: None,
        expires_at: None,
        recipient_public_key: recipient_pem,
        recipient_public_keys: recipient_pems,
        confirm_payload: Some(ByteBuf::from(br#"{"amount":"$20"}"#.to_vec())),
        inbox_canister_id: Some(inbox),
    });
    client::group::happy_path::send_message(env, user, group_id, None, content, None, Some(message_id));
    message_id
}

fn confirm(env: &mut PocketIc, user: &User, group_id: ChatId, message_id: types::MessageId) {
    let response: group_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        user.principal,
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
