// Synthetic structural-test sessions. Signatures are intentionally inert and are NOT auth proofs.
import { type Signature } from "@icp-sdk/core/agent";
import { Delegation, DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import type { JsonnableIdentityKeyAndChain } from "../domain/identity";

export const NATIVE_TEST_CANISTER = "aaaaa-aa";
export const nativeTestPolicy = {
    existingAccountOnly: true,
    clientOnlyApps: true,
    identityCanister: NATIVE_TEST_CANISTER,
};

export function syntheticKeyChain(
    key: ECDSAKeyIdentity,
    expiry: bigint,
    targets?: Principal[],
): JsonnableIdentityKeyAndChain {
    const chain = DelegationChain.fromDelegations(
        [
            {
                delegation: new Delegation(key.getPublicKey().toDer(), expiry, targets),
                signature: new Uint8Array(64).fill(7) as Signature,
            },
        ],
        key.getPublicKey().toDer(),
    );
    return { key: key.getKeyPair(), delegation: chain.toJSON() };
}

export async function nativeSessionFixture(nowMs: number) {
    const authKey = await ECDSAKeyIdentity.generate();
    const ocKey = await ECDSAKeyIdentity.generate();
    const expiresAtMs = nowMs + 240_000;
    const expiry = BigInt(expiresAtMs) * 1_000_000n;
    return {
        authKey,
        ocKey,
        expiry,
        request: {
            kind: "setAuthIdentity" as const,
            isIIPrincipal: false,
            identity: syntheticKeyChain(authKey, expiry, [
                Principal.fromText(NATIVE_TEST_CANISTER),
            ]),
            nativeBrowserSession: { ocIdentity: syntheticKeyChain(ocKey, expiry), expiresAtMs },
        },
    };
}
