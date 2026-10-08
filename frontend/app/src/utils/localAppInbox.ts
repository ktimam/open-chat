import { Principal } from "@icp-sdk/core/principal";
import { sha256 } from "@noble/hashes/sha256";
import {
    localAppDecodeBase64Url,
    validateEncryptedLocalAppDeliveryRequest,
    MAX_ENCRYPTED_REQUEST_BYTES,
} from "./localAppEncryption";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";

export interface LocalAppInboxEndpoint {
    readonly version: 1;
    readonly kind: "ic-canister";
    readonly host: string;
    readonly canisterId: string;
}
export interface LocalAppInboxGrant extends LocalAppInboxEndpoint {
    readonly inboxId: string;
    readonly writeCapability: string;
    readonly expiresAtMs: number;
}
/** Safe host-owned review/storage binding. Never contains the bearer capability. */
export interface LocalAppInboxTarget extends LocalAppInboxEndpoint {
    readonly inboxId: string;
    readonly capabilitySha256: string;
    readonly expiresAtMs: number;
}
export interface LocalAppInboxReceipt {
    readonly inboxId: string;
    readonly requestId: string;
    readonly bodySha256: string;
    readonly receivedAtMs: number;
    readonly expiresAtMs: number;
    readonly status: "Pending" | "Saved" | "Dismissed";
    readonly replayed: boolean;
}
export interface LocalAppInboxDelivery {
    readonly version: 1;
    readonly requestJson: string;
    readonly bodySha256: string;
    readonly receipt?: LocalAppInboxReceipt;
}
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ENDPOINT = ["version", "kind", "host", "canisterId"];
const PRIVATE = ["inboxId", "writeCapability", "expiresAtMs"];
const digest = (bytes: Uint8Array) =>
    Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
