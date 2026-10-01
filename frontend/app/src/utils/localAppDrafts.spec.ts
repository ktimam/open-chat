import { describe, expect, it, vi } from "vitest";
import {
    LocalAppDraftStore,
    type LocalDraftDelivery,
    type LocalDraftInput,
    type LocalDraftSchema,
    type LocalDraftTarget,
} from "./localAppDrafts";

const target: LocalDraftTarget = {
    appId: "example-app",
    actionId: "save-item",
    destination: "https://example.invalid/import",
    recipient: "example-recipient",
};
const schema: LocalDraftSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        label: { type: "string", minLength: 1, maxLength: 100 },
        count: { type: "integer", minimum: 0, maximum: 20 },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: ["label", "count"],
};
const payload = { label: "SYNTHETIC_PRIVATE_MARKER", count: 3, tags: ["private"] };
const input: LocalDraftInput = { target, schema, payload };

function setup(deliver: LocalDraftDelivery = async () => ({ kind: "delivered" })) {
    const transport = vi.fn(deliver);
    const store = new LocalAppDraftStore(transport);
    store.setAccount("synthetic-account-a");
    return { store, transport };
}

function pendingDelivery() {
    let resolve!: (result: { kind: "delivered" }) => void;
    const deliver = new Promise<{ kind: "delivered" }>((done) => {
        resolve = done;
    });
    return { deliver, resolve };
}

