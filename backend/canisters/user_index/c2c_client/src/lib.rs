use candid::Principal;
use canister_client::generate_c2c_call;
use types::{C2CError, CanisterId, UserDetails};
use user_index_canister::*;

// Queries
generate_c2c_call!(c2c_ai_app_action_route);
generate_c2c_call!(c2c_published_ai_app_ids, 30);
generate_c2c_call!(c2c_lookup_user);
generate_c2c_call!(ai_app_user_keys);
generate_c2c_call!(ai_apps);
generate_c2c_call!(platform_moderators_group);
generate_c2c_call!(user);
generate_c2c_call!(users_chit);

// Updates
generate_c2c_call!(c2c_ai_app_confirmed_action_route);
generate_c2c_call!(c2c_claim_ai_app_link_code);
generate_c2c_call!(c2c_get_ai_app_action_inbox_selector);
generate_c2c_call!(add_local_user_index_canister);
generate_c2c_call!(c2c_deposit_actions);
generate_c2c_call!(c2c_consume_ai_app_card_confirmation_grant);
generate_c2c_call!(c2c_create_ai_app_card_confirmation_grant);
generate_c2c_call!(c2c_create_ai_app_card_capability);
generate_c2c_call!(c2c_validate_ai_app_card_provenance);
generate_c2c_call!(c2c_delete_user);
generate_c2c_call!(c2c_local_user_index, 300);
generate_c2c_call!(c2c_csam_detected);
generate_c2c_call!(c2c_report_message);
generate_c2c_call!(c2c_send_openchat_bot_messages);
generate_c2c_call!(c2c_set_avatar);
generate_c2c_call!(c2c_suspend_users);
generate_c2c_call!(revoke_ai_app_user_key);

pub async fn lookup_user(
    user_id_or_principal: Principal,
    user_index_canister_id: CanisterId,
) -> Result<Option<UserDetails>, C2CError> {
    let args = c2c_lookup_user::Args { user_id_or_principal };

    let response = crate::c2c_lookup_user(user_index_canister_id, &args).await?;

    Ok(if let c2c_lookup_user::Response::Success(user) = response { Some(user) } else { None })
}
