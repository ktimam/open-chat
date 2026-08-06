use crate::TestEnv;
use crate::client;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{confirm, fetch_actions, inbox_deposit_fixture, link_key, new_recipient, post_card, setup};
use crate::wasms;
use ct_codecs::{Base64UrlSafeNoPadding, Decoder};
use oc_error_codes::OCErrorCode;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde_bytes::ByteBuf;
use std::ops::Deref;

const SYBIL_CALLERS: u128 = 16;
const MAX_CYCLES_PER_INVALID_ACK: u128 = 10_000_000_000;

#[test]
fn actions_rejects_query_transport_and_succeeds_as_a_replicated_update() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let args = action_inbox_canister::actions::Args {
        consumer_key_fingerprint: ByteBuf::from(vec![0; 32]),
        since_id: 0,
        max_results: 1,
    };
    let encoded = msgpack::serialize_then_unwrap(&args);

    assert!(
        env.query_call(fixture.inbox, fixture.user_a.principal, "actions_msgpack", encoded.clone())
            .is_err(),
        "consensus-sensitive ids and pagination must not be served by query transport"
    );
    let bytes = env
        .update_call(fixture.inbox, fixture.user_a.principal, "actions_msgpack", encoded)
        .expect("replicated actions update must succeed");
    let response: action_inbox_canister::actions::Response = msgpack::deserialize_then_unwrap(&bytes);
    assert!(matches!(
        response,
        action_inbox_canister::actions::Response::Success(result) if result.actions.is_empty()
    ));
}

fn acknowledge(
    env: &mut pocket_ic::PocketIc,
    sender: candid::Principal,
    inbox: candid::Principal,
    recipient: &crate::fan_out_delivery_tests::Recipient,
    selector: &[u8; 32],
    action: &action_inbox_canister::actions::StoredAction,
) -> action_inbox_canister::acknowledge_actions::Response {
    let envelope = ecies_payload::EciesEnvelope {
        ephemeral_public_key: action.ephemeral_public_key.to_vec(),
        ciphertext: action.ciphertext.to_vec(),
    };
    let plaintext = ecies_payload::decrypt(&envelope, &recipient.sk_pem).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
    let encoded_secret = value["acknowledgementSecret"].as_str().unwrap();
    let secret = Base64UrlSafeNoPadding::decode_to_vec(encoded_secret, None).unwrap();
    acknowledge_with_secret(env, sender, inbox, selector, action.id, &secret)
}

fn acknowledge_with_secret(
    env: &mut pocket_ic::PocketIc,
    sender: candid::Principal,
    inbox: candid::Principal,
    fingerprint: &[u8; 32],
    action_id: u64,
    secret: &[u8],
) -> action_inbox_canister::acknowledge_actions::Response {
    client::action_inbox::acknowledge_actions(
        env,
        sender,
        inbox,
        &action_inbox_canister::acknowledge_actions::Args {
            consumer_key_fingerprint: ByteBuf::from(fingerprint.to_vec()),
            consumer_public_key_pem: String::new(),
            through_id: action_id,
            signature: ByteBuf::new(),
            acknowledgement_secret: Some(ByteBuf::from(secret.to_vec())),
        },
    )
}

#[test]
fn old_key_can_be_drained_after_rotation_without_touching_the_new_key() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(8101);
    let old_key = new_recipient(&mut rng);
    let new_key = new_recipient(&mut rng);
    let old_selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        old_key.pk_pem.clone(),
    );
    let old_message = post_card(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.group_id,
        &fixture.app,
        None,
        vec![],
        None,
    );
    confirm(env, &fixture.user_a, fixture.group_id, old_message);
    let new_selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        new_key.pk_pem.clone(),
    );
    let new_message = post_card(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.group_id,
        &fixture.app,
        None,
        vec![],
        None,
    );
    confirm(env, &fixture.user_a, fixture.group_id, new_message);

    let old_actions = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &old_selector);
    let new_actions = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &new_selector);
    assert_eq!(old_actions.len(), 1);
    assert_eq!(new_actions.len(), 1);
    let response = acknowledge(
        env,
        fixture.user_a.principal,
        fixture.inbox,
        &old_key,
        &old_selector,
        &old_actions[0],
    );
    assert!(matches!(
        response,
        action_inbox_canister::acknowledge_actions::Response::Success(
            action_inbox_canister::acknowledge_actions::SuccessResult {
                acknowledged: 1,
                remaining: 0
            }
        )
    ));
    assert!(fetch_actions(env, fixture.user_a.principal, fixture.inbox, &old_selector).is_empty());
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &new_selector).len(),
        1
    );
}

