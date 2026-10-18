import { writable, get } from "@client/reactiveStores";
import { isTauri } from "@tauri-apps/api/core";
import type { AiAppLinkCode } from "@client";
import { AppSetupCodeUnavailableError, type AiAppCodeTransport } from "./aiAppCodeTransport";
import type { LocalAiAppPresentation } from "./localAppDirectoryPresentation";
import { loadLocalAppPublicPackage, type LocalAppDirectoryDescriptor } from "./localAppDirectory";
import type { LocalAppCatalogEntry } from "./localAppCatalog";
import { APP_SETUP_TIMEOUT_MS, boundedSetupCatalog, validSetupTarget } from "./localAppSetupPopup";
import {
    parseLocalAppSetupContext,
    parseLocalAppScopedSetupResult,
    type LocalAppSetupContext,
} from "./localAppScopedSetup";
import { createSetupCode, encryptSetupCode, decryptSetupCode } from "./appSetupCodeCrypto";
import {
    createSetupCodeActor,
    type SetupCodeActor,
    type SetupCodeCreate,
} from "./localAppSetupCodeActor";

export interface LocalAppCodeConnection {
    readonly app: LocalAiAppPresentation;
    readonly transport: AiAppCodeTransport;
}
/** Memory only: codes, ephemeral identities and private setup must never be persisted. */
export const localAppCodeConnection = writable<LocalAppCodeConnection | undefined>(undefined);
type Dependencies = {
    actor?: (app: LocalAppCatalogEntry) => Promise<SetupCodeActor>;
    now?: () => number;
    origin?: string;
};
const invalid = () =>
    new Error("The app connection could not be verified. Previously connected setup is unchanged.");

// Keep headroom below the app service's ten-minute maximum: a slightly fast
// device or a lagging replica must not make a fresh request exceed that limit.
// The exact shorter deadline stays bound into the ciphertext and all retries.
const CODE_LIFETIME_MS = APP_SETUP_TIMEOUT_MS - 60_000;

