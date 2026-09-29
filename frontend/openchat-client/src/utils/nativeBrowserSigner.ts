import { IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, requestIdOf } from "@icp-sdk/core/agent";
import { Delegation, DelegationChain } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { requestBrowserPasskeyAssertion } from "./browserPasskey";
import {
    createNativeBrowserAuthVerifier,
    type NativeBrowserAuthCandidate,
    type NativeBrowserAuthChallenge,
} from "./nativeBrowserAuth";

const toHex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** No storage or submission. A gesture signs only the fresh APK key and the displayed short lifetime. */
export async function signNativeBrowserChallenge(
    challenge: NativeBrowserAuthChallenge,
    officialIdentityCanister: string,
    lookup: (credentialId: Uint8Array) => Promise<Uint8Array>,
    signal?: AbortSignal,
): Promise<NativeBrowserAuthCandidate> {
    if (
        challenge.origin !== location.origin ||
        challenge.identityCanister !== officialIdentityCanister
    ) {
        throw new Error("Unexpected browser sign-in destination");
    }
    const verifier = createNativeBrowserAuthVerifier(challenge, { signal });
    const key = Uint8Array.from(challenge.sessionPublicKeyDerHex.match(/../g)!, (b) =>
        parseInt(b, 16),
    );
    const delegation = new Delegation(key, BigInt(challenge.delegationExpiresAtMs) * 1_000_000n, [
        Principal.fromText(officialIdentityCanister),
    ]);
    const bytes = Uint8Array.from([
        ...IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR,
        ...requestIdOf({ ...delegation }),
    ]);
    // Call the picker before any await, so this operation remains bound to the user's click.
    const assertion = await requestBrowserPasskeyAssertion(
        "localhost",
        bytes,
        undefined,
        signal,
        "required",
    );
    const rootKey = await lookup(assertion.credentialId);
    const candidate: NativeBrowserAuthCandidate = {
        protocol: challenge.protocol,
        attemptId: challenge.attemptId,
        nonce: challenge.nonce,
        credentialIdHex: toHex(assertion.credentialId),
        delegation: DelegationChain.fromDelegations(
            [{ delegation, signature: assertion.signature }],
            rootKey,
        ).toJSON(),
    };
    // Independent APK verification is still required: this check is not authority to activate it.
    await verifier.verify(candidate, rootKey);
    return candidate;
}
