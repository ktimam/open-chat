// Private proposals are not chat messages or backend-attested ActionCards. This module has no
// network, storage, iframe, model, or app-code dependency. Only explicit confirmation calls delivery.
export type LocalDraftJson =
    | null
    | boolean
    | number
    | string
    | readonly LocalDraftJson[]
    | { readonly [key: string]: LocalDraftJson };

type Scalar = null | boolean | number | string;
type EnumConstraint = { readonly enum?: readonly Scalar[] };
export type LocalDraftSchema = EnumConstraint &
    (
        | { readonly type: "string"; readonly minLength?: number; readonly maxLength?: number }
        | {
              readonly type: "number" | "integer";
              readonly minimum?: number;
              readonly maximum?: number;
          }
        | { readonly type: "boolean" | "null" }
        | {
              readonly type: "array";
              readonly items: LocalDraftSchema;
              readonly minItems?: number;
              readonly maxItems?: number;
          }
        | {
              readonly type: "object";
              readonly properties: Readonly<Record<string, LocalDraftSchema>>;
              readonly required?: readonly string[];
              readonly additionalProperties: false;
          }
    );

export interface LocalDraftTarget {
    readonly appId: string;
    readonly actionId: string;
    readonly destination: string;
    readonly recipient: string;
}

export interface LocalDraftInput {
    // Host-configured app identity and destination; never route using model-returned fields.
    readonly target: LocalDraftTarget;
    readonly schema: LocalDraftSchema;
    readonly payload: unknown;
}

export interface LocalDraftDeliveryRequest extends LocalDraftTarget {
    readonly idempotencyKey: string;
    readonly payload: LocalDraftJson;
}

export interface LocalDraftApproval {
    readonly approvalId: string;
    readonly draftId: string;
    readonly revision: number;
    readonly request: LocalDraftDeliveryRequest;
    // Render as host-owned text, not HTML. Includes EVERY delivered field and exact destination.
    readonly summary: string;
}

export type LocalDraftStatus = "draft" | "reviewed" | "sending" | "delivered" | "uncertain";
export interface LocalDraftView {
    readonly id: string;
    readonly revision: number;
    readonly status: LocalDraftStatus;
    readonly target: LocalDraftTarget;
    readonly payload: LocalDraftJson;
    readonly approval?: LocalDraftApproval;
}

// An adapter must preserve the exact destination/recipient/payload/idempotency key, not follow a
// redirect silently, and deduplicate the key app-side. Errors mean unknown outcome, NOT safe retry.
export type LocalDraftDelivery = (
    request: LocalDraftDeliveryRequest,
    signal: AbortSignal,
) => Promise<{ kind: "delivered" } | { kind: "uncertain" }>;

export type LocalDraftConfirmationResult =
    | { kind: "delivered" | "uncertain" }
    | { kind: "blocked" }
    | { kind: "discarded"; deliveryMayHaveOccurred: true };

interface DraftRecord {
    view: LocalDraftView;
    schema: LocalDraftSchema;
    idempotencyKey: string;
    attempted: boolean;
    controller?: AbortController;
}

const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 256;
const MAX_DEPTH = 16;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DISPLAY_CONTROLS = /[\u007F-\u009F\p{Cf}\u2028\u2029]/gu;

function invalid(): never {
    // Do not echo payload, destination, or private schema content into errors/logs.
    throw new Error("Invalid private draft data or unsupported schema");
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reject accessors, class instances, sparse arrays, non-JSON values and oversized trees. No getters
// or app callbacks execute during cloning/validation. Objects are sorted and deeply frozen.
function cloneJson(
    value: unknown,
    depth = 0,
    budget = { nodes: 0, stringBytes: 0 },
): LocalDraftJson {
    if (depth > MAX_DEPTH || ++budget.nodes > 4096) invalid();
    if (typeof value === "string") {
        budget.stringBytes += new TextEncoder().encode(value).byteLength;
        if (budget.stringBytes > MAX_BYTES) invalid();
        return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
    if (Array.isArray(value)) {
        if (value.length > MAX_ITEMS || Reflect.ownKeys(value).length !== value.length + 1)
            invalid();
        const result: LocalDraftJson[] = [];
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined || !("value" in descriptor)) invalid();
            result.push(cloneJson(descriptor.value, depth + 1, budget));
        }
        return Object.freeze(result);
    }
    if (!isObject(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_ITEMS || keys.some((key) => typeof key !== "string")) invalid();
    const result: Record<string, LocalDraftJson> = Object.create(null);
    for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (FORBIDDEN_KEYS.has(key) || !("value" in descriptor) || !descriptor.enumerable)
            invalid();
        budget.stringBytes += new TextEncoder().encode(key).byteLength;
        if (budget.stringBytes > MAX_BYTES) invalid();
        result[key] = cloneJson(descriptor.value, depth + 1, budget);
    }
    return Object.freeze(result);
}

function snapshotJson(value: unknown): LocalDraftJson {
    const cloned = cloneJson(value);
    if (new TextEncoder().encode(JSON.stringify(cloned)).byteLength > MAX_BYTES) invalid();
    return cloned;
}

