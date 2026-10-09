// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalAppSourceCardLink from "./LocalAppSourceCardLink.svelte";
import {
    privateAppWorkspaceState,
    type PrivateAppWorkspaceState,
} from "../utils/privateAppWorkspace";
import type { LocalDraftView } from "../utils/localAppDrafts";
import type { LocalAppCardAnchorSource } from "../utils/localAppCardAnchors";

const calls = vi.hoisted(() => ({ open: vi.fn(), selectCard: vi.fn(() => true) }));
vi.mock("../utils/privateAppWorkspace", async () => ({
    privateAppWorkspaceState: (await import("svelte/store")).writable({}),
    privateAppWorkspace: calls,
}));

const namespace = { account: "synthetic-account", backend: "synthetic-backend" };
const source: LocalAppCardAnchorSource = {
    chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    chatKind: "direct_chat",
    messageId: "900",
    messageIndex: 3,
};
const draft = (id = "private-card"): LocalDraftView => ({
    id,
    revision: 0,
    status: "draft",
    payload: { secret: "Never render private payload here" },
    target: {
        appId: "private-app-id",
        actionId: "private-action-id",
        destination: "https://private.invalid",
        recipient: "private-recipient",
    },
});
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | undefined;

function update(patch: Partial<PrivateAppWorkspaceState>) {
    privateAppWorkspaceState.update((current) => ({ ...current, ...patch }));
    flushSync();
}
function render() {
    target = document.createElement("div");
    document.body.append(target);
    instance = flushSync(() =>
        mount(LocalAppSourceCardLink, { target, props: { namespace, source } }),
    );
    return target;
}
function buttons() {
    return [...target.querySelectorAll("button")];
}

beforeEach(() => {
    vi.clearAllMocks();
    privateAppWorkspaceState.set({
        ...namespace,
        open: false,
        cardPresentation: "saved",
        cards: [draft()],
        cardSources: { "private-card": source },
        busy: false,
        draftLoading: false,
        fieldEditBlocked: false,
        draft: draft(),
        setupLoading: false,
        setupStatus: "",
        setupGeneration: 0,
        draftStorageStatus: "",
        enabledChats: [],
        connections: [],
        chatSetups: [],
        processorReady: false,
        message: "",
        editorJson: "{}",
        recipient: "",
        draftManualValues: false,
        directoryLoading: false,
        directoryStatus: "",
        appUpdates: {},
        disabledAppIds: [],
    });
});
afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    target?.remove();
});

