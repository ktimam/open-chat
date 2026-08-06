use candid::{Principal, encode_one};
use serde_bytes::ByteBuf;
use user_index_canister::c2c_redeem_ai_app_chat_link_token::{
    APP_SUBJECT_VERSION_V1, CHAT_HANDLE_VERSION_V1, Response, SuccessResult,
};

#[test]
fn redemption_success_candid_bytes_are_stable() {
    let encoded = encode_one(Response::Success(SuccessResult {
        app_subject: ByteBuf::from(vec![0x11; 32]),
        subject_version: APP_SUBJECT_VERSION_V1,
        app_id: 7,
        app_revision: 11,
        app_canister_id: Principal::from_slice(&[0x2A]),
        app_user_key_version: 13,
        chat_handle: ByteBuf::from(vec![0x22; 32]),
        chat_handle_version: CHAT_HANDLE_VERSION_V1,
    }))
    .unwrap();
    assert_eq!(
        hex::encode(encoded),
        "4449444c056b08a8f7dc3201a888d28c037ffacbddf2037fee82c1ea077fa39bfdac0803cca39e90097fcf82d6ba097fb8bafce40a716c02007a01026e716c08a2e5ea2a78c59cb79e057af9bcce970878f99fbdfe0879cec1e58d0a048892b4880c7ad5f4e3bd0d68ef82b5980f046d7b0100040d0000000000000001000b0000000000000007000000201111111111111111111111111111111111111111111111111111111111111111010001012a202222222222222222222222222222222222222222222222222222222222222222"
    );
}
