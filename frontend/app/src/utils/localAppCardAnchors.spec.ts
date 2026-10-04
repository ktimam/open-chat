// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { fromStore, get, writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import LocalAppCardAnchor from "../components_shared/LocalAppCardAnchor.svelte";
import {
    createLocalAppCardAnchorRegistry,
    localAppCardAnchorKey,
    localAppCardAnchors,
    MAX_LOCAL_APP_CARD_ANCHORS,
    type LocalAppCardAnchorNamespace,
    type LocalAppCardAnchorSource,
} from "./localAppCardAnchors";

const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const namespace: LocalAppCardAnchorNamespace = {
    account: "synthetic-viewer",
    backend: "https://backend.invalid",
};
const source: LocalAppCardAnchorSource = {
    chatKey: principal,
    chatKind: "direct_chat",
    messageId: "18446744073709551615",
    messageIndex: 0,
};
const disposers: (() => void)[] = [];
const instances = new Set<ReturnType<typeof mount>>();

function element(): HTMLDivElement {
    const node = document.createElement("div");
    document.body.append(node);
    return node;
}

afterEach(async () => {
    for (const instance of instances) await unmount(instance);
    instances.clear();
    for (const dispose of disposers.splice(0)) dispose();
    document.body.replaceChildren();
});

describe("message-anchor component lifecycle", () => {
    it("fails closed for an invalid host scope without breaking source-message rendering", () => {
        const target = element();
        const instance = flushSync(() =>
            mount(LocalAppCardAnchor, {
                target,
                props: { namespace: { ...namespace, account: "" }, source },
            }),
        );
        instances.add(instance);
        expect(target.firstElementChild).toBeInstanceOf(HTMLElement);
        expect(get(localAppCardAnchors)).toEqual([]);
    });

    it("registers its actual connected node and unregisters on unmount without workspace access", async () => {
        const target = element();
        const instance = flushSync(() =>
            mount(LocalAppCardAnchor, {
                target,
                props: { namespace, source },
            }),
        );
        instances.add(instance);
        const node = target.firstElementChild as HTMLElement;
        expect(node.isConnected).toBe(true);
        expect(localAppCardAnchors.find(namespace, source)).toBe(node);
        expect(node.textContent).toBe("");
        expect(node.attributes.length).toBe(1);
        expect(node.classList.contains("local-app-card-anchor")).toBe(true);
        await unmount(instance);
        instances.delete(instance);
        expect(localAppCardAnchors.find(namespace, source)).toBeUndefined();
        expect(get(localAppCardAnchors)).toEqual([]);
    });

    it("rebinds changed host namespace and source without stale associations", () => {
        const props = writable({ namespace, source });
        const current = fromStore(props);
        const target = element();
        const instance = flushSync(() =>
            mount(LocalAppCardAnchor, {
                target,
                props: {
                    get namespace() {
                        return current.current.namespace;
                    },
                    get source() {
                        return current.current.source;
                    },
                },
            }),
        );
        instances.add(instance);
        const node = target.firstElementChild as HTMLElement;
        const nextNamespace = { ...namespace, account: "next-account", backend: "next-backend" };
        const nextSource = { ...source, messageId: "next-message", threadRootMessageIndex: 0 };
        flushSync(() => props.set({ namespace: nextNamespace, source: nextSource }));
        expect(localAppCardAnchors.find(namespace, source)).toBeUndefined();
        expect(localAppCardAnchors.find(nextNamespace, nextSource)).toBe(node);
        expect(get(localAppCardAnchors)).toHaveLength(1);
    });
});

describe("host-captured local card anchor identity", () => {
    it("keys all namespace/source coordinates without treating message index as identity", () => {
        const key = localAppCardAnchorKey(namespace, source);
        expect(JSON.parse(key!)).toEqual([
            namespace.account,
            namespace.backend,
            "direct_chat",
            principal,
            source.messageId,
            null,
        ]);
        expect(localAppCardAnchorKey(namespace, { ...source, messageIndex: 99 })).toBe(key);
        expect(localAppCardAnchorKey(namespace, { ...source, messageIndex: undefined })).toBe(key);
        expect(localAppCardAnchorKey(namespace, { ...source, threadRootMessageIndex: 0 })).not.toBe(
            key,
        );
        expect(localAppCardAnchorKey(namespace, { ...source, chatKind: "group_chat" })).not.toBe(
            key,
        );
        expect(localAppCardAnchorKey(namespace, { ...source, messageId: "different" })).not.toBe(
            key,
        );
        expect(localAppCardAnchorKey({ ...namespace, account: "other" }, source)).not.toBe(key);
        expect(localAppCardAnchorKey({ ...namespace, backend: "other" }, source)).not.toBe(key);
    });

    it("uses the canonical channel key, preserves large identities and rejects delimiter aliases", () => {
        expect(
            localAppCardAnchorKey(namespace, {
                ...source,
                chatKind: "channel",
                chatKey: `${principal}_${Number.MAX_SAFE_INTEGER}`,
                threadRootMessageIndex: Number.MAX_SAFE_INTEGER,
            }),
        ).toBeDefined();
        expect(localAppCardAnchorKey({ account: "left|right", backend: "end" }, source)).not.toBe(
            localAppCardAnchorKey({ account: "left", backend: "right|end" }, source),
        );
    });

    it.each([
        { chatKey: `d|${principal}` },
        { chatKey: `${principal}_00`, chatKind: "channel" },
        { chatKey: `${principal}_1`, chatKind: "direct_chat" },
        { chatKey: `${principal}_9007199254740992`, chatKind: "channel" },
        { chatKey: "not-a-principal" },
        { chatKey: principal, chatKind: "channel" },
        { chatKind: undefined },
        { chatKind: "invalid" },
        { messageId: "" },
        { messageId: " leading-space" },
        { messageId: "hidden\u202econtrol" },
        { messageId: "x".repeat(129) },
        { threadRootMessageIndex: -1 },
        { threadRootMessageIndex: 0.5 },
        { threadRootMessageIndex: Number.MAX_SAFE_INTEGER + 1 },
        { messageIndex: Number.NaN },
    ])("rejects malformed, ambiguous or noncanonical source coordinates: %j", (invalid) => {
        expect(
            localAppCardAnchorKey(namespace, { ...source, ...invalid } as LocalAppCardAnchorSource),
        ).toBeUndefined();
    });

    it.each([
        { account: "" },
        { account: " other " },
        { account: "x".repeat(513) },
        { backend: "" },
        { backend: "x".repeat(2049) },
        { backend: "backend\u0000suffix" },
        { account: "viewer\u200binvisible" },
    ])("rejects malformed namespaces without normalizing them: %j", (invalid) => {
        expect(localAppCardAnchorKey({ ...namespace, ...invalid }, source)).toBeUndefined();
    });

    it("has no target while namespace or source is unavailable", () => {
        expect(localAppCardAnchorKey(undefined, source)).toBeUndefined();
        expect(localAppCardAnchorKey(namespace, undefined)).toBeUndefined();
    });
});

