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

    it("never auto-opens external post-confirm surfaces and marks only consent", () => {
        for (const file of [
            "src/components/home/ChatMessage.svelte",
            "src/components_mobile/home/ChatMessage.svelte",
        ]) {
            const message = readFileSync(appPath(file), "utf8");
            expect(message).toContain("confirmSurface = opening");
            expect(message).toContain("markSurfaceShownAfterConsent");
            expect(message).not.toContain("openSurfaceExternally(client, opening.url)");
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

    it("keeps all trusted-recipient disclosure in closed details", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).not.toContain('class="card-load-summary"');
        expect(card).toContain('class="card-security-details"');
        expect(card).toContain("<summary>Security details</summary>");
        expect(card).not.toContain("<details open");
        expect(card).toContain('{#if chatId.kind === "direct_chat"}');
        const gateStart = card.indexOf('<div class="card-load-gate">');
        const gateEnd = card.indexOf('<div class="external-frame-label">', gateStart);
        const loadGate = card.slice(gateStart, gateEnd).replace(/\s+/g, " ");
        const detailsStart = loadGate.indexOf('<details class="card-security-details"');
        const detailsEnd = loadGate.indexOf("</details>", detailsStart);
        const loadDetails = loadGate.slice(detailsStart, detailsEnd);
        expect(detailsStart).toBeGreaterThanOrEqual(0);
        expect(loadGate.slice(0, detailsStart)).not.toContain("IP address");
        expect(loadDetails).toContain("shares this card plus its chat and message identifiers");
        expect(loadDetails).toContain("Private app context stays hidden");
        expect(loadGate).toContain("Exact card URL");
        expect(loadGate).toContain("IP address");
        expect(loadGate).toContain("opaque sandbox");
        expect(loadGate).not.toContain("stable OpenChat user ID");
        expect(loadGate).not.toContain("recipient public key");
        const privateStart = card.indexOf('<div class="private-context-consent">');
        const privateEnd = card.indexOf("</div>", privateStart);
        const privateConsent = card.slice(privateStart, privateEnd).replace(/\s+/g, " ");
        const privateDetailsStart = privateConsent.indexOf(
            '<details class="private-context-details"',
        );
        expect(privateDetailsStart).toBeGreaterThanOrEqual(0);
        expect(privateConsent.slice(0, privateDetailsStart)).not.toContain(
            "stable OpenChat user ID",
        );
        expect(privateConsent).toContain("stable OpenChat user ID");
        expect(privateConsent).toContain("recipient-key scheme and public key");
        expect(privateConsent).toContain("encrypted viewer data");
        expect(privateConsent).toMatch(
            /Other\s+chat\s+members\s+receive\s+no\s+viewer-private\s+fields\./,
        );
        expect(card).toContain("let cardActivated = $derived(readySeen)");
        expect(card).toContain("Private app context is not shared");
        expect(card).toContain("appCardPrivateContextAvailable");
        expect(card).toContain("onclick={requestPrivateContext}");
        expect(card).toContain("privateContextRequested = true");
        expect(card).toContain("buildCardPrivateContextRequest(frameNonce)");
        expect(card).toContain("if (cardKey === undefined || !privateContextRequested) return");
        expect(card).toContain("canAcceptCardPrivateContextReady({");
        expect(card).toContain("explicitlyRequested: privateContextRequested");
    });

    it("keeps card redirects opaque and binds bridge messages to source + per-load nonce", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).toContain('sandbox="allow-scripts"');
        expect(card).toContain('referrerpolicy="no-referrer"');
        expect(card).not.toContain('sandbox="allow-scripts allow-same-origin"');
        expect(card.replace(/\s+/g, " ")).toContain(
            'isCardBridgeEventForFrame(event, iframeEl.contentWindow, "null", frameNonce)',
        );
        expect(card).toContain("onload={onIframeLoad}");
        expect(card).toContain("import.meta.env.DEV");
    });

    it("treats only a freshly proposed live sender card as load consent", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        const cache = readFileSync(appPath("../openchat-agent/src/utils/chatsDb.ts"), "utf8");
        const compact = card.replace(/\s+/g, " ");

        expect(card).toContain("shouldAutoLoadFreshlyProposedAppCard");
        expect(card).toContain("consumeFreshlyProposedAppCardAutoLoad");
        expect(compact).toContain("if (!autoLoadEligible || autoLoadKey === undefined) return;");
        const consumeIndex = compact.indexOf(
            "if (!consumeFreshlyProposedAppCardAutoLoad(autoLoadKey)) return;",
        );
        const preserveLoadedIndex = compact.indexOf("if (loadRequested) return;", consumeIndex);
        const activateIndex = compact.indexOf(
            "loadRequested = true; resetFrameSession();",
            preserveLoadedIndex,
        );
        expect(consumeIndex).toBeGreaterThanOrEqual(0);
        expect(preserveLoadedIndex).toBeGreaterThan(consumeIndex);
        expect(activateIndex).toBeGreaterThan(preserveLoadedIndex);
        expect(card).toContain("External app content (isolated)");
        expect(card).not.toContain("Untrusted app content");
        expect(card).toContain("Unverified card binding");
        expect(card).toContain("Directory binding only; card content is untrusted");
        expect(card).toContain("Untrusted card text");

        // The consent signal exists only in the current provenance-backed sender copy. It is
        // deliberately absent from IndexedDB and every recipient/historical hydration.
        expect(cache).toContain("retain a defensive copy in the current sender session");
        expect(cache).toContain("delete content.confirmPayload");
        expect(cache).toContain("confirmPayload: liveConfirmPayload");
    });

    it("uses the same one-time per-chat mint and exact dismiss cancellation after confirm", () => {
        const resolver = readFileSync(appPath("src/utils/aiAppSurfaces.ts"), "utf8");
        expect(resolver).toContain("return createChatLinkSurfaceOpening(client, app, chatId)");
        for (const file of [
            "src/components/home/ChatMessage.svelte",
            "src/components_mobile/home/ChatMessage.svelte",
        ]) {
            const message = readFileSync(appPath(file), "utf8");
            expect(message).toContain("confirmSurfaceHandedOff = false");
            expect(message).toContain("onConsent={consentToConfirmSurface}");
            expect(message).toContain("onDismiss={dismissConfirmSurface}");
            expect(message).toContain("client.cancelAiAppChatLinkToken(opening.chatLinkToken)");
            expect(message).toContain("opening !== undefined && !confirmSurfaceHandedOff");
            expect(message).toContain("let confirmSurfaceRequest = 0");
            expect(message).toContain("chatIdentifierToString(chatId)");
            expect(message).toContain("confirmSurfaceRequest += 1");
            expect(message).toContain("surfaceRequest !== confirmSurfaceRequest");
            expect(message).toContain(
                "await client.cancelAiAppChatLinkToken(opening.chatLinkToken)",
            );
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

    it("times out a non-handshaking frame and keeps classic confirmation fail-closed", () => {
        const card = readFileSync(appPath("src/components/home/ActionCardContent.svelte"), "utf8");
        expect(card).toContain("startCardHandshakeTimeout");
        expect(card).toContain("startCardBootstrapRetry");
        expect(card).toContain("cancelCardBootstrapRetry?.()");
        expect(card).toContain("frameNonce !== loadedNonce");
        expect(card).toContain("frameNonce !== expectedNonce");
        expect(card).toContain("Retry app card");
        expect(card).toContain("Use read-only OpenChat summary");
        const compact = card.replace(/\s+/g, " ");
        expect(compact).toContain(
            'response === "confirm" && (!cardContentAttested || !finalConfirmationAvailable)',
        );
        expect(card).toContain("appCardFinalConfirmationAvailable");
        expect(card).toContain("if (!cardConfirmable || busy || !cardActivated) return");
        expect(card).toContain("if (!cardCancelable || busy || !cardActivated) return");
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
