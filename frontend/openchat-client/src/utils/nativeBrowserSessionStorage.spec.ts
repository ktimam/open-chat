// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelegationChain, DelegationIdentity, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import {
    NativeBrowserSessionStorage,
    validateSavedNativeSession,
    type SavedNativeSession,
} from "./nativeBrowserSessionStorage";

// Transaction-serializing IDB seam, including structured CryptoKey cloning. Browser persistence
// is checked separately; these tests exercise actual validation and CAS orchestration offline.
const memory = vi.hoisted(() => ({
    value: undefined as unknown,
    tail: Promise.resolve(),
    fail: false,
}));
vi.mock("idb", () => ({
    openDB: async () => ({
        get: async () => {
            await memory.tail;
            if (memory.fail) throw new Error("storage unavailable");
            return structuredClone(memory.value);
        },
        transaction: () => {
            const before = memory.tail;
            let release!: () => void;
            const done = new Promise<void>((resolve) => {
                release = resolve;
            });
            memory.tail = done;
            let written = false;
            return {
                store: {
                    get: async () => {
                        await before;
                        if (memory.fail) {
                            release();
                            throw new Error("storage unavailable");
                        }
                        return structuredClone(memory.value);
                    },
                    put: async (value: unknown) => {
                        await before;
                        written = true;
                        memory.value = structuredClone(value);
                        release();
                    },
                },
                get done() {
                    if (!written) release();
                    return done;
                },
            };
        },
    }),
}));

const now = 1_800_000_000_000;
const scope = {
    icUrl: "https://icp-api.io",
    identityCanister: "aaaaa-aa",
    userIndexCanister: "aaaaa-aa",
};
async function fixture(): Promise<SavedNativeSession> {
    const root = await ECDSAKeyIdentity.generate();
    const key = await ECDSAKeyIdentity.generate();
    const expiresAtMs = now + 30 * 24 * 60 * 60_000;
    const chain = await DelegationChain.create(root, key.getPublicKey(), new Date(expiresAtMs), {
        targets: [Principal.fromText(scope.identityCanister)],
    });
    return {
        scope,
        key: key.getKeyPair(),
        delegation: chain.toJSON(),
        expiresAtMs,
        username: "synthetic-user",
        userId: "aaaaa-aa",
        ocPrincipal: DelegationIdentity.fromDelegation(key, chain).getPrincipal().toString(),
        webAuthnKey: { publicKey: root.getPublicKey().toDer(), credentialId: Uint8Array.of(1, 2) },
    };
}

