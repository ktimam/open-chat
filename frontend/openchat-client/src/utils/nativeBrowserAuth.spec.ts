// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    Cbor,
    DER_COSE_OID,
    SignIdentity,
    wrapDER,
    type DerEncodedPublicKey,
    type Signature,
} from "@icp-sdk/core/agent";
import { DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import {
    createNativeBrowserAuthVerifier,
    NATIVE_BROWSER_AUTH_PROTOCOL,
    type NativeBrowserAuthCandidate,
    type NativeBrowserAuthChallenge,
} from "./nativeBrowserAuth";

const now = 1_800_000_000_000;
const identityCanister = Principal.fromUint8Array(Uint8Array.of(1, 2, 3));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const base64url = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const encode = (value: string) => new TextEncoder().encode(value);
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

function derSignature(raw: Uint8Array): Uint8Array {
    const integers = [raw.slice(0, 32), raw.slice(32)]
        .map((value) => {
            while (value[0] === 0 && value.length > 1) value = value.slice(1);
            if (value[0] & 128) value = Uint8Array.from([0, ...value]);
            return [2, value.length, ...value];
        })
        .flat();
    return Uint8Array.from([0x30, integers.length, ...integers]);
}

type AssertionChanges = {
    origin?: string;
    rpId?: string;
    flags?: number;
    challenge?: string;
    crossOrigin?: unknown;
    topOrigin?: string;
    type?: string;
    corruptSignature?: boolean;
    trailingWire?: boolean;
    duplicateClientKey?: boolean;
    duplicateWireKey?: boolean;
};

async function fixture(changes: AssertionChanges = {}, lifetimeMs = 300_000) {
    const session = await ECDSAKeyIdentity.generate();
    const root = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const jwk = await webcrypto.subtle.exportKey("jwk", root.publicKey);
    // Authenticator COSE map has integer keys, not the SDK encoder's object string keys.
    const cose = Uint8Array.from([
        0xa5,
        1,
        2,
        3,
        0x26,
        0x20,
        1,
        0x21,
        0x58,
        32,
        ...fromB64(jwk.x!),
        0x22,
        0x58,
        32,
        ...fromB64(jwk.y!),
    ]);
    const rootDer = wrapDER(cose, DER_COSE_OID);
    const challenge: NativeBrowserAuthChallenge = {
        protocol: NATIVE_BROWSER_AUTH_PROTOCOL,
        attemptId: "01".repeat(16),
        nonce: "02".repeat(32),
        origin: "http://localhost:49123",
        url: "http://localhost:49123/sign-in",
        sessionPublicKeyDerHex: hex(session.getPublicKey().toDer()),
        expectedUsername: "synthetic-user",
        identityCanister: identityCanister.toText(),
        identityTargetHex: identityCanister.toHex(),
        expiresAtMs: now + 120_000,
        delegationExpiresAtMs: now + lifetimeMs,
        clientLabel: "OpenChat Fork · Local Test",
    };
    class SyntheticPasskey extends SignIdentity {
        getPublicKey() {
            return { toDer: () => rootDer as DerEncodedPublicKey };
        }
        async sign(blob: Uint8Array): Promise<Signature> {
            const authData = new Uint8Array(37);
            authData.set(
                new Uint8Array(
                    await webcrypto.subtle.digest("SHA-256", encode(changes.rpId ?? "localhost")),
                ),
            );
            authData[32] = changes.flags ?? 5;
            let client = JSON.stringify({
                type: changes.type ?? "webauthn.get",
                origin: changes.origin ?? challenge.origin,
                challenge: changes.challenge ?? base64url(blob),
                crossOrigin: changes.crossOrigin ?? false,
                ...(changes.topOrigin === undefined ? {} : { topOrigin: changes.topOrigin }),
            });
            if (changes.duplicateClientKey)
                client = client.replace("{", '{"\\u006frigin":"http://attacker.example",');
            const hash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", encode(client)));
            const raw = new Uint8Array(
                await webcrypto.subtle.sign(
                    { name: "ECDSA", hash: "SHA-256" },
                    root.privateKey,
                    Uint8Array.from([...authData, ...hash]),
                ),
            );
            const signature = derSignature(raw);
            if (changes.corruptSignature) signature[signature.length - 1] ^= 1;
            let wire = Cbor.encode({
                authenticator_data: authData,
                client_data_json: client,
                signature,
            });
            if (changes.duplicateWireKey) {
                const extra = Cbor.encode({ client_data_json: client }).slice(4);
                wire = Uint8Array.from([...wire.slice(0, 3), 0xa4, ...wire.slice(4), ...extra]);
            }
            return (changes.trailingWire ? Uint8Array.from([...wire, 0]) : wire) as Signature;
        }
    }
    const chain = await DelegationChain.create(
        new SyntheticPasskey(),
        session.getPublicKey(),
        new Date(challenge.delegationExpiresAtMs),
        { targets: [identityCanister] },
    );
    const candidate: NativeBrowserAuthCandidate = {
        protocol: challenge.protocol,
        attemptId: challenge.attemptId,
        nonce: challenge.nonce,
        credentialIdHex: "a1b2c3",
        delegation: chain.toJSON(),
    };
    return { challenge, candidate, rootDer, session };
}

describe("local-only native browser AUTH delegation cryptographic verifier", () => {
    const network = vi.fn(() => {
        throw new Error("Unexpected network");
    });
    beforeEach(() => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        network.mockClear();
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("verifies a real synthetic P-256 signature over the SDK delegation challenge, but does not activate an account", async () => {
        const f = await fixture();
        const result = await createNativeBrowserAuthVerifier(f.challenge, {
            now: () => now,
        }).verify(f.candidate, f.rootDer);
        expect(result.chain.toJSON()).toEqual(f.candidate.delegation);
        expect(result.credentialId).toEqual(bytes("a1b2c3"));
        expect(result.expectedUsername).toBe("synthetic-user");
        expect(result.authenticationExpiresAtMs).toBe(now + 300_000);
    });

    const badAssertions: [string, AssertionChanges][] = [
        ["valid signature from the wrong origin", { origin: "http://localhost:49124" }],
        ["valid signature from non-loopback origin", { origin: "https://attacker.example" }],
        ["valid signature for the wrong RP", { rpId: "oc.app" }],
        ["no user verification", { flags: 1 }],
        ["no user presence", { flags: 4 }],
        ["attested data in assertion", { flags: 0x45 }],
        ["invalid backup flags", { flags: 0x15 }],
        ["cross-origin assertion", { crossOrigin: true }],
        ["malformed cross-origin assertion", { crossOrigin: "false" }],
        ["top-origin assertion", { topOrigin: "http://localhost:49123" }],
        ["wrong operation", { type: "webauthn.create" }],
        ["wrong signed challenge", { challenge: "not-the-delegation" }],
        ["cryptographically invalid signature", { corruptSignature: true }],
        ["trailing CBOR", { trailingWire: true }],
        [
            "duplicate signed client JSON key, even with escaped spelling",
            { duplicateClientKey: true },
        ],
        ["duplicate CBOR field", { duplicateWireKey: true }],
    ];
    it.each(badAssertions)("rejects %s", async (_, changes) => {
        const f = await fixture(changes);
        await expect(
            createNativeBrowserAuthVerifier(f.challenge, { now: () => now }).verify(
                f.candidate,
                f.rootDer,
            ),
        ).rejects.toThrow();
    });

    const badCandidates: [string, (c: NativeBrowserAuthCandidate) => void][] = [
        [
            "wrong nonce",
            (c) => {
                c.nonce = "aa".repeat(32);
            },
        ],
        [
            "wrong attempt",
            (c) => {
                c.attemptId = "aa".repeat(16);
            },
        ],
        [
            "wrong protocol",
            (c) => {
                c.protocol = "old" as never;
            },
        ],
        [
            "empty credential ID",
            (c) => {
                c.credentialIdHex = "";
            },
        ],
        [
            "malformed credential ID",
            (c) => {
                c.credentialIdHex = "zz";
            },
        ],
        [
            "oversized credential ID",
            (c) => {
                c.credentialIdHex = "00".repeat(4097);
            },
        ],
        [
            "wrong root key",
            (c) => {
                c.delegation.publicKey = "00".repeat(64);
            },
        ],
        [
            "wrong delegated key",
            (c) => {
                c.delegation.delegations[0].delegation.pubkey = "00".repeat(64);
            },
        ],
        [
            "changed expiry",
            (c) => {
                c.delegation.delegations[0].delegation.expiration = (
                    BigInt(now + 300_001) * 1_000_000n
                ).toString(16);
            },
        ],
        [
            "missing target",
            (c) => {
                delete c.delegation.delegations[0].delegation.targets;
            },
        ],
        [
            "additional target",
            (c) => {
                c.delegation.delegations[0].delegation.targets!.push("0104");
            },
        ],
        [
            "wrong target",
            (c) => {
                c.delegation.delegations[0].delegation.targets = ["0104"];
            },
        ],
        [
            "extra delegation",
            (c) => {
                c.delegation.delegations.push(c.delegation.delegations[0]);
            },
        ],
        [
            "unsigned origin wrapper",
            (c) => {
                Object.assign(c, { origin: "http://localhost:49123" });
            },
        ],
        [
            "oversized signature",
            (c) => {
                c.delegation.delegations[0].signature = "00".repeat(32769);
            },
        ],
    ];
    it.each(badCandidates)("rejects %s and consumes the attempt", async (_, mutate) => {
        const f = await fixture();
        const original = structuredClone(f.candidate);
        mutate(f.candidate);
        const verifier = createNativeBrowserAuthVerifier(f.challenge, { now: () => now });
        await expect(verifier.verify(f.candidate, f.rootDer)).rejects.toThrow();
        await expect(verifier.verify(original, f.rootDer)).rejects.toThrow();
    });

    it("rejects a candidate whose root differs from the independently looked-up root", async () => {
        const f = await fixture();
        const other = await fixture();
        await expect(
            createNativeBrowserAuthVerifier(f.challenge, { now: () => now }).verify(
                f.candidate,
                other.rootDer,
            ),
        ).rejects.toThrow();
    });

    it("rejects a malformed ECDSA DER signature and wrong root algorithm", async () => {
        const f = await fixture();
        const wire = Cbor.decode<Record<string, unknown>>(
            bytes(f.candidate.delegation.delegations[0].signature),
        );
        wire.signature = Uint8Array.of(0x30, 6, 2, 1, 0x80, 2, 1, 1); // Negative r.
        f.candidate.delegation.delegations[0].signature = hex(Cbor.encode(wire));
        await expect(
            createNativeBrowserAuthVerifier(f.challenge, { now: () => now }).verify(
                f.candidate,
                f.rootDer,
            ),
        ).rejects.toThrow();
        const other = await fixture();
        // DER's final 77 bytes contain our COSE fixture; change ES256 (-7) to another algorithm.
        other.rootDer[other.rootDer.length - 77 + 4] = 0x27;
        other.candidate.delegation.publicKey = hex(other.rootDer);
        await expect(
            createNativeBrowserAuthVerifier(other.challenge, { now: () => now }).verify(
                other.candidate,
                other.rootDer,
            ),
        ).rejects.toThrow();
    });

    it("rejects an old candidate under a fresh native key even if unsigned nonce metadata is copied", async () => {
        const old = await fixture();
        const fresh = await fixture();
        await expect(
            createNativeBrowserAuthVerifier(fresh.challenge, { now: () => now }).verify(
                old.candidate,
                old.rootDer,
            ),
        ).rejects.toThrow();
    });

    it("consumes the attempt synchronously against concurrent replay", async () => {
        const f = await fixture();
        const verifier = createNativeBrowserAuthVerifier(f.challenge, { now: () => now });
        const first = verifier.verify(f.candidate, f.rootDer);
        await expect(verifier.verify(f.candidate, f.rootDer)).rejects.toThrow();
        await expect(first).resolves.toBeDefined();
        await expect(verifier.verify(f.candidate, f.rootDer)).rejects.toThrow();
    });

    it("rejects cancellation before and during cryptographic work, never returning a late result", async () => {
        const f = await fixture();
        const before = createNativeBrowserAuthVerifier(f.challenge, { now: () => now });
        before.cancel();
        await expect(before.verify(f.candidate, f.rootDer)).rejects.toThrow();
        const during = createNativeBrowserAuthVerifier(f.challenge, { now: () => now });
        const pending = during.verify(f.candidate, f.rootDer);
        during.cancel();
        await expect(pending).rejects.toThrow();
    });

    it("honors AbortSignal and expiry after an await", async () => {
        const f = await fixture();
        const controller = new AbortController();
        const verifier = createNativeBrowserAuthVerifier(f.challenge, {
            now: () => now,
            signal: controller.signal,
        });
        const pending = verifier.verify(f.candidate, f.rootDer);
        controller.abort();
        await expect(pending).rejects.toThrow();
        let time = now;
        const expiring = createNativeBrowserAuthVerifier(f.challenge, { now: () => time });
        const late = expiring.verify(f.candidate, f.rootDer);
        time = f.challenge.expiresAtMs;
        await expect(late).rejects.toThrow();
    });

    it("snapshots caller-owned challenge and candidate before async verification", async () => {
        const f = await fixture();
        const verifier = createNativeBrowserAuthVerifier(f.challenge, { now: () => now });
        const pending = verifier.verify(f.candidate, f.rootDer);
        f.challenge.expectedUsername = "attacker";
        f.candidate.delegation.delegations[0].delegation.pubkey = "00";
        const result = await pending;
        expect(result.expectedUsername).toBe("synthetic-user");
        expect(hex(result.chain.delegations[0].delegation.pubkey)).toBe(
            hex(f.session.getPublicKey().toDer()),
        );
    });

    it("rejects long-lived or non-loopback challenges before accepting a candidate", async () => {
        const f = await fixture();
        for (const changes of [
            { origin: "https://oc.app" },
            { origin: "http://127.0.0.1:49123" },
            { origin: "http://localhost:49123/" },
            { url: `${f.challenge.url}?nonce=x` },
            { delegationExpiresAtMs: now + 30 * 24 * 60 * 60_000 + 1 },
            { expiresAtMs: now + 120_001 },
            { expectedUsername: "" },
            { identityTargetHex: "0104" },
        ])
            expect(() =>
                createNativeBrowserAuthVerifier({ ...f.challenge, ...changes }, { now: () => now }),
            ).toThrow();
    });
    it("verifies a freshly signed 30-day deadline but rejects locally extending an existing signature", async () => {
        const lifetime = 30 * 24 * 60 * 60_000;
        const f = await fixture({}, lifetime);
        const verified = await createNativeBrowserAuthVerifier(f.challenge, {
            now: () => now,
        }).verify(f.candidate, f.rootDer);
        expect(verified.authenticationExpiresAtMs).toBe(now + lifetime);
        const old = await fixture();
        const extended = { ...old.challenge, delegationExpiresAtMs: now + lifetime };
        const modified = structuredClone(old.candidate);
        modified.delegation.delegations[0].delegation.expiration = (
            BigInt(now + lifetime) * 1_000_000n
        ).toString(16);
        await expect(
            createNativeBrowserAuthVerifier(extended, { now: () => now }).verify(
                modified,
                old.rootDer,
            ),
        ).rejects.toThrow();
    });
});
