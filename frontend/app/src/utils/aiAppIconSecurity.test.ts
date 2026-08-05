import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCardOrigin } from "./cardBridge";

describe("AI app icon privacy policy", () => {
    it("uses anonymous, no-referrer loading with the shared production URL policy", () => {
        const source = readFileSync(
            resolve(process.cwd(), "src/components/home/communities/explore/AiAppIcon.svelte"),
            "utf8",
        );
        expect(source).toContain('crossorigin="anonymous"');
        expect(source).toContain('referrerpolicy="no-referrer"');
        expect(source).toContain("deriveCardOrigin(");
        expect(source).toContain("import.meta.env.DEV");
        expect(source).toContain("failed = true");
        expect(source).toContain("remoteAllowed = $state(false)");
        expect(source).toContain("Load external app icon from");
        expect(source).toContain("onclick={allowRemoteIcon}");
    });

    it("blocks production localhost/private/metadata/OC-host icons and permits public HTTPS", () => {
        const hostOrigin = "https://oc.example";
        for (const url of [
            "https://oc.example/icon.png",
            "https://127.0.0.1/icon.png",
            "https://10.0.0.1/icon.png",
            "https://169.254.169.254/icon.png",
            "http://assets.example/icon.png",
        ]) {
            expect(deriveCardOrigin(url, { hostOrigin })).toBeUndefined();
        }
        expect(deriveCardOrigin("https://assets.example/icon.png", { hostOrigin })).toBe(
            "https://assets.example",
        );
    });
});
