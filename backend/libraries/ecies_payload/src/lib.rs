//! Generic ECIES envelope: encrypt an opaque payload to a recipient's P-256 public key so it can be stored
//! on-chain (in public canister state) yet read only by the holder of the matching private key. The scheme
//! is fixed so a Rust canister and a browser (Web Crypto + HKDF) can both implement it:
//!
//!   shared      = ECDH(ephemeral_sk, recipient_pk)            // P-256
//!   okm(44)     = HKDF-SHA256(ikm = shared, salt = "", info = INFO)
//!   key(32)     = okm[0..32]
//!   nonce(12)   = okm[32..44]
//!   ciphertext  = AES-256-GCM(key, nonce, plaintext)
//!   wire        = { ephemeral_public_key (65-byte uncompressed SEC1), ciphertext }
//!
//! The legacy generic envelope helper retains its v3 preimage for existing callers. Confirmed app-card
//! deposits use the separate v4 contract below: UserIndex signs every security-relevant outer field
//! with a dedicated purpose-specific key after consuming authoritative card context.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use candid::{CandidType, Principal};
use hkdf::Hkdf;
use p256::PublicKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::DecodePublicKey;
use rand_core::CryptoRngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// HKDF `info` label; bumping it versions the wire format.
const INFO: &[u8] = b"oc-action-inbox-v1";
/// Domain/key-usage contract for signatures made with OpenChat's shared P-256 signing key. The NUL
/// terminator keeps this binary preimage disjoint from JWT signing inputs (base64url header.payload).
pub const ACTION_INBOX_SIGNATURE_DOMAIN_V3: &[u8] = b"openchat/action-inbox/ecies-envelope-signature/v3\0";
/// Purpose-specific signature contract for app-card deposits. Unlike the legacy v3 envelope-only
/// preimage, v4 binds the exact authoritative route and every security-relevant outer commitment.
pub const ACTION_INBOX_SIGNATURE_DOMAIN_V4: &[u8] = b"openchat/action-inbox/deposit-signature/v4\0";
pub const ACTION_INBOX_SIGNATURE_VERSION_V4: u16 = 4;
pub const ACTION_INBOX_SIGNATURE_PURPOSE_DEPOSIT: u8 = 1;
pub const ACTION_SIGNING_KEY_ID_BYTES: usize = 32;
const ACTION_SIGNING_KEY_ID_DOMAIN_V1: &[u8] = b"openchat/action-inbox/signing-key-id/v1\0";
pub const ACTION_CARD_CONTEXT_HASH_BYTES: usize = 32;
const ACTION_CARD_CONTEXT_HASH_DOMAIN_V1: &[u8] = b"openchat/action-inbox/card-context/v1\0";
const ACTION_CARD_CONTEXT_HASH_DOMAIN_V2: &[u8] = b"openchat/action-inbox/card-context/v2\0";

/// Private card context authenticated by GroupIndex but exposed to consumers only as a commitment.
/// UserIndex hashes the consumed authority binding, and consumers recompute the same digest from the
/// decrypted v4 envelope. All integers are big-endian and all variable fields are u32-length-prefixed.
pub struct ActionCardContextCommitment<'a> {
    pub confirmed_by: Principal,
    pub chat_key: &'a str,
    pub thread_root_message_index: Option<u32>,
    pub message_id: u64,
    pub app_id: u32,
    pub app_revision: u64,
    pub action_id: &'a str,
    pub content_hash: &'a [u8],
    pub confirmation_lease_generation: u64,
    pub created_at: u64,
    pub payload_hash: &'a [u8],
}

