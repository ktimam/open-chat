use crate::TestEnv;
use crate::env::ENV;
use crate::fan_out_delivery_tests::{confirm, decrypt, fetch_actions, link_key, new_recipient, post_card, setup};
use ct_codecs::{Base64UrlSafeNoPadding, Decoder};
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;

// A per-user app delivers one envelope only to the actual confirmer's opaque selector. Another linked
// member receives no copy and cannot decrypt the confirmer's envelope.
#[test]
fn confirmer_delivery_is_encrypted_and_isolated_from_other_linked_members() {
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
    let selector_a = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_a,
        &fixture.app,
        recipient_a.pk_pem.clone(),
    );
    let selector_b = link_key(
        env,
        canister_ids.user_index,
        &fixture.user_b,
        &fixture.app,
        recipient_b.pk_pem.clone(),
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
    confirm(env, &fixture.user_a, fixture.group_id, message_id);

    let actions_a = fetch_actions(env, fixture.user_a.principal, fixture.inbox, &selector_a);
    let actions_b = fetch_actions(env, fixture.user_b.principal, fixture.inbox, &selector_b);
    assert_eq!(actions_a.len(), 1, "the confirmer must receive one encrypted delivery");
    assert!(actions_b.is_empty(), "a linked nonconfirmer must receive no delivery");

    let plaintext_a = decrypt(&actions_a[0], &recipient_a.sk_pem).expect("the confirmer must decrypt its envelope");
    let json_a: serde_json::Value = serde_json::from_slice(&plaintext_a).unwrap();
    assert!(
        json_a["context"].get("confirmedBy").is_none(),
        "raw confirmer principal must not leak into the app-scoped envelope"
    );
    assert_eq!(json_a["context"]["appId"], fixture.app.id);
    assert_eq!(json_a["context"]["appRevision"], fixture.app.updated);
    assert_eq!(json_a["envelopeVersion"], 4);
    assert_eq!(json_a["payloadEncoding"], "base64url");
    let encoded_payload = json_a["payload"].as_str().expect("v4 payload must be base64url text");
    let payload = Base64UrlSafeNoPadding::decode_to_vec(encoded_payload, None).expect("v4 payload must decode");
    let payload: serde_json::Value = serde_json::from_slice(&payload).expect("fixture payload must remain valid JSON");
    assert_eq!(payload["amount"], "$20");
    assert!(
        decrypt(&actions_a[0], &recipient_b.sk_pem).is_err(),
        "the nonconfirmer's key must not decrypt the confirmer's envelope"
    );
}
