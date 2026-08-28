import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "../..");

function appPath(path: string): string {
    return resolve(APP_ROOT, path);
}

describe("embedded app surface isolation", () => {
    it("uses one click-gated opaque sandbox host on desktop and mobile", () => {
        const hardened = readFileSync(
            appPath("src/components/home/HardenedAiAppSurface.svelte"),
            "utf8",
        );
        expect(hardened).toContain('sandbox="allow-scripts"');
        expect(hardened).not.toContain("allow-same-origin");
        expect(hardened).toContain("credentialless");
        expect(hardened).toContain('referrerpolicy="no-referrer"');
        expect(hardened).toContain("import.meta.env.DEV");
        expect(hardened).toContain("loadRequested");
        expect(hardened).toContain("AiAppSurfaceDestination");
        for (const file of [
            "src/components/home/AiAppSurfaceModal.svelte",
            "src/components_mobile/home/AiAppSurfaceSheet.svelte",
        ]) {
            const host = readFileSync(appPath(file), "utf8");
            expect(host).toContain("HardenedAiAppSurface");
            expect(host).not.toContain("<iframe");
        }
    });

    it("keeps chat confirmation independent from external setup surfaces", () => {
        for (const file of [
            "src/components/home/ChatMessage.svelte",
            "src/components_mobile/home/ChatMessage.svelte",
        ]) {
            const message = readFileSync(appPath(file), "utf8");
            expect(message).toContain("respondToActionCard(");
            expect(message).not.toContain("surfaceToOpenAfterConfirm");
            expect(message).not.toContain("confirmSurface");
            expect(message).not.toContain("AiAppSurfaceModal");
            expect(message).not.toContain("AiAppSurfaceSheet");
        }
        for (const file of [
            "src/components/home/AiAppSurfaceModal.svelte",
            "src/components_mobile/home/AiAppSurfaceSheet.svelte",
        ]) {
            const prompt = readFileSync(appPath(file), "utf8");
            expect(prompt).toContain("normalizeAiAppSurfaceUrl");
            expect(prompt).toContain("AiAppSurfaceDestination");
            expect(prompt).toContain("Not now");
        }
    });

    it("auto-renders only fully reconstructed trusted cards with compact registered-URL chrome", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        const compact = card.replace(/\s+/g, " ");
        expect(card).not.toContain("Load app card");
        expect(card).not.toContain("Security details");
        expect(card).not.toContain("IP address");
        expect(card).not.toContain("Direct-chat participant IDs");
        expect(card).not.toContain("Message ID:");
        expect(card).toContain('class="card-url"');
        expect(card).toContain("isMultiEntrySummaryRows(content.rows)");
        expect(card).toContain("completelyReverseMapRows(content.rows, opening.labelToField)");
        expect(compact).toContain(
            "const mappedPayload = isMultiEntrySummaryRows(content.rows) ? completelyReverseMapMultiRows(content.rows, opening.labelToField) : completelyReverseMapRows(content.rows, opening.labelToField);",
        );
        expect(compact).toContain("if (!hasDecodedPayload && mappedPayload === undefined)");
        expect(card).toContain("credentiallessSupported = supportsCredentiallessIframe()");
        expect(compact).toContain(
            "if (credentiallessSupported) { loadRequested = true; resetFrameSession(); }",
        );
        expect(card).toContain("let cardActivated = $derived(readySeen)");
        expect(card).not.toContain("Private context details");
        expect(card).not.toContain("Private app context is not shared");
        expect(card).toContain("appCardPrivateContextAvailable");
        expect(card).toContain("onclick={requestPrivateContext}");
        expect(card).toContain("privateContextRequested = true");
        expect(card).toContain("buildCardPrivateContextRequest(frameNonce)");
        expect(card).toContain("if (hasPersistentUserPairing) beginPrivateContextRequest()");
        expect(card).toContain("if (cardKey === undefined || !privateContextRequested) return");
        expect(card).toContain("canAcceptCardPrivateContextReady({");
        expect(card).toContain("explicitlyRequested: privateContextRequested");
    });

    it("keeps card redirects opaque and binds bridge messages to source + per-load nonce", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).toContain('sandbox="allow-scripts"');
        expect(card).toContain('referrerpolicy="no-referrer"');
        expect(card).not.toContain('sandbox="allow-scripts allow-same-origin"');
        const compact = card.replace(/\s+/g, " ");
        expect(compact).toContain("const frame = iframeEl; const target = frame?.contentWindow;");
        expect(compact).toContain("iframeEl !== frame ||");
        expect(compact).toContain(
            'isCardBridgeEventForFrame(event, target, "null", frameNonce)',
        );
        expect(card).toContain("onload={onIframeLoad}");
        expect(card).toContain("import.meta.env.DEV");
    });

    it("uses exact resolution and full attestation as the public rendering boundary", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        const cache = readFileSync(appPath("../openchat-agent/src/utils/chatsDb.ts"), "utf8");
        const compact = card.replace(/\s+/g, " ");

        expect(card).not.toContain("shouldAutoLoadFreshlyProposedAppCard");
        expect(card).not.toContain("consumeFreshlyProposedAppCardAutoLoad");
        const lookupIndex = compact.indexOf("resolveActionAppForCard(");
        const attestationIndex = compact.indexOf("if (!contentAttested)", lookupIndex);
        const mappingIndex = compact.indexOf("completelyReverseMapRows(", attestationIndex);
        const activateIndex = compact.indexOf("loadRequested = true;", mappingIndex);
        expect(lookupIndex).toBeGreaterThanOrEqual(0);
        expect(attestationIndex).toBeGreaterThan(lookupIndex);
        expect(mappingIndex).toBeGreaterThan(attestationIndex);
        expect(activateIndex).toBeGreaterThan(mappingIndex);
        expect(card).not.toContain("External app content (isolated)");
        expect(card).not.toContain("Untrusted app content");
        expect(card).toContain("Unverified card binding");
        expect(card).toContain("Directory binding only; card content is untrusted");
        expect(card).toContain("Untrusted card text");

        // The exact payload remains sender-session-only even though public rendering no longer
        // depends on it; recipients reconstruct only completely mapped public rows.
        expect(cache).toContain("retain a defensive copy in the current sender session");
        expect(cache).toContain("delete content.confirmPayload");
        expect(cache).toContain("confirmPayload: liveConfirmPayload");
    });

    it("mints chat setup tokens only from explicit desktop/mobile Settings entry points", () => {
        const resolver = readFileSync(appPath("src/utils/aiAppSurfaces.ts"), "utf8");
        expect(resolver).not.toContain("surfaceToOpenAfterConfirm");
        for (const file of [
            "src/components/home/groupdetails/AiAppsSummary.svelte",
            "src/components/home/groupdetails/AiAppsDirectSummary.svelte",
            "src/components_mobile/home/groupdetails/AiAppsSummary.svelte",
            "src/components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
        ]) {
            const settings = readFileSync(appPath(file), "utf8");
            expect(settings).toContain("createChatLinkSurfaceOpening(client, app,");
            expect(settings).toContain("setupHandedOff = false");
            expect(settings).toContain("onConsent={() => (setupHandedOff = true)}");
            expect(settings).toContain("onDismiss={dismissSetup}");
            expect(settings).toContain("client.cancelAiAppChatLinkToken(opening.chatLinkToken)");
            expect(settings).toContain("opening !== undefined && !setupHandedOff");
        }
    });

    it("accurately distinguishes URL-fragment exposure from HTTP request logging", () => {
        const disclosure = readFileSync(
            appPath("src/components/home/AiAppSurfaceDestination.svelte"),
            "utf8",
        );
        expect(disclosure).toContain("browser history");
        expect(disclosure).toContain("browsers do");
        expect(disclosure).toContain("not send it in HTTP requests.");
        expect(disclosure).not.toContain(
            "These identifiers can appear in the external app's request logs.",
        );
    });

    it("keeps even backend-attested app rendering behind the client release gate", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).toContain("appCardRenderingAvailable");
        expect(card).toContain("appCardRenderingBlocked = true");
        expect(card).toContain("App rendering is disabled by this client's release gate");
    });

    it("compiles every experimental app-card switch closed outside local development", () => {
        const rollup = readFileSync(appPath("rollup.config.mjs"), "utf8");
        expect(rollup).toContain('process.env.OC_BUILD_ENV === "development"');
        expect(rollup).toContain('process.env.OC_DFX_NETWORK === "local"');
        for (const flag of [
            "OC_LOCAL_AI_APP_CARDS_ENABLED",
            "OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED",
            "OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED",
            "OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED",
        ]) {
            expect(rollup).toMatch(
                new RegExp('localOnlyAiAppCardFlag\\(\\s*"' + flag + '"\\s*,?\\s*\\)'),
            );
        }
        expect(rollup).toContain("resolveLocalDevAllowedHost(");
        expect(rollup).toContain('"import.meta.env.OC_DEV_ALLOWED_HOST": localOnlyDevAllowedHost');
    });

    it("replaces Vite's development builtin in native bundles and rejects future leaks", () => {
        const rollup = readFileSync(appPath("rollup.config.mjs"), "utf8");

        expect(rollup).toContain("const { version, production, development, env } = initEnv();");
        for (const replacement of [
            '"import.meta.env.MODE": JSON.stringify(env)',
            '"import.meta.env.DEV": JSON.stringify(development)',
            '"import.meta.env.PROD": JSON.stringify(!development)',
            '"import.meta.env.SSR": "false"',
            '"import.meta.env.BASE_URL": JSON.stringify("/")',
            '"import.meta.env": "{}"',
        ]) {
            expect(rollup).toContain(replacement);
        }
        expect(rollup).toContain("rejectUnresolvedViteEnv()");
        expect(rollup).toContain('artifact.code.includes("import.meta.env")');
        expect(rollup).not.toContain('artifact.code.includes("import.meta.env.DEV")');
    });

    it("keeps capabilities/final grants out of URLs, storage, logs, and unrelated frames", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        const bridge = readFileSync(appPath("src/utils/cardBridge.ts"), "utf8");
        const worker = readFileSync(appPath("../openchat-worker/src/worker.ts"), "utf8");
        const workerClient = readFileSync(appPath("../openchat-client/src/workerAgent.ts"), "utf8");
        expect(bridge).toContain("event.source === expectedSource");
        expect(card).toContain("grant.grant.slice()");
        expect(card).not.toMatch(/localStorage[^\n]*(cardCapability|confirmationGrant)/);
        expect(card).not.toMatch(/sessionStorage[^\n]*(cardCapability|confirmationGrant)/);
        expect(bridge).not.toContain("confirmationGrant");
        expect(worker).not.toContain("error caused by payload");
        expect(worker).not.toContain('agent does not exist: ", msg.data');
        expect(workerClient).not.toContain('WORKER_CLIENT: response: ", ev');
        expect(workerClient).not.toContain('WORKER_CLIENT: error: ", ev');
        expect(workerClient).not.toContain('WORKER_CLIENT: unknown message: ", ev');
        expect(worker).not.toContain('WORKER: unhandled promise rejection: ", err');
        expect(worker).not.toContain('WORKER: unhandled error: ", err');
    });

    it("times out a non-handshaking frame and keeps host-initiated confirmation fail-closed", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).toContain("startCardHandshakeTimeout");
        expect(card).toContain("startCardBootstrapRetry");
        expect(card).toContain("cancelCardBootstrapRetry?.()");
        expect(card).toContain("frameNonce !== loadedNonce");
        expect(card).toContain("frameNonce !== expectedNonce");
        expect(card).toContain("Retry app card");
        expect(card).toContain("Show values");
        const compact = card.replace(/\s+/g, " ");
        expect(compact).toContain(
            'response === "confirm" && (!cardContentAttested || !finalConfirmationAvailable)',
        );
        expect(card).toContain("appCardFinalConfirmationAvailable");
        expect(card).toContain(
            "if (!canCollectConfirm || target == null || cardKey === undefined) return",
        );
        expect(card).toContain("cardCollectedConfirmFromMessage");
        expect(card).toContain("collectAttempt = undefined");
        expect(card).toContain("settleCardOperationBeforeTimeout");
        expect(card).not.toContain("Share app context");
        expect(card).toContain("collectAttempt !== undefined || confirmationAttempt !== undefined");
        expect(card).toContain("!cardConfirmable ||");
        expect(card).toContain("!cardActivated ||");
        expect(card).toContain("server binds the exact final payload");
        expect(card).toContain('respond("cancel", e)');
        expect(compact).toContain("authorized exact-payload endpoint");
    });

    it("documents only the registered-canister link claim and the versioned revoke tuple", () => {
        const files = [
            appPath("src/components/home/AiAppLinkModal.svelte"),
            appPath("src/components_mobile/home/AiAppLinkSheet.svelte"),
            appPath("../openchat-shared/src/domain/aiAction.ts"),
        ].map((file) => readFileSync(file, "utf8"));
        for (const source of files) {
            expect(source).toContain("c2c_claim_ai_app_link_code");
            expect(source).toContain("key_version");
            expect(source).not.toContain("the app claims it (claim_ai_app_link_code)");
            expect(source).not.toContain("via `claim_ai_app_link_code`");
        }
    });

    it("cancels link consent only from explicit desktop/mobile close handlers", () => {
        const helper = readFileSync(appPath("src/utils/aiAppLinkConsent.ts"), "utf8");
        const desktop = readFileSync(appPath("src/components/home/AiAppLinkModal.svelte"), "utf8");
        const mobile = readFileSync(
            appPath("src/components_mobile/home/AiAppLinkSheet.svelte"),
            "utf8",
        );
        for (const source of [desktop, mobile]) {
            expect(source).toContain("() => linkCode?.code");
            expect(source).toContain("cancelAiAppLinkConsent(");
            expect(source).toContain("async function cancelLink()");
            expect(source).toContain("completed = true");
            expect(source).toContain("onDismiss();");
            expect(source).not.toContain("if (cancelled)");
            expect(source).not.toContain("onDestroy");
        }
        expect(helper).toContain("client.cancelAiAppLinkCode(code)");
        expect(helper).not.toContain("client.removeMyAiAppKey(");
        expect(desktop).toContain("onClose={cancelLink}");
        expect(desktop).not.toContain("onClose={onDismiss}");
        expect(mobile).toContain("<Sheet onDismiss={cancelLink}>");
    });
});
