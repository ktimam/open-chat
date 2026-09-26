//! Separate from authentication: a bounded loopback server for one explicitly approved draft.
//! No request logging, outbound requests, cookies, filesystem routes or unauthenticated data GET.
use crate::local_app_handoff_protocol::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, header, server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use std::{convert::Infallible, net::Ipv4Addr, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tokio::{net::TcpListener, sync::{watch, Mutex as AsyncMutex, Semaphore}};

pub const HTML_ASSET: &str = "local-native-app-handoff.html";
pub const JS_ASSET: &str = "local-native-app-handoff.js";
pub const PROFILE_ASSET: &str = "local-native-app-handoff-profile.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundledProfile { version: u8, application_id: String, transport: String }
impl BundledProfile {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let profile: Self = parse_strict(bytes, 1024)?;
        if profile.version != 1 || profile.application_id != "dev.openchatfork.localtest" || profile.transport != "private-app-code-v1" {
            return Err("Local private app transport is unavailable".into());
        }
        Ok(profile)
    }
}
pub struct BrowserAssets { pub html: Vec<u8>, pub script: Vec<u8> }
struct Shared {
    attempt: Mutex<Attempt>, host: String, origin: String, html: Bytes, script: Bytes,
    epoch_ms: u64, started: Instant,
}
impl Shared { fn now(&self) -> u64 { self.epoch_ms.saturating_add(self.started.elapsed().as_millis() as u64) } }
struct Session { id: String, shared: Arc<Shared>, shutdown: watch::Sender<bool> }
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut attempt) = self.shared.attempt.lock() { attempt.cancel(); }
        let _ = self.shutdown.send(true);
    }
}
#[derive(Default)]
pub struct LocalAppHandoffBridge { session: AsyncMutex<Option<Session>> }

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|_| "Secure randomness is unavailable")?;
    Ok(hex::encode(value))
}
fn pairing_code() -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bytes = [0u8; 13];
    getrandom::fill(&mut bytes).map_err(|_| "Secure randomness is unavailable")?;
    // Exactly 100 independent bits, not modulo reduction of random bytes.
    Ok((0..20).map(|i| {
        let bit = i * 5;
        let word = ((bytes[bit / 8] as u16) << 8) | bytes.get(bit / 8 + 1).copied().unwrap_or(0) as u16;
        ALPHABET[((word >> (11 - bit % 8)) & 31) as usize] as char
    }).collect())
}

impl LocalAppHandoffBridge {
    pub async fn begin(&self, request: BeginRequest, _profile: BundledProfile, assets: BrowserAssets) -> Result<BeginResponse, String> {
        validate_approved_request(&request.approved_request_json)?;
        if assets.html.is_empty() || assets.html.len() > 64 * 1024 || assets.script.is_empty() || assets.script.len() > 1024 * 1024 {
            return Err("Bundled private handoff assets are unavailable".into());
        }
        let mut current = self.session.lock().await;
        if let Some(session) = current.as_ref() {
            if session.shared.attempt.lock().map_err(|_| "Private handoff state is unavailable")?.active(session.shared.now()) {
                return Err("A private handoff is active; cancel it before starting another".into());
            }
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|_| "Could not start private handoff")?;
        let port = listener.local_addr().map_err(|_| "Private handoff address is unavailable")?.port();
        if port < 1024 { return Err("Private handoff requires an ephemeral local port".into()); }
        let host = format!("localhost:{port}");
        let origin = format!("http://{host}");
        let id = random_hex(16)?;
        let code = pairing_code()?;
        let epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "System time is unavailable")?.as_millis() as u64;
        let attempt = Attempt::new(request, id.clone(), &code, epoch_ms)?;
        let response = BeginResponse { handoff_id: id.clone(), url: format!("{origin}/handoff"), pairing_code: code, claim_expires_at_ms: attempt.claim_expires_at_ms };
        let shared = Arc::new(Shared { attempt: Mutex::new(attempt), host, origin, html: assets.html.into(), script: assets.script.into(), epoch_ms, started: Instant::now() });
        let (shutdown, mut cancelled) = watch::channel(false);
        let transport = shared.clone();
        tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(4));
            let mut expiry = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    _ = cancelled.changed() => break,
                    _ = expiry.tick() => {
                        let now = transport.now();
                        if transport.attempt.lock().map(|mut a| now >= a.status(now).expires_at_ms).unwrap_or(true) { break; }
                    }
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
                            builder.keep_alive(false).max_headers(32).max_buf_size(16 * 1024)
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
        *current = Some(Session { id, shared, shutdown });
        Ok(response)
    }
    pub async fn poll(&self, id: &str) -> Result<Status, String> {
        let current = self.session.lock().await;
        let session = current.as_ref().filter(|s| s.id == id).ok_or("Unknown private handoff")?;
        let status = session.shared.attempt.lock().map_err(|_| "Private handoff state is unavailable")?.status(session.shared.now());
        Ok(status)
    }
    pub async fn cancel(&self, id: &str) -> Result<CancelResponse, String> {
        let current = self.session.lock().await;
        let session = current.as_ref().filter(|s| s.id == id).ok_or("Unknown private handoff")?;
        let result = session.shared.attempt.lock().map_err(|_| "Private handoff state is unavailable")?.cancel();
        let _ = session.shutdown.send(true);
        Ok(result)
    }
}

