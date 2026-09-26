// Inert protocol fixtures only. They are not real credentials, signatures, JWTs, or accounts.
import { Certificate, type HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { vi } from "vitest";
import { deserializeFromMsgPack, serializeToMsgPack } from "@agent/utils/msgpack";


export const TEST_CANISTER = "aaaaa-aa";
export const TEST_CREDENTIAL_ID = Uint8Array.of(1, 3, 5, 7);
export const TEST_PUBLIC_KEY = Uint8Array.of(48, 3, 1, 2, 3);
export const TEST_EXPIRATION = BigInt(Date.now() + 300_000) * 1_000_000n;

export function completeCurrentUser() {
    return { Success: {
        user_id: Principal.anonymous().toUint8Array(), username: "synthetic-user",
        date_created: 1n, icp_account: Array(32).fill(0), referrals: [],
        is_platform_moderator: false, is_platform_operator: false,
        is_suspected_bot: false, diamond_membership_status: "Inactive",
        moderation_flags_enabled: 0, is_unique_person: false,
        total_chit_earned: 0, chit_balance: 0, streak: 0, max_streak: 0,
    } };
}

/** Mocks only IC transport/certificate verification; actual codecs, schemas and mappers run. */
export function syntheticIdentityTransport(mode: "certified" | "accepted" = "certified") {
    const replies = new Map<string, unknown>([
        ["lookup_webauthn_pubkey_msgpack", { Success: { pubkey: TEST_PUBLIC_KEY } }],
        ["check_auth_principal_v2_msgpack", { Success: {
            user_id: Principal.anonymous().toUint8Array(),
            originating_canister: Principal.anonymous().toUint8Array(), is_ii_principal: false,
        } }],
        ["prepare_delegation_msgpack", { Success: {
            user_key: TEST_PUBLIC_KEY, expiration: TEST_EXPIRATION, proof_jwt: "synthetic-not-a-jwt",
        } }],
        ["current_user_msgpack", completeCurrentUser()],
    ]);
    const calls: { method: string; args: Record<string, unknown>; callSync?: boolean }[] = [];
    let sessionKey: Uint8Array = TEST_PUBLIC_KEY;
    let certificateReply: Uint8Array = new Uint8Array();
    const requestId = new Uint8Array(32).fill(17);
    const rootKey = new Uint8Array(32).fill(19);
    const certificateBytes = Uint8Array.of(23);
    const take = (method: string) => {
        if (replies.has(method)) return replies.get(method);
        if (method === "get_delegation_msgpack") return { Success: {
            delegation: { pubkey: sessionKey, expiration: TEST_EXPIRATION },
            signature: new Uint8Array(64).fill(29),
        } };
        throw new Error(`Unexpected synthetic RPC: ${method}`);
    };
    const query = vi.fn(async (_canister: unknown, options: { methodName: string; arg: Uint8Array }) => {
        const args = deserializeFromMsgPack<Record<string, unknown>>(options.arg);
        calls.push({ method: options.methodName, args });
        return { status: "replied", reply: { arg: serializeToMsgPack(take(options.methodName)) } };
    });
    const call = vi.fn(async (_canister: unknown, options: { methodName: string; arg: Uint8Array; callSync?: boolean }) => {
        if (options.methodName !== "prepare_delegation_msgpack") throw new Error("Unexpected update");
        const args = deserializeFromMsgPack<Record<string, unknown>>(options.arg);
        calls.push({ method: options.methodName, args, callSync: options.callSync });
        sessionKey = args.session_key as Uint8Array;
        certificateReply = serializeToMsgPack(take(options.methodName));
        return { requestId, response: mode === "certified"
            ? { status: 200, body: { certificate: certificateBytes } }
            : { status: 202 } };
    });
    const readState = vi.fn(async () => ({ certificate: certificateBytes }));
    const certificate = vi.spyOn(Certificate, "create").mockImplementation(async () => ({
        lookup_path: (path: unknown[]) => {
            const last = path.at(-1);
            const label = last instanceof Uint8Array ? new TextDecoder().decode(last) : last;
            return { status: "Found", value: label === "status"
                ? new TextEncoder().encode("replied") : certificateReply };
        },
    }) as never);
    return {
        agent: { query, call, readState, rootKey } as unknown as HttpAgent,
        query, call, certificate, readState, replies, calls, rootKey, certificateBytes,
    };
}
