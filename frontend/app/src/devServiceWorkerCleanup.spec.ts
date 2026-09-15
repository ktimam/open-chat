import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    DEVELOPMENT_SERVICE_WORKER_SOURCE,
    handleDevelopmentServiceWorkerRequest,
} from "../devServiceWorkerCleanup";

type HandlerResponse = Parameters<typeof handleDevelopmentServiceWorkerRequest>[1];

function responseRecorder() {
    const headers = new Map<string, string>();
    let body: unknown;
    let ended = false;
    const response = {
        statusCode: 0,
        setHeader(name: string, value: string | number) {
            headers.set(name.toLowerCase(), String(value));
            return response;
        },
        end(value?: unknown) {
            body = value;
            ended = true;
            return response;
        },
    };
    return {
        response: response as unknown as HandlerResponse,
        headers,
        body: () => body,
        ended: () => ended,
    };
}

describe("development service-worker cleanup endpoint", () => {
    test("serves executable no-store JavaScript at the versioned production worker path", () => {
        const recorded = responseRecorder();
        let continued = false;

        handleDevelopmentServiceWorkerRequest(
            { method: "GET", url: "/service_worker.js?v=stale-production" },
            recorded.response,
            () => {
                continued = true;
            },
        );

        expect(continued).toBe(false);
        expect(recorded.ended()).toBe(true);
        expect(recorded.response.statusCode).toBe(200);
        expect(recorded.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(recorded.headers.get("cache-control")).toBe("no-store");
        expect(recorded.headers.get("service-worker-allowed")).toBe("/");
        expect(Number(recorded.headers.get("content-length"))).toBe(
            Buffer.byteLength(DEVELOPMENT_SERVICE_WORKER_SOURCE),
        );
        expect(recorded.body()).toBe(DEVELOPMENT_SERVICE_WORKER_SOURCE);
    });

    test("unregisters and reloads once without opening or deleting browser storage", () => {
        expect(DEVELOPMENT_SERVICE_WORKER_SOURCE).toContain("self.skipWaiting()");
        expect(DEVELOPMENT_SERVICE_WORKER_SOURCE).toContain("self.registration.unregister()");
        expect(DEVELOPMENT_SERVICE_WORKER_SOURCE).toContain("self.clients.matchAll");
        expect(DEVELOPMENT_SERVICE_WORKER_SOURCE).toContain("client.navigate(client.url)");
        expect(DEVELOPMENT_SERVICE_WORKER_SOURCE).not.toMatch(
            /\bcaches\b|CacheStorage|indexedDB|openchat_network_first|openchat_stale_while_revalidate/,
        );
    });

    test("supports HEAD, rejects mutations, and leaves unrelated routes to Vite", () => {
        const head = responseRecorder();
        handleDevelopmentServiceWorkerRequest(
            { method: "HEAD", url: "/service_worker.js?check=1" },
            head.response,
            () => {
                throw new Error("HEAD request unexpectedly continued");
            },
        );
        expect(head.response.statusCode).toBe(200);
        expect(head.body()).toBeUndefined();
        expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);

        const post = responseRecorder();
        handleDevelopmentServiceWorkerRequest(
            { method: "POST", url: "/service_worker.js" },
            post.response,
            () => {
                throw new Error("POST request unexpectedly continued");
            },
        );
        expect(post.response.statusCode).toBe(405);
        expect(post.headers.get("allow")).toBe("GET, HEAD");

        const unrelated = responseRecorder();
        let continued = false;
        handleDevelopmentServiceWorkerRequest(
            { method: "GET", url: "/worker.js" },
            unrelated.response,
            () => {
                continued = true;
            },
        );
        expect(continued).toBe(true);
        expect(unrelated.ended()).toBe(false);
    });

    test("is wired only into the Vite development server", () => {
        const viteConfig = readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8");
        expect(viteConfig).toContain("developmentServiceWorkerCleanupPlugin()");
        expect(viteConfig).toContain(
            "server.middlewares.use(handleDevelopmentServiceWorkerRequest)",
        );
    });
});
