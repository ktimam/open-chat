use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

const ACK_DOMAIN: &[u8] = b"openchat-action-inbox-ack-v1";
const ACK_SECRET_DOMAIN: &[u8] = b"openchat-action-inbox-ack-secret-v1";
pub const ACKNOWLEDGEMENT_SECRET_BYTES: usize = 32;
pub const ACKNOWLEDGEMENT_SECRET_HASH_BYTES: usize = 32;

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub consumer_key_fingerprint: ByteBuf,
    /// Deprecated compatibility field. Live acknowledgements no longer parse this in replicated
    /// execution; possession of the per-action ECIES-encrypted secret is required instead.
    pub consumer_public_key_pem: String,
    /// Delete only the exact retained action with this id. The legacy `through_id` field label is
    /// retained for Candid wire compatibility; it no longer has cursor/range semantics.
    ///
    /// This is deliberately not a cursor: possession of a later action's secret must never
    /// authorize deletion of an earlier action.
    pub through_id: u64,
    /// Raw 64-byte P-256 ECDSA/SHA-256 signature over `acknowledgement_preimage`.
    /// Deprecated compatibility field. It is ignored by the update endpoint.
    pub signature: ByteBuf,
    /// Raw 32-byte bearer secret recovered from the exact action's ECIES plaintext.
    /// Optional keeps pre-capability Candid records decodable; None fails closed for a live action.
    #[serde(default)]
    pub acknowledgement_secret: Option<ByteBuf>,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidRequest(String),
    NotAuthorized,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub acknowledged: u32,
    pub remaining: u32,
}

/// Domain-separated bytes signed by the consumer. Binding the canister prevents cross-deployment
/// replay; binding the fingerprint and action id prevents a proof authorizing any other cleanup.
pub fn acknowledgement_preimage(canister_id: Principal, fingerprint: &[u8], action_id: u64) -> Vec<u8> {
    let canister = canister_id.as_slice();
    let mut bytes = Vec::with_capacity(ACK_DOMAIN.len() + 1 + canister.len() + fingerprint.len() + 8);
    bytes.extend_from_slice(ACK_DOMAIN);
    bytes.push(canister.len() as u8);
    bytes.extend_from_slice(canister);
    bytes.extend_from_slice(fingerprint);
    bytes.extend_from_slice(&action_id.to_le_bytes());
    bytes
}

/// Hash stored beside an opaque action. The random secret itself exists only inside that recipient's
/// ECIES plaintext. Canister and fingerprint binding prevents reuse against another inbox deployment
/// or consumer bucket; the stable action key binds the hash to the exact acknowledged action.
pub fn acknowledgement_secret_hash(
    canister_id: Principal,
    fingerprint: &[u8],
    acknowledgement_secret: &[u8],
) -> [u8; ACKNOWLEDGEMENT_SECRET_HASH_BYTES] {
    let canister = canister_id.as_slice();
    let mut bytes =
        Vec::with_capacity(ACK_SECRET_DOMAIN.len() + 1 + canister.len() + fingerprint.len() + acknowledgement_secret.len());
    bytes.extend_from_slice(ACK_SECRET_DOMAIN);
    bytes.push(canister.len() as u8);
    bytes.extend_from_slice(canister);
    bytes.extend_from_slice(fingerprint);
    bytes.extend_from_slice(acknowledgement_secret);
    sha256::sha256(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::{CandidType, decode_one, encode_one};

    #[test]
    fn acknowledgement_secret_hash_is_bound_to_canister_fingerprint_and_secret() {
        let canister = Principal::from_slice(&[1, 2, 3]);
        let fingerprint = [4; 32];
        let secret = [5; ACKNOWLEDGEMENT_SECRET_BYTES];
        let expected = acknowledgement_secret_hash(canister, &fingerprint, &secret);

        assert_eq!(expected.len(), ACKNOWLEDGEMENT_SECRET_HASH_BYTES);
        assert_ne!(
            expected,
            acknowledgement_secret_hash(Principal::from_slice(&[9]), &fingerprint, &secret)
        );
        assert_ne!(expected, acknowledgement_secret_hash(canister, &[8; 32], &secret));
        assert_ne!(
            expected,
            acknowledgement_secret_hash(canister, &fingerprint, &[7; ACKNOWLEDGEMENT_SECRET_BYTES])
        );
    }

    #[test]
    fn previous_candid_args_decode_with_the_legacy_through_id_field() {
        #[derive(CandidType)]
        struct PreviousArgs {
            consumer_key_fingerprint: ByteBuf,
            consumer_public_key_pem: String,
            through_id: u64,
            signature: ByteBuf,
        }

        let encoded = encode_one(PreviousArgs {
            consumer_key_fingerprint: ByteBuf::from(vec![4; 32]),
            consumer_public_key_pem: "legacy".to_string(),
            through_id: 77,
            signature: ByteBuf::from(vec![5; 64]),
        })
        .unwrap();
        let decoded: Args = decode_one(&encoded).unwrap();

        assert_eq!(decoded.consumer_key_fingerprint.as_ref(), &[4; 32]);
        assert_eq!(decoded.consumer_public_key_pem, "legacy");
        assert_eq!(decoded.through_id, 77);
        assert_eq!(decoded.signature.as_ref(), &[5; 64]);
        assert!(decoded.acknowledgement_secret.is_none());
    }
}
