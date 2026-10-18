import type { Identity } from "@icp-sdk/core/agent";
import type { LocalAppInboxEndpoint } from "./localAppInbox";
import { isLocalAppInboxGrant, validateLocalAppInbox } from "./localAppInbox";
import { localAppInboxUsesDevelopmentRootKey } from "./localAppInboxDelivery";

export type SetupCodeCreate = {
    request_id: string;
    claim_hash: Uint8Array;
    encrypted_context: Uint8Array;
    expires_at_ms: bigint;
};
export type SetupCodePoll =
    | { Waiting: { expires_at_ms: bigint } }
    | { Claimed: { expires_at_ms: bigint } }
    | { Completed: { encrypted_result: Uint8Array; expires_at_ms: bigint } };
export interface SetupCodeActor {
    create(request: SetupCodeCreate, signal: AbortSignal): Promise<{ expires_at_ms: bigint }>;
    poll(requestId: string, signal: AbortSignal): Promise<SetupCodePoll>;
    cancel(requestId: string, signal: AbortSignal): Promise<boolean>;
}

const failure = () =>
    new Error(
        "The app connection could not be verified. Check the connection or cancel; no setup was replaced.",
    );

/** Every operation is an update, signed only by this ephemeral attempt identity. */
export function createSetupCodeActor(
    endpoint: LocalAppInboxEndpoint,
    identity: Identity,
): SetupCodeActor {
    const checked = validateLocalAppInbox(endpoint);
    if (isLocalAppInboxGrant(checked)) throw failure();
    async function call(method: string, argument: unknown, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        const [{ Actor, HttpAgent }, { IDL }] = await Promise.all([
            import("@icp-sdk/core/agent"),
            import("@icp-sdk/core/candid"),
        ]);
        const expiry = IDL.Record({ expires_at_ms: IDL.Nat64 });
        const result = (ok: import("@icp-sdk/core/candid").IDL.Type) =>
            IDL.Variant({ Ok: ok, Err: IDL.Text });
        const factory = () =>
            IDL.Service({
                create_app_setup_code: IDL.Func(
                    [
                        IDL.Record({
                            request_id: IDL.Text,
                            claim_hash: IDL.Vec(IDL.Nat8),
                            encrypted_context: IDL.Vec(IDL.Nat8),
                            expires_at_ms: IDL.Nat64,
                        }),
                    ],
                    [result(expiry)],
                    [],
                ),
                poll_app_setup_code: IDL.Func(
                    [IDL.Text],
                    [
                        result(
                            IDL.Variant({
                                Waiting: expiry,
                                Claimed: expiry,
                                Completed: IDL.Record({
                                    encrypted_result: IDL.Vec(IDL.Nat8),
                                    expires_at_ms: IDL.Nat64,
                                }),
                            }),
                        ),
                    ],
                    [],
                ),
                cancel_app_setup_code: IDL.Func([IDL.Text], [result(IDL.Bool)], []),
            });
        const paths = new Set([
            "/api/v2/status",
            `/api/v4/canister/${checked.canisterId}/call`,
            ...["v2", "v3"].flatMap((version) =>
                ["call", "read_state"].map(
                    (name) => `/api/${version}/canister/${checked.canisterId}/${name}`,
                ),
            ),
        ]);
        const restrictedFetch: typeof fetch = (input, options) => {
            signal.throwIfAborted();
            const url = new URL(input instanceof Request ? input.url : String(input));
            const headers = new Headers(options?.headers);
            if (
                url.origin !== checked.host ||
                !paths.has(url.pathname) ||
                url.search ||
                url.hash ||
                url.username ||
                url.password ||
                headers.has("authorization") ||
                headers.has("cookie")
            )
                throw failure();
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
            identity,
            fetch: restrictedFetch,
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
        const raw = (await actor[method](argument)) as Record<string, unknown>;
        signal.throwIfAborted();
        if (!raw || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "Ok")) throw failure();
        return raw.Ok;
    }
    return {
        create: (value, signal) =>
            call("create_app_setup_code", value, signal) as Promise<{ expires_at_ms: bigint }>,
        poll: (id, signal) => call("poll_app_setup_code", id, signal) as Promise<SetupCodePoll>,
        cancel: (id, signal) => call("cancel_app_setup_code", id, signal) as Promise<boolean>,
    };
}