export async function connectCodeAppSetup(
    descriptor: LocalAppDirectoryDescriptor,
    signal: AbortSignal,
    pendingContext?: LocalAppSetupContext | Promise<LocalAppSetupContext | undefined>,
    pendingApp?: Promise<LocalAppCatalogEntry>,
    deps: Dependencies = {},
): Promise<string> {
    signal.throwIfAborted();
    if (!validSetupTarget(descriptor.id, descriptor.setupUrl) || get(localAppCodeConnection))
        throw invalid();
    const [app, suppliedContext] = await Promise.all([
        pendingApp ??
            loadLocalAppPublicPackage(descriptor, signal).then((pkg) => pkg.catalog.apps[0]),
        pendingContext,
    ]);
    signal.throwIfAborted();
    if (app.id !== descriptor.id || app.revision !== descriptor.revision) throw invalid();
    if (!app.setupCode) throw new AppSetupCodeUnavailableError();
    const context =
        suppliedContext === undefined
            ? undefined
            : parseLocalAppSetupContext(suppliedContext, descriptor.id);
    const actor = deps.actor
        ? await deps.actor(app)
        : createSetupCodeActor(
              app.setupCode,
              (await import("@icp-sdk/core/identity")).Ed25519KeyIdentity.generate(),
          );
    signal.throwIfAborted();
    if (get(localAppCodeConnection)) throw invalid();
    const now = deps.now ?? Date.now;
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        let attempt: Awaited<ReturnType<typeof createSetupCode>> | undefined;
        let createRequest: SetupCodeCreate | undefined;
        let created = false;
        let expiresAtMs = 0;
        let inFlight: Promise<AiAppLinkCode | undefined> | undefined;
        let checking = false;
        const operation = new AbortController();
        const cleanupRemote = (requestId?: string) => {
            if (requestId)
                void actor.cancel(requestId, AbortSignal.timeout(5000)).catch(() => undefined);
        };
        const finish = (json?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            window.removeEventListener("pagehide", cancel);
            operation.abort();
            cleanupRemote(attempt?.requestId);
            attempt = undefined;
            createRequest = undefined;
            if (get(localAppCodeConnection) === view) localAppCodeConnection.set(undefined);
            if (json !== undefined) resolve(json);
            else reject(invalid());
        };
        const cancel = () => finish();
        const transport: AiAppCodeTransport = {
            setupUrl: descriptor.setupUrl,
            createCode() {
                if (inFlight) return inFlight;
                const work = (async () => {
                    if (settled || signal.aborted) throw invalid();
                    if (expiresAtMs && expiresAtMs <= now()) throw invalid();
                    // Explicit retries reuse the same identity, request and ciphertext even
                    // when the first network response was lost. Never mint a second attempt.
                    if (attempt && created)
                        return { code: attempt.code, expiresAt: BigInt(expiresAtMs) };
                    attempt ??= await createSetupCode();
                    if (settled || signal.aborted) throw invalid();
                    if (!createRequest) {
                        expiresAtMs = now() + CODE_LIFETIME_MS;
                        const plaintext = JSON.stringify({
                            version: 1,
                            appId: descriptor.id,
                            setupUrl: descriptor.setupUrl,
                            clientOrigin: deps.origin ?? location.origin,
                            expiresAtMs,
                            setupContext: context ?? null,
                        });
                        const encrypted = await encryptSetupCode(
                            attempt.code,
                            "context",
                            plaintext,
                        );
                        if (settled || signal.aborted) throw invalid();
                        createRequest = {
                            request_id: attempt.requestId,
                            claim_hash: attempt.claimHash,
                            encrypted_context: encrypted,
                            expires_at_ms: BigInt(expiresAtMs),
                        };
                    }
                    const response = await actor.create(createRequest, operation.signal);
                    if (
                        settled ||
                        signal.aborted ||
                        expiresAtMs <= now() ||
                        !response ||
                        Object.keys(response).join() !== "expires_at_ms" ||
                        response.expires_at_ms !== BigInt(expiresAtMs)
                    )
                        throw invalid();
                    created = true;
                    return { code: attempt.code, expiresAt: BigInt(expiresAtMs) };
                })();
                inFlight = work;
                void work
                    .finally(() => {
                        if (inFlight === work) inFlight = undefined;
                    })
                    .catch(() => undefined);
                return work;
            },
            async checkConnection() {
                if (settled || checking || !created || !attempt || expiresAtMs <= now())
                    return false;
                checking = true;
                try {
                    const current = attempt;
                    const result = await actor.poll(current.requestId, operation.signal);
                    if (settled || signal.aborted || current !== attempt || expiresAtMs <= now())
                        throw invalid();
                    if (!result || Object.keys(result).length !== 1) throw invalid();
                    const phase = Object.keys(result)[0];
                    if (!["Waiting", "Claimed", "Completed"].includes(phase)) throw invalid();
                    const state = result[phase as keyof typeof result] as {
                        expires_at_ms: bigint;
                        encrypted_result?: Uint8Array;
                    };
                    if (
                        !state ||
                        state.expires_at_ms !== BigInt(expiresAtMs) ||
                        Object.keys(state).sort().join() !==
                            (phase === "Completed"
                                ? "encrypted_result,expires_at_ms"
                                : "expires_at_ms")
                    )
                        throw invalid();
                    if (phase !== "Completed") return false;
                    if (!(state.encrypted_result instanceof Uint8Array)) throw invalid();
                    const decoded: unknown = JSON.parse(
                        await decryptSetupCode(current.code, "result", state.encrypted_result),
                    );
                    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
                        throw invalid();
                    const value = decoded as Record<string, unknown>;
                    if (
                        Object.keys(value).sort().join() !==
                            "appId,catalogJson,requestId,setupUrl,version" ||
                        value.version !== 1 ||
                        value.appId !== descriptor.id ||
                        value.setupUrl !== descriptor.setupUrl ||
                        value.requestId !== current.requestId ||
                        !boundedSetupCatalog(value.catalogJson)
                    )
                        throw invalid();
                    if (context)
                        parseLocalAppScopedSetupResult(value.catalogJson, descriptor.id, context);
                    if (settled || signal.aborted || expiresAtMs <= now()) throw invalid();
                    finish(value.catalogJson);
                    return true;
                } finally {
                    checking = false;
                }
            },
            async cancel() {
                finish();
            },
            async openApp() {
                if (settled || !created || !attempt || expiresAtMs <= now()) throw invalid();
                // Open only the public, pinned HTTPS page. The code is copied separately.
                if (isTauri())
                    await (
                        await import("tauri-plugin-oc-api/commands/openUrl")
                    ).openUrl({ url: descriptor.setupUrl });
                else window.open(descriptor.setupUrl, "_blank", "noopener,noreferrer");
            },
        };
        const view: LocalAppCodeConnection = {
            app: {
                connectionKind: "local",
                id: descriptor.id,
                manifest: {
                    name: descriptor.name,
                    description: descriptor.description,
                    actions: [],
                },
                connected: false,
                actionsKnown: false,
                setupOrigin: new URL(descriptor.setupUrl).origin,
            },
            transport,
        };
        signal.addEventListener("abort", cancel, { once: true });
        window.addEventListener("pagehide", cancel, { once: true });
        const timer = setTimeout(cancel, CODE_LIFETIME_MS);
        if (signal.aborted) {
            cancel();
            return;
        }
        localAppCodeConnection.set(view);
    });
}