pub fn action_card_context_hash_v1(context: &ActionCardContextCommitment<'_>) -> Result<[u8; 32], String> {
    const HASH_BYTES: usize = 32;
    if context.content_hash.len() != HASH_BYTES || context.payload_hash.len() != HASH_BYTES {
        return Err("content_hash and payload_hash must both be exactly 32 bytes".to_string());
    }
    fn put_bytes(out: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
        let length = u32::try_from(value.len()).map_err(|_| "card context field is too long".to_string())?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(value);
        Ok(())
    }

    let mut canonical = Vec::new();
    canonical.extend_from_slice(ACTION_CARD_CONTEXT_HASH_DOMAIN_V1);
    put_bytes(&mut canonical, context.confirmed_by.as_slice())?;
    put_bytes(&mut canonical, context.chat_key.as_bytes())?;
    match context.thread_root_message_index {
        None => canonical.push(0),
        Some(index) => {
            canonical.push(1);
            canonical.extend_from_slice(&index.to_be_bytes());
        }
    }
    canonical.extend_from_slice(&context.message_id.to_be_bytes());
    canonical.extend_from_slice(&context.app_id.to_be_bytes());
    canonical.extend_from_slice(&context.app_revision.to_be_bytes());
    put_bytes(&mut canonical, context.action_id.as_bytes())?;
    canonical.extend_from_slice(context.content_hash);
    canonical.extend_from_slice(&context.confirmation_lease_generation.to_be_bytes());
    canonical.extend_from_slice(&context.created_at.to_be_bytes());
    canonical.extend_from_slice(context.payload_hash);
    Ok(Sha256::digest(canonical).into())
}

/// App-scoped card context authenticated by UserIndex and disclosed to the exact registered app.
/// The three 32-byte handles are dedicated-key HMAC pseudonyms; no global user principal or raw
/// OpenChat chat/message coordinate enters this portable consumer commitment.
pub struct AppScopedActionCardContextCommitment<'a> {
    pub context_version: u16,
    pub app_subject: &'a [u8],
    pub chat_handle: &'a [u8],
    pub message_handle: &'a [u8],
    pub app_id: u32,
    pub app_revision: u64,
    pub action_id: &'a str,
    pub content_hash: &'a [u8],
    pub confirmation_lease_generation: u64,
    pub created_at: u64,
    pub payload_hash: &'a [u8],
}

/// Canonical context commitment for app-scoped confirmed-action envelopes. Fixed-width fields are
/// validated and appended directly; `action_id` is u32-length-prefixed and all integers are
/// big-endian so browser and Rust consumers can reproduce the exact digest.
pub fn action_card_context_hash_v2(
    context: &AppScopedActionCardContextCommitment<'_>,
) -> Result<[u8; ACTION_CARD_CONTEXT_HASH_BYTES], String> {
    for (name, value) in [
        ("app_subject", context.app_subject),
        ("chat_handle", context.chat_handle),
        ("message_handle", context.message_handle),
        ("content_hash", context.content_hash),
        ("payload_hash", context.payload_hash),
    ] {
        if value.len() != ACTION_CARD_CONTEXT_HASH_BYTES {
            return Err(format!("{name} must be exactly {ACTION_CARD_CONTEXT_HASH_BYTES} bytes"));
        }
    }
    let action_id_length =
        u32::try_from(context.action_id.len()).map_err(|_| "card context action id is too long".to_string())?;

    let mut canonical = Vec::new();
    canonical.extend_from_slice(ACTION_CARD_CONTEXT_HASH_DOMAIN_V2);
    canonical.extend_from_slice(&context.context_version.to_be_bytes());
    canonical.extend_from_slice(context.app_subject);
    canonical.extend_from_slice(context.chat_handle);
    canonical.extend_from_slice(context.message_handle);
    canonical.extend_from_slice(&context.app_id.to_be_bytes());
    canonical.extend_from_slice(&context.app_revision.to_be_bytes());
    canonical.extend_from_slice(&action_id_length.to_be_bytes());
    canonical.extend_from_slice(context.action_id.as_bytes());
    canonical.extend_from_slice(context.content_hash);
    canonical.extend_from_slice(&context.confirmation_lease_generation.to_be_bytes());
    canonical.extend_from_slice(&context.created_at.to_be_bytes());
    canonical.extend_from_slice(context.payload_hash);
    Ok(Sha256::digest(canonical).into())
}

