import {
    parseLocalAppCatalog,
    type LocalAppCatalog,
    type LocalAppCatalogEntry,
} from "./localAppCatalog";
import { verifyImportedLocalProcessor, type ImportedLocalProcessor } from "./isolatedAppProcessor";

export type LocalAppDirectoryArtifact = Readonly<{
    url: string;
    sha256: string;
    byteLength: number;
}>;
export type LocalAppDirectoryDescriptor = Readonly<{
    id: string;
    name: string;
    description: string;
    revision: string;
    catalog: LocalAppDirectoryArtifact;
    processor: LocalAppDirectoryArtifact;
    setupUrl: string;
}>;
export type LocalAppDirectory = Readonly<{
    version: 1;
    apps: readonly LocalAppDirectoryDescriptor[];
}>;
export type LocalAppInstallation = Readonly<{
    appId: string;
    sourceUrl: string;
    descriptor: LocalAppDirectoryDescriptor;
    publicCatalogJson: string;
}>;
export type LocalAppPublicPackage = Readonly<{
    catalog: LocalAppCatalog;
    catalogJson: string;
    processor: ImportedLocalProcessor;
}>;
const MAX_FILE = 1024 * 1024;
const MAX_DIRECTORY = 128 * 1024;
// eslint-disable-next-line no-control-regex -- Displayed publisher metadata must not hide control characters.
const HIDDEN = /[\p{Cf}\u0000-\u001f\u007f-\u009f]/u;
function invalid(): never {
    throw new Error("Invalid app directory or package");
}
function sameJson(left: unknown, right: unknown): boolean {
    const encode = (value: unknown) =>
        JSON.stringify(value, (_key, item: unknown) =>
            item && typeof item === "object" && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
                : item,
        );
    return encode(left) === encode(right);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
    )
        invalid();
}
function text(value: unknown, limit: number): asserts value is string {
    if (
        typeof value !== "string" ||
        !value.length ||
        value.length > limit ||
        value.trim() !== value ||
        HIDDEN.test(value)
    )
        invalid();
}
export function localAppDirectorySource(value: string): string {
    text(value, 2048);
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
    )
        invalid();
    return url.href;
}
function resource(value: unknown, source: string): string {
    text(value, 2048);
    const url = localAppDirectorySource(new URL(value, source).href);
    if (new URL(url).origin !== new URL(source).origin) invalid();
    return url;
}
function artifact(value: unknown, source: string): LocalAppDirectoryArtifact {
    exact(value, ["url", "sha256", "byteLength"]);
    if (
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.byteLength) ||
        (value.byteLength as number) < 1 ||
        (value.byteLength as number) > MAX_FILE
    )
        invalid();
    return Object.freeze({
        url: resource(value.url, source),
        sha256: value.sha256,
        byteLength: value.byteLength as number,
    });
}
export function parseLocalAppDirectory(json: string, sourceUrl: string): LocalAppDirectory {
    const source = localAppDirectorySource(sourceUrl);
    if (new TextEncoder().encode(json).byteLength > MAX_DIRECTORY) invalid();
    const value: unknown = JSON.parse(json);
    exact(value, ["version", "apps"]);
    if (value.version !== 1 || !Array.isArray(value.apps) || value.apps.length > 16) invalid();
    const ids = new Set<string>();
    const apps = value.apps.map((entry: unknown) => {
        exact(entry, ["id", "name", "description", "revision", "catalog", "processor", "setupUrl"]);
        text(entry.id, 128);
        text(entry.revision, 128);
        text(entry.name, 200);
        text(entry.description, 4096);
        if (
            !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(entry.id) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(entry.revision) ||
            ids.has(entry.id)
        )
            invalid();
        ids.add(entry.id);
        return Object.freeze({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            revision: entry.revision,
            catalog: artifact(entry.catalog, source),
            processor: artifact(entry.processor, source),
            setupUrl: resource(entry.setupUrl, source),
        });
    });
    return Object.freeze({ version: 1, apps: Object.freeze(apps) });
}
async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}
async function readPublic(
    url: string,
    limit: number,
    signal: AbortSignal,
    fetcher: typeof fetch,
): Promise<Uint8Array> {
    signal.throwIfAborted();
    const response = await fetcher(url, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal,
    });
    if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.body
    ) {
        await response.body?.cancel();
        invalid();
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        await response.body.cancel();
        invalid();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) invalid();
            chunks.push(value);
        }
        signal.throwIfAborted();
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
export async function loadLocalAppDirectory(
    sourceUrl: string,
    signal: AbortSignal,
    fetcher: typeof fetch = fetch,
): Promise<LocalAppDirectory> {
    const source = localAppDirectorySource(sourceUrl);
    const bytes = await readPublic(source, MAX_DIRECTORY, signal, fetcher);
    return parseLocalAppDirectory(new TextDecoder("utf-8", { fatal: true }).decode(bytes), source);
}
async function loadArtifact(
    descriptor: LocalAppDirectoryArtifact,
    signal: AbortSignal,
    fetcher: typeof fetch,
): Promise<string> {
    const bytes = await readPublic(descriptor.url, descriptor.byteLength, signal, fetcher);
    if (bytes.byteLength !== descriptor.byteLength || (await sha256(bytes)) !== descriptor.sha256)
        invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function publicLocalAppCatalog(
    json: string,
    descriptor: LocalAppDirectoryDescriptor,
): LocalAppCatalog {
    const catalog = parseLocalAppCatalog(json);
    const app = catalog.apps[0];
    if (
        catalog.apps.length !== 1 ||
        app.id !== descriptor.id ||
        app.revision !== descriptor.revision ||
        app.name !== descriptor.name ||
        app.description !== descriptor.description ||
        app.processor?.sha256 !== descriptor.processor.sha256 ||
        app.processor.byteLength !== descriptor.processor.byteLength ||
        app.actions.some((action) => action.processorContext !== undefined)
    )
        invalid();
    return catalog;
}
export async function loadLocalAppPublicPackage(
    descriptor: LocalAppDirectoryDescriptor,
    signal: AbortSignal,
    fetcher: typeof fetch = fetch,
): Promise<LocalAppPublicPackage> {
    const catalogJson = await loadArtifact(descriptor.catalog, signal, fetcher);
    const catalog = publicLocalAppCatalog(catalogJson, descriptor);
    const source = await loadArtifact(descriptor.processor, signal, fetcher);
    const processor = Object.freeze({
        source,
        sha256: descriptor.processor.sha256,
        byteLength: descriptor.processor.byteLength,
    });
    if (!(await verifyImportedLocalProcessor(processor))) invalid();
    signal.throwIfAborted();
    return Object.freeze({ catalog, catalogJson, processor });
}
/** The app may supply its private context/labels/rules, but cannot silently change the pinned recipe or destination. */
export function bindConnectedLocalApp(
    json: string,
    publicCatalog: LocalAppCatalog,
): LocalAppCatalogEntry {
    const connected = parseLocalAppCatalog(json);
    const app = connected.apps[0];
    const advertised = publicCatalog.apps[0];
    if (
        connected.apps.length !== 1 ||
        app.id !== advertised.id ||
        app.revision !== advertised.revision ||
        app.name !== advertised.name ||
        app.description !== advertised.description ||
        app.destination !== advertised.destination ||
        !sameJson(app.processor, advertised.processor) ||
        app.actions.length !== advertised.actions.length
    )
        invalid();
    for (const action of app.actions) {
        const original = advertised.actions.find(
            (item) => item.definition.name === action.definition.name,
        );
        if (!original) invalid();
        const definition = Object.fromEntries(
            Object.entries(action.definition).filter(([key]) => key !== "rules"),
        );
        const publicDefinition = Object.fromEntries(
            Object.entries(original.definition).filter(([key]) => key !== "rules"),
        );
        if (
            !sameJson(definition, publicDefinition) ||
            !sameJson(action.draftSchema, original.draftSchema) ||
            !sameJson(action.handoff, original.handoff)
        )
            invalid();
    }
    return app;
}
export function localAppHasPrivateSetup(
    app: LocalAppCatalogEntry,
    publicCatalogJson: string,
): boolean {
    const catalog = parseLocalAppCatalog(publicCatalogJson);
    return catalog.apps.length !== 1 || !sameJson(app, catalog.apps[0]);
}
export function sameLocalAppPublisher(
    previous: LocalAppInstallation,
    next: LocalAppDirectoryDescriptor,
    sourceUrl: string,
): boolean {
    return (
        previous.sourceUrl === sourceUrl &&
        previous.descriptor.setupUrl === next.setupUrl &&
        previous.descriptor.catalog.url === next.catalog.url &&
        previous.descriptor.processor.url === next.processor.url
    );
}
/** Validate persisted provenance without contacting or executing the publisher. */
export async function validateLocalAppInstallation(
    value: unknown,
    app: LocalAppCatalogEntry,
): Promise<LocalAppInstallation> {
    exact(value, ["appId", "sourceUrl", "descriptor", "publicCatalogJson"]);
    if (
        value.appId !== app.id ||
        typeof value.sourceUrl !== "string" ||
        typeof value.publicCatalogJson !== "string"
    )
        invalid();
    const sourceUrl = localAppDirectorySource(value.sourceUrl);
    const descriptor = parseLocalAppDirectory(
        JSON.stringify({ version: 1, apps: [value.descriptor] }),
        sourceUrl,
    ).apps[0];
    const bytes = new TextEncoder().encode(value.publicCatalogJson);
    if (
        bytes.byteLength !== descriptor.catalog.byteLength ||
        (await sha256(bytes)) !== descriptor.catalog.sha256
    )
        invalid();
    const catalog = publicLocalAppCatalog(value.publicCatalogJson, descriptor);
    bindConnectedLocalApp(JSON.stringify({ version: 1, apps: [app] }), catalog);
    return Object.freeze({
        appId: app.id,
        sourceUrl,
        descriptor,
        publicCatalogJson: value.publicCatalogJson,
    });
}
