use crate::read_state;
use group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
use serde_bytes::ByteBuf;

pub async fn consume(
    binding: AiAppChatLinkAuthorityBindingV1,
    token: &ByteBuf,
) -> Result<AiAppChatLinkAuthorityBindingV1, String> {
    let (caller, group_index_canister_id) = prepare(&binding)?;
    let response = group_index_canister_c2c_client::c2c_consume_ai_app_chat_link_authority_v1(
        group_index_canister_id,
        &group_index_canister::c2c_consume_ai_app_chat_link_authority_v1::Args {
            binding: binding.clone(),
            token: token.clone(),
        },
    )
    .await
    .map_err(|_| "chat-link authority service unavailable".to_string())?;
    revalidate_caller(caller, &binding)?;
    match response {
        group_index_canister::c2c_consume_ai_app_chat_link_authority_v1::Response::Success(result)
            if result.binding == binding =>
        {
            Ok(result.binding)
        }
        _ => Err("invalid, stale, or replayed chat-link authority".to_string()),
    }
}

fn prepare(binding: &AiAppChatLinkAuthorityBindingV1) -> Result<(candid::Principal, types::CanisterId), String> {
    let caller = ic_cdk::api::msg_caller();
    if caller != binding.local_user_index_canister_id {
        return Err("chat-link authority belongs to another LocalUserIndex".to_string());
    }
    read_state(|state| {
        if !state.data.local_index_map.contains_key(&caller) {
            return Err("caller is not a registered LocalUserIndex".to_string());
        }
        Ok((caller, state.data.group_index_canister_id))
    })
}

fn revalidate_caller(caller: candid::Principal, binding: &AiAppChatLinkAuthorityBindingV1) -> Result<(), String> {
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
    use types::{Chat, UserId};

    #[test]
    fn binding_is_explicitly_scoped_to_one_lui_without_card_fields() {
        let owner = candid::Principal::from_slice(&[1]);
        let other = candid::Principal::from_slice(&[2]);
        let binding = AiAppChatLinkAuthorityBindingV1 {
            local_user_index_canister_id: owner,
            user_id: UserId::from(candid::Principal::from_slice(&[8])),
            chat: Chat::Group(candid::Principal::from_slice(&[7]).into()),
            app_id: 1,
            app_revision: 2,
        };
        let mut forged = binding.clone();
        forged.local_user_index_canister_id = other;
        assert_ne!(forged, binding);
    }
}
