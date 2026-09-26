use tauri::{AppHandle, Runtime, command};

use crate::OcExt;
use crate::Result;
use crate::models::*;
use crate::update_manager;
use crate::local_browser_auth_protocol::{BeginRequest as LocalBrowserAuthBeginRequest, Challenge as LocalBrowserAuthChallenge, PollResult as LocalBrowserAuthPollResult};

#[cfg(feature = "local-browser-auth")]
fn require_local_browser_auth_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> std::result::Result<(), String> {
    let url = window.url().map_err(|_| "Local browser authentication is unavailable")?;
    if !crate::local_browser_auth_protocol::bundled_window_allowed(
        window.label(), &url.origin().ascii_serialization(), url.username(), url.password().is_some(),
    ) {
        return Err("Browser authentication is available only to the bundled local APK".into());
    }
    Ok(())
}

#[command]
pub(crate) async fn begin_local_browser_auth<R: Runtime>(
    app: AppHandle<R>, window: tauri::WebviewWindow<R>, payload: LocalBrowserAuthBeginRequest,
) -> std::result::Result<LocalBrowserAuthChallenge, String> {
    #[cfg(feature = "local-browser-auth")]
    {
        use crate::local_browser_auth::{BrowserAssets, BrowserAuthBridge, BundledProfile, HTML_ASSET, JS_ASSET, PROFILE_ASSET};
        use tauri::Manager;
        require_local_browser_auth_window(&window)?;
        let resolver = app.asset_resolver();
        let profile = resolver.get(PROFILE_ASSET.into()).ok_or("Local APK authentication profile is missing")?;
        let profile = BundledProfile::parse(&profile.bytes)?;
        let html = resolver.get(HTML_ASSET.into()).ok_or("Bundled browser sign-in page is missing")?;
        let script = resolver.get(JS_ASSET.into()).ok_or("Bundled browser sign-in script is missing")?;
        app.state::<BrowserAuthBridge>().begin(payload, profile, BrowserAssets {
            html: html.bytes, script: script.bytes,
        }).await
    }
    #[cfg(not(feature = "local-browser-auth"))]
    { let _ = (app, window, payload); Err("Local browser authentication is not included in this build".into()) }
}

#[command]
pub(crate) async fn poll_local_browser_auth<R: Runtime>(
    app: AppHandle<R>, window: tauri::WebviewWindow<R>, attempt_id: String,
) -> std::result::Result<LocalBrowserAuthPollResult, String> {
    #[cfg(feature = "local-browser-auth")]
    {
        use tauri::Manager;
        require_local_browser_auth_window(&window)?;
        app.state::<crate::local_browser_auth::BrowserAuthBridge>().poll(&attempt_id).await
    }
    #[cfg(not(feature = "local-browser-auth"))]
    { let _ = (app, window, attempt_id); Err("Local browser authentication is not included in this build".into()) }
}

#[command]
pub(crate) async fn cancel_local_browser_auth<R: Runtime>(
    app: AppHandle<R>, window: tauri::WebviewWindow<R>, attempt_id: String,
) -> std::result::Result<(), String> {
    #[cfg(feature = "local-browser-auth")]
    {
        use tauri::Manager;
        require_local_browser_auth_window(&window)?;
        app.state::<crate::local_browser_auth::BrowserAuthBridge>().cancel(&attempt_id).await
    }
    #[cfg(not(feature = "local-browser-auth"))]
    { let _ = (app, window, attempt_id); Err("Local browser authentication is not included in this build".into()) }
}

#[command]
pub(crate) async fn complete_local_browser_auth<R: Runtime>(
    app: AppHandle<R>, window: tauri::WebviewWindow<R>, attempt_id: String, accepted: bool,
) -> std::result::Result<(), String> {
    #[cfg(feature = "local-browser-auth")]
    {
        use tauri::Manager;
        require_local_browser_auth_window(&window)?;
        app.state::<crate::local_browser_auth::BrowserAuthBridge>().complete(&attempt_id, accepted).await
    }
    #[cfg(not(feature = "local-browser-auth"))]
    { let _ = (app, window, attempt_id, accepted); Err("Local browser authentication is not included in this build".into()) }
}

