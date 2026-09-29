import {
    DER_COSE_OID,
    IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR,
    requestIdOf,
    unwrapDER,
    wrapDER,
} from "@icp-sdk/core/agent";
import { DelegationChain, type JsonnableDelegationChain } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { NATIVE_SESSION_MAX_LIFETIME_MS } from "@shared/utils/nativeBrowserSession";

export const NATIVE_BROWSER_AUTH_PROTOCOL = "openchat.local-browser-auth.v1";
export type NativeBrowserAuthChallenge = {
    protocol: typeof NATIVE_BROWSER_AUTH_PROTOCOL;
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
export type NativeBrowserAuthCandidate = {
    protocol: typeof NATIVE_BROWSER_AUTH_PROTOCOL;
    attemptId: string;
    nonce: string;
    credentialIdHex: string;
    delegation: JsonnableDelegationChain;
};

function invalid(): never {
    throw new Error("Invalid native browser authentication response");
}
const equal = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
const base64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function hex(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum * 2 ||
        !/^(?:[0-9a-fA-F]{2})+$/.test(value)
    )
        invalid();
    return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
    )
        invalid();
    return value as Record<string, unknown>;
}

/** Only the two small, definite-length CBOR maps this bridge accepts; not a general CBOR decoder.
 * Reject duplicate keys, trailing bytes, non-minimal lengths and unsupported types before parsing.
 */
function cborMap(bytes: Uint8Array, tagged: boolean): Map<string | number, unknown> {
    let offset = 0;
    const byte = () => {
        if (offset >= bytes.length) invalid();
        return bytes[offset++];
    };
    const head = (): [number, number] => {
        const b = byte();
        const info = b & 31;
        let length = info;
        if (info === 24) {
            length = byte();
            if (length < 24) invalid();
        } else if (info === 25) {
            length = byte() * 256 + byte();
            if (length <= 255) invalid();
        } else if (info >= 26) invalid();
        return [b >> 5, length];
    };
    const scalar = (): string | number | Uint8Array<ArrayBuffer> => {
        const [major, length] = head();
        if (major === 0) return length;
        if (major === 1) return -1 - length;
        if ((major !== 2 && major !== 3) || offset + length > bytes.length) invalid();
        const data = bytes.slice(offset, (offset += length));
        return major === 2 ? new Uint8Array(data) : decoder.decode(data);
    };
    if (tagged) {
        const [major, tag] = head();
        if (major !== 6 || tag !== 55799) invalid();
    }
    const [major, size] = head();
    if (major !== 5 || size > 8) invalid();
    const map = new Map<string | number, unknown>();
    for (let i = 0; i < size; i++) {
        const key = scalar();
        if (key instanceof Uint8Array || map.has(key)) invalid();
        map.set(key, scalar());
    }
    if (offset !== bytes.length) invalid();
    return map;
}

/** WebAuthn ES256 uses ASN.1 DER integers; WebCrypto ECDSA expects fixed-width r || s. */
function es256Signature(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2)
        invalid();
    const result = new Uint8Array(64);
    let offset = 2;
    for (let i = 0; i < 2; i++) {
        if (bytes[offset++] !== 2) invalid();
        const size = bytes[offset++];
        if (size < 1 || size > 33 || offset + size > bytes.length) invalid();
        let integer = bytes.slice(offset, (offset += size));
        if (integer[0] & 0x80) invalid();
        if (integer[0] === 0 && integer.length > 1) {
            if (!(integer[1] & 0x80)) invalid();
            integer = integer.slice(1);
        }
        if (integer.length > 32 || integer.every((v) => v === 0)) invalid();
        result.set(integer, i * 32 + 32 - integer.length);
    }
    if (offset !== bytes.length) invalid();
    return result;
}

// JSON.parse establishes grammar. Then scan strings/containers to reject duplicate keys (including
// escaped spellings), avoiding disagreement between JavaScript and the IC's JSON parser.
function clientDataJson(text: string): Record<string, unknown> {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
    const stack: (Set<string> | undefined)[] = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "{" || c === "[") {
            stack.push(c === "{" ? new Set() : undefined);
            if (stack.length > 8) invalid();
        } else if (c === "}" || c === "]") stack.pop();
        else if (c === '"') {
            const start = i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === "\\") i++;
                i++;
            }
            let next = i + 1;
            while (/\s/.test(text[next] ?? "x")) next++;
            if (text[next] === ":") {
                const key = JSON.parse(text.slice(start, i + 1)) as string;
                const keys = stack[stack.length - 1];
                if (keys === undefined || keys.has(key)) invalid();
                keys.add(key);
            }
        }
    }
    return parsed;
}