#[test]
fn sybil_invalid_secrets_cannot_acknowledge_or_lock_out_the_valid_holder() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(8102);
    let recipient = new_recipient(&mut rng);
    let attacker = new_recipient(&mut rng);
    let recipient_selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        recipient.pk_pem.clone(),
    );
    let attacker_selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_b,
        &fixture.app,
        attacker.pk_pem.clone(),
    );
    let message = post_card(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.group_id,
        &fixture.app,
        None,
        vec![],
        None,
    );
    confirm(env, &fixture.user_a, fixture.group_id, message);
    let actions = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_selector);
    assert_eq!(actions.len(), 1);
    assert!(fetch_actions(env, fixture.user_b.principal, fixture.inbox, &attacker_selector).is_empty());

    let envelope = ecies_payload::EciesEnvelope {
        ephemeral_public_key: actions[0].ephemeral_public_key.to_vec(),
        ciphertext: actions[0].ciphertext.to_vec(),
    };
    assert!(ecies_payload::decrypt(&envelope, &attacker.sk_pem).is_err());
    let response = acknowledge_with_secret(
        env,
        fixture.user_a.principal,
        fixture.inbox,
        &recipient_selector,
        actions[0].id,
        &[0; action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_BYTES],
    );
    assert!(matches!(
        response,
        action_inbox_canister::acknowledge_actions::Response::NotAuthorized
    ));
    assert_eq!(
        fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_selector).len(),
        1
    );

    let cycles_before = env.cycle_balance(fixture.inbox.as_slice().try_into().unwrap());
    for value in 1..=SYBIL_CALLERS as u8 {
        let caller = candid::Principal::from_slice(&[200, value]);
        let mut wrong_secret = [0; action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_BYTES];
        wrong_secret[0] = value;
        assert!(matches!(
            acknowledge_with_secret(env, caller, fixture.inbox, &recipient_selector, actions[0].id, &wrong_secret,),
            action_inbox_canister::acknowledge_actions::Response::NotAuthorized
        ));
    }
    let cycles_after = env.cycle_balance(fixture.inbox.as_slice().try_into().unwrap());
    let attack_cycles = cycles_before.saturating_sub(cycles_after);
    assert!(
        attack_cycles <= SYBIL_CALLERS * MAX_CYCLES_PER_INVALID_ACK,
        "{SYBIL_CALLERS} invalid acknowledgement calls consumed {attack_cycles} cycles"
    );

    assert!(matches!(
        acknowledge(
            env,
            fixture.user_a.principal,
            fixture.inbox,
            &recipient,
            &recipient_selector,
            &actions[0],
        ),
        action_inbox_canister::acknowledge_actions::Response::Success(
            action_inbox_canister::acknowledge_actions::SuccessResult {
                acknowledged: 1,
                remaining: 0
            }
        )
    ));
}

#[test]
fn retained_actions_and_acknowledgement_survive_a_canister_upgrade() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(8103);
    let recipient = new_recipient(&mut rng);
    let selector = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        recipient.pk_pem.clone(),
    );
    let message = post_card(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        fixture.group_id,
        &fixture.app,
        None,
        vec![],
        None,
    );
    confirm(env, &fixture.user_a, fixture.group_id, message);
    let before = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &selector);
    assert_eq!(before.len(), 1);

    env.upgrade_canister(
        fixture.inbox,
        wasms::ACTION_INBOX.module.clone().into(),
        candid::encode_one(action_inbox_canister::post_upgrade::Args {
            wasm_version: wasms::ACTION_INBOX.version,
        })
        .unwrap(),
        Some(*controller),
    )
    .unwrap();

    let after = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &selector);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, before[0].id);
    assert!(matches!(
        acknowledge(env, fixture.user_a.principal, fixture.inbox, &recipient, &selector, &after[0],),
        action_inbox_canister::acknowledge_actions::Response::Success(_)
    ));
}

