//! Local transport only: the host supplies an already approved immutable request. No model,
//! account, chat, app-specific schema or backend verification belongs in this module.
use serde::{de::{self, MapAccess, SeqAccess, Visitor}, Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;

pub const CLAIM_LIFETIME_MS: u64 = 120_000;
pub const DELIVERY_LIFETIME_MS: u64 = 600_000;
pub const MAX_REQUEST_BYTES: usize = 72 * 1024;
pub const MAX_POST_BYTES: usize = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginRequest { pub approved_request_json: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResponse {
    pub handoff_id: String,
    pub url: String,
    // Bearer authority; only the native review UI may display/copy this. Never log it.
    pub pairing_code: String,
    pub claim_expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase { AwaitingClaim, Reviewing, Offered, Received, Saved, Rejected, Uncertain, Expired, Cancelled }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub expires_at_ms: u64,
    pub delivery_may_have_occurred: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse { pub delivery_may_have_occurred: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimRequest { pub version: u8, pub code: String, pub browser_proof_hex: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub version: u8,
    pub handoff_id: String,
    pub approved_request_json: String,
    pub expires_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofRequest { pub version: u8, pub handoff_id: String, pub browser_proof_hex: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchRequest {
    pub version: u8, pub handoff_id: String, pub browser_proof_hex: String, pub import_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultRequest {
    pub version: u8, pub handoff_id: String, pub browser_proof_hex: String,
    pub import_id: String, pub outcome: Outcome,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome { Received, Saved, Rejected, Uncertain }

pub fn bundled_window_allowed(label: &str, origin: &str, username: &str, password: bool) -> bool {
    label == "main" && origin == "http://tauri.localhost" && username.is_empty() && !password
}

// serde_json::Value normally silently accepts duplicate object keys. Reject them at every depth,
// before any target/import ID lookup. The original UTF-8 string is retained, never reserialized.
struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = UniqueValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("bounded unique JSON") }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(UniqueValue(Value::Null)) }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> { Ok(UniqueValue(v.into())) }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> { Ok(UniqueValue(v.into())) }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> { Ok(UniqueValue(v.into())) }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(v).map(|n| UniqueValue(Value::Number(n))).ok_or_else(|| E::custom("Invalid JSON number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> { Ok(UniqueValue(v.into())) }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> { Ok(UniqueValue(v.into())) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueValue(value)) = seq.next_element()? {
                    if values.len() >= 256 { return Err(de::Error::custom("JSON collection too large")); }
                    values.push(value);
                }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some((key, UniqueValue(value))) = map.next_entry::<String, UniqueValue>()? {
                    if values.len() >= 256 || values.contains_key(&key) || matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
                        return Err(de::Error::custom("Invalid JSON key"));
                    }
                    values.insert(key, value);
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

pub fn parse_strict<T: serde::de::DeserializeOwned>(body: &[u8], max: usize) -> Result<T, &'static str> {
    if body.len() > max { return Err("Invalid local handoff request"); }
    let UniqueValue(value) = serde_json::from_slice(body).map_err(|_| "Invalid local handoff request")?;
    serde_json::from_value(value).map_err(|_| "Invalid local handoff request")
}

fn bounded_tree(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > 16 || *nodes > 4096 { return false; }
    match value {
        Value::Array(v) => v.iter().all(|v| bounded_tree(v, depth + 1, nodes)),
        Value::Object(v) => v.values().all(|v| bounded_tree(v, depth + 1, nodes)),
        _ => true,
    }
}

pub fn validate_approved_request(raw: &str) -> Result<String, &'static str> {
    let value: Value = parse_strict(raw.as_bytes(), MAX_REQUEST_BYTES)?;
    let object = value.as_object().ok_or("Invalid private handoff request")?;
    let fields = ["appId", "actionId", "destination", "recipient", "idempotencyKey", "payload"];
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) { return Err("Invalid private handoff request"); }
    for key in &fields[..5] {
        let text = object[*key].as_str().ok_or("Invalid private handoff target")?;
        if text.is_empty() || text.len() > 2048 { return Err("Invalid private handoff target"); }
    }
    let import_id = object["idempotencyKey"].as_str().unwrap();
    if import_id.len() != 43 || !import_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') ||
        !b"AEIMQUYcgkosw048".contains(&import_id.as_bytes()[42]) { return Err("Invalid private handoff identifier"); }
    let destination = object["destination"].as_str().unwrap();
    let url = reqwest::Url::parse(destination).map_err(|_| "Invalid private handoff destination")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() ||
        !(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))) ||
        url.as_str() != destination { return Err("Invalid private handoff destination"); }
    let payload = &object["payload"];
    if !bounded_tree(payload, 0, &mut 0) || serde_json::to_vec(payload).map_err(|_| "Invalid private payload")?.len() > 64 * 1024 {
        return Err("Invalid private handoff payload");
    }
    Ok(import_id.into())
}

fn hash(value: &[u8]) -> [u8; 32] { Sha256::digest(value).into() }
fn equal_hash(a: &[u8; 32], b: &[u8; 32]) -> bool { a.iter().zip(b).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0 }
fn proof_hash(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return None; }
    Some(hash(&hex::decode(value).ok()?))
}

pub struct Attempt {
    pub handoff_id: String,
    pub claim_expires_at_ms: u64,
    expires_at_ms: u64,
    phase: Phase,
    import_id: String,
    approved_json: Option<String>,
    code_hash: Option<[u8; 32]>,
    proof_hash: Option<[u8; 32]>,
    bad_claims: u8,
    dispatched: bool,
}

impl Attempt {
    pub fn new(request: BeginRequest, handoff_id: String, code: &str, now: u64) -> Result<Self, &'static str> {
        let import_id = validate_approved_request(&request.approved_request_json)?;
        if code.len() != 20 || !code.bytes().all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b)) { return Err("Invalid local pairing code"); }
        let deadline = now.checked_add(CLAIM_LIFETIME_MS).ok_or("Invalid handoff deadline")?;
        Ok(Self { handoff_id, claim_expires_at_ms: deadline, expires_at_ms: deadline, phase: Phase::AwaitingClaim,
            import_id, approved_json: Some(request.approved_request_json), code_hash: Some(hash(code.as_bytes())),
            proof_hash: None, bad_claims: 0, dispatched: false })
    }

    fn clear_sensitive(&mut self) { self.approved_json = None; self.code_hash = None; self.proof_hash = None; }
    fn expire(&mut self, now: u64) {
        if now < self.expires_at_ms { return; }
        self.clear_sensitive();
        self.phase = match self.phase {
            Phase::AwaitingClaim | Phase::Reviewing => Phase::Expired,
            Phase::Offered => Phase::Uncertain,
            phase => phase,
        };
    }
    pub fn status(&mut self, now: u64) -> Status {
        self.expire(now);
        Status { phase: self.phase, expires_at_ms: self.expires_at_ms, delivery_may_have_occurred: self.dispatched }
    }
    pub fn active(&mut self, now: u64) -> bool {
        let status = self.status(now);
        now < status.expires_at_ms && matches!(status.phase, Phase::AwaitingClaim | Phase::Reviewing | Phase::Offered | Phase::Received)
    }
    pub fn claim(&mut self, body: &[u8], now: u64) -> Result<ClaimResponse, &'static str> {
        self.expire(now);
        if self.phase != Phase::AwaitingClaim { return Err("Local handoff cannot be claimed"); }
        let candidate = parse_strict::<ClaimRequest>(body, MAX_POST_BYTES).ok();
        let proof = candidate.as_ref().and_then(|c| proof_hash(&c.browser_proof_hex));
        let accepted = candidate.as_ref().is_some_and(|c| c.version == 1 && c.code.len() == 20 &&
            self.code_hash.as_ref().is_some_and(|expected| equal_hash(expected, &hash(c.code.as_bytes())))) && proof.is_some();
        if !accepted {
            self.bad_claims += 1;
            if self.bad_claims >= 5 { self.clear_sensitive(); self.phase = Phase::Expired; }
            return Err("Local handoff cannot be claimed");
        }
        self.expires_at_ms = now.checked_add(DELIVERY_LIFETIME_MS).ok_or("Invalid handoff deadline")?;
        self.proof_hash = proof;
        self.code_hash = None;
        self.phase = Phase::Reviewing;
        // Taking the payload and consuming the code is atomic even if the HTTP response is lost.
        let approved_request_json = self.approved_json.take().ok_or("Local handoff has no approved request")?;
        Ok(ClaimResponse { version: 1, handoff_id: self.handoff_id.clone(), approved_request_json, expires_at_ms: self.expires_at_ms })
    }
    fn authenticate(&mut self, version: u8, id: &str, proof: &str, now: u64) -> Result<(), &'static str> {
        self.expire(now);
        if version != 1 || id != self.handoff_id || now >= self.expires_at_ms ||
            !proof_hash(proof).is_some_and(|actual| self.proof_hash.as_ref().is_some_and(|expected| equal_hash(expected, &actual))) {
            return Err("Local handoff authorization is unavailable");
        }
        Ok(())
    }
    pub fn authenticated_status(&mut self, request: ProofRequest, now: u64) -> Result<Status, &'static str> {
        self.authenticate(request.version, &request.handoff_id, &request.browser_proof_hex, now)?;
        Ok(self.status(now))
    }
    pub fn dispatch(&mut self, request: DispatchRequest, now: u64) -> Result<Status, &'static str> {
        self.authenticate(request.version, &request.handoff_id, &request.browser_proof_hex, now)?;
        if self.phase != Phase::Reviewing || request.import_id != self.import_id { return Err("Local handoff cannot be dispatched"); }
        // Authorization itself is the point of no assured recall, not the later acknowledgement.
        self.phase = Phase::Offered;
        self.dispatched = true;
        Ok(self.status(now))
    }
    pub fn result(&mut self, request: ResultRequest, now: u64) -> Result<Status, &'static str> {
        self.authenticate(request.version, &request.handoff_id, &request.browser_proof_hex, now)?;
        if request.import_id != self.import_id { return Err("Local handoff result does not match"); }
        self.phase = match (self.phase, request.outcome) {
            (Phase::Offered, Outcome::Received) => Phase::Received,
            (Phase::Received, Outcome::Saved) => Phase::Saved,
            (Phase::Offered, Outcome::Rejected) => Phase::Rejected,
            (Phase::Reviewing | Phase::Offered, Outcome::Uncertain) => Phase::Uncertain,
            _ => return Err("Local handoff result is out of order"),
        };
        Ok(self.status(now))
    }
    pub fn cancel(&mut self) -> CancelResponse {
        self.clear_sensitive();
        self.phase = Phase::Cancelled;
        CancelResponse { delivery_may_have_occurred: self.dispatched }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CODE: &str = "ABCDEFGHIJKLMNOPQRST";
    const PROOF: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    pub(super) fn approved() -> String {
        r#"{ "appId":"fixture", "actionId":"add", "destination":"https://example.test/import", "recipient":"Fixture recipient", "idempotencyKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "payload":{"amount":1.2300,"note":"\u0627"} }"#.into()
    }
    fn fixture() -> Attempt { Attempt::new(BeginRequest { approved_request_json: approved() }, "22".repeat(16), CODE, 1000).unwrap() }
    fn claim_body(code: &str) -> Vec<u8> { serde_json::to_vec(&serde_json::json!({"version":1,"code":code,"browserProofHex":PROOF})).unwrap() }
    fn proof() -> ProofRequest { ProofRequest { version: 1, handoff_id: "22".repeat(16), browser_proof_hex: PROOF.into() } }
    fn dispatch() -> DispatchRequest { DispatchRequest { version: 1, handoff_id: "22".repeat(16), browser_proof_hex: PROOF.into(), import_id: "A".repeat(43) } }
    fn result(outcome: Outcome) -> ResultRequest { ResultRequest { version: 1, handoff_id: "22".repeat(16), browser_proof_hex: PROOF.into(), import_id: "A".repeat(43), outcome } }

    #[test]
    fn immutable_raw_json_is_claimed_exactly_once_and_not_delivery() {
        let mut attempt = fixture();
        let response = attempt.claim(&claim_body(CODE), 2000).unwrap();
        assert_eq!(response.approved_request_json, approved());
        assert_eq!(response.expires_at_ms, 602000);
        assert!(attempt.approved_json.is_none() && attempt.code_hash.is_none());
        assert!(attempt.claim(&claim_body(CODE), 2001).is_err());
        let status = attempt.authenticated_status(proof(), 3000).unwrap();
        assert_eq!(status.phase, Phase::Reviewing);
        assert!(!status.delivery_may_have_occurred);
    }
    #[test]
    fn five_bad_claims_expire_without_leaking_or_replacing_payload() {
        let mut attempt = fixture();
        for index in 0..5 {
            assert!(attempt.claim(&claim_body("X"), 2000).is_err());
            assert_eq!(attempt.status(2000).phase, if index == 4 { Phase::Expired } else { Phase::AwaitingClaim });
        }
        assert!(attempt.approved_json.is_none() && attempt.code_hash.is_none());
        assert!(attempt.claim(&claim_body(CODE), 2001).is_err());
    }
    #[test]
    fn dispatch_is_one_shot_and_saved_requires_received() {
        let mut attempt = fixture();
        assert!(attempt.dispatch(dispatch(), 2000).is_err());
        attempt.claim(&claim_body(CODE), 2000).unwrap();
        assert!(attempt.result(result(Outcome::Saved), 3000).is_err());
        assert!(attempt.result(result(Outcome::Received), 3000).is_err());
        assert!(attempt.dispatch(dispatch(), 3000).unwrap().delivery_may_have_occurred);
        assert!(attempt.dispatch(dispatch(), 3001).is_err());
        assert!(attempt.result(result(Outcome::Saved), 3001).is_err());
        assert_eq!(attempt.result(result(Outcome::Received), 3001).unwrap().phase, Phase::Received);
        assert!(attempt.result(result(Outcome::Received), 3002).is_err());
        assert_eq!(attempt.result(result(Outcome::Saved), 3002).unwrap().phase, Phase::Saved);
        assert!(attempt.result(result(Outcome::Saved), 3003).is_err());
    }
    #[test]
    fn proof_import_and_attempt_bindings_are_required() {
        let mut attempt = fixture();
        attempt.claim(&claim_body(CODE), 2000).unwrap();
        let mut wrong = proof(); wrong.browser_proof_hex = "33".repeat(32);
        assert!(attempt.authenticated_status(wrong, 3000).is_err());
        let mut wrong = proof(); wrong.handoff_id = "44".repeat(16);
        assert!(attempt.authenticated_status(wrong, 3000).is_err());
        let mut wrong = proof(); wrong.version = 2;
        assert!(attempt.authenticated_status(wrong, 3000).is_err());
        let mut wrong = dispatch(); wrong.import_id = "B".repeat(43);
        assert!(attempt.dispatch(wrong, 3000).is_err());
        assert_eq!(attempt.status(3000).phase, Phase::Reviewing);
        attempt.dispatch(dispatch(), 3000).unwrap();
        let mut wrong = result(Outcome::Received); wrong.import_id = "B".repeat(43);
        assert!(attempt.result(wrong, 3000).is_err());
    }
    #[test]
    fn cancel_expire_and_lost_responses_never_authorize_resend() {
        let mut attempt = fixture();
        assert!(!attempt.cancel().delivery_may_have_occurred);
        assert!(attempt.claim(&claim_body(CODE), 2000).is_err());
        let mut attempt = fixture();
        assert!(attempt.claim(&claim_body(CODE), 121000).is_err());
        assert!(attempt.approved_json.is_none());
        let mut attempt = fixture();
        drop(attempt.claim(&claim_body(CODE), 2000).unwrap()); // Simulate response loss.
        assert!(attempt.claim(&claim_body(CODE), 2001).is_err());
        assert!(!attempt.cancel().delivery_may_have_occurred);
        assert!(attempt.dispatch(dispatch(), 3000).is_err());
        let mut attempt = fixture(); attempt.claim(&claim_body(CODE), 2000).unwrap();
        attempt.dispatch(dispatch(), 3000).unwrap();
        assert!(attempt.cancel().delivery_may_have_occurred);
        assert!(attempt.result(result(Outcome::Received), 3001).is_err());
        let mut attempt = fixture(); attempt.claim(&claim_body(CODE), 2000).unwrap();
        attempt.dispatch(dispatch(), 3000).unwrap();
        assert_eq!(attempt.status(602000).phase, Phase::Uncertain);
        assert!(attempt.result(result(Outcome::Received), 602000).is_err());
        let mut attempt = fixture(); attempt.claim(&claim_body(CODE), 2000).unwrap();
        attempt.dispatch(dispatch(), 3000).unwrap(); attempt.result(result(Outcome::Received), 3001).unwrap();
        assert_eq!(attempt.status(602000).phase, Phase::Received); // Never relabel receipt as saved.
    }
    #[test]
    fn duplicate_keys_unknown_fields_and_invalid_utf8_fail_closed() {
        for raw in [approved().replace("\"appId\":\"fixture\"", "\"appId\":\"fixture\",\"appId\":\"other\""),
            approved().replace("\"amount\":1.2300", "\"amount\":1,\"amount\":2"),
            approved().replace("\"amount\":1.2300", "\"__proto__\":{}"),
            approved().replace("\"amount\":1.2300", "\"constructor\":{}"),
            approved().replacen("{", "{\"rawMessage\":\"not accepted\",", 1)] {
            assert!(validate_approved_request(&raw).is_err());
        }
        assert!(parse_strict::<Value>(&[0xff], MAX_POST_BYTES).is_err());
        assert!(parse_strict::<ClaimRequest>(br#"{"version":1,"version":1,"code":"ABCDEFGHIJKLMNOPQRST","browserProofHex":"00"}"#, MAX_POST_BYTES).is_err());
        assert!(parse_strict::<ProofRequest>(br#"{"version":1,"handoffId":"x","browserProofHex":"00","extra":true}"#, MAX_POST_BYTES).is_err());
    }
    #[test]
    fn target_payload_and_collection_bounds_are_enforced() {
        for target in ["http://remote.example/import", "https://user:pass@example.test/import", "https://example.test/import#hidden", "javascript:alert(1)", "https://EXAMPLE.test/import"] {
            assert!(validate_approved_request(&approved().replace("https://example.test/import", target)).is_err());
        }
        for target in ["http://localhost:5000/import", "http://127.0.0.1:5000/import", "http://[::1]:5000/import"] {
            assert!(validate_approved_request(&approved().replace("https://example.test/import", target)).is_ok());
        }
        let mut value: Value = serde_json::from_str(&approved()).unwrap();
        value["payload"] = Value::String("x".repeat(64 * 1024));
        assert!(validate_approved_request(&value.to_string()).is_err());
        value["payload"] = serde_json::json!([0]);
        for _ in 0..17 { value["payload"] = serde_json::json!([value["payload"].clone()]); }
        assert!(validate_approved_request(&value.to_string()).is_err());
        value["payload"] = serde_json::json!(vec![0; 257]);
        assert!(validate_approved_request(&value.to_string()).is_err());
        assert!(validate_approved_request(&" ".repeat(MAX_REQUEST_BYTES + 1)).is_err());
    }
    #[test]
    fn native_window_is_exact_main_origin() {
        assert!(bundled_window_allowed("main", "http://tauri.localhost", "", false));
        for origin in ["https://tauri.localhost", "http://tauri.localhost:1234", "http://localhost", "null"] {
            assert!(!bundled_window_allowed("main", origin, "", false));
        }
        assert!(!bundled_window_allowed("popup", "http://tauri.localhost", "", false));
        assert!(!bundled_window_allowed("main", "http://tauri.localhost", "user", false));
    }
}
