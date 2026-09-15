use crate::env::ENV;
use crate::utils::tick_many;
use crate::{TestEnv, client};
use std::ops::Deref;
use testing::rng::random_string;

const ENABLED_APP_LIMIT: usize = 32;

#[test]
fn group_and_channel_enabled_ai_apps_are_bounded_and_directory_validated() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user = client::register_diamond_user(env, canister_ids, *controller);

    // Every id used for the capacity boundary is backed by a neutral repository-built verifier and
    // an exact published registry revision. The old regression used arbitrary integers, which
    // accidentally encoded the dangling-id vulnerability as expected behavior.
    let apps: Vec<_> = (0..=ENABLED_APP_LIMIT)
        .map(|_| crate::fan_out_delivery_tests::publish_per_user_app(env, canister_ids.user_index, *controller, &user, None))
        .collect();
    let app_ids: Vec<_> = apps.iter().map(|app| app.id).collect();
    let mut draft_manifest = apps[0].manifest.clone();
    draft_manifest.name = random_string();
    let draft_id =
        client::user_index::happy_path::register_ai_app(env, user.principal, canister_ids.user_index, draft_manifest);

    let group_id = client::user::happy_path::create_group(env, &user, &random_string(), true, true);
    assert!(matches!(
        client::group::set_ai_app_enabled(
            env,
            user.principal,
            group_id.into(),
            &group_canister::set_ai_app_enabled::Args {
                app_id: u32::MAX,
                enabled: true,
            },
        ),
        group_canister::set_ai_app_enabled::Response::Error(_)
    ));
    assert!(matches!(
        client::group::set_ai_app_enabled(
            env,
            user.principal,
            group_id.into(),
            &group_canister::set_ai_app_enabled::Args {
                app_id: draft_id,
                enabled: true,
            },
        ),
        group_canister::set_ai_app_enabled::Response::Error(_)
    ));
    for app_id in app_ids.iter().take(ENABLED_APP_LIMIT - 1).copied() {
        client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_id, true);
    }
    assert_eq!(
        client::group::happy_path::enabled_ai_apps(env, user.principal, group_id).len(),
        ENABLED_APP_LIMIT - 1
    );

    client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_ids[ENABLED_APP_LIMIT - 1], true);
    assert_eq!(
        client::group::happy_path::enabled_ai_apps(env, user.principal, group_id).len(),
        ENABLED_APP_LIMIT
    );
    assert!(matches!(
        client::group::set_ai_app_enabled(
            env,
            user.principal,
            group_id.into(),
            &group_canister::set_ai_app_enabled::Args {
                app_id: app_ids[ENABLED_APP_LIMIT],
                enabled: true,
            },
        ),
        group_canister::set_ai_app_enabled::Response::Error(_)
    ));

    // At capacity, idempotence and remove-then-replace remain available.
    client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_ids[ENABLED_APP_LIMIT - 1], true);
    client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_ids[0], false);
    client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_ids[ENABLED_APP_LIMIT], true);
    let group_apps = client::group::happy_path::enabled_ai_apps(env, user.principal, group_id);
    assert_eq!(group_apps.len(), ENABLED_APP_LIMIT);
    assert!(!group_apps.contains(&app_ids[0]));
    assert!(group_apps.contains(&app_ids[ENABLED_APP_LIMIT]));

    let community_id = client::user::happy_path::create_community(env, &user, &random_string(), true, vec![random_string()]);
    tick_many(env, 3);
    let channel_id = client::community::happy_path::create_channel(env, user.principal, community_id, true, random_string());

    assert!(matches!(
        client::community::set_ai_app_enabled(
            env,
            user.principal,
            community_id.into(),
            &community_canister::set_ai_app_enabled::Args {
                channel_id,
                app_id: u32::MAX,
                enabled: true,
            },
        ),
        community_canister::set_ai_app_enabled::Response::Error(_)
    ));
    assert!(matches!(
        client::community::set_ai_app_enabled(
            env,
            user.principal,
            community_id.into(),
            &community_canister::set_ai_app_enabled::Args {
                channel_id,
                app_id: draft_id,
                enabled: true,
            },
        ),
        community_canister::set_ai_app_enabled::Response::Error(_)
    ));
    for app_id in app_ids.iter().take(ENABLED_APP_LIMIT).copied() {
        set_channel_ai_app_enabled(env, user.principal, community_id, channel_id, app_id, true);
    }
    assert_eq!(
        client::community::happy_path::enabled_ai_apps(env, user.principal, community_id, channel_id).len(),
        ENABLED_APP_LIMIT
    );
    assert!(matches!(
        client::community::set_ai_app_enabled(
            env,
            user.principal,
            community_id.into(),
            &community_canister::set_ai_app_enabled::Args {
                channel_id,
                app_id: app_ids[ENABLED_APP_LIMIT],
                enabled: true,
            },
        ),
        community_canister::set_ai_app_enabled::Response::Error(_)
    ));

    set_channel_ai_app_enabled(env, user.principal, community_id, channel_id, app_ids[0], false);
    set_channel_ai_app_enabled(
        env,
        user.principal,
        community_id,
        channel_id,
        app_ids[ENABLED_APP_LIMIT],
        true,
    );
    let channel_apps = client::community::happy_path::enabled_ai_apps(env, user.principal, community_id, channel_id);
    assert_eq!(channel_apps.len(), ENABLED_APP_LIMIT);
    assert!(!channel_apps.contains(&app_ids[0]));
    assert!(channel_apps.contains(&app_ids[ENABLED_APP_LIMIT]));

    // Registry deletion immediately disables every trusted execution route. The next enable
    // operation also reconciles the bounded child set and releases the deleted id's slot.
    let deleted = &apps[7];
    let response: user_index_canister::delete_ai_app::Response = client::execute_update(
        env,
        user.principal,
        canister_ids.user_index,
        "delete_ai_app",
        &user_index_canister::delete_ai_app::Args {
            name: deleted.manifest.name.clone(),
        },
    );
    assert!(matches!(response, user_index_canister::delete_ai_app::Response::Success));

    client::group::happy_path::set_ai_app_enabled(env, user.principal, group_id, app_ids[1], true);
    let group_apps = client::group::happy_path::enabled_ai_apps(env, user.principal, group_id);
    assert!(!group_apps.contains(&deleted.id));
    assert_eq!(group_apps.len(), ENABLED_APP_LIMIT - 1);
    assert!(matches!(
        client::group::set_ai_app_enabled(
            env,
            user.principal,
            group_id.into(),
            &group_canister::set_ai_app_enabled::Args {
                app_id: deleted.id,
                enabled: true,
            },
        ),
        group_canister::set_ai_app_enabled::Response::Error(_)
    ));

    set_channel_ai_app_enabled(env, user.principal, community_id, channel_id, app_ids[1], true);
    let channel_apps = client::community::happy_path::enabled_ai_apps(env, user.principal, community_id, channel_id);
    assert!(!channel_apps.contains(&deleted.id));
    assert_eq!(channel_apps.len(), ENABLED_APP_LIMIT - 1);
}

fn set_channel_ai_app_enabled(
    env: &mut pocket_ic::PocketIc,
    sender: candid::Principal,
    community_id: types::CommunityId,
    channel_id: types::ChannelId,
    app_id: types::AiAppId,
    enabled: bool,
) {
    let response = client::community::set_ai_app_enabled(
        env,
        sender,
        community_id.into(),
        &community_canister::set_ai_app_enabled::Args {
            channel_id,
            app_id,
            enabled,
        },
    );
    assert!(matches!(response, community_canister::set_ai_app_enabled::Response::Success));
}
