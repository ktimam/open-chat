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

// P0-21: recipient keys are FROZEN into the card at post time (client-authored), not gathered from
// the registry at confirm. A posts a card carrying only A's key (empty fan-out list); B confirms.
// Exactly one deposit lands — in A's bucket. B, whose key was never on the card, gets nothing.
#[test]
fn frozen_recipient_set_is_authoritative() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4245);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // A's key ONLY — no fan-out list.
    let message_id = post_card(env, &user_a, group_id, Some(recipient_a.pk_pem.clone()), vec![], inbox);
    confirm(env, &user_b, group_id, message_id);

    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "A's key was on the card → A's bucket receives the deposit");
    assert_eq!(actions_b.len(), 0, "B's key was NOT on the card → B's bucket stays empty");
}

// P0-22: a card confirmed when NOBODY's key is on it (no recipient_public_key, empty fan-out list)
// still commits — a routing-less confirm — and deposits nothing. It must NOT trap.
#[test]
fn empty_recipient_card_confirms_safely_with_no_deposit() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, _user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4246);
    let bystander = new_recipient(&mut rng);

    // A confirm_payload + inbox but NO recipient key anywhere.
    let message_id = post_card(env, &user_a, group_id, None, vec![], inbox);
    confirm(env, &user_a, group_id, message_id); // confirm() asserts Success — proves it does not trap

    // Nothing was deposited: an uninvolved fingerprint has no actions.
    let actions = fetch_actions(env, user_a.principal, inbox, &bystander.fingerprint);
    assert_eq!(actions.len(), 0, "an empty-recipient card deposits nothing");
}

// P0-22 (late link): registering a delivery key AFTER the card was posted does NOT retroactively add
// the late member to that card's recipient set. B links a key post-hoc, then confirms; nothing lands
// in B's newly-registered-key bucket — recipients were frozen at post time.
#[test]
fn late_link_does_not_retroactively_deliver() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4247);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // A posts a card carrying ONLY A's key (B hasn't linked yet).
    let message_id = post_card(env, &user_a, group_id, Some(recipient_a.pk_pem.clone()), vec![], inbox);

    // B links a delivery key AFTER the post.
    let app_id = register_per_user_app(env, user_a.principal, canister_ids.user_index);
    let set: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        user_b.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id,
            public_key: recipient_b.pk_pem.clone(),
        },
    );
    assert!(matches!(set, user_index_canister::set_my_ai_app_key::Response::Success));

    confirm(env, &user_b, group_id, message_id);

    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "A (on the card) receives the deposit");
    assert_eq!(actions_b.len(), 0, "B linked AFTER the post → no retroactive delivery");
}

// Shared setup: two diamond users, a group with both as members, and a freshly installed action_inbox
// authorized to receive deposits from the group's local_user_index.
fn setup_two_member_group_with_inbox(
    env: &mut PocketIc,
    canister_ids: &crate::CanisterIds,
    controller: &Principal,
) -> (User, User, ChatId, CanisterId) {
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
    (user_a, user_b, group_id, inbox)
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
        app_id: None,
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
            confirm_payload_override: None,
        },
    );
    assert!(
        matches!(response, group_canister::respond_to_action_card::Response::Success(_)),
        "confirm failed: {response:?}"
    );
    tick_many(env, 10);
}

