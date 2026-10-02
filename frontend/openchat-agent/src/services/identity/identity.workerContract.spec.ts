// @vitest-environment node
// Actual worker -> IdentityAgent -> IdentityClient -> codec/schema/mappers. Only transport,
// persistence, logging and unrelated OpenChatAgent behavior are inert. No real passkey/login.
import { webcrypto } from "node:crypto";
import { DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    syntheticIdentityTransport,
    TEST_CANISTER,
    TEST_CREDENTIAL_ID,
    TEST_EXPIRATION,
    TEST_PUBLIC_KEY,
} from "./identity.fullClient.fixture";

const seam = vi.hoisted(() => ({
    transport: undefined as ReturnType<typeof syntheticIdentityTransport> | undefined,
    saved: vi.fn(),
    cachedKey: vi.fn(async () => undefined),
    constructed: vi.fn(),
    logger: { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@agent/utils/httpAgent", () => ({
    createHttpAgent: async () => seam.transport!.agent,
}));
vi.mock("@agent/utils/webAuthnKeyCache", () => ({ getCachedWebAuthnKey: seam.cachedKey }));
vi.mock("@shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@shared")>()),
    IdentityStorage: {
        createForOcIdentity: () => ({
            get: async () => undefined,
            set: seam.saved,
            remove: vi.fn(),
        }),
    },
    inititaliseLogger: () => seam.logger,
}));
vi.mock("@agent", async () => {
    const { IdentityAgent } = await import("@agent/services/identityAgent");
    const { UserIndexClient } = await import("@agent/services/userIndex/userIndex.client");
    return {
        IdentityAgent,
        OpenChatAgent: class {
            client: InstanceType<typeof UserIndexClient>;
            constructor(identity: ConstructorParameters<typeof UserIndexClient>[0]) {
                seam.constructed(identity.getPrincipal().toString());
                this.client = new UserIndexClient(
                    identity,
                    seam.transport!.agent,
                    TEST_CANISTER,
                    "",
                    {
                        getCachedCurrentUser: async () => undefined,
                        setCachedCurrentUser: async () => {},
                    } as never,
                    {} as never,
                );
            }
            getCurrentUser() {
                return this.client.getCurrentUser();
            }
            dispose() {}
            addEventListener() {}
        },
        abortInFlightQueries: vi.fn(),
        getBotDefinition: vi.fn(),
        setCachedWebAuthnKey: vi.fn(),
        setCommunityReferral: vi.fn(),
    };
});