function active(
    challenge: NativeBrowserAuthChallenge,
    now: () => number,
    signal?: AbortSignal,
): void {
    if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
    const time = now();
    if (
        !Number.isSafeInteger(time) ||
        time >= challenge.expiresAtMs ||
        time >= challenge.delegationExpiresAtMs
    )
        invalid();
}

/**
 * Creates a single-use verifier, not an authenticated session. The caller must pass a fresh native
 * challenge (and fresh native key) per attempt. The nonce is transport binding, NOT part of the IC
 * signed challenge; the fresh exact delegated public key supplies the signed attempt binding.
 *
 * expectedRootPublicKeyDer must come from a fresh, independently signature-verified official
 * credential-ID lookup, never from the browser candidate or a cached mapping. Success proves the
 * local WebAuthn signature only. Official authenticated account/profile checks must still match
 * expectedUsername before storing or activating either the AUTH identity or an OC identity.
 *
 * No fetch, storage, native command, signing or other transport is performed by this helper.
 */
export function createNativeBrowserAuthVerifier(
    challengeInput: NativeBrowserAuthChallenge,
    options: { now?: () => number; signal?: AbortSignal } = {},
): {
    verify: (
        candidate: unknown,
        expectedRootPublicKeyDer: Uint8Array,
    ) => Promise<{
        chain: DelegationChain;
        credentialId: Uint8Array;
        expectedUsername: string;
        authenticationExpiresAtMs: number;
    }>;
    cancel: () => void;
} {
    const challenge = Object.freeze({ ...challengeInput });
    const now = options.now ?? Date.now;
    const start = now();
    const origin = new URL(challenge.origin);
    const target = Principal.fromText(challenge.identityCanister);
    const sessionKey = hex(challenge.sessionPublicKeyDerHex, 512);
    if (
        challenge.protocol !== NATIVE_BROWSER_AUTH_PROTOCOL ||
        !/^[a-f0-9]{32}$/.test(challenge.attemptId) ||
        !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
        origin.protocol !== "http:" ||
        origin.hostname !== "localhost" ||
        origin.port === "" ||
        origin.origin !== challenge.origin ||
        challenge.url !== `${origin.origin}/sign-in` ||
        !equal(hex(challenge.identityTargetHex, 29), target.toUint8Array()) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(challenge.expiresAtMs) ||
        !Number.isSafeInteger(challenge.delegationExpiresAtMs) ||
        challenge.expiresAtMs <= start ||
        challenge.expiresAtMs > start + 120_000 ||
        challenge.delegationExpiresAtMs <= challenge.expiresAtMs ||
        challenge.delegationExpiresAtMs > start + NATIVE_SESSION_MAX_LIFETIME_MS ||
        typeof challenge.expectedUsername !== "string" ||
        challenge.expectedUsername.trim() !== challenge.expectedUsername ||
        challenge.expectedUsername.length < 1 ||
        challenge.expectedUsername.length > 100 ||
        // eslint-disable-next-line no-control-regex -- Authentication names must reject literal ASCII control characters.
        /[\u0000-\u001f\u007f]/.test(challenge.expectedUsername) ||
        challenge.clientLabel !== "OpenChat Fork · Local Test"
    )
        invalid();
    let used = false;
    let cancelled = false;
    const checkActive = () => {
        if (cancelled) invalid();
        active(challenge, now, options.signal);
    };

    return {
        cancel: () => {
            cancelled = true;
        },
        async verify(candidateInput, expectedRootPublicKeyDer) {
            if (used) invalid();
            used = true; // Consume even invalid submissions; a retry requires a new native key/attempt.
            checkActive();
            const candidate = record(candidateInput, [
                "protocol",
                "attemptId",
                "nonce",
                "credentialIdHex",
                "delegation",
            ]);
            if (
                candidate.protocol !== challenge.protocol ||
                candidate.attemptId !== challenge.attemptId ||
                candidate.nonce !== challenge.nonce
            )
                invalid();
            const credentialId = hex(candidate.credentialIdHex, 4096);
            const json = record(candidate.delegation, ["publicKey", "delegations"]);
            const rootDer = hex(json.publicKey, 1024);
            if (
                !(expectedRootPublicKeyDer instanceof Uint8Array) ||
                !equal(rootDer, expectedRootPublicKeyDer)
            )
                invalid();
            if (!Array.isArray(json.delegations) || json.delegations.length !== 1) invalid();
            const link = record(json.delegations[0], ["delegation", "signature"]);
            const d = record(link.delegation, ["pubkey", "expiration", "targets"]);
            if (
                !equal(hex(d.pubkey, 512), sessionKey) ||
                typeof d.expiration !== "string" ||
                !/^[1-9a-f][0-9a-f]{0,15}$/i.test(d.expiration) ||
                BigInt(`0x${d.expiration}`) !==
                    BigInt(challenge.delegationExpiresAtMs) * 1_000_000n ||
                !Array.isArray(d.targets) ||
                d.targets.length !== 1 ||
                !equal(hex(d.targets[0], 29), target.toUint8Array())
            )
                invalid();

            // Copy only bounded, validated primitives; later caller mutations cannot change verification.
            const wireBytes = hex(link.signature, 32_768);
            const chain = DelegationChain.fromJSON({
                publicKey: json.publicKey as string,
                delegations: [
                    {
                        signature: link.signature as string,
                        delegation: {
                            pubkey: d.pubkey as string,
                            expiration: d.expiration as string,
                            targets: [d.targets[0] as string],
                        },
                    },
                ],
            });
            const wire = cborMap(wireBytes, true);
            if (
                wire.size !== 3 ||
                !wire.has("authenticator_data") ||
                !wire.has("client_data_json") ||
                !wire.has("signature")
            )
                invalid();
            const authData = wire.get("authenticator_data");
            const clientJson = wire.get("client_data_json");
            const signature = wire.get("signature");
            if (
                !(authData instanceof Uint8Array) ||
                authData.length < 37 ||
                authData.length > 4096 ||
                typeof clientJson !== "string" ||
                clientJson.length > 8192 ||
                !(signature instanceof Uint8Array)
            )
                invalid();
            const client = clientDataJson(clientJson);
            const delegation = chain.delegations[0].delegation;
            const signedChallenge = Uint8Array.from([
                ...IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR,
                ...requestIdOf({ ...delegation }),
            ]);
            if (
                typeof client !== "object" ||
                client === null ||
                Array.isArray(client) ||
                client.type !== "webauthn.get" ||
                client.origin !== origin.origin ||
                client.challenge !== base64url(signedChallenge) ||
                (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
                client.topOrigin !== undefined ||
                (authData[32] & 5) !== 5 ||
                (authData[32] & 0x40) !== 0 || // Attested credential data is not an assertion.
                ((authData[32] & 0x10) !== 0 && (authData[32] & 8) === 0)
            )
                invalid();
            const rpHash = new Uint8Array(
                await crypto.subtle.digest("SHA-256", encoder.encode("localhost")),
            );
            checkActive();
            if (!equal(authData.slice(0, 32), rpHash)) invalid();
            const coseBytes = unwrapDER(rootDer, DER_COSE_OID);
            // SDK unwrapDER does not itself check the enclosing sequence length.
            if (!equal(rootDer, wrapDER(coseBytes, DER_COSE_OID))) invalid();
            const cose = cborMap(coseBytes, false);
            const x = cose.get(-2);
            const y = cose.get(-3);
            if (
                cose.size !== 5 ||
                cose.get(1) !== 2 ||
                cose.get(3) !== -7 ||
                cose.get(-1) !== 1 ||
                !(x instanceof Uint8Array) ||
                x.length !== 32 ||
                !(y instanceof Uint8Array) ||
                y.length !== 32
            )
                invalid();
            const key = await crypto.subtle.importKey(
                "jwk",
                {
                    kty: "EC",
                    crv: "P-256",
                    x: base64url(x),
                    y: base64url(y),
                    ext: true,
                },
                { name: "ECDSA", namedCurve: "P-256" },
                false,
                ["verify"],
            );
            checkActive();
            const hash = new Uint8Array(
                await crypto.subtle.digest("SHA-256", encoder.encode(clientJson)),
            );
            checkActive();
            const signedBytes = Uint8Array.from([...authData, ...hash]);
            const valid = await crypto.subtle.verify(
                { name: "ECDSA", hash: "SHA-256" },
                key,
                es256Signature(signature),
                signedBytes,
            );
            checkActive();
            if (!valid) invalid();
            return {
                chain,
                credentialId,
                expectedUsername: challenge.expectedUsername,
                authenticationExpiresAtMs: challenge.delegationExpiresAtMs,
            };
        },
    };
}
