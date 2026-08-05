use crate::model::ai_app_registry::{MAX_AI_APP_QUERY_PAGE_SIZE, MAX_AI_APP_QUERY_RESPONSE_BYTES};
use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::my_ai_apps::{Response::*, *};

#[query(candid = true, msgpack = true)]
fn my_ai_apps(args: Args) -> Response {
    read_state(|state| my_ai_apps_impl(args, state))
}

fn my_ai_apps_impl(args: Args, state: &RuntimeState) -> Response {
    if args.page_size == 0 || args.page_size > MAX_AI_APP_QUERY_PAGE_SIZE {
        return InvalidPageSize(MAX_AI_APP_QUERY_PAGE_SIZE);
    }
    let caller = state.env.caller();
    let Some(owner) = state
        .data
        .users
        .get_by_principal(&caller)
        .map(|user| user.user_id)
        .or_else(|| state.data.test_mode.then(|| caller.into()))
    else {
        return UserNotFound;
    };
    let (apps, total) = state
        .data
        .ai_apps
        .list_owned_page(owner, state.env.now(), args.page_index, args.page_size);
    let response = Success(SuccessResult { apps, total });
    if !response_is_within_limit(&response) {
        return ResponseTooLarge(MAX_AI_APP_QUERY_RESPONSE_BYTES as u32);
    }
    response
}

fn response_is_within_limit(response: &Response) -> bool {
    matches!(
        msgpack::serialize_to_vec(response),
        Ok(encoded) if encoded.len() <= MAX_AI_APP_QUERY_RESPONSE_BYTES
    ) && matches!(
        candid::encode_one(response),
        Ok(encoded) if encoded.len() <= MAX_AI_APP_QUERY_RESPONSE_BYTES
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use types::AiAppManifest;
    use utils::env::test::TestEnv;

    fn manifest(name: &str) -> AiAppManifest {
        AiAppManifest {
            name: name.to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        }
    }

    #[test]
    fn caller_owned_apps_are_paginated_at_exact_boundaries() {
        let env = TestEnv::default();
        let owner = env.caller.into();
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id: owner,
            username: "owner".to_string(),
            ..Default::default()
        });
        for index in 0..10 {
            let app = data
                .ai_apps
                .register(owner, manifest(&format!("owned-{index}")), env.now, true)
                .unwrap();
            assert!(data.ai_apps.publish(app.id, env.now));
        }
        let state = RuntimeState::new(Box::new(env), data);

        let Success(first) = my_ai_apps_impl(
            Args {
                page_index: 0,
                page_size: MAX_AI_APP_QUERY_PAGE_SIZE,
            },
            &state,
        ) else {
            panic!("expected first page")
        };
        assert_eq!(first.total, 10);
        assert_eq!(first.apps.len(), 8);

        let Success(second) = my_ai_apps_impl(
            Args {
                page_index: 1,
                page_size: MAX_AI_APP_QUERY_PAGE_SIZE,
            },
            &state,
        ) else {
            panic!("expected second page")
        };
        assert_eq!(second.apps.len(), 2);
        assert!(matches!(
            my_ai_apps_impl(
                Args {
                    page_index: 0,
                    page_size: 0,
                },
                &state,
            ),
            InvalidPageSize(8)
        ));
        assert!(matches!(
            my_ai_apps_impl(
                Args {
                    page_index: 0,
                    page_size: MAX_AI_APP_QUERY_PAGE_SIZE + 1,
                },
                &state,
            ),
            InvalidPageSize(8)
        ));
    }
}
