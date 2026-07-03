use crate::env::ENV;
use crate::utils::tick_many;
use crate::{TestEnv, client};
use std::ops::Deref;
use testing::rng::random_string;
use types::AiAppManifest;

// register_ai_app only requires the consumer_public_key to LOOK like a public key (it must contain
// the literal "BEGIN PUBLIC KEY"); it is not parsed. This is a real P-256 SPKI PEM.
const TEST_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqEJ3Fh3nq0pXwq3B0m1yq0m8m0z1\n\
4Yb0d3fZq7Xk5c1m0e6qg8sB9r2n0aQ7l5Yy8dW1s0N6vF3wR4p9xK5rQ==\n\
-----END PUBLIC KEY-----\n";

// #4: a group's enabled AI apps must carry over to the channel created when the group is imported
// into a community. Before the fix the imported channel always started with an empty set.
#[test]
fn enabled_ai_apps_carried_over_on_group_import() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();

    let user1 = client::register_diamond_user(env, canister_ids, *controller);

    let group_id = client::user::happy_path::create_group(env, &user1, &random_string(), true, true);
    let community_id = client::user::happy_path::create_community(
        env,
        &user1,
        &random_string(),
        true,
        (0..2).map(|_| random_string()).collect(),
    );
    tick_many(env, 3);

    // Register an AI app (owned by user1) and enable it on the group.
    let app_id = client::user_index::happy_path::register_ai_app(
        env,
        user1.principal,
        canister_ids.user_index,
        AiAppManifest {
            name: random_string(),
            description: "Test app".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: TEST_SPKI_PEM.to_string(),
            per_user_keys: false,
            actions: vec![],
            surfaces: vec![],
        },
    );

    client::group::happy_path::set_ai_app_enabled(env, user1.principal, group_id, app_id, true);
    // Sanity: the group now reports the app as enabled.
    assert_eq!(
        client::group::happy_path::enabled_ai_apps(env, user1.principal, group_id),
        vec![app_id]
    );

    // Import the group into the community and let the multi-batch import finalize.
    let channel_id = client::community::happy_path::import_group(env, user1.principal, community_id, group_id).channel_id;
    tick_many(env, 20);

    // The imported channel must carry the same enabled app.
    let app_ids = client::community::happy_path::enabled_ai_apps(env, user1.principal, community_id, channel_id);
    assert_eq!(app_ids, vec![app_id], "imported channel must inherit the group's enabled AI apps");
}