describe("saved native browser identity storage", () => {
    beforeEach(() => {
        vi.stubGlobal("crypto", webcrypto);
        vi.spyOn(Date, "now").mockReturnValue(now);
        memory.value = undefined;
        memory.tail = Promise.resolve();
        memory.fail = false;
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    it("roundtrips one scoped nonextractable session across adapter instances without changing expiry", async () => {
        const first = new NativeBrowserSessionStorage();
        const saved = await fixture();
        const generation = await first.save(
            saved,
            (await first.read()).generation,
            new AbortController().signal,
        );
        const second = new NativeBrowserSessionStorage();
        const record = await second.read();
        expect(record.generation).toBe(generation);
        expect(record.session?.expiresAtMs).toBe(saved.expiresAtMs);
        expect(record.session?.key.privateKey.extractable).toBe(false);
        await expect(validateSavedNativeSession(record.session!, scope)).resolves.toBeDefined();
        expect(Object.keys(memory.value as object).sort()).toEqual([
            "generation",
            "session",
            "version",
        ]);
    });
    it.each(["expiry", "scope", "root", "leaf", "target", "private", "extractable", "extra-link"])(
        "rejects %s drift without writing",
        async (variant) => {
            const saved = await fixture();
            if (variant === "expiry") saved.expiresAtMs++;
            if (variant === "scope") saved.scope = { ...scope, icUrl: "https://evil.invalid" };
            if (variant === "root") saved.webAuthnKey.publicKey = new Uint8Array(91);
            const chain = DelegationChain.fromJSON(saved.delegation);
            if (variant === "leaf") chain.delegations[0].delegation.pubkey[0] ^= 1;
            if (variant === "target") chain.delegations[0].delegation.targets = [];
            if (variant === "extra-link") chain.delegations.push(chain.delegations[0]);
            saved.delegation = chain.toJSON();
            if (variant === "private")
                saved.key.privateKey = (await ECDSAKeyIdentity.generate()).getKeyPair().privateKey;
            if (variant === "extractable")
                saved.key.privateKey = (
                    await ECDSAKeyIdentity.generate({ extractable: true })
                ).getKeyPair().privateKey;
            await expect(
                new NativeBrowserSessionStorage().save(
                    saved,
                    "initial",
                    new AbortController().signal,
                ),
            ).rejects.toThrow();
            expect(memory.value).toBeUndefined();
        },
    );
    it("rejects expired record and wrong backend/account service before restoration", async () => {
        const saved = await fixture();
        for (const changed of [
            { ...scope, userIndexCanister: "2vxsx-fae" },
            { ...scope, identityCanister: "2vxsx-fae" },
        ])
            await expect(validateSavedNativeSession(saved, changed)).rejects.toThrow();
        vi.mocked(Date.now).mockReturnValue(saved.expiresAtMs);
        await expect(validateSavedNativeSession(saved, scope)).rejects.toThrow();
    });
    it("rejects extra stored data and snapshots checked inputs before asynchronous writes", async () => {
        const store = new NativeBrowserSessionStorage();
        const saved = await fixture();
        await expect(
            store.save(
                { ...saved, draft: "must-not-persist" } as SavedNativeSession,
                "initial",
                new AbortController().signal,
            ),
        ).rejects.toThrow();
        expect(memory.value).toBeUndefined();
        const saving = store.save(saved, "initial", new AbortController().signal);
        saved.username = "mutated-after-validation-started";
        await saving;
        expect((await store.read()).session?.username).toBe("synthetic-user");
    });
    it("rejects a delayed save when logout occurs during key validation", async () => {
        const store = new NativeBrowserSessionStorage();
        const saved = await fixture();
        const saving = store.save(saved, "initial", new AbortController().signal);
        // Validation necessarily yields to WebCrypto before opening its write transaction.
        await new NativeBrowserSessionStorage().clear();
        await expect(saving).rejects.toMatchObject({ name: "AbortError" });
        expect((await store.read()).session).toBeUndefined();
    });
    it("logout tombstone contains no session and rejects a stale save from another instance", async () => {
        const first = new NativeBrowserSessionStorage();
        const second = new NativeBrowserSessionStorage();
        const old = await first.read();
        const saved = await fixture();
        await second.clear();
        await expect(
            first.save(saved, old.generation, new AbortController().signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(Object.keys(memory.value as object).sort()).toEqual(["generation", "version"]);
        expect((await first.read()).session).toBeUndefined();
    });
    it("logout wins even if it starts after a save, and stale cleanup cannot erase a new session", async () => {
        const store = new NativeBrowserSessionStorage();
        const saved = await fixture();
        const first = await store.save(saved, "initial", new AbortController().signal);
        await store.clear();
        const second = await store.save(
            saved,
            (await store.read()).generation,
            new AbortController().signal,
        );
        await store.clear(first);
        expect((await store.read()).generation).toBe(second);
        await store.clear();
        expect((await store.read()).session).toBeUndefined();
    });
    it("rejects cancelled saves and reports storage failure without localStorage fallback", async () => {
        const store = new NativeBrowserSessionStorage();
        const signal = new AbortController();
        signal.abort();
        await expect(store.save(await fixture(), "initial", signal.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(memory.value).toBeUndefined();
        memory.fail = true;
        await expect(store.read()).rejects.toThrow("storage unavailable");
        await expect(store.clear()).rejects.toThrow("storage unavailable");
    });
});
