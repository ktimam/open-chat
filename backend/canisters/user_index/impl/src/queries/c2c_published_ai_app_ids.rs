use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use std::collections::BTreeSet;
use user_index_canister::c2c_published_ai_app_ids::{Response::*, *};

#[query(msgpack = true)]
fn c2c_published_ai_app_ids(args: Args) -> Response {
    read_state(|state| c2c_published_ai_app_ids_impl(args, state))
}

fn c2c_published_ai_app_ids_impl(args: Args, state: &RuntimeState) -> Response {
    if args.app_ids.len() > MAX_APP_IDS {
        return TooManyApps(MAX_APP_IDS as u8);
    }

    let app_ids = args
        .app_ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|app_id| state.data.ai_apps.get(*app_id).is_some_and(|app| app.published))
        .collect();
    Success(SuccessResult { app_ids })
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
    fn returns_only_sorted_unique_published_ids() {
        let mut state = state();
        let owner: UserId = Principal::from_slice(&[1]).into();
        let published = state.data.ai_apps.register(owner, manifest("published"), 1, true).unwrap();
        let draft = state.data.ai_apps.register(owner, manifest("draft"), 2, true).unwrap();
        assert!(state.data.ai_apps.publish(published.id, 3));

        let Success(result) = c2c_published_ai_app_ids_impl(
            Args {
                app_ids: vec![draft.id, published.id, u32::MAX, published.id],
            },
            &state,
        ) else {
            panic!("expected success")
        };
        assert_eq!(result.app_ids, vec![published.id]);
    }

    #[test]
    fn accepts_chat_limit_plus_candidate_and_rejects_one_more() {
        assert!(matches!(
            c2c_published_ai_app_ids_impl(
                Args {
                    app_ids: (0..MAX_APP_IDS as u32).collect(),
                },
                &state(),
            ),
            Success(_)
        ));
        assert!(matches!(
            c2c_published_ai_app_ids_impl(
                Args {
                    app_ids: (0..=MAX_APP_IDS as u32).collect(),
                },
                &state(),
            ),
            TooManyApps(33)
        ));
    }
}
