import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("embedded app surface isolation", () => {
    it("uses one click-gated opaque sandbox host on desktop and mobile", () => {
        const hardened = readFileSync(
            resolve(process.cwd(), "src/components/home/HardenedAiAppSurface.svelte"),
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
            const host = readFileSync(resolve(process.cwd(), file), "utf8");
            expect(host).toContain("HardenedAiAppSurface");
            expect(host).not.toContain("<iframe");
        }
    });

    it("never auto-opens external post-confirm surfaces and marks only consent", () => {
        for (const file of [
            "src/components/home/ChatMessage.svelte",
            "src/components_mobile/home/ChatMessage.svelte",
        ]) {
            const message = readFileSync(resolve(process.cwd(), file), "utf8");
            expect(message).toContain("confirmSurface = opening");
            expect(message).toContain("markSurfaceShownAfterConsent");
            expect(message).not.toContain("openSurfaceExternally(client, opening.url)");
        }
        for (const file of [
            "src/components/home/AiAppSurfaceModal.svelte",
            "src/components_mobile/home/AiAppSurfaceSheet.svelte",
        ]) {
            const prompt = readFileSync(resolve(process.cwd(), file), "utf8");
            expect(prompt).toContain("normalizeAiAppSurfaceUrl");
            expect(prompt).toContain("AiAppSurfaceDestination");
            expect(prompt).toContain("Not now");
        }
    });

    it("enumerates private redemption metadata before load and separates its grant", () => {
        const card = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        for (const category of [
            "stable OpenChat user ID",
            "stable chat identifiers",
            "both participant identifiers",
            "app/revision/action",
            "message, optional thread",
            "recipient-key scheme/public key",
        ]) {
            expect(card).toContain(category);
        }
        expect(card).toContain("let cardActivated = $derived(readySeen)");
        expect(card).toContain("Private app context is not shared");
        expect(card).toContain("appCardPrivateContextAvailable");
        expect(card).toContain("onclick={requestPrivateContext}");
        expect(card).toContain("privateContextRequested = true");
        expect(card).toContain("buildCardPrivateContextRequest(frameNonce)");
        expect(card).toContain("if (cardKey === undefined || !privateContextRequested) return");
        expect(card).toContain("canAcceptCardPrivateContextReady({");
        expect(card).toContain("explicitlyRequested: privateContextRequested");
        expect(card).toMatch(/Other\s+chat\s+members\s+receive\s+no\s+viewer-private\s+fields\./);
    });

    it("keeps card redirects opaque and binds bridge messages to source + per-load nonce", () => {
        const card = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        expect(card).toContain('sandbox="allow-scripts"');
        expect(card).toContain('referrerpolicy="no-referrer"');
        expect(card).not.toContain('sandbox="allow-scripts allow-same-origin"');
        expect(card.replace(/\s+/g, " ")).toContain(
            'isCardBridgeEventForFrame(event, iframeEl.contentWindow, "null", frameNonce)',
        );
        expect(card).toContain("onload={onIframeLoad}");
        expect(card).toContain("import.meta.env.DEV");
    });

    it("keeps capabilities/final grants out of URLs, storage, logs, and unrelated frames", () => {
        const card = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        const bridge = readFileSync(resolve(process.cwd(), "src/utils/cardBridge.ts"), "utf8");
        const worker = readFileSync(
            resolve(process.cwd(), "../openchat-worker/src/worker.ts"),
            "utf8",
        );
        const workerClient = readFileSync(
            resolve(process.cwd(), "../openchat-client/src/workerAgent.ts"),
            "utf8",
        );
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
        const card = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        expect(card).toContain("startCardHandshakeTimeout");
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
            resolve(process.cwd(), "src/components/home/AiAppLinkModal.svelte"),
            resolve(process.cwd(), "src/components_mobile/home/AiAppLinkSheet.svelte"),
            resolve(process.cwd(), "../openchat-shared/src/domain/aiAction.ts"),
        ].map((file) => readFileSync(file, "utf8"));
        for (const source of files) {
            expect(source).toContain("c2c_claim_ai_app_link_code");
            expect(source).toContain("key_version");
            expect(source).not.toContain("the app claims it (claim_ai_app_link_code)");
            expect(source).not.toContain("via `claim_ai_app_link_code`");
        }
    });

    it("cancels link consent only from explicit desktop/mobile close handlers", () => {
        const desktop = readFileSync(
            resolve(process.cwd(), "src/components/home/AiAppLinkModal.svelte"),
            "utf8",
        );
        const mobile = readFileSync(
            resolve(process.cwd(), "src/components_mobile/home/AiAppLinkSheet.svelte"),
            "utf8",
        );
        for (const source of [desktop, mobile]) {
            expect(source).toContain("cancelAiAppLinkConsent(client, app.id, pendingCodeRequest)");
            expect(source).toContain("async function cancelLink()");
            expect(source).toContain("completed = true");
            expect(source).not.toContain("onDestroy");
        }
        expect(desktop).toContain("onClose={cancelLink}");
        expect(desktop).not.toContain("onClose={onDismiss}");
        expect(mobile).toContain("<Sheet onDismiss={cancelLink}>");
    });
});
