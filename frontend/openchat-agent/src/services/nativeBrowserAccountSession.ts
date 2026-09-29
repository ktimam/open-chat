import { AnonymousIdentity, HttpAgent, type Identity, type Signature } from "@icp-sdk/core/agent";
import { DelegationChain, DelegationIdentity, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { NATIVE_SESSION_MAX_LIFETIME_MS } from "@shared/utils/nativeBrowserSession";
import type { CreatedUser, CurrentUserResponse } from "@shared";
import { Empty, UserIndexCurrentUserResponse } from "../typebox";
import { IdentityClient } from "./identity/identity.client";
import { SingleCanisterMsgpackAgent } from "./canisterAgent/msgpack";
import { currentUserResponse } from "./userIndex/mappers";

const FAILED = "The official OpenChat account could not be verified. Nothing was signed in.";
const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
function fail(): never {
    throw new Error(FAILED);
}
function active(expiresAtMs: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
    if (Date.now() >= expiresAtMs) fail();
}
function officialHost(icUrl: string): string {
    // This is a local APK using official services, never a configurable trust-root/replica bridge.
    const url = new URL(icUrl);
    if (
        url.origin !== "https://icp-api.io" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
    )
        fail();
    return url.origin;
}

// Do not reuse the normal cache-backed UserIndex client or query retries/logging. Auth proof must
// come from fresh verified responses, and raw provider errors may contain signed requests.
class FreshIdentityClient extends IdentityClient {
    protected override executeQuery<From, To>(
        call: () => Promise<From>,
        mapper: (value: From) => To | Promise<To>,
    ): Promise<To> {
        return call()
            .then(mapper)
            .catch(() => fail());
    }
    protected override writeTrace(): void {
        /* No sign-in trace payloads. */
    }
}
class FreshProfileClient extends SingleCanisterMsgpackAgent {
    constructor(identity: Identity, agent: HttpAgent, canister: string) {
        super(identity, agent, canister, "UserIndex");
    }
    protected override executeQuery<From, To>(
        call: () => Promise<From>,
        mapper: (value: From) => To | Promise<To>,
    ): Promise<To> {
        return call()
            .then(mapper)
            .catch(() => fail());
    }
    protected override writeTrace(): void {
        /* No sign-in trace payloads. */
    }
    currentUser(): Promise<CurrentUserResponse> {
        return this.query(
            "current_user",
            {},
            currentUserResponse,
            Empty,
            UserIndexCurrentUserResponse,
        );
    }
}

/** Bounded isolated transport: pinned HTTPS origin, built-in mainnet root, fresh query signatures,
 * no cache/cookies/redirects and no automatic resubmission of the single prepare update. */
async function freshAgent(
    identity: Identity,
    icUrl: string,
    expiresAtMs: number,
    signal?: AbortSignal,
): Promise<HttpAgent> {
    const host = officialHost(icUrl);
    active(expiresAtMs, signal);
    const deadline = AbortSignal.timeout(Math.min(45_000, expiresAtMs - Date.now()));
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let submitted = false;
    const agent = await HttpAgent.create({
        identity,
        host,
        verifyQuerySignatures: true,
        retryTimes: 0,
        fetch: async (input, init) => {
            active(expiresAtMs, combined);
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (
                url.origin !== host ||
                url.username ||
                url.password ||
                url.search ||
                url.hash ||
                !/^\/api\/v[234]\/(?:status|(?:canister|subnet)\/[^/]+\/(?:query|call|read_state))$/.test(
                    url.pathname,
                )
            )
                fail();
            const update = url.pathname.endsWith("/call");
            if (update && submitted) fail();
            if (update) submitted = true;
            try {
                const response = await fetch(input, {
                    ...init,
                    cache: "no-store",
                    credentials: "omit",
                    redirect: "error",
                    signal: init?.signal ? AbortSignal.any([combined, init.signal]) : combined,
                });
                active(expiresAtMs, combined);
                return response;
            } catch {
                fail();
            }
        },
    });
    active(expiresAtMs, signal);
    return agent;
}

/** Public lookup is independent of the candidate/browser and deliberately bypasses local key cache. */
export async function lookupNativeBrowserCredential(
    identityCanister: string,
    icUrl: string,
    credentialId: Uint8Array,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    try {
        Principal.fromText(identityCanister);
        if (
            !(credentialId instanceof Uint8Array) ||
            credentialId.length === 0 ||
            credentialId.length > 4096
        )
            fail();
        const id = credentialId.slice();
        const identity = new AnonymousIdentity();
        const deadline = Date.now() + 45_000;
        const agent = await freshAgent(identity, icUrl, deadline, signal);
        const root = await new FreshIdentityClient(
            identity,
            agent,
            identityCanister,
        ).lookupWebAuthnPubKey(id);
        active(deadline, signal);
        if (root === undefined || root.length < 32 || root.length > 1024) fail();
        return root.slice();
    } catch {
        if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
        fail();
    }
}

export type NativeBrowserAccountSessionRequest = {
    authKey: ECDSAKeyIdentity;
    authChain: DelegationChain;
    expectedUsername: string;
    expiresAtMs: number;
    identityCanister: string;
    userIndexCanister: string;
    icUrl: string;
    signal?: AbortSignal;
    // Restored sessions must still belong to the originally verified immutable account IDs.
    expectedAccount?: { userId: string; ocPrincipal: string };
};

/** Call after local signature validation, or with a saved AUTH identity requiring fresh proof.
 * Returns a proven candidate, never stores
 * identities, activates a worker, creates/registers a user, links accounts, or retries an update.
 * The native attempt must still be completed successfully before the caller activates this result.
 */
export async function establishNativeBrowserAccountSession(
    input: NativeBrowserAccountSessionRequest,
): Promise<{
    ocKey: ECDSAKeyIdentity;
    ocChain: DelegationChain;
    profile: CreatedUser;
}> {
    const {
        authKey,
        expectedUsername,
        expiresAtMs,
        identityCanister,
        userIndexCanister,
        icUrl,
        signal,
    } = input;
    try {
        const authChain = DelegationChain.fromJSON(input.authChain.toJSON());
        const target = Principal.fromText(identityCanister);
        Principal.fromText(userIndexCanister);
        officialHost(icUrl);
        const auth = authChain.delegations[0]?.delegation;
        if (
            !Number.isSafeInteger(expiresAtMs) ||
            expiresAtMs > Date.now() + NATIVE_SESSION_MAX_LIFETIME_MS ||
            typeof expectedUsername !== "string" ||
            expectedUsername.length === 0 ||
            expectedUsername.length > 100 ||
            expectedUsername !== expectedUsername.trim() ||
            authChain.delegations.length !== 1 ||
            !equal(auth.pubkey, authKey.getPublicKey().toDer()) ||
            auth.targets?.length !== 1 ||
            !equal(auth.targets[0].toUint8Array(), target.toUint8Array()) ||
            auth.expiration !== BigInt(expiresAtMs) * 1_000_000n
        )
            fail();
        active(expiresAtMs, signal);
        const identity = DelegationIdentity.fromDelegation(authKey, authChain);
        const agent = await freshAgent(identity, icUrl, expiresAtMs, signal);
        const client = new FreshIdentityClient(identity, agent, identityCanister);
        const mapping = await client.checkAuthPrincipal();
        active(expiresAtMs, signal);
        if (
            mapping.kind !== "success" ||
            mapping.userId === undefined ||
            mapping.isIIPrincipal ||
            (input.expectedAccount !== undefined && mapping.userId !== input.expectedAccount.userId)
        )
            fail();
        const ocKey = await ECDSAKeyIdentity.generate();
        active(expiresAtMs, signal);
        const ocDer = ocKey.getPublicKey().toDer();
        // Reserve time for canister processing so server-relative TTL cannot exceed the AUTH expiry.
        // The returned exact expiry is checked again; clock skew fails closed, never widens authority.
        const remainingMs = expiresAtMs - Date.now() - 10_000;
        if (remainingMs <= 0) fail();
        const prepared = await client.prepareDelegation(
            ocDer,
            false,
            BigInt(remainingMs) * 1_000_000n,
        );
        active(expiresAtMs, signal);
        if (
            prepared.kind !== "success" ||
            prepared.expiration <= BigInt(Date.now()) * 1_000_000n ||
            prepared.expiration > auth.expiration ||
            prepared.userKey.length < 32 ||
            prepared.userKey.length > 4096
        )
            fail();
        for (let attempt = 0; attempt < 5; attempt++) {
            const result = await client.getDelegation(ocDer, prepared.expiration);
            active(expiresAtMs, signal);
            if (result.kind === "not_found") {
                if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 200));
                active(expiresAtMs, signal);
                continue;
            }
            if (
                result.kind !== "success" ||
                !equal(result.delegation.pubkey, ocDer) ||
                result.delegation.expiration !== prepared.expiration ||
                result.delegation.targets !== undefined ||
                result.signature.length < 32 ||
                result.signature.length > 32_768
            )
                fail();
            const ocChain = DelegationChain.fromDelegations(
                [
                    {
                        delegation: result.delegation,
                        signature: result.signature.slice() as Signature,
                    },
                ],
                prepared.userKey.slice(),
            );
            const ocIdentity = DelegationIdentity.fromDelegation(ocKey, ocChain);
            if (
                input.expectedAccount !== undefined &&
                ocIdentity.getPrincipal().toString() !== input.expectedAccount.ocPrincipal
            )
                fail();
            const ocAgent = await freshAgent(
                ocIdentity,
                icUrl,
                Number(prepared.expiration / 1_000_000n),
                signal,
            );
            const profile = await new FreshProfileClient(
                ocIdentity,
                ocAgent,
                userIndexCanister,
            ).currentUser();
            active(Number(prepared.expiration / 1_000_000n), signal);
            if (
                profile.kind !== "created_user" ||
                (input.expectedAccount === undefined && profile.username !== expectedUsername) ||
                profile.userId !== mapping.userId
            )
                fail();
            return { ocKey, ocChain, profile };
        }
        fail();
    } catch {
        if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
        fail();
    }
}