#[command]
pub(crate) async fn open_url<R: Runtime>(
    app: AppHandle<R>,
    payload: OpenUrlRequest,
) -> Result<OpenUrlResponse> {
    app.oc().open_url(payload)
}

#[command]
pub(crate) async fn sign_up<R: Runtime>(
    app: AppHandle<R>,
    payload: SignUpRequest,
) -> Result<SignUpResponse> {
    app.oc().sign_up(payload)
}

#[command]
pub(crate) async fn sign_in<R: Runtime>(
    app: AppHandle<R>,
    payload: SignInRequest,
) -> Result<SignInResponse> {
    app.oc().sign_in(payload)
}

#[command]
pub(crate) async fn show_notification<R: Runtime>(
    app: AppHandle<R>,
    payload: ShowNotificationRequest,
) {
    app.oc().show_notification(payload)
}

#[command]
pub(crate) async fn svelte_ready<R: Runtime>(app: AppHandle<R>) {
    app.oc().svelte_ready()
}

#[command]
pub(crate) async fn release_notifications<R: Runtime>(
    app: AppHandle<R>,
    payload: ReleaseNotificationsRequest,
) {
    app.oc().release_notifications(payload)
}

#[command]
pub(crate) async fn minimize_app<R: Runtime>(app: AppHandle<R>) {
    app.oc().minimize_app()
}

#[command]
pub(crate) async fn restart_app<R: Runtime>(app: AppHandle<R>) {
    #[cfg(mobile)]
    app.oc().restart_app();
    #[cfg(not(mobile))]
    app.restart();
}

#[command]
pub(crate) async fn load_recent_media<R: Runtime>(
    app: AppHandle<R>,
    payload: LoadRecentMediaRequest,
) -> Result<LoadRecentMediaResponse> {
    app.oc().load_recent_media(payload)
}

#[command]
pub(crate) async fn get_shell_version<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<Option<String>, String> {
    let manager = update_manager::UpdateManager::new(app);
    Ok(manager.get_shell_version().map(|v| v.to_string()))
}

#[command]
pub(crate) async fn get_server_version<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<String, String> {
    let manager = update_manager::UpdateManager::new(app);
    manager
        .get_server_version()
        .await
        .map(|v| v.to_string())
        .map_err(|e| e.to_string())
}

#[command]
pub(crate) async fn download_update<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<bool, String> {
    let manager = update_manager::UpdateManager::new(app.clone());

    let did_download = manager
        .check_for_updates()
        .await
        .map_err(|e| e.to_string())?;

    Ok(did_download)
}

#[command]
pub(crate) async fn enable_viewport_resize<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.oc().toggle_viewport_resize(true)
}

#[command]
pub(crate) async fn disable_viewport_resize<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.oc().toggle_viewport_resize(false)
}

#[command]
pub(crate) async fn export_media<R: Runtime>(
    app: AppHandle<R>,
    payload: ExportMediaRequest,
) -> Result<ExportMediaResponse> {
    app.oc().export_media(payload)
}

#[command]
pub(crate) async fn update_chat_shortcuts<R: Runtime>(
    app: AppHandle<R>,
    payload: UpdateChatShortcutsRequest,
) -> Result<UpdateChatShortcutsResponse> {
    app.oc().update_chat_shortcuts(payload)
}

// This command is only used to save files to local public storage.
//
// Note: this command is not handled by kotlin code.

