use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlRequest {
    pub url: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlResponse {
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpRequest {
    pub username: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpResponse {
    pub passkey: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    challenge: Vec<u8>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInResponse {
    pub passkey: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowNotificationRequest {
    pub notification_id: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SvelteReadyRequest;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MinimizeAppRequest;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotificationsRequest {
    pub sender_id: Option<String>,
    pub group_id: Option<String>,
    pub community_id: Option<String>,
    pub channel_id: Option<String>,
    pub thread_index: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LoadRecentMediaRequest {
    pub count: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRecentMediaResponse {
    pub permission: String,
    pub media: Vec<RecentMedia>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMedia {
    pub uri: String,
    pub filename: String,
    pub mime_type: String,
    pub date_added: u32,
    pub is_video: bool,
    pub file_path: String,
    pub size: usize,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct EmptyPayload;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMediaRequest {
    pub kind: String,
    pub filename: String,
    pub data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatShortcut {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatShortcutsRequest {
    pub chats: Vec<ChatShortcut>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatShortcutsResponse {
    pub count: usize,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileSpec {
    pub url: String,
    // Expected SHA-256. Curated catalog entries always provide it (verified after download). Custom
    // "add from URL" models may omit it: trust-on-first-use — the hash is computed during download and
    // returned so the caller can record it, then supply it on any later re-download to verify integrity.
    #[serde(default)]
    pub sha256: Option<String>,
    pub bytes: u64,
    // Optional on-disk filename override (sanitised). Lets the caller control the stored name so runtime
    // discovery works regardless of the URL's tail — e.g. force a vision projector to contain "mmproj" so
    // find_mmproj/find_gguf classify it correctly. Absent ⇒ derived from the URL's last path segment.
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadModelRequest {
    pub model_id: String,
    pub runtime: String,
    pub files: Vec<ModelFileSpec>,
}

// The SHA-256 actually observed for each downloaded file. Callers persist these for custom (unverified)
// models so a subsequent download can be integrity-checked against the first.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedFile {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadModelResponse {
    pub files: Vec<DownloadedFile>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeModelUrlRequest {
    pub url: String,
}

// Result of a lightweight HEAD (or ranged GET) against a candidate model URL, done natively because the
// WebView can't (CORS blocks cross-origin HEAD to model hosts). Never errors hard — a failed probe is
// reported via `ok = false` + `error` so the "add from URL" UI can warn rather than crash.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeModelUrlResponse {
    pub ok: bool,
    pub status: Option<u16>,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    // Best-effort download filename (Content-Disposition, else the URL's last path segment).
    pub filename: String,
    // Whether the server advertises byte-range support (resumable/streamable download).
    pub accepts_ranges: bool,
    pub error: Option<String>,
}

// A snapshot of the device's headroom, so the UI can flag a model that likely won't fit or run well.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemResourcesResponse {
    // Free space on the volume holding the app data dir (where models are stored).
    pub free_disk_bytes: u64,
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub cpu_count: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub model_id: String,
    pub runtime: String,
    pub size_bytes: u64,
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteModelRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferRequest {
    pub model_id: String,
    pub runtime: String,
    pub prompt: String,
    #[serde(default)]
    pub image: Option<Vec<u8>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    // A JSON Schema (serialised) the output must conform to. Best-effort: constrains generation via a
    // grammar when the runtime supports it.
    #[serde(default)]
    pub response_schema: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferResponse {
    pub text: String,
}