describe("connected local card anchor registry", () => {
    it("publishes a readonly store and unregisters without touching the node", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const node = element();
        node.textContent = "host child";
        const changes = vi.fn();
        disposers.push(registry.subscribe(changes));
        const dispose = registry.register(namespace, source, node);
        disposers.push(dispose);
        expect(registry.find(namespace, source)).toBe(node);
        expect(get(registry)).toEqual([{ key: localAppCardAnchorKey(namespace, source), node }]);
        expect(Object.isFrozen(get(registry))).toBe(true);
        expect(Object.isFrozen(get(registry)[0])).toBe(true);
        expect(registry).not.toHaveProperty("set");
        expect(registry).not.toHaveProperty("update");
        dispose();
        dispose();
        expect(registry.find(namespace, source)).toBeUndefined();
        expect(get(registry)).toEqual([]);
        expect(node.isConnected).toBe(true);
        expect(node.textContent).toBe("host child");
        expect(changes).toHaveBeenCalledTimes(3);
    });

    it("an old disposer cannot remove a replacement node or a renewed same-node registration", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const first = element();
        const next = element();
        const firstDispose = registry.register(namespace, source, first);
        const nextDispose = registry.register(namespace, source, next);
        const renewedDispose = registry.register(namespace, source, next);
        disposers.push(firstDispose, nextDispose, renewedDispose);
        firstDispose();
        nextDispose();
        expect(registry.find(namespace, source)).toBe(next);
        expect(get(registry)).toHaveLength(1);
        renewedDispose();
        expect(get(registry)).toEqual([]);
    });

    it("isolates accounts, backends, chat kinds, messages and threads", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const node = element();
        disposers.push(registry.register(namespace, source, node));
        expect(registry.find({ ...namespace, account: "other" }, source)).toBeUndefined();
        expect(registry.find({ ...namespace, backend: "other" }, source)).toBeUndefined();
        expect(registry.find(namespace, { ...source, chatKind: "group_chat" })).toBeUndefined();
        expect(registry.find(namespace, { ...source, messageId: "other" })).toBeUndefined();
        expect(registry.find(namespace, { ...source, threadRootMessageIndex: 0 })).toBeUndefined();
    });

    it("revokes an old namespace when the same rendered node is reused", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const node = element();
        const other = { ...namespace, account: "other" };
        const firstDispose = registry.register(namespace, source, node);
        disposers.push(firstDispose, registry.register(other, source, node));
        expect(registry.find(namespace, source)).toBeUndefined();
        expect(registry.find(other, source)).toBe(node);
        firstDispose();
        expect(registry.find(other, source)).toBe(node);
    });

    it("synchronously prunes disconnected targets and does not restore them after reattachment", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const node = element();
        disposers.push(registry.register(namespace, source, node));
        node.remove();
        expect(registry.find(namespace, source)).toBeUndefined();
        expect(get(registry)).toEqual([]);
        document.body.append(node);
        expect(registry.find(namespace, source)).toBeUndefined();
    });

    it("accepts no detached, fake, non-HTML or malformed-namespace anchors", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const detached = document.createElement("div");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        document.body.append(svg);
        for (const node of [detached, svg, { isConnected: true }])
            expect(() => registry.register(namespace, source, node as HTMLElement)).toThrow(
                "Invalid local app card anchor",
            );
        expect(() => registry.register({ ...namespace, account: "" }, source, element())).toThrow(
            "Invalid local app card anchor",
        );
        expect(get(registry)).toEqual([]);
    });

    it("bounds live registrations, permits replacements, and reclaims detached capacity", () => {
        const registry = createLocalAppCardAnchorRegistry();
        const nodes: HTMLElement[] = [];
        for (let index = 0; index < MAX_LOCAL_APP_CARD_ANCHORS; index++) {
            const node = element();
            nodes.push(node);
            disposers.push(
                registry.register(namespace, { ...source, messageId: `${index}` }, node),
            );
        }
        const next = element();
        expect(() => registry.register(namespace, source, next)).toThrow(
            "Local app card anchor limit reached",
        );
        expect(get(registry)).toHaveLength(MAX_LOCAL_APP_CARD_ANCHORS);
        disposers.push(registry.register(namespace, { ...source, messageId: "0" }, next));
        nodes[1].remove();
        disposers.push(registry.register(namespace, source, element()));
        expect(get(registry)).toHaveLength(MAX_LOCAL_APP_CARD_ANCHORS);
    });
});
