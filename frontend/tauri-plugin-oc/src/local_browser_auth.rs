//! A short-lived fixed-route loopback transport. It never authenticates a candidate itself.
//! No private keys, linking codes or cookies enter this server, and no request is logged.
use crate::local_browser_auth_protocol::{
    validate_begin, Attempt, BeginRequest, Challenge, PollResult, ATTEMPT_LIFETIME_MS,
    CLIENT_LABEL, MAX_CANDIDATE_BYTES, PROTOCOL, SESSION_LIFETIME_MS,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, header, server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use std::{convert::Infallible, net::Ipv4Addr, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::{net::TcpListener, sync::{watch, Mutex as AsyncMutex, Semaphore}};

pub const HTML_ASSET: &str = "local-browser-auth.html";
pub const JS_ASSET: &str = "local-browser-auth.js";
pub const PROFILE_ASSET: &str = "local-apk-profile.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundledProfile {
    pub version: u8,
    pub application_id: String,
    pub label: String,
    pub ota: String,
    pub native_authentication: String,
    pub identity_canister: String,
    pub identity_target_hex: String,
}

impl BundledProfile {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 4_096 { return Err("Invalid local APK authentication profile".into()); }
        let profile: Self = serde_json::from_slice(bytes).map_err(|_| "Invalid local APK authentication profile")?;
        if profile.version != 1 || profile.application_id != "dev.openchatfork.localtest" ||
            profile.label != CLIENT_LABEL || profile.ota != "none" || profile.native_authentication != "browser-bridge-v1" ||
            profile.identity_canister.is_empty() || profile.identity_canister.len() > 63 ||
            !profile.identity_canister.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') ||
            profile.identity_target_hex.is_empty() || profile.identity_target_hex.len() > 58 ||
            profile.identity_target_hex.len() % 2 != 0 || !profile.identity_target_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Local APK browser authentication is unavailable".into());
        }
        Ok(profile)
    }
}

pub struct BrowserAssets { pub html: Vec<u8>, pub script: Vec<u8> }
struct Shared {
    attempt: Mutex<Attempt>,
    host: String,
    origin: String,
    html: Bytes,
    script: Bytes,
}
struct Session {
    id: String,
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut attempt) = self.shared.attempt.lock() { attempt.cancel(); }
        let _ = self.shutdown.send(true);
    }
}

#[derive(Default)]
pub struct BrowserAuthBridge { session: AsyncMutex<Option<Session>> }

fn now_ms() -> Result<u64, String> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis() as u64)
        .map_err(|_| "System time is unavailable".into())
}
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|_| "Secure randomness is unavailable")?;
    Ok(hex::encode(value))
}

