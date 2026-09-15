import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/onDeviceInference", () => ({ isNativeClient: () => false }));

import {
    aiAppSurfaceDestinationOrigin,
    redactedAiAppSurfaceDisplayUrl,
} from "../../utils/aiAppSurfaces";
import AiAppSurfaceDestination from "./AiAppSurfaceDestination.svelte";
import HardenedAiAppSurface from "./HardenedAiAppSurface.svelte";

const TOKEN = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const URL_WITH_BEARER = "https://app.example/settings#token=" + TOKEN;

describe("AI app surface consent gate", () => {
    it("renders only the destination origin before consent", async () => {
        const target = document.createElement("div");
        document.body.append(target);
        const displayUrl = redactedAiAppSurfaceDisplayUrl(URL_WITH_BEARER, [
            "one_time_chat_link_token",
        ]);
        const component = mount(AiAppSurfaceDestination, {
            target,
            props: {
                displayUrl,
                dataDisclosures: ["one_time_chat_link_token"],
            },
        });

        try {
            await tick();
            expect(aiAppSurfaceDestinationOrigin(URL_WITH_BEARER)).toBe("https://app.example");
            expect(target.textContent).toContain("https://app.example");
            expect(target.textContent).not.toContain("/settings");
            expect(target.textContent).not.toContain(TOKEN);
        } finally {
            await unmount(component);
            target.remove();
        }
    });

    it("puts technical disclosure behind an accessible native details control", async () => {
        const target = document.createElement("div");
        document.body.append(target);
        const component = mount(AiAppSurfaceDestination, {
            target,
            props: {
                displayUrl: redactedAiAppSurfaceDisplayUrl(URL_WITH_BEARER, [
                    "one_time_chat_link_token",
                ]),
                dataDisclosures: ["one_time_chat_link_token"],
            },
        });

        try {
            await tick();
            const details = target.querySelector("details");
            expect(details).not.toBeNull();
            expect(details?.hasAttribute("open")).toBe(false);
            expect(details?.querySelector("summary")?.textContent).toBe("Privacy details");
            expect(details?.textContent).toContain("browser history");
            expect(details?.textContent).toContain("not send it in HTTP requests");
        } finally {
            await unmount(component);
            target.remove();
        }
    });

    it("gives the actual bearer URL only to the post-consent iframe sink", async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
            HTMLIFrameElement.prototype,
            "credentialless",
        );
        Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", {
            configurable: true,
            writable: true,
            value: true,
        });
        const target = document.createElement("div");
        document.body.append(target);
        const consent = vi.fn();
        const component = mount(HardenedAiAppSurface, {
            target,
            props: {
                title: "Example app",
                url: URL_WITH_BEARER,
                dataDisclosures: ["one_time_chat_link_token"],
                onConsent: consent,
            },
        });

        try {
            await tick();
            expect(target.querySelector("iframe")).toBeNull();
            expect(target.textContent).not.toContain(TOKEN);

            (target.querySelector("button") as HTMLButtonElement).click();
            await tick();

            expect(consent).toHaveBeenCalledOnce();
            expect(target.querySelector("iframe")?.src).toBe(URL_WITH_BEARER);
        } finally {
            await unmount(component);
            target.remove();
            if (descriptor === undefined) {
                delete (HTMLIFrameElement.prototype as { credentialless?: boolean }).credentialless;
            } else {
                Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", descriptor);
            }
        }
    });

    it("uses the redacted display URL in desktop and mobile pre-consent chrome", () => {
        const files = [
            resolve(__dirname, "AiAppSurfaceModal.svelte"),
            resolve(__dirname, "../../components_mobile/home/AiAppSurfaceSheet.svelte"),
        ];

        for (const file of files) {
            const source = readFileSync(file, "utf8");
            expect(source).toContain("redactedAiAppSurfaceDisplayUrl");
            expect(source).not.toMatch(/Browser destination:[^\n]*normalizedUrl/);
            expect(source).toContain("Not now");
            expect(source).toContain("Open {title}");
            expect(source).not.toContain("Opening hands the full destination URL");
            expect(source).not.toContain("<AiAppSurfaceDestination {title}");
        }

        const desktop = readFileSync(files[0], "utf8").replace(/\s+/g, " ");
        expect(desktop).toContain('<ModalContent closeIcon fill={display === "sheet"}');
        expect(desktop).toContain("<Button hollow small onClick={onDismiss}>Not now</Button>");
        expect(desktop).toMatch(/<Button\s+small\s+disabled=.*?>\s*<OpenInNew/s);

        const mobile = readFileSync(files[1], "utf8").replace(/\s+/g, " ");
        expect(mobile).toContain('height={display === "sheet" ? "fill" : "hug"}');
        expect(mobile).toContain('mode={"active"}');
    });
});
