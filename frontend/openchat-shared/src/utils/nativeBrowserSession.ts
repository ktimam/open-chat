import { DelegationChain, DelegationIdentity, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import type { JsonnableIdentityKeyAndChain } from "../domain/identity";
import type { SetAuthIdentity } from "../domain/worker";

export class NativeBrowserSessionError extends Error {
    readonly code = "invalid_native_browser_session";
    constructor() {
        super("The verified browser session is invalid, expired, or superseded.");
        this.name = "NativeBrowserSessionError";
    }
}

const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
const NS_PER_MS = 1_000_000n;
const MAX_LIFETIME_MS = 5 * 60_000;

type Policy = {
    existingAccountOnly?: boolean;
    clientOnlyApps?: boolean;
    identityCanister: string;
};

async function restoreSingle(source: JsonnableIdentityKeyAndChain) {
    if (!source || !source.delegation || source.delegation.delegations.length !== 1) {
        throw new NativeBrowserSessionError();
    }
    const pair = source.key;
    const isP256 = (key: CryptoKey, type: "public" | "private", usage: KeyUsage) =>
        key?.type === type && key.algorithm.name === "ECDSA" &&
        (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" && key.usages.includes(usage);
    if (!pair || !isP256(pair.publicKey, "public", "verify") || !isP256(pair.privateKey, "private", "sign")) {
        throw new NativeBrowserSessionError();
    }
    const chain = DelegationChain.fromJSON(source.delegation);
    const key = await ECDSAKeyIdentity.fromKeyPair(pair);
    const leaf = chain.delegations[0].delegation;
    if (!equal(key.getPublicKey().toDer(), leaf.pubkey)) throw new NativeBrowserSessionError();
    // fromKeyPair exports only the public key. Check the private half too, locally, without
    // generating a delegation or exposing this inert key-pair proof outside this function.
    const challenge = new TextEncoder().encode("OpenChat local session key-pair check v1");
    const algorithm = { name: "ECDSA", hash: "SHA-256" };
    const proof = await crypto.subtle.sign(algorithm, pair.privateKey, challenge);
    if (!await crypto.subtle.verify(algorithm, pair.publicKey, proof, challenge)) throw new NativeBrowserSessionError();
    return { identity: DelegationIdentity.fromDelegation(key, chain), leaf };
}

/**
 * Structural worker-side checks for a session whose signatures and official account mapping
 * were already verified by the explicit native-browser flow. This does NOT verify signatures
 * or authorize an external caller, and must never be exposed as a public auth callback.
 * It performs local key restoration/consistency checks: no network, persistence, or identity minting.
 */
export async function validateNativeBrowserSession(
    authIdentity: JsonnableIdentityKeyAndChain | undefined,
    supplied: SetAuthIdentity["nativeBrowserSession"],
    isIIPrincipal: boolean,
    policy: Policy,
    nowMs = Date.now(),
): Promise<{ authIdentity: DelegationIdentity; ocIdentity: DelegationIdentity; sessionExpiryMs: number }> {
    try {
        if (policy.existingAccountOnly !== true || policy.clientOnlyApps !== true || isIIPrincipal !== false ||
            authIdentity === undefined || supplied === undefined ||
            !Number.isSafeInteger(nowMs) || nowMs < 0 ||
            !Number.isSafeInteger(supplied.expiresAtMs) || supplied.expiresAtMs <= nowMs ||
            supplied.expiresAtMs > nowMs + MAX_LIFETIME_MS) throw new NativeBrowserSessionError();

        const expectedTarget = Principal.fromText(policy.identityCanister).toText();
        const auth = await restoreSingle(authIdentity);
        const oc = await restoreSingle(supplied.ocIdentity);
        const nowNs = BigInt(nowMs) * NS_PER_MS;
        if (auth.leaf.expiration !== BigInt(supplied.expiresAtMs) * NS_PER_MS ||
            auth.leaf.expiration <= nowNs || auth.leaf.expiration > BigInt(nowMs + MAX_LIFETIME_MS) * NS_PER_MS ||
            auth.leaf.targets?.length !== 1 || auth.leaf.targets[0].toText() !== expectedTarget ||
            oc.leaf.expiration <= nowNs || oc.leaf.expiration > auth.leaf.expiration ||
            (oc.leaf.targets !== undefined && oc.leaf.targets.length !== 0)) throw new NativeBrowserSessionError();
        return { authIdentity: auth.identity, ocIdentity: oc.identity,
            sessionExpiryMs: Number(oc.leaf.expiration / NS_PER_MS) };
    } catch {
        // Do not forward malformed key material or underlying crypto/parser diagnostics.
        throw new NativeBrowserSessionError();
    }
}
