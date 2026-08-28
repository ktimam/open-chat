use ai_app_verifier_canister::{
    c2c_attest_ai_app_card_confirmation_v1, c2c_attest_ai_app_card_v1, c2c_authorize_ai_action_recipients, c2c_verify_ai_app,
    c2c_verify_ai_app_v2,
};
use candid::{CandidType, Principal};
use serde::Deserialize;
use std::cell::RefCell;

#[derive(Default)]
struct RecipientAuthorizationFixture {
    recipients: Vec<c2c_authorize_ai_action_recipients::AuthorizedRecipient>,
    subsequent_recipients: Option<Vec<c2c_authorize_ai_action_recipients::AuthorizedRecipient>>,
    calls: u64,
}

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
    static RECIPIENT_AUTHORIZATION_FIXTURE: RefCell<RecipientAuthorizationFixture> =
        RefCell::new(RecipientAuthorizationFixture::default());
}

#[ic_cdk::init]
fn init(args: InitArgs) {
    CONFIG.with_borrow_mut(|config| *config = Some(args));
    LAST_ACCEPTED_CARD.with_borrow_mut(|binding| *binding = None);
    RECIPIENT_AUTHORIZATION_FIXTURE.with_borrow_mut(|fixture| *fixture = RecipientAuthorizationFixture::default());
}

#[derive(CandidType, Deserialize)]
struct ProxyClaimLinkCodeArgs {
    user_index_canister_id: Principal,
    args: user_index_canister::c2c_claim_ai_app_link_code::Args,
}

#[derive(CandidType, Deserialize)]
struct ProxyRevokeUserKeyArgs {
    user_index_canister_id: Principal,
    args: user_index_canister::revoke_ai_app_user_key::Args,
}

#[derive(CandidType, Deserialize)]
struct ConfigureAuthorizedRecipientsArgs {
    recipients: Vec<c2c_authorize_ai_action_recipients::AuthorizedRecipient>,
    subsequent_recipients: Option<Vec<c2c_authorize_ai_action_recipients::AuthorizedRecipient>>,
}

/// Test-only ingress bridge: PocketIC ingress callers cannot legitimately impersonate this app
/// canister, so the installed verifier performs the typed canister-to-canister call itself.
#[ic_cdk::update]
async fn proxy_c2c_claim_ai_app_link_code(
    args: ProxyClaimLinkCodeArgs,
) -> user_index_canister::c2c_claim_ai_app_link_code::Response {
    user_index_canister_c2c_client::c2c_claim_ai_app_link_code(args.user_index_canister_id, &args.args)
        .await
        .unwrap_or_else(|error| ic_cdk::trap(&format!("claim link code transport failure: {error:?}")))
}

/// Test-only ingress bridge for the app-authenticated revoke endpoint.
#[ic_cdk::update]
async fn proxy_revoke_ai_app_user_key(args: ProxyRevokeUserKeyArgs) -> user_index_canister::revoke_ai_app_user_key::Response {
    user_index_canister_c2c_client::revoke_ai_app_user_key(args.user_index_canister_id, &args.args)
        .await
        .unwrap_or_else(|error| ic_cdk::trap(&format!("revoke user key transport failure: {error:?}")))
}

