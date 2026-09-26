//! Transport validation is not authentication. The guest verifies the signed WebAuthn assertion
//! and obtains fresh authenticated proof from official services before accepting a candidate.
use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "openchat.local-browser-auth.v1";
pub const CLIENT_LABEL: &str = "OpenChat Fork · Local Test";
pub const ATTEMPT_LIFETIME_MS: u64 = 120_000;
pub const SESSION_LIFETIME_MS: u64 = 300_000;
pub const MAX_CANDIDATE_BYTES: usize = 65_536;

pub fn bundled_window_allowed(label: &str, origin: &str, username: &str, has_password: bool) -> bool {
    label == "main" && origin == "http://tauri.localhost" && username.is_empty() && !has_password
}

#[test]
fn bundled_window_requires_exact_origin_and_no_userinfo() {
    assert!(bundled_window_allowed("main", "http://tauri.localhost", "", false));
    for origin in ["https://tauri.localhost", "http://tauri.localhost:8080", "http://localhost", "null"] {
        assert!(!bundled_window_allowed("main", origin, "", false));
    }
    assert!(!bundled_window_allowed("popup", "http://tauri.localhost", "", false));
    assert!(!bundled_window_allowed("main", "http://tauri.localhost", "user", false));
    assert!(!bundled_window_allowed("main", "http://tauri.localhost", "", true));
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginRequest {
    pub session_public_key_der_hex: String,
    pub expected_username: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Challenge {
    pub protocol: String,
    pub attempt_id: String,
    pub nonce: String,
    pub origin: String,
    pub url: String,
    pub session_public_key_der_hex: String,
    pub expected_username: String,
    pub identity_canister: String,
    pub identity_target_hex: String,
    pub expires_at_ms: u64,
    pub delegation_expires_at_ms: u64,
    pub client_label: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub protocol: String,
    pub attempt_id: String,
    pub nonce: String,
    pub credential_id_hex: String,
    pub delegation: JsonChain,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonChain {
    pub public_key: String,
    pub delegations: Vec<JsonSignedDelegation>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonSignedDelegation {
    pub delegation: JsonDelegation,
    pub signature: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonDelegation {
    pub pubkey: String,
    pub expiration: String,
    pub targets: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PollResult {
    Pending,
    Submitted { candidate: Candidate },
    Verifying,
    Verified,
    Failed,
    Expired,
    Cancelled,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pending,
    Submitted,
    Verifying,
    Verified,
    Failed,
    Expired,
    Cancelled,
}

pub struct Attempt {
    pub challenge: Challenge,
    phase: Phase,
    candidate: Option<Candidate>,
}

fn bounded_hex(value: &str, minimum_bytes: usize, maximum_bytes: usize) -> bool {
    value.len() >= minimum_bytes * 2 && value.len() <= maximum_bytes * 2 &&
        value.len() % 2 == 0 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn validate_begin(request: &BeginRequest) -> Result<(), &'static str> {
    // APK-generated ECDSA DER is public, but bound its representation before retaining it.
    if !bounded_hex(&request.session_public_key_der_hex, 32, 512) {
        return Err("Invalid local session public key");
    }
    if request.expected_username.is_empty() || request.expected_username.len() > 64 ||
        request.expected_username.trim() != request.expected_username ||
        request.expected_username.chars().any(char::is_control) {
        return Err("Enter the exact existing account username");
    }
    Ok(())
}

impl Attempt {
    pub fn new(challenge: Challenge) -> Self {
        Self { challenge, phase: Phase::Pending, candidate: None }
    }

    fn expire(&mut self, now_ms: u64) {
        if now_ms >= self.challenge.expires_at_ms &&
            matches!(self.phase, Phase::Pending | Phase::Submitted | Phase::Verifying) {
            self.phase = Phase::Expired;
            self.candidate = None;
        }
    }

    pub fn accepts_candidate(&mut self, now_ms: u64) -> bool {
        self.expire(now_ms);
        self.phase == Phase::Pending
    }

    pub fn submit(&mut self, body: &[u8], now_ms: u64) -> Result<(), &'static str> {
        self.expire(now_ms);
        if self.phase != Phase::Pending { return Err("Local sign-in attempt is no longer pending"); }
        if body.len() > MAX_CANDIDATE_BYTES { return Err("Local sign-in response is too large"); }
        let candidate: Candidate = serde_json::from_slice(body).map_err(|_| "Invalid local sign-in response")?;
        let challenge = &self.challenge;
        if candidate.protocol != PROTOCOL || candidate.attempt_id != challenge.attempt_id ||
            candidate.nonce != challenge.nonce || !bounded_hex(&candidate.credential_id_hex, 1, 1_024) ||
            !bounded_hex(&candidate.delegation.public_key, 32, 4_096) ||
            candidate.delegation.delegations.len() != 1 {
            return Err("Local sign-in response does not match this attempt");
        }
        let signed = &candidate.delegation.delegations[0];
        let delegation = &signed.delegation;
        let expiration = u64::from_str_radix(&delegation.expiration, 16)
            .map_err(|_| "Invalid local sign-in expiry")?;
        let expected_expiration = challenge.delegation_expires_at_ms.checked_mul(1_000_000)
            .ok_or("Invalid local sign-in expiry")?;
        if !bounded_hex(&signed.signature, 32, 16_384) ||
            !delegation.pubkey.eq_ignore_ascii_case(&challenge.session_public_key_der_hex) ||
            expiration != expected_expiration || now_ms >= challenge.delegation_expires_at_ms ||
            delegation.targets.len() != 1 ||
            !delegation.targets[0].eq_ignore_ascii_case(&challenge.identity_target_hex) {
            return Err("Local sign-in delegation does not match this attempt");
        }
        self.candidate = Some(candidate);
        self.phase = Phase::Submitted;
        Ok(())
    }

    pub fn poll(&mut self, now_ms: u64) -> PollResult {
        self.expire(now_ms);
        match self.phase {
            Phase::Submitted => {
                // Exactly once to the trusted native guest, never to an HTTP/browser endpoint.
                if let Some(candidate) = self.candidate.take() {
                    self.phase = Phase::Verifying;
                    PollResult::Submitted { candidate }
                } else {
                    self.phase = Phase::Failed;
                    PollResult::Failed
                }
            }
            Phase::Pending => PollResult::Pending,
            Phase::Verifying => PollResult::Verifying,
            Phase::Verified => PollResult::Verified,
            Phase::Failed => PollResult::Failed,
            Phase::Expired => PollResult::Expired,
            Phase::Cancelled => PollResult::Cancelled,
        }
    }

    pub fn complete(&mut self, accepted: bool, now_ms: u64) -> Result<(), &'static str> {
        self.expire(now_ms);
        if self.phase != Phase::Verifying { return Err("Local sign-in is not awaiting verification"); }
        self.phase = if accepted { Phase::Verified } else { Phase::Failed };
        Ok(())
    }

    pub fn cancel(&mut self) {
        self.phase = Phase::Cancelled;
        self.candidate = None;
    }

    pub fn status(&mut self, now_ms: u64) -> &'static str {
        self.expire(now_ms);
        match self.phase {
            Phase::Pending => "pending",
            Phase::Submitted | Phase::Verifying => "pending_verification",
            Phase::Verified => "verified",
            Phase::Failed => "failed",
            Phase::Expired => "expired",
            Phase::Cancelled => "cancelled",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Attempt, serde_json::Value) {
        let challenge = Challenge {
            protocol: PROTOCOL.into(), attempt_id: "11".repeat(16), nonce: "22".repeat(32),
            origin: "http://localhost:54321".into(), url: "http://localhost:54321/sign-in".into(),
            session_public_key_der_hex: "33".repeat(91), expected_username: "fixture-user".into(),
            identity_canister: "fixture-cai".into(), identity_target_hex: "ABCD".into(),
            expires_at_ms: 121_000, delegation_expires_at_ms: 301_000, client_label: CLIENT_LABEL.into(),
        };
        let body = serde_json::json!({
            "protocol": PROTOCOL, "attemptId": challenge.attempt_id, "nonce": challenge.nonce,
            "credentialIdHex": "44".repeat(32), "delegation": { "publicKey": "55".repeat(91),
                "delegations": [{"delegation": {"pubkey": challenge.session_public_key_der_hex,
                    "expiration": format!("{:x}", challenge.delegation_expires_at_ms * 1_000_000),
                    "targets": [challenge.identity_target_hex]}, "signature": "66".repeat(160)}]}
        });
        (Attempt::new(challenge), body)
    }
    #[test]
    fn candidate_is_not_authentication_and_only_delivered_once() {
        let (mut attempt, body) = fixture();
        attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).unwrap();
        assert_eq!(attempt.status(2_000), "pending_verification");
        assert!(matches!(attempt.poll(2_000), PollResult::Submitted { .. }));
        assert!(matches!(attempt.poll(2_000), PollResult::Verifying));
        assert!(attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).is_err());
        attempt.complete(true, 3_000).unwrap();
        assert_eq!(attempt.status(3_000), "verified");
        assert!(attempt.complete(true, 3_000).is_err());
    }
    #[test]
    fn binding_mismatches_and_unknown_fields_fail_closed() {
        for (pointer, replacement) in [
            ("/protocol", serde_json::json!("wrong")), ("/attemptId", serde_json::json!("wrong")),
            ("/nonce", serde_json::json!("wrong")), ("/credentialIdHex", serde_json::json!("not-hex")),
            ("/delegation/delegations/0/delegation/pubkey", serde_json::json!("00".repeat(91))),
            ("/delegation/delegations/0/delegation/expiration", serde_json::json!("ffffffffffffffff")),
            ("/delegation/delegations/0/delegation/targets", serde_json::json!([])),
            ("/delegation/delegations/0/delegation/targets", serde_json::json!(["ABCD", "EF"])),
        ] {
            let (mut attempt, mut body) = fixture();
            *body.pointer_mut(pointer).unwrap() = replacement;
            assert!(attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).is_err());
            assert!(matches!(attempt.poll(2_000), PollResult::Pending));
        }
        let (mut attempt, mut body) = fixture();
        body["privateKey"] = serde_json::json!("not-accepted");
        assert!(attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).is_err());
    }
    #[test]
    fn cancellation_expiry_and_oversize_never_return_a_candidate() {
        let (mut attempt, body) = fixture();
        assert!(attempt.submit(&vec![b' '; MAX_CANDIDATE_BYTES + 1], 2_000).is_err());
        attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).unwrap();
        assert!(matches!(attempt.poll(121_000), PollResult::Expired));
        assert!(attempt.complete(true, 121_000).is_err());
        let (mut attempt, body) = fixture();
        attempt.cancel();
        assert!(attempt.submit(&serde_json::to_vec(&body).unwrap(), 2_000).is_err());
        assert!(matches!(attempt.poll(2_000), PollResult::Cancelled));
    }
}