impl BrowserAuthBridge {
    pub async fn begin(&self, request: BeginRequest, profile: BundledProfile, assets: BrowserAssets) -> Result<Challenge, String> {
        validate_begin(&request)?;
        if assets.html.is_empty() || assets.html.len() > 64 * 1_024 ||
            assets.script.is_empty() || assets.script.len() > 4 * 1_024 * 1_024 {
            return Err("Bundled browser sign-in assets are unavailable".into());
        }
        let mut current = self.session.lock().await;
        if let Some(session) = current.as_ref() {
            let phase = session.shared.attempt.lock().map_err(|_| "Local sign-in state is unavailable")?.status(now_ms()?);
            if matches!(phase, "pending" | "pending_verification") {
                return Err("A local browser sign-in is already pending; cancel it before starting another".into());
            }
        }
        // Only the APK chooses the address; frontend callers cannot open a LAN/public listener.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await
            .map_err(|_| "Could not start local browser sign-in")?;
        let port = listener.local_addr().map_err(|_| "Local browser address unavailable")?.port();
        let host = format!("localhost:{port}");
        let origin = format!("http://{host}");
        let now = now_ms()?;
        let challenge = Challenge {
            protocol: PROTOCOL.into(), attempt_id: random_hex(16)?, nonce: random_hex(32)?,
            origin: origin.clone(), url: format!("{origin}/sign-in"),
            session_public_key_der_hex: request.session_public_key_der_hex,
            expected_username: request.expected_username, identity_canister: profile.identity_canister,
            identity_target_hex: profile.identity_target_hex,
            expires_at_ms: now.checked_add(ATTEMPT_LIFETIME_MS).ok_or("Invalid system time")?,
            delegation_expires_at_ms: now.checked_add(SESSION_LIFETIME_MS).ok_or("Invalid system time")?,
            client_label: CLIENT_LABEL.into(),
        };
        let shared = Arc::new(Shared {
            attempt: Mutex::new(Attempt::new(challenge.clone())), host, origin,
            html: Bytes::from(assets.html), script: Bytes::from(assets.script),
        });
        let (shutdown, mut cancelled) = watch::channel(false);
        let transport = shared.clone();
        tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(4));
            let lifetime = tokio::time::sleep(Duration::from_millis(ATTEMPT_LIFETIME_MS));
            tokio::pin!(lifetime);
            loop {
                tokio::select! {
                    _ = &mut lifetime => {
                        if let Ok(mut attempt) = transport.attempt.lock() {
                            let expires = attempt.challenge.expires_at_ms;
                            attempt.status(expires);
                        }
                        break;
                    }
                    _ = cancelled.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { break };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                        let transport = transport.clone();
                        let mut connection_cancelled = cancelled.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            let service = service_fn(move |request| handle(request, transport.clone()));
                            let mut builder = http1::Builder::new();
                            builder.keep_alive(false).max_headers(32).max_buf_size(16 * 1_024)
                                .timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(3));
                            let connection = builder.serve_connection(TokioIo::new(stream), service);
                            tokio::select! {
                                _ = tokio::time::timeout(Duration::from_secs(5), connection) => {},
                                _ = connection_cancelled.changed() => {},
                            }
                        });
                    }
                }
            }
        });
        *current = Some(Session { id: challenge.attempt_id.clone(), shared, shutdown });
        Ok(challenge)
    }

    pub async fn poll(&self, attempt_id: &str) -> Result<PollResult, String> {
        let current = self.session.lock().await;
        let session = current.as_ref().filter(|s| s.id == attempt_id).ok_or("Unknown local sign-in attempt")?;
        let result = session.shared.attempt.lock().map_err(|_| "Local sign-in state is unavailable")?.poll(now_ms()?);
        Ok(result)
    }

    pub async fn complete(&self, attempt_id: &str, accepted: bool) -> Result<(), String> {
        let current = self.session.lock().await;
        let session = current.as_ref().filter(|s| s.id == attempt_id).ok_or("Unknown local sign-in attempt")?;
        let result = session.shared.attempt.lock().map_err(|_| "Local sign-in state is unavailable")?.complete(accepted, now_ms()?);
        result.map_err(Into::into)
    }

    pub async fn cancel(&self, attempt_id: &str) -> Result<(), String> {
        let mut current = self.session.lock().await;
        if current.as_ref().is_some_and(|s| s.id == attempt_id) {
            // Drop closes the listener and cancels active connections, without touching stored data.
            current.take();
            Ok(())
        } else { Err("Unknown local sign-in attempt".into()) }
    }
}

type BrowserResponse = Response<Full<Bytes>>;
fn response(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> BrowserResponse {
    Response::builder().status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' https://icp-api.io; img-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .header("Cross-Origin-Opener-Policy", "same-origin")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY")
        .body(Full::new(body.into())).expect("fixed response headers are valid")
}
fn error(status: StatusCode) -> BrowserResponse { response(status, "text/plain; charset=utf-8", "Local sign-in request rejected") }

fn allows_fetch_metadata(method: &Method, path: &str, headers: &hyper::HeaderMap) -> bool {
    const FETCH_HEADERS: [&str; 4] = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];
    if FETCH_HEADERS.iter().any(|name| headers.get_all(*name).iter().count() > 1) { return false; }
    match headers.get("sec-fetch-site").map(|value| value.to_str()) {
        // Preserve clients without Fetch Metadata, but reject a partial header set.
        None => FETCH_HEADERS[1..].iter().all(|name| !headers.contains_key(*name)),
        Some(Ok("same-origin" | "none")) => true,
        // Chrome Custom Tabs mark the initial external document navigation cross-site
        // without Sec-Fetch-User; reloads may add ?1. Only the static entry document
        // may use that exception; it still requires an explicit passkey click. No
        // challenge/status/script or candidate data route gets a cross-site grant.
        Some(Ok("cross-site")) => method == Method::GET && path == "/sign-in" &&
            !headers.contains_key(header::ORIGIN) &&
            headers.get("sec-fetch-mode").and_then(|value| value.to_str().ok()) == Some("navigate") &&
            headers.get("sec-fetch-dest").and_then(|value| value.to_str().ok()) == Some("document") &&
            (!headers.contains_key("sec-fetch-user") ||
                headers.get("sec-fetch-user").and_then(|value| value.to_str().ok()) == Some("?1")),
        _ => false,
    }
}

