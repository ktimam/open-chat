use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, CanisterId, TimestampMillis};

pub const APP_SUBJECT_VERSION_V1: u16 = 1;
pub const CHAT_HANDLE_VERSION_V1: u16 = 1;

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    /// Exactly 32 bytes, decoded from the canonical base64url launch fragment.
    pub token: ByteBuf,
    /// The app account currently signed in. A mismatch never consumes the token.
    pub expected_app_subject: ByteBuf,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    TokenNotFound,
    TokenExpired,
    NotAuthorized,
    SubjectMismatch,
    AppUnavailable,
    InvalidRequest(String),
    Error(OCError),
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SuccessResult {
    pub app_subject: ByteBuf,
    pub subject_version: u16,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub app_canister_id: CanisterId,
    /// Exact consent/key lifecycle epoch for this user/app binding.
    pub app_user_key_version: u64,
    pub chat_handle: ByteBuf,
    pub chat_handle_version: u16,
    /// Presentation-only label captured by OpenChat when the user explicitly opened setup.
    /// Optional preserves decoding of any short-lived token minted before this field existed.
    pub chat_name: Option<String>,
}