/** Bounded, immutable JSON data shared by the local catalog and isolated processor boundaries. */
export function snapshotLocalDraftJson(value: unknown): LocalDraftJson {
    return snapshotJson(value);
}

export function snapshotLocalDraftSchema(value: unknown): LocalDraftSchema {
    const schema = snapshotJson(value);
    validateSchema(schema);
    return schema;
}

export function snapshotLocalDraftPayload(
    value: unknown,
    schema: LocalDraftSchema,
): LocalDraftJson {
    const pinnedSchema = snapshotLocalDraftSchema(schema);
    const payload = snapshotJson(value);
    validatePayload(payload, pinnedSchema);
    return payload;
}

function bounds(
    schema: Record<string, unknown>,
    low: string,
    high: string,
    integer: boolean,
): void {
    for (const name of [low, high]) {
        const value = schema[name];
        if (
            value !== undefined &&
            (typeof value !== "number" ||
                !Number.isFinite(value) ||
                (integer && (!Number.isSafeInteger(value) || value < 0)))
        )
            invalid();
    }
    const lower = schema[low];
    const upper = schema[high];
    if (typeof lower === "number" && typeof upper === "number" && lower > upper) invalid();
}

function validateSchema(value: unknown): asserts value is LocalDraftSchema {
    if (!isObject(value)) invalid();
    const allowed = ["type", "enum"];
    if (value.enum !== undefined) {
        if (
            !Array.isArray(value.enum) ||
            value.enum.length === 0 ||
            value.enum.some(
                (entry) =>
                    entry !== null && !["string", "number", "boolean"].includes(typeof entry),
            )
        )
            invalid();
    }
    switch (value.type) {
        case "string":
            allowed.push("minLength", "maxLength");
            bounds(value, "minLength", "maxLength", true);
            break;
        case "number":
        case "integer":
            allowed.push("minimum", "maximum");
            bounds(value, "minimum", "maximum", false);
            break;
        case "boolean":
        case "null":
            break;
        case "array":
            allowed.push("items", "minItems", "maxItems");
            bounds(value, "minItems", "maxItems", true);
            validateSchema(value.items);
            break;
        case "object": {
            allowed.push("properties", "required", "additionalProperties");
            const properties = value.properties;
            if (!isObject(properties) || value.additionalProperties !== false) invalid();
            for (const schema of Object.values(properties)) validateSchema(schema);
            if (
                value.required !== undefined &&
                (!Array.isArray(value.required) ||
                    value.required.some(
                        (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
                    ))
            )
                invalid();
            break;
        }
        default:
            invalid();
    }
    if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function validatePayload(value: LocalDraftJson, schema: LocalDraftSchema): void {
    if (schema.enum !== undefined && !schema.enum.some((entry) => entry === value)) invalid();
    switch (schema.type) {
        case "null":
            if (value !== null) invalid();
            break;
        case "boolean":
            if (typeof value !== "boolean") invalid();
            break;
        case "string":
            if (typeof value !== "string") invalid();
            if (
                Array.from(value).length < (schema.minLength ?? 0) ||
                Array.from(value).length > (schema.maxLength ?? Infinity)
            )
                invalid();
            break;
        case "number":
        case "integer":
            if (
                typeof value !== "number" ||
                (schema.type === "integer" && !Number.isSafeInteger(value))
            )
                invalid();
            if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
                invalid();
            break;
        case "array":
            if (!Array.isArray(value)) invalid();
            if (
                value.length < (schema.minItems ?? 0) ||
                value.length > (schema.maxItems ?? Infinity)
            )
                invalid();
            for (const item of value) validatePayload(item, schema.items);
            break;
        case "object":
            if (!isObject(value)) invalid();
            for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid();
            for (const [key, item] of Object.entries(value)) {
                if (!Object.hasOwn(schema.properties, key)) invalid();
                validatePayload(item as LocalDraftJson, schema.properties[key]);
            }
            break;
    }
}

function snapshotTarget(input: LocalDraftTarget): LocalDraftTarget {
    const value = snapshotJson(input);
    if (!isObject(value) || Object.keys(value).length !== 4) invalid();
    for (const key of ["appId", "actionId", "destination", "recipient"]) {
        if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 2048)
            invalid();
    }
    let url: URL;
    try {
        url = new URL(value.destination as string);
    } catch {
        return invalid();
    }
    if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
    )
        invalid();
    // Review the canonical URL, which is also the only URL handed to the delivery adapter.
    return Object.freeze({ ...value, destination: url.href }) as unknown as LocalDraftTarget;
}

