/** Only the fixed first-party relay assets bypass the ordinary application caches. */
export function isLocalAppRelayRequest(request: Pick<Request, "url">, origin: string): boolean {
    const url = new URL(request.url);
    return (
        url.origin === origin &&
        (url.pathname === "/local-app-handoff.html" || url.pathname === "/local-app-handoff.js")
    );
}

export async function fetchLocalAppRelay(request: Request): Promise<Response> {
    try {
        // Do not cache/reconstruct/follow redirects or fall back to the main OpenChat document.
        return await fetch(request, { cache: "no-store", redirect: "error" });
    } catch {
        return Response.error();
    }
}
