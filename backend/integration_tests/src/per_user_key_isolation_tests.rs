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
use types::{ActionCardContentInitial, ActionCardResponse, ActionCardRow, CanisterId, ChatId, MessageContentInitial};

// A recipient delivery keypair, kept as both the public SPKI PEM (routing/encryption target) and the
// private PKCS#8 PEM (so the test can decrypt exactly as the production consumer would).
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

// Two users each confirm their OWN action card (each addressed to their OWN delivery key) into a
// single shared inbox. The deposits must land in per-fingerprint buckets, be decryptable ONLY by the
// matching private key (cross-user isolation), and carry the confirming user's id as `confirmedBy`.
#[test]
fn per_user_deposits_are_isolated_and_attributed() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user_a = client::register_diamond_user(env, canister_ids, *controller);
    let user_b = client::register_diamond_user(env, canister_ids, *controller);

    let group_id = client::user::happy_path::create_group(env, &user_a, &random_string(), true, true);
    tick_many(env, 3);

    let group_lui = client::group::happy_path::local_user_index(env, group_id);

    // Add B to the group so it can post + confirm its own card.
    client::local_user_index::happy_path::add_users_to_group(
        env,
        &user_a,
        group_lui,
        group_id,
        vec![(user_b.user_id, user_b.principal)],
    );

    // The platform signing key and one shared per-app inbox authorizing the group's LUI as depositor.
    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        group_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let inbox = install_inbox(env, *controller, canister_ids, group_lui, oc_pem);

    let mut rng = StdRng::seed_from_u64(77);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // Each user confirms a card addressed to their own key, routed (per-card override) to `inbox`.
    post_and_confirm(env, &user_a, group_id, recipient_a.pk_pem.clone(), inbox);
    post_and_confirm(env, &user_b, group_id, recipient_b.pk_pem.clone(), inbox);

    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "A's fingerprint bucket must hold A's single deposit");
    assert_eq!(actions_b.len(), 1, "B's fingerprint bucket must hold B's single deposit");

    // A's ciphertext: decrypts with A's key, attributes to A, and is opaque to B's key.
    let plaintext_a = decrypt(&actions_a[0], &recipient_a.sk_pem).expect("A must decrypt its own deposit");
    let json_a: serde_json::Value = serde_json::from_slice(&plaintext_a).unwrap();
    assert_eq!(
        json_a["context"]["confirmedBy"], user_a.user_id.to_string(),
        "A's deposit must be attributed to A"
    );
    assert_eq!(json_a["payload"]["amount"], "$20", "the opaque payload must round-trip");
    assert!(
        decrypt(&actions_a[0], &recipient_b.sk_pem).is_err(),
        "B's key must NOT decrypt A's deposit (cross-user isolation)"
    );

    // B's ciphertext: decrypts with B's key, attributes to B, and is opaque to A's key.
    let plaintext_b = decrypt(&actions_b[0], &recipient_b.sk_pem).expect("B must decrypt its own deposit");
    let json_b: serde_json::Value = serde_json::from_slice(&plaintext_b).unwrap();
    assert_eq!(
        json_b["context"]["confirmedBy"], user_b.user_id.to_string(),
        "B's deposit must be attributed to B"
    );
    assert!(
        decrypt(&actions_b[0], &recipient_a.sk_pem).is_err(),
        "A's key must NOT decrypt B's deposit (cross-user isolation)"
    );
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

fn post_and_confirm(env: &mut PocketIc, user: &User, group_id: ChatId, recipient_pem: String, inbox: CanisterId) {
    let message_id = random_from_u128();
    let content = MessageContentInitial::ActionCard(ActionCardContentInitial {
        title: "Pay".to_string(),
        rows: vec![ActionCardRow {
            label: "Amount".to_string(),
            value: "$20".to_string(),
        }],
        confirm_label: "Confirm".to_string(),
        cancel_label: "Cancel".to_string(),
        action_id: "act-iso".to_string(),
        disclosure: None,
        expires_at: None,
        recipient_public_key: Some(recipient_pem),
        recipient_public_keys: vec![],
        // Valid JSON so it embeds as a JSON value in the deposit envelope's `payload`.
        confirm_payload: Some(ByteBuf::from(br#"{"amount":"$20"}"#.to_vec())),
        inbox_canister_id: Some(inbox),
    });
    client::group::happy_path::send_message(env, user, group_id, None, content, None, Some(message_id));

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
