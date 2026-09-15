use canister_api_macros::update;
use user_index_canister::claim_ai_app_link_code::{Response::*, *};

/// Browser principals must never be able to turn a copied bearer code into a key binding. The
/// app-authenticated flow is `c2c_claim_ai_app_link_code`; this legacy method remains only as a
/// stable wire-compatible fail-closed response for older clients.
#[update(candid = true, msgpack = true)]
fn claim_ai_app_link_code(_args: Args) -> Response {
    InvalidRequest("link codes must be claimed by the registered app canister".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_browser_claim_is_permanently_fail_closed() {
        assert!(matches!(
            claim_ai_app_link_code(Args {
                code: "a".repeat(64),
                public_key: "unused".to_string(),
            }),
            InvalidRequest(_)
        ));
    }
}
