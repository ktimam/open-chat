import type { IncomingMessage, ServerResponse } from "node:http";

export const DEVELOPMENT_SERVICE_WORKER_PATH = "/service_worker.js";

// A previously installed production worker can continue serving a stale app shell after this
// origin switches back to Vite. Browsers update that registration from its original script URL,
// so development must return JavaScript at the exact path instead of Vite's index.html fallback.
// This worker deliberately never opens Cache Storage: model artifacts and every other cache stay
// untouched. Once it activates it removes only its own registration and reloads controlled windows
// once so their next navigation reaches the development server directly.
export const DEVELOPMENT_SERVICE_WORKER_SOURCE = `
self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await self.registration.unregister();
        const windows = await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
        });
        await Promise.all(windows.map((client) => client.navigate(client.url)));
    })());
});
`.trimStart();

type Next = () => void;

export function handleDevelopmentServiceWorkerRequest(
    req: Pick<IncomingMessage, "method" | "url">,
    res: Pick<ServerResponse, "end" | "setHeader" | "statusCode">,
    next: Next,
): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== DEVELOPMENT_SERVICE_WORKER_PATH) {
        next();
        return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end("method not allowed");
        return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Content-Length", Buffer.byteLength(DEVELOPMENT_SERVICE_WORKER_SOURCE));
    res.end(req.method === "HEAD" ? undefined : DEVELOPMENT_SERVICE_WORKER_SOURCE);
}
