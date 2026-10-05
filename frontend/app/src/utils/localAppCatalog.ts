import type { AiActionDefinition } from "@shared";
import {
    validateLocalAppDeliveryEncryption,
    type LocalAppDeliveryEncryption,
} from "./localAppEncryption";
import { validateLocalAppDraftEditor, type DraftEditorV1 } from "./localAppDraftChoices";
import {
    validateLocalAppDraftPresentation,
    type DraftPresentationV1,
} from "./localAppDraftPresentation";
import { validateLocalAppView, type LocalAppViewV1 } from "./localAppView";
import {
    snapshotLocalDraftJson,
    snapshotLocalDraftPayload,
    snapshotLocalDraftSchema,
    type LocalDraftJson,
    type LocalDraftSchema,
} from "./localAppDrafts";

export interface LocalProcessorArtifactDescriptor {
    readonly sha256: string;
    readonly byteLength: number;
}

export interface LocalAppAction {
    readonly definition: AiActionDefinition;
    readonly draftSchema: LocalDraftSchema;
    readonly draftEditor?: DraftEditorV1;
    readonly draftPresentation?: DraftPresentationV1;
    readonly draftView?: LocalAppViewV1;
    // Private app-owned setup data imported explicitly; never copied into the handoff by default.
    readonly processorContext?: LocalDraftJson;
    readonly handoff:
        | { readonly kind: "single" }
        | { readonly kind: "list" }
        | { readonly kind: "wrapped-list"; readonly field: string };
}

export interface LocalAppCatalogEntry {
    readonly id: string;
    readonly revision: string;
    readonly name: string;
    readonly description: string;
    readonly destination: string;
    // Declared review context, not proof of the account/sheet that will ultimately save the action.
    readonly recipientLabel?: string;
    readonly deliveryEncryption?: LocalAppDeliveryEncryption;
    readonly processor?: LocalProcessorArtifactDescriptor;
    readonly actions: readonly LocalAppAction[];
}

export interface LocalAppCatalog {
    readonly version: 1;
    readonly apps: readonly LocalAppCatalogEntry[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex -- Reject hidden/control characters in imported declarations; keep explicit code-point coverage.
const HIDDEN = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const NORMALIZERS = ["k_m_suffix", "strip_symbols", "uppercase", "lowercase", "trim"];
const MAX_CATALOG_BYTES = 1024 * 1024;

function invalid(): never {
    throw new Error("Invalid imported local app catalog");
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
    if (
        !record(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    )
        invalid();
}

function text(value: unknown, max: number, allowEmpty = false): asserts value is string {
    if (
        typeof value !== "string" ||
        (!allowEmpty && value.trim().length === 0) ||
        value.length > max ||
        HIDDEN.test(value)
    )
        invalid();
}

function field(value: unknown): asserts value is string {
    if (
        typeof value !== "string" ||
        !FIELD.test(value) ||
        ["__proto__", "constructor", "prototype"].includes(value)
    )
        invalid();
}

function list(value: unknown, max: number, nonempty = false): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0)) invalid();
}

function validateRules(value: unknown): void {
    list(value, 20);
    for (const rule of value) {
        if (!record(rule)) invalid();
        switch (rule.kind) {
            case "keyword_map":
                exact(rule, ["kind", "field", "mode", "map"]);
                field(rule.field);
                if (rule.mode !== "hint" && rule.mode !== "override") invalid();
                list(rule.map, 50);
                for (const entry of rule.map) {
                    exact(entry, ["value", "keywords"]);
                    text(entry.value, 64);
                    list(entry.keywords, 50);
                    for (const keyword of entry.keywords) text(keyword, 64);
                }
                break;
            case "from_message":
                exact(rule, ["kind", "field"], ["maxLength"]);
                field(rule.field);
                if (
                    rule.maxLength !== undefined &&
                    (typeof rule.maxLength !== "number" ||
                        !Number.isSafeInteger(rule.maxLength) ||
                        rule.maxLength < 0 ||
                        rule.maxLength > 2000)
                )
                    invalid();
                break;
            case "normalize":
                exact(rule, ["kind", "field", "ops"]);
                field(rule.field);
                list(rule.ops, 5);
                if (
                    rule.ops.some(
                        (operation) =>
                            typeof operation !== "string" || !NORMALIZERS.includes(operation),
                    )
                )
                    invalid();
                break;
            case "instruction":
                exact(rule, ["kind", "text"]);
                text(rule.text, 1000);
                break;
            case "context":
                exact(rule, ["kind", "provide"]);
                list(rule.provide, 1);
                if (rule.provide.some((item) => item !== "today")) invalid();
                break;
            default:
                invalid();
        }
    }
}

function validateDefinition(value: unknown): void {
    exact(
        value,
        ["name", "description", "promptTemplate", "responseSchema", "card"],
        ["rules", "acceptsImage"],
    );
    text(value.name, 128);
    if (!ID.test(value.name)) invalid();
    text(value.description, 4096, true);
    text(value.promptTemplate, 16_384);
    if (!record(value.responseSchema)) invalid();
    snapshotLocalDraftJson(value.responseSchema); // Preserve opaque app-authored prompt/schema extensions.
    exact(value.card, ["title", "rows", "confirmLabel", "cancelLabel"], ["disclosure"]);
    text(value.card.title, 200);
    text(value.card.confirmLabel, 128);
    text(value.card.cancelLabel, 128);
    if (value.card.disclosure !== undefined) text(value.card.disclosure, 4096);
    list(value.card.rows, 32, true);
    const labels = new Set<string>();
    const fields = new Set<string>();
    for (const row of value.card.rows) {
        exact(row, ["label", "valueKey"]);
        text(row.label, 128);
        field(row.valueKey);
        if (labels.has(row.label) || fields.has(row.valueKey)) invalid();
        labels.add(row.label);
        fields.add(row.valueKey);
    }
    if (value.rules !== undefined) validateRules(value.rules);
    if (value.acceptsImage !== undefined && typeof value.acceptsImage !== "boolean") invalid();
}

