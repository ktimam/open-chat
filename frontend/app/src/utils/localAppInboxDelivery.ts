import type { LocalDraftDeliveryRequest } from "./localAppDrafts";
import { localAppDecodeBase64Url, sealLocalAppDelivery } from "./localAppEncryption";
import {
    isLocalAppInboxGrant,
    localAppInboxSha256,
    localAppInboxTarget,
    validateLocalAppInbox,
    validateLocalAppInboxDelivery,
    validateLocalAppInboxReceipt,
    type LocalAppInboxGrant,
    type LocalAppInboxDelivery,
    type LocalAppInboxReceipt,
} from "./localAppInbox";
import { localAppDeliveryStatus } from "./localAppRelayDelivery";

export type LocalAppInboxDeposit = (
    grant: LocalAppInboxGrant,
    requestId: string,
    body: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
) => Promise<LocalAppInboxReceipt>;
const failure = () =>
    new Error(
        "The app inbox could not confirm durable receipt. Nothing will be retried automatically.",
    );

/** Local replica trust is restricted to a development build and explicit loopback/tailnet hosts.
 * Production always verifies the IC root key; a catalog can never opt out of verification. */
export function localAppInboxUsesDevelopmentRootKey(host: string, development: boolean): boolean {
    const url = new URL(host);
    return (
        development &&
        (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
            (url.protocol === "https:" && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)))
    );
}

/** Anonymous, fixed Candid protocol. Never borrows OpenChat identity, cookies or credentials. */
export const depositLocalAppInbox: LocalAppInboxDeposit = async (
    supplied,
    requestId,
    body,
    signal,
) => {
    const checked = validateLocalAppInbox(supplied);
    if (!isLocalAppInboxGrant(checked)) throw failure();
    signal.throwIfAborted();
    const [{ Actor, AnonymousIdentity, HttpAgent }, { IDL }] = await Promise.all([
        import("@icp-sdk/core/agent"),
        import("@icp-sdk/core/candid"),
    ]);
    const Status = IDL.Variant({ Pending: IDL.Null, Saved: IDL.Null, Dismissed: IDL.Null });
    const Receipt = IDL.Record({
        inbox_id: IDL.Text,
        request_id: IDL.Text,
        body_sha256: IDL.Vec(IDL.Nat8),
        received_at_ms: IDL.Nat64,
        expires_at_ms: IDL.Nat64,
        status: Status,
        replayed: IDL.Bool,
    });
    const ErrorType = IDL.Variant(
        Object.fromEntries(
            [
                "NotAuthorized",
                "InvalidRequest",
                "NotFound",
                "Expired",
                "Revoked",
                "Conflict",
                "Capacity",
                "CounterExhausted",
            ].map((name) => [name, IDL.Null]),
        ),
    );
    const factory = () =>
        IDL.Service({
            deposit_encrypted_inbox: IDL.Func(
                [
                    IDL.Record({
                        inbox_id: IDL.Text,
                        write_capability: IDL.Vec(IDL.Nat8),
                        request_id: IDL.Text,
                        encrypted_payload: IDL.Vec(IDL.Nat8),
                    }),
                ],
                [IDL.Variant({ Ok: Receipt, Err: ErrorType })],
                [],
            ),
        });
    const allowedPaths = new Set([
        "/api/v2/status",
        `/api/v4/canister/${checked.canisterId}/call`,
        ...["v2", "v3"].flatMap((version) =>
            ["call", "read_state"].map(
                (method) => `/api/${version}/canister/${checked.canisterId}/${method}`,
            ),
        ),
    ]);
    const publicFetch: typeof fetch = async (input, options) => {
        signal.throwIfAborted();
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
            url.origin !== checked.host ||
            !allowedPaths.has(url.pathname) ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
        )
            throw failure();
        const headers = new Headers(options?.headers);
        if (headers.has("authorization") || headers.has("cookie")) throw failure();
        return fetch(input, {
            ...options,
            headers,
            signal,
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            cache: "no-store",
        });
    };
    const agent = await HttpAgent.create({
        host: checked.host,
        identity: new AnonymousIdentity(),
        fetch: publicFetch,
        retryTimes: 0,
        shouldFetchRootKey: false,
        shouldSyncTime: false,
        logToConsole: false,
    });
    if (
        localAppInboxUsesDevelopmentRootKey(
            checked.host,
            import.meta.env.OC_BUILD_ENV === "development" &&
                import.meta.env.OC_UNOFFICIAL_CLIENT === "true",
        )
    )
        await agent.fetchRootKey();
    signal.throwIfAborted();
    const actor = Actor.createActor(factory, { agent, canisterId: checked.canisterId });
    const result = (await actor.deposit_encrypted_inbox({
        inbox_id: checked.inboxId,
        write_capability: localAppDecodeBase64Url(checked.writeCapability, 32),
        request_id: requestId,
        encrypted_payload: body,
    })) as Record<string, unknown>;
    signal.throwIfAborted();
    if (!result || Object.keys(result).length !== 1 || !Object.hasOwn(result, "Ok"))
        throw failure();
    const raw = result.Ok as Record<string, unknown>;
    if (
        !raw ||
        Object.keys(raw).sort().join(",") !==
            "body_sha256,expires_at_ms,inbox_id,received_at_ms,replayed,request_id,status"
    )
        throw failure();
    if (
        !(raw.body_sha256 instanceof Uint8Array) ||
        raw.body_sha256.length !== 32 ||
        typeof raw.received_at_ms !== "bigint" ||
        typeof raw.expires_at_ms !== "bigint" ||
        raw.received_at_ms > BigInt(Number.MAX_SAFE_INTEGER) ||
        raw.expires_at_ms > BigInt(Number.MAX_SAFE_INTEGER) ||
        !raw.status ||
        typeof raw.status !== "object" ||
        Object.keys(raw.status).length !== 1 ||
        Object.values(raw.status)[0] !== null
    )
        throw failure();
    return validateLocalAppInboxReceipt({
        inboxId: raw.inbox_id,
        requestId: raw.request_id,
        bodySha256: Array.from(raw.body_sha256, (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
        ),
        receivedAtMs: Number(raw.received_at_ms),
        expiresAtMs: Number(raw.expires_at_ms),
        status: Object.keys(raw.status)[0],
        replayed: raw.replayed,
    });
};

