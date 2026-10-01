// @vitest-environment node
// Exercises the actual worker message handlers with inert backend agents; no production requests.
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "@shared";

const backend = vi.hoisted(() => ({
    create: vi.fn(async () => "already_registered"),
    register: vi.fn(async () => ({ kind: "success" })),
    catalog: vi.fn(async () => ({ version: 1, models: [] })),
    sendMessage: vi.fn(async () => "success"),
    editMessage: vi.fn(async () => "success"),
    lookupMembers: vi.fn(async () => ({ kind: "success", members: [] })),
    searchCommunityMembers: vi.fn(async () => ({ kind: "success", members: [] })),
    searchUsers: vi.fn(async () => []),
    approveAccessGatePayment: vi.fn(async () => ({ kind: "success" })),
    userMigration: vi.fn(async () => ({ kind: "queued" })),
    log: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

vi.mock("@agent", () => ({
    IdentityAgent: {
        create: vi.fn(async () => ({
            checkOpenChatIdentityExists: async () => false,
            createOpenChatIdentity: backend.create,
        })),
    },
    OpenChatAgent: class {
        registerUser = backend.register;
        modelCatalog = backend.catalog;
        sendMessage = backend.sendMessage;
        editMessage = backend.editMessage;
        lookupMembers = backend.lookupMembers;
        searchCommunityMembers = backend.searchCommunityMembers;
        searchUsers = backend.searchUsers;
        approveAccessGatePayment = backend.approveAccessGatePayment;
        userMigration = backend.userMigration;
        dispose() {}
        addEventListener() {}
    },
    abortInFlightQueries: vi.fn(),
    getBotDefinition: vi.fn(),
    setCachedWebAuthnKey: vi.fn(),
    setCommunityReferral: vi.fn(),
}));

vi.mock("@shared", () => ({
    IdentityStorage: {
        createForOcIdentity: () => ({
            get: async () => undefined,
            set: vi.fn(),
            remove: vi.fn(),
        }),
    },
    buildIdentityFromJson: async () => ({
        getPrincipal: () => ({ toString: () => "synthetic-test" }),
    }),
    inititaliseLogger: () => backend.log,
    shouldReportError: () => false,
    shouldReportWorkerError: () => false,
    getSessionExpiryMs: vi.fn(),
    setMinLogLevel: vi.fn(),
    MessagesReadFromServer: class {},
    StorageUpdated: class {},
    Stream: class {},
    SyncHeadMoved: class {},
    UsersLoaded: class {},
}));

describe("existing-account-only worker boundary", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const posted = vi.fn();
    const network = vi.fn(() => {
        throw new Error("No network allowed in worker policy tests");
    });
    let correlationId = 0;

    async function send(payload: Record<string, unknown>) {
        const id = ++correlationId;
        handlers.get("message")!({ data: { ...payload, correlationId: id } });
        await vi.waitFor(() =>
            expect(posted.mock.calls.some(([reply]) => reply.correlationId === id)).toBe(true),
        );
        return posted.mock.calls.find(([reply]) => reply.correlationId === id)![0];
    }

    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("self", {
            addEventListener: (type: string, handler: (event: unknown) => void) =>
                handlers.set(type, handler),
        });
        vi.stubGlobal("postMessage", posted);
        vi.stubGlobal("fetch", network);
        await import("./worker");
    });

    beforeEach(() => {
        posted.mockClear();
        backend.create.mockClear();
        backend.register.mockClear();
        backend.catalog.mockClear();
        backend.sendMessage.mockClear();
        backend.editMessage.mockClear();
        backend.lookupMembers.mockClear();
        backend.searchCommunityMembers.mockClear();
        backend.searchUsers.mockClear();
        backend.approveAccessGatePayment.mockClear();
        backend.userMigration.mockClear();
    });

    afterAll(() => {
        expect(network).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("rejects identity creation and user registration before either backend method", async () => {
        await send({ kind: "init", existingAccountOnly: true });
        await send({ kind: "setAuthIdentity", identity: {} });
        for (const kind of ["createOpenChatIdentity", "registerUser"]) {
            const reply = await send({ kind, username: "unused" });
            expect(reply.kind).toBe("worker_error");
            expect(JSON.parse(reply.error)).toMatchObject({ code: "existing_account_required" });
        }
        expect(backend.create).not.toHaveBeenCalled();
        expect(backend.register).not.toHaveBeenCalled();
    });

    it.each([undefined, false])(
        "preserves official backend operations when policy is %s",
        async (existingAccountOnly) => {
            await send({ kind: "init", existingAccountOnly });
            await send({ kind: "setAuthIdentity", identity: {} });
            expect((await send({ kind: "createOpenChatIdentity" })).response).toBe(
                "already_registered",
            );
            expect((await send({ kind: "registerUser", username: "synthetic" })).response).toEqual({
                kind: "success",
            });
            expect(backend.create).toHaveBeenCalledOnce();
            expect(backend.register).toHaveBeenCalledOnce();
        },
    );

    it("blocks unsupported app methods and custom cards before backend dispatch without leaking payloads", async () => {
        await send({ kind: "init", clientOnlyApps: true });
        await send({ kind: "setAuthIdentity", identity: {} });
        const message = { content: { kind: "action_card_content", payload: "private-marker" } };
        for (const request of [
            { kind: "modelCatalog" },
            { kind: "sendMessage", event: { event: message } },
            { kind: "editMessage", msg: message },
        ]) {
            const reply = await send(request);
            expect(reply.kind).toBe("worker_error");
            expect(JSON.parse(reply.error)).toMatchObject({ code: "client_only_app_request" });
            expect(JSON.stringify(reply)).not.toContain("private-marker");
        }
        expect(backend.catalog).not.toHaveBeenCalled();
        expect(backend.sendMessage).not.toHaveBeenCalled();
        expect(backend.editMessage).not.toHaveBeenCalled();
    });

    it("continues dispatching ordinary chat text in client-only mode", async () => {
        await send({ kind: "init", clientOnlyApps: true });
        await send({ kind: "setAuthIdentity", identity: {} });
        const message = { content: { kind: "text_content", text: "synthetic" } };
        expect((await send({ kind: "sendMessage", event: { event: message } })).response).toBe(
            "success",
        );
        expect((await send({ kind: "editMessage", msg: message })).response).toBe("success");
        expect(backend.sendMessage).toHaveBeenCalledOnce();
        expect(backend.editMessage).toHaveBeenCalledOnce();
    });

    it("forwards merged member, paging, payment and migration requests without relaxing card denial", async () => {
        await send({ kind: "init", clientOnlyApps: true });
        await send({ kind: "setAuthIdentity", identity: {} });
        const chatId = { kind: "group_chat", groupId: "synthetic-group" } as const;
        const communityId = { kind: "community", communityId: "synthetic-community" } as const;
        const cases = [
            {
                request: {
                    kind: "userMigration",
                    userId: "synthetic-migrating-user",
                } satisfies WorkerRequest,
                method: backend.userMigration,
                arguments: ["synthetic-migrating-user"],
                response: { kind: "queued" },
            },
            {
                request: {
                    kind: "lookupMembers",
                    id: chatId,
                    userIds: ["synthetic-member-a", "synthetic-member-b"],
                    latestKnownUpdate: 99n,
                } satisfies WorkerRequest,
                method: backend.lookupMembers,
                arguments: [chatId, ["synthetic-member-a", "synthetic-member-b"], 99n],
                response: { kind: "success", members: [] },
            },
            {
                request: {
                    kind: "searchCommunityMembers",
                    id: communityId,
                    searchTerm: "synthetic member",
                    maxResults: 17,
                    latestKnownUpdate: 101n,
                } satisfies WorkerRequest,
                method: backend.searchCommunityMembers,
                arguments: [communityId, "synthetic member", 17, 101n],
                response: { kind: "success", members: [] },
            },
            {
                request: {
                    kind: "searchUsers",
                    searchTerm: "synthetic user",
                    maxResults: 23,
                    pageIndex: 2,
                } satisfies WorkerRequest,
                method: backend.searchUsers,
                arguments: ["synthetic user", 23, 2],
                response: [],
            },
            {
                request: {
                    kind: "approveAccessGatePayment",
                    canisterId: "synthetic-gate",
                    ledger: "synthetic-ledger",
                    amount: 123n,
                    expiresIn: 456n,
                    pin: undefined,
                } satisfies WorkerRequest,
                method: backend.approveAccessGatePayment,
                arguments: ["synthetic-gate", "synthetic-ledger", 123n, 456n, undefined],
                response: { kind: "success" },
            },
        ];
        for (const item of cases) {
            const reply = await send(item.request);
            expect(reply.kind).toBe("worker_response");
            expect(reply.response).toEqual(item.response);
            expect(item.method).toHaveBeenCalledExactlyOnceWith(...item.arguments);
        }

        // New official requests must not alter the client-only policy for later app requests.
        const message = {
            content: { kind: "action_card_content", payload: "private-marker-after-members" },
        };
        for (const request of [
            { kind: "modelCatalog" },
            { kind: "sendMessage", event: { event: message } },
            { kind: "editMessage", msg: message },
        ]) {
            const reply = await send(request);
            expect(reply.kind).toBe("worker_error");
            expect(JSON.parse(reply.error)).toMatchObject({ code: "client_only_app_request" });
            expect(JSON.stringify(reply)).not.toContain("private-marker-after-members");
        }
        expect(backend.catalog).not.toHaveBeenCalled();
        expect(backend.sendMessage).not.toHaveBeenCalled();
        expect(backend.editMessage).not.toHaveBeenCalled();
    });
});