// One malformed key among valid recipients fails the WHOLE fan-out batch: no partial deposit to
// the good key, and the two-phase confirm leaves the card Pending (still cancellable/retryable).
#[test]
fn malformed_recipient_key_fails_whole_batch_leaving_card_pending() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4249);
    let recipient_a = new_recipient(&mut rng);
    let bad_pem = "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n".to_string();

    let message_id = post_card(env, &user_a, group_id, Some(recipient_a.pk_pem.clone()), vec![bad_pem], inbox);

    // Confirm: ECIES encrypt fails on the bad key -> the LUI rejects the whole batch -> Error.
    let response: group_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        user_b.principal,
        group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Confirm,
            confirm_payload_override: None,
        },
    );
    assert!(
        !matches!(response, group_canister::respond_to_action_card::Response::Success(_)),
        "a batch containing a malformed key must not confirm: {response:?}"
    );
    tick_many(env, 10);

    // Atomic: the GOOD key received nothing — no partial deposit.
    assert_eq!(
        fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint).len(),
        0,
        "the valid recipient must NOT receive a partial deposit"
    );

    // The card stayed Pending: a Cancel still transitions (only possible from Pending).
    let cancel: group_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        user_b.principal,
        group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Cancel,
            confirm_payload_override: None,
        },
    );
    assert!(
        matches!(cancel, group_canister::respond_to_action_card::Response::Success(_)),
        "the failed confirm must leave the card Pending (cancellable): {cancel:?}"
    );
}

// Two DIFFERENT members confirm the same card (B first, then A). The second confirm must be a
// no-op — each recipient bucket ends with exactly ONE action, not two. (Even a true in-flight race
// collapses: idempotency_id = sha256(payload || message_id) is confirmer-independent, and the inbox
// dedupes on (fingerprint, idempotency_id).)
#[test]
fn different_member_second_confirm_adds_no_deposit() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4250);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    let message_id = post_card(
        env,
        &user_a,
        group_id,
        Some(recipient_a.pk_pem.clone()),
        vec![recipient_b.pk_pem.clone()],
        inbox,
    );

    // B confirms first: Success, fan-out deposits to both buckets (helper asserts Success + ticks).
    confirm(env, &user_b, group_id, message_id);

    // A's confirm of the now-Confirmed card must NOT succeed (NoChange) and must not re-deposit.
    let second: group_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        user_a.principal,
        group_id.into(),
        "respond_to_action_card_msgpack",
        &group_canister::respond_to_action_card::Args {
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Confirm,
            confirm_payload_override: None,
        },
    );
    assert!(
        !matches!(second, group_canister::respond_to_action_card::Response::Success(_)),
        "a second member's confirm of a Confirmed card must not Succeed: {second:?}"
    );
    tick_many(env, 10);

    for (recipient, who) in [(&recipient_a, "A"), (&recipient_b, "B")] {
        let actions = fetch_actions(env, user_a.principal, inbox, &recipient.fingerprint);
        assert_eq!(actions.len(), 1, "{who}'s bucket must hold exactly one action after two confirms");
        // The stored copy attributes the confirm to B — the member whose confirm won.
        let plaintext = decrypt(&actions[0], &recipient.sk_pem).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(json["context"]["confirmedBy"], user_b.user_id.to_string());
    }
}

