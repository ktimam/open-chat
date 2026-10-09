//! One explicit app-setup response, not authentication, a draft transport or a persistence store.
use crate::local_app_handoff_protocol::parse_strict;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const SETUP_LIFETIME_MS: u64 = 600_000;
pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;
// JSON string escaping may encode one decoded catalog byte using six envelope bytes.
pub const MAX_POST_BYTES: usize = MAX_CATALOG_BYTES * 6 + 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginRequest {
    pub app_id: String,
    pub setup_url: String,
    #[serde(default, deserialize_with = "present_context")]
    pub setup_context: Option<Value>,
}
fn present_context<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResponse {
    pub setup_id: String,
    pub url: String,
    pub expires_at_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub version: u8,
    pub setup_id: String,
    pub app_id: String,
    pub setup_url: String,
    pub expires_at_ms: u64,
    pub browser_proof_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_context: Option<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Waiting,
    Received,
    Expired,
    Cancelled,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub phase: Phase,
    pub expires_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_json: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultRequest {
    pub version: u8,
    pub setup_id: String,
    pub browser_proof_hex: String,
    pub catalog_json: String,
}

fn hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn validate_begin(request: &BeginRequest) -> Result<(), &'static str> {
    let id = request.app_id.as_bytes();
    if id.is_empty()
        || id.len() > 128
        || !id[0].is_ascii_alphanumeric()
        || !id
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/@+-".contains(b))
    {
        return Err("Invalid app setup identifier");
    }
    let url = reqwest::Url::parse(&request.setup_url).map_err(|_| "Invalid app setup URL")?;
    if request.setup_url.len() > 2048
        || url.as_str() != request.setup_url
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err("Invalid app setup URL");
    }
    if let Some(context) = &request.setup_context {
        validate_context(context, &request.app_id)?;
    }
    Ok(())
}
pub fn validate_catalog(raw: &str, app_id: &str) -> Result<(), &'static str> {
    let value: Value = parse_strict(raw.as_bytes(), MAX_CATALOG_BYTES)?;
    let root = value.as_object().ok_or("Invalid app setup catalog")?;
    let apps = root
        .get("apps")
        .and_then(Value::as_array)
        .ok_or("Invalid app setup catalog")?;
    if root.len() != 2
        || root.get("version") != Some(&Value::from(1))
        || apps.len() != 1
        || apps[0]
            .as_object()
            .and_then(|app| app.get("id"))
            .and_then(Value::as_str)
            != Some(app_id)
    {
        return Err("App setup catalog does not match the requested app");
    }
    // The existing frontend parser still validates the complete schema, public package binding,
    // processor hash and exact source origin before installing this opaque app-owned setup.
    Ok(())
}