describe("source-message private card rediscovery", () => {
    it("shows only host-authored text for a matching saved card after close/restart", () => {
        render();
        expect(target.textContent?.trim()).toBe("View private card");
        expect(target.querySelector("input, iframe, a, textarea, img")).toBeNull();
        for (const value of [
            "private-card",
            "private-app-id",
            "private-recipient",
            "Never render private payload here",
        ])
            expect(target.innerHTML).not.toContain(value);
        expect(calls.open).not.toHaveBeenCalled();
        expect(calls.selectCard).not.toHaveBeenCalled();
    });

    it("explicitly opens source presentation before selecting without proposing or delivering", () => {
        render();
        buttons()[0].click();
        expect(calls.open).toHaveBeenCalledExactlyOnceWith("source");
        expect(calls.selectCard).toHaveBeenCalledExactlyOnceWith("private-card");
        expect(calls.open.mock.invocationCallOrder[0]).toBeLessThan(
            calls.selectCard.mock.invocationCallOrder[0],
        );
    });

    it.each([{ account: "other" }, { backend: "other" }])(
        "hides other account/backend data: %j",
        (patch) => {
            update(patch);
            render();
            expect(target.textContent).toBe("");
            expect(buttons()).toHaveLength(0);
        },
    );

    it.each([
        { messageId: "901" },
        { chatKind: "group_chat" },
        { threadRootMessageIndex: 0 },
        { chatKey: "aaaaa-aa" },
        { chatKind: undefined },
    ])("does not conflate source identities: %j", (patch) => {
        update({
            cardSources: { "private-card": { ...source, ...patch } as LocalAppCardAnchorSource },
        });
        render();
        expect(buttons()).toHaveLength(0);
    });

    it("ignores navigation-only index changes while retaining the same source identity", () => {
        update({ cardSources: { "private-card": { ...source, messageIndex: 7 } } });
        render();
        expect(buttons()).toHaveLength(1);
    });

    it("hides the already active inline card but exposes it again when closed or in saved view", () => {
        update({
            open: true,
            cardPresentation: "source",
            presentationSource: source,
            presentationDraftId: "private-card",
        });
        render();
        expect(buttons()).toHaveLength(0);
        update({ open: false });
        expect(buttons()).toHaveLength(1);
        update({ open: true, cardPresentation: "saved" });
        expect(buttons()).toHaveLength(1);
    });

    it("hides links during same-source extraction even when an older draft is selected", () => {
        update({
            open: true,
            busy: true,
            phase: "preparing",
            cardPresentation: "source",
            presentationSource: source,
            draft: draft("old-other-card"),
        });
        render();
        expect(buttons()).toHaveLength(0);
        update({ open: false });
        expect(buttons()).toHaveLength(0);
    });

    it.each(["busy", "draftLoading", "fieldEditBlocked"] as const)(
        "disables and rechecks the %s guard without changing presentation",
        (guard) => {
            render();
            const button = buttons()[0];
            update({ [guard]: true });
            expect(button.disabled).toBe(true);
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(calls.open).not.toHaveBeenCalled();
            expect(calls.selectCard).not.toHaveBeenCalled();
        },
    );

    it("rechecks authoritative scope and card existence against a stale click", () => {
        render();
        const button = buttons()[0];
        privateAppWorkspaceState.set({ ...get(privateAppWorkspaceState), account: "other" });
        button.click();
        expect(calls.open).not.toHaveBeenCalled();
        expect(calls.selectCard).not.toHaveBeenCalled();
    });

    it("reopens only the same hidden invalid editor without selecting or replacing its fields", () => {
        update({
            open: false,
            cardPresentation: "source",
            presentationSource: source,
            fieldEditBlocked: true,
            editorJson: "INCOMPLETE EDIT MUST REMAIN",
            presentationDraftId: "private-card",
        });
        render();
        expect(buttons()[0].disabled).toBe(false);
        const before = get(privateAppWorkspaceState);
        buttons()[0].click();
        expect(calls.open).toHaveBeenCalledExactlyOnceWith("source");
        expect(calls.selectCard).not.toHaveBeenCalled();
        expect(get(privateAppWorkspaceState)).toBe(before);
    });

    it.each([
        { cardPresentation: "saved", presentationSource: undefined },
        { cardPresentation: "source", presentationSource: { ...source, messageId: "different" } },
        { cardPresentation: "source", presentationSource: source, draft: draft("other-card") },
        { cardPresentation: "source", presentationSource: source, presentationDraftId: undefined },
        {
            cardPresentation: "source",
            presentationSource: source,
            presentationDraftId: "other-card",
        },
    ] as const)("never retargets a blocked editor to another source, card or mode: %j", (patch) => {
        update({ open: false, fieldEditBlocked: true, ...patch });
        render();
        expect(buttons()[0].disabled).toBe(true);
        buttons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(calls.open).not.toHaveBeenCalled();
        expect(calls.selectCard).not.toHaveBeenCalled();
    });

    it("offers only matching cards and hides only the currently active one", () => {
        update({
            cards: [draft("first"), draft("second"), draft("unrelated")],
            cardSources: {
                first: source,
                second: source,
                unrelated: { ...source, messageId: "901" },
            },
            draft: draft("first"),
        });
        render();
        expect(buttons().map((button) => button.textContent?.trim())).toEqual([
            "View private card 1",
            "View private card 2",
        ]);
        buttons()[1].click();
        expect(calls.selectCard).toHaveBeenLastCalledWith("second");
        update({
            open: true,
            cardPresentation: "source",
            presentationSource: source,
            presentationDraftId: "first",
        });
        expect(buttons()).toHaveLength(1);
        buttons()[0].click();
        expect(calls.selectCard).toHaveBeenLastCalledWith("second");
    });

    it("does not mistake a failed proposal's retained draft for a displayed source card", () => {
        update({
            open: true,
            cardPresentation: "source",
            presentationSource: source,
            presentationDraftId: undefined,
        });
        render();
        expect(buttons()).toHaveLength(1);
        expect(buttons()[0].disabled).toBe(false);
    });
});
