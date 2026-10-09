import { describe, expect, it, vi } from "vitest";
import { LocalAppChatConfiguration } from "./localAppChatConfiguration";
import type { LocalAppCatalog } from "./localAppCatalog";
import { scopedAppFixture } from "./localAppChatRoutes.testFixtures";

const catalog = (): LocalAppCatalog => ({
    version: 1,
    apps: [
        {
            id: "private-app",
            revision: "v1",
            name: "Private app",
            description: "Generic test",
            destination: "https://example.test/review",
            actions: [
                {
                    definition: {
                        name: "record",
                        description: "record",
                        promptTemplate: "Extract",
                        responseSchema: {},
                        card: {
                            title: "Record",
                            rows: [{ label: "Value", valueKey: "value" }],
                            confirmLabel: "Review",
                            cancelLabel: "Cancel",
                        },
                        acceptsImage: true,
                        rules: [
                            {
                                kind: "keyword_map",
                                field: "value",
                                mode: "hint",
                                map: [{ value: "a", keywords: ["ticket"] }],
                            },
                        ],
                    },
                    draftSchema: { type: "object", properties: {}, additionalProperties: false },
                    handoff: { kind: "single" },
                    processorContext: { private: "never-match-this" },
                },
            ],
        },
    ],
});

describe("local per-chat app opt-in", () => {
    it("uses each chat's private vocabulary and invalidates suggestions without resetting opt-ins", async () => {
        const f = await scopedAppFixture();
        const state = new LocalAppChatConfiguration();
        const routes = [f.route("a", 1, "alpha"), f.route("b", 2, "beta")];
        state.setContext("viewer", f.catalog, f.connections, routes);
        state.setEnabled("viewer", "a", "sample", true);
        state.setEnabled("viewer", "b", "sample", true);
        state.setEnabled("viewer", "unconfigured", "sample", true);
        const old = state.suggestions("viewer", "a", { kind: "text_content", text: "alpha" });
        expect(old).toHaveLength(1);
        expect(state.suggestions("viewer", "a", { kind: "text_content", text: "beta" })).toEqual(
            [],
        );
        expect(
            state.suggestions("viewer", "b", { kind: "text_content", text: "beta" }),
        ).toHaveLength(1);
        expect(state.enabledApps("viewer", "unconfigured")).toEqual([]);
        state.setContext("viewer", f.catalog, f.connections, [
            f.route("a", 1, "updated"),
            routes[1],
        ]);
        expect(state.enabled("viewer", "a", "sample")).toBe(true);
        expect(state.enabled("viewer", "b", "sample")).toBe(true);
        expect(state.current(old[0])).toBe(false);
        expect(
            state.suggestions("viewer", "a", { kind: "text_content", text: "updated" }),
        ).toHaveLength(1);
        expect(
            state.suggestions("viewer", "b", { kind: "text_content", text: "beta" }),
        ).toHaveLength(1);
    });
    it("restores copied bounded choices only against the exact account and catalog", () => {
        const changed = vi.fn();
        const state = new LocalAppChatConfiguration(changed);
        const original = catalog();
        state.setContext("viewer", original);
        const rows = [{ chatKey: "chat", appIds: ["private-app"] }];
        expect(state.restoreEnabled("other", original, rows)).toBe(false);
        expect(state.restoreEnabled("viewer", catalog(), rows)).toBe(false);
        expect(state.restoreEnabled("viewer", original, rows)).toBe(true);
        rows[0].appIds.length = 0;
        expect(state.enabled("viewer", "chat", "private-app")).toBe(true);
        expect(changed).toHaveBeenLastCalledWith("restore");
        const snapshot = state.snapshotEnabled("viewer", original);
        expect(snapshot).toEqual([{ chatKey: "chat", appIds: ["private-app"] }]);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot[0].appIds)).toBe(true);
        expect(state.snapshotEnabled("other", original)).toEqual([]);
    });
    it("rejects malformed or excessive restored choices without partially replacing current opt-ins", () => {
        const state = new LocalAppChatConfiguration();
        const original = catalog();
        state.setContext("viewer", original);
        state.setEnabled("viewer", "kept", "private-app", true);
        const invalid = [
            [{ chatKey: "", appIds: ["private-app"] }],
            [{ chatKey: "x".repeat(513), appIds: ["private-app"] }],
            [{ chatKey: "chat", appIds: [] }],
            [{ chatKey: "chat", appIds: ["unknown"] }],
            [{ chatKey: "chat", appIds: ["private-app", "private-app"] }],
            [
                { chatKey: "chat", appIds: ["private-app"] },
                { chatKey: "chat", appIds: ["private-app"] },
            ],
            Array.from({ length: 257 }, (_, index) => ({
                chatKey: String(index),
                appIds: ["private-app"],
            })),
        ];
        for (const rows of invalid) {
            expect(state.restoreEnabled("viewer", original, rows)).toBe(false);
            expect(state.enabled("viewer", "kept", "private-app")).toBe(true);
            expect(state.enabled("viewer", "chat", "private-app")).toBe(false);
        }
    });
    it("is off by default and scopes explicit enablement to viewer and chat", () => {
        const state = new LocalAppChatConfiguration();
        state.setContext("viewer", catalog());
        expect(state.suggestions("viewer", "chat", { kind: "image_content" })).toEqual([]);
        expect(state.setEnabled("other", "chat", "private-app", true)).toBe(false);
        expect(state.setEnabled("viewer", "chat", "private-app", true)).toBe(true);
        expect(
            state.suggestions("viewer", "chat", { kind: "text_content", text: "ticket today" }),
        ).toHaveLength(1);
        expect(state.suggestions("other", "chat", { kind: "image_content" })).toEqual([]);
        expect(state.suggestions("viewer", "other-chat", { kind: "image_content" })).toEqual([]);
    });
    it("uses only whole-word declarative rules, never app-specific context or a model", () => {
        const changed = vi.fn();
        const state = new LocalAppChatConfiguration(changed);
        state.setContext("viewer", catalog());
        state.setEnabled("viewer", "chat", "private-app", true);
        expect(
            state.suggestions("viewer", "chat", { kind: "text_content", text: "tickets" }),
        ).toEqual([]);
        expect(
            state.suggestions("viewer", "chat", { kind: "text_content", text: "never-match-this" }),
        ).toEqual([]);
        expect(state.suggestions("viewer", "chat", { kind: "audio_content" })).toEqual([]);
        expect(
            state.suggestions("viewer", "chat", { kind: "text_content", text: "TICKET" })[0],
        ).toMatchObject({ appId: "private-app", appRevision: "v1", actionId: "record" });
        expect(changed).toHaveBeenCalledTimes(2);
    });
    it("revokes prior suggestions and opt-ins on disable, catalog replacement or account change", () => {
        const state = new LocalAppChatConfiguration();
        const original = catalog();
        state.setContext("viewer", original);
        state.setEnabled("viewer", "chat", "private-app", true);
        const suggestion = state.suggestions("viewer", "chat", { kind: "image_content" })[0];
        expect(state.current(suggestion)).toBe(true);
        state.setEnabled("viewer", "chat", "private-app", false);
        expect(state.current(suggestion)).toBe(false);
        state.setEnabled("viewer", "chat", "private-app", true);
        state.setContext("viewer", catalog());
        expect(state.enabled("viewer", "chat", "private-app")).toBe(false);
        state.setEnabled("viewer", "chat", "private-app", true);
        state.setContext("other", original);
        expect(state.enabled("other", "chat", "private-app")).toBe(false);
    });
});
