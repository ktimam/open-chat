/** Shared by development middleware and the dependency-free optimized local preview. */
export const LOCAL_APP_RELAY_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const LOCAL_APP_RELAY_HEADERS = Object.freeze({
    "Content-Security-Policy": LOCAL_APP_RELAY_CSP,
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "Cross-Origin-Embedder-Policy": "unsafe-none",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
});
