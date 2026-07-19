use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::models::{
    DownloadModelRequest, DownloadModelResponse, DownloadedFile, InferRequest, InferResponse,
    LocalModel, ProbeModelUrlResponse, SystemResourcesResponse,
};

// Generic on-device model store (design deliverable A): downloads/verifies/lists/removes user-selected
// models under the app data dir, and dispatches inference to the native runtime. Nothing is bundled; the
// catalog and prompts are caller-supplied. Mirrors the streamed-download pattern in `update_manager.rs`.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    model_id: String,
    received_bytes: u64,
    total_bytes: u64,
}

pub struct ModelManager<R: Runtime> {
    app_handle: AppHandle<R>,
}

impl<R: Runtime> ModelManager<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self { app_handle }
    }

    fn models_dir(&self) -> Option<PathBuf> {
        self.app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("models"))
    }

    fn model_dir(&self, model_id: &str) -> Option<PathBuf> {
        self.models_dir().map(|p| p.join(sanitize(model_id)))
    }

    // Download all of a model's files, emitting "model-download-progress" events. A file with an
    // expected SHA-256 is verified after download (curated catalog entries); one without is trusted on
    // first use and its computed hash is returned so the caller can record it. Idempotent: already-present
    // files that still check out (by hash, or by size when untrusted) are skipped. Returns the observed
    // per-file hashes.
    pub async fn download_model(
        &self,
        req: DownloadModelRequest,
    ) -> Result<DownloadModelResponse, String> {
        let dir = self
            .model_dir(&req.model_id)
            .ok_or("could not resolve app data dir")?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let total_bytes: u64 = req.files.iter().map(|f| f.bytes).sum();
        let mut received: u64 = 0;
        let client = Client::new();
        let mut downloaded: Vec<DownloadedFile> = Vec::with_capacity(req.files.len());

        for file in &req.files {
            // Caller-chosen filename (sanitised) if given, else the URL's last path segment.
            let name = file
                .filename
                .as_deref()
                .map(sanitize)
                .unwrap_or_else(|| file_name_from_url(&file.url));
            let dest = dir.join(name);

            // Skip a file that's already present and good. With an expected hash, "good" means it
            // verifies; without one, fall back to an exact size match (best we can do untrusted).
            if dest.exists() {
                match &file.sha256 {
                    Some(expected) if verify_sha256(&dest, expected).unwrap_or(false) => {
                        received = received.saturating_add(file.bytes);
                        downloaded.push(DownloadedFile {
                            url: file.url.clone(),
                            sha256: expected.clone(),
                        });
                        continue;
                    }
                    None
                        if file.bytes > 0
                            && fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == file.bytes =>
                    {
                        received = received.saturating_add(file.bytes);
                        if let Ok(digest) = sha256_hex(&dest) {
                            downloaded.push(DownloadedFile {
                                url: file.url.clone(),
                                sha256: digest,
                            });
                        }
                        continue;
                    }
                    _ => {}
                }
            }

            let resp = client
                .get(&file.url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("download failed ({}): {}", resp.status(), file.url));
            }

            let mut out = fs::File::create(&dest).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut stream = resp.bytes_stream();
            let mut file_received: u64 = 0;

            while let Some(chunk) = stream.next().await {
                // On any stream/write error, drop the partial file so a later run can't mistake it for
                // complete (and gigabytes aren't stranded on disk).
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = fs::remove_file(&dest);
                        return Err(e.to_string());
                    }
                };
                if let Err(e) = out.write_all(&chunk) {
                    let _ = fs::remove_file(&dest);
                    return Err(e.to_string());
                }
                hasher.update(&chunk);
                file_received = file_received.saturating_add(chunk.len() as u64);
                received = received.saturating_add(chunk.len() as u64);
                let _ = self.app_handle.emit(
                    "model-download-progress",
                    ModelDownloadProgress {
                        model_id: req.model_id.clone(),
                        received_bytes: received,
                        total_bytes,
                    },
                );
            }

            let digest = hex::encode(hasher.finalize());
            match &file.sha256 {
                // Curated file: the hash is the authoritative integrity gate.
                Some(expected) => {
                    if !digest.eq_ignore_ascii_case(expected) {
                        let _ = fs::remove_file(&dest);
                        return Err(format!("sha256 mismatch for {}", file.url));
                    }
                }
                // Trust-on-first-use: no hash to check, so the expected size is the integrity proxy — this
                // rejects a complete-but-wrong body (e.g. an HTML error/login page returned as 200) before
                // it's blessed as the trusted baseline. Skipped only when the size is unknown (bytes == 0).
                None => {
                    if file.bytes > 0 && file_received != file.bytes {
                        let _ = fs::remove_file(&dest);
                        return Err(format!(
                            "size mismatch for {}: expected {} bytes, got {}",
                            file.url, file.bytes, file_received
                        ));
                    }
                }
            }
            downloaded.push(DownloadedFile {
                url: file.url.clone(),
                sha256: digest,
            });
        }

        // Persist a manifest so list_local_models can report the runtime + footprint.
        let manifest = LocalModel {
            model_id: req.model_id.clone(),
            runtime: req.runtime.clone(),
            size_bytes: total_bytes,
            path: dir.to_string_lossy().to_string(),
        };
        fs::write(
            dir.join("model.json"),
            serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        Ok(DownloadModelResponse { files: downloaded })
    }

    // Lightweight preflight for the "add a model from a URL" flow. HEAD the URL (falling back to a 1-byte
    // ranged GET when HEAD is disallowed) to learn the size, type, filename and range support without
    // downloading. Runs natively because the WebView can't: cross-origin HEAD to model hosts is CORS-blocked.
    pub async fn probe_model_url(&self, url: &str) -> ProbeModelUrlResponse {
        let mut out = ProbeModelUrlResponse {
            filename: file_name_from_url(url),
            ..Default::default()
        };

        // Scheme check is case-insensitive (RFC 3986) and tolerant of leading whitespace; reqwest
        // normalises the actual request URL, so the original `url` is still what gets fetched.
        let normalized = url.trim_start().to_ascii_lowercase();
        if !(normalized.starts_with("http://") || normalized.starts_with("https://")) {
            out.error = Some("URL must start with http:// or https://".to_string());
            return out;
        }

        let client = Client::new();
        let resp = match client.head(url).send().await {
            Ok(r) if r.status().is_success() => Some(r),
            // Some hosts reject HEAD; a 1-byte range request reveals the same metadata cheaply.
            _ => client
                .get(url)
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send()
                .await
                .ok(),
        };

        let Some(resp) = resp else {
            out.error = Some("could not reach the URL".to_string());
            return out;
        };

        let status = resp.status();
        out.status = Some(status.as_u16());
        out.ok = status.is_success();
        if !out.ok {
            out.error = Some(format!("server returned HTTP {}", status.as_u16()));
        }

        let headers = resp.headers();
        out.content_length = total_length_from_headers(headers);
        out.content_type = headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        out.accepts_ranges = headers
            .get(reqwest::header::ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .unwrap_or(false)
            || headers.contains_key(reqwest::header::CONTENT_RANGE);
        if let Some(name) = filename_from_disposition(headers) {
            out.filename = name;
        }

        out
    }

    // Report the device's storage/memory headroom so the UI can warn before a large download or a model
    // that won't fit in RAM. Free disk is measured on the volume that actually holds the model store.
    pub fn system_resources(&self) -> SystemResourcesResponse {
        use sysinfo::{Disks, System};

        let mut sys = System::new();
        sys.refresh_memory();

        let cpu_count = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(0);

        let target = self.models_dir().unwrap_or_else(|| PathBuf::from("."));
        let disks = Disks::new_with_refreshed_list();
        let free_disk_bytes = disks
            .list()
            .iter()
            .filter(|d| target.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| d.available_space())
            // Fall back to the roomiest mounted volume if the path can't be matched to one.
            .or_else(|| disks.list().iter().map(|d| d.available_space()).max())
            .unwrap_or(0);

        SystemResourcesResponse {
            free_disk_bytes,
            total_ram_bytes: sys.total_memory(),
            available_ram_bytes: sys.available_memory(),
            cpu_count,
        }
    }

    pub fn list_local_models(&self) -> Result<Vec<LocalModel>, String> {
        let Some(dir) = self.models_dir() else {
            return Ok(Vec::new());
        };
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut models = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let manifest = entry.path().join("model.json");
            if manifest.exists()
                && let Ok(bytes) = fs::read(&manifest)
                && let Ok(model) = serde_json::from_slice::<LocalModel>(&bytes)
            {
                models.push(model);
            }
        }
        Ok(models)
    }

    pub fn delete_model(&self, model_id: &str) -> Result<(), String> {
        if let Some(dir) = self.model_dir(model_id)
            && dir.exists()
        {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn infer(&self, req: InferRequest) -> Result<InferResponse, String> {
        #[cfg(feature = "inference")]
        {
            let dir = self
                .model_dir(&req.model_id)
                .ok_or("could not resolve model dir")?;
            let gguf = find_gguf(&dir).ok_or("no GGUF model file found for this model")?;
            let prompt = req.prompt.clone();
            let max_tokens = req.max_tokens.unwrap_or(512);
            let schema = req.response_schema.clone();
            // llama.cpp inference is synchronous and compute-heavy — keep it off the async runtime.
            // With an image, route through the multimodal path (mtmd + the model's mmproj projector);
            // otherwise text-only.
            let text = match req.image {
                Some(image) if !image.is_empty() => {
                    let mmproj = find_mmproj(&dir).ok_or(
                        "this model has no vision projector (mmproj) file; it cannot process images",
                    )?;
                    tokio::task::spawn_blocking(move || {
                        crate::inference::run_multimodal_inference(
                            &gguf,
                            &mmproj,
                            &prompt,
                            &image,
                            max_tokens,
                            schema.as_deref(),
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())??
                }
                _ => tokio::task::spawn_blocking(move || {
                    crate::inference::run_text_inference(&gguf, &prompt, max_tokens, schema.as_deref())
                })
                .await
                .map_err(|e| e.to_string())??,
            };
            Ok(InferResponse { text })
        }
        #[cfg(not(feature = "inference"))]
        {
            let _ = req;
            Err("this build was compiled without the on-device inference runtime (enable the `inference` cargo feature)".to_string())
        }
    }
}

// Keep a value usable as a single, safe path segment (defence against traversal / odd characters). Path
// separators and other non-`[A-Za-z0-9._-]` characters become '_', so after mapping the only traversal
// vectors left are all-dot / empty segments — ".", "..", "" — which would escape or collapse the target
// directory (e.g. `models/..` resolves to the app-data root). Those are prefixed with '_' to a safe,
// non-relative name so the result is always a normal single component.
fn sanitize(value: &str) -> String {
    let mapped: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if mapped.is_empty() || mapped.chars().all(|c| c == '.') {
        format!("_{mapped}")
    } else {
        mapped
    }
}

fn file_name_from_url(url: &str) -> String {
    let trimmed = url.split(['?', '#']).next().unwrap_or(url);
    let name = trimmed.rsplit('/').next().unwrap_or("model.bin");
    if name.is_empty() {
        "model.bin".to_string()
    } else {
        sanitize(name)
    }
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hex::encode(hasher.finalize()))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    Ok(sha256_hex(path)?.eq_ignore_ascii_case(expected))
}

// Total size of the resource from response headers. A ranged reply (Content-Range present) is
// authoritative for the FULL size via its "/total" tail (e.g. "bytes 0-0/12345"); its Content-Length is
// only the returned range's size (1 for `bytes=0-0`), so we must NOT fall back to it — an unknown total
// ("bytes 0-0/*") or a malformed value yields None (size unknown). An unranged reply carries the full
// size directly as Content-Length.
fn total_length_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    if let Some(cr) = headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        return cr
            .rsplit('/')
            .next()
            .and_then(|t| t.trim().parse::<u64>().ok());
    }
    headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
}

