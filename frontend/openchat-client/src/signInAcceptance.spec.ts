// @vitest-environment jsdom
// Exercises the actual OpenChat class and private acceptance paths. Crypto/preflight, native
// commands, persistence and worker transport are inert seams; no real account or sign-in.
import { webcrypto } from "node:crypto";
import { Delegation, DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import type { Signature } from "@icp-sdk/core/agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
    native: true,
    authCreate: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    cacheRemove: vi.fn(),
    nativeRead: vi.fn(),
    nativeSave: vi.fn(),
    nativeClear: vi.fn(),
    nativeCurrent: vi.fn(),
    nativeProve: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    flow: vi.fn(),
    signer: undefined as ECDSAKeyIdentity | undefined,
    signFailure: false,
    order: [] as string[],
}));
vi.hoisted(() => {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
    })) as typeof window.matchMedia;
});
vi.mock("@icp-sdk/auth/client", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    AuthClient: { create: seam.authCreate },
}));
vi.mock("@shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@shared")>()),
    IdentityStorage: {
        createForAuthIdentity: () => ({
            storage: {},
            getKeyAndChain: seam.cacheGet,
            set: seam.cacheSet,
            remove: seam.cacheRemove,
        }),
    },
}));
vi.mock("@client/workerAgent", () => ({
    WorkerAgent: class {
        send = seam.send;
        stream = seam.stream;
    },
}));
vi.mock("@client/utils/poller", () => ({
    Poller: class {
        stop() {}
        triggerNow() {}
    },
}));
vi.mock("@client/utils/nativeBrowserSignInFlow", () => ({ runNativeBrowserSignIn: seam.flow }));
vi.mock("@client/utils/nativeBrowserSessionStorage", async (original) => ({
    ...(await original<object>()),
    NativeBrowserSessionStorage: class {
        read = seam.nativeRead;
        save = seam.nativeSave;
        clear = seam.nativeClear;
        isCurrent = seam.nativeCurrent;
    },
}));
vi.mock("@client/utils/webAuthn", () => ({
    createWebAuthnIdentity: vi.fn(),
    MultiWebAuthnIdentity: class {
        getPublicKey() {
            return seam.signer!.getPublicKey();
        }
        sign(value: Uint8Array) {
            if (seam.signFailure) throw new Error("synthetic signer failure");
            return seam.signer!.sign(value);
        }
        innerIdentity() {
            return {
                getPublicKey: () => seam.signer!.getPublicKey(),
                rawId: Uint8Array.of(1, 2, 3),
            };
        }
    },
}));
vi.mock("tauri-plugin-oc-api/commands/localBrowserAuth", () => ({
    beginLocalBrowserAuth: vi.fn(),
    pollLocalBrowserAuth: vi.fn(),
    cancelLocalBrowserAuth: vi.fn(),
    completeLocalBrowserAuth: vi.fn(),
}));
vi.mock("tauri-plugin-oc-api/commands/openUrl", () => ({ openUrl: vi.fn() }));
vi.mock("@agent/services/nativeBrowserAccountSession", () => ({
    lookupNativeBrowserCredential: vi.fn(),
    establishNativeBrowserAccountSession: seam.nativeProve,
}));

import { anonymousUser, Stream, type CreatedUser } from "@shared";
import { OpenChat } from "./openchat";
import type { OpenChatConfig } from "./config";
import { currentUserStore, identityStateStore } from "./state";
import { Principal } from "@icp-sdk/core/principal";
import { get } from "svelte/store";

