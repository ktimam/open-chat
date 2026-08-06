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
    /// Optional content-only happy-path fixture. It still pins the registered UserIndex/app,
    /// validates the scoped context shape, and records the exact accepted binding for confirmation.
    pub accepted_card_content: Option<types::AiAppCardContentV1>,
    /// Optional final payload accepted only for the exact previously accepted card binding.
    pub accepted_confirmation_payload: Option<Vec<u8>>,
}

thread_local! {
    static CONFIG: RefCell<Option<InitArgs>> = const { RefCell::new(None) };
    static LAST_ACCEPTED_CARD: RefCell<Option<c2c_attest_ai_app_card_v1::CardAttestationBindingV1>> =
        const { RefCell::new(None) };
}

#[ic_cdk::init]
fn init(args: InitArgs) {
    CONFIG.with_borrow_mut(|config| *config = Some(args));
    LAST_ACCEPTED_CARD.with_borrow_mut(|binding| *binding = None);
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
    let response = CONFIG.with_borrow(|config| {
        let expected = config.as_ref().expect("verifier test canister not initialized");
        let exact = expected.expected_card_attestation.as_ref() == Some(&args.binding);
        let fixture = expected.expected_card_attestation.is_none()
            && expected
                .accepted_card_content
                .as_ref()
                .is_some_and(|content| card_binding_matches_fixture(&args.binding, expected, content));
        let vouched = expected.vouched && (exact || fixture);
        c2c_attest_ai_app_card_v1::Response {
            vouched,
            binding: expected
                .expected_card_attestation
                .clone()
                .unwrap_or_else(|| args.binding.clone()),
        }
    });
    if response.vouched {
        LAST_ACCEPTED_CARD.with_borrow_mut(|binding| *binding = Some(response.binding.clone()));
    }
    response
}

#[ic_cdk::update]
fn c2c_attest_ai_app_card_confirmation_v1(
    args: c2c_attest_ai_app_card_confirmation_v1::Args,
) -> c2c_attest_ai_app_card_confirmation_v1::Response {
    CONFIG.with_borrow(|config| {
        let expected = config.as_ref().expect("verifier test canister not initialized");
        let exact = expected.expected_card_confirmation_attestation.as_ref() == Some(&args.binding);
        let fixture = expected.expected_card_confirmation_attestation.is_none()
            && expected.accepted_confirmation_payload.as_ref().is_some_and(|payload| {
                LAST_ACCEPTED_CARD.with_borrow(|card| {
                    card.as_ref()
                        .is_some_and(|card| final_binding_matches_fixture(&args.binding, card, payload))
                })
            });
        let vouched = expected.vouched && (exact || fixture);
        c2c_attest_ai_app_card_confirmation_v1::Response {
            vouched,
            binding: expected
                .expected_card_confirmation_attestation
                .clone()
                .unwrap_or_else(|| args.binding.clone()),
        }
    })
}

fn final_binding_matches_fixture(
    binding: &c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1,
    accepted_card: &c2c_attest_ai_app_card_v1::CardAttestationBindingV1,
    accepted_payload: &[u8],
) -> bool {
    let accepted = &accepted_card.commitment.context;
    let confirmer = &binding.context;
    binding.user_index_canister_id == accepted_card.user_index_canister_id
        && binding.app_canister_id == accepted_card.app_canister_id
        && accepted.context_version == types::APP_SCOPED_CARD_CONTEXT_VERSION_V1
        && confirmer.context_version == accepted.context_version
        && accepted.app_subject.len() == 32
        && confirmer.app_subject.len() == 32
        && accepted.chat_handle.len() == 32
        && confirmer.chat_handle == accepted.chat_handle
        && accepted.message_handle.len() == 32
        && confirmer.message_handle == accepted.message_handle
        && confirmer.app_id == accepted.app_id
        && confirmer.app_revision == accepted.app_revision
        && confirmer.action_id == accepted.action_id
        && binding.content_hash == accepted_card.authority_content_hash
        && binding.confirm_payload.as_ref() == accepted_payload
        && binding.app_user_key_version.is_some()
}

fn card_binding_matches_fixture(
    binding: &c2c_attest_ai_app_card_v1::CardAttestationBindingV1,
    expected: &InitArgs,
    content: &types::AiAppCardContentV1,
) -> bool {
    expected.expected_v2.as_ref().is_some_and(|registration| {
        let context = &binding.commitment.context;
        binding.user_index_canister_id == registration.user_index_canister_id
            && binding.app_canister_id == registration.app_canister_id
            && context.context_version == types::APP_SCOPED_CARD_CONTEXT_VERSION_V1
            && context.app_subject.len() == 32
            && context.chat_handle.len() == 32
            && context.message_handle.len() == 32
            && context.app_id == registration.app_id
            && context.app_revision == registration.app_revision
            && context.action_id == content.action_id
            && binding.commitment.content == *content
            && binding.authority_content_hash != [0; 32]
    })
}

