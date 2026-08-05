use p256::ecdsa;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_bytes::ByteBuf;
use types::TimestampMillis;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const MAX_ACTION_SIGNING_KEYS: usize = 3;
pub const RETAIN_VERIFY_ONLY_KEY_MILLIS: TimestampMillis = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ActionSigningKeyStatus {
    Staged,
    Active,
    VerifyOnly,
}

#[derive(Serialize, Deserialize)]
struct ActionSigningKey {
    key_id: [u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES],
    public_key_pem: String,
    /// Present only while staged or active. The wrapper preserves the previous MessagePack bytes
    /// representation while zeroizing its complete current allocation whenever it is dropped.
    secret_key_der: Option<SecretKeyDer>,
    status: ActionSigningKeyStatus,
    created_at: TimestampMillis,
    verify_until: Option<TimestampMillis>,
}

/// Dedicated PR2 secret storage. This is intentionally local to the action-signing keyring so the
/// legacy OpenChat key and its established protocols are unaffected.
struct SecretKeyDer(Vec<u8>);

impl SecretKeyDer {
    fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Serialize for SecretKeyDer {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretKeyDer {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self(ByteBuf::deserialize(deserializer)?.into_vec()))
    }
}

impl Drop for SecretKeyDer {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for SecretKeyDer {}

pub struct PublicActionSigningKey<'a> {
    pub key_id: &'a [u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES],
    pub public_key_pem: &'a str,
    pub status: ActionSigningKeyStatus,
    pub created_at: TimestampMillis,
    pub verify_until: Option<TimestampMillis>,
}

/// PR2-only action-deposit signing keys. The original `oc_key_pair` remains untouched for bots,
/// access tokens, memberships, and every other established OpenChat signature protocol.
#[derive(Default, Serialize, Deserialize)]
pub struct ActionSigningKeyring {
    keys: Vec<ActionSigningKey>,
    active_key_id: Option<[u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES]>,
}

impl ActionSigningKeyring {
    pub fn ensure_initialized(&mut self, rng: &mut (impl CryptoRng + RngCore), now: TimestampMillis) -> Result<bool, String> {
        if !self.keys.is_empty() {
            return match self.active_key_id {
                Some(_) if self.active_key().is_some() => Ok(false),
                Some(_) => Err("action-signing keyring active key id is inconsistent".to_string()),
                None if self.keys.iter().any(|entry| entry.status == ActionSigningKeyStatus::Active) => {
                    Err("action-signing keyring has an active entry but no active key id".to_string())
                }
                // A freshly initialized keyring deliberately contains only staged keys. Consumers
                // must pin the public key before governance explicitly activates it.
                None => Ok(false),
            };
        }
        let (public_key_pem, secret_key_der) = generate_action_signing_key(rng)?;
        let key_id = ecies_payload::action_signing_key_id(&public_key_pem)?;
        self.keys.push(ActionSigningKey {
            key_id,
            public_key_pem,
            secret_key_der: Some(secret_key_der),
            status: ActionSigningKeyStatus::Staged,
            created_at: now,
            verify_until: None,
        });
        Ok(true)
    }

    pub fn active_key(&self) -> Option<(&[u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES], &[u8])> {
        let active = self.active_key_id.as_ref()?;
        self.keys
            .iter()
            .find(|entry| entry.status == ActionSigningKeyStatus::Active && &entry.key_id == active)
            .and_then(|entry| entry.secret_key_der.as_ref().map(|secret| (&entry.key_id, secret.as_slice())))
    }

