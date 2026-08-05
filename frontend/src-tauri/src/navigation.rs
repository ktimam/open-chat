use tauri::async_runtime;
use tauri::{AppHandle, Url};
use tauri_plugin_oc::{OcExt, OpenUrlRequest};

// TODO rewrite remote oc.app urls for nav locally!

// Handle webview navigation!
//
// Handles webview URL changes, and returns true or false if the navigation
// should proceed.
pub fn mobile_on_navigation_handler(app_handle: &AppHandle, url: &Url) -> bool {
    let url_str = url.to_string();

    // Check if the nav url is local tauri domain!
    if is_allowed_url_for_mode(
        &url_str,
        app_handle.config().build.dev_url.as_ref(),
        cfg!(debug_assertions),
    ) {
        return true;
    }

    let app_handle = app_handle.clone();

    // Url is not allowed for navigation in webview, so we send an open_url
    // command to the native layer, which will then handle it appropriately.
    async_runtime::spawn(async move {
        let req = OpenUrlRequest { url: url_str };
        let res = app_handle.oc().open_url(req);
        if let Err(err) = res {
            eprintln!("ERROR OPENING URL: {:#?}", err);
        }
    });

    // URL is allowed and we continue navigation!
    false
}

// Check URL
//
// Only allow URLs that should be handled by the webview. If not, then either
// an external app or a browser should be used.
fn is_allowed_url_for_mode(url_str: &str, configured_dev_url: Option<&Url>, debug: bool) -> bool {
    let Ok(url) = Url::parse(url_str) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    if debug {
        let Some(configured) = configured_dev_url else {
            return false;
        };
        if !matches!(configured.scheme(), "http" | "https") || configured.host_str().is_none() {
            return false;
        }
        return url.scheme() == configured.scheme()
            && url.host_str() == configured.host_str()
            && url.port_or_known_default() == configured.port_or_known_default();
    }

    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" => {
            url.host_str() == Some("tauri.localhost") && url.port_or_known_default() == Some(80)
        }
        "https" => {
            url.host_str() == Some("tauri.localhost") && url.port_or_known_default() == Some(443)
        }
        _ => false,
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn debug_navigation_trusts_only_the_exact_configured_origin() {
        let configured = Url::parse("http://localhost:5003").unwrap();
        assert!(is_allowed_url_for_mode(
            "http://localhost:5003/settings",
            Some(&configured),
            true,
        ));

        for blocked in [
            "http://localhost:5004/",
            "http://127.0.0.1:5003/",
            "http://evil.localhost:5003/",
            "https://localhost:5003/",
            "file:///tmp/index.html",
        ] {
            assert!(
                !is_allowed_url_for_mode(blocked, Some(&configured), true),
                "trusted {blocked}",
            );
        }
    }

    #[test]
    fn release_navigation_trusts_only_the_packaged_origin() {
        assert!(is_allowed_url_for_mode(
            "http://tauri.localhost/index.html",
            None,
            false,
        ));
        assert!(is_allowed_url_for_mode(
            "https://tauri.localhost/index.html",
            None,
            false,
        ));
        assert!(is_allowed_url_for_mode(
            "tauri://localhost/index.html",
            None,
            false,
        ));
        for blocked in [
            "http://localhost:5003/",
            "http://tauri.localhost.evil.example/",
            "tauri://tauri.localhost/",
            "file:///tmp/index.html",
        ] {
            assert!(
                !is_allowed_url_for_mode(blocked, None, false),
                "trusted {blocked}"
            );
        }
    }
}
