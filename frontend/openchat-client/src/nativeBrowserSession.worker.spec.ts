// @vitest-environment node
// Actual worker handlers and structural validator. No real passkeys, certificates, accounts,
// network or storage: only root's separate verified browser flow may authorize this transport.
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeSessionFixture, nativeTestPolicy } from "@shared/utils/nativeBrowserSession.fixture";

const backend = vi.hoisted(() => ({
    get: vi.fn(async () => undefined),
    set: vi.fn(),
    remove: vi.fn(async () => {}),
    create: vi.fn(),
    constructed: vi.fn(),
    exists: vi.fn(async () => false),
    mint: vi.fn(),
    register: vi.fn(),
    check: vi.fn(async () => ({ kind: "success", webAuthnKey: { synthetic: true } })),
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
        dispose() {}
    },
    abortInFlightQueries: vi.fn(),
    getBotDefinition: vi.fn(),
    setCachedWebAuthnKey: vi.fn(),
    setCommunityReferral: vi.fn(),
}));

describe("ephemeral native-session worker adoption", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const posted = vi.fn();
    const network = vi.fn(() => {
        throw new Error("Network forbidden in native adoption tests");
    });
    let fixture: Awaited<ReturnType<typeof nativeSessionFixture>>;
    let correlation = 0;
    const identityAgent = () => ({
        checkOpenChatIdentityExists: backend.exists,
        getOpenChatIdentity: backend.mint,
        createOpenChatIdentity: backend.register,
        checkAuthPrincipal: backend.check,
    });
    const request = () => structuredClone(fixture.request);
    function dispatch(payload: Record<string, unknown>) {
        const correlationId = ++correlation;
        handlers.get("message")!({ data: structuredClone({ ...payload, correlationId }) });
        return correlationId;
    }
    async function reply(correlationId: number) {
        await vi.waitFor(() =>
            expect(posted.mock.calls.some(([r]) => r.correlationId === correlationId)).toBe(true),
        );
        return posted.mock.calls.find(([r]) => r.correlationId === correlationId)![0];
    }
    const send = (payload: Record<string, unknown>) => reply(dispatch(payload));
    const init = (flags = { existingAccountOnly: true, clientOnlyApps: true }) =>
        send({
            kind: "init",
            ...flags,
            identityCanister: nativeTestPolicy.identityCanister,
            icUrl: "https://synthetic.invalid",
        });
    const anon = () => send({ kind: "setAuthIdentity", identity: undefined, isIIPrincipal: false });
    const expectNoCacheOrMint = () => {
        expect(backend.get).not.toHaveBeenCalled();
        expect(backend.set).not.toHaveBeenCalled();
        expect(backend.exists).not.toHaveBeenCalled();
        expect(backend.mint).not.toHaveBeenCalled();
        expect(backend.register).not.toHaveBeenCalled();
    };

    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("self", {
            addEventListener: (type: string, handler: (event: unknown) => void) =>
                handlers.set(type, handler),
        });
        vi.stubGlobal("postMessage", (value: unknown) => posted(structuredClone(value)));
        fixture = await nativeSessionFixture(Date.now());
        await import("@worker");
    });
    beforeEach(async () => {
        for (const mock of Object.values(backend)) if (vi.isMockFunction(mock)) mock.mockClear();
        backend.create.mockReset().mockImplementation(async () => identityAgent());
        posted.mockClear();
        network.mockClear();
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        await init();
        await anon();
        backend.constructed.mockClear();
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
    afterAll(() => vi.unstubAllGlobals());

    it("adopts exactly the supplied session without lookup, cache, minting or registration", async () => {
        const result = await send(request());
        expect(result).toMatchObject({
            kind: "worker_response",
            response: {
                kind: "success",
                ocIdentityPrincipal: fixture.ocKey.getPrincipal().toString(),
                ocIdentityExpiry: fixture.request.nativeBrowserSession.expiresAtMs,
            },
        });
        expect(backend.create).toHaveBeenCalledOnce();
        expect(backend.create.mock.calls[0][0].getPrincipal().toString()).toBe(
            fixture.authKey.getPrincipal().toString(),
        );
        expect(backend.constructed).toHaveBeenCalledExactlyOnceWith(
            fixture.ocKey.getPrincipal().toString(),
            fixture.authKey.getPrincipal().toString(),
        );
        expectNoCacheOrMint();
        expect(backend.remove).not.toHaveBeenCalled();
    });
    it.each([
        { existingAccountOnly: false, clientOnlyApps: true },
        { existingAccountOnly: true, clientOnlyApps: false },
        { existingAccountOnly: false, clientOnlyApps: false },
    ])("rejects adoption outside the explicit unofficial mode: %j", async (flags) => {
        await init(flags);
        const result = await send(request());
        expect(result.kind).toBe("worker_error");
        expect(JSON.parse(result.error)).toMatchObject({ code: "invalid_native_browser_session" });
        expect(backend.create).not.toHaveBeenCalled();
        expectNoCacheOrMint();
    });
    it("keeps the default official identity lookup path when no native session is supplied", async () => {
        await init({ existingAccountOnly: false, clientOnlyApps: false });
        const r = request();
        expect(
            await send({ kind: r.kind, identity: r.identity, isIIPrincipal: false }),
        ).toMatchObject({
            kind: "worker_response",
            response: { kind: "oc_identity_not_found" },
        });
        expect(backend.get).toHaveBeenCalledOnce();
        expect(backend.exists).toHaveBeenCalledOnce();
        expect(backend.register).not.toHaveBeenCalled();
    });
    it("clears the previous identity agent on anonymous reset", async () => {
        expect(await send(request())).toMatchObject({ response: { kind: "success" } });
        await anon();
        expect(await send({ kind: "currentUserWebAuthnKey" })).toMatchObject({
            kind: "worker_response",
            response: undefined,
        });
        expect(backend.check).not.toHaveBeenCalled();
        expectNoCacheOrMint();
    });
    it.each(["anon", "logout"] as const)(
        "does not resurrect a pending adoption after %s",
        async (reset) => {
            let release!: (value: ReturnType<typeof identityAgent>) => void;
            backend.create.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const pending = dispatch(request());
            await vi.waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
            if (reset === "anon") await anon();
            else await send({ kind: "logout" });
            backend.constructed.mockClear();
            release(identityAgent());
            const result = await reply(pending);
            expect(result.kind).toBe("worker_error");
            expect(JSON.parse(result.error)).toMatchObject({
                code: "invalid_native_browser_session",
            });
            expect(backend.constructed).not.toHaveBeenCalled();
            expectNoCacheOrMint();
        },
    );
    it("stops before identity-agent setup when anonymous reset supersedes key restoration", async () => {
        const publicKey = await crypto.subtle.exportKey(
            "spki",
            fixture.authKey.getKeyPair().publicKey,
        );
        let release!: () => void;
        vi.spyOn(crypto.subtle, "exportKey").mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(publicKey);
                }) as never,
        );
        const pending = dispatch(request());
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        await anon();
        backend.constructed.mockClear();
        release();
        expect(await reply(pending)).toMatchObject({ kind: "worker_error" });
        expect(backend.create).not.toHaveBeenCalled();
        expect(backend.constructed).not.toHaveBeenCalled();
        expectNoCacheOrMint();
    });
    it("rechecks expiry after asynchronous identity-agent setup", async () => {
        let release!: (value: ReturnType<typeof identityAgent>) => void;
        backend.create.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const pending = dispatch(request());
        await vi.waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
        vi.spyOn(Date, "now").mockReturnValue(fixture.request.nativeBrowserSession.expiresAtMs);
        release(identityAgent());
        expect(await reply(pending)).toMatchObject({ kind: "worker_error" });
        expect(backend.constructed).not.toHaveBeenCalled();
        expectNoCacheOrMint();
    });
});
