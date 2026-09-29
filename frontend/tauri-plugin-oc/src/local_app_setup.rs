//! Bounded loopback app-setup return path. No logs, outbound calls, draft/credential transport,
//! file routes or persistence. Only the bundled local-test main window may own a session.
use crate::local_app_handoff_protocol::parse_strict;
use crate::local_app_setup_protocol::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use std::{
    convert::Infallible,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, Semaphore, watch},
};

pub const HTML_ASSET: &str = "local-native-app-setup.html";
pub const JS_ASSET: &str = "local-native-app-setup.js";
pub const PROFILE_ASSET: &str = "local-native-app-setup-profile.json";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundledProfile {
    version: u8,
    application_id: String,
    transport: String,
}
impl BundledProfile {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let profile: Self = parse_strict(bytes, 1024)?;
        if profile.version != 1
            || profile.application_id != "dev.openchatfork.localtest"
            || profile.transport != "private-app-setup-v1"
        {
            return Err("Local app setup transport is unavailable".into());
        }
        Ok(profile)
    }
}
pub struct BrowserAssets {
    pub html: Vec<u8>,
    pub script: Vec<u8>,
}
struct Shared {
    attempt: Mutex<Attempt>,
    host: String,
    origin: String,
    html: Bytes,
    script: Bytes,
    epoch_ms: u64,
    started: Instant,
}
impl Shared {
    fn now(&self) -> u64 {
        self.epoch_ms
            .saturating_add(self.started.elapsed().as_millis() as u64)
    }
}
struct Session {
    id: String,
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut attempt) = self.shared.attempt.lock() {
            attempt.cancel();
        }
        let _ = self.shutdown.send(true);
    }
}
#[derive(Default)]
pub struct LocalAppSetupBridge {
    session: AsyncMutex<Option<Session>>,
}
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|_| "Secure randomness is unavailable")?;
    Ok(hex::encode(value))
}
impl LocalAppSetupBridge {
    pub async fn begin(
        &self,
        request: BeginRequest,
        _profile: BundledProfile,
        assets: BrowserAssets,
    ) -> Result<BeginResponse, String> {
        validate_begin(&request)?;
        if assets.html.is_empty()
            || assets.html.len() > 64 * 1024
            || assets.script.is_empty()
            || assets.script.len() > 1024 * 1024
        {
            return Err("Bundled app setup assets are unavailable".into());
        }
        let mut current = self.session.lock().await;
        if let Some(session) = current.as_ref() {
            if session
                .shared
                .attempt
                .lock()
                .map_err(|_| "App setup state is unavailable")?
                .active(session.shared.now())
            {
                return Err(
                    "An app setup connection is active; cancel it before starting another".into(),
                );
            }
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Could not start local app setup")?;
        let port = listener
            .local_addr()
            .map_err(|_| "App setup address is unavailable")?
            .port();
        if port < 1024 {
            return Err("App setup requires an ephemeral local port".into());
        }
        let host = format!("localhost:{port}");
        let origin = format!("http://{host}");
        let id = random_hex(16)?;
        let bootstrap = random_hex(32)?;
        let proof = random_hex(32)?;
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "System time is unavailable")?
            .as_millis() as u64;
        let attempt = Attempt::new(request, id.clone(), &bootstrap, proof, epoch_ms)?;
        let response = BeginResponse {
            setup_id: id.clone(),
            // Fragment only: never an HTTP request/query/referrer. The bundled page removes it
            // immediately and redeems it once; no listener endpoint reveals this authority.
            url: format!("{origin}/setup#bootstrap={bootstrap}"),
            expires_at_ms: attempt.expires_at_ms,
        };
        let shared = Arc::new(Shared {
            attempt: Mutex::new(attempt),
            host,
            origin,
            html: assets.html.into(),
            script: assets.script.into(),
            epoch_ms,
            started: Instant::now(),
        });
        let (shutdown, mut cancelled) = watch::channel(false);
        let transport = shared.clone();
        tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(4));
            let mut expiry = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    _ = cancelled.changed() => break,
                    _ = expiry.tick() => {
                        if transport.attempt.lock().map(|mut a| matches!(a.phase(transport.now()), Phase::Expired | Phase::Cancelled)).unwrap_or(true) { break; }
                    }
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { break };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                        let transport = transport.clone(); let mut connection_cancelled = cancelled.clone();
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
        *current = Some(Session {
            id,
            shared,
            shutdown,
        });
        Ok(response)
    }
    pub async fn poll(&self, id: &str) -> Result<PollResult, String> {
        let current = self.session.lock().await;
        let session = current
            .as_ref()
            .filter(|s| s.id == id)
            .ok_or("Unknown app setup connection")?;
        let result = session
            .shared
            .attempt
            .lock()
            .map_err(|_| "App setup state is unavailable")?
            .poll(session.shared.now());
        if result.phase != Phase::Waiting {
            let _ = session.shutdown.send(true);
        }
        Ok(result)
    }
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let current = self.session.lock().await;
        let session = current
            .as_ref()
            .filter(|s| s.id == id)
            .ok_or("Unknown app setup connection")?;
        session
            .shared
            .attempt
            .lock()
            .map_err(|_| "App setup state is unavailable")?
            .cancel();
        let _ = session.shutdown.send(true);
        Ok(())
    }
}

