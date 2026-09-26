import { invoke } from "@tauri-apps/api/core";

/** Public transport metadata. Signing and accepting are separate explicit, verified operations. */
export type LocalBrowserAuthChallenge = {
    protocol: "openchat.local-browser-auth.v1";
    attemptId: string;
    nonce: string;
    origin: string;
    url: string;
    sessionPublicKeyDerHex: string;
    expectedUsername: string;
    identityCanister: string;
    identityTargetHex: string;
    expiresAtMs: number;
    delegationExpiresAtMs: number;
    clientLabel: "OpenChat Fork · Local Test";
};

export type LocalBrowserAuthCandidate = {
    protocol: "openchat.local-browser-auth.v1";
    attemptId: string;
    nonce: string;
    credentialIdHex: string;
    delegation: {
        publicKey: string;
        delegations: {
            delegation: { pubkey: string; expiration: string; targets: string[] };
            signature: string;
        }[];
    };
};

export type LocalBrowserAuthPollResult =
    | { kind: "pending" | "verifying" | "verified" | "failed" | "expired" | "cancelled" }
    | { kind: "submitted"; candidate: LocalBrowserAuthCandidate };

export function beginLocalBrowserAuth(payload: {
    sessionPublicKeyDerHex: string;
    expectedUsername: string;
}): Promise<LocalBrowserAuthChallenge> {
    return invoke("plugin:oc|begin_local_browser_auth", { payload });
}

export function pollLocalBrowserAuth(attemptId: string): Promise<LocalBrowserAuthPollResult> {
    return invoke("plugin:oc|poll_local_browser_auth", { attemptId });
}

export function cancelLocalBrowserAuth(attemptId: string): Promise<void> {
    return invoke("plugin:oc|cancel_local_browser_auth", { attemptId });
}

/** Call true only after local signature checks AND fresh official-account proof have passed. */
export function completeLocalBrowserAuth(attemptId: string, accepted: boolean): Promise<void> {
    return invoke("plugin:oc|complete_local_browser_auth", { attemptId, accepted });
}
