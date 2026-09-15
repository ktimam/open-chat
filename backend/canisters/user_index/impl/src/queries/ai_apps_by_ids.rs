use crate::model::ai_app_registry::{MAX_AI_APP_QUERY_PAGE_SIZE, MAX_AI_APP_QUERY_RESPONSE_BYTES};
use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use std::collections::HashSet;
use user_index_canister::ai_apps_by_ids::{Response::*, *};

const MAX_LOOKUPS: usize = MAX_AI_APP_QUERY_PAGE_SIZE as usize;

#[query(candid = true, msgpack = true)]
fn ai_apps_by_ids(args: Args) -> Response {
    read_state(|state| ai_apps_by_ids_impl(args, state))
}

fn ai_apps_by_ids_impl(args: Args, state: &RuntimeState) -> Response {
    if args.lookups.len() > MAX_LOOKUPS {
        return TooManyApps(MAX_LOOKUPS as u8);
    }
    let caller = state.env.caller();
    let user_id = state
        .data
        .users
        .get_by_principal(&caller)
        .map(|user| user.user_id)
        .or_else(|| state.data.test_mode.then(|| caller.into()));
    let now = state.env.now();
    let mut seen = HashSet::new();
    let apps = args
        .lookups
        .into_iter()
        .filter(|lookup| seen.insert(lookup.app_id))
        .filter_map(|lookup| {
            state
                .data
                .ai_apps
                .get_visible(lookup.app_id, user_id, now)
                .filter(|app| lookup.revision.is_none_or(|revision| app.updated == revision))
                .cloned()
        })
        .collect::<Vec<_>>();
    let response = Success(SuccessResult { apps });
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
    use crate::{Data, RuntimeState};
    use candid::Principal;
    use types::{AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    fn state() -> RuntimeState {
        RuntimeState::new(Box::new(TestEnv::default()), Data::default())
    }

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
    fn caps_lookups_deduplicates_and_requires_current_revision() {
        let mut state = state();
        let owner: UserId = Principal::from_slice(&[1]).into();
        let app = state.data.ai_apps.register(owner, manifest("app"), 10, true).unwrap();
        state.data.ai_apps.publish(app.id, 10);
        let lookup = |revision| AiAppLookup {
            app_id: app.id,
            revision,
        };

        let success = ai_apps_by_ids_impl(
            Args {
                lookups: vec![lookup(Some(app.updated)), lookup(None)],
            },
            &state,
        );
        let Success(result) = success else {
            panic!("expected success")
        };
        assert_eq!(result.apps.len(), 1);

        let Success(stale) = ai_apps_by_ids_impl(
            Args {
                lookups: vec![lookup(Some(app.updated + 1))],
            },
            &state,
        ) else {
            panic!("expected success")
        };
        assert!(stale.apps.is_empty());

        let Success(isolated) = ai_apps_by_ids_impl(
            Args {
                lookups: vec![
                    AiAppLookup {
                        app_id: u32::MAX,
                        revision: None,
                    },
                    lookup(Some(app.updated)),
                ],
            },
            &state,
        ) else {
            panic!("expected success")
        };
        assert_eq!(isolated.apps.iter().map(|app| app.id).collect::<Vec<_>>(), vec![app.id]);

        assert!(matches!(
            ai_apps_by_ids_impl(
                Args {
                    lookups: (0..=MAX_LOOKUPS)
                        .map(|index| AiAppLookup {
                            app_id: index as u32,
                            revision: None,
                        })
                        .collect(),
                },
                &state,
            ),
            TooManyApps(8)
        ));
    }

    #[test]
    fn encoded_response_ceiling_fails_closed() {
        let mut state = state();
        let owner: UserId = Principal::from_slice(&[1]).into();
        let mut oversized = manifest("oversized");
        oversized.description = "x".repeat(MAX_AI_APP_QUERY_RESPONSE_BYTES + 1);
        let app = state.data.ai_apps.register(owner, oversized, 10, true).unwrap();
        state.data.ai_apps.publish(app.id, 10);

        assert!(matches!(
            ai_apps_by_ids_impl(
                Args {
                    lookups: vec![AiAppLookup {
                        app_id: app.id,
                        revision: Some(app.updated),
                    }],
                },
                &state,
            ),
            ResponseTooLarge(limit) if limit == MAX_AI_APP_QUERY_RESPONSE_BYTES as u32
        ));
    }
}