#[command]
pub(crate) async fn save_media<R: Runtime>(
    _app: AppHandle<R>,
    payload: SaveMediaRequest,
) -> Result<()> {
    let SaveMediaRequest {
        kind,
        filename,
        data,
        mime_type,
    } = payload;

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = (&kind, &filename, &data, &mime_type);

    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::{
            AndroidFsExt, PublicDir, PublicGeneralPurposeDir, PublicImageDir, PublicVideoDir,
        };
        let api = _app.android_fs_async();
        let storage = api.public_storage();

        storage.request_permission().await?;

        let pub_dir = match kind.as_str() {
            "image" => PublicDir::Image(PublicImageDir::Pictures),
            "video" => PublicDir::Video(PublicVideoDir::Movies),
            _ => PublicDir::GeneralPurpose(PublicGeneralPurposeDir::Download),
        };

        println!("OC_LOG: Download file: {:?}, {:?}", pub_dir, filename);

        let mime = (!mime_type.trim().is_empty()).then_some(mime_type.as_str());

        storage
            .write_new(None, pub_dir, &filename, mime, &data)
            .await?;
    }

    // iOS saves to app's sandbox, to save to public camera roll we need to use
    // Photos framework on the Swift side, and add NSPhotoLibraryAddUsageDescription
    // to Info.plist
    #[cfg(target_os = "ios")]
    {
        use std::path::Path;
        use tauri::Manager;
        use tokio::fs;

        // The Photos-framework save path (which would use the mime type) is
        // not implemented yet — files land in the app's Documents sandbox.
        let _ = &mime_type;

        let safe_filename = Path::new(&filename)
            .file_name()
            .ok_or_else(|| crate::Error::IOSInvalidFileName)?;

        let base_dir = _app.path().document_dir()?;
        let sub_dir = match kind.as_str() {
            "image" => base_dir.join("Pictures"),
            "video" => base_dir.join("Videos"),
            _ => base_dir.clone(),
        };

        // create_dir_all is idempotent
        fs::create_dir_all(&sub_dir).await?;

        let file_path = sub_dir.join(safe_filename);
        fs::write(&file_path, &data).await?;
    }

    Ok(())
}

#[command]
pub(crate) async fn download_model<R: Runtime>(
    app: AppHandle<R>,
    payload: DownloadModelRequest,
) -> std::result::Result<DownloadModelResponse, String> {
    crate::model_manager::ModelManager::new(app)
        .download_model(payload)
        .await
}

#[command]
pub(crate) async fn probe_model_url<R: Runtime>(
    app: AppHandle<R>,
    payload: ProbeModelUrlRequest,
) -> std::result::Result<ProbeModelUrlResponse, String> {
    Ok(crate::model_manager::ModelManager::new(app)
        .probe_model_url(&payload.url)
        .await)
}

#[command]
pub(crate) async fn system_resources<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<SystemResourcesResponse, String> {
    Ok(crate::model_manager::ModelManager::new(app).system_resources())
}

#[command]
pub(crate) async fn list_local_models<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<Vec<LocalModel>, String> {
    crate::model_manager::ModelManager::new(app).list_local_models()
}

#[command]
pub(crate) async fn delete_model<R: Runtime>(
    app: AppHandle<R>,
    payload: DeleteModelRequest,
) -> std::result::Result<(), String> {
    crate::model_manager::ModelManager::new(app)
        .delete_model(&payload.model_id)
        .await
}

// Compile-time capability probe. Keeping this command present in every build lets the guest avoid
// mistaking "a Tauri bridge exists" for "this binary contains llama.cpp". Older binaries do not have
// the command at all; the guest treats that rejection as update-required too.
#[command]
pub(crate) fn inference_runtime_available() -> bool {
    cfg!(feature = "inference")
}

#[command]
pub(crate) async fn infer<R: Runtime>(
    app: AppHandle<R>,
    payload: InferRequest,
) -> std::result::Result<InferResponse, String> {
    crate::model_manager::ModelManager::new(app)
        .infer(payload)
        .await
}

#[cfg(test)]
mod inference_capability_tests {
    #[test]
    fn reports_the_compiled_native_runtime_feature() {
        assert_eq!(
            super::inference_runtime_available(),
            cfg!(feature = "inference")
        );
    }
}
