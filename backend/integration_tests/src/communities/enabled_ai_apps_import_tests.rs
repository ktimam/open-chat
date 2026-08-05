use crate::env::ENV;
use crate::utils::tick_many;
use crate::{TestEnv, client};
use std::ops::Deref;
use testing::rng::random_string;

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

    // Publish a neutral generic app before enabling it. Draft and unknown ids fail closed.
    let app_id =
        crate::fan_out_delivery_tests::publish_per_user_app(env, canister_ids.user_index, *controller, &user1, None).id;

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
    assert_eq!(
        app_ids,
        vec![app_id],
        "imported channel must inherit the group's enabled AI apps"
    );
}