    pub fn public_keys(&self) -> impl Iterator<Item = PublicActionSigningKey<'_>> {
        self.keys.iter().map(|entry| PublicActionSigningKey {
            key_id: &entry.key_id,
            public_key_pem: &entry.public_key_pem,
            status: entry.status,
            created_at: entry.created_at,
            verify_until: entry.verify_until,
        })
    }

    /// Returns only keys whose advertised verification lifetime includes `now`. The hourly
    /// retirement job bounds storage, while this view makes the public cutoff exact even if the
    /// timer has not run yet (or was postponed by an upgrade).
    pub fn public_keys_at(&self, now: TimestampMillis) -> impl Iterator<Item = PublicActionSigningKey<'_>> {
        self.keys
            .iter()
            .filter(move |entry| {
                entry.status != ActionSigningKeyStatus::VerifyOnly
                    || entry.verify_until.is_some_and(|verify_until| verify_until > now)
            })
            .map(|entry| PublicActionSigningKey {
                key_id: &entry.key_id,
                public_key_pem: &entry.public_key_pem,
                status: entry.status,
                created_at: entry.created_at,
                verify_until: entry.verify_until,
            })
    }

    pub fn stage(
        &mut self,
        rng: &mut (impl CryptoRng + RngCore),
        now: TimestampMillis,
    ) -> Result<[u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES], String> {
        self.retire_expired(now);
        if self.keys.len() >= MAX_ACTION_SIGNING_KEYS {
            return Err(format!("action-signing keyring is full (maximum {MAX_ACTION_SIGNING_KEYS})"));
        }
        let (public_key_pem, secret_key_der) = generate_action_signing_key(rng)?;
        let key_id = ecies_payload::action_signing_key_id(&public_key_pem)?;
        if self.keys.iter().any(|entry| entry.key_id == key_id) {
            return Err("generated action-signing key id already exists".to_string());
        }
        self.keys.push(ActionSigningKey {
            key_id,
            public_key_pem,
            secret_key_der: Some(secret_key_der),
            status: ActionSigningKeyStatus::Staged,
            created_at: now,
            verify_until: None,
        });
        Ok(key_id)
    }

    pub fn activate(
        &mut self,
        key_id: &[u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES],
        now: TimestampMillis,
    ) -> Result<(), String> {
        let target = self
            .keys
            .iter()
            .position(|entry| entry.key_id == *key_id && entry.status == ActionSigningKeyStatus::Staged)
            .ok_or_else(|| "staged action-signing key not found".to_string())?;
        if self.keys[target].secret_key_der.is_none() {
            return Err("staged action-signing key has no private material".to_string());
        }
        for entry in &mut self.keys {
            if entry.status == ActionSigningKeyStatus::Active {
                entry.status = ActionSigningKeyStatus::VerifyOnly;
                entry.verify_until = Some(now.saturating_add(RETAIN_VERIFY_ONLY_KEY_MILLIS));
                entry.secret_key_der = None;
            }
        }
        self.keys[target].status = ActionSigningKeyStatus::Active;
        self.keys[target].verify_until = None;
        self.active_key_id = Some(*key_id);
        Ok(())
    }

    pub fn retire_expired(&mut self, now: TimestampMillis) -> usize {
        let before = self.keys.len();
        self.keys.retain(|entry| {
            entry.status != ActionSigningKeyStatus::VerifyOnly
                || entry.verify_until.is_some_and(|verify_until| verify_until > now)
        });
        before - self.keys.len()
    }
}

