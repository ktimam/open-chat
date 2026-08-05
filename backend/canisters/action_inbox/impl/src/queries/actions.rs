use crate::{RuntimeState, read_state};
use action_inbox_canister::actions::{Response::*, *};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;

#[update(candid = true, msgpack = true)]
fn actions(args: Args) -> Response {
    read_state(|state| actions_impl(args, state))
}

fn actions_impl(args: Args, state: &RuntimeState) -> Response {
    if state.data.inbox.migration_in_progress() {
        return Error(
            OCErrorCode::Throttled
                .with_message("action inbox migration is in progress; retry after bounded maintenance advances".to_string()),
        );
    }
    if args.consumer_key_fingerprint.len() != 32 {
        return Success(SuccessResult { actions: Vec::new() });
    }
    let actions = state.data.inbox.query(
        args.consumer_key_fingerprint.as_ref(),
        args.since_id,
        (args.max_results as usize).min(100),
        state.env.now(),
    );
    Success(SuccessResult { actions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use serde_bytes::ByteBuf;
    use utils::env::test::TestEnv;

    #[test]
    fn actions_fail_closed_while_the_stable_index_migration_is_incomplete() {
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let mut data = Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true);
        data.inbox.force_incomplete_migration_for_test();
        let state = RuntimeState::new(Box::new(env), data);

        let response = actions_impl(
            Args {
                consumer_key_fingerprint: ByteBuf::from(vec![1; 32]),
                since_id: 0,
                max_results: 100,
            },
            &state,
        );

        assert!(matches!(response, Error(error) if error.matches_code(OCErrorCode::Throttled)));
    }
}