/// All authoritative outer context committed by an action-inbox deposit signature. Variable-width
/// fields are length-prefixed and fixed-width fields are validated before encoding, so there is one
/// canonical preimage for a logical deposit in every implementation.
pub struct ActionSignatureContext<'a> {
    pub key_id: &'a [u8],
    pub user_index_canister_id: Principal,
    pub inbox_canister_id: Principal,
    pub app_id: u32,
    pub app_revision: u64,
    pub action_id: &'a str,
    pub card_context_hash: &'a [u8],
    pub consumer_key_fingerprint: &'a [u8],
    pub idempotency_key: &'a [u8],
    pub payload_hash: &'a [u8],
    pub acknowledgement_secret_hash: &'a [u8],
    pub ephemeral_public_key: &'a [u8],
    pub ciphertext: &'a [u8],
    pub created_at: u64,
}

/// Stable, purpose-scoped identifier for an action-signing public key. This is intentionally not
/// the consumer-key fingerprint namespace even though both use SHA-256 over a canonical SEC1 point.
pub fn action_signing_key_id(public_key_pem: &str) -> Result<[u8; ACTION_SIGNING_KEY_ID_BYTES], String> {
    let public_key = PublicKey::from_public_key_pem(public_key_pem).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    digest.update(ACTION_SIGNING_KEY_ID_DOMAIN_V1);
    digest.update(public_key.to_encoded_point(false).as_bytes());
    Ok(digest.finalize().into())
}