#[test]
fn acknowledged_tombstone_survives_upgrade_and_retry_remains_a_successful_no_op() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(8104);
    let recipient = new_recipient(&mut rng);
    let acknowledgement_secret = [7; action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_BYTES];
    let deposit = || {
        let mut deposit = inbox_deposit_fixture(recipient.fingerprint, [6; 32], [7; 32], 1);
        deposit.acknowledgement_secret_hash = ByteBuf::from(
            action_inbox_canister::acknowledge_actions::acknowledgement_secret_hash(
                fixture.inbox,
                &recipient.fingerprint,
                &acknowledgement_secret,
            )
            .to_vec(),
        );
        deposit.ciphertext = ByteBuf::from(b"opaque".to_vec());
        deposit
    };
    let notify = |env: &mut pocket_ic::PocketIc| -> action_inbox_canister::c2c_notify_actions::Response {
        client::execute_msgpack_update(
            env,
            canister_ids.user_index,
            fixture.inbox,
            "c2c_notify_actions_msgpack",
            &action_inbox_canister::c2c_notify_actions::Args {
                app_id: fixture.app.id,
                deposits: vec![deposit()],
            },
        )
    };

    assert!(matches!(
        notify(env),
        action_inbox_canister::c2c_notify_actions::Response::Success
    ));
    let stored = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient.fingerprint);
    assert_eq!(stored.len(), 1);
    assert!(matches!(
        acknowledge_with_secret(
            env,
            fixture.user_a.principal,
            fixture.inbox,
            &recipient.fingerprint,
            stored[0].id,
            &acknowledgement_secret,
        ),
        action_inbox_canister::acknowledge_actions::Response::Success(_)
    ));

    env.upgrade_canister(
        fixture.inbox,
        wasms::ACTION_INBOX.module.clone().into(),
        candid::encode_one(action_inbox_canister::post_upgrade::Args {
            wasm_version: wasms::ACTION_INBOX.version,
        })
        .unwrap(),
        Some(*controller),
    )
    .unwrap();

    assert!(matches!(
        notify(env),
        action_inbox_canister::c2c_notify_actions::Response::Success
    ));
    assert!(fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient.fingerprint).is_empty());
}

