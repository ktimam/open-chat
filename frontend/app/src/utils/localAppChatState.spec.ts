import { beforeEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";
import type { PrivateAppWorkspaceState } from "./privateAppWorkspace";
import type { LocalAppCatalog } from "./localAppCatalog";

const calls = vi.hoisted(() => ({ replace: vi.fn(() => true) }));
vi.mock("./privateAppWorkspace", () => ({
    privateAppWorkspaceState: writable({}),
    privateAppWorkspace: { replaceEnabledChats: calls.replace },
}));
import { privateAppWorkspaceState } from "./privateAppWorkspace";
import { localAppChatConfiguration, localAutoProposeSuggestions } from "./localAppChatState";

const catalog: LocalAppCatalog = {
    version: 1,
    apps: [
        {
            id: "app",
            revision: "v1",
            name: "App",
            description: "",
            destination: "https://example.test/review",
            actions: [],
        },
    ],
};
const enabledChats = Object.freeze([{ chatKey: "chat", appIds: Object.freeze(["app"]) }]);
const publish = (patch: Partial<PrivateAppWorkspaceState> = {}) =>
    privateAppWorkspaceState.set({
        account: "viewer",
        catalog,
        enabledChats,
        setupLoading: false,
        open: false,
        busy: false,
        processorReady: false,
        editorJson: "",
        draftManualValues: false,
        recipient: "",
        message: "",
        setupStatus: "",
        setupGeneration: 1,
        draftLoading: false,
        draftStorageStatus: "",
        cards: [],
        cardSources: {},
        directoryLoading: false,
        directoryStatus: "",
        appUpdates: {},
        disabledAppIds: [],
        ...patch,
    });

beforeEach(() => {
    publish({ account: undefined, catalog: undefined, enabledChats: [] });
    calls.replace.mockClear().mockReturnValue(true);
    localAutoProposeSuggestions.set(new Map());
});

describe("setup-only chat preference integration", () => {
    it("restores preferences without writing them and does not save on draft/status updates", () => {
        publish();
        expect(localAppChatConfiguration.enabled("viewer", "chat", "app")).toBe(true);
        publish({
            open: true,
            editorJson: '{"private":"draft"}',
            recipient: "private recipient",
            message: "private model output",
        });
        expect(calls.replace).not.toHaveBeenCalled();
    });
    it("saves only an explicit toggle, bound to exact account/catalog", () => {
        publish();
        expect(localAppChatConfiguration.setEnabled("viewer", "new-chat", "app", true)).toBe(true);
        expect(calls.replace).toHaveBeenCalledExactlyOnceWith("viewer", catalog, [
            { chatKey: "chat", appIds: ["app"] },
            { chatKey: "new-chat", appIds: ["app"] },
        ]);
    });
    it("rolls back a workspace-rejected toggle without attempting another save", () => {
        publish();
        calls.replace.mockReturnValue(false);
        localAppChatConfiguration.setEnabled("viewer", "chat", "app", false);
        expect(localAppChatConfiguration.enabled("viewer", "chat", "app")).toBe(true);
        expect(calls.replace).toHaveBeenCalledOnce();
    });
    it("clears active opt-ins for another account or replaced catalog without persisting a revocation", () => {
        publish();
        publish({ account: "other", enabledChats: [] });
        expect(localAppChatConfiguration.enabled("other", "chat", "app")).toBe(false);
        publish();
        publish({ catalog: { ...catalog }, enabledChats: [] });
        expect(localAppChatConfiguration.enabled("viewer", "chat", "app")).toBe(false);
        expect(calls.replace).not.toHaveBeenCalled();
    });
});