describe("private local drafts", () => {
    it("revokes unattempted consent without replacing the draft or import ID", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        const first = store.review(draft.id);
        const before = store.snapshot(draft.id);
        expect(store.revokeApproval(draft.id)).toMatchObject({ id: draft.id, status: "draft" });
        expect(store.snapshot(draft.id)).toEqual(before);
        expect(await store.confirm(draft.id, first.approvalId)).toEqual({ kind: "blocked" });
        const next = store.review(draft.id);
        expect(next.approvalId).not.toBe(first.approvalId);
        expect(next.request).toEqual(first.request);
        expect(transport).not.toHaveBeenCalled();
    });

    it.each(["delivered", "uncertain"] as const)(
        "revokes %s consent while retaining immutable request and outcome",
        async (kind) => {
            const { store, transport } = setup(async () => ({ kind }));
            const draft = store.create(input);
            const first = store.review(draft.id);
            await store.confirm(draft.id, first.approvalId);
            const before = store.snapshot(draft.id);
            expect(store.revokeApproval(draft.id)).toMatchObject({ status: kind });
            expect(store.get(draft.id)?.approval).toBeUndefined();
            expect(store.snapshot(draft.id)).toEqual(before);
            expect(() =>
                store.edit(draft.id, { payload: { label: "changed", count: 1 } }),
            ).toThrow();
            const dispatch =
                kind === "delivered"
                    ? store.reopenDelivered.bind(store)
                    : store.retryUncertain.bind(store);
            expect(await dispatch(draft.id, first.approvalId)).toEqual({ kind: "blocked" });
            const next = store.reviewRecovered(draft.id);
            expect(next.approvalId).not.toBe(first.approvalId);
            expect(next.request).toEqual(first.request);
            expect(store.get(draft.id)?.status).toBe(kind);
            expect(transport).toHaveBeenCalledOnce();
            await dispatch(draft.id, next.approvalId);
            expect(transport).toHaveBeenCalledTimes(2);
        },
    );

    it("does not revoke or switch a sending request", async () => {
        const pending = pendingDelivery();
        const { store } = setup(() => pending.deliver);
        const draft = store.create(input);
        const approval = store.review(draft.id);
        const sending = store.confirm(draft.id, approval.approvalId);
        expect(() => store.revokeApproval(draft.id)).toThrow(/sending/);
        expect(store.get(draft.id)?.approval).toBe(approval);
        pending.resolve({ kind: "delivered" });
        await sending;
    });

    it("never calls delivery before a valid host review and explicit confirmation", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        expect(await store.confirm(draft.id, "invented-approval")).toEqual({ kind: "blocked" });
        expect(transport).not.toHaveBeenCalled();
        const approval = store.review(draft.id);
        expect(approval.summary).toContain("SYNTHETIC_PRIVATE_MARKER");
        expect(transport).not.toHaveBeenCalled();
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "delivered" });
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0][0]).toBe(approval.request);
        expect(store.get(draft.id)?.status).toBe("delivered");
    });

    it("requires an account and clears private data on logout", () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        store.setAccount(undefined);
        expect(store.get(draft.id)).toBeUndefined();
        expect(() => store.create(input)).toThrow(/signed-in account/);
        expect(transport).not.toHaveBeenCalled();
    });

    it("deeply clones and freezes payload, schema, destination and recipient", () => {
        const { store } = setup();
        const mutable = { label: "original", count: 2, tags: ["original"] };
        const mutableTarget = { ...target };
        const draft = store.create({ ...input, target: mutableTarget, payload: mutable });
        mutable.label = "changed";
        mutable.tags[0] = "changed";
        mutableTarget.destination = "https://other.invalid";
        mutableTarget.recipient = "someone-else";
        const approval = store.review(draft.id);
        expect(approval.request.payload).toEqual({
            label: "original",
            count: 2,
            tags: ["original"],
        });
        expect(approval.request.destination).toBe(target.destination);
        expect(approval.request.recipient).toBe(target.recipient);
        expect(Object.isFrozen(approval)).toBe(true);
        expect(Object.isFrozen(approval.request)).toBe(true);
        expect(Object.isFrozen(approval.request.payload)).toBe(true);
        expect(Object.isFrozen((approval.request.payload as { tags: string[] }).tags)).toBe(true);
        expect(() => {
            (approval.request as { recipient: string }).recipient = "forged";
        }).toThrow();
    });

    it("reviews every exact delivered field, escaping hidden controls without changing data", () => {
        const { store } = setup();
        const draft = store.create({ ...input, payload: { label: "line\u202ehidden", count: 3 } });
        const approval = store.review(draft.id);
        expect(approval.summary).toContain("\\u202e");
        expect(approval.summary).not.toContain("\u202e");
        expect(JSON.parse(approval.summary)).toEqual(approval.request);
        expect(Object.keys(approval.request).sort()).toEqual([
            "actionId",
            "appId",
            "destination",
            "idempotencyKey",
            "payload",
            "recipient",
        ]);
        expect(approval.request.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(approval.request).not.toHaveProperty("accountId");
        expect(approval.request).not.toHaveProperty("appVerified");
    });

    it("does not let a later schema mutation weaken a draft's validation", () => {
        const { store } = setup();
        const mutableSchema = {
            type: "object" as const,
            additionalProperties: false as const,
            properties: { count: { type: "integer" as const, maximum: 3 } },
            required: ["count"],
        };
        const draft = store.create({ target, schema: mutableSchema, payload: { count: 2 } });
        mutableSchema.properties.count.maximum = 100;
        mutableSchema.required.length = 0;
        expect(() => store.edit(draft.id, { payload: { count: 4 } })).toThrow();
        expect(() => store.edit(draft.id, { payload: {} })).toThrow();
    });

    it.each(["payload", "destination", "recipient"] as const)(
        "invalidates approval after %s edits",
        async (change) => {
            const { store, transport } = setup();
            const draft = store.create(input);
            const old = store.review(draft.id);
            store.edit(
                draft.id,
                change === "payload"
                    ? { payload: { label: "new value", count: 4 } }
                    : {
                          target: {
                              ...target,
                              [change]:
                                  change === "destination"
                                      ? "https://other.invalid/import"
                                      : "other-recipient",
                          },
                      },
            );
            expect(store.get(draft.id)?.approval).toBeUndefined();
            expect(await store.confirm(draft.id, old.approvalId)).toEqual({ kind: "blocked" });
            expect(transport).not.toHaveBeenCalled();
            const revised = store.review(draft.id);
            expect(revised.revision).toBe(old.revision + 1);
            expect(revised.approvalId).not.toBe(old.approvalId);
            expect(await store.confirm(draft.id, revised.approvalId)).toEqual({
                kind: "delivered",
            });
            expect(transport.mock.calls[0][0]).toBe(revised.request);
        },
    );

    it("re-review revokes an older approval even without edits", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        const old = store.review(draft.id);
        const latest = store.review(draft.id);
        expect(await store.confirm(draft.id, old.approvalId)).toEqual({ kind: "blocked" });
        expect(transport).not.toHaveBeenCalled();
        expect(latest.request.idempotencyKey).toBe(old.request.idempotencyKey);
    });

    it("prevents double confirmation and editing during delivery", async () => {
        const pending = pendingDelivery();
        const { store, transport } = setup(() => pending.deliver);
        const draft = store.create(input);
        const approval = store.review(draft.id);
        const first = store.confirm(draft.id, approval.approvalId);
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "blocked" });
        expect(() => store.edit(draft.id, { payload })).toThrow(/cannot be edited/);
        expect(transport).toHaveBeenCalledOnce();
        pending.resolve({ kind: "delivered" });
        expect(await first).toEqual({ kind: "delivered" });
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "blocked" });
    });

    it("does not auto-retry uncertainty and keeps identical bytes/key through explicit reconnect retry", async () => {
        const { store, transport } = setup(async () => {
            throw new Error("PRIVATE_TRANSPORT_DETAIL");
        });
        const draft = store.create(input);
        const approval = store.review(draft.id);
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "uncertain" });
        store.setAccount("synthetic-account-a"); // Same account / reconnect does not discard the key.
        await Promise.resolve();
        expect(transport).toHaveBeenCalledOnce();
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "blocked" });
        expect(() => store.edit(draft.id, { payload: { label: "edited", count: 9 } })).toThrow();
        expect(() => store.review(draft.id)).toThrow();
        transport.mockResolvedValueOnce({ kind: "delivered" });
        expect(await store.retryUncertain(draft.id, approval.approvalId)).toEqual({
            kind: "delivered",
        });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
        expect(JSON.stringify(transport.mock.calls[1][0])).toBe(JSON.stringify(approval.request));
    });

    it("never retries a draft that has not had an unknown delivery outcome", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        const approval = store.review(draft.id);
        expect(await store.retryUncertain(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it("locks explicit uncertain retry against double clicks with the original approval", async () => {
        const { store, transport } = setup(async () => ({ kind: "uncertain" }));
        const draft = store.create(input);
        const approval = store.review(draft.id);
        await store.confirm(draft.id, approval.approvalId);
        const pending = pendingDelivery();
        transport.mockImplementationOnce(() => pending.deliver);
        const retry = store.retryUncertain(draft.id, approval.approvalId);
        expect(await store.retryUncertain(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(transport).toHaveBeenCalledTimes(2);
        pending.resolve({ kind: "delivered" });
        expect(await retry).toEqual({ kind: "delivered" });
    });

    it("reopens an acknowledged request only by a separate choice with identical bytes and key", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        const approval = store.review(draft.id);
        await store.confirm(draft.id, approval.approvalId);
        store.setAccount("synthetic-account-a");
        expect(transport).toHaveBeenCalledOnce();
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "blocked" });
        expect(await store.retryUncertain(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(await store.reopenDelivered(draft.id, "wrong")).toEqual({ kind: "blocked" });
        const pending = pendingDelivery();
        transport.mockImplementationOnce(() => pending.deliver);
        const reopened = store.reopenDelivered(draft.id, approval.approvalId);
        expect(store.get(draft.id)?.status).toBe("sending");
        expect(await store.reopenDelivered(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls[1][0]).toBe(approval.request);
        expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
        expect(() => store.edit(draft.id, { payload: { label: "changed", count: 1 } })).toThrow();
        pending.resolve({ kind: "delivered" });
        expect(await reopened).toEqual({ kind: "delivered" });
        expect(store.get(draft.id)?.approval).toBe(approval);
    });

    it("does not use reopening to bypass the initial review or uncertain-retry path", async () => {
        const { store, transport } = setup(async () => ({ kind: "uncertain" }));
        const draft = store.create(input);
        expect(await store.reopenDelivered(draft.id, "invented")).toEqual({ kind: "blocked" });
        const approval = store.review(draft.id);
        expect(await store.reopenDelivered(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(transport).not.toHaveBeenCalled();
        await store.confirm(draft.id, approval.approvalId);
        expect(await store.reopenDelivered(draft.id, approval.approvalId)).toEqual({
            kind: "blocked",
        });
        expect(transport).toHaveBeenCalledOnce();
    });

    it.each(["cancel", "account", "logout", "clear"] as const)(
        "does not revive a reopened request after %s",
        async (operation) => {
            const { store, transport } = setup();
            const draft = store.create(input);
            const approval = store.review(draft.id);
            await store.confirm(draft.id, approval.approvalId);
            const pending = pendingDelivery();
            transport.mockImplementationOnce(() => pending.deliver);
            const reopened = store.reopenDelivered(draft.id, approval.approvalId);
            if (operation === "cancel") store.cancel(draft.id);
            else if (operation === "account") store.setAccount("different-account");
            else if (operation === "logout") store.setAccount(undefined);
            else store.clear();
            expect(transport.mock.calls[1][1].aborted).toBe(true);
            pending.resolve({ kind: "delivered" });
            expect(await reopened).toEqual({ kind: "discarded", deliveryMayHaveOccurred: true });
            expect(store.get(draft.id)).toBeUndefined();
            expect(await store.reopenDelivered(draft.id, approval.approvalId)).toEqual({
                kind: "blocked",
            });
            expect(transport).toHaveBeenCalledTimes(2);
        },
    );

    it("cancel before confirmation discards data without sending", async () => {
        const { store, transport } = setup();
        const draft = store.create(input);
        const approval = store.review(draft.id);
        expect(store.cancel(draft.id)).toEqual({ deliveryMayHaveOccurred: false });
        expect(await store.confirm(draft.id, approval.approvalId)).toEqual({ kind: "blocked" });
        expect(store.get(draft.id)).toBeUndefined();
        expect(transport).not.toHaveBeenCalled();
    });

    it.each(["cancel", "account", "logout", "clear"] as const)(
        "ignores late delivery after %s and aborts without claiming remote undo",
        async (operation) => {
            const pending = pendingDelivery();
            const { store, transport } = setup(() => pending.deliver);
            const draft = store.create(input);
            const approval = store.review(draft.id);
            const confirming = store.confirm(draft.id, approval.approvalId);
            if (operation === "cancel")
                expect(store.cancel(draft.id)).toEqual({ deliveryMayHaveOccurred: true });
            if (operation === "account") store.setAccount("synthetic-account-b");
            if (operation === "logout") store.setAccount(undefined);
            if (operation === "clear") store.clear();
            expect(transport.mock.calls[0][1].aborted).toBe(true);
            pending.resolve({ kind: "delivered" });
            expect(await confirming).toEqual({ kind: "discarded", deliveryMayHaveOccurred: true });
            expect(store.get(draft.id)).toBeUndefined();
            expect(await store.retryUncertain(draft.id, approval.approvalId)).toEqual({
                kind: "blocked",
            });
        },
    );

    it("different drafts get distinct random idempotency keys", () => {
        const { store } = setup();
        const one = store.review(store.create(input).id);
        const two = store.review(store.create(input).id);
        expect(one.request.idempotencyKey).not.toBe(two.request.idempotencyKey);
    });

    it.each([
        { label: "missing required" },
        { label: "unexpected", count: 3, hidden: "not reviewed" },
        { label: "nonfinite", count: Infinity },
        { label: "fraction", count: 1.2 },
        { label: "", count: 3 },
        { label: "invalid tags", count: 3, tags: [1] },
        { label: "too many tags", count: 3, tags: ["a", "b", "c", "d"] },
    ])("rejects invalid payload %# before transport", (invalidPayload) => {
        const { store, transport } = setup();
        expect(() => store.create({ ...input, payload: invalidPayload })).toThrow(
            /Invalid private draft/,
        );
        expect(transport).not.toHaveBeenCalled();
    });

    it("fails closed on unsupported schema features rather than ignoring validation", () => {
        const { store } = setup();
        expect(() =>
            store.create({
                ...input,
                schema: { ...schema, pattern: "ignored" } as LocalDraftSchema,
            }),
        ).toThrow();
        expect(() =>
            store.create({
                ...input,
                schema: { ...schema, additionalProperties: true } as unknown as LocalDraftSchema,
            }),
        ).toThrow();
    });

    it("does not run getters or toJSON callbacks in payload or schema", () => {
        const { store, transport } = setup();
        const getter = vi.fn(() => "private");
        const accessor = Object.defineProperty({ count: 3 }, "label", {
            get: getter,
            enumerable: true,
        });
        expect(() => store.create({ ...input, payload: accessor })).toThrow();
        expect(() => store.create({ ...input, payload: { ...payload, toJSON: getter } })).toThrow();
        const schemaAccessor = Object.defineProperty({}, "type", { get: getter, enumerable: true });
        expect(() =>
            store.create({ ...input, schema: schemaAccessor as LocalDraftSchema }),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });

    it.each([
        "javascript:alert(1)",
        "http://example.invalid/import",
        "https://user:password@example.invalid/import",
        "https://example.invalid/import#secret",
    ])("rejects unsafe destination %s", (destination) => {
        const { store } = setup();
        expect(() => store.create({ ...input, target: { ...target, destination } })).toThrow();
    });

    it("permits explicit loopback development destinations and canonicalizes them for review", () => {
        const { store } = setup();
        const draft = store.create({
            ...input,
            target: { ...target, destination: "http://LOCALHOST:5189" },
        });
        expect(store.review(draft.id).request.destination).toBe("http://localhost:5189/");
    });

    it("rejects oversized, sparse and cyclic payloads", () => {
        const { store } = setup();
        expect(() =>
            store.create({ ...input, payload: { label: "x".repeat(65_537), count: 3 } }),
        ).toThrow();
        expect(() => store.create({ ...input, payload: { ...payload, tags: Array(2) } })).toThrow();
        const cyclic: Record<string, unknown> = { ...payload };
        cyclic.self = cyclic;
        expect(() => store.create({ ...input, payload: cyclic })).toThrow();
    });
});