const MAX_SETUP_ROUTES: usize = 32;
fn opaque_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && b"AEIMQUYcgkosw048".contains(&s.as_bytes()[42])
    })
}
fn exact_keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|row| {
        required.iter().all(|key| row.contains_key(*key))
            && row
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
fn validate_routes<'a>(value: &'a Value, app_id: &str) -> Result<Vec<&'a str>, &'static str> {
    let routes = value.as_array().ok_or("Invalid scoped app setup")?;
    if routes.len() > MAX_SETUP_ROUTES {
        return Err("Invalid scoped app setup");
    }
    let mut handles = Vec::new();
    for route in routes {
        if !exact_keys(route, &["handle", "catalogJson"], &[]) || !opaque_id(route.get("handle")) {
            return Err("Invalid scoped app setup");
        }
        let handle = route["handle"].as_str().ok_or("Invalid scoped app setup")?;
        if handles.contains(&handle) {
            return Err("Invalid scoped app setup");
        }
        handles.push(handle);
        validate_catalog(
            route["catalogJson"]
                .as_str()
                .ok_or("Invalid scoped app setup")?,
            app_id,
        )?;
    }
    Ok(handles)
}
fn validate_context(value: &Value, app_id: &str) -> Result<(), &'static str> {
    if serde_json::to_vec(value)
        .map_err(|_| "Invalid scoped app setup")?
        .len()
        > MAX_CATALOG_BYTES
        || value.get("version") != Some(&Value::from(2))
    {
        return Err("Invalid scoped app setup");
    }
    match value.get("scope").and_then(Value::as_str) {
        Some("account") => {
            if !exact_keys(
                value,
                &["version", "scope", "routes"],
                &["accountId", "legacyCatalogJson"],
            ) || (value.get("accountId").is_some() && !opaque_id(value.get("accountId")))
            {
                return Err("Invalid scoped app setup");
            }
            validate_routes(&value["routes"], app_id)?;
            if let Some(legacy) = value.get("legacyCatalogJson") {
                validate_catalog(legacy.as_str().ok_or("Invalid scoped app setup")?, app_id)?;
            }
        }
        Some("chat") => {
            if !exact_keys(
                value,
                &["version", "scope", "accountId", "handle"],
                &["catalogJson"],
            ) || !opaque_id(value.get("accountId"))
                || !opaque_id(value.get("handle"))
            {
                return Err("Invalid scoped app setup");
            }
            if let Some(catalog) = value.get("catalogJson") {
                validate_catalog(catalog.as_str().ok_or("Invalid scoped app setup")?, app_id)?;
            }
        }
        _ => return Err("Invalid scoped app setup"),
    }
    Ok(())
}
fn validate_result(raw: &str, app_id: &str, context: Option<&Value>) -> Result<(), &'static str> {
    let Some(context) = context else {
        return validate_catalog(raw, app_id);
    };
    validate_context(context, app_id)?;
    let value: Value = parse_strict(raw.as_bytes(), MAX_CATALOG_BYTES)?;
    if !exact_keys(
        &value,
        &[
            "version",
            "scope",
            "appId",
            "accountId",
            "catalogJson",
            "routes",
        ],
        &[],
    ) || value.get("version") != Some(&Value::from(2))
        || value.get("scope") != context.get("scope")
        || value.get("appId").and_then(Value::as_str) != Some(app_id)
        || !opaque_id(value.get("accountId"))
        || (context.get("accountId").is_some()
            && context.get("accountId") != value.get("accountId"))
    {
        return Err("Invalid scoped app setup");
    }
    validate_catalog(
        value["catalogJson"]
            .as_str()
            .ok_or("Invalid scoped app setup")?,
        app_id,
    )?;
    let handles = validate_routes(&value["routes"], app_id)?;
    let expected = if context["scope"].as_str() == Some("chat") {
        vec![
            context["handle"]
                .as_str()
                .ok_or("Invalid scoped app setup")?,
        ]
    } else {
        validate_routes(&context["routes"], app_id)?
    };
    if handles.len() != expected.len() || handles.iter().any(|handle| !expected.contains(handle)) {
        return Err("Invalid scoped app setup");
    }
    Ok(())
}