/** Encrypt once and durably record exact wire bytes BEFORE calling the app-owned inbox.
 * No app window, processor or user-account identity participates in this transport. */
export async function deliverLocalAppToInbox(
    request: LocalDraftDeliveryRequest,
    signal: AbortSignal,
    options: {
        grant: LocalAppInboxGrant;
        saved?: LocalAppInboxDelivery;
        persist: (value: LocalAppInboxDelivery) => Promise<void>;
        deposit?: LocalAppInboxDeposit;
        now?: () => number;
    },
): Promise<{ kind: "delivered" | "uncertain" }> {
    try {
        signal.throwIfAborted();
        const target = await localAppInboxTarget(options.grant);
        if (
            !request.deliveryInbox ||
            Object.entries(target).some(
                ([key, value]) => value !== request.deliveryInbox![key as keyof typeof target],
            ) ||
            target.expiresAtMs <= (options.now ?? Date.now)()
        )
            throw failure();
        let saved = options.saved;
        if (!saved) {
            const requestJson = JSON.stringify(await sealLocalAppDelivery(request, signal));
            saved = validateLocalAppInboxDelivery(
                {
                    version: 1,
                    requestJson,
                    bodySha256: await localAppInboxSha256(new TextEncoder().encode(requestJson)),
                },
                request,
            );
        } else saved = validateLocalAppInboxDelivery(saved, request);
        const body = new TextEncoder().encode(saved.requestJson);
        if ((await localAppInboxSha256(body)) !== saved.bodySha256) throw failure();
        signal.throwIfAborted();
        await options.persist(saved);
        signal.throwIfAborted();
        // Even a manual retry uses the SAME stored ciphertext, never a new encryption.
        const receipt = await (options.deposit ?? depositLocalAppInbox)(
            options.grant,
            request.idempotencyKey,
            body,
            signal,
        );
        signal.throwIfAborted();
        const received = validateLocalAppInboxDelivery({ ...saved, receipt }, request);
        if (
            receipt.expiresAtMs <= (options.now ?? Date.now)() ||
            receipt.receivedAtMs > (options.now ?? Date.now)() + 60_000
        )
            throw failure();
        await options.persist(received);
        signal.throwIfAborted();
        localAppDeliveryStatus.set({
            importId: request.idempotencyKey,
            status:
                receipt.status === "Saved"
                    ? "saved"
                    : receipt.status === "Dismissed"
                      ? "rejected"
                      : "received",
        });
        return { kind: "delivered" };
    } catch {
        // The exact encrypted request is retained after unknown outcomes. No auto retry/fallback.
        return { kind: "uncertain" };
    }
}
