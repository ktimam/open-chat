use ai_app_verifier_canister::*;
use canister_client::generate_candid_c2c_call;

// These targets are third-party app canisters. Bound every wait so a stopped/nonresponding app
// cannot retain UserIndex callback contexts or indefinitely block upgrades. Timeouts fail closed at
// the caller; V1 remains callable for compatibility, but publication trusts only V2.
generate_candid_c2c_call!(c2c_attest_ai_app_card_confirmation_v1, timeout_seconds = 10);
generate_candid_c2c_call!(c2c_attest_ai_app_card_v1, timeout_seconds = 10);
generate_candid_c2c_call!(c2c_verify_ai_app, timeout_seconds = 10);
generate_candid_c2c_call!(c2c_verify_ai_app_v2, timeout_seconds = 10);

#[cfg(test)]
mod tests {
    #[test]
    fn every_third_party_verifier_call_has_an_explicit_bounded_wait() {
        let source = include_str!("lib.rs");
        for method in [
            "c2c_attest_ai_app_card_confirmation_v1",
            "c2c_attest_ai_app_card_v1",
            "c2c_verify_ai_app",
            "c2c_verify_ai_app_v2",
        ] {
            assert!(source.contains(&format!("generate_candid_c2c_call!({method}, timeout_seconds = 10)")));
        }
    }
}