pub struct Attempt {
    pub setup_id: String,
    pub expires_at_ms: u64,
    started_at_ms: u64,
    request: BeginRequest,
    phase: Phase,
    bootstrap_hash: Option<[u8; 32]>,
    proof: Option<String>,
    catalog_json: Option<String>,
}
impl Attempt {
    pub fn new(
        request: BeginRequest,
        setup_id: String,
        bootstrap: &str,
        proof: String,
        now: u64,
    ) -> Result<Self, &'static str> {
        validate_begin(&request)?;
        if !hex(&setup_id, 16) || !hex(bootstrap, 32) || !hex(&proof, 32) || bootstrap == proof {
            return Err("Invalid app setup randomness");
        }
        let expires_at_ms = now
            .checked_add(SETUP_LIFETIME_MS)
            .ok_or("Invalid app setup deadline")?;
        Ok(Self {
            setup_id,
            expires_at_ms,
            started_at_ms: now,
            request,
            phase: Phase::Waiting,
            bootstrap_hash: Some(Sha256::digest(bootstrap.as_bytes()).into()),
            proof: Some(proof),
            catalog_json: None,
        })
    }
    fn expire(&mut self, now: u64) {
        if now < self.started_at_ms || now >= self.expires_at_ms {
            self.bootstrap_hash = None;
            self.proof = None;
            self.catalog_json = None;
            if self.phase != Phase::Cancelled {
                self.phase = Phase::Expired;
            }
        }
    }
    pub fn phase(&mut self, now: u64) -> Phase {
        self.expire(now);
        self.phase
    }
    pub fn active(&mut self, now: u64) -> bool {
        self.expire(now);
        self.phase == Phase::Waiting
            || (self.phase == Phase::Received && self.catalog_json.is_some())
    }
    pub fn challenge(&mut self, bootstrap: &str, now: u64) -> Result<Challenge, &'static str> {
        self.expire(now);
        if self.phase != Phase::Waiting {
            return Err("App setup is no longer waiting");
        }
        let actual = Sha256::digest(bootstrap.as_bytes());
        if !hex(bootstrap, 32)
            || !self.bootstrap_hash.as_ref().is_some_and(|expected| {
                expected
                    .iter()
                    .zip(actual)
                    .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                    == 0
            })
        {
            return Err("App setup bootstrap is unavailable");
        }
        // A local process can spoof browser headers; only the native-launched browser receives
        // this one-use fragment secret. Consume before responding, including lost responses.
        self.bootstrap_hash = None;
        Ok(Challenge {
            version: 1,
            setup_id: self.setup_id.clone(),
            app_id: self.request.app_id.clone(),
            setup_url: self.request.setup_url.clone(),
            expires_at_ms: self.expires_at_ms,
            browser_proof_hex: self.proof.clone().ok_or("App setup proof is unavailable")?,
            setup_context: self.request.setup_context.clone(),
        })
    }
    pub fn accept(&mut self, body: &[u8], now: u64) -> Result<(), &'static str> {
        self.expire(now);
        if self.phase != Phase::Waiting || self.bootstrap_hash.is_some() {
            return Err("App setup is no longer waiting");
        }
        let result: ResultRequest = parse_strict(body, MAX_POST_BYTES)?;
        let expected = Sha256::digest(
            self.proof
                .as_ref()
                .ok_or("App setup proof is unavailable")?
                .as_bytes(),
        );
        let actual = Sha256::digest(result.browser_proof_hex.as_bytes());
        let equal = expected
            .iter()
            .zip(actual)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0;
        if result.version != 1
            || result.setup_id != self.setup_id
            || !hex(&result.browser_proof_hex, 32)
            || !equal
        {
            return Err("App setup response does not match");
        }
        validate_result(
            &result.catalog_json,
            &self.request.app_id,
            self.request.setup_context.as_ref(),
        )?;
        self.catalog_json = Some(result.catalog_json);
        self.proof = None;
        self.phase = Phase::Received;
        Ok(())
    }
    pub fn poll(&mut self, now: u64) -> PollResult {
        self.expire(now);
        PollResult {
            phase: self.phase,
            expires_at_ms: self.expires_at_ms,
            catalog_json: self.catalog_json.take(),
        }
    }
    pub fn cancel(&mut self) {
        self.bootstrap_hash = None;
        self.proof = None;
        self.catalog_json = None;
        self.phase = Phase::Cancelled;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const RAW: &str =
        r#"{ "version":1, "apps":[{"id":"fixture","label":"\u0627","number":1.2300}] }"#;
    fn fixture() -> Attempt {
        Attempt::new(
            BeginRequest {
                app_id: "fixture".into(),
                setup_url: "https://app.example/connect".into(),
                setup_context: None,
            },
            "22".repeat(16),
            &"33".repeat(32),
            "11".repeat(32),
            1000,
        )
        .unwrap()
    }
    fn result(raw: &str) -> Value {
        json!({"version":1,"setupId":"22".repeat(16),"browserProofHex":"11".repeat(32),"catalogJson":raw})
    }
    fn ready() -> Attempt {
        let mut a = fixture();
        a.challenge(&"33".repeat(32), 1000).unwrap();
        a
    }
    #[test]
    fn opaque_catalog_is_returned_once_and_never_by_browser_challenge() {
        let mut a = fixture();
        assert!(a.poll(1000).catalog_json.is_none());
        let challenge = serde_json::to_value(a.challenge(&"33".repeat(32), 2000).unwrap()).unwrap();
        assert_eq!(challenge.as_object().unwrap().len(), 6);
        assert!(challenge.get("catalogJson").is_none());
        a.accept(result(RAW).to_string().as_bytes(), 3000).unwrap();
        assert!(a.proof.is_none());
        assert!(a.challenge(&"33".repeat(32), 3000).is_err());
        assert!(a.accept(result(RAW).to_string().as_bytes(), 3001).is_err());
        assert!(a.active(3001));
        let first = a.poll(3001);
        assert_eq!(first.phase, Phase::Received);
        assert_eq!(first.catalog_json.as_deref(), Some(RAW));
        assert!(!a.active(3001));
        assert!(a.poll(3002).catalog_json.is_none());
    }
    #[test]
    fn proof_identifier_version_and_duplicate_fields_fail_closed() {
        for (field, value) in [
            ("version", json!(2)),
            ("setupId", json!("33".repeat(16))),
            ("browserProofHex", json!("44".repeat(32))),
            ("extra", json!("no")),
        ] {
            let mut a = ready();
            let mut body = result(RAW);
            body[field] = value;
            assert!(a.accept(body.to_string().as_bytes(), 2000).is_err());
            assert_eq!(a.phase(2000), Phase::Waiting);
            assert!(a.poll(2000).catalog_json.is_none());
        }
        let duplicate = result(RAW).to_string().replacen('{', "{\"version\":1,", 1);
        assert!(ready().accept(duplicate.as_bytes(), 2000).is_err());
    }
    #[test]
    fn only_exact_single_app_catalog_root_is_accepted() {
        for raw in [
            r#"{"version":1,"apps":[{"id":"other"}]}"#,
            r#"{"version":1,"apps":[]}"#,
            r#"{"version":1,"apps":[{"id":"fixture"},{"id":"other"}]}"#,
            r#"{"version":1,"apps":[{"id":"fixture"}],"draft":"no"}"#,
            r#"{"version":2,"apps":[{"id":"fixture"}]}"#,
            r#"{"version":1,"apps":[{"id":"fixture","id":"other"}]}"#,
            r#"{"version":1,"apps":[{"id":"fixture","constructor":{}}]}"#,
            "[]",
        ] {
            assert!(
                ready()
                    .accept(result(raw).to_string().as_bytes(), 2000)
                    .is_err()
            );
        }
    }
    #[test]
    fn decoded_catalog_limit_and_sixfold_escaped_envelope_are_distinct() {
        let prefix = r#"{"version":1,"apps":[{"id":"fixture","text":""#;
        let suffix = r#""}]}"#;
        let raw = format!(
            "{prefix}{}{suffix}",
            "a".repeat(MAX_CATALOG_BYTES - prefix.len() - suffix.len())
        );
        assert_eq!(raw.len(), MAX_CATALOG_BYTES);
        let escaped: String = raw.bytes().map(|byte| format!("\\u{byte:04x}")).collect();
        let body = format!(
            "{{\"version\":1,\"setupId\":\"{}\",\"browserProofHex\":\"{}\",\"catalogJson\":\"{escaped}\"}}",
            "22".repeat(16),
            "11".repeat(32)
        );
        assert!(body.len() < MAX_POST_BYTES);
        ready().accept(body.as_bytes(), 2000).unwrap();
        assert!(
            ready()
                .accept(result(&(raw + " ")).to_string().as_bytes(), 2000)
                .is_err()
        );
        assert!(
            ready()
                .accept(&vec![b' '; MAX_POST_BYTES + 1], 2000)
                .is_err()
        );
    }
    #[test]
    fn deadline_never_refreshes_and_cancel_or_expiry_clears_received_setup() {
        let mut a = fixture();
        assert_eq!(
            a.challenge(&"33".repeat(32), 600999).unwrap().expires_at_ms,
            601000
        );
        assert!(a.challenge(&"33".repeat(32), 601000).is_err());
        assert!(a.proof.is_none());
        for cancel in [false, true] {
            let mut a = ready();
            a.accept(result(RAW).to_string().as_bytes(), 2000).unwrap();
            if cancel {
                a.cancel();
            }
            assert!(
                a.poll(if cancel { 2001 } else { 601000 })
                    .catalog_json
                    .is_none()
            );
            assert!(a.proof.is_none());
        }
        assert_eq!(fixture().phase(999), Phase::Expired);
    }
    #[test]
    fn native_launch_bootstrap_is_required_one_use_and_distinct_from_result_proof() {
        let mut a = fixture();
        assert!(a.accept(result(RAW).to_string().as_bytes(), 1000).is_err());
        for wrong in ["".into(), "ff".repeat(32), "33".repeat(31)] {
            assert!(a.challenge(&wrong, 1000).is_err());
            assert!(a.bootstrap_hash.is_some());
        }
        let challenge = a.challenge(&"33".repeat(32), 1000).unwrap();
        assert_eq!(challenge.browser_proof_hex, "11".repeat(32));
        assert!(a.bootstrap_hash.is_none());
        assert!(a.challenge(&"33".repeat(32), 1001).is_err());
        a.accept(result(RAW).to_string().as_bytes(), 1002).unwrap();
        let mut a = fixture();
        a.cancel();
        assert!(a.bootstrap_hash.is_none() && a.proof.is_none());
        assert!(a.challenge(&"33".repeat(32), 1000).is_err());
    }
    #[test]
    fn begin_accepts_only_bounded_canonical_setup_urls_and_generic_ids() {
        for url in [
            "http://app.example/connect",
            "https://user:secret@app.example/connect",
            "https://app.example/connect?token=no",
            "https://app.example/connect#no",
            "file:///setup",
            "https://APP.example/connect",
        ] {
            assert!(
                validate_begin(&BeginRequest {
                    app_id: "fixture".into(),
                    setup_url: url.into(),
                    setup_context: None,
                })
                .is_err()
            );
        }
        for url in [
            "https://app.example/connect",
            "http://localhost:3000/connect",
            "http://127.0.0.1:3000/connect",
            "http://[::1]:3000/connect",
        ] {
            validate_begin(&BeginRequest {
                app_id: "publisher:app-v1".into(),
                setup_url: url.into(),
                setup_context: None,
            })
            .unwrap();
        }
        for id in ["", "with space", "_initial", "α"] {
            assert!(
                validate_begin(&BeginRequest {
                    app_id: id.into(),
                    setup_url: "https://app.example/connect".into(),
                    setup_context: None,
                })
                .is_err()
            );
        }
    }

    fn scoped_context(scope: &str) -> Value {
        if scope == "chat" {
            json!({"version":2,"scope":"chat","accountId":"A".repeat(43),"handle":"B".repeat(42)+"A","catalogJson":RAW})
        } else {
            json!({"version":2,"scope":"account","accountId":"A".repeat(43),"legacyCatalogJson":RAW,
                "routes":[{"handle":"B".repeat(42)+"A","catalogJson":RAW}]})
        }
    }
    fn scoped_result(scope: &str) -> Value {
        json!({"version":2,"scope":scope,"appId":"fixture","accountId":"A".repeat(43),"catalogJson":RAW,
            "routes":[{"handle":"B".repeat(42)+"A","catalogJson":RAW}]})
    }
    #[test]
    fn scoped_setup_retains_exact_bindings_and_one_use_native_proof() {
        for scope in ["account", "chat"] {
            let context = scoped_context(scope);
            let mut a = fixture();
            a.request.setup_context = Some(context.clone());
            let challenge = a.challenge(&"33".repeat(32), 2000).unwrap();
            assert_eq!(challenge.setup_context, Some(context));
            let raw = scoped_result(scope).to_string();
            a.accept(result(&raw).to_string().as_bytes(), 3000).unwrap();
            assert_eq!(a.poll(3001).catalog_json.as_deref(), Some(raw.as_str()));
            assert!(a.poll(3002).catalog_json.is_none());
        }
    }
    #[test]
    fn scoped_reply_rejects_account_scope_app_and_handle_mismatch_or_partial_results() {
        for (field, replacement) in [
            ("scope", json!("chat")),
            ("accountId", json!("C".repeat(42) + "A")),
            ("appId", json!("other")),
            ("routes", json!([])),
            (
                "routes",
                json!([{"handle":"C".repeat(42)+"A","catalogJson":RAW}]),
            ),
            (
                "routes",
                json!([{"handle":"B".repeat(42)+"A","catalogJson":RAW},{"handle":"B".repeat(42)+"A","catalogJson":RAW}]),
            ),
            (
                "catalogJson",
                json!(r#"{"version":1,"apps":[{"id":"other"}]}"#),
            ),
            ("extra", json!(true)),
        ] {
            let mut value = scoped_result("account");
            value[field] = replacement;
            assert!(
                validate_result(
                    &value.to_string(),
                    "fixture",
                    Some(&scoped_context("account"))
                )
                .is_err()
            );
        }
        assert!(validate_result(RAW, "fixture", Some(&scoped_context("account"))).is_err());
        assert!(validate_result(&scoped_result("account").to_string(), "fixture", None).is_err());
    }
    #[test]
    fn scoped_context_and_response_bounds_fail_closed() {
        for scope in ["account", "chat"] {
            let mut context = scoped_context(scope);
            context["accountId"] = json!("B".repeat(43));
            assert!(validate_context(&context, "fixture").is_err());
            let mut context = scoped_context(scope);
            context["rawChatKey"] = json!("private");
            assert!(validate_context(&context, "fixture").is_err());
        }
        let mut context = scoped_context("account");
        context["routes"] = Value::Array(
            (0..33)
                .map(|i| json!({"handle":format!("{i:042}A"),"catalogJson":RAW}))
                .collect(),
        );
        assert!(validate_context(&context, "fixture").is_err());
        let mut context = scoped_context("account");
        context["legacyCatalogJson"] = json!("x".repeat(MAX_CATALOG_BYTES));
        assert!(validate_context(&context, "fixture").is_err());
        let mut begin = fixture().request;
        begin.setup_context = Some(Value::Null);
        assert!(validate_begin(&begin).is_err());
    }
}
