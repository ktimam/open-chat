import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenChat, type OpenChatConfig } from "@client";
import { createOpenChatClient } from "./openchatClient";

vi.mock("@client", () => ({
    OpenChat: vi.fn(function () {}),
}));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe("shared OpenChat client configuration", () => {
    it("keeps the fork's client-only apps and app directory configuration", () => {
        vi.stubEnv("OC_UNOFFICIAL_CLIENT", "true");
        vi.stubEnv("OC_APP_DIRECTORY_URL", "https://directory.example/apps-v1.json");
        vi.stubEnv("OC_BASE_ORIGIN", "https://client.example");
        const formatter = vi.fn() as unknown as OpenChatConfig["i18nFormatter"];
        const logger = {} as OpenChatConfig["logger"];

        createOpenChatClient(formatter, logger);

        expect(OpenChat).toHaveBeenCalledWith(
            expect.objectContaining({
                clientOnlyApps: true,
                appDirectoryUrl: "https://directory.example/apps-v1.json",
                baseOrigin: "https://client.example",
                i18nFormatter: formatter,
                logger,
            }),
        );
    });

    it("does not enable client-only apps in an official build", () => {
        vi.stubEnv("OC_UNOFFICIAL_CLIENT", "false");
        createOpenChatClient(
            vi.fn() as unknown as OpenChatConfig["i18nFormatter"],
            {} as OpenChatConfig["logger"],
        );
        expect(OpenChat).toHaveBeenCalledWith(expect.objectContaining({ clientOnlyApps: false }));
    });
});