type BrowserResponse = Response<Full<Bytes>>;
fn response(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> BrowserResponse {
    Response::builder().status(status).header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        // Unlike sign-in, the explicit app popup must retain its opener for source-bound messages.
        .header("Cross-Origin-Opener-Policy", "unsafe-none")
        .header("Cross-Origin-Embedder-Policy", "unsafe-none")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY").body(Full::new(body.into())).expect("fixed headers")
}
fn error(status: StatusCode) -> BrowserResponse { response(status, "text/plain; charset=utf-8", "Private handoff request rejected") }
fn allows_fetch_metadata(method: &Method, path: &str, headers: &hyper::HeaderMap) -> bool {
    const NAMES: [&str; 4] = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];
    if NAMES.iter().any(|h| headers.get_all(*h).iter().count() > 1) { return false; }
    match headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        None => NAMES.iter().all(|h| !headers.contains_key(*h)),
        Some("same-origin" | "none") => true,
        Some("cross-site") => *method == Method::GET && path == "/handoff" && !headers.contains_key(header::ORIGIN) &&
            headers.get("sec-fetch-mode").and_then(|v| v.to_str().ok()) == Some("navigate") &&
            headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok()) == Some("document") &&
            (!headers.contains_key("sec-fetch-user") || headers.get("sec-fetch-user").and_then(|v| v.to_str().ok()) == Some("?1")),
        _ => false,
    }
}
async fn handle(request: Request<Incoming>, shared: Arc<Shared>) -> Result<BrowserResponse, Infallible> {
    let headers = request.headers();
    if request.uri().authority().is_some() || request.uri().query().is_some() ||
        headers.get_all(header::HOST).iter().count() != 1 || headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(&shared.host) {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1 ||
        headers.get(header::ORIGIN).is_some_and(|v| v.to_str().ok() != Some(&shared.origin)) ||
        !allows_fetch_metadata(request.method(), request.uri().path(), headers) { return Ok(error(StatusCode::FORBIDDEN)); }
    let path = request.uri().path().to_owned();
    {
        let Ok(mut attempt) = shared.attempt.lock() else { return Ok(error(StatusCode::SERVICE_UNAVAILABLE)); };
        let status = attempt.status(shared.now());
        if shared.now() >= status.expires_at_ms || matches!(status.phase, Phase::Expired | Phase::Cancelled) { return Ok(error(StatusCode::GONE)); }
    }
    if request.method() == Method::GET {
        return Ok(match path.as_str() {
            "/handoff" => response(StatusCode::OK, "text/html; charset=utf-8", shared.html.clone()),
            "/handoff.js" => response(StatusCode::OK, "text/javascript; charset=utf-8", shared.script.clone()),
            _ => error(StatusCode::NOT_FOUND),
        });
    }
    if request.method() != Method::POST || !matches!(path.as_str(), "/claim" | "/status" | "/dispatch" | "/result") {
        return Ok(error(StatusCode::METHOD_NOT_ALLOWED));
    }
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(&shared.origin) ||
        headers.get_all(header::CONTENT_TYPE).iter().count() != 1 ||
        !matches!(headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()), Some("application/json" | "application/json; charset=utf-8")) ||
        headers.get(header::CONTENT_LENGTH).is_some_and(|v| v.to_str().ok().and_then(|s| s.parse::<usize>().ok()).is_none_or(|n| n > MAX_POST_BYTES)) {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    let Ok(body) = Limited::new(request.into_body(), MAX_POST_BYTES).collect().await else { return Ok(error(StatusCode::PAYLOAD_TOO_LARGE)); };
    let bytes = body.to_bytes();
    let Ok(mut attempt) = shared.attempt.lock() else { return Ok(error(StatusCode::SERVICE_UNAVAILABLE)); };
    let now = shared.now();
    let result = match path.as_str() {
        "/claim" => attempt.claim(&bytes, now).and_then(|v| serde_json::to_vec(&v).map_err(|_| "Private response unavailable")),
        "/status" => parse_strict(&bytes, MAX_POST_BYTES).and_then(|v| attempt.authenticated_status(v, now)).and_then(|v| serde_json::to_vec(&v).map_err(|_| "Private response unavailable")),
        "/dispatch" => parse_strict(&bytes, MAX_POST_BYTES).and_then(|v| attempt.dispatch(v, now)).and_then(|v| serde_json::to_vec(&v).map_err(|_| "Private response unavailable")),
        "/result" => parse_strict(&bytes, MAX_POST_BYTES).and_then(|v| attempt.result(v, now)).and_then(|v| serde_json::to_vec(&v).map_err(|_| "Private response unavailable")),
        _ => unreachable!(),
    };
    Ok(match result { Ok(body) => response(StatusCode::OK, "application/json", body), Err(_) => error(StatusCode::FORBIDDEN) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn profile() -> BundledProfile {
        BundledProfile::parse(br#"{"version":1,"applicationId":"dev.openchatfork.localtest","transport":"private-app-code-v1"}"#).unwrap()
    }
    fn raw_approved() -> String {
        format!(r#"{{"appId":"fixture","actionId":"add","destination":"https://example.test/import","recipient":"Fixture user","idempotencyKey":"{}","payload":{{"amount":1.2300,"note":"\u0627"}}}}"#, "A".repeat(43))
    }
    async fn fixture() -> (LocalAppHandoffBridge, BeginResponse) {
        let bridge = LocalAppHandoffBridge::default();
        let response = bridge.begin(BeginRequest { approved_request_json: raw_approved() }, profile(), BrowserAssets {
            html: b"<!doctype html><script src=\"/handoff.js\"></script>".to_vec(), script: b"void 0;".to_vec(),
        }).await.unwrap();
        (bridge, response)
    }
    fn host(start: &BeginResponse) -> &str { start.url.strip_prefix("http://").unwrap().strip_suffix("/handoff").unwrap() }
    async fn wire(start: &BeginResponse, request: String) -> String {
        let port: u16 = host(start).rsplit(':').next().unwrap().parse().unwrap();
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response)).await.unwrap().unwrap();
        String::from_utf8(response).unwrap()
    }
    async fn post(start: &BeginResponse, path: &str, body: Value) -> String {
        let body = body.to_string();
        wire(start, format!("POST {path} HTTP/1.1\r\nHost: {}\r\nOrigin: http://{}\r\nContent-Type: application/json\r\nSec-Fetch-Site: same-origin\r\nContent-Length: {}\r\n\r\n{body}", host(start), host(start), body.len())).await
    }
    fn status(response: &str) -> u16 { response.split_whitespace().nth(1).unwrap().parse().unwrap() }
    fn body(response: &str) -> Value { serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap() }
    fn proof(start: &BeginResponse) -> Value { json!({"version":1,"handoffId":start.handoff_id,"browserProofHex":"11".repeat(32)}) }
    async fn claim(start: &BeginResponse) -> String {
        post(start, "/claim", json!({"version":1,"code":start.pairing_code,"browserProofHex":"11".repeat(32)})).await
    }

    #[tokio::test]
    async fn static_first_navigation_and_reload_reveal_no_payload_or_code() {
        let (_bridge, start) = fixture().await;
        assert_eq!(start.pairing_code.len(), 20);
        assert!(start.pairing_code.bytes().all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b)));
        assert!(!start.url.contains(&start.pairing_code) && !start.url.contains(&start.handoff_id));
        for user in ["", "Sec-Fetch-User: ?1\r\n"] {
            let response = wire(&start, format!("GET /handoff HTTP/1.1\r\nHost: {}\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n{user}\r\n", host(&start))).await;
            assert_eq!(status(&response), 200);
            assert!(!response.contains(&start.pairing_code) && !response.contains("amount") && !response.contains("recipient"));
            let headers = response.to_lowercase();
            assert!(headers.contains("cache-control: no-store") && headers.contains("connect-src 'self'"));
            assert!(headers.contains("cross-origin-opener-policy: unsafe-none") && !headers.contains("access-control-allow-origin"));
        }
        for path in ["/approved", "/claim", "/status", "/dispatch", "/result", "/challenge"] {
            assert_eq!(status(&wire(&start, format!("GET {path} HTTP/1.1\r\nHost: {}\r\n\r\n", host(&start))).await), 404);
        }
    }
    #[tokio::test]
    async fn private_claim_is_authenticated_atomic_and_verbatim() {
        let (bridge, start) = fixture().await;
        assert_eq!(status(&post(&start, "/status", proof(&start)).await), 403);
        let response = claim(&start).await;
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response)["approvedRequestJson"], raw_approved());
        assert_eq!(status(&claim(&start).await), 403);
        let response = post(&start, "/status", proof(&start)).await;
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response)["phase"], "reviewing");
        assert_eq!(body(&response)["deliveryMayHaveOccurred"], false);
        assert_eq!(bridge.poll(&start.handoff_id).await.unwrap().phase, Phase::Reviewing);
    }
    #[tokio::test]
    async fn fresh_dispatch_gate_and_ordered_app_reported_outcomes() {
        let (bridge, start) = fixture().await;
        claim(&start).await;
        let mut dispatch = proof(&start); dispatch["importId"] = json!("A".repeat(43));
        let mut outcome = dispatch.clone(); outcome["outcome"] = json!("saved");
        assert_eq!(status(&post(&start, "/result", outcome.clone()).await), 403);
        assert_eq!(status(&post(&start, "/dispatch", dispatch.clone()).await), 200);
        assert_eq!(status(&post(&start, "/dispatch", dispatch).await), 403);
        assert_eq!(status(&post(&start, "/result", outcome.clone()).await), 403);
        outcome["outcome"] = json!("received");
        assert_eq!(body(&post(&start, "/result", outcome.clone()).await)["phase"], "received");
        outcome["outcome"] = json!("saved");
        assert_eq!(body(&post(&start, "/result", outcome.clone()).await)["phase"], "saved");
        assert_eq!(status(&post(&start, "/result", outcome).await), 403);
        assert!(bridge.poll(&start.handoff_id).await.unwrap().delivery_may_have_occurred);
    }
    #[tokio::test]
    async fn origin_host_metadata_and_malformed_bodies_cannot_claim() {
        let (_bridge, start) = fixture().await;
        let host = host(&start);
        let body = json!({"version":1,"code":start.pairing_code,"browserProofHex":"11".repeat(32)}).to_string();
        for (host_header, origin, metadata, content_type) in [
            (host.to_string(), "Origin: https://evil.test\r\n".to_string(), "Sec-Fetch-Site: same-origin\r\n", "application/json"),
            (host.to_string(), "".to_string(), "Sec-Fetch-Site: same-origin\r\n", "application/json"),
            ("other.test".into(), format!("Origin: http://{host}\r\n"), "Sec-Fetch-Site: same-origin\r\n", "application/json"),
            (host.into(), format!("Origin: http://{host}\r\n"), "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n", "application/json"),
            (host.into(), format!("Origin: http://{host}\r\n"), "Sec-Fetch-Site: same-origin\r\nSec-Fetch-Site: same-origin\r\n", "application/json"),
            (host.into(), format!("Origin: http://{host}\r\n"), "Sec-Fetch-Site: same-origin\r\n", "text/plain"),
        ] {
            let response = wire(&start, format!("POST /claim HTTP/1.1\r\nHost: {host_header}\r\n{origin}{metadata}Content-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}", body.len())).await;
            assert!([400, 403].contains(&status(&response)));
            assert!(!response.contains("approvedRequestJson"));
        }
        let duplicate = body.replacen("{", "{\"version\":1,", 1);
        assert_eq!(status(&wire(&start, format!("POST /claim HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{duplicate}", duplicate.len())).await), 403);
        assert_eq!(status(&claim(&start).await), 200); // Invalid requests did not release the payload.
    }
    #[tokio::test]
    async fn static_navigation_exception_is_narrow_and_invalid_pairs_lock_out() {
        let (_bridge, start) = fixture().await;
        for headers in ["Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\n", "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\nSec-Fetch-User: ?0\r\n", "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\nSec-Fetch-User: ?1\r\nSec-Fetch-User: ?1\r\n"] {
            assert_eq!(status(&wire(&start, format!("GET /handoff HTTP/1.1\r\nHost: {}\r\n{headers}\r\n", host(&start))).await), 403);
        }
        for path in ["/handoff.js", "/claim", "/handoff?code=no"] {
            assert!([400, 403].contains(&status(&wire(&start, format!("GET {path} HTTP/1.1\r\nHost: {}\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n\r\n", host(&start))).await)));
        }
        for _ in 0..5 { assert_eq!(status(&post(&start, "/claim", json!({"version":1,"code":"WRONG","browserProofHex":"11".repeat(32)})).await), 403); }
        assert_eq!(status(&claim(&start).await), 410);
    }
    #[tokio::test]
    async fn cancel_blocks_stale_browser_and_new_session_never_retargets_old_request() {
        let (bridge, start) = fixture().await;
        claim(&start).await;
        assert!(bridge.begin(BeginRequest { approved_request_json: raw_approved() }, profile(), BrowserAssets { html: vec![1], script: vec![1] }).await.is_err());
        assert!(!bridge.cancel(&start.handoff_id).await.unwrap().delivery_may_have_occurred);
        assert_eq!(bridge.poll(&start.handoff_id).await.unwrap().phase, Phase::Cancelled);
        let next = bridge.begin(BeginRequest { approved_request_json: raw_approved() }, profile(), BrowserAssets { html: vec![1], script: vec![1] }).await.unwrap();
        assert_ne!(next.handoff_id, start.handoff_id);
        assert_ne!(next.pairing_code, start.pairing_code);
        assert_eq!(status(&post(&next, "/status", proof(&start)).await), 403);
    }
    #[test]
    fn wrong_or_ambiguous_profile_is_unavailable() {
        assert!(BundledProfile::parse(br#"{"version":1,"applicationId":"com.oclabs.openchat","transport":"private-app-code-v1"}"#).is_err());
        assert!(BundledProfile::parse(br#"{"version":1,"version":1,"applicationId":"dev.openchatfork.localtest","transport":"private-app-code-v1"}"#).is_err());
    }
}