/// Test-only fixture configuration. Production apps derive this set from their private account
/// model; this neutral canister stores only caller-supplied opaque test rows.
#[ic_cdk::update]
fn configure_authorized_recipients(args: ConfigureAuthorizedRecipientsArgs) {
    if args.recipients.len() > c2c_authorize_ai_action_recipients::MAX_AUTHORIZED_RECIPIENTS
        || args
            .subsequent_recipients
            .as_ref()
            .is_some_and(|recipients| recipients.len() > c2c_authorize_ai_action_recipients::MAX_AUTHORIZED_RECIPIENTS)
    {
        ic_cdk::trap("too many authorized recipient fixtures");
    }
    RECIPIENT_AUTHORIZATION_FIXTURE.with_borrow_mut(|fixture| {
        *fixture = RecipientAuthorizationFixture {
            recipients: args.recipients,
            subsequent_recipients: args.subsequent_recipients,
            calls: 0,
        };
    });
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
fn c2c_authorize_ai_action_recipients(
    args: c2c_authorize_ai_action_recipients::Args,
) -> c2c_authorize_ai_action_recipients::Response {
    let caller_is_user_index = CONFIG.with_borrow(|config| {
        config
            .as_ref()
            .and_then(|value| value.expected_v2.as_ref())
            .is_some_and(|binding| binding.user_index_canister_id == ic_cdk::api::msg_caller())
    });
    if !caller_is_user_index {
        return c2c_authorize_ai_action_recipients::Response::NotAuthorized;
    }
    RECIPIENT_AUTHORIZATION_FIXTURE.with_borrow_mut(|fixture| {
        let recipients = if fixture.calls == 0 {
            fixture.recipients.clone()
        } else {
            fixture.subsequent_recipients.as_ref().unwrap_or(&fixture.recipients).clone()
        };
        fixture.calls = fixture.calls.saturating_add(1);
        if recipients.is_empty() {
            return c2c_authorize_ai_action_recipients::Response::NotAuthorized;
        }
        let expires_at = match args
            .authorization_created_at
            .checked_add(c2c_authorize_ai_action_recipients::RECIPIENT_AUTHORIZATION_TTL_MILLIS)
        {
            Some(value) => value,
            None => return c2c_authorize_ai_action_recipients::Response::InvalidRequest("expiry overflowed".to_string()),
        };
        c2c_authorize_ai_action_recipients::Response::Success(c2c_authorize_ai_action_recipients::SuccessResult {
            scope_commitment: serde_bytes::ByteBuf::from(recipient_scope_commitment(&args, &recipients).to_vec()),
            recipients,
            expires_at,
        })
    })
}

fn recipient_scope_commitment(
    args: &c2c_authorize_ai_action_recipients::Args,
    recipients: &[c2c_authorize_ai_action_recipients::AuthorizedRecipient],
) -> [u8; 32] {
    let mut bytes = b"openchat/test-recipient-scope/v1\0".to_vec();
    bytes.extend(candid::encode_one(args.clone()).expect("bounded callback args must encode"));
    bytes.extend(candid::encode_one(recipients.to_vec()).expect("bounded recipient fixtures must encode"));
    sha256::sha256(&bytes)
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
            && expected.expected_card_attestation.is_none()
            && expected.accepted_card_content.is_some()
            && expected.accepted_confirmation_payload.as_ref().is_some_and(|payload| {
                LAST_ACCEPTED_CARD.with_borrow(|card| {
                    card.as_ref()
                        .is_some_and(|card| confirmation_binding_matches_fixture(&args.binding, card, payload))
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

fn confirmation_binding_matches_fixture(
    binding: &c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1,
    accepted_card: &c2c_attest_ai_app_card_v1::CardAttestationBindingV1,
    accepted_payload: &[u8],
) -> bool {
    let context = &binding.context;
    let accepted_context = &accepted_card.commitment.context;
    binding.user_index_canister_id == accepted_card.user_index_canister_id
        && binding.app_canister_id == accepted_card.app_canister_id
        && context.context_version == accepted_context.context_version
        && context.app_subject.len() == 32
        && context.chat_handle == accepted_context.chat_handle
        && context.message_handle == accepted_context.message_handle
        && context.app_id == accepted_context.app_id
        && context.app_revision == accepted_context.app_revision
        && context.action_id == accepted_context.action_id
        && binding.content_hash == accepted_card.authority_content_hash
        && binding.confirm_payload.as_ref() == accepted_payload
        && binding.app_user_key_version.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ai_app_verifier_canister::c2c_attest_ai_app_card_v1::AppScopedCardContentCommitmentV1;
    use serde_bytes::ByteBuf;
    use types::{AiAppCardContentV1, AppScopedCardContext};

    const ACCEPTED_PAYLOAD: &[u8] = br#"{"approved":true}"#;

    fn context(app_subject: u8) -> AppScopedCardContext {
        AppScopedCardContext {
            context_version: types::APP_SCOPED_CARD_CONTEXT_VERSION_V1,
            app_subject: ByteBuf::from(vec![app_subject; 32]),
            chat_handle: ByteBuf::from(vec![3; 32]),
            message_handle: ByteBuf::from(vec![4; 32]),
            app_id: 7,
            app_revision: 8,
            action_id: "sample.confirm".to_string(),
        }
    }

    fn accepted_card() -> c2c_attest_ai_app_card_v1::CardAttestationBindingV1 {
        c2c_attest_ai_app_card_v1::CardAttestationBindingV1 {
            user_index_canister_id: Principal::from_slice(&[1]),
            app_canister_id: Principal::from_slice(&[2]),
            commitment: AppScopedCardContentCommitmentV1 {
                context: context(5),
                content: AiAppCardContentV1 {
                    title: "Review".to_string(),
                    rows: Vec::new(),
                    confirm_label: "Confirm".to_string(),
                    cancel_label: "Cancel".to_string(),
                    action_id: "sample.confirm".to_string(),
                    disclosure: None,
                    expires_at: None,
                    confirm_payload: Some(ByteBuf::from(ACCEPTED_PAYLOAD.to_vec())),
                },
            },
            authority_content_hash: [6; 32],
        }
    }

    fn confirmation() -> c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1 {
        c2c_attest_ai_app_card_confirmation_v1::CardConfirmationAttestationBindingV1 {
            user_index_canister_id: Principal::from_slice(&[1]),
            app_canister_id: Principal::from_slice(&[2]),
            context: context(9),
            content_hash: [6; 32],
            confirm_payload: ByteBuf::from(ACCEPTED_PAYLOAD.to_vec()),
            app_user_key_version: Some(2),
        }
    }

    #[test]
    fn final_fixture_accepts_a_different_confirmer_subject() {
        let card = accepted_card();
        let binding = confirmation();
        assert_ne!(binding.context.app_subject, card.commitment.context.app_subject);
        assert!(confirmation_binding_matches_fixture(&binding, &card, ACCEPTED_PAYLOAD));
    }

    #[test]
    fn final_fixture_rejects_a_payload_mismatch() {
        let mut binding = confirmation();
        binding.confirm_payload = ByteBuf::from(b"changed".to_vec());
        assert!(!confirmation_binding_matches_fixture(
            &binding,
            &accepted_card(),
            ACCEPTED_PAYLOAD
        ));
    }

    #[test]
    fn final_fixture_rejects_chat_or_message_handle_mismatch() {
        let card = accepted_card();
        let mut chat_changed = confirmation();
        chat_changed.context.chat_handle = ByteBuf::from(vec![10; 32]);
        assert!(!confirmation_binding_matches_fixture(&chat_changed, &card, ACCEPTED_PAYLOAD));

        let mut message_changed = confirmation();
        message_changed.context.message_handle = ByteBuf::from(vec![11; 32]);
        assert!(!confirmation_binding_matches_fixture(
            &message_changed,
            &card,
            ACCEPTED_PAYLOAD
        ));
    }

    #[test]
    fn final_fixture_requires_a_per_user_key_version() {
        let mut binding = confirmation();
        binding.app_user_key_version = None;
        assert!(!confirmation_binding_matches_fixture(
            &binding,
            &accepted_card(),
            ACCEPTED_PAYLOAD
        ));
    }
}

ic_cdk::export_candid!();
