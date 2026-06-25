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
//! Provenance is added separately by signing `signing_preimage()` (= ephemeral_pk ‖ ciphertext) with the
//! platform's existing P-256 key via `jwt::sign_bytes` — i.e. ECDSA(SHA-256(preimage)), which Web Crypto's
//! `ECDSA`/`SHA-256` verifies directly. Nothing here is app-specific.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use candid::CandidType;
use hkdf::Hkdf;
use p256::PublicKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::DecodePublicKey;
use rand_core::CryptoRngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// HKDF `info` label; bumping it versions the wire format.
const INFO: &[u8] = b"oc-action-inbox-v1";

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct EciesEnvelope {
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

impl EciesEnvelope {
    /// The exact bytes signed for provenance: `ephemeral_public_key ‖ ciphertext`.
    pub fn signing_preimage(&self) -> Vec<u8> {
        let mut preimage = Vec::with_capacity(self.ephemeral_public_key.len() + self.ciphertext.len());
        preimage.extend_from_slice(&self.ephemeral_public_key);
        preimage.extend_from_slice(&self.ciphertext);
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
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let mut rng = StdRng::seed_from_u64(7);
        let recipient = p256::SecretKey::random(&mut rng);
        let pk_pem = recipient.public_key().to_public_key_pem(Default::default()).unwrap();
        let sk_pem = recipient.to_pkcs8_pem(Default::default()).unwrap().to_string();

        let plaintext = b"a generic confirmed action payload, opaque to OpenChat";
        let envelope = encrypt(plaintext, &pk_pem, &mut rng).unwrap();

        assert_eq!(envelope.ephemeral_public_key.len(), 65, "uncompressed SEC1 ephemeral key");
        assert_eq!(envelope.signing_preimage().len(), 65 + envelope.ciphertext.len());

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

        let plaintext = b"{\"action_id\":\"iou.add\",\"rows\":[{\"label\":\"Amount\",\"value\":\"$20\"}]}";
        let envelope = encrypt(plaintext, &pk_pem, &mut rng).unwrap();
        let fingerprint = key_fingerprint(&pk_pem).unwrap();

        println!("ECIES_VECTOR_BEGIN");
        println!("recipient_sk_pem_b64={}", b64.encode(sk_pem.as_bytes()));
        println!("recipient_pk_pem_b64={}", b64.encode(pk_pem.as_bytes()));
        println!("ephemeral_public_key_b64={}", b64.encode(&envelope.ephemeral_public_key));
        println!("ciphertext_b64={}", b64.encode(&envelope.ciphertext));
        println!("signing_preimage_b64={}", b64.encode(envelope.signing_preimage()));
        println!("fingerprint_hex={}", fingerprint.iter().map(|b| format!("{b:02x}")).collect::<String>());
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