// DIRECT chat: only the responder's canister emits the deposit; the peer's mirror copy is
// apply-only. Exactly one deposit per recipient key — never doubled by the mirror.
#[test]
fn direct_chat_mirror_copy_never_emits_second_deposit() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let user_a = client::register_diamond_user(env, canister_ids, *controller);
    let user_b = client::register_diamond_user(env, canister_ids, *controller);

    // Authorize BOTH LUIs: if the mirror side ever (wrongly) deposited, it would come from A's LUI
    // and must be COUNTED, not rejected by the depositor guard.
    let a_lui = canister_ids.local_user_index(env, user_a.canister());
    let b_lui = canister_ids.local_user_index(env, user_b.canister());
    let local_user_index_canister::oc_signing_public_key::Response::Success(oc_pem) = client::execute_msgpack_query(
        env,
        Principal::anonymous(),
        b_lui,
        "oc_signing_public_key_msgpack",
        &local_user_index_canister::oc_signing_public_key::Args {},
    );
    let mut depositors = vec![a_lui, b_lui];
    depositors.dedup();
    let inbox = client::create_canister(env, *controller);
    client::install_canister(
        env,
        *controller,
        inbox,
        wasms::ACTION_INBOX.clone(),
        action_inbox_canister::init::Args {
            user_index_canister_id: canister_ids.user_index,
            cycles_dispenser_canister_id: canister_ids.cycles_dispenser,
            deployment_operators: vec![*controller],
            authorized_depositors: depositors,
            oc_signing_public_key_pem: oc_pem,
            wasm_version: wasms::ACTION_INBOX.version,
            test_mode: true,
        },
    );

    let mut rng = StdRng::seed_from_u64(4251);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // A sends B a routing-bearing card in their DIRECT chat, carrying both members' keys.
    let message_id = random_from_u128();
    let content = MessageContentInitial::ActionCard(ActionCardContentInitial {
        title: "Pay".to_string(),
        rows: vec![ActionCardRow {
            label: "Amount".to_string(),
            value: "$20".to_string(),
        }],
        confirm_label: "Confirm".to_string(),
        cancel_label: "Cancel".to_string(),
        action_id: "act-direct".to_string(),
        app_id: None,
        disclosure: None,
        expires_at: None,
        recipient_public_key: Some(recipient_a.pk_pem.clone()),
        recipient_public_keys: vec![recipient_b.pk_pem.clone()],
        confirm_payload: Some(ByteBuf::from(br#"{"amount":"$20"}"#.to_vec())),
        inbox_canister_id: Some(inbox),
    });
    client::user::happy_path::send_message(env, &user_a, user_b.user_id, None, content, None, Some(message_id));
    tick_many(env, 5); // the card reaches B's copy of the direct chat

    // B confirms on B's OWN canister (Args.user_id = the OTHER participant).
    let response: user_canister::respond_to_action_card::Response = client::execute_msgpack_update(
        env,
        user_b.principal,
        user_b.canister(),
        "respond_to_action_card_msgpack",
        &user_canister::respond_to_action_card::Args {
            user_id: user_a.user_id,
            thread_root_message_index: None,
            message_id,
            response: ActionCardResponse::Confirm,
            confirm_payload_override: None,
        },
    );
    assert!(
        matches!(response, user_canister::respond_to_action_card::Response::Success(_)),
        "direct-chat confirm failed: {response:?}"
    );
    tick_many(env, 10); // deposit lands AND the mirror event reaches A's canister

    // Exactly one deposit per recipient: the mirror on A's canister applied state without depositing.
    assert_eq!(
        fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint).len(),
        1,
        "A's bucket: exactly one deposit (mirror must not double it)"
    );
    assert_eq!(
        fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint).len(),
        1,
        "B's bucket: exactly one deposit"
    );
}

// Key rotation between post and confirm: the deposit goes to the STALE key frozen on the card (K1),
// never the new key (K2) — and the registry now returns only K2 (upsert, not append).
#[test]
fn rotation_after_post_delivers_to_stale_key_frozen_on_card() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let app_id = register_per_user_app(env, user_a.principal, canister_ids.user_index);
    let mut rng = StdRng::seed_from_u64(4252);
    let k1 = new_recipient(&mut rng);
    let k2 = new_recipient(&mut rng);

    // A registers K1, and the card is posted carrying K1 (what a proposer's lookup would capture).
    let set1: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        user_a.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id,
            public_key: k1.pk_pem.clone(),
        },
    );
    assert!(matches!(set1, user_index_canister::set_my_ai_app_key::Response::Success));
    let message_id = post_card(env, &user_a, group_id, Some(k1.pk_pem.clone()), vec![], inbox);

    // A rotates to K2 BEFORE the confirm.
    let set2: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        user_a.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id,
            public_key: k2.pk_pem.clone(),
        },
    );
    assert!(matches!(set2, user_index_canister::set_my_ai_app_key::Response::Success));

    confirm(env, &user_b, group_id, message_id);

    // Delivery targets the key BAKED ON THE CARD (K1), not the rotated key.
    assert_eq!(
        fetch_actions(env, user_a.principal, inbox, &k1.fingerprint).len(),
        1,
        "the stale key frozen on the card must receive the deposit"
    );
    assert_eq!(
        fetch_actions(env, user_a.principal, inbox, &k2.fingerprint).len(),
        0,
        "the rotated-to key was never on the card — nothing lands there"
    );

    // Rotation REPLACED the registry row (upsert): the fan-out lookup returns only K2 now.
    let keys = lookup_keys(env, user_a.principal, canister_ids.user_index, app_id, vec![user_a.user_id]);
    assert_eq!(keys.len(), 1, "rotation must replace, not append: {keys:?}");
    assert_eq!(keys[0].public_key, k2.pk_pem, "only the new key remains registered");
}

