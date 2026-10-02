// @vitest-environment jsdom
// The real OpenChat auth methods and IdentityStorage execute here. Only provider/crypto,
// IndexedDB I/O and worker transport are synthetic. onCreatedUser stops unrelated app polling;
// these tests do not qualify a device, credential provider, RP or signing certificate.
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from "vitest";

const seam = vi.hoisted(() => ({
    native: true,
    authCreate: vi.fn(),
    authLogin: vi.fn(),
    authLogout: vi.fn(),
    storageGet: vi.fn(),
    storageSet: vi.fn(),
    storageRemove: vi.fn(),
    data: new Map<string, unknown>(),
    nativeConstruct: vi.fn(),
    webConstruct: vi.fn(),
    nativeCreate: vi.fn(),
    webCreate: vi.fn(),
    providerSign: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    workerFailure: undefined as ((error: unknown) => void) | undefined,
    signer: undefined as ECDSAKeyIdentity | undefined,
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
    IdbStorage: class {
        constructor(private options: { dbName: string }) {}
        get(key: string) {
            return seam.storageGet(`${this.options.dbName}/${key}`);
        }
        set(key: string, value: unknown) {
            return seam.storageSet(`${this.options.dbName}/${key}`, value);
        }
        remove(key: string) {
            return seam.storageRemove(`${this.options.dbName}/${key}`);
        }
    },
}));
vi.mock("@client/workerAgent", () => ({
    WorkerAgent: class {
        constructor(_config: unknown, onFailure: (error: unknown) => void) {
            seam.workerFailure = onFailure;
        }
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
vi.mock("@client/utils/androidWebAuthn", () => ({
    createAndroidWebAuthnPasskeyIdentity: seam.nativeCreate,
    AndroidWebAuthnPasskeyIdentity: class {
        private lookup: (id: Uint8Array) => Promise<Uint8Array>;
        constructor(...args: [(id: Uint8Array) => Promise<Uint8Array>]) {
            [this.lookup] = args;
            seam.nativeConstruct(...args);
        }
        getPublicKey() {
            return seam.signer!.getPublicKey();
        }
        async sign(value: Uint8Array) {
            await this.lookup(Uint8Array.of(1, 2, 3));
            return seam.providerSign(value);
        }
        identity() {
            return {
                getPublicKey: () => seam.signer!.getPublicKey(),
                rawId: Uint8Array.of(1, 2, 3),
            };
        }
    },
}));
vi.mock("@client/utils/webAuthn", () => ({
    createWebAuthnIdentity: seam.webCreate,
    MultiWebAuthnIdentity: class {
        private lookup: (id: Uint8Array) => Promise<Uint8Array>;
        constructor(...args: [string, (id: Uint8Array) => Promise<Uint8Array>]) {
            [, this.lookup] = args;
            seam.webConstruct(...args);
        }
        getPublicKey() {
            return seam.signer!.getPublicKey();
        }
        async sign(value: Uint8Array) {
            await this.lookup(Uint8Array.of(1, 2, 3));
            return seam.providerSign(value);
        }
        innerIdentity() {
            return {
                getPublicKey: () => seam.signer!.getPublicKey(),
                rawId: Uint8Array.of(1, 2, 3),
            };
        }
    },
}));

import {
    anonymousUser,
    AuthProvider,
    IdentityStorage,
    Stream,
    type CreatedUser,
    type WebAuthnKeyFull,
} from "@shared";
import { OpenChat } from "./openchat";
import type { OpenChatConfig } from "./config";
import {
    chatsInitialisedStore,
    currentUserStore,
    identityStateStore,
    selectedAuthProviderStore,
    startupErrorStore,
} from "./state";

const NOW = 1_800_000_000_000;
const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
const logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("OpenChat original authentication pipeline", () => {
    let authKey: ECDSAKeyIdentity;
    let savedKey: ECDSAKeyIdentity;
    let savedChain: DelegationChain;
    let profile: CreatedUser;
    let client: OpenChat;
    let created: MockInstance<OpenChat["onCreatedUser"]>;
    const network = vi.fn(() => {
        throw new Error("Network forbidden in class authentication tests");
    });
    const authenticated = () =>
        created.mock.calls.filter(([user]) => (user as CreatedUser).username === "synthetic-user");
    const workerSuccess = () => ({
        kind: "success",
        ocIdentityPrincipal: "aaaaa-aa",
        ocIdentityExpiry: NOW + THIRTY_DAYS,
    });
    function build(overrides: Partial<OpenChatConfig> = {}) {
        client = new OpenChat({
            mobileLayout: "v1",
            websiteVersion: "synthetic",
            proposalBotCanister: "aaaaa-aa",
            identityCanister: "aaaaa-aa",
            userIndexCanister: "aaaaa-aa",
            webAuthnOrigin: "oc.app",
            internetIdentityUrl: "https://identity.example.invalid",
            icUrl: "https://icp-api.io",
            clientOnlyApps: true,
            logger,
            ...overrides,
        } as unknown as OpenChatConfig);
        return client;
    }
    async function boot() {
        await vi.waitFor(() => expect(created).toHaveBeenCalled());
        vi.setSystemTime(NOW);
        created.mockClear();
        seam.order.length = 0;
        seam.send.mockClear();
    }
    async function seedIdentity(chain = savedChain) {
        await IdentityStorage.createForAuthIdentity().set(savedKey, chain);
        seam.storageSet.mockClear();
        seam.order.length = 0;
    }
    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        authKey = await ECDSAKeyIdentity.generate();
        savedKey = await ECDSAKeyIdentity.generate();
        savedChain = await DelegationChain.create(
            authKey,
            savedKey.getPublicKey(),
            new Date(NOW + THIRTY_DAYS),
        );
        profile = { ...anonymousUser(), username: "synthetic-user", userId: "aaaaa-aa" };
    });
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("gtag", vi.fn());
        localStorage.clear();
        network.mockClear();
        seam.data.clear();
        seam.native = true;
        seam.signer = authKey;
        seam.order = [];
        seam.nativeConstruct.mockClear();
        seam.webConstruct.mockClear();
        seam.authLogin.mockReset();
        seam.authLogout.mockReset().mockResolvedValue(undefined);
        seam.authCreate.mockReset().mockResolvedValue({
            login: seam.authLogin,
            logout: seam.authLogout,
        });
        seam.storageGet.mockReset().mockImplementation(async (key) => seam.data.get(key));
        seam.storageSet.mockReset().mockImplementation(async (key, value) => {
            seam.data.set(key, value);
            if (key === "auth-client-db/delegation") seam.order.push("persist");
        });
        seam.storageRemove.mockReset().mockImplementation(async (key) => seam.data.delete(key));
        seam.providerSign.mockReset().mockImplementation((value) => authKey.sign(value));
        const createIdentity = async (
            _username: string,
            cache: (key: WebAuthnKeyFull) => Promise<void>,
        ) => {
            await cache({
                publicKey: new Uint8Array(authKey.getPublicKey().toDer()),
                credentialId: Uint8Array.of(1, 2, 3),
                origin: "oc.app",
                crossPlatform: false,
                aaguid: new Uint8Array(16),
            });
            return {
                getPublicKey: () => authKey.getPublicKey(),
                getPrincipal: () => authKey.getPrincipal(),
                rawId: Uint8Array.of(1, 2, 3),
            };
        };
        seam.nativeCreate.mockReset().mockImplementation(createIdentity);
        seam.webCreate
            .mockReset()
            .mockImplementation((_origin, cache, username) => createIdentity(username, cache));
        seam.send.mockReset().mockImplementation(async (request) => {
            switch (request.kind) {
                case "setAuthIdentity":
                    seam.order.push(request.identity ? "worker-identity" : "worker-anon");
                    return request.identity ? workerSuccess() : { kind: "auth_identity_not_found" };
                case "lookupWebAuthnPubKey":
                    return new Uint8Array(authKey.getPublicKey().toDer());
                case "registerUser":
                    return { kind: "success" };
            }
        });
        seam.stream.mockReset().mockImplementation((request) => {
            if (request.kind === "getCurrentUser") {
                seam.order.push("profile");
                return new Stream((resolve) => queueMicrotask(() => resolve(profile, true)));
            }
            if (request.kind === "getPublicProfile") {
                return new Stream((resolve) => queueMicrotask(() => resolve(undefined, true)));
            }
            throw new Error(`Unexpected synthetic stream: ${request.kind}`);
        });
        vi.spyOn(OpenChat.prototype, "isNativeApp").mockImplementation(() => seam.native);
        // End the acceptance pipeline at its real profile result, before unrelated chat polling.
        created = vi.spyOn(OpenChat.prototype, "onCreatedUser").mockImplementation(() => {});
        for (const fn of Object.values(logger)) fn.mockClear();
        currentUserStore.set(anonymousUser());
        identityStateStore.set({ kind: "anon" });
        startupErrorStore.set(undefined);
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([true, false])(
        "starts native=%s through AuthClient and IdentityStorage",
        async (native) => {
            seam.native = native;
            build();
            await boot();
            expect(seam.authCreate).toHaveBeenCalledWith({
                idleOptions: { disableIdle: true, disableDefaultIdleCallback: true },
                storage: expect.any(Object),
            });
            expect(seam.storageGet).toHaveBeenCalledWith("auth-client-db/identity");
            expect(seam.providerSign).not.toHaveBeenCalled();
            expect(seam.storageSet).not.toHaveBeenCalled();
            expect(identityStateStore.value.kind).toBe("anon");
        },
    );
    it.each(["android", "web"])(
        "uses the real %s sign-in pipeline and 30-day persistence",
        async (provider) => {
            seam.native = provider === "android";
            build();
            await boot();
            const transitions = vi.spyOn(client, "updateIdentityState");
            const getUser = vi.spyOn(client, "getCurrentUser");
            if (provider === "android") await client.signInWithAndroidWebAuthn();
            else await client.signInWithWebAuthn();
            expect(seam.order).toEqual(["persist", "worker-identity", "profile"]);
            expect(seam.providerSign).toHaveBeenCalledOnce();
            expect(getUser).toHaveBeenCalledOnce();
            expect(authenticated()).toEqual([[profile]]);
            expect(currentUserStore.value).toEqual(profile);
            expect(transitions).toHaveBeenCalledWith({ kind: "loading_user", registering: false });
            const saved = await IdentityStorage.createForAuthIdentity().getKeyAndChain();
            expect(saved!.delegation.delegations[0].delegation.expiration).toBe(
                BigInt(NOW + THIRTY_DAYS) * 1_000_000n,
            );
            expect(seam.send).toHaveBeenCalledWith({
                kind: "setAuthIdentity",
                identity: { key: saved!.key.getKeyPair(), delegation: saved!.delegation.toJSON() },
                isIIPrincipal: false,
            });
            if (provider === "android") {
                expect(seam.nativeConstruct).toHaveBeenCalledWith(expect.any(Function));
                expect(seam.webConstruct).not.toHaveBeenCalled();
            } else expect(seam.webConstruct).toHaveBeenCalledWith("oc.app", expect.any(Function));
        },
    );
    it("restores the persisted native sign-in through the original worker/profile pipeline without a provider prompt", async () => {
        build();
        await boot();
        await client.signInWithAndroidWebAuthn();
        const saved = await IdentityStorage.createForAuthIdentity().getKeyAndChain();
        created.mockClear();
        seam.providerSign.mockClear();
        seam.nativeConstruct.mockClear();
        seam.storageSet.mockClear();
        seam.order.length = 0;
        build();
        await vi.waitFor(() => expect(authenticated()).toHaveLength(1));
        expect(seam.order).toEqual(["worker-identity", "profile"]);
        expect(seam.nativeConstruct).not.toHaveBeenCalled();
        expect(seam.providerSign).not.toHaveBeenCalled();
        expect(seam.storageSet).not.toHaveBeenCalled();
        expect(saved).toBeDefined();
        expect(client.AuthPrincipal).toBe(authKey.getPrincipal().toString());
    });
    it("keeps loading_user while a saved identity waits for the worker", async () => {
        await seedIdentity();
        const gate = deferred<ReturnType<typeof workerSuccess>>();
        seam.send.mockImplementation((request) =>
            request.kind === "setAuthIdentity" ? gate.promise : Promise.resolve(),
        );
        build();
        await vi.waitFor(() => expect(identityStateStore.value.kind).toBe("loading_user"));
        expect(authenticated()).toHaveLength(0);
        gate.resolve(workerSuccess());
        await vi.waitFor(() => expect(authenticated()).toHaveLength(1));
        expect(seam.providerSign).not.toHaveBeenCalled();
    });
    it.each(["error", "null", "undefined"] as const)(
        "preserves a saved sign-in and reports a generic failure when the initial profile lookup rejects (%s)",
        async (failure) => {
            await seedIdentity();
            const savedIdentity = new Map(seam.data);
            const privateMarker = "synthetic-private-profile-error";
            const error =
                failure === "error"
                    ? new Error(privateMarker)
                    : failure === "null"
                      ? null
                      : undefined;
            seam.stream.mockImplementationOnce((request) => {
                expect(request.kind).toBe("getCurrentUser");
                return new Stream<CreatedUser>((_resolve, reject) =>
                    queueMicrotask(() => reject(error)),
                );
            });
            build();

            await vi.waitFor(() => expect(startupErrorStore.value).toContain("load your account"));
            expect(startupErrorStore.value).toContain("Check your connection and reload");
            expect(startupErrorStore.value).not.toContain(privateMarker);
            expect(identityStateStore.value.kind).toBe("loading_user");
            expect(chatsInitialisedStore.value).toBe(false);
            expect(created).not.toHaveBeenCalled();
            expect(seam.data).toEqual(savedIdentity);
            expect(seam.storageRemove).not.toHaveBeenCalled();
            expect(seam.authLogout).not.toHaveBeenCalled();
            expect(seam.providerSign).not.toHaveBeenCalled();
        },
    );
    it("ignores a stale profile rejection after the same account has signed in successfully", async () => {
        await seedIdentity();
        let rejectInitialProfile: ((error: unknown) => void) | undefined;
        seam.stream.mockImplementationOnce((request) => {
            expect(request.kind).toBe("getCurrentUser");
            return new Stream<CreatedUser>((_resolve, reject) => {
                rejectInitialProfile = reject;
            });
        });
        build();
        await vi.waitFor(() => expect(rejectInitialProfile).toBeTypeOf("function"));
        const principal = client.AuthPrincipal;

        await client.signInWithAndroidWebAuthn();
        expect(client.AuthPrincipal).toBe(principal);
        expect(authenticated()).toEqual([[profile]]);
        expect(startupErrorStore.value).toBeUndefined();
        const savedIdentity = new Map(seam.data);

        rejectInitialProfile!(new Error("synthetic-stale-profile-error"));
        await vi.advanceTimersByTimeAsync(0);
        expect(startupErrorStore.value).toBeUndefined();
        expect(created).toHaveBeenCalledOnce();
        expect(currentUserStore.value).toEqual(profile);
        expect(seam.data).toEqual(savedIdentity);
        expect(seam.storageRemove).not.toHaveBeenCalled();
        expect(seam.authLogout).not.toHaveBeenCalled();
    });
    it("does not show a stale profile error or restore account state after an explicit logout", async () => {
        await seedIdentity();
        let rejectInitialProfile: ((error: unknown) => void) | undefined;
        seam.stream.mockImplementationOnce((request) => {
            expect(request.kind).toBe("getCurrentUser");
            return new Stream<CreatedUser>((_resolve, reject) => {
                rejectInitialProfile = reject;
            });
        });
        build();
        await vi.waitFor(() => expect(rejectInitialProfile).toBeTypeOf("function"));

        await client.logout();
        expect(seam.send).toHaveBeenCalledWith({ kind: "logout" });
        // Original logout ends the session by navigation. jsdom does not navigate;
        // the old profile continuation must leave that completed teardown untouched.
        const identityAfterLogout = identityStateStore.value;
        const callsAfterLogout = created.mock.calls.length;
        const storageAfterLogout = new Map(seam.data);
        const userAfterLogout = currentUserStore.value;
        rejectInitialProfile!(new Error("synthetic-profile-error-after-logout"));
        await vi.advanceTimersByTimeAsync(0);

        expect(startupErrorStore.value).toBeUndefined();
        expect(identityStateStore.value).toEqual(identityAfterLogout);
        expect(created).toHaveBeenCalledTimes(callsAfterLogout);
        expect(currentUserStore.value).toEqual(userAfterLogout);
        expect(seam.data).toEqual(storageAfterLogout);
        expect(seam.authLogout).toHaveBeenCalledOnce();
        expect(seam.providerSign).not.toHaveBeenCalled();
    });
    it("rejects an expired delegation through real IdentityStorage and starts anonymously", async () => {
        const expired = await DelegationChain.create(
            authKey,
            savedKey.getPublicKey(),
            new Date(NOW - 1),
        );
        await seedIdentity(expired);
        build();
        await boot();
        expect(seam.storageRemove).toHaveBeenCalledWith("auth-client-db/delegation");
        expect(authenticated()).toHaveLength(0);
        expect(identityStateStore.value.kind).toBe("anon");
        expect(seam.providerSign).not.toHaveBeenCalled();
    });
    it.each(["auth-client", "storage", "worker"])(
        "reports generic %s startup failures",
        async (failure) => {
            const error = new Error(`synthetic ${failure} failure`);
            if (failure === "auth-client") seam.authCreate.mockRejectedValue(error);
            if (failure === "storage") seam.storageGet.mockRejectedValue(error);
            if (failure === "worker") seam.send.mockRejectedValue(error);
            build();
            await vi.waitFor(() => expect(startupErrorStore.value).toContain("background worker"));
            expect(logger.error).toHaveBeenCalledWith("OpenChat background worker failed", error);
            expect(authenticated()).toHaveLength(0);
        },
    );
    it("retains the generic worker startup-failure callback", async () => {
        build();
        await boot();
        const error = new Error("synthetic worker startup failure");
        seam.workerFailure!(error);
        expect(logger.error).toHaveBeenCalledWith("OpenChat background worker failed", error);
        expect(startupErrorStore.value).toContain("background worker");
    });
    it("uses AuthClient login options and loads its saved identity on success", async () => {
        build();
        await boot();
        await seedIdentity();
        selectedAuthProviderStore.set(AuthProvider.II);
        client.login();
        await vi.waitFor(() => expect(seam.authLogin).toHaveBeenCalledOnce());
        const options = seam.authLogin.mock.calls[0][0];
        expect(options.maxTimeToLive).toBe(BigInt(THIRTY_DAYS) * 1_000_000n);
        expect(options.identityProvider).toBe("https://identity.example.invalid");
        await options.onSuccess();
        expect(authenticated()).toEqual([[profile]]);
        expect(seam.send).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "setAuthIdentity", isIIPrincipal: true }),
        );
    });
    it("routes AuthClient success-handler failures to the generic startup diagnostic", async () => {
        build();
        await boot();
        selectedAuthProviderStore.set(AuthProvider.II);
        client.login();
        await vi.waitFor(() => expect(seam.authLogin).toHaveBeenCalledOnce());
        seam.storageGet.mockRejectedValue(new Error("synthetic storage failure"));
        await seam.authLogin.mock.calls[0][0].onSuccess();
        expect(startupErrorStore.value).toContain("background worker");
    });
    it("allows original new-identity creation and registration instead of enforcing a special existing-account gate", async () => {
        build();
        await boot();
        seam.send.mockImplementation(async (request) => {
            if (request.kind === "lookupWebAuthnPubKey")
                return new Uint8Array(authKey.getPublicKey().toDer());
            if (request.kind === "setAuthIdentity") return { kind: "oc_identity_not_found" };
            if (request.kind === "createOpenChatIdentity") return workerSuccess();
            if (request.kind === "registerUser") return { kind: "success" };
        });
        seam.stream.mockImplementation(
            () =>
                new Stream((resolve) =>
                    queueMicrotask(() => resolve({ kind: "unknown_user" }, true)),
                ),
        );
        await client.signInWithAndroidWebAuthn();
        expect(seam.send).toHaveBeenCalledWith({
            kind: "createOpenChatIdentity",
            webAuthnCredentialId: Uint8Array.of(1, 2, 3),
        });
        expect(identityStateStore.value.kind).toBe("registering");
        await expect(client.registerUser("new-user", undefined)).resolves.toEqual({
            kind: "success",
        });
    });
    it.each(["android", "web"])(
        "preserves original %s signup and assumeIdentity=false behavior",
        async (provider) => {
            build();
            await boot();
            const result =
                provider === "android"
                    ? await client.signUpWithAndroidWebAuthn(false, "new-user")
                    : await client.signUpWithWebAuthn(false, "new-user");
            expect(result[1].delegations[0].delegation.expiration).toBe(
                BigInt(NOW + THIRTY_DAYS) * 1_000_000n,
            );
            expect(seam.storageSet).not.toHaveBeenCalled();
            expect(seam.send).not.toHaveBeenCalledWith(
                expect.objectContaining({ kind: "setAuthIdentity" }),
            );
            expect(authenticated()).toHaveLength(0);
        },
    );
    it("re-authenticates natively without persisting or replacing the active session", async () => {
        build();
        await boot();
        await client.signInWithAndroidWebAuthn();
        seam.order.length = 0;
        seam.storageSet.mockClear();
        seam.nativeConstruct.mockClear();
        seam.send.mockClear();
        const result = await client.reSignInWithCurrentWebAuthnIdentity();
        expect(result[1].delegations[0].delegation.expiration).toBe(
            BigInt(NOW + THIRTY_DAYS) * 1_000_000n,
        );
        expect(seam.nativeConstruct).toHaveBeenCalledWith(expect.any(Function));
        expect(seam.storageSet).not.toHaveBeenCalled();
        expect(seam.send).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: "setAuthIdentity" }),
        );
        expect(seam.order).toEqual([]);
    });
    it("links an existing account with the original native code/passkey pipeline", async () => {
        build();
        await boot();
        const defaultSend = seam.send.getMockImplementation()!;
        seam.send.mockImplementation(async (request) => {
            if (request.kind === "verifyAccountLinkingCode") {
                seam.order.push("verify-code");
                return { kind: "success", username: "synthetic-user" };
            }
            if (request.kind === "setCachedWebAuthnKey") seam.order.push("cache-passkey");
            if (request.kind === "finaliseAccountLinkingWithCode") seam.order.push("link-account");
            return defaultSend(request);
        });
        await client.linkAccountsWithAndroidWebAuthn("123456");
        expect(seam.nativeCreate).toHaveBeenCalledWith("synthetic-user", expect.any(Function));
        expect(seam.order).toEqual([
            "verify-code",
            "cache-passkey",
            "link-account",
            "persist",
            "worker-identity",
            "profile",
        ]);
        const verify = seam.send.mock.calls.find(
            ([request]) => request.kind === "verifyAccountLinkingCode",
        )![0];
        const finalize = seam.send.mock.calls.find(
            ([request]) => request.kind === "finaliseAccountLinkingWithCode",
        )![0];
        expect(verify.code).toBe("123456");
        expect(finalize.tempKey).toBe(verify.tempKey);
        expect(finalize.webAuthnKey).toEqual(
            expect.objectContaining({ origin: "oc.app", credentialId: Uint8Array.of(1, 2, 3) }),
        );
        expect(authenticated()).toEqual([[profile]]);
        expect(seam.webCreate).not.toHaveBeenCalled();
    });
    it("does not create a native passkey when the original linking code is rejected", async () => {
        build();
        await boot();
        const rejection = { kind: "error", code: 100, msg: "synthetic rejected linking code" };
        seam.send.mockResolvedValue(rejection);
        await expect(client.linkAccountsWithAndroidWebAuthn("123456")).rejects.toEqual(rejection);
        expect(seam.nativeCreate).not.toHaveBeenCalled();
        expect(seam.storageSet).not.toHaveBeenCalled();
        expect(authenticated()).toHaveLength(0);
    });
    it("does not persist or adopt an identity when the provider rejects sign-in", async () => {
        build();
        await boot();
        seam.providerSign.mockRejectedValue(new Error("synthetic provider cancellation"));
        await expect(client.signInWithAndroidWebAuthn()).rejects.toThrow("provider cancellation");
        expect(seam.storageSet).not.toHaveBeenCalled();
        expect(seam.send).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: "setAuthIdentity" }),
        );
        expect(authenticated()).toHaveLength(0);
    });
    it("does not adopt an identity when original persistence fails", async () => {
        build();
        await boot();
        seam.storageSet.mockRejectedValue(new Error("synthetic persistence failure"));
        await expect(client.signInWithAndroidWebAuthn()).rejects.toThrow("persistence failure");
        expect(seam.send).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: "setAuthIdentity" }),
        );
        expect(authenticated()).toHaveLength(0);
    });
    it("preserves original idempotent logout and both teardown paths", async () => {
        build();
        await boot();
        const first = client.logout();
        expect(client.logout()).toBe(first);
        await first;
        expect(seam.authLogout).toHaveBeenCalledOnce();
        expect(seam.send.mock.calls.filter(([request]) => request.kind === "logout")).toHaveLength(
            1,
        );
    });
    it.each([{ clientOnlyApps: false }, { icUrl: undefined }, { userIndexCanister: "" }])(
        "preserves private setup isolation for incomplete/official profiles (%j)",
        async (overrides) => {
            build(overrides);
            await boot();
            expect(client.privateAppStorageBackend()).toBeUndefined();
        },
    );
    it.each([
        ["https://icp-api.io", "aaaaa-aa"],
        ["http://127.0.0.1:8080", "aaaaa-aa"],
        ["https://icp-api.io", "2vxsx-fae"],
    ])(
        "binds private setup to gateway/account service (%s/%s)",
        async (icUrl, userIndexCanister) => {
            build({ icUrl, userIndexCanister });
            await boot();
            expect(client.privateAppStorageBackend()).toBe(
                JSON.stringify([icUrl, userIndexCanister]),
            );
        },
    );
    it("has no active browser bridge or custom native-session API in the client", () => {
        const source = readFileSync("openchat-client/src/openchat.ts", "utf8");
        expect(source).not.toMatch(
            /nativeBrowser|NativeBrowser|signInWithLocalBrowser|createBrowserAccountLinkFlow|retrySavedNativeSession|nativeSessionRestoreState|existingAccountOnly/,
        );
        expect(OpenChat.prototype).not.toHaveProperty("signInWithLocalBrowser");
        expect(OpenChat.prototype).not.toHaveProperty("createBrowserAccountLinkFlow");
        expect(OpenChat.prototype).not.toHaveProperty("retrySavedNativeSession");
    });
});