const NOW = 1_800_000_000_000;
type NativeActivation = {
    activate(
        session: { ocKey: ECDSAKeyIdentity; ocChain: DelegationChain; profile: CreatedUser },
        authKey: ECDSAKeyIdentity,
        authChain: DelegationChain,
        key: { publicKey: Uint8Array; credentialId: Uint8Array },
    ): Promise<void>;
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("OpenChat verified sign-in acceptance", () => {
    let authKey: ECDSAKeyIdentity, ocKey: ECDSAKeyIdentity;
    let authChain: DelegationChain, ocChain: DelegationChain;
    let profile: CreatedUser;
    let client: OpenChat;
    let created: ReturnType<typeof vi.spyOn>, logout: ReturnType<typeof vi.spyOn>;
    const network = vi.fn(() => {
        throw new Error("Network forbidden in class acceptance tests");
    });
    const authenticated = () =>
        created.mock.calls.filter(([user]) => (user as CreatedUser).username === "synthetic-user");
    const workerSuccess = (expiry = NOW + 240_000) => ({
        kind: "success",
        ocIdentityPrincipal: ocKey.getPrincipal().toString(),
        ocIdentityExpiry: expiry,
    });
    function build(existingAccountOnly = true, overrides: Partial<OpenChatConfig> = {}) {
        client = new OpenChat({
            mobileLayout: "v1",
            websiteVersion: "synthetic",
            proposalBotCanister: "aaaaa-aa",
            identityCanister: "aaaaa-aa",
            userIndexCanister: "aaaaa-aa",
            webAuthnOrigin: "localhost",
            icUrl: "https://icp-api.io",
            existingAccountOnly,
            clientOnlyApps: existingAccountOnly,
            logger: { debug() {}, log() {}, warn() {}, error() {} },
            ...overrides,
        } as unknown as OpenChatConfig);
        return client;
    }
    async function boot() {
        await vi.waitFor(() => expect(created).toHaveBeenCalled());
        created.mockClear();
        seam.order.length = 0;
        seam.send.mockClear();
    }
    const nativeSignIn = (signal?: AbortSignal) =>
        client.signInWithLocalBrowser("synthetic-user", { signal });
    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        authKey = await ECDSAKeyIdentity.generate();
        ocKey = await ECDSAKeyIdentity.generate();
        const chain = (key: ECDSAKeyIdentity) =>
            DelegationChain.fromDelegations(
                [
                    {
                        delegation: new Delegation(
                            key.getPublicKey().toDer(),
                            BigInt(NOW + 240_000) * 1_000_000n,
                        ),
                        signature: new Uint8Array(64).fill(7) as Signature,
                    },
                ],
                key.getPublicKey().toDer(),
            );
        authChain = chain(authKey);
        authChain.delegations[0].delegation.targets = [Principal.fromText("aaaaa-aa")];
        ocChain = chain(ocKey);
        profile = { ...anonymousUser(), username: "synthetic-user", userId: "aaaaa-aa" };
    });
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        localStorage.clear();
        network.mockClear();
        seam.native = true;
        seam.signer = authKey;
        seam.signFailure = false;
        seam.order = [];
        seam.authCreate.mockReset().mockResolvedValue({ logout: vi.fn() });
        seam.cacheGet.mockReset().mockResolvedValue(undefined);
        seam.nativeRead.mockReset().mockResolvedValue({ generation: "initial" });
        seam.nativeCurrent.mockReset().mockResolvedValue(true);
        seam.nativeClear.mockReset().mockResolvedValue(undefined);
        seam.nativeSave.mockReset().mockImplementation(async () => {
            seam.order.push("native-persist");
            return "saved-generation";
        });
        seam.nativeProve.mockReset().mockResolvedValue({ ocKey, ocChain, profile });
        seam.cacheRemove.mockReset().mockResolvedValue(undefined);
        seam.cacheSet.mockReset().mockImplementation(async () => {
            seam.order.push("persist");
        });
        seam.send.mockReset().mockImplementation(async (request) => {
            if (request.kind === "setAuthIdentity") {
                seam.order.push(request.identity ? "worker-proof" : "worker-anon");
                return request.identity ? workerSuccess() : { kind: "auth_identity_not_found" };
            }
        });
        seam.stream.mockReset().mockImplementation((request) => {
            if (request.kind !== "getCurrentUser") throw new Error("Unexpected synthetic stream");
            seam.order.push("profile-proof");
            return new Stream((resolve) => queueMicrotask(() => resolve(profile, true)));
        });
        seam.flow
            .mockReset()
            .mockImplementation(async (_username, _canister, adapter: NativeActivation) =>
                adapter.activate({ ocKey, ocChain, profile }, authKey, authChain, {
                    publicKey: authKey.getPublicKey().toDer(),
                    credentialId: Uint8Array.of(1, 2, 3),
                }),
            );
        vi.spyOn(OpenChat.prototype, "isNativeApp").mockImplementation(() => seam.native);
        created = vi.spyOn(OpenChat.prototype, "onCreatedUser").mockImplementation(() => {});
        logout = vi.spyOn(OpenChat.prototype, "logout").mockResolvedValue(undefined);
        vi.spyOn(OpenChat.prototype, "getPublicProfile").mockImplementation(
            () => new Stream((resolve) => queueMicrotask(() => resolve(undefined, true))) as never,
        );
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("starts with no session without AuthClient or legacy cached auth restoration", async () => {
        build();
        await boot();
        expect(seam.authCreate).not.toHaveBeenCalled();
        expect(seam.cacheGet).not.toHaveBeenCalled();
        expect(seam.cacheSet).not.toHaveBeenCalled();
        expect(seam.nativeRead).toHaveBeenCalledOnce();
        expect(authenticated()).toHaveLength(0);
    });
    it.each([{ clientOnlyApps: false }, { icUrl: undefined }, { userIndexCanister: "" }])(
        "does not offer a shared private setup scope for incomplete/official profiles (%j)",
        async (overrides) => {
            build(true, overrides);
            await boot();
            expect(client.privateAppStorageBackend()).toBeUndefined();
        },
    );
    it.each([
        ["https://icp-api.io", "aaaaa-aa"],
        ["http://127.0.0.1:8080", "aaaaa-aa"],
        ["https://icp-api.io", "2vxsx-fae"],
    ])(
        "binds private setup to the configured gateway and account service (%s/%s)",
        async (icUrl, userIndexCanister) => {
            build(true, { icUrl, userIndexCanister });
            await boot();
            expect(client.privateAppStorageBackend()).toBe(
                JSON.stringify([icUrl, userIndexCanister]),
            );
            expect(seam.flow).not.toHaveBeenCalled();
        },
    );
    it("rejects missing gateway configuration before starting native sign-in", async () => {
        build(true, { icUrl: undefined });
        await boot();
        await expect(nativeSignIn()).rejects.toThrow(
            "Local APK identity service is not configured",
        );
        expect(seam.flow).not.toHaveBeenCalled();
        expect(seam.send).not.toHaveBeenCalled();
        expect(seam.cacheGet).not.toHaveBeenCalled();
        expect(seam.cacheSet).not.toHaveBeenCalled();
        expect(authenticated()).toHaveLength(0);
        expect(identityStateStore.value.kind).toBe("anon");
    });
    it("keeps the native sign-in form mounted while worker adoption is pending", async () => {
        build();
        await boot();
        const gate = deferred<ReturnType<typeof workerSuccess>>();
        const transitions = vi.spyOn(client, "updateIdentityState");
        seam.send.mockImplementation(async (request) =>
            request.kind === "setAuthIdentity"
                ? request.identity
                    ? gate.promise
                    : { kind: "auth_identity_not_found" }
                : undefined,
        );
        const pending = nativeSignIn();
        await vi.waitFor(() =>
            expect(seam.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: "setAuthIdentity",
                    nativeBrowserSession: expect.any(Object),
                }),
            ),
        );
        expect(identityStateStore.value.kind).toBe("logging_in");
        expect(transitions.mock.calls.some(([state]) => state.kind === "loading_user")).toBe(false);
        expect(authenticated()).toHaveLength(0);
        gate.resolve(workerSuccess());
        await pending;
        expect(authenticated()).toEqual([[profile]]);
        expect(transitions.mock.calls.some(([state]) => state.kind === "loading_user")).toBe(false);
    });
    it("saves only after adoption of the proven profile and respects even a short signed expiry", async () => {
        build();
        await boot();
        const getUser = vi.spyOn(client, "getCurrentUser");
        await nativeSignIn();
        expect(authenticated()).toEqual([[profile]]);
        expect(getUser).not.toHaveBeenCalled();
        expect(seam.stream).not.toHaveBeenCalled();
        expect(seam.cacheGet).not.toHaveBeenCalled();
        expect(seam.cacheSet).not.toHaveBeenCalled();
        expect(seam.nativeSave).toHaveBeenCalledOnce();
        expect(seam.order).toEqual(["worker-proof", "native-persist"]);
        expect(seam.send).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "setAuthIdentity",
                nativeBrowserSession: expect.objectContaining({ expiresAtMs: NOW + 240_000 }),
            }),
        );
        expect(logout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(NOW + 239_000 - Date.now() - 1);
        expect(logout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(logout).toHaveBeenCalledOnce();
    });
    function savedSession() {
        return {
            scope: {
                icUrl: "https://icp-api.io",
                identityCanister: "aaaaa-aa",
                userIndexCanister: "aaaaa-aa",
            },
            key: authKey.getKeyPair(),
            delegation: authChain.toJSON(),
            expiresAtMs: NOW + 240_000,
            username: profile.username,
            userId: profile.userId,
            ocPrincipal: ocKey.getPrincipal().toString(),
            webAuthnKey: { publicKey: authChain.publicKey, credentialId: Uint8Array.of(1) },
        };
    }
    it("restores only after fresh official proof and exact saved account/scope bindings", async () => {
        const saved = savedSession();
        seam.nativeRead.mockResolvedValue({ generation: "existing", session: saved });
        build();
        await vi.waitFor(() => expect(authenticated()).toHaveLength(1));
        expect(seam.flow).not.toHaveBeenCalled();
        expect(seam.nativeProve).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedAccount: { userId: saved.userId, ocPrincipal: saved.ocPrincipal },
                ...saved.scope,
                expiresAtMs: saved.expiresAtMs,
            }),
        );
        expect(seam.nativeCurrent).toHaveBeenCalledWith("existing");
        expect(seam.nativeSave).not.toHaveBeenCalled();
        expect(get(client.nativeSessionRestoreState)).toBe("idle");
    });
    it("keeps a valid saved identity after network failure and retries without opening the browser", async () => {
        seam.nativeRead.mockResolvedValue({ generation: "existing", session: savedSession() });
        seam.nativeProve.mockRejectedValueOnce(new Error("offline"));
        build();
        await vi.waitFor(() => expect(get(client.nativeSessionRestoreState)).toBe("retry"));
        expect(authenticated()).toHaveLength(0);
        expect(seam.nativeClear).not.toHaveBeenCalled();
        await client.retrySavedNativeSession();
        expect(authenticated()).toHaveLength(1);
        expect(seam.nativeProve).toHaveBeenCalledTimes(2);
        expect(seam.flow).not.toHaveBeenCalled();
    });
    it.each(["expired", "scope", "key"])(
        "never uses %s saved identity as account authority",
        async (failure) => {
            const saved = savedSession();
            if (failure === "expired") saved.expiresAtMs = NOW;
            if (failure === "scope") saved.scope.identityCanister = "2vxsx-fae";
            if (failure === "key") saved.key = ocKey.getKeyPair();
            seam.nativeRead.mockResolvedValue({ generation: "existing", session: saved });
            build();
            await vi.waitFor(() => expect(get(client.nativeSessionRestoreState)).toBe("invalid"));
            expect(seam.nativeProve).not.toHaveBeenCalled();
            expect(seam.nativeClear).toHaveBeenCalledWith("existing");
            expect(authenticated()).toHaveLength(0);
        },
    );
    it("does not adopt a restore superseded by another instance's logout", async () => {
        seam.nativeRead.mockResolvedValue({ generation: "existing", session: savedSession() });
        seam.nativeCurrent.mockResolvedValue(false);
        build();
        await vi.waitFor(() => expect(get(client.nativeSessionRestoreState)).toBe("retry"));
        expect(authenticated()).toHaveLength(0);
        expect(seam.nativeSave).not.toHaveBeenCalled();
    });
    it("logout clears saved state and cancels a delayed official restore result", async () => {
        const proof = deferred<{
            ocKey: ECDSAKeyIdentity;
            ocChain: DelegationChain;
            profile: CreatedUser;
        }>();
        seam.nativeRead.mockResolvedValue({ generation: "existing", session: savedSession() });
        seam.nativeProve.mockReturnValue(proof.promise);
        build();
        await vi.waitFor(() => expect(seam.nativeProve).toHaveBeenCalledOnce());
        logout.mockRestore();
        await client.logout();
        expect(seam.nativeClear).toHaveBeenCalledWith();
        proof.resolve({ ocKey, ocChain, profile });
        await vi.waitFor(() =>
            expect(seam.nativeProve.mock.results[0].value).resolves.toBeDefined(),
        );
        expect(authenticated()).toHaveLength(0);
        expect(seam.nativeSave).not.toHaveBeenCalled();
    });
    it("does not expire a 30-day signed session at the setTimeout limit", async () => {
        build();
        await boot();
        const expires = NOW + 30 * 24 * 60 * 60_000;
        const longAuth = DelegationChain.fromJSON(authChain.toJSON());
        const longOc = DelegationChain.fromJSON(ocChain.toJSON());
        longAuth.delegations[0].delegation.expiration = BigInt(expires) * 1_000_000n;
        longOc.delegations[0].delegation.expiration = BigInt(expires - 10_000) * 1_000_000n;
        seam.send.mockImplementation(async (r) =>
            r.kind === "setAuthIdentity" ? workerSuccess(expires - 10_000) : undefined,
        );
        seam.flow.mockImplementation(async (_u, _c, adapter: NativeActivation) =>
            adapter.activate({ ocKey, ocChain: longOc, profile }, authKey, longAuth, {
                publicKey: authChain.publicKey,
                credentialId: Uint8Array.of(1),
            }),
        );
        await nativeSignIn();
        await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
        expect(logout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(expires - 11_000 - Date.now());
        expect(logout).toHaveBeenCalledOnce();
    });
    it.each([
        "worker-error",
        "worker-nonsuccess",
        "principal",
        "expiry",
        "expired",
        "cancelled",
    ] as const)("does not activate a native profile after %s rejection", async (failure) => {
        build();
        await boot();
        const controller = new AbortController();
        seam.send.mockImplementation(async (request) => {
            if (request.kind !== "setAuthIdentity") return;
            if (!request.identity) return { kind: "auth_identity_not_found" };
            if (failure === "worker-error") throw new Error("synthetic worker failure");
            if (failure === "cancelled") controller.abort();
            if (failure === "expired") vi.setSystemTime(NOW + 240_000);
            return failure === "worker-nonsuccess"
                ? { kind: "oc_identity_not_found" }
                : failure === "principal"
                  ? { ...workerSuccess(), ocIdentityPrincipal: "2vxsx-fae" }
                  : failure === "expiry"
                    ? workerSuccess(NOW + 240_001)
                    : workerSuccess();
        });
        await expect(nativeSignIn(controller.signal)).rejects.toBeDefined();
        expect(authenticated()).toHaveLength(0);
        expect(seam.cacheSet).not.toHaveBeenCalled();
        expect(identityStateStore.value.kind).toBe("anon");
        expect(seam.send).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: "setAuthIdentity", identity: undefined }),
        );
    });
    it("waits for anonymous startup before activating a native session", async () => {
        const initial = deferred<unknown>();
        let started = false;
        seam.send.mockImplementation(async (request) => {
            if (request.kind !== "setAuthIdentity") return;
            if (!request.identity && !started) {
                started = true;
                return initial.promise;
            }
            return request.identity ? workerSuccess() : { kind: "auth_identity_not_found" };
        });
        build();
        const pending = nativeSignIn();
        await vi.waitFor(() => expect(started).toBe(true));
        expect(seam.flow).not.toHaveBeenCalled();
        initial.resolve({ kind: "auth_identity_not_found" });
        await pending;
        expect(authenticated()).toHaveLength(1);
        expect(created.mock.calls.at(-1)).toEqual([profile]);
    });
    it("persists unofficial WebAuthn only after worker and matching-profile proof", async () => {
        seam.native = false;
        build();
        await boot();
        const gate = deferred<CreatedUser>();
        seam.stream.mockImplementation(() => {
            seam.order.push("profile-proof");
            return new Stream((resolve, reject) => {
                gate.promise.then((user) => resolve(user, true), reject);
            });
        });
        seam.send.mockImplementation(async (request) =>
            request.kind === "setAuthIdentity"
                ? request.identity
                    ? (seam.order.push("worker-proof"), workerSuccess(NOW + 60 * 60_000))
                    : { kind: "auth_identity_not_found" }
                : undefined,
        );
        const pending = client.signInWithWebAuthn({
            username: "synthetic-user",
            credentialId: Uint8Array.of(1, 2, 3),
        });
        await vi.waitFor(() => expect(seam.order).toContain("profile-proof"));
        expect(identityStateStore.value.kind).toBe("logging_in");
        expect(seam.cacheSet).not.toHaveBeenCalled();
        expect(authenticated()).toHaveLength(0);
        gate.resolve(profile);
        await pending;
        expect(seam.order).toEqual(["worker-proof", "profile-proof", "persist"]);
        expect(authenticated()).toHaveLength(1);
    });
    it.each(["worker", "profile", "wrong-profile", "persistence"] as const)(
        "cleans up unofficial WebAuthn after %s failure",
        async (failure) => {
            seam.native = false;
            build();
            await boot();
            const transitions = vi.spyOn(client, "updateIdentityState");
            seam.send.mockImplementation(async (request) => {
                if (request.kind !== "setAuthIdentity") return;
                if (!request.identity) return { kind: "auth_identity_not_found" };
                if (failure === "worker") throw new Error("synthetic worker failure");
                return workerSuccess(NOW + 60 * 60_000);
            });
            seam.stream.mockImplementation(
                () =>
                    new Stream((resolve, reject) =>
                        queueMicrotask(() =>
                            failure === "profile"
                                ? reject(new Error("synthetic profile failure"))
                                : resolve(
                                      failure === "wrong-profile"
                                          ? { ...profile, username: "someone-else" }
                                          : profile,
                                      true,
                                  ),
                        ),
                    ),
            );
            if (failure === "persistence")
                seam.cacheSet.mockRejectedValue(new Error("synthetic storage failure"));
            await expect(
                client.signInWithWebAuthn({
                    username: "synthetic-user",
                    credentialId: Uint8Array.of(1, 2, 3),
                }),
            ).rejects.toBeDefined();
            expect(authenticated()).toHaveLength(0);
            expect(seam.cacheRemove).toHaveBeenCalledOnce();
            expect(currentUserStore.value.username).not.toBe("synthetic-user");
            expect(identityStateStore.value.kind).toBe("anon");
            expect(transitions.mock.calls.some(([state]) => state.kind === "logging_in")).toBe(
                true,
            );
            expect(transitions.mock.calls.some(([state]) => state.kind === "loading_user")).toBe(
                false,
            );
            expect(seam.send).toHaveBeenLastCalledWith({
                kind: "setAuthIdentity",
                identity: undefined,
                isIIPrincipal: false,
            });
            if (failure !== "persistence") expect(seam.cacheSet).not.toHaveBeenCalled();
        },
    );
    it("preserves official WebAuthn persistence before worker/profile startup", async () => {
        seam.native = false;
        build(false);
        await boot();
        const transitions = vi.spyOn(client, "updateIdentityState");
        seam.send.mockImplementation(async (request) =>
            request.kind === "setAuthIdentity"
                ? request.identity
                    ? (seam.order.push("worker-proof"), workerSuccess(NOW + 60 * 60_000))
                    : { kind: "auth_identity_not_found" }
                : undefined,
        );
        await client.signInWithWebAuthn();
        expect(seam.authCreate).toHaveBeenCalledOnce();
        expect(seam.order).toEqual(["persist", "worker-proof", "profile-proof"]);
        expect(authenticated()).toHaveLength(1);
        expect(transitions.mock.calls.some(([state]) => state.kind === "loading_user")).toBe(true);
        expect(transitions.mock.calls.some(([state]) => state.kind === "logging_in")).toBe(false);
    });
    it("preserves loading_user during automatic unofficial browser session restoration", async () => {
        seam.native = false;
        seam.cacheGet.mockResolvedValue({ key: authKey, delegation: authChain });
        const gate = deferred<ReturnType<typeof workerSuccess>>();
        seam.send.mockImplementation(async (request) =>
            request.kind === "setAuthIdentity"
                ? request.identity
                    ? gate.promise
                    : { kind: "auth_identity_not_found" }
                : undefined,
        );
        build();
        await vi.waitFor(() =>
            expect(seam.send).toHaveBeenCalledWith(
                expect.objectContaining({ kind: "setAuthIdentity", identity: expect.any(Object) }),
            ),
        );
        expect(identityStateStore.value.kind).toBe("loading_user");
        gate.resolve(workerSuccess(NOW + 60 * 60_000));
        await vi.waitFor(() => expect(authenticated()).toHaveLength(1));
        expect(seam.cacheSet).not.toHaveBeenCalled();
    });
});