fn generate_action_signing_key(rng: &mut (impl CryptoRng + RngCore)) -> Result<(String, SecretKeyDer), String> {
    let signing_key = ecdsa::SigningKey::random(rng);
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|error| format!("failed to encode action-signing public key: {error}"))?;
    // `SecretDocument` and the P-256 signing scalar zeroize themselves on drop. Move the one DER
    // copy needed for durable state directly into our own drop-zeroizing wrapper.
    let secret_document = signing_key
        .to_pkcs8_der()
        .map_err(|error| format!("failed to encode action-signing private key: {error}"))?;
    Ok((public_key_pem, SecretKeyDer(secret_document.as_bytes().to_vec())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::{Signature, VerifyingKey};
    use p256::pkcs8::DecodePublicKey;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    #[test]
    fn initializes_a_purpose_specific_key_and_supports_bounded_overlap_rotation() {
        let mut rng = StdRng::seed_from_u64(71);
        let mut keyring = ActionSigningKeyring::default();
        assert_eq!(keyring.ensure_initialized(&mut rng, 10), Ok(true));
        assert_eq!(keyring.ensure_initialized(&mut rng, 11), Ok(false));
        assert!(keyring.active_key().is_none());
        let original = *keyring
            .public_keys()
            .find(|entry| entry.status == ActionSigningKeyStatus::Staged)
            .unwrap()
            .key_id;
        keyring.activate(&original, 12).unwrap();

        let replacement = keyring.stage(&mut rng, 20).unwrap();
        keyring.activate(&replacement, 30).unwrap();
        assert_eq!(*keyring.active_key().unwrap().0, replacement);
        let public: Vec<_> = keyring.public_keys().collect();
        assert_eq!(public.len(), 2);
        assert!(public.iter().any(|entry| entry.key_id == &original
            && entry.status == ActionSigningKeyStatus::VerifyOnly
            && entry.verify_until == Some(30 + RETAIN_VERIFY_ONLY_KEY_MILLIS)));
        assert!(
            keyring
                .keys
                .iter()
                .find(|entry| entry.key_id == original)
                .unwrap()
                .secret_key_der
                .is_none(),
            "verify-only keys retain public verification material but remove private DER from the live keyring"
        );
        assert_eq!(keyring.retire_expired(30 + RETAIN_VERIFY_ONLY_KEY_MILLIS), 1);
        assert_eq!(keyring.public_keys().count(), 1);
    }

    #[test]
    fn bootstrap_never_auto_activates_before_consumers_can_pin_the_key() {
        let mut rng = StdRng::seed_from_u64(76);
        let mut keyring = ActionSigningKeyring::default();

        assert_eq!(keyring.ensure_initialized(&mut rng, 10), Ok(true));
        assert!(keyring.active_key().is_none());
        let public: Vec<_> = keyring.public_keys().collect();
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].status, ActionSigningKeyStatus::Staged);
        assert_eq!(public[0].verify_until, None);
    }

    #[test]
    fn public_view_stops_advertising_verify_only_keys_at_the_exact_cutoff() {
        let mut rng = StdRng::seed_from_u64(77);
        let mut keyring = ActionSigningKeyring::default();
        keyring.ensure_initialized(&mut rng, 1).unwrap();
        let original = *keyring.public_keys().next().unwrap().key_id;
        keyring.activate(&original, 2).unwrap();
        let replacement = keyring.stage(&mut rng, 3).unwrap();
        let cutoff = 4 + RETAIN_VERIFY_ONLY_KEY_MILLIS;
        keyring.activate(&replacement, 4).unwrap();

        assert_eq!(keyring.public_keys_at(cutoff - 1).count(), 2);
        assert_eq!(keyring.public_keys_at(cutoff).count(), 1);
        // Publication filtering is immediate even before the bounded cleanup job mutates state.
        assert_eq!(keyring.public_keys().count(), 2);
    }

    #[test]
    fn staged_key_count_is_bounded() {
        let mut rng = StdRng::seed_from_u64(72);
        let mut keyring = ActionSigningKeyring::default();
        keyring.ensure_initialized(&mut rng, 1).unwrap();
        keyring.stage(&mut rng, 2).unwrap();
        keyring.stage(&mut rng, 3).unwrap();
        assert!(keyring.stage(&mut rng, 4).is_err());
    }

    #[test]
    fn malformed_verify_only_key_without_a_deadline_fails_closed() {
        let mut rng = StdRng::seed_from_u64(75);
        let mut keyring = ActionSigningKeyring::default();
        keyring.ensure_initialized(&mut rng, 1).unwrap();
        let initial = *keyring.public_keys().next().unwrap().key_id;
        keyring.activate(&initial, 1).unwrap();
        let replacement = keyring.stage(&mut rng, 2).unwrap();
        keyring.activate(&replacement, 3).unwrap();
        let verify_only = keyring
            .keys
            .iter_mut()
            .find(|entry| entry.status == ActionSigningKeyStatus::VerifyOnly)
            .unwrap();
        verify_only.verify_until = None;

        assert_eq!(keyring.retire_expired(4), 1);
        assert_eq!(keyring.public_keys().count(), 1);
        assert!(keyring.active_key().is_some());
    }

    #[test]
    fn dedicated_active_key_signatures_do_not_verify_with_an_unrelated_legacy_key() {
        let mut rng = StdRng::seed_from_u64(74);
        let legacy_key = P256KeyPair::new(&mut rng);
        let mut keyring = ActionSigningKeyring::default();
        keyring.ensure_initialized(&mut rng, 1).unwrap();
        let initial = *keyring.public_keys().next().unwrap().key_id;
        keyring.activate(&initial, 1).unwrap();
        let active_public_key = keyring
            .public_keys()
            .find(|entry| entry.status == ActionSigningKeyStatus::Active)
            .unwrap()
            .public_key_pem
            .to_string();
        let (active_key_id, active_secret_key_der) = keyring.active_key().unwrap();
        assert_ne!(
            active_key_id,
            &ecies_payload::action_signing_key_id(legacy_key.public_key_pem()).unwrap()
        );

        let preimage = b"openchat/action-inbox/deposit-signature/v4\0fixture";
        let signature = Signature::from_slice(&jwt::sign_bytes(preimage, active_secret_key_der, &mut rng).unwrap()).unwrap();
        let active_verifier = VerifyingKey::from_public_key_pem(&active_public_key).unwrap();
        let legacy_verifier = VerifyingKey::from_public_key_pem(legacy_key.public_key_pem()).unwrap();
        assert!(active_verifier.verify(preimage, &signature).is_ok());
        assert!(legacy_verifier.verify(preimage, &signature).is_err());
    }

    #[test]
    fn dedicated_secret_storage_is_drop_zeroizing_and_keeps_the_old_msgpack_shape() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<SecretKeyDer>();

        #[derive(Serialize, Deserialize)]
        struct PreviousActionSigningKey {
            key_id: [u8; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES],
            public_key_pem: String,
            secret_key_der: Option<ByteBuf>,
            status: ActionSigningKeyStatus,
            created_at: TimestampMillis,
            verify_until: Option<TimestampMillis>,
        }

        let previous = PreviousActionSigningKey {
            key_id: [7; ecies_payload::ACTION_SIGNING_KEY_ID_BYTES],
            public_key_pem: "public".to_string(),
            secret_key_der: Some(ByteBuf::from(vec![1, 2, 3, 4])),
            status: ActionSigningKeyStatus::Staged,
            created_at: 11,
            verify_until: None,
        };
        let previous_bytes = msgpack::serialize_then_unwrap(&previous);
        let restored: ActionSigningKey = msgpack::deserialize_then_unwrap(&previous_bytes);
        assert_eq!(restored.secret_key_der.as_ref().unwrap().as_slice(), [1, 2, 3, 4]);

        let current_bytes = msgpack::serialize_then_unwrap(&restored);
        let round_tripped: PreviousActionSigningKey = msgpack::deserialize_then_unwrap(&current_bytes);
        assert_eq!(round_tripped.secret_key_der.unwrap().as_ref(), [1, 2, 3, 4]);
    }
}