// Extract a download filename from a Content-Disposition header (the common `filename="…"` form),
// sanitised for use as a path segment. Extended `filename*=` encodings are ignored (URL fallback used).
fn filename_from_disposition(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let cd = headers
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    for part in cd.split(';') {
        if let Some(rest) = part.trim().strip_prefix("filename=") {
            let name = rest.trim().trim_matches('"');
            if !name.is_empty() {
                return Some(sanitize(name));
            }
        }
    }
    None
}

// The main LM GGUF for a downloaded model (the vision projector mmproj is a separate file we skip here).
#[cfg(feature = "inference")]
fn find_gguf(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.extension().and_then(|e| e.to_str()) == Some("gguf") && !name.contains("mmproj") {
            return Some(path);
        }
    }
    None
}

// The vision projector (mmproj) GGUF, present only for multimodal models that shipped one alongside
// the language model. Identified by the conventional "mmproj" marker in the filename.
#[cfg(feature = "inference")]
fn find_mmproj(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.extension().and_then(|e| e.to_str()) == Some("gguf") && name.contains("mmproj") {
            return Some(path);
        }
    }
    None
}

#[cfg(all(test, feature = "inference"))]
mod cycle_tests {
    use super::*;
    use crate::models::LocalModel;

    const MODEL_ID: &str = "gemma-4-e2b-it-q4";
    const LM_URL: &str =
        "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf";
    const LM_SHA: &str = "9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d";
    const MMPROJ_URL: &str =
        "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf";
    const MMPROJ_SHA: &str = "140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa";

