/** Generic app-owned setup bindings. No chat coordinates, messages or authentication material. */
export const LOCAL_APP_SCOPED_SETUP_MAX_BYTES = 1024 * 1024;
export const LOCAL_APP_SCOPED_SETUP_MAX_ROUTES = 32;
const OPAQUE_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export type LocalAppSetupRoute = Readonly<{ handle: string; catalogJson: string }>;
export type LocalAppSetupContext =
    | Readonly<{
          version: 2;
          scope: "account";
          accountId?: string;
          legacyCatalogJson?: string;
          routes: readonly LocalAppSetupRoute[];
      }>
    | Readonly<{
          version: 2;
          scope: "chat";
          accountId: string;
          handle: string;
          catalogJson?: string;
      }>;
export type LocalAppScopedSetupResult = Readonly<{
    version: 2;
    scope: "account" | "chat";
    appId: string;
    accountId: string;
    catalogJson: string;
    routes: readonly LocalAppSetupRoute[];
}>;

function invalid(): never {
    throw new Error("Invalid scoped app setup");
}
function exact(
    value: unknown,
    required: string[],
    optional: string[] = [],
): Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        return invalid();
    const keys = Reflect.ownKeys(value);
    if (
        required.some((key) => !keys.includes(key)) ||
        keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
    )
        return invalid();
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field?.enumerable || !("value" in field)) return invalid();
        copy[key] = field.value;
    }
    return copy;
}
function id(value: unknown): string {
    if (typeof value !== "string" || !OPAQUE_ID.test(value)) return invalid();
    return value;
}
function bounded(value: unknown): string {
    if (
        typeof value !== "string" ||
        !value ||
        value.length > LOCAL_APP_SCOPED_SETUP_MAX_BYTES ||
        new TextEncoder().encode(value).byteLength > LOCAL_APP_SCOPED_SETUP_MAX_BYTES
    )
        return invalid();
    return value;
}
/** JSON.parse checks grammar; the token pass additionally rejects duplicate/prototype keys. */
function strictJson(value: unknown): unknown {
    const text = bounded(value);
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return invalid();
    }
    const stack: { object: boolean; key: boolean; seen: Set<string> }[] = [];
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)) {
        const part = token[0],
            top = stack.at(-1);
        if (part === "{" || part === "[") {
            if (stack.length >= 64) return invalid();
            stack.push({ object: part === "{", key: part === "{", seen: new Set() });
        } else if (part === "}" || part === "]") stack.pop();
        else if (top?.object && part === ",") top.key = true;
        else if (top?.object && part === ":") top.key = false;
        else if (top?.object && top.key && part.startsWith('"')) {
            const key = JSON.parse(part) as string;
            if (["__proto__", "constructor", "prototype"].includes(key) || top.seen.has(key))
                return invalid();
            top.seen.add(key);
        }
    }
    return parsed;
}
function catalog(value: unknown, appId?: string): string {
    const text = bounded(value);
    const root = exact(strictJson(text), ["version", "apps"]);
    if (root.version !== 1 || !Array.isArray(root.apps) || root.apps.length !== 1) return invalid();
    const app = root.apps[0];
    if (
        !app ||
        typeof app !== "object" ||
        Array.isArray(app) ||
        typeof app.id !== "string" ||
        !APP_ID.test(app.id) ||
        (appId !== undefined && app.id !== appId)
    )
        return invalid();
    // Full schema, publisher, destination, processor and grant validation remains at installation.
    return text;
}
function routes(value: unknown, appId?: string): readonly LocalAppSetupRoute[] {
    if (!Array.isArray(value) || value.length > LOCAL_APP_SCOPED_SETUP_MAX_ROUTES) return invalid();
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== value.length + 1 ||
        keys.some(
            (key) =>
                typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
        )
    )
        return invalid();
    const seen = new Set<string>();
    return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
            const entry = Object.getOwnPropertyDescriptor(value, String(index));
            if (!entry?.enumerable || !("value" in entry)) return invalid();
            const item: unknown = entry.value;
            const row = exact(item, ["handle", "catalogJson"]);
            const handle = id(row.handle);
            if (seen.has(handle)) return invalid();
            seen.add(handle);
            return Object.freeze({ handle, catalogJson: catalog(row.catalogJson, appId) });
        }),
    );
}
export function parseLocalAppSetupContext(value: unknown, appId?: string): LocalAppSetupContext {
    if (appId !== undefined && !APP_ID.test(appId)) return invalid();
    const base = exact(
        value,
        ["version", "scope"],
        ["accountId", "routes", "handle", "legacyCatalogJson", "catalogJson"],
    );
    if (base.version !== 2) return invalid();
    let result: LocalAppSetupContext;
    if (base.scope === "account") {
        const row = exact(
            value,
            ["version", "scope", "routes"],
            ["accountId", "legacyCatalogJson"],
        );
        result = Object.freeze({
            version: 2,
            scope: "account",
            ...(Object.hasOwn(row, "accountId") ? { accountId: id(row.accountId) } : {}),
            ...(Object.hasOwn(row, "legacyCatalogJson")
                ? { legacyCatalogJson: catalog(row.legacyCatalogJson, appId) }
                : {}),
            routes: routes(row.routes, appId),
        });
    } else if (base.scope === "chat") {
        const row = exact(value, ["version", "scope", "accountId", "handle"], ["catalogJson"]);
        result = Object.freeze({
            version: 2,
            scope: "chat",
            accountId: id(row.accountId),
            handle: id(row.handle),
            ...(Object.hasOwn(row, "catalogJson")
                ? { catalogJson: catalog(row.catalogJson, appId) }
                : {}),
        });
    } else return invalid();
    bounded(JSON.stringify(result));
    return result;
}
export function parseLocalAppScopedSetupResult(
    json: string,
    appId: string,
    context: LocalAppSetupContext,
): LocalAppScopedSetupResult {
    const request = parseLocalAppSetupContext(context, appId);
    const row = exact(strictJson(json), [
        "version",
        "scope",
        "appId",
        "accountId",
        "catalogJson",
        "routes",
    ]);
    if (row.version !== 2 || row.scope !== request.scope || row.appId !== appId) return invalid();
    const accountId = id(row.accountId);
    if (request.accountId !== undefined && accountId !== request.accountId) return invalid();
    const received = routes(row.routes, appId);
    const expected =
        request.scope === "chat" ? [request.handle] : request.routes.map((route) => route.handle);
    if (
        received.length !== expected.length ||
        received.some((route) => !expected.includes(route.handle))
    )
        return invalid();
    return Object.freeze({
        version: 2,
        scope: request.scope,
        appId,
        accountId,
        catalogJson: catalog(row.catalogJson, appId),
        routes: received,
    });
}
