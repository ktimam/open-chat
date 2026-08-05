use crate::TestEnv;
use crate::client;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{
    confirm_raw, fetch_actions, inbox_deposit_fixture, install_inbox, new_recipient, post_card, set_key, setup,
};
use crate::utils::{now_millis, tick_many};
use candid::Principal;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;
use types::ActionCardResponse;

// A prepare/deposit failure must release the card reservation. Retrying the same card after repairing
// the authoritative key then deposits exactly once per member.
#[test]
fn failed_confirm_releases_reservation_for_retry() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(9_001);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);
    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.app.id,
        recipient_a.pk_pem.clone(),
    );
    let message_id = post_card(env, &fixture.user_a, fixture.group_id, &fixture.app, None, vec![], None);

    let failed = confirm_raw(env, &fixture.user_b, fixture.group_id, message_id);
    assert!(
        matches!(failed, group_canister::respond_to_action_card::Response::Error(_)),
        "a missing authoritative key must fail before deposit: {failed:?}"
    );
    assert!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_a.fingerprint).is_empty(),
        "failed preparation must be atomic"
    );

    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_b,
        fixture.app.id,
        recipient_b.pk_pem.clone(),
    );
    let retried = confirm_raw(env, &fixture.user_b, fixture.group_id, message_id);
    assert!(
        matches!(retried, group_canister::respond_to_action_card::Response::Success(_)),
        "the repaired retry must acquire the released reservation: {retried:?}"
    );
    tick_many(env, 10);
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_a.fingerprint).len(),
        1
    );
    assert_eq!(
        fetch_actions(env, fixture.user_b.principal, fixture.inbox, &recipient_b.fingerprint).len(),
        1
    );
}

// The inbox remains idempotent for delivery-queue retries, independently of the card-level
// single-flight guarantee.
#[test]
fn duplicate_full_identity_dedupes_to_single_action() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let inbox = install_inbox(env, *controller, canister_ids, fixture.app.id, canister_ids.user_index);
    let mut rng = StdRng::seed_from_u64(9_002);
    let recipient = new_recipient(&mut rng);
    let created_at = now_millis(env);
    let deposit = |identity_suffix: u8| {
        let mut identity = [6; 32];
        identity[31] = identity_suffix;
        inbox_deposit_fixture(recipient.fingerprint, identity, [7; 32], created_at)
    };
    notify(env, canister_ids.user_index, inbox, fixture.app.id, vec![deposit(1)]);
    notify(env, canister_ids.user_index, inbox, fixture.app.id, vec![deposit(1)]);
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, inbox, &recipient.fingerprint).len(),
        1,
        "the same full delivery identity must be stored once"
    );
    notify(env, canister_ids.user_index, inbox, fixture.app.id, vec![deposit(2)]);
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, inbox, &recipient.fingerprint).len(),
        2,
        "a distinct full delivery identity remains a distinct action"
    );
}

// Both calls are submitted before either result is awaited. The first call reserves the Pending card
// before its cross-canister deposit; a different actor cannot replace that durable attempt or issue a
// second outbound deposit. Payload-takeover and post-timeout retry boundaries are covered directly by
// the serialized card-state tests while edited confirmation remains feature-gated.
#[test]
fn concurrent_distinct_actor_confirms_issue_one_outbound_delivery() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(9_003);
    let recipient_a = new_recipient(&mut rng);
    let recipient_b = new_recipient(&mut rng);
    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.app.id,
        recipient_a.pk_pem.clone(),
    );
    set_key(
        env,
        canister_ids.user_index,
        &fixture.user_b,
        fixture.app.id,
        recipient_b.pk_pem.clone(),
    );
    let message_id = post_card(env, &fixture.user_a, fixture.group_id, &fixture.app, None, vec![], None);
    let confirm_bytes = msgpack::serialize_then_unwrap(&group_canister::respond_to_action_card::Args {
        thread_root_message_index: None,
        message_id,
        response: ActionCardResponse::Confirm,
        confirm_payload_override: None,
        confirmation_grant: None,
    });
    let call_a = env
        .submit_call(
            fixture.group_id.into(),
            fixture.user_a.principal,
            "respond_to_action_card_msgpack",
            confirm_bytes.clone(),
        )
        .expect("submit confirm A");
    let call_b = env
        .submit_call(
            fixture.group_id.into(),
            fixture.user_b.principal,
            "respond_to_action_card_msgpack",
            confirm_bytes,
        )
        .expect("submit confirm B");
    let result_a: group_canister::respond_to_action_card::Response =
        msgpack::deserialize_then_unwrap(&env.await_call(call_a).expect("await confirm A"));
    let result_b: group_canister::respond_to_action_card::Response =
        msgpack::deserialize_then_unwrap(&env.await_call(call_b).expect("await confirm B"));
    tick_many(env, 10);

    let successes = [&result_a, &result_b]
        .into_iter()
        .filter(|result| matches!(result, group_canister::respond_to_action_card::Response::Success(_)))
        .count();
    assert_eq!(
        successes, 1,
        "exactly one competing confirmer may reserve and commit the card: A={result_a:?}, B={result_b:?}"
    );
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_a.fingerprint).len(),
        1,
        "only one outbound fan-out may reach member A"
    );
    assert_eq!(
        fetch_actions(env, fixture.user_b.principal, fixture.inbox, &recipient_b.fingerprint).len(),
        1,
        "only one outbound fan-out may reach member B"
    );
}

fn notify(
    env: &mut PocketIc,
    depositor: Principal,
    inbox: Principal,
    app_id: types::AiAppId,
    deposits: Vec<action_inbox_canister::c2c_notify_actions::ActionDeposit>,
) {
    let response: action_inbox_canister::c2c_notify_actions::Response = client::execute_msgpack_update(
        env,
        depositor,
        inbox,
        "c2c_notify_actions_msgpack",
        &action_inbox_canister::c2c_notify_actions::Args { app_id, deposits },
    );
    assert!(
        matches!(response, action_inbox_canister::c2c_notify_actions::Response::Success),
        "c2c_notify_actions must succeed: {response:?}"
    );
}
