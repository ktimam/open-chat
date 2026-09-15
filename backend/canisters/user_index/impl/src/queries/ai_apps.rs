use crate::model::ai_app_registry::{MAX_AI_APP_QUERY_PAGE_SIZE, MAX_AI_APP_QUERY_RESPONSE_BYTES};
use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_apps::{Response::*, *};

#[query(candid = true, msgpack = true)]
fn ai_apps(_args: Args) -> Response {
    read_state(ai_apps_impl)
}

fn ai_apps_impl(state: &RuntimeState) -> Response {
    // Published apps for everyone, plus the caller's own unpublished ones. Caller resolution
    // mirrors register_ai_app: a registered user's UserId, else (test_mode only) the raw
    // principal — so a local deploy-script owner can still see its own pre-publish registration.
    let caller = state.env.caller();
    let user_id = state
        .data
        .users
        .get_by_principal(&caller)
        .map(|u| u.user_id)
        .or_else(|| state.data.test_mode.then(|| caller.into()));
    let (apps, _) = state
        .data
        .ai_apps
        .list_visible_page(user_id, state.env.now(), 0, MAX_AI_APP_QUERY_PAGE_SIZE);
    let response = Success(SuccessResult { apps });
    if response_is_within_limit(&response) {
        response
    } else {
        // The legacy response has no error variant. Fail closed without encoding a response that
        // can exceed the canister limit; valid current manifests fit below this ceiling.
        Success(SuccessResult { apps: Vec::new() })
    }
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
    use candid::Principal;
    use types::{AiAppManifest, UserId};
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
    fn legacy_full_list_is_a_bounded_compatibility_page() {
        let mut data = Data::default();
        let owner: UserId = Principal::from_slice(&[1]).into();
        for index in 0..10 {
            let app = data
                .ai_apps
                .register(owner, manifest(&format!("app-{index}")), index, true)
                .unwrap();
            data.ai_apps.publish(app.id, index);
        }
        let state = RuntimeState::new(Box::new(TestEnv::default()), data);
        let Success(result) = ai_apps_impl(&state);
        assert_eq!(result.apps.len(), MAX_AI_APP_QUERY_PAGE_SIZE as usize);
        assert!(response_is_within_limit(&Success(result)));
    }
}