type BrowserResponse = Response<Full<Bytes>>;
fn response(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> BrowserResponse {
    Response::builder().status(status).header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        // The explicitly opened app setup page needs its opener for source-bound messages.
        .header("Cross-Origin-Opener-Policy", "unsafe-none").header("Cross-Origin-Embedder-Policy", "unsafe-none")
        .header("Cross-Origin-Resource-Policy", "same-origin").header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY")
        .body(Full::new(body.into())).expect("fixed headers")
}
fn error(status: StatusCode) -> BrowserResponse {
    response(
        status,
        "text/plain; charset=utf-8",
        "Local app setup request rejected",
    )
}
fn allows_fetch_metadata(method: &Method, path: &str, headers: &hyper::HeaderMap) -> bool {
    const NAMES: [&str; 4] = [
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
    ];
    if NAMES
        .iter()
        .any(|name| headers.get_all(*name).iter().count() > 1)
    {
        return false;
    }
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if path == "/challenge" || path == "/result" {
        // Unlike static navigation, proof/result endpoints require real same-origin fetch metadata.
        return value("sec-fetch-site") == Some("same-origin")
            && matches!(value("sec-fetch-mode"), Some("same-origin" | "cors"))
            && value("sec-fetch-dest") == Some("empty")
            && !headers.contains_key("sec-fetch-user");
    }
    match value("sec-fetch-site") {
        None => NAMES.iter().all(|name| !headers.contains_key(*name)),
        Some("same-origin" | "none") => true,
        Some("cross-site") => {
            *method == Method::GET
                && path == "/setup"
                && !headers.contains_key(header::ORIGIN)
                && value("sec-fetch-mode") == Some("navigate")
                && value("sec-fetch-dest") == Some("document")
                && (!headers.contains_key("sec-fetch-user")
                    || value("sec-fetch-user") == Some("?1"))
        }
        _ => false,
    }
}
async fn handle(
    request: Request<Incoming>,
    shared: Arc<Shared>,
) -> Result<BrowserResponse, Infallible> {
    let headers = request.headers();
    if request.uri().authority().is_some()
        || request.uri().query().is_some()
        || headers.get_all(header::HOST).iter().count() != 1
        || headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(&shared.host)
    {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers
            .get(header::ORIGIN)
            .is_some_and(|v| v.to_str().ok() != Some(&shared.origin))
        || !allows_fetch_metadata(request.method(), request.uri().path(), headers)
    {
        return Ok(error(StatusCode::FORBIDDEN));
    }
    let path = request.uri().path().to_owned();
    {
        let Ok(mut attempt) = shared.attempt.lock() else {
            return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
        };
        if attempt.phase(shared.now()) != Phase::Waiting {
            return Ok(error(StatusCode::GONE));
        }
    }
    if request.method() == Method::GET {
        return Ok(match path.as_str() {
            "/setup" => response(
                StatusCode::OK,
                "text/html; charset=utf-8",
                shared.html.clone(),
            ),
            "/setup.js" => response(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                shared.script.clone(),
            ),
            "/challenge" => {
                if headers.get_all("x-openchat-setup-bootstrap").iter().count() != 1 {
                    return Ok(error(StatusCode::FORBIDDEN));
                }
                let Some(bootstrap) = headers
                    .get("x-openchat-setup-bootstrap")
                    .and_then(|value| value.to_str().ok())
                else {
                    return Ok(error(StatusCode::FORBIDDEN));
                };
                let Ok(mut attempt) = shared.attempt.lock() else {
                    return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
                };
                match attempt
                    .challenge(bootstrap, shared.now())
                    .and_then(|value| {
                        serde_json::to_vec(&value).map_err(|_| "Setup response unavailable")
                    }) {
                    Ok(body) => response(StatusCode::OK, "application/json", body),
                    Err(_) => error(StatusCode::FORBIDDEN),
                }
            }
            _ => error(StatusCode::NOT_FOUND),
        });
    }
    if request.method() != Method::POST || path != "/result" {
        return Ok(error(StatusCode::METHOD_NOT_ALLOWED));
    }
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(&shared.origin)
        || headers.get_all(header::CONTENT_TYPE).iter().count() != 1
        || !matches!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json" | "application/json; charset=utf-8")
        )
        || headers.get_all(header::CONTENT_LENGTH).iter().count() > 1
        || headers.get(header::CONTENT_LENGTH).is_some_and(|v| {
            v.to_str()
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .is_none_or(|n| n > MAX_POST_BYTES)
        })
    {
        return Ok(error(StatusCode::BAD_REQUEST));
    }
    let Ok(body) = Limited::new(request.into_body(), MAX_POST_BYTES)
        .collect()
        .await
    else {
        return Ok(error(StatusCode::PAYLOAD_TOO_LARGE));
    };
    let Ok(mut attempt) = shared.attempt.lock() else {
        return Ok(error(StatusCode::SERVICE_UNAVAILABLE));
    };
    Ok(match attempt.accept(&body.to_bytes(), shared.now()) {
        Ok(()) => response(StatusCode::OK, "application/json", r#"{"accepted":true}"#),
        Err(_) => error(StatusCode::FORBIDDEN),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn profile() -> BundledProfile {
        BundledProfile::parse(br#"{"version":1,"applicationId":"dev.openchatfork.localtest","transport":"private-app-setup-v1"}"#).unwrap()
    }
    fn begin() -> BeginRequest {
        BeginRequest {
            app_id: "fixture".into(),
            setup_url: "https://app.example/connect".into(),
        }
    }
    fn assets() -> BrowserAssets {
        BrowserAssets {
            html: b"<script src='/setup.js'></script>".to_vec(),
            script: b"void 0;".to_vec(),
        }
    }
    async fn fixture() -> (LocalAppSetupBridge, BeginResponse) {
        let bridge = LocalAppSetupBridge::default();
        let start = bridge.begin(begin(), profile(), assets()).await.unwrap();
        (bridge, start)
    }
    fn host(start: &BeginResponse) -> &str {
        start
            .url
            .split('#')
            .next()
            .unwrap()
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/setup")
            .unwrap()
    }
    fn bootstrap(start: &BeginResponse) -> &str {
        start.url.split_once("#bootstrap=").unwrap().1
    }
    async fn wire(start: &BeginResponse, request: String) -> String {
        let port = host(start)
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(response).unwrap()
    }
    const FETCH: &str =
        "Sec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: same-origin\r\nSec-Fetch-Dest: empty\r\n";
    async fn challenge(start: &BeginResponse) -> Value {
        let response = wire(
            start,
            format!(
                "GET /challenge HTTP/1.1\r\nHost: {}\r\n{FETCH}X-OpenChat-Setup-Bootstrap: {}\r\n\r\n",
                host(start), bootstrap(start)
            ),
        )
        .await;
        assert_eq!(status(&response), 200);
        body(&response)
    }
    async fn post(start: &BeginResponse, value: Value) -> String {
        let body = value.to_string();
        wire(start, format!("POST /result HTTP/1.1\r\nHost: {}\r\nOrigin: http://{}\r\n{FETCH}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", host(start), host(start), body.len())).await
    }
    fn status(value: &str) -> u16 {
        value.split_whitespace().nth(1).unwrap().parse().unwrap()
    }
    fn body(value: &str) -> Value {
        serde_json::from_str(value.split_once("\r\n\r\n").unwrap().1).unwrap()
    }
    fn result(challenge: &Value) -> Value {
        json!({"version":1,"setupId":challenge["setupId"],"browserProofHex":challenge["browserProofHex"],"catalogJson":"{ \"version\":1, \"apps\":[{\"id\":\"fixture\"}] }"})
    }
    #[tokio::test]
    async fn static_navigation_has_no_proof_or_setup_and_no_cors() {
        let (_bridge, start) = fixture().await;
        assert_eq!(start.setup_id.len(), 32);
        assert_eq!(bootstrap(&start).len(), 64);
        assert!(!start.url.contains(&start.setup_id));
        let response = wire(&start, format!("GET /setup HTTP/1.1\r\nHost: {}\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n\r\n", host(&start))).await;
        assert_eq!(status(&response), 200);
        assert!(
            !response.contains("browserProofHex")
                && !response.contains("app.example")
                && !response.contains(bootstrap(&start))
        );
        let headers = response.to_lowercase();
        assert!(
            headers.contains("cache-control: no-store")
                && headers.contains("frame-ancestors 'none'")
                && headers.contains("connect-src 'self'")
        );
        assert!(!headers.contains("access-control-allow-origin"));
        for path in ["/result", "/catalog", "/challenge"] {
            assert_ne!(
                status(
                    &wire(
                        &start,
                        format!("GET {path} HTTP/1.1\r\nHost: {}\r\n\r\n", host(&start))
                    )
                    .await
                ),
                200
            );
        }
    }
    #[tokio::test]
    async fn result_is_proof_bound_one_shot_and_native_poll_consumes_verbatim() {
        let (bridge, start) = fixture().await;
        let challenge = challenge(&start).await;
        assert_eq!(challenge["setupUrl"], "https://app.example/connect");
        assert_eq!(challenge["expiresAtMs"], start.expires_at_ms);
        let mut wrong = result(&challenge);
        wrong["browserProofHex"] = json!("ff".repeat(32));
        assert_eq!(status(&post(&start, wrong).await), 403);
        assert!(
            bridge
                .poll(&start.setup_id)
                .await
                .unwrap()
                .catalog_json
                .is_none()
        );
        let payload = result(&challenge);
        let response = post(&start, payload.clone()).await;
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response), json!({"accepted":true}));
        assert_eq!(status(&post(&start, payload.clone()).await), 410);
        assert!(bridge.begin(begin(), profile(), assets()).await.is_err());
        assert!(bridge.poll("wrong").await.is_err());
        let polled = bridge.poll(&start.setup_id).await.unwrap();
        assert_eq!(polled.phase, Phase::Received);
        assert_eq!(
            polled.catalog_json.as_deref(),
            payload["catalogJson"].as_str()
        );
        assert!(
            bridge
                .poll(&start.setup_id)
                .await
                .unwrap()
                .catalog_json
                .is_none()
        );
    }
    #[tokio::test]
    async fn proof_endpoint_rejects_cross_site_navigation_and_ambiguous_headers() {
        let (_bridge, start) = fixture().await;
        for metadata in [
            "",
            "Sec-Fetch-Site: same-origin\r\n",
            "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n",
            "Sec-Fetch-Site: none\r\nSec-Fetch-Mode: same-origin\r\nSec-Fetch-Dest: empty\r\n",
            "Sec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: empty\r\n",
            "Sec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: same-origin\r\nSec-Fetch-Dest: empty\r\nSec-Fetch-Site: same-origin\r\n",
        ] {
            assert_eq!(
                status(
                    &wire(
                        &start,
                        format!(
                            "GET /challenge HTTP/1.1\r\nHost: {}\r\n{metadata}X-OpenChat-Setup-Bootstrap: {}\r\n\r\n",
                            host(&start), bootstrap(&start)
                        )
                    )
                    .await
                ),
                403
            );
        }
        for (path, headers) in [
            (
                "/challenge?code=no",
                format!("Host: {}\r\n{FETCH}", host(&start)),
            ),
            ("/challenge", format!("Host: other.test\r\n{FETCH}")),
            (
                "/challenge",
                format!(
                    "Host: {}\r\nOrigin: https://other.test\r\n{FETCH}",
                    host(&start)
                ),
            ),
        ] {
            assert!([400, 403].contains(&status(
                &wire(&start, format!("GET {path} HTTP/1.1\r\n{headers}X-OpenChat-Setup-Bootstrap: {}\r\n\r\n", bootstrap(&start))).await
            )));
        }
        assert_eq!(challenge(&start).await["version"], 1);
    }
    #[tokio::test]
    async fn spoofed_browser_headers_cannot_bootstrap_and_valid_secret_is_one_use() {
        let (_bridge, start) = fixture().await;
        for supplied in [
            String::new(),
            format!("X-OpenChat-Setup-Bootstrap: {}\r\n", "ff".repeat(32)),
            format!(
                "X-OpenChat-Setup-Bootstrap: {}\r\nX-OpenChat-Setup-Bootstrap: {}\r\n",
                bootstrap(&start),
                bootstrap(&start)
            ),
        ] {
            let response = wire(
                &start,
                format!(
                    "GET /challenge HTTP/1.1\r\nHost: {}\r\n{FETCH}{supplied}\r\n",
                    host(&start)
                ),
            )
            .await;
            assert_eq!(status(&response), 403);
            assert!(!response.contains("browserProofHex") && !response.contains(bootstrap(&start)));
        }
        let accepted = challenge(&start).await;
        assert_ne!(accepted["browserProofHex"], bootstrap(&start));
        let replay = wire(&start, format!("GET /challenge HTTP/1.1\r\nHost: {}\r\n{FETCH}X-OpenChat-Setup-Bootstrap: {}\r\n\r\n", host(&start), bootstrap(&start))).await;
        assert_eq!(status(&replay), 403);
        assert!(!replay.contains("browserProofHex"));
        assert_eq!(status(&post(&start, result(&accepted)).await), 200);
    }
    #[tokio::test]
    async fn result_needs_exact_origin_and_type_and_cannot_be_cross_site() {
        let (bridge, start) = fixture().await;
        let body = result(&challenge(&start).await).to_string();
        for (origin, metadata, content_type) in [
            ("", FETCH, "application/json"),
            ("https://other.test", FETCH, "application/json"),
            ("SELF", "", "application/json"),
            ("SELF", FETCH, "text/plain"),
        ] {
            let origin = if origin == "SELF" {
                format!("http://{}", host(&start))
            } else {
                origin.into()
            };
            let response = wire(&start, format!("POST /result HTTP/1.1\r\nHost: {}\r\nOrigin: {origin}\r\n{metadata}Content-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}", host(&start), body.len())).await;
            assert!([400, 403].contains(&status(&response)));
        }
        assert!(
            bridge
                .poll(&start.setup_id)
                .await
                .unwrap()
                .catalog_json
                .is_none()
        );
    }
    #[tokio::test]
    async fn cancel_drop_and_replacement_close_the_old_listener() {
        let (bridge, start) = fixture().await;
        let previous = challenge(&start).await;
        assert!(bridge.begin(begin(), profile(), assets()).await.is_err());
        bridge.cancel(&start.setup_id).await.unwrap();
        assert_eq!(
            bridge.poll(&start.setup_id).await.unwrap().phase,
            Phase::Cancelled
        );
        let next = bridge.begin(begin(), profile(), assets()).await.unwrap();
        assert_ne!(next.setup_id, start.setup_id);
        let next_challenge = challenge(&next).await;
        assert_ne!(
            next_challenge["browserProofHex"],
            previous["browserProofHex"]
        );
        assert_eq!(status(&post(&next, result(&previous)).await), 403);
        let port = host(&next)
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        drop(bridge);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        );
    }
    #[test]
    fn only_exact_localtest_profile_and_bundled_origin_are_eligible() {
        for raw in [
            r#"{"version":1,"applicationId":"com.oclabs.openchat","transport":"private-app-setup-v1"}"#,
            r#"{"version":1,"applicationId":"dev.openchatfork.localtest","transport":"private-app-code-v1"}"#,
            r#"{"version":1,"version":1,"applicationId":"dev.openchatfork.localtest","transport":"private-app-setup-v1"}"#,
        ] {
            assert!(BundledProfile::parse(raw.as_bytes()).is_err());
        }
        use crate::local_app_handoff_protocol::bundled_window_allowed;
        assert!(bundled_window_allowed(
            "main",
            "http://tauri.localhost",
            "",
            false
        ));
        assert!(!bundled_window_allowed(
            "other",
            "http://tauri.localhost",
            "",
            false
        ));
        assert!(!bundled_window_allowed(
            "main",
            "https://app.example",
            "",
            false
        ));
    }
}
