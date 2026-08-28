use crate::read_state;
use group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1;
use serde_bytes::ByteBuf;

pub async fn validate(binding: AiAppCardAuthorityBindingV1, token: &ByteBuf) -> Result<AiAppCardAuthorityBindingV1, String> {
    let (caller, group_index_canister_id) = prepare(&binding)?;
    let response = group_index_canister_c2c_client::c2c_validate_ai_app_card_authority_v1(
        group_index_canister_id,
        &group_index_canister::c2c_validate_ai_app_card_authority_v1::Args {
            binding: binding.clone(),
            token: token.clone(),
        },
    )
    .await
    .map_err(|_| "card authority service unavailable".to_string())?;
    revalidate_caller(caller, &binding)?;
    match response {
        group_index_canister::c2c_validate_ai_app_card_authority_v1::Response::Success(result) if result.binding == binding => {
            Ok(result.binding)
        }
        _ => Err("invalid or stale card authority".to_string()),
    }
}

pub async fn consume(binding: AiAppCardAuthorityBindingV1, token: &ByteBuf) -> Result<AiAppCardAuthorityBindingV1, String> {
    let (caller, group_index_canister_id) = prepare(&binding)?;
    let response = group_index_canister_c2c_client::c2c_consume_ai_app_card_authority_v1(
        group_index_canister_id,
        &group_index_canister::c2c_consume_ai_app_card_authority_v1::Args {
            binding: binding.clone(),
            token: token.clone(),
        },
    )
    .await
    .map_err(|_| "card authority service unavailable".to_string())?;
    revalidate_caller(caller, &binding)?;
    match response {
        group_index_canister::c2c_consume_ai_app_card_authority_v1::Response::Success(result) if result.binding == binding => {
            Ok(result.binding)
        }
        _ => Err("invalid, stale, or replayed card authority".to_string()),
    }
}

fn prepare(binding: &AiAppCardAuthorityBindingV1) -> Result<(candid::Principal, types::CanisterId), String> {
    let caller = ic_cdk::api::msg_caller();
    if caller != binding.local_user_index_canister_id {
        return Err("card authority belongs to another LocalUserIndex".to_string());
    }
    read_state(|state| {
        if !state.data.local_index_map.contains_key(&caller) {
            return Err("caller is not a registered LocalUserIndex".to_string());
        }
        Ok((caller, state.data.group_index_canister_id))
    })
}

fn revalidate_caller(caller: candid::Principal, binding: &AiAppCardAuthorityBindingV1) -> Result<(), String> {
    read_state(|state| {
        if caller != binding.local_user_index_canister_id || !state.data.local_index_map.contains_key(&caller) {
            Err("LocalUserIndex authority changed during validation".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1;
    use types::{AiAppCardContext, Chat, MessageId};

    fn binding(owner: candid::Principal) -> AiAppCardAuthorityBindingV1 {
        let group = candid::Principal::from_slice(&[7]);
        AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: owner,
            context: AiAppCardContext {
                user_id: candid::Principal::from_slice(&[8]).into(),
                chat: Chat::Group(group.into()),
                chat_key: format!("group:{group}"),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
                app_id: 1,
                app_revision: 2,
                action_id: "generic.action".to_string(),
            },
            content_hash: [3; 32],
            operation: AiAppCardAuthorityOperationV1::ValidateProvenance {
                provenance_hash: [4; 32],
            },
        }
    }

    #[test]
    fn binding_is_explicitly_scoped_to_one_lui() {
        let owner = candid::Principal::from_slice(&[1]);
        let other = candid::Principal::from_slice(&[2]);
        assert_ne!(binding(owner).local_user_index_canister_id, other);
        let mut forged = binding(owner);
        forged.local_user_index_canister_id = other;
        assert_ne!(forged, binding(owner));
    }
}
