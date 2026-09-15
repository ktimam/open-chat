import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(import.meta.dirname, "..");
const FRONTEND_ROOT = resolve(APP_ROOT, "../..");

function appSource(path: string): string {
    return readFileSync(resolve(APP_ROOT, path), "utf8").replace(/\s+/g, " ");
}

describe("account-linking-code UI parity", () => {
    it("renders the existing v1 flow from the v2 account-linking page", () => {
        const v1Profile = appSource("components/home/profile/UserProfile.svelte");
        const v2 = appSource("components_mobile/home/user_profile/AccountLinkingCode.svelte");

        expect(v1Profile).toContain('import AccountLinkingCode from "./AccountLinkingCode.svelte"');
        expect(v1Profile).toContain("<AccountLinkingCode />");
        expect(v2).toContain(
            'import AccountLinkingCodeFlow from "@src/components/home/profile/AccountLinkingCode.svelte"',
        );
        expect(v2).toContain("<AccountLinkingCodeFlow />");
    });

    it("only exposes the v2 entry point for eligible signed-in accounts", () => {
        const settings = appSource("components_mobile/home/user_profile/AppSettings.svelte");
        const modals = appSource("components_mobile/home/SlidingModals.svelte");
        const events = readFileSync(
            resolve(FRONTEND_ROOT, "openchat-shared/src/utils/pubsub_events.ts"),
            "utf8",
        ).replace(/\s+/g, " ");

        expect(settings).toContain("{#if !$anonUserStore && client.accountLinkingCodeEnabled()}");
        expect(settings).toContain('publish("userProfileAccountLinking")');
        expect(settings).toContain('i18nKey("accountLinkingCode.settingsMenu.title")');
        expect(modals).toContain('subscribe("userProfileAccountLinking"');
        expect(modals).toContain('page.kind === "user_profile_account_linking"');
        expect(events).toContain("userProfileAccountLinking: undefined;");
    });

    it("reuses the existing v1 generation flow without a second mobile implementation", () => {
        const flow = appSource("components/home/profile/AccountLinkingCode.svelte");

        expect(flow).toMatch(/client\s*\.\s*createAccountLinkingCode\(\)/);
        expect(flow).not.toContain("publish(");
    });

    it("keeps the six-character code inside narrow mobile viewports", () => {
        const flow = appSource("components/home/profile/AccountLinkingCode.svelte");

        expect(flow).toContain("width: min(28rem, calc(100vw - 2rem))");
        expect(flow).toContain("gap: clamp(0.25rem, 2vw, 1rem)");
        expect(flow).toContain("flex: 1 1 0");
        expect(flow).toContain("max-width: 3.5rem");
    });
});
