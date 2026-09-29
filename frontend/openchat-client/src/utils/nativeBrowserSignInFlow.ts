import { ECDSAKeyIdentity, type DelegationChain } from "@icp-sdk/core/identity";
import {
    createNativeBrowserAuthVerifier,
    type NativeBrowserAuthChallenge,
    type NativeBrowserAuthCandidate,
} from "./nativeBrowserAuth";

type CandidatePoll =
    | { kind: "submitted"; candidate: NativeBrowserAuthCandidate }
    | { kind: "pending" | "verifying" | "verified" | "failed" | "expired" | "cancelled" };
type Adapter<T> = {
    begin(value: {
        sessionPublicKeyDerHex: string;
        expectedUsername: string;
    }): Promise<NativeBrowserAuthChallenge>;
    open(url: string): Promise<unknown>;
    poll(attemptId: string): Promise<CandidatePoll>;
    cancel(attemptId: string): Promise<unknown>;
    complete(attemptId: string, accepted: boolean): Promise<unknown>;
    lookup(credentialId: Uint8Array): Promise<Uint8Array>;
    prove(
        authKey: ECDSAKeyIdentity,
        authChain: DelegationChain,
        expectedUsername: string,
        expiresAtMs: number,
    ): Promise<T>;
    activate(
        session: T,
        authKey: ECDSAKeyIdentity,
        authChain: DelegationChain,
        webAuthnKey: { credentialId: Uint8Array; publicKey: Uint8Array },
    ): Promise<void>;
};

const toHex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function pause(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Sign-in cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, 350);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            signal.removeEventListener("abort", abort);
            abort();
        }
    });
}

/** One browser attempt, no disk persistence and no automatic retry or account creation. */
export async function runNativeBrowserSignIn<T>(
    expectedUsername: string,
    identityCanister: string,
    adapter: Adapter<T>,
    options: { signal?: AbortSignal; onStatus?: (message: string) => void } = {},
): Promise<void> {
    const signal = options.signal;
    let challenge: NativeBrowserAuthChallenge | undefined;
    let accepted = false;
    const active = () => {
        if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
        if (challenge && Date.now() >= challenge.expiresAtMs)
            throw new Error("APK sign-in request expired");
    };
    const status = (text: string) => {
        try {
            options.onStatus?.(text);
        } catch {
            /* View cannot alter authorization. */
        }
    };
    try {
        if (
            expectedUsername.trim() !== expectedUsername ||
            !expectedUsername ||
            expectedUsername.length > 100 ||
            // eslint-disable-next-line no-control-regex -- Reject control characters before creating any native authentication request.
            /[\u0000-\u001f\u007f]/.test(expectedUsername)
        )
            throw new Error("Enter the expected existing username");
        active();
        const key = await ECDSAKeyIdentity.generate();
        active();
        const publicKey = toHex(new Uint8Array(key.getPublicKey().toDer()));
        challenge = await adapter.begin({ sessionPublicKeyDerHex: publicKey, expectedUsername });
        active();
        if (
            challenge.sessionPublicKeyDerHex !== publicKey ||
            challenge.identityCanister !== identityCanister ||
            challenge.expectedUsername !== expectedUsername
        )
            throw new Error("APK request binding failed");
        const verifier = createNativeBrowserAuthVerifier(challenge, { signal });
        status(
            "Complete the explicit sign-in in your browser, then return here. This local-test session lasts at most five minutes.",
        );
        await adapter.open(challenge.url);
        active();
        while (true) {
            const response = await adapter.poll(challenge.attemptId);
            active();
            if (response.kind === "pending") {
                await pause(signal);
                active();
                continue;
            }
            if (response.kind !== "submitted")
                throw new Error("APK sign-in did not provide a new response");
            const candidate = response.candidate;
            // Bound untrusted metadata before the first lookup; verifier checks the complete object.
            if (
                typeof candidate?.credentialIdHex !== "string" ||
                !/^(?:[0-9a-f]{2}){1,1024}$/.test(candidate.credentialIdHex)
            )
                throw new Error("Invalid credential identifier");
            const credentialId = Uint8Array.from(candidate.credentialIdHex.match(/../g)!, (b) =>
                parseInt(b, 16),
            );
            status(
                "Checking the passkey signature and existing account. No APK session is active yet.",
            );
            const publicKey = await adapter.lookup(credentialId);
            active();
            const proof = await verifier.verify(candidate, publicKey);
            active();
            const session = await adapter.prove(
                key,
                proof.chain,
                proof.expectedUsername,
                proof.authenticationExpiresAtMs,
            );
            active();
            // Native one-shot acceptance is the final cancellation/expiry gate before any activation.
            await adapter.complete(challenge.attemptId, true);
            accepted = true;
            active();
            await adapter.activate(session, key, proof.chain, {
                credentialId: proof.credentialId,
                publicKey,
            });
            status("Existing account verified. The local test session is open.");
            return;
        }
    } finally {
        if (challenge && !accepted) {
            // Teardown never sends credentials or replaces the primary failure.
            await adapter.cancel(challenge.attemptId).catch(() => undefined);
        }
    }
}