function freezeTree(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
}

/** Called only after an explicit user import. No URL fetch, executable content or registry lookup. */
export function parseLocalAppCatalog(json: string): LocalAppCatalog {
    if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > MAX_CATALOG_BYTES)
        invalid();
    let catalog: unknown;
    try {
        catalog = JSON.parse(json);
    } catch {
        return invalid();
    }
    exact(catalog, ["version", "apps"]);
    if (catalog.version !== 1) invalid();
    list(catalog.apps, 16);
    const appIds = new Set<string>();
    for (const app of catalog.apps) {
        exact(
            app,
            ["id", "revision", "name", "description", "destination", "actions"],
            ["processor", "recipientLabel", "deliveryEncryption"],
        );
        text(app.id, 128);
        text(app.revision, 128);
        if (!ID.test(app.id) || !ID.test(app.revision) || appIds.has(app.id)) invalid();
        appIds.add(app.id);
        text(app.name, 200);
        text(app.description, 4096, true);
        if (app.recipientLabel !== undefined) text(app.recipientLabel, 512);
        if (app.deliveryEncryption !== undefined)
            app.deliveryEncryption = validateLocalAppDeliveryEncryption(app.deliveryEncryption);
        text(app.destination, 2048);
        let destination: URL;
        try {
            destination = new URL(app.destination);
        } catch {
            return invalid();
        }
        if (
            destination.username ||
            destination.password ||
            destination.hash ||
            (destination.protocol !== "https:" &&
                !(
                    destination.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)
                ))
        )
            invalid();
        app.destination = destination.href;
        if (app.processor !== undefined) {
            exact(app.processor, ["sha256", "byteLength"]);
            if (
                typeof app.processor.sha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(app.processor.sha256) ||
                typeof app.processor.byteLength !== "number" ||
                !Number.isSafeInteger(app.processor.byteLength) ||
                app.processor.byteLength < 1 ||
                app.processor.byteLength > 1024 * 1024
            )
                invalid();
        }
        list(app.actions, 32, true);
        const actionIds = new Set<string>();
        for (const action of app.actions) {
            exact(
                action,
                ["definition", "draftSchema", "handoff"],
                ["processorContext", "draftEditor", "draftPresentation", "draftView"],
            );
            validateDefinition(action.definition);
            const definition = action.definition as Record<string, unknown>;
            if (actionIds.has(definition.name as string)) invalid();
            actionIds.add(definition.name as string);
            snapshotLocalDraftSchema(action.draftSchema);
            if (action.processorContext !== undefined)
                snapshotLocalDraftJson(action.processorContext);
            if (!record(action.handoff)) invalid();
            if (action.handoff.kind === "wrapped-list") {
                exact(action.handoff, ["kind", "field"]);
                field(action.handoff.field);
            } else {
                exact(action.handoff, ["kind"]);
                if (action.handoff.kind !== "single" && action.handoff.kind !== "list") invalid();
            }
            if (action.draftEditor !== undefined)
                action.draftEditor = validateLocalAppDraftEditor(
                    action.draftEditor,
                    action.draftSchema as LocalDraftSchema,
                    action.handoff as LocalAppAction["handoff"],
                );
            if (action.draftPresentation !== undefined)
                action.draftPresentation = validateLocalAppDraftPresentation(
                    action.draftPresentation,
                    action.draftSchema as LocalDraftSchema,
                    action.handoff as LocalAppAction["handoff"],
                );
            if (action.draftView !== undefined)
                action.draftView = validateLocalAppView(
                    action.draftView,
                    action.draftSchema as LocalDraftSchema,
                    action.handoff as LocalAppAction["handoff"],
                ).view;
            // Keep declarations that need a processor visible for setup, but never run one without
            // the pinned descriptor. Unknown extensions remain opaque; the existing runner owns them.
            const schema = definition.responseSchema as Record<string, unknown>;
            if (Object.hasOwn(schema, "x-openchat-local-processor") && app.processor === undefined)
                invalid();
        }
    }
    freezeTree(catalog);
    return catalog as unknown as LocalAppCatalog;
}

export function localAppCandidates(
    catalog: LocalAppCatalog,
): readonly { app: LocalAppCatalogEntry; action: LocalAppAction }[] {
    return Object.freeze(
        catalog.apps.flatMap((app) => app.actions.map((action) => Object.freeze({ app, action }))),
    );
}

/** App-owned mapping chooses the envelope shape; no domain fields are built into OpenChat. */
export function projectLocalAppPayload(
    action: LocalAppAction,
    candidates: readonly Record<string, unknown>[],
): LocalDraftJson {
    if (candidates.length === 0 || candidates.length > 32) invalid();
    const handoff = action.handoff;
    if (handoff.kind === "single" && candidates.length !== 1) invalid();
    const payload =
        handoff.kind === "single"
            ? candidates[0]
            : handoff.kind === "list"
              ? candidates
              : { [handoff.field]: candidates };
    return snapshotLocalDraftPayload(payload, action.draftSchema);
}
