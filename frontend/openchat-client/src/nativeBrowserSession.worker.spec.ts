// @vitest-environment node
// Real worker handlers, local test identities, and mocked backend/storage.
// No browser transport, passkey ceremony, network, account creation, or deployment.
import { webcrypto } from "node:crypto";
import { DelegationChain, DelegationIdentity, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import type { SetAuthIdentity } from "@shared";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from "vitest";

const backend = vi.hoisted(() => ({
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    constructed: vi.fn(),
    disposed: vi.fn(),
    exists: vi.fn(),
    mint: vi.fn(),
    register: vi.fn(),
    verifyCode: vi.fn(),
    finaliseCode: vi.fn(),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@shared")>()),
    IdentityStorage: {
        createForOcIdentity: () => ({ get: backend.get, set: backend.set, remove: backend.remove }),
    },
    inititaliseLogger: () => backend.logger,
}));
vi.mock("@agent", () => ({
    IdentityAgent: { create: backend.create },
    OpenChatAgent: class {
        constructor(identity: { getPrincipal(): { toString(): string } }, authPrincipal: string) {
            backend.constructed(identity.getPrincipal().toString(), authPrincipal);
        }
        addEventListener() {}
        dispose() {
            backend.disposed();
        }
    },
    abortInFlightQueries: vi.fn(),
    getBotDefinition: vi.fn(),
    setCachedWebAuthnKey: vi.fn(),
    setCommunityReferral: vi.fn(),
}));

describe("original worker auth bootstrap and identity refresh", () => {
    const identityCanister = "aaaaa-aa";
    const icUrl = "https://synthetic.invalid";
    const expiresAtMs = Date.now() + 300_000;
    const anonymousPrincipal = "2vxsx-fae";
    const handlers = new Map<string, (event: unknown) => void>();
    const posted = vi.fn();
    const network = vi.fn(() => {
        throw new Error("Network forbidden in worker auth tests");
    });
    let auth: Awaited<ReturnType<typeof session>>;
    let cached: Awaited<ReturnType<typeof session>>;
    let supplied: Awaited<ReturnType<typeof session>>;
    let correlation = 0;

    async function session(key?: ECDSAKeyIdentity) {
        const root = await ECDSAKeyIdentity.generate();
        key ??= await ECDSAKeyIdentity.generate();
        const chain = await DelegationChain.create(root, key.getPublicKey(), new Date(expiresAtMs));
        const identity = DelegationIdentity.fromDelegation(key, chain);
        return {
            key,
            chain,
            identity,
            principal: identity.getPrincipal().toString(),
            json: { key: key.getKeyPair(), delegation: chain.toJSON() },
        };
    }
    const identityAgent = () => ({
        checkOpenChatIdentityExists: backend.exists,
        getOpenChatIdentity: backend.mint,
        createOpenChatIdentity: backend.register,
        verifyAccountLinkingCode: backend.verifyCode,
        finaliseAccountLinkingWithCode: backend.finaliseCode,
    });
    async function send(payload: Record<string, unknown>) {
        const correlationId = ++correlation;
        handlers.get("message")!({ data: structuredClone({ ...payload, correlationId }) });
        await vi.waitFor(() =>
            expect(posted.mock.calls.some(([r]) => r.correlationId === correlationId)).toBe(true),
        );
        return posted.mock.calls.find(([r]) => r.correlationId === correlationId)![0];
    }
    const init = (existingAccountOnly = false) =>
        send({ kind: "init", existingAccountOnly, clientOnlyApps: true, identityCanister, icUrl });
    const anon = () => send({ kind: "setAuthIdentity", identity: undefined, isIIPrincipal: false });
    const request = (isIIPrincipal = false): SetAuthIdentity => ({
        kind: "setAuthIdentity",
        identity: auth.json,
        isIIPrincipal,
    });
    const success = (principal: string) => ({
        kind: "worker_response",
        response: {
            kind: "success",
            ocIdentityPrincipal: principal,
            ocIdentityExpiry: expiresAtMs,
        },
    });
    const expectOriginalAgent = (principal: string, isIIPrincipal = false) => {
        expect(backend.create).toHaveBeenCalledOnce();
        const [identity, ...options] = backend.create.mock.calls[0];
        expect(identity.getPrincipal().toString()).toBe(principal);
        expect(options).toEqual([identityCanister, icUrl, isIIPrincipal]);
    };

    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("self", {
            addEventListener: (type: string, handler: (event: unknown) => void) =>
                handlers.set(type, handler),
        });
        vi.stubGlobal("postMessage", (value: unknown) => posted(structuredClone(value)));
        [auth, cached, supplied] = await Promise.all([session(), session(), session()]);
        await import("@worker");
    });
    beforeEach(async () => {
        for (const mock of Object.values(backend)) if (vi.isMockFunction(mock)) mock.mockReset();
        backend.create.mockImplementation(async () => identityAgent());
        backend.get.mockResolvedValue(undefined);
        backend.set.mockResolvedValue(undefined);
        backend.remove.mockResolvedValue(undefined);
        backend.exists.mockResolvedValue(false);
        backend.mint.mockResolvedValue(undefined);
        posted.mockClear();
        network.mockClear();
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        await init();
        await anon();
        backend.constructed.mockClear();
        backend.disposed.mockClear();
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        expect(backend.register).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
    afterAll(() => vi.unstubAllGlobals());

    it("has only the original auth identity fields in the typed worker protocol", () => {
        expectTypeOf<keyof SetAuthIdentity>().toEqualTypeOf<
            "kind" | "identity" | "isIIPrincipal"
        >();
    });
    it("bootstraps an anonymous agent without identity lookup or delegation minting", async () => {
        expect(await anon()).toMatchObject({ response: { kind: "auth_identity_not_found" } });
        expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(anonymousPrincipal, "");
        for (const mock of [backend.create, backend.get, backend.exists, backend.mint, backend.set])
            expect(mock).not.toHaveBeenCalled();
    });
    it.each([false, true])(
        "loads cached OC identity for the auth principal (II=%s)",
        async (ii) => {
            backend.get.mockResolvedValueOnce(cached.identity);
            expect(await send(request(ii))).toMatchObject(success(cached.principal));
            expectOriginalAgent(auth.principal, ii);
            expect(backend.get).toHaveBeenCalledExactlyOnceWith(auth.principal);
            expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(
                cached.principal,
                auth.principal,
            );
            for (const mock of [backend.exists, backend.mint, backend.set])
                expect(mock).not.toHaveBeenCalled();
        },
    );
    it("looks up a missing cached identity without creating an account", async () => {
        expect(await send(request())).toMatchObject({
            response: { kind: "oc_identity_not_found" },
        });
        expectOriginalAgent(auth.principal);
        expect(backend.get).toHaveBeenCalledExactlyOnceWith(auth.principal);
        expect(backend.exists).toHaveBeenCalledOnce();
        expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(
            anonymousPrincipal,
            auth.principal,
        );
        expect(backend.mint).not.toHaveBeenCalled();
        expect(backend.set).not.toHaveBeenCalled();
    });
    it("refreshes an existing identity with a new session key and persists its delegation", async () => {
        let refreshed!: Awaited<ReturnType<typeof session>>;
        backend.exists.mockResolvedValueOnce(true);
        backend.mint.mockImplementationOnce(async (key: ECDSAKeyIdentity) => {
            refreshed = await session(key);
            return { identity: refreshed.identity };
        });
        const result = await send(request());
        expect(result).toMatchObject(success(refreshed.principal));
        expectOriginalAgent(auth.principal);
        const key = backend.mint.mock.calls[0][0];
        expect(key).toBeInstanceOf(ECDSAKeyIdentity);
        expect(key.getPrincipal().toString()).not.toBe(auth.key.getPrincipal().toString());
        expect(backend.set).toHaveBeenCalledExactlyOnceWith(key, refreshed.chain, auth.principal);
        expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(
            refreshed.principal,
            auth.principal,
        );
    });
    it.each([undefined, { identity: "delegation_not_found" }])(
        "leaves identity unavailable when refresh returns %j",
        async (result) => {
            backend.exists.mockResolvedValueOnce(true);
            backend.mint.mockResolvedValueOnce(result);
            expect(await send(request())).toMatchObject({
                response: { kind: "oc_identity_not_found" },
            });
            expect(backend.mint).toHaveBeenCalledOnce();
            expect(backend.set).not.toHaveBeenCalled();
        },
    );
    it.each(["get", "exists", "mint", "set"] as const)(
        "reports %s failures without constructing a replacement agent",
        async (stage) => {
            backend.exists.mockResolvedValue(true);
            backend.mint.mockResolvedValue({ identity: cached.identity });
            backend[stage].mockRejectedValueOnce(new Error("synthetic " + stage + " failure"));
            expect(await send(request())).toMatchObject({
                kind: "worker_error",
                requestKind: "setAuthIdentity",
            });
            expect(backend.constructed).not.toHaveBeenCalled();
        },
    );
    it("reinitializes storage lookup and disposes the old agent when auth identity changes", async () => {
        backend.get.mockResolvedValueOnce(cached.identity).mockResolvedValueOnce(supplied.identity);
        expect(await send(request())).toMatchObject(success(cached.principal));
        expect(await send({ ...request(), identity: supplied.json })).toMatchObject(
            success(supplied.principal),
        );
        expect(backend.get.mock.calls).toEqual([[auth.principal], [supplied.principal]]);
        expect(backend.constructed.mock.calls).toEqual([
            [cached.principal, auth.principal],
            [supplied.principal, supplied.principal],
        ]);
        expect(backend.create).toHaveBeenCalledTimes(2);
        expect(backend.disposed).toHaveBeenCalledTimes(2);
    });
    it("removes persisted OC identity and disposes the active agent on logout", async () => {
        backend.get.mockResolvedValueOnce(cached.identity);
        await send(request());
        backend.disposed.mockClear();
        expect(await send({ kind: "logout" })).toMatchObject({
            kind: "worker_response",
            response: undefined,
        });
        expect(backend.remove).toHaveBeenCalledOnce();
        expect(backend.disposed).toHaveBeenCalledOnce();
        expect(await send({ kind: "getCurrentUser" })).toMatchObject({ kind: "worker_error" });
        expect(await anon()).toMatchObject({ response: { kind: "auth_identity_not_found" } });
        expect(backend.constructed).toHaveBeenLastCalledWith(anonymousPrincipal, "");
    });
    it.each([false, true])(
        "does not adopt an obsolete supplied OC session (legacy policy=%s)",
        async (legacyPolicy) => {
            await init(legacyPolicy);
            backend.get.mockResolvedValueOnce(cached.identity);
            const result = await send({
                ...request(),
                nativeBrowserSession: { ocIdentity: supplied.json, expiresAtMs },
            });
            expect(result).toMatchObject(success(cached.principal));
            expect(backend.get).toHaveBeenCalledExactlyOnceWith(auth.principal);
            expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(
                cached.principal,
                auth.principal,
            );
            expect(cached.principal).not.toBe(supplied.principal);
        },
    );
    it("ignores a malformed extra session field and still requires original identity lookup", async () => {
        expect(
            await send({ ...request(), nativeBrowserSession: { arbitrary: "untrusted" } }),
        ).toMatchObject({ response: { kind: "oc_identity_not_found" } });
        expect(backend.exists).toHaveBeenCalledOnce();
        expect(backend.mint).not.toHaveBeenCalled();
    });
    it("cannot bootstrap a supplied OC session without an auth identity", async () => {
        expect(
            await send({
                kind: "setAuthIdentity",
                identity: undefined,
                isIIPrincipal: false,
                nativeBrowserSession: { ocIdentity: supplied.json, expiresAtMs },
            }),
        ).toMatchObject({ response: { kind: "auth_identity_not_found" } });
        expect(backend.create).not.toHaveBeenCalled();
        expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(anonymousPrincipal, "");
    });
    it("verifies a user-selected linking code through the original identity-agent options", async () => {
        await init(true);
        backend.verifyCode.mockResolvedValueOnce({ kind: "success" });
        expect(
            await send({
                kind: "verifyAccountLinkingCode",
                code: "123456",
                tempKey: auth.key.getKeyPair(),
            }),
        ).toMatchObject({ response: { kind: "success" } });
        expectOriginalAgent(auth.key.getPrincipal().toString());
        expect(backend.verifyCode).toHaveBeenCalledExactlyOnceWith("123456");
        expect(backend.set).not.toHaveBeenCalled();
    });
    it("finalizes linking through original options and persists the returned delegation", async () => {
        await init(true);
        backend.finaliseCode.mockResolvedValueOnce(cached.identity);
        const publicKey = new Uint8Array([1, 2, 3]);
        expect(
            await send({
                kind: "finaliseAccountLinkingWithCode",
                tempKey: auth.key.getKeyPair(),
                principal: cached.principal,
                publicKey,
                webAuthnKey: undefined,
            }),
        ).toMatchObject({ response: { kind: "success" } });
        expectOriginalAgent(auth.key.getPrincipal().toString());
        const key = backend.create.mock.calls[0][0];
        expect(backend.finaliseCode).toHaveBeenCalledExactlyOnceWith(
            cached.principal,
            publicKey,
            key,
            undefined,
        );
        expect(backend.set).toHaveBeenCalledExactlyOnceWith(
            key,
            cached.chain,
            auth.key.getPrincipal().toString(),
        );
    });
});
