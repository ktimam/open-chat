// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LocalAppDraftStore, type LocalDraftDeliveryRequest } from "./localAppDrafts";
import {
    localAppBase64Url,
    sealLocalAppDelivery,
    LOCAL_APP_ENCRYPTION_SCHEME,
} from "./localAppEncryption";
import {
    validateLocalAppInbox,
    localAppInboxEndpoint,
    localAppInboxTarget,
    localAppInboxSha256,
    validateLocalAppInboxDelivery,
    validateLocalAppInboxReceipt,
    localAppInboxReviewUrl,
    type LocalAppInboxGrant,
    type LocalAppInboxDelivery,
    type LocalAppInboxReceipt,
} from "./localAppInbox";
import {
    deliverLocalAppToInbox,
    localAppInboxUsesDevelopmentRootKey,
    type LocalAppInboxDeposit,
} from "./localAppInboxDelivery";

const grant: LocalAppInboxGrant = {
    version: 1,
    kind: "ic-canister",
    host: "https://app.example",
    canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    inboxId: "a".repeat(64),
    writeCapability: localAppBase64Url(new Uint8Array(32).fill(7)),
    expiresAtMs: Date.now() + 86_400_000,
};
async function request(): Promise<LocalDraftDeliveryRequest> {
    const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));
    return {
        appId: "example",
        appRevision: "1",
        actionId: "record",
        destination: "https://app.example/import",
        recipient: "Example recipient",
        deliveryInbox: await localAppInboxTarget(grant),
        deliveryEncryption: {
            version: 1,
            scheme: LOCAL_APP_ENCRYPTION_SCHEME,
            keyId: await localAppInboxSha256(spki),
            publicKeySpki: localAppBase64Url(spki),
            recipientContext: localAppBase64Url(new TextEncoder().encode("synthetic-recipient")),
        },
        idempotencyKey: "B".repeat(42) + "A",
        payload: { note: "PRIVATE_PLAINTEXT_SENTINEL" },
    };
}
const receiptFor = async (
    id: string,
    bytes: Uint8Array<ArrayBuffer>,
    extra: Partial<LocalAppInboxReceipt> = {},
): Promise<LocalAppInboxReceipt> => ({
    inboxId: grant.inboxId,
    requestId: id,
    bodySha256: await localAppInboxSha256(bytes),
    receivedAtMs: Date.now(),
    expiresAtMs: Date.now() + 86_400_000,
    status: "Pending",
    replayed: false,
    ...extra,
});