function invalid(): never {
    throw new Error("The app inbox connection is invalid. Reconnect the app before sending.");
}
function exact(
    value: unknown,
    required: string[],
    optional: string[] = [],
): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        invalid();
    if (required.some((key) => !Object.hasOwn(value, key))) invalid();
    for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        if (
            typeof key !== "string" ||
            ![...required, ...optional].includes(key) ||
            !("value" in field) ||
            !field.enumerable
        )
            invalid();
    }
}
function timestamp(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
}
export function validateLocalAppInbox(value: unknown): LocalAppInboxEndpoint | LocalAppInboxGrant {
    exact(value, ENDPOINT, PRIVATE);
    if (
        value.version !== 1 ||
        value.kind !== "ic-canister" ||
        typeof value.host !== "string" ||
        typeof value.canisterId !== "string"
    )
        invalid();
    let host: URL;
    try {
        host = new URL(value.host);
    } catch {
        return invalid();
    }
    if (
        host.origin !== value.host ||
        host.username ||
        host.password ||
        host.search ||
        host.hash ||
        (host.protocol !== "https:" &&
            !(
                host.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)
            ))
    )
        invalid();
    try {
        const principal = Principal.fromText(value.canisterId);
        if (
            principal.toText() !== value.canisterId ||
            principal.isAnonymous() ||
            principal.toText() === "aaaaa-aa"
        )
            invalid();
    } catch {
        return invalid();
    }
    if (PRIVATE.some((key) => Object.hasOwn(value, key))) {
        if (
            !PRIVATE.every((key) => Object.hasOwn(value, key)) ||
            typeof value.inboxId !== "string" ||
            !HASH.test(value.inboxId)
        )
            invalid();
        localAppDecodeBase64Url(value.writeCapability, 32);
        timestamp(value.expiresAtMs);
    }
    return Object.freeze({ ...value }) as unknown as LocalAppInboxEndpoint | LocalAppInboxGrant;
}
export function isLocalAppInboxGrant(value: LocalAppInboxEndpoint): value is LocalAppInboxGrant {
    return Object.hasOwn(value, "writeCapability");
}
export function localAppInboxEndpoint(value: LocalAppInboxEndpoint): LocalAppInboxEndpoint {
    const checked = validateLocalAppInbox(value);
    return Object.freeze({
        version: 1,
        kind: "ic-canister",
        host: checked.host,
        canisterId: checked.canisterId,
    });
}
export async function localAppInboxSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return digest(bytes);
}
export function localAppInboxCapabilityDigest(grant: LocalAppInboxGrant): string {
    return digest(localAppDecodeBase64Url(grant.writeCapability, 32));
}
export function localAppInboxTarget(value: LocalAppInboxEndpoint): LocalAppInboxTarget {
    const grant = validateLocalAppInbox(value);
    if (!isLocalAppInboxGrant(grant)) invalid();
    return Object.freeze({
        ...localAppInboxEndpoint(grant),
        inboxId: grant.inboxId,
        expiresAtMs: grant.expiresAtMs,
        capabilitySha256: localAppInboxCapabilityDigest(grant),
    });
}
export function validateLocalAppInboxTarget(value: unknown): LocalAppInboxTarget {
    exact(value, [...ENDPOINT, "inboxId", "capabilitySha256", "expiresAtMs"]);
    validateLocalAppInbox(Object.fromEntries(ENDPOINT.map((key) => [key, value[key]])));
    if (
        typeof value.inboxId !== "string" ||
        !HASH.test(value.inboxId) ||
        typeof value.capabilitySha256 !== "string" ||
        !HASH.test(value.capabilitySha256)
    )
        invalid();
    timestamp(value.expiresAtMs);
    return Object.freeze({ ...value }) as unknown as LocalAppInboxTarget;
}
export function validateLocalAppInboxReceipt(value: unknown): LocalAppInboxReceipt {
    exact(value, [
        "inboxId",
        "requestId",
        "bodySha256",
        "receivedAtMs",
        "expiresAtMs",
        "status",
        "replayed",
    ]);
    if (
        typeof value.inboxId !== "string" ||
        !HASH.test(value.inboxId) ||
        typeof value.requestId !== "string" ||
        !ID.test(value.requestId) ||
        typeof value.bodySha256 !== "string" ||
        !HASH.test(value.bodySha256) ||
        !["Pending", "Saved", "Dismissed"].includes(value.status as string) ||
        typeof value.replayed !== "boolean"
    )
        invalid();
    timestamp(value.receivedAtMs);
    timestamp(value.expiresAtMs);
    if (value.expiresAtMs <= value.receivedAtMs) invalid();
    return Object.freeze({ ...value }) as unknown as LocalAppInboxReceipt;
}
/** Explicit navigation only. The fragment carries opaque receipt IDs, never fields or authority. */
export function localAppInboxReviewUrl(destination: string, value: LocalAppInboxReceipt): string {
    const receipt = validateLocalAppInboxReceipt(value);
    const url = new URL(destination);
    if (
        url.href !== destination ||
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
    url.hash = new URLSearchParams({
        "oc-inbox": receipt.inboxId,
        "oc-request": receipt.requestId,
    }).toString();
    return url.href;
}
/** Validate stored ciphertext separately: it may exceed the 64 KiB plaintext/schema bound. */
export function validateLocalAppInboxDelivery(
    value: unknown,
    request: Pick<
        LocalDraftDeliveryRequest,
        | "appId"
        | "appRevision"
        | "actionId"
        | "destination"
        | "idempotencyKey"
        | "deliveryEncryption"
        | "deliveryInbox"
    >,
): LocalAppInboxDelivery {
    exact(value, ["version", "requestJson", "bodySha256"], ["receipt"]);
    if (
        value.version !== 1 ||
        typeof value.requestJson !== "string" ||
        new TextEncoder().encode(value.requestJson).byteLength > MAX_ENCRYPTED_REQUEST_BYTES ||
        typeof value.bodySha256 !== "string" ||
        !HASH.test(value.bodySha256) ||
        !request.deliveryInbox
    )
        invalid();
    let raw: unknown;
    try {
        raw = JSON.parse(value.requestJson);
    } catch {
        return invalid();
    }
    // Accept only our exact serializer, including key order; duplicate keys are never accepted.
    if (JSON.stringify(raw) !== value.requestJson) invalid();
    if (digest(new TextEncoder().encode(value.requestJson)) !== value.bodySha256) invalid();
    const encrypted = validateEncryptedLocalAppDeliveryRequest(raw);
    for (const key of [
        "appId",
        "appRevision",
        "actionId",
        "destination",
        "idempotencyKey",
    ] as const)
        if (encrypted[key] !== request[key]) invalid();
    if (
        encrypted.envelope.keyId !== request.deliveryEncryption?.keyId ||
        encrypted.envelope.recipientContext !== request.deliveryEncryption?.recipientContext
    )
        invalid();
    const receipt =
        value.receipt === undefined ? undefined : validateLocalAppInboxReceipt(value.receipt);
    if (
        receipt &&
        (receipt.requestId !== request.idempotencyKey ||
            receipt.bodySha256 !== value.bodySha256 ||
            (receipt.inboxId !== request.deliveryInbox.inboxId && !receipt.replayed))
    )
        invalid();
    return Object.freeze({
        version: 1,
        requestJson: value.requestJson,
        bodySha256: value.bodySha256,
        ...(receipt ? { receipt } : {}),
    });
}
