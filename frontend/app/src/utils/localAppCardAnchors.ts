import { writable, type Readable } from "svelte/store";
import type { LocalAppDraftSourceReference } from "./localAppDraftPersistence";
import type { LocalAppSetupScope } from "./localAppSetupStore";
import { localAppSourceNavigation } from "./localAppSourceNavigation";

export type LocalAppCardAnchorNamespace = LocalAppSetupScope;
export type LocalAppCardAnchorSource = LocalAppDraftSourceReference &
    Readonly<{ chatKind: NonNullable<LocalAppDraftSourceReference["chatKind"]> }>;
export type LocalAppCardAnchor = Readonly<{ key: string; node: HTMLElement }>;

// This is a registry of currently rendered message nodes, never a saved-card collection.
export const MAX_LOCAL_APP_CARD_ANCHORS = 512;

function identifier(value: unknown, limit: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= limit &&
        value.trim() === value &&
        // eslint-disable-next-line no-control-regex -- Reject invisible namespace aliases.
        !/[\p{Cf}\u0000-\u001f\u007f-\u009f]/u.test(value)
    );
}

/** Host coordinates only. Message indices are navigation metadata, not message identity. */
export function localAppCardAnchorKey(
    namespace: LocalAppCardAnchorNamespace | undefined,
    source: LocalAppDraftSourceReference | undefined,
): string | undefined {
    if (
        !namespace ||
        !identifier(namespace.account, 512) ||
        !identifier(namespace.backend, 2048) ||
        !source ||
        source.chatKind === undefined ||
        !identifier(source.messageId, 128) ||
        localAppSourceNavigation(source) === undefined
    )
        return undefined;
    // JSON tuple encoding prevents delimiter collisions and preserves thread index zero.
    return JSON.stringify([
        namespace.account,
        namespace.backend,
        source.chatKind,
        source.chatKey,
        source.messageId,
        source.threadRootMessageIndex ?? null,
    ]);
}

export interface LocalAppCardAnchorRegistry {
    readonly subscribe: Readable<readonly LocalAppCardAnchor[]>["subscribe"];
    register(
        namespace: LocalAppCardAnchorNamespace,
        source: LocalAppCardAnchorSource,
        node: HTMLElement,
    ): () => void;
    find(
        namespace: LocalAppCardAnchorNamespace | undefined,
        source: LocalAppDraftSourceReference | undefined,
    ): HTMLElement | undefined;
}

/** No workspace, content, storage, navigation, or delivery operations occur in this registry. */
export function createLocalAppCardAnchorRegistry(): LocalAppCardAnchorRegistry {
    const nodes = new Map<string, LocalAppCardAnchor>();
    const store = writable<readonly LocalAppCardAnchor[]>(Object.freeze([]));

    function publish() {
        store.set(Object.freeze([...nodes.values()]));
    }

    function prune() {
        let changed = false;
        for (const [key, entry] of nodes) {
            if (!entry.node.isConnected || entry.node.ownerDocument !== document) {
                nodes.delete(key);
                changed = true;
            }
        }
        if (changed) publish();
    }

    return Object.freeze({
        subscribe: store.subscribe,
        register(namespace, source, node) {
            const key = localAppCardAnchorKey(namespace, source);
            if (
                key === undefined ||
                typeof HTMLElement === "undefined" ||
                !(node instanceof HTMLElement) ||
                !node.isConnected ||
                node.ownerDocument !== document
            )
                throw new Error("Invalid local app card anchor");
            prune();
            const sameNode = [...nodes.values()].find((entry) => entry.node === node);
            if (
                !nodes.has(key) &&
                sameNode === undefined &&
                nodes.size >= MAX_LOCAL_APP_CARD_ANCHORS
            )
                throw new Error("Local app card anchor limit reached");
            // Reusing a rendered node under a new account/source revokes its old association.
            if (sameNode) nodes.delete(sameNode.key);
            const entry: LocalAppCardAnchor = Object.freeze({ key, node });
            nodes.set(key, entry);
            publish();
            return () => {
                // The entry identity, not merely the node/key, owns this registration.
                if (nodes.get(key) !== entry) return;
                nodes.delete(key);
                publish();
            };
        },
        find(namespace, source) {
            const key = localAppCardAnchorKey(namespace, source);
            if (key === undefined) return undefined;
            prune();
            return nodes.get(key)?.node;
        },
    } satisfies LocalAppCardAnchorRegistry);
}

export const localAppCardAnchors = createLocalAppCardAnchorRegistry();