// One malformed key among the fan-out recipients fails the WHOLE batch atomically: the confirm
// errors, the card stays Pending (retryable), and the VALID recipient receives NOTHING — never a
// partial fan-out that silently dropped one member.
#[test]
fn malformed_recipient_key_fails_whole_fanout_batch_atomically() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4248);
    let recipient_a = new_recipient(&mut rng);

    // A's VALID key plus a garbage "PEM" in the fan-out list.
    let message_id = post_card(
        env,
        &user_a,
        group_id,
        Some(recipient_a.pk_pem.clone()),
        vec!["-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n".to_string()],
        inbox,
    );

    // confirm() helper asserts Success, so drive the update raw and expect the C2C error.
    let confirm_raw = |env: &mut PocketIc| -> group_canister::respond_to_action_card::Response {
        client::execute_msgpack_update(
            env,
            user_b.principal,
            group_id.into(),
            "respond_to_action_card_msgpack",
            &group_canister::respond_to_action_card::Args {
                thread_root_message_index: None,
                message_id,
                response: ActionCardResponse::Confirm,
                confirm_payload_override: None,
            },
        )
    };

    let response = confirm_raw(env);
    assert!(
        matches!(response, group_canister::respond_to_action_card::Response::Error(_)),
        "a malformed recipient key must fail the confirm, got {response:?}"
    );
    tick_many(env, 10);

    // ATOMIC: the valid recipient got nothing — deposits are built before the single batch call,
    // so an error on the bad key means the good key's envelope was never sent either.
    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    assert_eq!(actions_a.len(), 0, "no partial deposit to the valid key");

    // PENDING, not Confirmed: a re-confirm attempts (and fails) the deposit again, proving the
    // failed confirm did not commit the card.
    let retry = confirm_raw(env);
    assert!(
        matches!(retry, group_canister::respond_to_action_card::Response::Error(_)),
        "the card must remain Pending/retryable after the failed batch, got {retry:?}"
    );
}

// A member removed from the group BETWEEN post and confirm still receives the fan-out deposit:
// the recipient set was frozen into the card at post time and delivery never re-consults
// membership. (If pruning-on-departure is ever the intended contract, this test is the tripwire.)
#[test]
fn removed_member_still_receives_frozen_fanout_deposit() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let (user_a, user_b, group_id, inbox) = setup_two_member_group_with_inbox(env, canister_ids, controller);

    let mut rng = StdRng::seed_from_u64(4253);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);

    // Card frozen with BOTH members' keys while B is still a member.
    let message_id = post_card(
        env,
        &user_a,
        group_id,
        Some(recipient_a.pk_pem.clone()),
        vec![recipient_b.pk_pem.clone()],
        inbox,
    );

    // B is removed BEFORE the confirm.
    let removed = client::group::remove_participant(
        env,
        user_a.principal,
        group_id.into(),
        &group_canister::remove_participant::Args { user_id: user_b.user_id },
    );
    assert!(
        matches!(removed, group_canister::remove_participant::Response::Success),
        "removal must Succeed: {removed:?}"
    );
    tick_many(env, 3);

    // A (still a member) confirms.
    confirm(env, &user_a, group_id, message_id);

    let actions_a = fetch_actions(env, user_a.principal, inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, user_b.principal, inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "the confirmer's bucket receives its deposit");
    assert_eq!(
        actions_b.len(),
        1,
        "the DEPARTED member's key was frozen on the card at post time → the envelope still lands"
    );
}
