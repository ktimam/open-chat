import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "..");

function source(path: string): string {
    return readFileSync(resolve(APP_ROOT, path), "utf8");
}

describe("AI app provenance reconnect UI", () => {
    it.each(["components/home/ChatMessage.svelte", "components_mobile/home/ChatMessage.svelte"])(
        "wires the shared exact-current reconnect resolver into %s",
        (path) => {
            const component = source(path);

            expect(component).toContain("resolveAiAppReconnectTarget");
            expect(component).toContain("async function promptReconnect(");
            expect(component).toContain("promptReconnect:");
            expect(component).toContain("promptReconnect(request, stillCurrent)");
            expect(component).toContain("resolveReconnectCandidate:");
            expect(component).toContain("if (!stillCurrent()");
            expect(component).toContain('resolution.kind === "app_or_action_unavailable"');
            expect(component).toContain('i18nKey("aiApps.reconnectUnavailable")');
            expect(component).toContain('i18nKey("aiApps.reconnectLookupFailed")');
            expect(component).toContain('= "recovery";');
            expect(component).toContain("resolution.previousConnection.publicKey");
            expect(component).toContain("resolution.previousConnection.keyVersion");
            expect(component).toContain("resolution.retryCoordinates");
            expect(component).toContain("purpose={");
            expect(component).toContain("previousPublicKey={");
            expect(component).toContain("previousKeyVersion={");
            expect(component).toContain("viewer !== $currentUserIdStore");
            expect(component).not.toContain(
                "The current app connection could not be opened. Refresh OpenChat and retry.",
            );
        },
    );

    it.each([
        "components/home/AiAppLinkModal.svelte",
        "components_mobile/home/AiAppLinkSheet.svelte",
    ])("keeps reconnect inert until Check connection observes a newer epoch in %s", (path) => {
        const component = source(path);

        expect(component).toContain('purpose?: "connect" | "recovery"');
        expect(component).toContain("previousPublicKey?: string");
        expect(component).toContain("previousKeyVersion?: bigint");
        expect(component).toContain('purpose === "recovery"');
        expect(component).toContain('if (purpose === "connect") void fetchCode();');
        expect(component).not.toMatch(/\n\s*void fetchCode\(\);/);
        expect(component).toContain("aiAppLinkCompleted(keys, app.id, previousConnection)");
        expect(component).toContain('i18nKey("aiApps.reconnectRetryExplain"');
        expect(component).toContain('"aiApps.reconnectGenerateCode"');
        expect(component).toContain('"aiApps.reconnectGenerateConnectionCode"');
        expect(component).toContain('i18nKey("aiApps.close")');
        expect(component).toContain("{#if notLinkedYet}");
        expect(component).toContain("onClick={checkConnection}");
        expect(component).toContain("onClick={cancelLink}");
        expect(component).not.toContain(
            "keys.some((k) => k.appId === app.id && k.publicKey.length > 0)",
        );
    });

    it("wraps the mobile reconnect actions within a narrow sheet", () => {
        const component = source("components_mobile/home/AiAppLinkSheet.svelte");

        expect(component).toContain(
            '<Container gap={"md"} mainAxisAlignment={"end"} crossAxisAlignment={"center"} wrap>',
        );
        expect(component).toContain('resourceKey={i18nKey("aiApps.linkCodeCopy")}');
        expect(component).toContain('resourceKey={i18nKey("aiApps.close")}');
        expect(component).toContain('resourceKey={i18nKey("aiApps.checkConnection")}');
    });
});
