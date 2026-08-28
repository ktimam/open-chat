use crate::model::ai_app_registry::{MAX_AI_APP_QUERY_PAGE_SIZE, MAX_AI_APP_QUERY_RESPONSE_BYTES};
use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::explore_ai_apps::{Response::*, *};

const MIN_TERM_LENGTH: u8 = 2;
const MAX_TERM_LENGTH: u8 = 20;
#[query(candid = true, msgpack = true)]
fn explore_ai_apps(args: Args) -> Response {
    read_state(|state| explore_ai_apps_impl(args, state))
}

fn explore_ai_apps_impl(args: Args, state: &RuntimeState) -> Response {
    if args.page_size == 0 || args.page_size > MAX_AI_APP_QUERY_PAGE_SIZE {
        return InvalidPageSize(MAX_AI_APP_QUERY_PAGE_SIZE);
    }
    if let Some(term_length) = args.search_term.as_ref().map(|term| term.chars().count()) {
        if term_length < MIN_TERM_LENGTH as usize {
            return TermTooShort(MIN_TERM_LENGTH);
        }

        if term_length > MAX_TERM_LENGTH as usize {
            return TermTooLong(MAX_TERM_LENGTH);
        }
    }

    let (matches, total) = state.data.ai_apps.search(args.search_term, args.page_index, args.page_size);

    let response = Success(SuccessResult { matches, total });
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
    use utils::env::test::TestEnv;

    #[test]
    fn page_size_is_bounded_at_zero_eight_and_nine() {
        let state = RuntimeState::new(Box::new(TestEnv::default()), Data::default());
        assert!(matches!(
            explore_ai_apps_impl(
                Args {
                    search_term: None,
                    page_index: 0,
                    page_size: 0,
                },
                &state,
            ),
            InvalidPageSize(8)
        ));
        assert!(matches!(
            explore_ai_apps_impl(
                Args {
                    search_term: None,
                    page_index: 0,
                    page_size: 8,
                },
                &state,
            ),
            Success(_)
        ));
        assert!(matches!(
            explore_ai_apps_impl(
                Args {
                    search_term: None,
                    page_index: 0,
                    page_size: 9,
                },
                &state,
            ),
            InvalidPageSize(8)
        ));
    }

    #[test]
    fn search_term_length_cannot_wrap_and_counts_unicode_characters() {
        let state = RuntimeState::new(Box::new(TestEnv::default()), Data::default());
        for term in ["x".repeat(21), "x".repeat(255), "x".repeat(256), "x".repeat(258)] {
            assert!(matches!(
                explore_ai_apps_impl(
                    Args {
                        search_term: Some(term),
                        page_index: 0,
                        page_size: 8,
                    },
                    &state,
                ),
                TermTooLong(20)
            ));
        }
        assert!(matches!(
            explore_ai_apps_impl(
                Args {
                    search_term: Some("é".repeat(20)),
                    page_index: 0,
                    page_size: 8,
                },
                &state,
            ),
            Success(_)
        ));
        assert!(matches!(
            explore_ai_apps_impl(
                Args {
                    search_term: Some("é".repeat(21)),
                    page_index: 0,
                    page_size: 8,
                },
                &state,
            ),
            TermTooLong(20)
        ));
    }
}
