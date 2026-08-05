use ai_app_verifier_canister::{
    c2c_attest_ai_app_card_confirmation_v1, c2c_attest_ai_app_card_v1, c2c_verify_ai_app, c2c_verify_ai_app_v2,
};
use candid::{CandidType, Principal};
use serde::Deserialize;
use std::cell::RefCell;

#[derive(CandidType, Deserialize, Clone)]
pub struct InitArgs {
    pub name: String,
    pub owner: Principal,
    pub vouched: bool,
    /// `None` models a legacy V1-only app. UserIndex must never publish it even if V1 vouches.
    pub expected_v2: Option<c2c_verify_ai_app_v2::VerificationBindingV2>,
    /// Optional exact card fixture. Missing means card attestation is unavailable/fail-closed.
    pub expected_card_attestation: Option<c2c_attest_ai_app_card_v1::CardAttestationBindingV1>,
    /// Optional exact final-payload fixture. Missing means confirmation attestation is unavailable.
    pub expected_card_confirmation_attestation:
        Option<c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1>,
}

thread_local! {
    static CONFIG: RefCell<Option<InitArgs>> = const { RefCell::new(None) };
}

#[ic_cdk::init]
fn init(args: InitArgs) {
    CONFIG.with_borrow_mut(|config| *config = Some(args));
}

/// Neutral, repository-built verifier used only by OpenChat integration tests. It deliberately
/// binds both the generic app name and OpenChat owner so tests exercise the complete trust contract.
#[ic_cdk::update]
fn c2c_verify_ai_app(args: c2c_verify_ai_app::Args) -> c2c_verify_ai_app::Response {
    CONFIG.with_borrow(|config| {
        let vouched = config
            .as_ref()
            .is_some_and(|expected| expected.vouched && expected.name == args.name && expected.owner == args.owner);
        c2c_verify_ai_app::Response {
            vouched,
            name: vouched.then_some(args.name),
            owner: vouched.then_some(args.owner),
        }
    })
}

/// V2 test endpoint. A successful response echoes the canister's independently configured binding,
/// never the caller's challenge. This lets publication tests exercise substitution and stale-config
/// failures instead of accidentally using a permissive reflector as their trust fixture.
#[ic_cdk::update]
fn c2c_verify_ai_app_v2(args: c2c_verify_ai_app_v2::Args) -> c2c_verify_ai_app_v2::Response {
    CONFIG.with_borrow(|config| {
        let expected = config.as_ref().expect("verifier test canister not initialized");
        let vouched = expected.vouched && expected.expected_v2.as_ref() == Some(&args.binding);
        c2c_verify_ai_app_v2::Response {
            vouched,
            binding: expected.expected_v2.clone().unwrap_or(args.binding),
        }
    })
}

#[ic_cdk::update]
fn c2c_attest_ai_app_card_v1(args: c2c_attest_ai_app_card_v1::Args) -> c2c_attest_ai_app_card_v1::Response {
    CONFIG.with_borrow(|config| {
        let expected = config.as_ref().expect("verifier test canister not initialized");
        let vouched = expected.vouched && expected.expected_card_attestation.as_ref() == Some(&args.binding);
        c2c_attest_ai_app_card_v1::Response {
            vouched,
            binding: expected.expected_card_attestation.clone().unwrap_or(args.binding),
        }
    })
}

#[ic_cdk::update]
fn c2c_attest_ai_app_card_confirmation_v1(
    args: c2c_attest_ai_app_card_confirmation_v1::Args,
) -> c2c_attest_ai_app_card_confirmation_v1::Response {
    CONFIG.with_borrow(|config| {
        let expected = config.as_ref().expect("verifier test canister not initialized");
        let vouched = expected.vouched && expected.expected_card_confirmation_attestation.as_ref() == Some(&args.binding);
        c2c_attest_ai_app_card_confirmation_v1::Response {
            vouched,
            binding: expected
                .expected_card_confirmation_attestation
                .clone()
                .unwrap_or(args.binding),
        }
    })
}

ic_cdk::export_candid!();
