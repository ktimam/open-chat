use serde::{Deserialize, Serialize};
use types::{AiAppCardContext, CanisterId};

pub const AI_APP_CARD_AUTHORITY_TOKEN_BYTES: usize = 32;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum OpaqueHashPurposeV1 {
    AuthorityToken = 1,
    Provenance = 2,
    RecipientPublicKey = 3,
    ConfirmationGrant = 4,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum AiAppCardAuthorityOperationV1 {
    ValidateProvenance {
        provenance_hash: [u8; 32],
    },
    CreatePrivateContextCapability {
        recipient_key_scheme: String,
        recipient_public_key_hash: [u8; 32],
    },
    CreateConfirmationGrant {
        confirm_payload_hash: [u8; 32],
    },
    ConsumeConfirmationGrant {
        confirm_payload_hash: [u8; 32],
        confirmation_grant_hash: [u8; 32],
        confirmation_lease_generation: u64,
    },
    DepositConfirmedAction {
        confirm_payload_hash: [u8; 32],
        confirmation_lease_generation: u64,
        created_at: types::TimestampMillis,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiAppCardAuthorityBindingV1 {
    pub local_user_index_canister_id: CanisterId,
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub operation: AiAppCardAuthorityOperationV1,
}

pub fn opaque_hash_v1(purpose: OpaqueHashPurposeV1, value: &[u8]) -> [u8; 32] {
    const DOMAIN: &[u8] = b"openchat.ai-app-card-authority.opaque.v1\0";
    let mut bytes = Vec::with_capacity(DOMAIN.len() + 1 + 8 + value.len());
    bytes.extend_from_slice(DOMAIN);
    bytes.push(purpose as u8);
    bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
    bytes.extend_from_slice(value);
    sha256::sha256(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_hashes_are_purpose_separated_and_length_delimited() {
        let value = b"same opaque bytes";
        assert_ne!(
            opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, value),
            opaque_hash_v1(OpaqueHashPurposeV1::Provenance, value)
        );
        assert_ne!(
            opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, b"ab"),
            opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, b"a\0b")
        );
    }
}