async fn handle(request: Request<Incoming>, shared: Arc<Shared>) -> Result<BrowserResponse, Infallible> {
    let headers = request.headers();
    if request.uri().authority().is_some() || request.uri().query().is_some() ||
        headers.get_all(header::HOST).iter().count() != 1 ||
        headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(shared.host.as_str()) {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1 ||
        headers.get(header::ORIGIN).is_some_and(|v| v.to_str().ok() != Some(shared.origin.as_str())) ||
        !allows_fetch_metadata(request.method(), request.uri().path(), headers) {
        return Ok(error(StatusCode::FORBIDDEN));
    }
    let path = request.uri().path();
    let now = match now_ms() { Ok(value) => value, Err(_) => return Ok(error(StatusCode::SERVICE_UNAVAILABLE)) };
    if request.method() == Method::GET {
        let Ok(mut attempt) = shared.attempt.lock() else { return Ok(error(StatusCode::SERVICE_UNAVAILABLE)) };
        let status = attempt.status(now);
        if matches!(status, "expired" | "cancelled") { return Ok(error(StatusCode::GONE)); }
        return Ok(match path {
            "/sign-in" => response(StatusCode::OK, "text/html; charset=utf-8", shared.html.clone()),
            "/sign-in.js" => response(StatusCode::OK, "text/javascript; charset=utf-8", shared.script.clone()),
            "/challenge" if status == "pending" => response(StatusCode::OK, "application/json", serde_json::to_vec(&attempt.challenge).unwrap_or_default()),
            "/status" => response(StatusCode::OK, "application/json", format!("{{\"status\":\"{status}\"}}")),
            _ => error(StatusCode::NOT_FOUND),
        });
    }
    if request.method() != Method::POST || path != "/candidate" {
        return Ok(error(StatusCode::METHOD_NOT_ALLOWED));
    }
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(shared.origin.as_str()) ||
        !matches!(headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()), Some("application/json" | "application/json; charset=utf-8")) ||
        headers.get(header::CONTENT_LENGTH).is_some_and(|v| v.to_str().ok().and_then(|s| s.parse::<usize>().ok()).is_none_or(|size| size > MAX_CANDIDATE_BYTES)) {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    let collected = Limited::new(request.into_body(), MAX_CANDIDATE_BYTES).collect().await;
    let Ok(collected) = collected else { return Ok(error(StatusCode::PAYLOAD_TOO_LARGE)) };
    let Ok(mut attempt) = shared.attempt.lock() else { return Ok(error(StatusCode::SERVICE_UNAVAILABLE)) };
    let current_time = match now_ms() { Ok(value) => value, Err(_) => return Ok(error(StatusCode::SERVICE_UNAVAILABLE)) };
    if !attempt.accepts_candidate(current_time) { return Ok(error(StatusCode::CONFLICT)); }
    if attempt.submit(&collected.to_bytes(), current_time).is_err() { return Ok(error(StatusCode::BAD_REQUEST)); }
    Ok(response(StatusCode::ACCEPTED, "application/json", "{\"status\":\"pending_verification\"}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn profile() -> BundledProfile {
        BundledProfile::parse(br#"{"version":1,"applicationId":"dev.openchatfork.localtest","label":"OpenChat Fork \u00b7 Local Test","ota":"none","nativeAuthentication":"browser-bridge-v1","identityCanister":"fixture-cai","identityTargetHex":"ABCD"}"#).unwrap()
    }
    async fn fixture() -> (BrowserAuthBridge, Challenge) {
        let bridge = BrowserAuthBridge::default();
        let challenge = bridge.begin(BeginRequest {
            session_public_key_der_hex: "11".repeat(91), expected_username: "fixture-user".into(),
        }, profile(), BrowserAssets { html: b"<!doctype html><title>fixture</title>".to_vec(), script: b"void 0;".to_vec() }).await.unwrap();
        (bridge, challenge)
    }
    async fn request(challenge: &Challenge, wire: String) -> String {
        let port: u16 = challenge.origin.rsplit(':').next().unwrap().parse().unwrap();
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        stream.write_all(wire.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response)).await.unwrap().unwrap();
        String::from_utf8(response).unwrap()
    }
    fn candidate(challenge: &Challenge) -> String {
        serde_json::json!({
            "protocol": PROTOCOL, "attemptId": challenge.attempt_id, "nonce": challenge.nonce,
            "credentialIdHex": "22".repeat(32), "delegation": {"publicKey": "33".repeat(91),
                "delegations": [{"delegation": {"pubkey": challenge.session_public_key_der_hex,
                    "expiration": format!("{:x}", challenge.delegation_expires_at_ms * 1_000_000),
                    "targets": [challenge.identity_target_hex]}, "signature": "44".repeat(160)}]}
        }).to_string()
    }
    #[tokio::test]
    async fn serves_only_fixed_bundled_routes_with_no_cors_or_auth_in_url() {
        let (bridge, challenge) = fixture().await;
        assert!(challenge.url.starts_with("http://localhost:"));
        assert!(challenge.url.ends_with("/sign-in"));
        assert!(!challenge.url.contains(&challenge.nonce));
        assert_eq!(challenge.delegation_expires_at_ms - challenge.expires_at_ms, SESSION_LIFETIME_MS - ATTEMPT_LIFETIME_MS);
        let host = challenge.origin.trim_start_matches("http://");
        let response = request(&challenge, format!("GET /challenge HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Site: same-origin\r\n\r\n")).await;
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.to_ascii_lowercase().contains("cache-control: no-store"));
        assert!(!response.to_ascii_lowercase().contains("access-control-allow-origin"));
        assert!(response.contains(&challenge.session_public_key_der_hex));
        for path in ["/../secret", "/.env", "/sign-in?secret=x", "https://outside.invalid/sign-in"] {
            let response = request(&challenge, format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n")).await;
            assert!(!response.starts_with("HTTP/1.1 200"));
        }
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
    #[tokio::test]
    async fn rejects_wrong_host_origin_content_type_and_cross_site_requests() {
        let (bridge, challenge) = fixture().await;
        let host = challenge.origin.trim_start_matches("http://");
        for headers in [
            "Host: attacker.invalid\r\n".to_string(),
            format!("Host: {host}\r\nOrigin: http://attacker.invalid\r\n"),
            format!("Host: {host}\r\nSec-Fetch-Site: cross-site\r\n"),
        ] {
            let response = request(&challenge, format!("GET /challenge HTTP/1.1\r\n{headers}\r\n")).await;
            assert!(!response.starts_with("HTTP/1.1 200"));
        }
        for headers in [
            format!("Host: {host}\r\nContent-Type: application/json\r\n"),
            format!("Host: {host}\r\nOrigin: {}\r\nContent-Type: text/plain\r\n", challenge.origin),
        ] {
            let response = request(&challenge, format!("POST /candidate HTTP/1.1\r\n{headers}Content-Length: 2\r\n\r\n{{}}")).await;
            assert!(response.starts_with("HTTP/1.1 400"));
        }
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
    #[tokio::test]
    async fn chrome_custom_tab_initial_navigation_and_reload_load_only_static_document() {
        let (bridge, challenge) = fixture().await;
        let host = challenge.origin.trim_start_matches("http://");
        // True first Custom Tab request captured before target execution: no User header.
        let navigation = "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n";
        let page = request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\n{navigation}\r\n")).await;
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("<title>fixture</title>"));
        assert!(!page.contains(&challenge.session_public_key_der_hex));
        // A subsequent Chrome reload includes ?1 and also serves only the static page.
        let reload = request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\n{navigation}Sec-Fetch-User: ?1\r\n\r\n")).await;
        assert!(reload.starts_with("HTTP/1.1 200"));
        assert!(!reload.contains(&challenge.session_public_key_der_hex));
        let script = request(&challenge, format!("GET /sign-in.js HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: script\r\n\r\n")).await;
        assert!(script.starts_with("HTTP/1.1 200"));
        assert!(script.contains("void 0;"));
        let metadata = request(&challenge, format!("GET /challenge HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\n\r\n")).await;
        assert!(metadata.starts_with("HTTP/1.1 200"));
        assert!(metadata.contains(&challenge.session_public_key_der_hex));
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Pending));
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
    #[tokio::test]
    async fn navigation_exception_rejects_malformed_metadata_and_all_cross_site_data_routes() {
        let (bridge, challenge) = fixture().await;
        let host = challenge.origin.trim_start_matches("http://");
        let fields = ["Sec-Fetch-Site: cross-site", "Sec-Fetch-Mode: navigate", "Sec-Fetch-Dest: document", "Sec-Fetch-User: ?1"];
        let navigation = format!("{}\r\n", fields.join("\r\n"));
        for index in 0..fields.len() {
            let missing = fields.iter().enumerate().filter_map(|(i, field)| (i != index).then_some(*field)).collect::<Vec<_>>().join("\r\n");
            let duplicate = format!("{navigation}{}\r\n", fields[index]);
            if index != 3 { // The real initial external navigation has no User header.
                assert!(request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\n{missing}\r\n\r\n")).await.starts_with("HTTP/1.1 403"));
            }
            assert!(request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\n{duplicate}\r\n")).await.starts_with("HTTP/1.1 403"));
        }
        for (from, to) in [("cross-site", "same-site"), ("navigate", "cors"), ("document", "iframe"), ("?1", "?0"), ("?1", "?1, ?1"), ("?1", "true"), ("?1", "")] {
            let metadata = navigation.replace(from, to);
            assert!(request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\n{metadata}\r\n")).await.starts_with("HTTP/1.1 403"));
        }
        for origin in ["http://attacker.invalid", challenge.origin.as_str()] {
            assert!(request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\n{navigation}\r\n")).await.starts_with("HTTP/1.1 403"));
        }
        assert!(request(&challenge, format!("GET /sign-in HTTP/1.1\r\nHost: attacker.invalid\r\n{navigation}\r\n")).await.starts_with("HTTP/1.1 400"));
        for path in ["/sign-in?ignored=yes", "/sign-in.js", "/challenge", "/status", "/candidate", "/sign-in/"] {
            let response = request(&challenge, format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{navigation}\r\n")).await;
            assert!(!response.starts_with("HTTP/1.1 200"));
        }
        let body = candidate(&challenge);
        let common = format!("Host: {host}\r\nOrigin: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", challenge.origin, body.len());
        for metadata in [navigation.clone(), navigation.replace("Sec-Fetch-User: ?1\r\n", "")] {
            assert!(request(&challenge, format!("POST /candidate HTTP/1.1\r\n{common}{metadata}\r\n{body}")).await.starts_with("HTTP/1.1 403"));
        }
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Pending));
        assert!(request(&challenge, format!("POST /candidate HTTP/1.1\r\n{common}Sec-Fetch-Site: same-origin\r\n\r\n{body}")).await.starts_with("HTTP/1.1 202"));
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
    #[tokio::test]
    async fn candidate_is_one_shot_and_http_never_returns_the_signed_delegation() {
        let (bridge, challenge) = fixture().await;
        let host = challenge.origin.trim_start_matches("http://");
        let body = candidate(&challenge);
        let wire = format!("POST /candidate HTTP/1.1\r\nHost: {host}\r\nOrigin: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", challenge.origin, body.len());
        let response = request(&challenge, wire.clone()).await;
        assert!(response.starts_with("HTTP/1.1 202"));
        assert!(response.contains("pending_verification"));
        assert!(!response.contains("delegation"));
        assert!(request(&challenge, wire).await.starts_with("HTTP/1.1 409"));
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Submitted { .. }));
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Verifying));
        assert!(bridge.poll("wrong").await.is_err());
        let status = request(&challenge, format!("GET /status HTTP/1.1\r\nHost: {host}\r\n\r\n")).await;
        assert!(!status.contains(&"44".repeat(160)));
        bridge.complete(&challenge.attempt_id, false).await.unwrap();
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Failed));
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
    #[tokio::test]
    async fn simultaneous_begin_never_retargets_pending_key() {
        let (bridge, challenge) = fixture().await;
        assert!(bridge.begin(BeginRequest { session_public_key_der_hex: "99".repeat(91), expected_username: "different-user".into() }, profile(), BrowserAssets { html: vec![1], script: vec![1] }).await.is_err());
        assert!(matches!(bridge.poll(&challenge.attempt_id).await.unwrap(), PollResult::Pending));
        bridge.cancel(&challenge.attempt_id).await.unwrap();
    }
}