    // Hardlink (instant, no copy) the real file into the model dir, falling back to a copy across volumes.
    fn seed(src: &str, dst: &Path) {
        if fs::hard_link(src, dst).is_err() {
            fs::copy(src, dst).expect("seed file");
        }
    }

    // Drives the WHOLE on-device cycle on the PC, against a temp model dir, using the SAME standalone
    // functions the ModelManager methods call:
    //   verify (download_model's SHA-256 step, against the catalog's own hashes) -> write/read the
    //   model.json manifest (download_model / list_local_models) -> find_gguf + infer (text + structured
    //   JSON) -> delete.
    // The thin ModelManager wrappers add only Tauri app_data_dir resolution + progress events on top;
    // those need a bundled Tauri app context that a bare `cargo test` can't load on Windows (webview DLL),
    // so they run in the real app, not here. Skipped unless the two model env vars point at real files.
    #[test]
    fn full_model_cycle() {
        let (Ok(lm), Ok(mmproj)) = (
            std::env::var("OC_TEST_MODEL_GGUF"),
            std::env::var("OC_TEST_MMPROJ_GGUF"),
        ) else {
            eprintln!("OC_TEST_MODEL_GGUF / OC_TEST_MMPROJ_GGUF not set — skipping full cycle test");
            return;
        };

        let dir = std::env::temp_dir().join("oc_cycle_test").join(sanitize(MODEL_ID));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create model dir");
        let lm_path = dir.join(file_name_from_url(LM_URL));
        let mmproj_path = dir.join(file_name_from_url(MMPROJ_URL));
        seed(&lm, &lm_path);
        seed(&mmproj, &mmproj_path);

        // 1. Verify the seeded files against the CATALOG's SHA-256s (proves the catalog hashes are correct
        //    and is exactly download_model's verify step).
        assert!(verify_sha256(&lm_path, LM_SHA).expect("hash lm"), "LM sha256 must match catalog");
        assert!(
            verify_sha256(&mmproj_path, MMPROJ_SHA).expect("hash mmproj"),
            "mmproj sha256 must match catalog"
        );

        // 2. Manifest round-trip (download_model writes model.json; list_local_models reads it).
        let total = 3_106_736_256u64 + 985_654_080u64;
        let manifest = LocalModel {
            model_id: MODEL_ID.to_string(),
            runtime: "llama-cpp".to_string(),
            size_bytes: total,
            path: dir.to_string_lossy().to_string(),
        };
        fs::write(dir.join("model.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        let listed: LocalModel =
            serde_json::from_slice(&fs::read(dir.join("model.json")).unwrap()).unwrap();
        assert_eq!(listed.model_id, MODEL_ID);
        assert_eq!(listed.size_bytes, total);

        // 3. find_gguf picks the LM (not the mmproj), then infer — plain text.
        let gguf = find_gguf(&dir).expect("find_gguf should locate the LM");
        assert_eq!(gguf, lm_path);
        let text = crate::inference::run_text_inference(
            &gguf,
            "In one short sentence, what is a bicycle?",
            48,
            None,
        )
        .expect("text infer");
        eprintln!("[cycle] text => {text}");
        assert!(!text.trim().is_empty(), "text inference should produce output");

        // 4. infer — structured (JSON schema).
        let schema = r#"{"type":"object","properties":{"animal":{"type":"string"}},"required":["animal"]}"#;
        let structured = crate::inference::run_text_inference(&gguf, "Name one animal.", 64, Some(schema))
            .expect("structured infer");
        eprintln!("[cycle] structured => {structured}");
        assert!(structured.contains('{'), "structured output should contain JSON");

        // 5. delete — and confirm it's gone.
        fs::remove_dir_all(&dir).expect("delete model dir");
        assert!(!dir.exists(), "model dir should be gone after delete");
    }
}

// Preflight/helper unit tests — no model or inference runtime needed, so they run on every `cargo test`.
#[cfg(test)]
mod preflight_tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    fn headers(pairs: &[(reqwest::header::HeaderName, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn total_length_prefers_content_range_total() {
        // A ranged reply's Content-Length is the range size (1 byte); the true size is the /total tail.
        let h = headers(&[
            (reqwest::header::CONTENT_RANGE, "bytes 0-0/1048576"),
            (reqwest::header::CONTENT_LENGTH, "1"),
        ]);
        assert_eq!(total_length_from_headers(&h), Some(1_048_576));
    }

    #[test]
    fn total_length_falls_back_to_content_length() {
        let h = headers(&[(reqwest::header::CONTENT_LENGTH, "2048")]);
        assert_eq!(total_length_from_headers(&h), Some(2048));
    }

    #[test]
    fn total_length_absent_is_none() {
        assert_eq!(total_length_from_headers(&HeaderMap::new()), None);
    }

    #[test]
    fn total_length_unknown_range_total_is_none_not_partial_size() {
        // 206 reply to `Range: bytes=0-0` with an unknown instance length. The 1-byte Content-Length is
        // the RANGE size, not the file size — must NOT be reported as the total (would show a GB model
        // as 1 byte and suppress every size warning).
        let h = headers(&[
            (reqwest::header::CONTENT_RANGE, "bytes 0-0/*"),
            (reqwest::header::CONTENT_LENGTH, "1"),
        ]);
        assert_eq!(total_length_from_headers(&h), None);

        // A malformed total is likewise unknown, not the range size.
        let bad = headers(&[
            (reqwest::header::CONTENT_RANGE, "bytes 0-0/notanumber"),
            (reqwest::header::CONTENT_LENGTH, "1"),
        ]);
        assert_eq!(total_length_from_headers(&bad), None);
    }

    #[test]
    fn sanitize_neutralizes_traversal_segments() {
        // The classic traversal tokens must not survive as path components.
        for evil in ["..", ".", "", "...", "/", "\\", "../", "..\\"] {
            let s = sanitize(evil);
            assert_ne!(s, "..", "sanitize({evil:?}) must not be \"..\"");
            assert_ne!(s, ".", "sanitize({evil:?}) must not be \".\"");
            assert!(!s.is_empty(), "sanitize({evil:?}) must not be empty");
            // A single normal component never resolves to a parent/self reference.
            assert_eq!(
                std::path::Path::new("root").join(&s).components().count(),
                2,
                "sanitize({evil:?})={s:?} escaped its parent"
            );
        }
        // Ordinary ids pass through unchanged; separators become underscores; dots inside a name are fine.
        assert_eq!(sanitize("gemma-4-e2b-it-q4"), "gemma-4-e2b-it-q4");
        assert_eq!(sanitize("a/b"), "a_b");
        assert_eq!(sanitize("model.v1"), "model.v1");
        assert_eq!(sanitize("..a"), "..a");
    }

    #[test]
    fn filename_from_disposition_quoted_and_bare() {
        let quoted = headers(&[(
            reqwest::header::CONTENT_DISPOSITION,
            "attachment; filename=\"model-Q4_K_M.gguf\"",
        )]);
        assert_eq!(
            filename_from_disposition(&quoted).as_deref(),
            Some("model-Q4_K_M.gguf")
        );

        let bare = headers(&[(
            reqwest::header::CONTENT_DISPOSITION,
            "attachment; filename=weights.bin",
        )]);
        assert_eq!(filename_from_disposition(&bare).as_deref(), Some("weights.bin"));

        assert_eq!(filename_from_disposition(&HeaderMap::new()), None);
    }

    #[test]
    fn file_name_from_url_strips_query_and_sanitizes() {
        assert_eq!(
            file_name_from_url("https://host/path/model-Q4.gguf?download=true"),
            "model-Q4.gguf"
        );
        assert_eq!(file_name_from_url("https://host/"), "model.bin");
    }

    #[test]
    fn sha256_hex_matches_known_digest() {
        // SHA-256("abc") — the canonical test vector.
        let dir = std::env::temp_dir().join("oc_sha_test");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("abc.txt");
        fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_hex(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_file(&path);
    }
}
