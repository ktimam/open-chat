use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_card_tokens::{ConsumeProvenanceResult, ProvenanceStatus, TOKEN_BYTES};
use crate::updates::create_ai_app_card_provenance::{canonical_non_direct_chat_key, resolve_current_card_app};
use crate::{mutate_state, read_state};
use canister_api_macros::update;
use user_index_canister::c2c_validate_ai_app_card_provenance::{Response::*, *};

#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_validate_ai_app_card_provenance(args: Args) -> Response {
    if !read_state(crate::pr2_entropy::is_ready) {
        return Error("card provenance service temporarily unavailable".to_string());
    }
    let binding = group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: ic_cdk::api::msg_caller(),
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::ValidateProvenance {
            provenance_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::Provenance,
                &args.provenance,
            ),
        },
    };
    if crate::ai_app_card_authority::consume(binding, &args.authority).await.is_err() {
        return InvalidRequest("invalid or replayed card authority".to_string());
    }
    mutate_state(|state| {
        if !crate::pr2_entropy::is_ready(state) {
            return Error("card provenance service temporarily unavailable".to_string());
        }
        if args.provenance.len() != TOKEN_BYTES {
            return InvalidProvenance;
        }
        let chat_key = match canonical_non_direct_chat_key(args.context.chat) {
            Ok(value) => value,
            Err(error) => return InvalidRequest(error),
        };
        if chat_key != args.context.chat_key {
            return InvalidRequest("non-canonical chat key".to_string());
        }
        let this_canister_id = state.env.canister_id();
        let now = state.env.now();
        let status = state.data.ai_app_card_tokens.provenance_status(
            this_canister_id,
            &args.provenance,
            &args.context,
            &args.content_hash,
            now,
        );
        match status {
            ProvenanceStatus::Expired | ProvenanceStatus::NotFound | ProvenanceStatus::ContextMismatch => {
                return InvalidProvenance;
            }
            ProvenanceStatus::Active | ProvenanceStatus::AlreadyValidated => {}
        }
        if resolve_current_card_app(
            &state.data.ai_apps,
            args.context.app_id,
            args.context.app_revision,
            &args.context.action_id,
        )
        .is_none()
        {
            return AppUnavailable;
        }
        if status == ProvenanceStatus::AlreadyValidated {
            return Success;
        }
        match state.data.ai_app_card_tokens.consume_provenance(
            this_canister_id,
            &args.provenance,
            &args.context,
            &args.content_hash,
            now,
        ) {
            ConsumeProvenanceResult::Valid | ConsumeProvenanceResult::AlreadyValidated => Success,
            ConsumeProvenanceResult::Expired | ConsumeProvenanceResult::NotFound | ConsumeProvenanceResult::ContextMismatch => {
                InvalidProvenance
            }
        }
    })
}