/// Exact v4 bytes signed by UserIndex after it resolves the authoritative app/inbox route.
pub fn action_signature_preimage_v4(context: &ActionSignatureContext<'_>) -> Result<Vec<u8>, String> {
    const HASH_BYTES: usize = 32;
    const EPHEMERAL_KEY_BYTES: usize = 65;
    for (name, bytes, expected) in [
        ("key_id", context.key_id, ACTION_SIGNING_KEY_ID_BYTES),
        ("card_context_hash", context.card_context_hash, ACTION_CARD_CONTEXT_HASH_BYTES),
        ("consumer_key_fingerprint", context.consumer_key_fingerprint, HASH_BYTES),
        ("idempotency_key", context.idempotency_key, HASH_BYTES),
        ("payload_hash", context.payload_hash, HASH_BYTES),
        ("acknowledgement_secret_hash", context.acknowledgement_secret_hash, HASH_BYTES),
        ("ephemeral_public_key", context.ephemeral_public_key, EPHEMERAL_KEY_BYTES),
    ] {
        if bytes.len() != expected {
            return Err(format!("{name} must be exactly {expected} bytes"));
        }
    }
    let action_id_len = u16::try_from(context.action_id.len()).map_err(|_| "action_id is too long".to_string())?;
    let ciphertext_len = u32::try_from(context.ciphertext.len()).map_err(|_| "ciphertext is too long".to_string())?;
    if context.ciphertext.is_empty() {
        return Err("ciphertext must not be empty".to_string());
    }
    let user_index = context.user_index_canister_id.as_slice();
    let inbox = context.inbox_canister_id.as_slice();
    let user_index_len = u8::try_from(user_index.len()).map_err(|_| "UserIndex principal is too long".to_string())?;
    let inbox_len = u8::try_from(inbox.len()).map_err(|_| "ActionInbox principal is too long".to_string())?;

    let mut preimage = Vec::with_capacity(
        ACTION_INBOX_SIGNATURE_DOMAIN_V4.len()
            + 3
            + ACTION_SIGNING_KEY_ID_BYTES
            + 2
            + user_index.len()
            + inbox.len()
            + 4
            + 8
            + 2
            + context.action_id.len()
            + HASH_BYTES * 5
            + EPHEMERAL_KEY_BYTES
            + 4
            + context.ciphertext.len()
            + 8,
    );
    preimage.extend_from_slice(ACTION_INBOX_SIGNATURE_DOMAIN_V4);
    preimage.extend_from_slice(&ACTION_INBOX_SIGNATURE_VERSION_V4.to_le_bytes());
    preimage.push(ACTION_INBOX_SIGNATURE_PURPOSE_DEPOSIT);
    preimage.extend_from_slice(context.key_id);
    preimage.push(user_index_len);
    preimage.extend_from_slice(user_index);
    preimage.push(inbox_len);
    preimage.extend_from_slice(inbox);
    preimage.extend_from_slice(&context.app_id.to_le_bytes());
    preimage.extend_from_slice(&context.app_revision.to_le_bytes());
    preimage.extend_from_slice(&action_id_len.to_le_bytes());
    preimage.extend_from_slice(context.action_id.as_bytes());
    preimage.extend_from_slice(context.card_context_hash);
    preimage.extend_from_slice(context.consumer_key_fingerprint);
    preimage.extend_from_slice(context.idempotency_key);
    preimage.extend_from_slice(context.payload_hash);
    preimage.extend_from_slice(context.acknowledgement_secret_hash);
    preimage.extend_from_slice(context.ephemeral_public_key);
    preimage.extend_from_slice(&ciphertext_len.to_le_bytes());
    preimage.extend_from_slice(context.ciphertext);
    preimage.extend_from_slice(&context.created_at.to_le_bytes());
    Ok(preimage)
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct EciesEnvelope {
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

impl EciesEnvelope {
    /// The exact bytes signed for provenance (preimage v3):
    /// ACTION_INBOX_SIGNATURE_DOMAIN_V3 ‖ ephemeral_public_key ‖ ciphertext ‖
    /// created_at (u64 little-endian, 8 bytes).
    ///
    /// v3 adds an explicit domain because this key also signs JWTs and other platform payloads.
    /// Pre-v3 entries become unverifiable; this format has only been used in local development and
    /// its activation remains disabled.
    pub fn signing_preimage(&self, created_at: u64) -> Vec<u8> {
        let mut preimage = Vec::with_capacity(
            ACTION_INBOX_SIGNATURE_DOMAIN_V3.len() + self.ephemeral_public_key.len() + self.ciphertext.len() + 8,
        );
        preimage.extend_from_slice(ACTION_INBOX_SIGNATURE_DOMAIN_V3);
        preimage.extend_from_slice(&self.ephemeral_public_key);
        preimage.extend_from_slice(&self.ciphertext);
        preimage.extend_from_slice(&created_at.to_le_bytes());
        preimage
    }
}

fn derive_key_and_nonce(shared_secret: &[u8]) -> Result<([u8; 32], [u8; 12]), String> {
    let hkdf = Hkdf::<Sha256>::new(None, shared_secret);
    let mut okm = [0u8; 44];
    hkdf.expand(INFO, &mut okm).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    let mut nonce = [0u8; 12];
    key.copy_from_slice(&okm[..32]);
    nonce.copy_from_slice(&okm[32..]);
    Ok((key, nonce))
}

/// Stable routing key for a consumer: SHA-256 of the P-256 public key's uncompressed SEC1 point (the 65-byte
/// `0x04 ‖ X ‖ Y`). Both the depositor (this Rust side) and the consumer (its client) compute it identically
/// so deposits route to the right inbox slot. The raw point is used (not the SPKI DER) so the digest is
/// independent of how each stack encodes the SubjectPublicKeyInfo algorithm OID (WebCrypto may tag an ECDH
/// key differently than `p256`). The consumer computes `sha256(crypto.subtle.exportKey("raw", pubKey))`.
pub fn key_fingerprint(public_key_pem: &str) -> Result<[u8; 32], String> {
    let pk = PublicKey::from_public_key_pem(public_key_pem).map_err(|e| e.to_string())?;
    Ok(Sha256::digest(pk.to_encoded_point(false).as_bytes()).into())
}

/// Encrypt `plaintext` to `recipient_public_key_pem` (a P-256 SubjectPublicKeyInfo PEM).
pub fn encrypt(
    plaintext: &[u8],
    recipient_public_key_pem: &str,
    rng: &mut impl CryptoRngCore,
) -> Result<EciesEnvelope, String> {
    let recipient_pk = PublicKey::from_public_key_pem(recipient_public_key_pem).map_err(|e| e.to_string())?;

    let ephemeral_sk = p256::SecretKey::random(rng);
    let ephemeral_pk = ephemeral_sk.public_key();

    let shared = p256::ecdh::diffie_hellman(ephemeral_sk.to_nonzero_scalar(), recipient_pk.as_affine());
    let (key, nonce) = derive_key_and_nonce(shared.raw_secret_bytes())?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| format!("aes-gcm encrypt: {e}"))?;

    Ok(EciesEnvelope {
        ephemeral_public_key: ephemeral_pk.to_encoded_point(false).as_bytes().to_vec(),
        ciphertext,
    })
}

/// Reference decrypt (the production consumer decrypts in its own client; this mirrors the scheme exactly
/// for tests and integration assertions). `recipient_secret_key_pem` is a P-256 PKCS#8 PEM.
pub fn decrypt(envelope: &EciesEnvelope, recipient_secret_key_pem: &str) -> Result<Vec<u8>, String> {
    use p256::pkcs8::DecodePrivateKey;

    let recipient_sk = p256::SecretKey::from_pkcs8_pem(recipient_secret_key_pem).map_err(|e| e.to_string())?;
    let ephemeral_pk = PublicKey::from_sec1_bytes(&envelope.ephemeral_public_key).map_err(|e| e.to_string())?;

    let shared = p256::ecdh::diffie_hellman(recipient_sk.to_nonzero_scalar(), ephemeral_pk.as_affine());
    let (key, nonce) = derive_key_and_nonce(shared.raw_secret_bytes())?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(&nonce), envelope.ciphertext.as_slice())
        .map_err(|e| format!("aes-gcm decrypt: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::{Signature, VerifyingKey};
    use p256::pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding};
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    fn signature_context<'a>(
        ciphertext: &'a [u8],
        ephemeral_public_key: &'a [u8],
        inbox: Principal,
    ) -> ActionSignatureContext<'a> {
        ActionSignatureContext {
            key_id: &[0x11; 32],
            user_index_canister_id: Principal::from_slice(&[1, 2, 3]),
            inbox_canister_id: inbox,
            app_id: 0x0102_0304,
            app_revision: 0x0102_0304_0506_0708,
            action_id: "expense.import",
            card_context_hash: &[0x22; 32],
            consumer_key_fingerprint: &[0x33; 32],
            idempotency_key: &[0x44; 32],
            payload_hash: &[0x55; 32],
            acknowledgement_secret_hash: &[0x66; 32],
            ephemeral_public_key,
            ciphertext,
            created_at: 0x1112_1314_1516_1718,
        }
    }

    #[test]
    fn v4_signature_preimage_matches_the_cross_implementation_golden_vector() {
        let ciphertext = [0x80, 0x00, 0xff, 0x01];
        let ephemeral_public_key = [&[0x04][..], &[0x77; 64]].concat();
        let preimage = action_signature_preimage_v4(&signature_context(
            &ciphertext,
            &ephemeral_public_key,
            Principal::from_slice(&[4, 5, 6, 7]),
        ))
        .unwrap();

        assert_eq!(preimage.len(), 356);
        assert_eq!(
            <[u8; 32]>::from(Sha256::digest(&preimage)),
            [
                0x65, 0x0b, 0x89, 0x91, 0x8e, 0x00, 0xa6, 0x25, 0xe8, 0x43, 0xf0, 0x61, 0x51, 0xfb, 0xfd, 0xbd, 0x2d, 0x2a,
                0xf9, 0x70, 0xe7, 0x4b, 0xdc, 0x45, 0x30, 0x7f, 0x32, 0xc4, 0x71, 0xef, 0x33, 0x89,
            ]
        );

        let changed_ciphertext = action_signature_preimage_v4(&signature_context(
            &[0x80, 0x00, 0xff, 0x02],
            &ephemeral_public_key,
            Principal::from_slice(&[4, 5, 6, 7]),
        ))
        .unwrap();
        let changed_inbox = action_signature_preimage_v4(&signature_context(
            &ciphertext,
            &ephemeral_public_key,
            Principal::from_slice(&[4, 5, 6, 8]),
        ))
        .unwrap();
        assert_ne!(Sha256::digest(&preimage), Sha256::digest(changed_ciphertext));
        assert_ne!(Sha256::digest(&preimage), Sha256::digest(changed_inbox));
    }

    #[test]
    fn private_card_context_commitment_matches_the_cross_implementation_golden_vector() {
        let digest = action_card_context_hash_v1(&ActionCardContextCommitment {
            confirmed_by: Principal::from_slice(&[9, 8, 7]),
            chat_key: "group:aaaaa-aa",
            thread_root_message_index: Some(42),
            message_id: 123_456_789,
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            content_hash: &[0xaa; 32],
            confirmation_lease_generation: 3,
            created_at: 1_720_000_000_000,
            payload_hash: &[0xbb; 32],
        })
        .unwrap();
        assert_eq!(
            digest,
            [
                0x89, 0x60, 0x1a, 0xd8, 0xbf, 0xb6, 0x8c, 0xae, 0xa5, 0x28, 0xff, 0x28, 0x15, 0x65, 0x92, 0x65, 0x3a, 0xde,
                0x40, 0x74, 0xde, 0xde, 0x9a, 0x5f, 0x01, 0x0e, 0xcb, 0xd4, 0x4b, 0x16, 0xe1, 0x0a,
            ]
        );

        let changed = action_card_context_hash_v1(&ActionCardContextCommitment {
            confirmed_by: Principal::from_slice(&[9, 8, 7]),
            chat_key: "group:aaaaa-aa",
            thread_root_message_index: None,
            message_id: 123_456_789,
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            content_hash: &[0xaa; 32],
            confirmation_lease_generation: 3,
            created_at: 1_720_000_000_000,
            payload_hash: &[0xbb; 32],
        })
        .unwrap();
        assert_ne!(digest, changed);
    }

    #[test]
    fn app_scoped_card_context_commitment_matches_the_cross_implementation_golden_vector() {
        let context = AppScopedActionCardContextCommitment {
            context_version: 1,
            app_subject: &[1; 32],
            chat_handle: &[2; 32],
            message_handle: &[3; 32],
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            content_hash: &[0xaa; 32],
            confirmation_lease_generation: 3,
            created_at: 1_720_000_000_000,
            payload_hash: &[0xbb; 32],
        };
        let digest = action_card_context_hash_v2(&context).unwrap();
        assert_eq!(
            digest,
            [
                0x31, 0x2d, 0xa5, 0xd5, 0xab, 0x8e, 0x3d, 0x67, 0xc5, 0x6b, 0x0e, 0x90, 0x31, 0x3d, 0xac, 0x5d, 0x68, 0x0a,
                0x1a, 0x83, 0x45, 0xd1, 0x4c, 0x39, 0xfe, 0xec, 0xd9, 0xb0, 0x54, 0x49, 0x24, 0x67,
            ]
        );

        let changed_chat = AppScopedActionCardContextCommitment {
            chat_handle: &[4; 32],
            ..context
        };
        assert_ne!(digest, action_card_context_hash_v2(&changed_chat).unwrap());
    }

    #[test]
    fn app_scoped_context_commitment_rejects_noncanonical_handles() {
        let context = AppScopedActionCardContextCommitment {
            context_version: 1,
            app_subject: &[1; 31],
            chat_handle: &[2; 32],
            message_handle: &[3; 32],
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            content_hash: &[0xaa; 32],
            confirmation_lease_generation: 3,
            created_at: 1_720_000_000_000,
            payload_hash: &[0xbb; 32],
        };
        assert_eq!(
            action_card_context_hash_v2(&context).unwrap_err(),
            "app_subject must be exactly 32 bytes"
        );
    }

    #[test]
    fn v4_preimage_rejects_noncanonical_fixed_width_fields() {
        let bad = ActionSignatureContext {
            key_id: &[0x11; 31],
            user_index_canister_id: Principal::from_slice(&[1]),
            inbox_canister_id: Principal::from_slice(&[2]),
            app_id: 1,
            app_revision: 2,
            action_id: "a",
            card_context_hash: &[0x22; 32],
            consumer_key_fingerprint: &[0x33; 32],
            idempotency_key: &[0x44; 32],
            payload_hash: &[0x55; 32],
            acknowledgement_secret_hash: &[0x66; 32],
            ephemeral_public_key: &[0x04; 65],
            ciphertext: &[1],
            created_at: 3,
        };
        assert_eq!(
            action_signature_preimage_v4(&bad).unwrap_err(),
            "key_id must be exactly 32 bytes"
        );
    }

    #[test]
    fn v4_raw_signature_matches_the_cross_language_golden_vector() {
        let signing_key = p256::SecretKey::from_slice(&[1; 32]).unwrap();
        let public_key_pem = signing_key.public_key().to_public_key_pem(LineEnding::LF).unwrap();
        let secret_key_der = signing_key.to_pkcs8_der().unwrap();
        let key_id = action_signing_key_id(&public_key_pem).unwrap();
        let card_context_hash = action_card_context_hash_v2(&AppScopedActionCardContextCommitment {
            context_version: 1,
            app_subject: &[1; 32],
            chat_handle: &[2; 32],
            message_handle: &[3; 32],
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            content_hash: &[0xaa; 32],
            confirmation_lease_generation: 3,
            created_at: 1_720_000_000_000,
            payload_hash: &[0xbb; 32],
        })
        .unwrap();
        let ephemeral_public_key = [&[0x04][..], &[0x77; 64]].concat();
        let preimage = action_signature_preimage_v4(&ActionSignatureContext {
            key_id: &key_id,
            user_index_canister_id: Principal::from_slice(&[1, 2, 3]),
            inbox_canister_id: Principal::from_slice(&[4, 5, 6, 7]),
            app_id: 17,
            app_revision: 23,
            action_id: "expense.import",
            card_context_hash: &card_context_hash,
            consumer_key_fingerprint: &[0x33; 32],
            idempotency_key: &[0x44; 32],
            payload_hash: &[0xbb; 32],
            acknowledgement_secret_hash: &[0x66; 32],
            ephemeral_public_key: &ephemeral_public_key,
            ciphertext: &[0x80, 0x00, 0xff, 0x01],
            created_at: 1_720_000_000_000,
        })
        .unwrap();
        let mut rng = StdRng::seed_from_u64(0xA11CE);
        let signature = jwt::sign_bytes(&preimage, secret_key_der.as_bytes(), &mut rng).unwrap();
        let to_hex = |bytes: &[u8]| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();

        assert_eq!(
            public_key_pem,
            "-----BEGIN PUBLIC KEY-----\n\
             MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEb/A7lJJBzh2t1DUZ5pYOCoW0Gmmg\n\
             XDKBA6orzhWUyhY8T3U6Vb8B3FP2wLDH7ueLQMb/fSWpbiKCuYnO9xwUSg==\n\
             -----END PUBLIC KEY-----\n"
        );
        assert_eq!(
            to_hex(&key_id),
            "c4109bdc5946e2419731c8770f4cc0077ef4d7c88abca84e9479d96f3fe498fd"
        );
        assert_eq!(
            to_hex(&card_context_hash),
            "312da5d5ab8e3d67c56b0e90313dac5d680a1a8345d14c39feecd9b054492467"
        );
        assert_eq!(
            to_hex(&Sha256::digest(&preimage)),
            "d9cfc26dcc266baf1458ed47de26e5713bf310777ecc37ab2b5845c54b7337d9"
        );
        assert_eq!(signature.len(), 64, "wire signature is raw P1363 r||s, not ASN.1 DER");
        assert_eq!(
            to_hex(&signature),
            "3b04ebad45dad4fb46ad255e5fa7616ad05e3245b916fdfb25c105f1bb97ebe1c8f2b866d2e62f1ea814b1fad7433497c248ab7ec13ca19df3cea69e61f683b3"
        );

        let verifier = VerifyingKey::from_public_key_pem(&public_key_pem).unwrap();
        verifier
            .verify(&preimage, &Signature::from_slice(&signature).unwrap())
            .unwrap();
    }

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let mut rng = StdRng::seed_from_u64(7);
        let recipient = p256::SecretKey::random(&mut rng);
        let pk_pem = recipient.public_key().to_public_key_pem(Default::default()).unwrap();
        let sk_pem = recipient.to_pkcs8_pem(Default::default()).unwrap().to_string();

        let plaintext = b"a generic confirmed action payload, opaque to OpenChat";
        let envelope = encrypt(plaintext, &pk_pem, &mut rng).unwrap();

        assert_eq!(envelope.ephemeral_public_key.len(), 65, "uncompressed SEC1 ephemeral key");

        let created_at: u64 = 1_720_000_000_000;
        let preimage = envelope.signing_preimage(created_at);
        assert!(preimage.starts_with(ACTION_INBOX_SIGNATURE_DOMAIN_V3));
        assert_eq!(
            preimage.len(),
            ACTION_INBOX_SIGNATURE_DOMAIN_V3.len() + 65 + envelope.ciphertext.len() + 8
        );
        assert_eq!(
            &preimage[preimage.len() - 8..],
            created_at.to_le_bytes(),
            "created_at is u64 LE-suffixed (domain-separated preimage v3)"
        );

        let recovered = decrypt(&envelope, &sk_pem).unwrap();
        assert_eq!(recovered, plaintext);
    }

    // Prints a deterministic interop vector (run with `--nocapture`) so a JS/WebCrypto consumer can prove it
    // decrypts the exact ECIES wire format this library produces. Ignored in normal runs.
    #[test]
    #[ignore]
    fn print_interop_vector() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;

        let mut rng = StdRng::seed_from_u64(424242);
        let recipient = p256::SecretKey::random(&mut rng);
        let pk_pem = recipient.public_key().to_public_key_pem(Default::default()).unwrap();
        let sk_pem = recipient.to_pkcs8_pem(Default::default()).unwrap().to_string();

        let plaintext = b"{\"action_id\":\"example.action\",\"rows\":[{\"label\":\"Amount\",\"value\":\"$20\"}]}";
        let created_at: u64 = 1_720_000_000_000;
        let envelope = encrypt(plaintext, &pk_pem, &mut rng).unwrap();
        let fingerprint = key_fingerprint(&pk_pem).unwrap();

        // Platform signing key: sign the envelope's v3 preimage (which binds `created_at`) exactly as
        // local_user_index does on deposit, so a WebCrypto consumer can prove it verifies the provenance
        // signature OpenChat produces.
        let oc = p256::SecretKey::random(&mut rng);
        let oc_public_key_pem = oc.public_key().to_public_key_pem(Default::default()).unwrap();
        let oc_secret_key_der = oc.to_pkcs8_der().unwrap().as_bytes().to_vec();
        let oc_signature = jwt::sign_bytes(&envelope.signing_preimage(created_at), &oc_secret_key_der, &mut rng).unwrap();

        println!("ECIES_VECTOR_BEGIN");
        println!("recipient_sk_pem_b64={}", b64.encode(sk_pem.as_bytes()));
        println!("recipient_pk_pem_b64={}", b64.encode(pk_pem.as_bytes()));
        println!("ephemeral_public_key_b64={}", b64.encode(&envelope.ephemeral_public_key));
        println!("ciphertext_b64={}", b64.encode(&envelope.ciphertext));
        println!("created_at={created_at}");
        println!("signing_preimage_b64={}", b64.encode(envelope.signing_preimage(created_at)));
        println!("oc_public_key_pem_b64={}", b64.encode(oc_public_key_pem.as_bytes()));
        println!("oc_signature_b64={}", b64.encode(&oc_signature));
        println!(
            "fingerprint_hex={}",
            fingerprint.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        println!("expected_plaintext={}", String::from_utf8_lossy(plaintext));
        println!("ECIES_VECTOR_END");
    }

    #[test]
    fn wrong_recipient_cannot_decrypt() {
        let mut rng = StdRng::seed_from_u64(11);
        let recipient = p256::SecretKey::random(&mut rng);
        let attacker = p256::SecretKey::random(&mut rng);
        let pk_pem = recipient.public_key().to_public_key_pem(Default::default()).unwrap();
        let attacker_sk_pem = attacker.to_pkcs8_pem(Default::default()).unwrap().to_string();

        let envelope = encrypt(b"secret", &pk_pem, &mut rng).unwrap();
        assert!(decrypt(&envelope, &attacker_sk_pem).is_err());
    }
}