describe("private app inbox declarations", () => {
    it("accepts public endpoint separately from a complete private capability grant", async () => {
        expect(validateLocalAppInbox(localAppInboxEndpoint(grant))).toEqual({
            version: 1,
            kind: "ic-canister",
            host: grant.host,
            canisterId: grant.canisterId,
        });
        expect(validateLocalAppInbox(grant)).toEqual(grant);
        expect(JSON.stringify(await localAppInboxTarget(grant))).not.toContain(
            grant.writeCapability,
        );
    });
    it.each([
        "http://app.example",
        "https://app.example/",
        "https://u:p@app.example",
        "https://app.example/path",
        "https://app.example?x=1",
        "https://app.example#x",
        "file:///tmp/x",
    ])("rejects unsafe or noncanonical host %s", (host) => {
        expect(() => validateLocalAppInbox({ ...grant, host })).toThrow();
    });
    it.each(["localhost", "127.0.0.1", "[::1]"])("allows explicit HTTP loopback %s", (hostname) => {
        expect(validateLocalAppInbox({ ...grant, host: `http://${hostname}:8080` }).host).toBe(
            `http://${hostname}:8080`,
        );
    });
    it.each(["2vxsx-fae", "aaaaa-aa", "not-a-principal", "RRKAH-FQAAA-AAAAA-AAAAQ-CAI"])(
        "rejects invalid/anonymous/management principal %s",
        (canisterId) => {
            expect(() => validateLocalAppInbox({ ...grant, canisterId })).toThrow();
        },
    );
    it("rejects partial grants, malformed capabilities, unsafe timestamps and extra fields", () => {
        const endpoint = localAppInboxEndpoint(grant);
        for (const value of [
            { ...endpoint, inboxId: grant.inboxId },
            { ...grant, writeCapability: "x" },
            { ...grant, expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
            { ...grant, extra: true },
            { ...grant, inboxId: "A".repeat(64) },
        ])
            expect(() => validateLocalAppInbox(value)).toThrow();
    });
    it("never fetches a development replica root key for production or arbitrary HTTPS", () => {
        expect(localAppInboxUsesDevelopmentRootKey("http://localhost:8080", false)).toBe(false);
        expect(localAppInboxUsesDevelopmentRootKey("https://node.tail123.ts.net:9443", false)).toBe(
            false,
        );
        expect(localAppInboxUsesDevelopmentRootKey("https://app.example", true)).toBe(false);
        expect(localAppInboxUsesDevelopmentRootKey("http://localhost:8080", true)).toBe(true);
        expect(localAppInboxUsesDevelopmentRootKey("https://node.tail123.ts.net:9443", true)).toBe(
            true,
        );
    });
    it("does not invoke getters while validating a grant", () => {
        const getter = vi.fn();
        expect(() =>
            validateLocalAppInbox(
                Object.defineProperty({ ...grant }, "writeCapability", {
                    get: getter,
                    enumerable: true,
                }),
            ),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
});

describe("durable encrypted inbox delivery", () => {
    it("saves ciphertext before deposit and durable receipt after; never sends plaintext or capability in JSON", async () => {
        const reviewed = await request();
        const writes: LocalAppInboxDelivery[] = [];
        const deposit: LocalAppInboxDeposit = vi.fn(async (_grant, id, bytes) => {
            expect(writes).toHaveLength(1);
            expect(new TextDecoder().decode(bytes)).toBe(writes[0].requestJson);
            expect(writes[0].requestJson).not.toContain("PRIVATE_PLAINTEXT_SENTINEL");
            expect(writes[0].requestJson).not.toContain(grant.writeCapability);
            return receiptFor(id, bytes);
        });
        expect(
            await deliverLocalAppToInbox(reviewed, new AbortController().signal, {
                grant,
                persist: async (value) => {
                    writes.push(structuredClone(value));
                },
                deposit,
            }),
        ).toEqual({ kind: "delivered" });
        expect(deposit).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(2);
        expect(writes[1].receipt?.status).toBe("Pending");
        expect(writes[0].requestJson).toBe(writes[1].requestJson);
    });
    it("does not deposit if write-ahead storage fails", async () => {
        const deposit = vi.fn();
        expect(
            await deliverLocalAppToInbox(await request(), new AbortController().signal, {
                grant,
                persist: async () => {
                    throw Error("storage unavailable");
                },
                deposit,
            }),
        ).toEqual({ kind: "uncertain" });
        expect(deposit).not.toHaveBeenCalled();
    });
    it("an unknown outcome retry uses the exact same ciphertext and request ID, including after serialization", async () => {
        const reviewed = await request();
        let saved: LocalAppInboxDelivery | undefined;
        const bodies: string[] = [];
        const persist = async (value: LocalAppInboxDelivery) => {
            saved = JSON.parse(JSON.stringify(value));
        };
        const first: LocalAppInboxDeposit = async (_grant, id, bytes) => {
            bodies.push(new TextDecoder().decode(bytes));
            expect(id).toBe(reviewed.idempotencyKey);
            throw Error("unknown network outcome");
        };
        expect(
            await deliverLocalAppToInbox(reviewed, new AbortController().signal, {
                grant,
                persist,
                deposit: first,
            }),
        ).toEqual({ kind: "uncertain" });
        const retry: LocalAppInboxDeposit = async (_grant, id, bytes) => {
            bodies.push(new TextDecoder().decode(bytes));
            return receiptFor(id, bytes, { replayed: true });
        };
        expect(
            await deliverLocalAppToInbox(reviewed, new AbortController().signal, {
                grant,
                saved,
                persist,
                deposit: retry,
            }),
        ).toEqual({ kind: "delivered" });
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toBe(bodies[1]);
    });
    it.each(["requestId", "bodySha256", "inboxId"] as const)(
        "rejects mismatched durable receipt %s",
        async (field) => {
            const deposit: LocalAppInboxDeposit = async (_grant, id, bytes) =>
                receiptFor(id, bytes, {
                    [field]: field === "requestId" ? "C".repeat(42) + "A" : "f".repeat(64),
                });
            expect(
                await deliverLocalAppToInbox(await request(), new AbortController().signal, {
                    grant,
                    persist: async () => {},
                    deposit,
                }),
            ).toEqual({ kind: "uncertain" });
        },
    );
    it("accepts an owner-bound cross-grant replay only when same body and ID were acknowledged", async () => {
        const deposit: LocalAppInboxDeposit = async (_grant, id, bytes) =>
            receiptFor(id, bytes, { inboxId: "b".repeat(64), replayed: true, status: "Saved" });
        let saved: LocalAppInboxDelivery | undefined;
        expect(
            await deliverLocalAppToInbox(await request(), new AbortController().signal, {
                grant,
                persist: async (value) => {
                    saved = value;
                },
                deposit,
            }),
        ).toEqual({ kind: "delivered" });
        expect(saved?.receipt?.status).toBe("Saved");
    });
    it("aborting after write-ahead never starts a deposit", async () => {
        const abort = new AbortController();
        const deposit = vi.fn();
        expect(
            await deliverLocalAppToInbox(await request(), abort.signal, {
                grant,
                persist: async () => {
                    abort.abort();
                },
                deposit,
            }),
        ).toEqual({ kind: "uncertain" });
        expect(deposit).not.toHaveBeenCalled();
    });
    it("rejects altered saved bytes, digest, recipient and expired/replaced grants", async () => {
        const reviewed = await request();
        const requestJson = JSON.stringify(await sealLocalAppDelivery(reviewed));
        const saved = {
            version: 1 as const,
            requestJson,
            bodySha256: await localAppInboxSha256(new TextEncoder().encode(requestJson)),
        };
        expect(() =>
            validateLocalAppInboxDelivery({ ...saved, bodySha256: "0".repeat(64) }, reviewed),
        ).toThrow();
        expect(() =>
            validateLocalAppInboxDelivery({ ...saved, requestJson: requestJson + " " }, reviewed),
        ).toThrow();
        expect(() =>
            validateLocalAppInboxDelivery(saved, {
                ...reviewed,
                destination: "https://other.example/import",
            }),
        ).toThrow();
        for (const changed of [
            { ...grant, expiresAtMs: 1 },
            { ...grant, writeCapability: localAppBase64Url(new Uint8Array(32).fill(8)) },
        ]) {
            const deposit = vi.fn();
            expect(
                await deliverLocalAppToInbox(reviewed, new AbortController().signal, {
                    grant: changed,
                    saved,
                    persist: async () => {},
                    deposit,
                }),
            ).toEqual({ kind: "uncertain" });
            expect(deposit).not.toHaveBeenCalled();
        }
    });
    it("restores durable Pending without restoring approval, and retains exact encrypted bytes", async () => {
        const reviewed = await request();
        const store: LocalAppDraftStore = new LocalAppDraftStore((value, signal) =>
            deliverLocalAppToInbox(value, signal, {
                grant,
                persist: async (saved) => {
                    store.setInboxDelivery(cardId, saved);
                },
                deposit: async (_grant, id, bytes) => receiptFor(id, bytes),
            }),
        );
        store.setAccount("synthetic");
        const { idempotencyKey, payload, ...target } = reviewed;
        const card = store.create({
            target,
            payload,
            schema: {
                type: "object",
                properties: { note: { type: "string" } },
                required: ["note"],
                additionalProperties: false,
            },
        });
        const cardId = card.id;
        const approval = store.review(cardId);
        expect(approval.request.idempotencyKey).not.toBe(idempotencyKey);
        expect(approval.summary).not.toContain(grant.writeCapability);
        expect(await store.confirm(cardId, approval.approvalId)).toEqual({ kind: "delivered" });
        const snapshot = JSON.parse(JSON.stringify(store.snapshot(cardId)));
        const restored = new LocalAppDraftStore(vi.fn());
        restored.setAccount("synthetic");
        expect(restored.restore(snapshot)).toMatchObject({
            status: "delivered",
            inboxDelivery: { requestJson: snapshot.inboxDelivery.requestJson },
        });
        expect(restored.get(cardId)?.approval).toBeUndefined();
        expect(restored.reviewRecovered(cardId).request.idempotencyKey).toBe(
            approval.request.idempotencyKey,
        );
        const bad = {
            ...snapshot,
            inboxDelivery: { ...snapshot.inboxDelivery, bodySha256: "0".repeat(64) },
        };
        const rejected = new LocalAppDraftStore(vi.fn());
        rejected.setAccount("synthetic");
        expect(() => rejected.restore(bad)).toThrow();
    });
    it("rejects malformed receipt fields", () => {
        expect(() => validateLocalAppInboxReceipt({ inboxId: grant.inboxId })).toThrow();
    });
    it("opens only the pinned app with opaque receipt IDs in the fragment, not fields or capability", async () => {
        const receipt = await receiptFor("B".repeat(42) + "A", new Uint8Array([1]), {
            inboxId: "b".repeat(64),
            replayed: true,
        });
        const opened = new URL(localAppInboxReviewUrl("https://app.example/import", receipt));
        expect(opened.origin).toBe("https://app.example");
        expect(opened.pathname).toBe("/import");
        expect(opened.search).toBe("");
        expect(opened.hash).toBe(`#oc-inbox=${receipt.inboxId}&oc-request=${receipt.requestId}`);
        expect(opened.href).not.toContain(grant.writeCapability);
        expect(() => localAppInboxReviewUrl("javascript:alert(1)", receipt)).toThrow();
        expect(() => localAppInboxReviewUrl("https://app.example/import#other", receipt)).toThrow();
    });
});