#[derive(CandidType, Deserialize)]
struct ClaimLinkCodeProxyArgs {
    user_index_canister_id: Principal,
    args: user_index_canister::c2c_claim_ai_app_link_code::Args,
}

#[ic_cdk::update]
async fn proxy_c2c_claim_ai_app_link_code(
    proxy: ClaimLinkCodeProxyArgs,
) -> user_index_canister::c2c_claim_ai_app_link_code::Response {
    user_index_canister_c2c_client::c2c_claim_ai_app_link_code(proxy.user_index_canister_id, &proxy.args)
        .await
        .unwrap_or_else(|error| ic_cdk::trap(format!("UserIndex link-code claim transport failed: {error:?}")))
}

#[derive(CandidType, Deserialize)]
struct RevokeUserKeyProxyArgs {
    user_index_canister_id: Principal,
    args: user_index_canister::revoke_ai_app_user_key::Args,
}

#[ic_cdk::update]
async fn proxy_revoke_ai_app_user_key(proxy: RevokeUserKeyProxyArgs) -> user_index_canister::revoke_ai_app_user_key::Response {
    user_index_canister_c2c_client::revoke_ai_app_user_key(proxy.user_index_canister_id, &proxy.args)
        .await
        .unwrap_or_else(|error| ic_cdk::trap(format!("UserIndex key revocation transport failed: {error:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_bytes::ByteBuf;

    const PAYLOAD: &[u8] = br#"{"amount":"$20"}"#;

    fn context(app_subject: u8) -> types::AppScopedCardContext {
        types::AppScopedCardContext {
            context_version: types::APP_SCOPED_CARD_CONTEXT_VERSION_V1,
            app_subject: ByteBuf::from(vec![app_subject; 32]),
            chat_handle: ByteBuf::from(vec![2; 32]),
            message_handle: ByteBuf::from(vec![3; 32]),
            app_id: 7,
            app_revision: 11,
            action_id: "sample.confirm".to_string(),
        }
    }

    fn accepted_card() -> c2c_attest_ai_app_card_v1::CardAttestationBindingV1 {
        c2c_attest_ai_app_card_v1::CardAttestationBindingV1 {
            user_index_canister_id: Principal::from_slice(&[1]),
            app_canister_id: Principal::from_slice(&[2]),
            commitment: c2c_attest_ai_app_card_v1::AppScopedCardContentCommitmentV1 {
                context: context(4),
                content: types::AiAppCardContentV1 {
                    title: "Review operation".to_string(),
                    rows: vec![types::ActionCardRow {
                        label: "Amount".to_string(),
                        value: "$20".to_string(),
                    }],
                    confirm_label: "Confirm".to_string(),
                    cancel_label: "Cancel".to_string(),
                    action_id: "sample.confirm".to_string(),
                    disclosure: None,
                    expires_at: None,
                    confirm_payload: Some(ByteBuf::from(PAYLOAD.to_vec())),
                },
            },
            authority_content_hash: [8; 32],
        }
    }

    fn final_binding() -> c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1 {
        c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1 {
            user_index_canister_id: Principal::from_slice(&[1]),
            app_canister_id: Principal::from_slice(&[2]),
            context: context(9),
            content_hash: [8; 32],
            confirm_payload: ByteBuf::from(PAYLOAD.to_vec()),
            app_user_key_version: Some(2),
        }
    }

    #[test]
    fn accepts_a_different_valid_confirmer_subject_for_the_same_card() {
        let accepted = accepted_card();
        let binding = final_binding();
        assert_ne!(binding.context.app_subject, accepted.commitment.context.app_subject);
        assert!(final_binding_matches_fixture(&binding, &accepted, PAYLOAD));
    }

    #[test]
    fn rejects_payload_mismatch() {
        assert!(!final_binding_matches_fixture(
            &final_binding(),
            &accepted_card(),
            b"different payload"
        ));
    }

    #[test]
    fn rejects_chat_or_message_handle_mismatch() {
        let accepted = accepted_card();
        let mut binding = final_binding();
        binding.context.chat_handle[0] ^= 1;
        assert!(!final_binding_matches_fixture(&binding, &accepted, PAYLOAD));

        let mut binding = final_binding();
        binding.context.message_handle[0] ^= 1;
        assert!(!final_binding_matches_fixture(&binding, &accepted, PAYLOAD));
    }

    #[test]
    fn rejects_missing_per_user_key_version() {
        let mut binding = final_binding();
        binding.app_user_key_version = None;
        assert!(!final_binding_matches_fixture(&binding, &accepted_card(), PAYLOAD));
    }
}

ic_cdk::export_candid!();