#[test]
#[ignore = "capacity-scale PocketIC regression (3,200 ingress updates); run explicitly in release mode"]
fn exact_global_action_capacity_survives_upgrade_and_recovers_after_one_exact_action_is_acknowledged() {
    const MAX_DEPOSITS_PER_CALL: usize = 32;

    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let configuration = client::execute_msgpack_query::<_, action_inbox_canister::configuration::Response>(
        env,
        fixture.user_a.principal,
        fixture.inbox,
        "configuration_msgpack",
        &action_inbox_canister::configuration::Args {},
    );
    let action_inbox_canister::configuration::Response::Success(configuration) = configuration;
    let actions_per_key = configuration.max_actions_per_key as usize;
    let total_actions = configuration.max_total_actions as usize;
    assert_eq!(actions_per_key, 1_000);
    assert_eq!(total_actions, 100_000);
    assert_eq!(total_actions % actions_per_key, 0);
    let key_count = total_actions / actions_per_key;
    assert_eq!(key_count, 100);

    let secret_for = |key_index: usize, idempotency_id: u64| {
        let mut secret = [0u8; action_inbox_canister::acknowledge_actions::ACKNOWLEDGEMENT_SECRET_BYTES];
        secret[..8].copy_from_slice(&(key_index as u64).to_le_bytes());
        secret[8..16].copy_from_slice(&idempotency_id.to_le_bytes());
        secret
    };
    let make_deposit = |key_index: usize, idempotency_id: u64| {
        let fingerprint = [key_index as u8; 32];
        let secret = secret_for(key_index, idempotency_id);
        let mut identity = [0; 32];
        identity[24..].copy_from_slice(&idempotency_id.to_be_bytes());
        let mut deposit = inbox_deposit_fixture(fingerprint, identity, [7; 32], 1);
        deposit.acknowledgement_secret_hash = ByteBuf::from(
            action_inbox_canister::acknowledge_actions::acknowledgement_secret_hash(fixture.inbox, &fingerprint, &secret)
                .to_vec(),
        );
        deposit.ciphertext = ByteBuf::from(vec![5]);
        deposit
    };
    let notify = |env: &mut pocket_ic::PocketIc, deposits: Vec<action_inbox_canister::c2c_notify_actions::ActionDeposit>| {
        client::execute_msgpack_update::<_, action_inbox_canister::c2c_notify_actions::Response>(
            env,
            canister_ids.user_index,
            fixture.inbox,
            "c2c_notify_actions_msgpack",
            &action_inbox_canister::c2c_notify_actions::Args {
                app_id: fixture.app.id,
                deposits,
            },
        )
    };

    for key_index in 0..key_count {
        for start in (1..=actions_per_key).step_by(MAX_DEPOSITS_PER_CALL) {
            let end = (start + MAX_DEPOSITS_PER_CALL - 1).min(actions_per_key);
            let deposits = (start..=end)
                .map(|idempotency_id| make_deposit(key_index, idempotency_id as u64))
                .collect();
            assert!(matches!(
                notify(env, deposits),
                action_inbox_canister::c2c_notify_actions::Response::Success
            ));
        }
    }

    let overflow_key_index = 200;
    let overflow = make_deposit(overflow_key_index, 1);
    assert!(matches!(
        notify(env, vec![overflow.clone()]),
        action_inbox_canister::c2c_notify_actions::Response::Error(error)
            if error.matches_code(OCErrorCode::Throttled)
    ));

    let first_fingerprint = [0; 32];
    let last_first_key_id = actions_per_key as u64;
    let read_last = |env: &mut pocket_ic::PocketIc| {
        client::action_inbox::actions(
            env,
            fixture.user_a.principal,
            fixture.inbox,
            &action_inbox_canister::actions::Args {
                consumer_key_fingerprint: ByteBuf::from(first_fingerprint.to_vec()),
                since_id: last_first_key_id - 1,
                max_results: 1,
            },
        )
    };
    assert!(matches!(
        read_last(env),
        action_inbox_canister::actions::Response::Success(result)
            if result.actions.len() == 1 && result.actions[0].id == last_first_key_id
    ));

    env.upgrade_canister(
        fixture.inbox,
        wasms::ACTION_INBOX.module.clone().into(),
        candid::encode_one(action_inbox_canister::post_upgrade::Args {
            wasm_version: wasms::ACTION_INBOX.version,
        })
        .unwrap(),
        Some(*controller),
    )
    .unwrap();

    assert!(matches!(
        read_last(env),
        action_inbox_canister::actions::Response::Success(result)
            if result.actions.len() == 1 && result.actions[0].id == last_first_key_id
    ));
    assert!(matches!(
        notify(env, vec![overflow.clone()]),
        action_inbox_canister::c2c_notify_actions::Response::Error(error)
            if error.matches_code(OCErrorCode::Throttled)
    ));
    let last_secret = secret_for(0, actions_per_key as u64);
    assert!(matches!(
        acknowledge_with_secret(
            env,
            fixture.user_a.principal,
            fixture.inbox,
            &first_fingerprint,
            last_first_key_id,
            &last_secret,
        ),
        action_inbox_canister::acknowledge_actions::Response::Success(
            action_inbox_canister::acknowledge_actions::SuccessResult {
                acknowledged: 1,
                remaining: 999,
            }
        )
    ));
    assert!(matches!(
        notify(env, vec![overflow]),
        action_inbox_canister::c2c_notify_actions::Response::Success
    ));
}
