use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, Url, plugin::PluginApi};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Oc<R>> {
    Ok(Oc(app.clone()))
}

/// Access to the oc APIs.
pub struct Oc<R: Runtime>(AppHandle<R>);

fn validate_external_url(value: &str) -> crate::Result<Url> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(crate::Error::InvalidExternalUrl);
    }
    let url = Url::parse(value).map_err(|_| crate::Error::InvalidExternalUrl)?;
    match url.scheme() {
        "http" | "https"
            if url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none() => {}
        "mailto" | "tel"
            if !url.path().is_empty() && url.username().is_empty() && url.password().is_none() => {}
        _ => return Err(crate::Error::InvalidExternalUrl),
    }
    Ok(url)
}

// These are the mobile-native bridge methods (push notifications, passkey sign-in, deep links, recent
// media, the Android viewport handling, …). They have no platform meaning in a desktop build, so they
// degrade to graceful no-ops / empty defaults rather than panicking — that lets the web app boot on
// desktop instead of crashing at startup the moment it calls e.g. `svelte_ready`.
impl<R: Runtime> Oc<R> {
    // On desktop, hand the URL to the OS default handler (browser for http(s)) — unlike the other
    // mobile-bridge methods this one HAS a real desktop meaning; a no-op here is why "open in
    // browser" / external links silently did nothing in the desktop shell.
    pub fn open_url(&self, payload: OpenUrlRequest) -> crate::Result<OpenUrlResponse> {
        let url = validate_external_url(&payload.url)?;
        // Best-effort: a failure to launch the handler must not surface as an app error.
        let _ = open::that_detached(url.as_str());
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

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn external_url_policy_allows_web_and_explicit_user_schemes_only() {
        for allowed in [
            "https://oc.app/path",
            "http://example.com/path",
            "mailto:user@example.com",
            "tel:+12025550123",
        ] {
            assert!(validate_external_url(allowed).is_ok(), "rejected {allowed}");
        }

        for blocked in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "shell:AppsFolder",
            "https://user:pass@example.com/",
            "not a URL",
        ] {
            assert!(
                validate_external_url(blocked).is_err(),
                "accepted {blocked}"
            );
        }
    }
}
