import { openDB, type IDBPDatabase } from "idb";
import {
    DelegationChain,
    ECDSAKeyIdentity,
    type JsonnableDelegationChain,
} from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { NATIVE_SESSION_MAX_LIFETIME_MS } from "@shared/utils/nativeBrowserSession";

export type NativeSessionScope = {
    icUrl: string;
    identityCanister: string;
    userIndexCanister: string;
};
export type SavedNativeSession = {
    scope: NativeSessionScope;
    key: CryptoKeyPair;
    delegation: JsonnableDelegationChain;
    expiresAtMs: number;
    username: string;
    userId: string;
    ocPrincipal: string;
    webAuthnKey: { credentialId: Uint8Array; publicKey: Uint8Array };
};
type Stored = { version: 1; generation: string; session?: SavedNativeSession };
const STORE = "session";
const KEY = "current";
const EMPTY = "initial";
const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
const cancelled = () => new DOMException("Saved sign-in was cancelled or replaced", "AbortError");
const exactKeys = (value: object, keys: string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Structural validation only. Restoration also requires fresh authenticated official account proof.
 * Uses the existing IndexedDB/WebCrypto substrate, not a hardware keystore. No passkey private key,
 * profile, browser response, chat data or draft is stored. */
export async function validateSavedNativeSession(
    value: SavedNativeSession,
    scope: NativeSessionScope,
) {
    try {
        if (
            !value ||
            !exactKeys(value, [
                "scope",
                "key",
                "delegation",
                "expiresAtMs",
                "username",
                "userId",
                "ocPrincipal",
                "webAuthnKey",
            ]) ||
            !value.scope ||
            !exactKeys(value.scope, ["icUrl", "identityCanister", "userIndexCanister"]) ||
            !value.webAuthnKey ||
            !exactKeys(value.webAuthnKey, ["credentialId", "publicKey"]) ||
            value.scope?.icUrl !== scope.icUrl ||
            value.scope.identityCanister !== scope.identityCanister ||
            value.scope.userIndexCanister !== scope.userIndexCanister ||
            scope.icUrl !== "https://icp-api.io" ||
            !Number.isSafeInteger(value.expiresAtMs) ||
            value.expiresAtMs <= Date.now() ||
            value.expiresAtMs > Date.now() + NATIVE_SESSION_MAX_LIFETIME_MS ||
            typeof value.username !== "string" ||
            !value.username ||
            value.username.length > 100 ||
            value.username.trim() !== value.username ||
            !value.userId ||
            !value.ocPrincipal ||
            value.key?.privateKey?.type !== "private" ||
            value.key.privateKey.extractable !== false ||
            value.key.privateKey.algorithm.name !== "ECDSA" ||
            (value.key.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
            !value.key.privateKey.usages.includes("sign") ||
            value.key.publicKey?.type !== "public" ||
            value.key.publicKey.algorithm.name !== "ECDSA" ||
            (value.key.publicKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
            !value.key.publicKey.usages.includes("verify") ||
            !(value.webAuthnKey?.credentialId instanceof Uint8Array) ||
            value.webAuthnKey.credentialId.length < 1 ||
            value.webAuthnKey.credentialId.length > 1024 ||
            !(value.webAuthnKey.publicKey instanceof Uint8Array) ||
            value.webAuthnKey.publicKey.length < 32 ||
            value.webAuthnKey.publicKey.length > 4096 ||
            JSON.stringify(value.delegation).length > 65_536
        )
            throw new Error();
        for (const id of [
            scope.identityCanister,
            scope.userIndexCanister,
            value.userId,
            value.ocPrincipal,
        ])
            if (Principal.fromText(id).toText() !== id || Principal.fromText(id).isAnonymous())
                throw new Error();
        const chain = DelegationChain.fromJSON(value.delegation);
        const key = await ECDSAKeyIdentity.fromKeyPair(value.key);
        const leaf = chain.delegations[0]?.delegation;
        if (
            chain.delegations.length !== 1 ||
            !equal(chain.publicKey, value.webAuthnKey.publicKey) ||
            !equal(leaf.pubkey, key.getPublicKey().toDer()) ||
            leaf.expiration !== BigInt(value.expiresAtMs) * 1_000_000n ||
            leaf.targets?.length !== 1 ||
            leaf.targets[0].toText() !== scope.identityCanister
        )
            throw new Error();
        const challenge = new TextEncoder().encode("OpenChat saved native key-pair check v1");
        const algorithm = { name: "ECDSA", hash: "SHA-256" };
        const proof = await crypto.subtle.sign(algorithm, value.key.privateKey, challenge);
        if (!(await crypto.subtle.verify(algorithm, value.key.publicKey, proof, challenge)))
            throw new Error();
        return { key, chain };
    } catch {
        throw new Error("Saved sign-in is invalid or expired. Sign in again.");
    }
}

/** One atomic record and metadata-only logout tombstone. Transactional CAS prevents late saves
 * in another page/instance from resurrecting a session after logout. No localStorage fallback. */
export class NativeBrowserSessionStorage {
    #db: Promise<IDBPDatabase> | undefined;
    #database() {
        return (this.#db ??= openDB("oc-native-browser-session", 1, {
            upgrade(db) {
                db.createObjectStore(STORE);
            },
        }));
    }
    async read(): Promise<{ generation: string; session?: SavedNativeSession }> {
        const value: Stored | undefined = await (await this.#database()).get(STORE, KEY);
        if (value === undefined) return { generation: EMPTY };
        if (
            !value ||
            value.version !== 1 ||
            typeof value.generation !== "string" ||
            !exactKeys(
                value,
                value.session === undefined
                    ? ["version", "generation"]
                    : ["version", "generation", "session"],
            )
        )
            throw new Error("Saved sign-in storage is invalid. Sign out before signing in again.");
        return value;
    }
    async isCurrent(generation: string): Promise<boolean> {
        return (await this.read()).generation === generation;
    }
    async save(
        session: SavedNativeSession,
        generation: string,
        signal: AbortSignal,
    ): Promise<string> {
        // Snapshot before asynchronous crypto/IDB work; caller mutation cannot change what was checked.
        const snapshot = structuredClone(session);
        await validateSavedNativeSession(snapshot, snapshot.scope);
        if (signal.aborted) throw cancelled();
        const db = await this.#database();
        const tx = db.transaction(STORE, "readwrite");
        const current: Stored | undefined = await tx.store.get(KEY);
        if (signal.aborted || (current?.generation ?? EMPTY) !== generation) {
            await tx.done;
            throw cancelled();
        }
        const next = crypto.randomUUID();
        await tx.store.put({ version: 1, generation: next, session: snapshot }, KEY);
        await tx.done;
        return next;
    }
    async clear(generation?: string): Promise<void> {
        const tx = (await this.#database()).transaction(STORE, "readwrite");
        const current: Stored | undefined = await tx.store.get(KEY);
        if (generation === undefined || (current?.generation ?? EMPTY) === generation)
            await tx.store.put({ version: 1, generation: crypto.randomUUID() }, KEY);
        await tx.done;
    }
}
