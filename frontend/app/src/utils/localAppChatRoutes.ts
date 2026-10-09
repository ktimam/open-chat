import type { LocalAppCatalog, LocalAppCatalogEntry } from "./localAppCatalog";
import { parseLocalAppCatalog } from "./localAppCatalog";
import { bindConnectedLocalApp, type LocalAppInstallation } from "./localAppDirectory";

/** App-owned account identity. Chat coordinates remain exclusively in local storage. */
export type LocalAppAccountConnection = Readonly<{
    appId: string;
    accountId: string;
    legacyChatKeys?: readonly string[];
}>;
export type LocalAppChatSetup = Readonly<{
    appId: string;
    chatKey: string;
    handle: string;
    accountId: string;
    /** Absent while an explicitly requested setup is awaiting its verified reply. */
    catalogJson?: string;
}>;

const OPAQUE_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// eslint-disable-next-line no-control-regex -- Local chat identifiers cannot hide control characters.
const HIDDEN = /[\p{Cf}\u0000-\u001F\u007F-\u009F]/u;
function invalid(): never {
    throw new Error("Invalid stored private app chat setup");
}
function exact(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    if (required.some((key) => !Object.hasOwn(value, key))) invalid();
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (
            typeof key !== "string" ||
            (!required.includes(key) && !optional.includes(key)) ||
            !("value" in descriptor) ||
            !descriptor.enumerable
        )
            invalid();
    }
}
function text(value: unknown, max: number): asserts value is string {
    if (
        typeof value !== "string" ||
        !value.length ||
        value.length > max ||
        value.trim() !== value ||
        HIDDEN.test(value)
    )
        invalid();
}
function opaque(value: unknown): asserts value is string {
    if (typeof value !== "string" || !OPAQUE_ID.test(value)) invalid();
}
function array(value: unknown, max: number): asserts value is unknown[] {
    if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > max ||
        Reflect.ownKeys(value).length !== value.length + 1
    )
        invalid();
    for (let index = 0; index < value.length; ++index) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    }
}

/** Validate private per-chat catalogs against the same pinned publisher package as the app. */
export function validateLocalAppChatRoutes(
    catalog: LocalAppCatalog,
    installations: readonly LocalAppInstallation[],
    connectionsValue: unknown,
    chatSetupsValue: unknown,
): Readonly<{
    connections: readonly LocalAppAccountConnection[];
    chatSetups: readonly LocalAppChatSetup[];
}> {
    const connectionRows = connectionsValue === undefined ? [] : connectionsValue;
    const setupRows = chatSetupsValue === undefined ? [] : chatSetupsValue;
    array(connectionRows, 16);
    array(setupRows, 16 * 32);
    const accounts = new Map<string, string>();
    const publicCatalogs = new Map<string, LocalAppCatalog>();
    const connections = connectionRows.map((value) => {
        exact(value, ["appId", "accountId"], ["legacyChatKeys"]);
        text(value.appId, 128);
        opaque(value.accountId);
        const app = catalog.apps.find((entry) => entry.id === value.appId);
        const installation = installations.find((entry) => entry.appId === value.appId);
        if (!app?.setupScopes || !installation || accounts.has(value.appId)) invalid();
        const publicCatalog = parseLocalAppCatalog(installation.publicCatalogJson);
        bindConnectedLocalApp(JSON.stringify({ version: 1, apps: [app] }), publicCatalog);
        if (!publicCatalog.apps[0].setupScopes) invalid();
        publicCatalogs.set(value.appId, publicCatalog);
        accounts.set(value.appId, value.accountId);
        let legacyChatKeys: readonly string[] | undefined;
        if (value.legacyChatKeys !== undefined) {
            array(value.legacyChatKeys, 256);
            const seen = new Set<string>();
            legacyChatKeys = Object.freeze(
                value.legacyChatKeys.map((key) => {
                    text(key, 512);
                    if (seen.has(key)) invalid();
                    seen.add(key);
                    return key;
                }),
            );
        }
        return Object.freeze({
            appId: value.appId,
            accountId: value.accountId,
            ...(legacyChatKeys === undefined ? {} : { legacyChatKeys }),
        });
    });
    const handles = new Set<string>();
    const chats = new Set<string>();
    const counts = new Map<string, number>();
    let catalogBytes = 0;
    const chatSetups = setupRows.map((value) => {
        exact(value, ["appId", "chatKey", "handle", "accountId"], ["catalogJson"]);
        text(value.appId, 128);
        text(value.chatKey, 512);
        opaque(value.handle);
        opaque(value.accountId);
        const key = JSON.stringify([value.appId, value.chatKey]);
        const publicCatalog = publicCatalogs.get(value.appId);
        const count = (counts.get(value.appId) ?? 0) + 1;
        if (
            accounts.get(value.appId) !== value.accountId ||
            !publicCatalog ||
            handles.has(value.handle) ||
            chats.has(key) ||
            count > 32
        )
            invalid();
        handles.add(value.handle);
        chats.add(key);
        counts.set(value.appId, count);
        if (value.catalogJson !== undefined) {
            if (typeof value.catalogJson !== "string") invalid();
            catalogBytes += new TextEncoder().encode(value.catalogJson).byteLength;
            if (catalogBytes > 8 * 1024 * 1024) invalid();
            bindConnectedLocalApp(value.catalogJson, publicCatalog);
        }
        return Object.freeze({
            appId: value.appId,
            chatKey: value.chatKey,
            handle: value.handle,
            accountId: value.accountId,
            ...(value.catalogJson === undefined ? {} : { catalogJson: value.catalogJson }),
        });
    });
    return Object.freeze({
        connections: Object.freeze(connections),
        chatSetups: Object.freeze(chatSetups),
    });
}

/** An app account reconnect must never redirect every chat to the latest selected destination. */
export function resolveLocalAppForChat(
    catalog: LocalAppCatalog | undefined,
    connections: readonly LocalAppAccountConnection[] | undefined,
    chatSetups: readonly LocalAppChatSetup[] | undefined,
    appId: string,
    chatKey?: string,
): LocalAppCatalogEntry | undefined {
    const app = catalog?.apps.find((entry) => entry.id === appId);
    if (!app?.setupScopes) return app;
    if (!chatKey) return undefined;
    const connection = connections?.find((entry) => entry.appId === appId);
    if (!connection) return undefined;
    const setup = chatSetups?.find((entry) => entry.appId === appId && entry.chatKey === chatKey);
    if (setup) {
        if (setup.accountId !== connection.accountId || !setup.catalogJson) return undefined;
        try {
            return bindConnectedLocalApp(setup.catalogJson, { version: 1, apps: [app] });
        } catch {
            return undefined;
        }
    }
    return connection.legacyChatKeys?.includes(chatKey) ? app : undefined;
}
