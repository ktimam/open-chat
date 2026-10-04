use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_oc);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Oc<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.ocplugin.app", "OpenChatPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_oc)?;
    Ok(Oc(handle))
}

/// Access to the oc APIs.
pub struct Oc<R: Runtime>(PluginHandle<R>);

#[cfg(all(target_os = "android", feature = "local-app-handoff"))]
pub fn local_app_retention<R: Runtime>(app: &AppHandle<R>) -> std::sync::Arc<dyn crate::local_app_retention::RetentionBackend> {
    struct AndroidRetention<R: Runtime>(AppHandle<R>);
    #[derive(serde::Deserialize)]
    struct RetentionResult { retained: bool }
    impl<R: Runtime> AndroidRetention<R> {
        fn call(&self, command: &str, owner: &str, remaining_ms: Option<u64>) -> bool {
            use crate::OcExt;
            let result: Result<RetentionResult, _> = self.0.oc().0.run_mobile_plugin(command,
                serde_json::json!({ "owner": owner, "remainingMs": remaining_ms }));
            result.is_ok_and(|value| value.retained)
        }
    }
    impl<R: Runtime> crate::local_app_retention::RetentionBackend for AndroidRetention<R> {
        fn start(&self, owner: &str, remaining_ms: u64) -> Result<(), ()> {
            self.call("startLocalAppRetention", owner, Some(remaining_ms)).then_some(()).ok_or(())
        }
        fn extend(&self, owner: &str, remaining_ms: u64) -> Result<(), ()> {
            self.call("extendLocalAppRetention", owner, Some(remaining_ms)).then_some(()).ok_or(())
        }
        fn active(&self, owner: &str) -> bool { self.call("checkLocalAppRetention", owner, None) }
        fn release(&self, owner: &str) { self.call("releaseLocalAppRetention", owner, None); }
    }
    std::sync::Arc::new(AndroidRetention(app.clone()))
}

impl<R: Runtime> Oc<R> {
    pub fn open_url(&self, payload: OpenUrlRequest) -> crate::Result<OpenUrlResponse> {
        self.0
            .run_mobile_plugin("openUrl", payload)
            .map_err(Into::into)
    }

    pub fn sign_up(&self, payload: SignUpRequest) -> crate::Result<SignUpResponse> {
        self.0
            .run_mobile_plugin("signUp", payload)
            .map_err(Into::into)
    }

    pub fn sign_in(&self, payload: SignInRequest) -> crate::Result<SignInResponse> {
        self.0
            .run_mobile_plugin("signIn", payload)
            .map_err(Into::into)
    }

    pub fn show_notification(&self, payload: ShowNotificationRequest) {
        let _: Result<(), _> = self.0.run_mobile_plugin("showNotification", payload);
    }

    // SvelteReadyRequest is just a placeholder type simply required as the
    // second arg to the run_mobile_plugin function.
    pub fn svelte_ready(&self) {
        let _: Result<(), _> = self
            .0
            .run_mobile_plugin("svelteReady", SvelteReadyRequest::default());
    }

    pub fn release_notifications(&self, payload: ReleaseNotificationsRequest) {
        let _: Result<(), _> = self.0.run_mobile_plugin("releaseNotifications", payload);
    }

    pub fn minimize_app(&self) {
        let _: Result<(), _> = self
            .0
            .run_mobile_plugin("minimizeApp", MinimizeAppRequest::default());
    }

    pub fn restart_app(&self) {
        let _: Result<(), _> = self
            .0
            .run_mobile_plugin("restartApp", MinimizeAppRequest::default());
    }

    pub fn load_recent_media(
        &self,
        payload: LoadRecentMediaRequest,
    ) -> crate::Result<LoadRecentMediaResponse> {
        self.0
            .run_mobile_plugin("loadRecentMedia", payload)
            .map_err(Into::into)
    }

    pub fn toggle_viewport_resize(&self, toggle: bool) -> crate::Result<()> {
        let res: Result<(), _> = if toggle {
            self.0
                .run_mobile_plugin("enableViewportResize", EmptyPayload::default())
        } else {
            self.0
                .run_mobile_plugin("disableViewportResize", EmptyPayload::default())
        };

        res.map_err(Into::into)
    }

    pub fn export_media(&self, payload: ExportMediaRequest) -> crate::Result<ExportMediaResponse> {
        self.0
            .run_mobile_plugin("exportMedia", payload)
            .map_err(Into::into)
    }

    pub fn update_chat_shortcuts(
        &self,
        payload: UpdateChatShortcutsRequest,
    ) -> crate::Result<UpdateChatShortcutsResponse> {
        self.0
            .run_mobile_plugin("updateChatShortcuts", payload)
            .map_err(Into::into)
    }
}
