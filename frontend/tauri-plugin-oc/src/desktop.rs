use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Oc<R>> {
    Ok(Oc(app.clone()))
}

/// Access to the oc APIs.
pub struct Oc<R: Runtime>(AppHandle<R>);

// These are the mobile-native bridge methods (push notifications, passkey sign-in, deep links, recent
// media, the Android viewport handling, …). They have no platform meaning in a desktop build, so they
// degrade to graceful no-ops / empty defaults rather than panicking — that lets the web app boot on
// desktop instead of crashing at startup the moment it calls e.g. `svelte_ready`.
impl<R: Runtime> Oc<R> {
    pub fn open_url(&self, _payload: OpenUrlRequest) -> crate::Result<OpenUrlResponse> {
        Ok(OpenUrlResponse::default())
    }

    pub fn sign_up(&self, _payload: SignUpRequest) -> crate::Result<SignUpResponse> {
        Ok(SignUpResponse::default())
    }

    pub fn sign_in(&self, _payload: SignInRequest) -> crate::Result<SignInResponse> {
        Ok(SignInResponse::default())
    }

    pub fn show_notification(&self, _payload: ShowNotificationRequest) {}

    pub fn svelte_ready(&self) {}

    pub fn minimize_app(&self) {}

    pub fn release_notifications(&self, _payload: ReleaseNotificationsRequest) {}

    pub fn load_recent_media(
        &self,
        _payload: LoadRecentMediaRequest,
    ) -> crate::Result<LoadRecentMediaResponse> {
        Ok(LoadRecentMediaResponse::default())
    }

    pub fn toggle_viewport_resize(&self, _toggle: bool) -> crate::Result<()> {
        Ok(())
    }

    pub fn update_chat_shortcuts(
        &self,
        _payload: UpdateChatShortcutsRequest,
    ) -> crate::Result<UpdateChatShortcutsResponse> {
        Ok(UpdateChatShortcutsResponse::default())
    }
}