describe("full-client identity worker integration (synthetic only)", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const posted = vi.fn();
    const network = vi.fn(() => {
        throw new Error("Network forbidden in worker identity tests");
    });
    let correlation = 0;
    let authIdentity: { key: CryptoKeyPair; delegation: ReturnType<DelegationChain["toJSON"]> };

    async function send(payload: Record<string, unknown>) {
        const correlationId = ++correlation;
        // Structured cloning is intentional: real browser workers cannot receive identity class instances.
        handlers.get("message")!({ data: structuredClone({ ...payload, correlationId }) });
        await vi.waitFor(() =>
            expect(posted.mock.calls.some(([r]) => r.correlationId === correlationId)).toBe(true),
        );
        return posted.mock.calls.find(([r]) => r.correlationId === correlationId)![0];
    }
    const signIn = () =>
        send({ kind: "setAuthIdentity", identity: authIdentity, isIIPrincipal: false });
    const methods = () => seam.transport!.calls.map((c) => c.method);

    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("navigator", { onLine: true });
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("self", {
            addEventListener: (type: string, handler: (event: unknown) => void) =>
                handlers.set(type, handler),
        });
        vi.stubGlobal("postMessage", (value: unknown) => posted(structuredClone(value)));
        const authentication = await ECDSAKeyIdentity.generate();
        const session = await ECDSAKeyIdentity.generate();
        const delegation = await DelegationChain.create(
            authentication,
            session.getPublicKey(),
            new Date(Date.now() + 300_000),
        );
        authIdentity = { key: session.getKeyPair(), delegation: delegation.toJSON() };
        await import("@worker");
    });
    beforeEach(async () => {
        posted.mockClear();
        seam.saved.mockClear();
        seam.constructed.mockClear();
        seam.cachedKey.mockClear();
        network.mockClear();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        seam.transport = syntheticIdentityTransport();
        await send({
            kind: "init",
            identityCanister: TEST_CANISTER,
            userIndexCanister: TEST_CANISTER,
            icUrl: "https://synthetic.invalid",
            existingAccountOnly: true,
            clientOnlyApps: true,
        });
        await send({ kind: "setAuthIdentity", identity: undefined, isIIPrincipal: false });
        seam.constructed.mockClear();
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        expect(
            methods().every((method) =>
                [
                    "lookup_webauthn_pubkey_msgpack",
                    "check_auth_principal_v2_msgpack",
                    "prepare_delegation_msgpack",
                    "get_delegation_msgpack",
                    "current_user_msgpack",
                ].includes(method),
            ),
        ).toBe(true);
        vi.restoreAllMocks();
    });
    afterAll(() => vi.unstubAllGlobals());

    it("looks up an uncached credential and opens a synthetic account through the typed worker flow", async () => {
        const lookup = await send({
            kind: "lookupWebAuthnPubKey",
            credentialId: TEST_CREDENTIAL_ID,
        });
        expect(lookup).toMatchObject({ kind: "worker_response", response: TEST_PUBLIC_KEY });
        expect(seam.cachedKey).toHaveBeenCalledWith(TEST_CREDENTIAL_ID);
        expect(await signIn()).toMatchObject({
            kind: "worker_response",
            response: { kind: "success" },
        });
        expect(seam.saved).toHaveBeenCalledOnce();
        expect(await send({ kind: "getCurrentUser" })).toMatchObject({
            kind: "worker_response",
            final: true,
            response: { kind: "created_user", username: "synthetic-user" },
        });
        expect(methods()).toEqual([
            "lookup_webauthn_pubkey_msgpack",
            "check_auth_principal_v2_msgpack",
            "prepare_delegation_msgpack",
            "get_delegation_msgpack",
            "current_user_msgpack",
        ]);
    });

    it("preserves a typed schema error across the worker JSON boundary, without constructing an account", async () => {
        seam.transport!.replies.set("lookup_webauthn_pubkey_msgpack", {
            Success: { pubkey: "invalid" },
        });
        const lookup = await send({
            kind: "lookupWebAuthnPubKey",
            credentialId: TEST_CREDENTIAL_ID,
        });
        expect(lookup.kind).toBe("worker_error");
        expect(JSON.parse(lookup.error)).toMatchObject({ name: "TypeboxValidationError" });
        expect(seam.saved).not.toHaveBeenCalled();
        expect(seam.constructed).not.toHaveBeenCalled();
        expect(seam.transport!.call).not.toHaveBeenCalled();
    });

    it("does not persist a delegation when the probe-shaped prepare reply lacks a required field", async () => {
        seam.transport!.replies.set("prepare_delegation_msgpack", {
            Success: {
                user_key: TEST_PUBLIC_KEY,
                expiration: TEST_EXPIRATION,
            },
        });
        const result = await signIn();
        expect(result.kind).toBe("worker_error");
        expect(JSON.parse(result.error)).toMatchObject({ name: "TypeboxValidationError" });
        expect(methods()).toEqual([
            "check_auth_principal_v2_msgpack",
            "prepare_delegation_msgpack",
        ]);
        expect(seam.saved).not.toHaveBeenCalled();
        expect(seam.constructed).not.toHaveBeenCalled();
    });

    it("requires the complete current_user schema even after delegation succeeded", async () => {
        expect(await signIn()).toMatchObject({ response: { kind: "success" } });
        seam.transport!.replies.set("current_user_msgpack", {
            Success: { user_id: Uint8Array.of(4), username: "synthetic-user" },
        });
        const result = await send({ kind: "getCurrentUser" });
        expect(result.kind).toBe("worker_error");
        expect(JSON.parse(result.error)).toMatchObject({ name: "TypeboxValidationError" });
    });

    it("settles an offline current-user cache miss with an error after identity startup succeeds", async () => {
        expect(await signIn()).toMatchObject({ response: { kind: "success" } });
        const callsBeforeProfile = methods();
        // The real UserIndexClient above has no cached current user. Going offline must
        // not silently leave the real worker request pending or invent an anonymous user.
        vi.stubGlobal("navigator", { onLine: false });
        try {
            const result = await send({ kind: "getCurrentUser" });
            expect(result).toMatchObject({
                kind: "worker_error",
                requestKind: "getCurrentUser",
            });
            expect(JSON.parse(result.error)).toMatchObject({
                message: "Current user is unavailable offline without a cached profile",
            });
            expect(methods()).toEqual(callsBeforeProfile);
        } finally {
            vi.stubGlobal("navigator", { onLine: true });
        }
    });

    it("does not create an account when the authentication principal is not linked", async () => {
        seam.transport!.replies.set("check_auth_principal_v2_msgpack", "NotFound");
        expect(await signIn()).toMatchObject({
            kind: "worker_response",
            response: { kind: "oc_identity_not_found" },
        });
        expect(methods()).toEqual(["check_auth_principal_v2_msgpack"]);
        expect(seam.transport!.call).not.toHaveBeenCalled();
        expect(seam.saved).not.toHaveBeenCalled();
        expect(await send({ kind: "createOpenChatIdentity" })).toMatchObject({
            kind: "worker_error",
        });
        expect(seam.transport!.call).not.toHaveBeenCalled();
    });
});
