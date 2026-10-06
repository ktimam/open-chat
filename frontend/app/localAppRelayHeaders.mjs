/** Shared by development middleware and the dependency-free optimized local preview. */
export const LOCAL_APP_RELAY_CSP =
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const LOCAL_APP_RELAY_HEADERS = Object.freeze({
    "Content-Security-Policy": LOCAL_APP_RELAY_CSP,
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "Cross-Origin-Embedder-Policy": "unsafe-none",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
});

/** Build configuration only, never a request parameter or app message. */
export function localAppRelayOrigin(directoryUrl = "") {
    if (directoryUrl === "") return undefined;
    if (typeof directoryUrl !== "string") throw new Error("Invalid configured app relay origin");
    const url = new URL(directoryUrl);
    if (
        url.href !== directoryUrl ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^[A-Za-z0-9:/._\[\]-]+$/.test(url.origin) ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
    ) {
        throw new Error("Invalid configured app relay origin");
    }
    return url.origin;
}

export function localAppRelayHeaders(appOrigin) {
    if (appOrigin === undefined) return LOCAL_APP_RELAY_HEADERS;
    if (typeof appOrigin !== "string" || localAppRelayOrigin(`${appOrigin}/`) !== appOrigin)
        throw new Error("Invalid configured app relay origin");
    return Object.freeze({
        ...LOCAL_APP_RELAY_HEADERS,
        // Only the configured publisher can be framed. The relay itself remains unframeable.
        "Content-Security-Policy": LOCAL_APP_RELAY_CSP.replace(
            "frame-src 'none'",
            `frame-src ${appOrigin}`,
        ),
    });
}
