// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverLocalAppViaRelay, cancelLocalAppHandoffs } from "./localAppRelayDelivery";
import { createNativeAppDelivery } from "./nativeAppDelivery";
import { localAppBase64Url, validateEncryptedLocalAppDeliveryRequest } from "./localAppEncryption";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";

async function request(): Promise<LocalDraftDeliveryRequest> {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    return {
        appId: "example",
        appRevision: "local-import-v2",
        actionId: "record",
        destination: "https://app.example/import",
        recipient: "PRIVATE_LABEL",
        idempotencyKey: "A".repeat(43),
        deliveryEncryption: {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            publicKeySpki: localAppBase64Url(spki),
            recipientContext: "Y29udGV4dA",
            keyId: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)), (b) =>
                b.toString(16).padStart(2, "0"),
            ).join(""),
        },
        payload: { marker: "PRIVATE_ENTRY_FIELDS_12900" },
    };
}
function browser() {
    const channels: FakeChannel[] = [];
    class FakeChannel {
        onmessage?: (event: { data: unknown }) => void;
        onmessageerror?: () => void;
        postMessage = vi.fn();
        close = vi.fn();
        constructor(readonly name: string) {
            channels.push(this);
        }
    }
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.stubGlobal("location", { origin: "https://client.example" });
    vi.stubGlobal("window", { open, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    return { open, channels };
}
const privateMarkersAbsent = (value: unknown) => {
    const json = JSON.stringify(value);
    expect(json).not.toContain("PRIVATE_ENTRY_FIELDS_12900");
    expect(json).not.toContain("PRIVATE_LABEL");
    expect(json).not.toContain('"payload"');
};
afterEach(() => {
    cancelLocalAppHandoffs();
    vi.unstubAllGlobals();
});
describe("actual crypto before browser and native transports (no sealing mocks)", () => {
    it("opens an empty relay synchronously but sends only ciphertext after durable approval", async () => {
        const r = await request();
        const f = browser();
        const abort = new AbortController();
        let saved!: () => void;
        const gate = new Promise<void>((resolve) => {
            saved = resolve;
        });
        const result = deliverLocalAppViaRelay(r, abort.signal, gate);
        expect(f.open).toHaveBeenCalledOnce();
        const c = f.channels[0];
        const nonce = c.name.split(":")[1];
        c.onmessage?.({ data: { type: "relay-ready", version: 1, sessionNonce: nonce } });
        await Promise.resolve();
        expect(c.postMessage).not.toHaveBeenCalled();
        saved();
        await vi.waitFor(() => expect(c.postMessage).toHaveBeenCalledOnce());
        const wire = c.postMessage.mock.calls[0][0].request;
        expect(validateEncryptedLocalAppDeliveryRequest(wire).idempotencyKey).toBe(
            r.idempotencyKey,
        );
        privateMarkersAbsent(c.postMessage.mock.calls);
        privateMarkersAbsent(f.open.mock.calls);
        abort.abort();
        expect(await result).toEqual({ kind: "uncertain" });
    });
    it("a failed write-ahead blocks all browser release, even before relay readiness", async () => {
        const r = await request();
        const f = browser();
        const result = deliverLocalAppViaRelay(
            r,
            new AbortController().signal,
            Promise.reject(new Error("storage failure")),
        );
        expect(await result).toEqual({ kind: "uncertain" });
        expect(f.channels[0].postMessage.mock.calls.every(([m]) => m.type === "relay-cancel")).toBe(
            true,
        );
        privateMarkersAbsent(f.channels[0].postMessage.mock.calls);
    });
    it("never passes plaintext to native IPC, and persistence failure never starts native handoff", async () => {
        const r = await request();
        browser();
        const deps = {
            begin: vi.fn(async (_request: { approvedRequestJson: string }) => ({
                handoffId: "a".repeat(32),
                pairingCode: "A".repeat(20),
                url: "http://localhost:41000/handoff",
                claimExpiresAtMs: Date.now() + 120000,
            })),
            poll: vi.fn(async () => ({
                phase: "received" as const,
                expiresAtMs: Date.now() + 600000,
                deliveryMayHaveOccurred: true,
            })),
            cancel: vi.fn(async () => {}),
            open: vi.fn(async () => {}),
            copy: vi.fn(async () => {}),
            status: vi.fn(),
        };
        const adapter = createNativeAppDelivery(deps);
        expect(
            await adapter.deliver(
                r,
                new AbortController().signal,
                Promise.reject(new Error("quota")),
            ),
        ).toEqual({ kind: "uncertain" });
        expect(deps.begin).not.toHaveBeenCalled();
        expect(await adapter.deliver(r, new AbortController().signal, Promise.resolve())).toEqual({
            kind: "delivered",
        });
        const wire = JSON.parse(deps.begin.mock.calls[0][0].approvedRequestJson);
        validateEncryptedLocalAppDeliveryRequest(wire);
        privateMarkersAbsent(wire);
        adapter.cancelAll();
    });
});
