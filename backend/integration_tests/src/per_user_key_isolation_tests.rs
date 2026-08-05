use crate::TestEnv;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{confirm, decrypt, fetch_actions, new_recipient, post_card, set_key, setup};
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;

// A per-user app fans one confirmation out to the authoritative group members. Every member gets an
// independently encrypted envelope in its own fingerprint bucket, and no member can decrypt another
// member's copy.
#[test]
fn authoritative_fanout_is_encrypted_and_isolated_per_member() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let fixture = setup(env, canister_ids, *controller);
    let mut rng = StdRng::seed_from_u64(77);
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
    confirm(env, &fixture.user_a, fixture.group_id, message_id);

    let actions_a = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &recipient_a.fingerprint);
    let actions_b = fetch_actions(env, fixture.user_b.principal, fixture.inbox, &recipient_b.fingerprint);
    assert_eq!(actions_a.len(), 1, "member A must receive one encrypted copy");
    assert_eq!(actions_b.len(), 1, "member B must receive one encrypted copy");

    let plaintext_a = decrypt(&actions_a[0], &recipient_a.sk_pem).expect("A must decrypt A's envelope");
    let plaintext_b = decrypt(&actions_b[0], &recipient_b.sk_pem).expect("B must decrypt B's envelope");
    let json_a: serde_json::Value = serde_json::from_slice(&plaintext_a).unwrap();
    let json_b: serde_json::Value = serde_json::from_slice(&plaintext_b).unwrap();
    for json in [&json_a, &json_b] {
        assert_eq!(json["context"]["confirmedBy"], fixture.user_a.user_id.to_string());
        assert_eq!(json["context"]["appId"], fixture.app.id);
        assert_eq!(json["context"]["appRevision"], fixture.app.updated);
        assert_eq!(json["payload"]["amount"], "$20");
    }
    assert!(
        decrypt(&actions_a[0], &recipient_b.sk_pem).is_err(),
        "B's key must not decrypt A's envelope"
    );
    assert!(
        decrypt(&actions_b[0], &recipient_a.sk_pem).is_err(),
        "A's key must not decrypt B's envelope"
    );
}
