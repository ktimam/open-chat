// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:45821/handoff"}
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { parseNativeApprovedRequest, startLocalNativeAppHandoff } from "./localNativeAppHandoff";

const request = {
    appId: "generic-app",
    actionId: "record",
    destination: "https://app.example/import",
    recipient: "Review in the app",
    idempotencyKey: "A".repeat(43),
    payload: { reading: 42, note: "private-marker\u202e<script>" },
};
const nonce = "B".repeat(42) + "A";
let cleanup: (() => void) | undefined;
let phase: string;
let popup: { closed: boolean; postMessage: ReturnType<typeof vi.fn> };
let fetchMock: Mock<(path: string, init: RequestInit) => Promise<Response>>;
let pendingDispatch: (() => void) | undefined;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const state = () => ({
    phase,
    expiresAtMs: Date.now() + 600_000,
    deliveryMayHaveOccurred: ["offered", "received", "saved"].includes(phase),
});
const flush = () => vi.advanceTimersByTimeAsync(0);
function postEvent(data: unknown, origin = "https://app.example", source: object = popup) {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
}
function connected(overrides: object = {}, origin?: string, source?: object) {
    const connect = popup.postMessage.mock.calls.find(
        ([m]) => m.type === "oc:app-import:connect",
    )![0];
    postEvent(
        {
            type: "oc:app-import:connected",
            version: 1,
            connectionId: connect.connectionId,
            sessionNonce: nonce,
            ...overrides,
        },
        origin,
        source,
    );
}
function appMessage(type: string, extra: object = {}) {
    postEvent({ type: `oc:app-import:${type}`, version: 1, sessionNonce: nonce, ...extra });
}
async function load() {
    el<HTMLInputElement>("pairing-code").value = "ABCDEFGHIJKLMNOPQRST";
    el<HTMLButtonElement>("claim-draft").click();
    await flush();
}
async function openAndReady() {
    await load();
    el<HTMLButtonElement>("open-app").click();
    connected();
    appMessage("ready");
    await flush();
}
beforeEach(() => {
    vi.useFakeTimers();
    phase = "reviewing";
    pendingDispatch = undefined;
    document.body.innerHTML =
        '<input id="pairing-code"><button id="claim-draft">Load</button><p id="handoff-status"></p><pre id="handoff-summary" hidden></pre><button id="open-app" disabled>Open</button>';
    popup = { closed: false, postMessage: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    fetchMock = vi.fn(async (path: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (path === "/claim")
            return json({
                version: 1,
                handoffId: "a".repeat(32),
                approvedRequestJson: JSON.stringify(request),
                expiresAtMs: Date.now() + 600_000,
            });
        if (path === "/dispatch") {
            phase = "offered";
            return json(state());
        }
        if (path === "/result") {
            phase = body.outcome;
            return json(state());
        }
        if (path === "/status") return json(state());
        throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    cleanup = startLocalNativeAppHandoff();
});
afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("native private app browser relay", () => {
    it("does nothing until click; claims once in POST body, reviews escaped exact fields, and never includes secrets in a URL", async () => {
        expect(fetchMock).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
        await load();
        el<HTMLButtonElement>("claim-draft").click();
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [path, init] = fetchMock.mock.calls[0];
        expect(path).toBe("/claim");
        expect(init).toMatchObject({
            method: "POST",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
        });
        expect(JSON.parse(init.body as string)).toEqual({
            version: 1,
            code: "ABCDEFGHIJKLMNOPQRST",
            browserProofHex: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(el<HTMLInputElement>("pairing-code").value).toBe("");
        expect(JSON.parse(el("handoff-summary").textContent!)).toEqual(request);
        expect(el("handoff-summary").textContent).toContain("\\u202e");
        expect(el("handoff-summary").querySelector("script")).toBeNull();
        expect(window.open).not.toHaveBeenCalled();
        el<HTMLButtonElement>("open-app").click();
        expect(window.open).toHaveBeenCalledExactlyOnceWith(request.destination, "_blank");
        expect(location.href).toBe("http://localhost:45821/handoff");
        expect(JSON.stringify(popup.postMessage.mock.calls)).not.toContain("private-marker");
    });
    it.each(["origin", "source", "connection", "nonce", "extras"])(
        "ignores unbound receiver consent (%s)",
        async (alteration) => {
            await load();
            el<HTMLButtonElement>("open-app").click();
            connected(
                alteration === "connection"
                    ? { connectionId: "wrong" }
                    : alteration === "nonce"
                      ? { sessionNonce: "wrong" }
                      : alteration === "extras"
                        ? { target: "wrong" }
                        : {},
                alteration === "origin" ? "https://other.example" : undefined,
                alteration === "source" ? {} : undefined,
            );
            appMessage("ready");
            await flush();
            expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/claim"]);
            expect(JSON.stringify(popup.postMessage.mock.calls)).not.toContain("private-marker");
        },
    );
    it("requires connected then ready then one successful dispatch; duplicate messages never re-offer", async () => {
        await load();
        el<HTMLButtonElement>("open-app").click();
        appMessage("ready");
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        connected();
        appMessage("ready");
        appMessage("ready");
        await flush();
        expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/claim", "/dispatch"]);
        const offers = popup.postMessage.mock.calls.filter(
            ([m]) => m.type === "oc:app-import:offer",
        );
        expect(offers).toHaveLength(1);
        expect(offers[0]).toEqual([
            {
                type: "oc:app-import:offer",
                version: 1,
                sessionNonce: nonce,
                importId: request.idempotencyKey,
                actionId: request.actionId,
                payload: request.payload,
            },
            "https://app.example",
        ]);
        appMessage("ready");
        connected();
        await flush();
        expect(
            popup.postMessage.mock.calls.filter(([m]) => m.type.endsWith(":offer")),
        ).toHaveLength(1);
    });
    it("does not send an offer when dispatch fails, and never retries", async () => {
        fetchMock.mockImplementation(async (path: string) =>
            path === "/claim"
                ? json({
                      version: 1,
                      handoffId: "a".repeat(32),
                      approvedRequestJson: JSON.stringify(request),
                      expiresAtMs: Date.now() + 600_000,
                  })
                : Promise.reject(new Error("lost response")),
        );
        await openAndReady();
        appMessage("ready");
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchMock.mock.calls.filter(([path]) => path === "/dispatch")).toHaveLength(1);
        expect(
            popup.postMessage.mock.calls.filter(([m]) => m.type.endsWith(":offer")),
        ).toHaveLength(0);
        expect(el("handoff-summary").textContent).toBe("");
        expect(el("handoff-status").textContent).toContain("outcome is unknown");
    });
    it("does not release payload after pagehide while the dispatch response is pending", async () => {
        const original = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((path: string, init: RequestInit) =>
            path === "/dispatch"
                ? new Promise<Response>((resolve) => {
                      pendingDispatch = () => {
                          phase = "offered";
                          resolve(json(state()));
                      };
                  })
                : original(path, init),
        );
        await load();
        el<HTMLButtonElement>("open-app").click();
        connected();
        appMessage("ready");
        await flush();
        window.dispatchEvent(new Event("pagehide"));
        pendingDispatch!();
        await flush();
        expect(
            popup.postMessage.mock.calls.filter(([m]) => m.type.endsWith(":offer")),
        ).toHaveLength(0);
        expect(el("handoff-summary").textContent).toBe("");
    });
    it("rechecks absolute expiry after a delayed dispatch even if timeout callbacks have not run", async () => {
        const original = fetchMock.getMockImplementation()!;
        const deadline = Date.now() + 600_000;
        fetchMock.mockImplementation((path: string, init: RequestInit) =>
            path === "/dispatch"
                ? new Promise<Response>((resolve) => {
                      pendingDispatch = () =>
                          resolve(
                              json({
                                  phase: "offered",
                                  expiresAtMs: deadline,
                                  deliveryMayHaveOccurred: true,
                              }),
                          );
                  })
                : original(path, init),
        );
        await load();
        el<HTMLButtonElement>("open-app").click();
        connected();
        appMessage("ready");
        await flush();
        // Simulate resuming a response before throttled/paused timer callbacks are dispatched.
        vi.setSystemTime(deadline + 1);
        pendingDispatch!();
        await flush();
        expect(
            popup.postMessage.mock.calls.filter(([m]) => m.type.endsWith(":offer")),
        ).toHaveLength(0);
        expect(fetchMock.mock.calls.filter(([path]) => path === "/dispatch")).toHaveLength(1);
        expect(el("handoff-summary").textContent).toBe("");
    });
    it("serializes receipt then save, and does not call receipt a saved entry", async () => {
        await openAndReady();
        appMessage("committed", {
            importId: request.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: false,
        });
        expect(fetchMock.mock.calls.filter(([path]) => path === "/result")).toHaveLength(0);
        appMessage("received", { importId: request.idempotencyKey, status: "pending-review" });
        expect(el("handoff-status").textContent).toContain("not saving");
        appMessage("committed", {
            importId: request.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: false,
        });
        await flush();
        expect(
            fetchMock.mock.calls
                .filter(([path]) => path === "/result")
                .map(([, init]) => JSON.parse(init.body as string).outcome),
        ).toEqual(["received", "saved"]);
        expect(el("handoff-status").textContent).toBe(
            "The app reports that this import was saved.",
        );
        expect(el("handoff-summary").textContent).toBe("");
    });
    it("erases pending content on native cancellation and ignores later receiver consent", async () => {
        await load();
        el<HTMLButtonElement>("open-app").click();
        phase = "cancelled";
        await vi.advanceTimersByTimeAsync(1000);
        connected();
        appMessage("ready");
        await flush();
        expect(el("handoff-summary").textContent).toBe("");
        expect(el("handoff-status").textContent).toContain("closed or expired");
        expect(fetchMock.mock.calls.filter(([path]) => path === "/dispatch")).toHaveLength(0);
    });
    it("bounds receiver consent to two minutes, with metadata only and no auto-offer", async () => {
        await load();
        el<HTMLButtonElement>("open-app").click();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(JSON.stringify(popup.postMessage.mock.calls)).not.toContain("private-marker");
        expect(
            fetchMock.mock.calls
                .filter(([path]) => path === "/result")
                .map(([, init]) => JSON.parse(init.body as string).outcome),
        ).toEqual(["uncertain"]);
        expect(el("handoff-summary").textContent).toBe("");
    });
    it("leaves blocked popups retryable only by an explicit click", async () => {
        vi.mocked(window.open).mockReturnValueOnce(null);
        await load();
        el<HTMLButtonElement>("open-app").click();
        await vi.advanceTimersByTimeAsync(1500);
        expect(window.open).toHaveBeenCalledTimes(1);
        expect(el<HTMLButtonElement>("open-app").disabled).toBe(false);
        el<HTMLButtonElement>("open-app").click();
        expect(window.open).toHaveBeenCalledTimes(2);
    });
    it("closes after an app popup is closed and erases the review", async () => {
        await load();
        el<HTMLButtonElement>("open-app").click();
        popup.closed = true;
        await vi.advanceTimersByTimeAsync(500);
        expect(el("handoff-summary").textContent).toBe("");
        expect(el<HTMLButtonElement>("open-app").disabled).toBe(true);
    });
    it.each(["throwing", "already closed"] as const)(
        "keeps an initially %s popup terminal without starting new timers or sending again",
        async (reason) => {
            await load();
            if (reason === "throwing") {
                popup.postMessage.mockImplementationOnce(() => {
                    throw new Error("Synthetic popup transport failure");
                });
            } else popup.closed = true;
            el<HTMLButtonElement>("open-app").click();
            expect(el("handoff-status").textContent).toContain("outcome is unknown");
            expect(el("handoff-summary").textContent).toBe("");
            expect(el<HTMLButtonElement>("open-app").disabled).toBe(true);
            expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/claim"]);
            expect(vi.getTimerCount()).toBe(0);
            const failureStatus = el("handoff-status").textContent;
            const sends = reason === "throwing" ? 1 : 0;
            expect(popup.postMessage).toHaveBeenCalledTimes(sends);
            popup.closed = false;
            if (reason === "throwing") {
                // Match the actual attempted connection, not an unrelated ID
                // that the live handler would reject even without cleanup.
                const connectionId = popup.postMessage.mock.calls[0][0].connectionId;
                postEvent({
                    type: "oc:app-import:connected",
                    version: 1,
                    connectionId,
                    sessionNonce: nonce,
                });
            }
            appMessage("ready");
            el<HTMLButtonElement>("open-app").dispatchEvent(new Event("click"));
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            expect(window.open).toHaveBeenCalledOnce();
            expect(popup.postMessage).toHaveBeenCalledTimes(sends);
            expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/claim"]);
            expect(el("handoff-status").textContent).toBe(failureStatus);
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it("does not automatically retry a claim whose response was lost", async () => {
        fetchMock.mockRejectedValue(new Error("lost claim"));
        await load();
        el<HTMLButtonElement>("claim-draft").click();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(window.open).not.toHaveBeenCalled();
        expect(el("handoff-status").textContent).toContain("Do not reload or retry");
    });
    it.each([
        { ...request, destination: "https://user:pass@app.example/import" },
        { ...request, destination: "https://app.example/import#token" },
        { ...request, destination: "http://external.example/import" },
        { ...request, idempotencyKey: "bad" },
        { ...request, hiddenField: "not-reviewed" },
        { ...request, payload: JSON.parse('{"__proto__":{"polluted":true}}') },
        { ...request, payload: "x".repeat(65 * 1024) },
    ])("rejects unsafe or unreviewed claim content", (value) => {
        expect(() => parseNativeApprovedRequest(JSON.stringify(value))).toThrow();
    });
});