/** Host-owned JSON display: preserve exact values while exposing hidden text controls. */
export function formatLocalDraftJson(value: unknown): string {
    const json = JSON.stringify(snapshotJson(value), null, 2);
    return json.replace(DISPLAY_CONTROLS, (character) => {
        // JSON escapes preserve the exact value while exposing bidi/hidden control characters.
        return Array.from(
            { length: character.length },
            (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
        ).join("");
    });
}

function randomId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export class LocalAppDraftStore {
    readonly #drafts = new Map<string, DraftRecord>();
    #account: string | undefined;

    constructor(private readonly deliver: LocalDraftDelivery) {}

    setAccount(account: string | undefined): void {
        if (account === this.#account) return;
        this.clear();
        this.#account = account;
    }

    clear(): void {
        // Remove first so synchronous abort listeners cannot revive or confirm a cleared record.
        const records = [...this.#drafts.values()];
        this.#drafts.clear();
        for (const record of records) record.controller?.abort();
    }

    create(input: LocalDraftInput): LocalDraftView {
        if (!this.#account) throw new Error("A signed-in account is required for a private draft");
        const schema = snapshotJson(input.schema);
        validateSchema(schema);
        const payload = snapshotJson(input.payload);
        validatePayload(payload, schema);
        const target = snapshotTarget(input.target);
        const id = randomId();
        const view: LocalDraftView = Object.freeze({
            id,
            revision: 0,
            status: "draft",
            target,
            payload,
        });
        this.#drafts.set(id, { view, schema, idempotencyKey: randomId(), attempted: false });
        return view;
    }

    get(id: string): LocalDraftView | undefined {
        return this.#drafts.get(id)?.view;
    }

    edit(id: string, changes: { target?: LocalDraftTarget; payload?: unknown }): LocalDraftView {
        const record = this.#required(id);
        if (record.attempted) throw new Error("A dispatched draft cannot be edited");
        const payload = Object.hasOwn(changes, "payload")
            ? snapshotJson(changes.payload)
            : record.view.payload;
        validatePayload(payload, record.schema);
        const target =
            changes.target === undefined ? record.view.target : snapshotTarget(changes.target);
        record.view = Object.freeze({
            id,
            revision: record.view.revision + 1,
            status: "draft",
            target,
            payload,
        });
        return record.view;
    }

    review(id: string): LocalDraftApproval {
        const record = this.#required(id);
        if (record.attempted) throw new Error("Use the existing review for a dispatched draft");
        const request: LocalDraftDeliveryRequest = Object.freeze({
            ...record.view.target,
            idempotencyKey: record.idempotencyKey,
            payload: record.view.payload,
        });
        const approval: LocalDraftApproval = Object.freeze({
            approvalId: randomId(),
            draftId: id,
            revision: record.view.revision,
            request,
            summary: formatLocalDraftJson(request),
        });
        record.view = Object.freeze({ ...record.view, status: "reviewed", approval });
        return approval;
    }

    confirm(id: string, approvalId: string): Promise<LocalDraftConfirmationResult> {
        return this.#dispatch(id, approvalId, "reviewed");
    }

    // Only a NEW explicit user choice after unknown outcome/reconnection may invoke this. Keep the
    // exact request and idempotency key; a generic reconnect callback must never call this itself.
    retryUncertain(id: string, approvalId: string): Promise<LocalDraftConfirmationResult> {
        return this.#dispatch(id, approvalId, "uncertain");
    }

    // Receipt is not saving. A NEW explicit choice may reopen an acknowledged handoff after
    // the receiving page is lost. Keep the original review/key; never infer or prepare again.
    // The host must first check the app's save report and warn about possible prior saving.
    reopenDelivered(id: string, approvalId: string): Promise<LocalDraftConfirmationResult> {
        return this.#dispatch(id, approvalId, "delivered");
    }

    cancel(id: string): { deliveryMayHaveOccurred: boolean } {
        const record = this.#drafts.get(id);
        this.#drafts.delete(id);
        record?.controller?.abort();
        // Cancellation only discards the local draft; it cannot undo an accepted remote action.
        return { deliveryMayHaveOccurred: record?.attempted ?? false };
    }

    #required(id: string): DraftRecord {
        const record = this.#drafts.get(id);
        if (record === undefined) throw new Error("Private draft is no longer available");
        return record;
    }

    async #dispatch(
        id: string,
        approvalId: string,
        expectedStatus: "reviewed" | "uncertain" | "delivered",
    ): Promise<LocalDraftConfirmationResult> {
        const record = this.#drafts.get(id);
        const approval = record?.view.approval;
        if (
            !this.#account ||
            record === undefined ||
            approval === undefined ||
            approval.approvalId !== approvalId ||
            approval.revision !== record.view.revision ||
            record.view.status !== expectedStatus
        )
            return { kind: "blocked" };
        // Lock synchronously before invoking the adapter: double clicks cannot dispatch twice.
        record.attempted = true;
        record.view = Object.freeze({ ...record.view, status: "sending" });
        const controller = new AbortController();
        record.controller = controller;
        let outcome: "delivered" | "uncertain" = "uncertain";
        try {
            const result = await this.deliver(approval.request, controller.signal);
            if (result?.kind === "delivered") outcome = "delivered";
        } catch {
            // No raw error reaches UI/logs and no automatic retry follows a transport failure.
        }
        if (this.#drafts.get(id) !== record || controller.signal.aborted) {
            return { kind: "discarded", deliveryMayHaveOccurred: true };
        }
        record.controller = undefined;
        record.view = Object.freeze({ ...record.view, status: outcome });
        return { kind: outcome };
    }
}
