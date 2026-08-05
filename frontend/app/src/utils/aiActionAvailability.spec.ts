import { describe, expect, it } from "vitest";
import {
    appCardRenderingAllowed,
    appCardFinalConfirmationAvailable,
    appCardPrivateContextAvailable,
    appContentAttestationAvailable,
    evaluateLocalAiActionAvailability,
} from "./aiActionAvailability";

const LOCAL_ENV = {
    buildEnvironment: "development",
    dfxNetwork: "local",
    cardsEnabled: "true",
    contentAttestationEnabled: "true",
    finalConfirmationEnabled: "true",
    privateContextEnabled: "true",
} as const;

describe("new action-card availability", () => {
    it("keeps the runtime entry points disabled by default", () => {
        expect(appContentAttestationAvailable()).toBe(false);
        expect(appCardFinalConfirmationAvailable()).toBe(false);
        expect(appCardPrivateContextAvailable()).toBe(false);
    });

    it("enables the three capabilities only for an explicitly armed local loopback build", () => {
        expect(evaluateLocalAiActionAvailability(LOCAL_ENV, "localhost")).toEqual({
            contentAttestation: true,
            finalConfirmation: true,
            privateContext: true,
        });
        expect(evaluateLocalAiActionAvailability(LOCAL_ENV, "127.0.0.1")).toEqual({
            contentAttestation: true,
            finalConfirmation: true,
            privateContext: true,
        });
        expect(evaluateLocalAiActionAvailability(LOCAL_ENV, "::1")).toEqual({
            contentAttestation: true,
            finalConfirmation: true,
            privateContext: true,
        });
        expect(evaluateLocalAiActionAvailability(LOCAL_ENV, "[::1]")).toEqual({
            contentAttestation: true,
            finalConfirmation: true,
            privateContext: true,
        });
    });

    it.each([
        ["missing master", { ...LOCAL_ENV, cardsEnabled: undefined }, "localhost"],
        ["production build", { ...LOCAL_ENV, buildEnvironment: "production" }, "localhost"],
        ["testnet build", { ...LOCAL_ENV, buildEnvironment: "testnet" }, "localhost"],
        ["non-local network", { ...LOCAL_ENV, dfxNetwork: "ic" }, "localhost"],
        ["non-loopback host", LOCAL_ENV, "192.168.1.50"],
        ["missing browser host", LOCAL_ENV, undefined],
        ["uppercase true", { ...LOCAL_ENV, cardsEnabled: "TRUE" }, "localhost"],
        ["numeric true", { ...LOCAL_ENV, cardsEnabled: "1" }, "localhost"],
    ])("fails closed for %s", (_label, environment, hostname) => {
        expect(evaluateLocalAiActionAvailability(environment, hostname)).toEqual({
            contentAttestation: false,
            finalConfirmation: false,
            privateContext: false,
        });
    });

    it("keeps final confirmation and private context dependent on content attestation", () => {
        expect(
            evaluateLocalAiActionAvailability(
                { ...LOCAL_ENV, contentAttestationEnabled: "false" },
                "localhost",
            ),
        ).toEqual({
            contentAttestation: false,
            finalConfirmation: false,
            privateContext: false,
        });
        expect(
            evaluateLocalAiActionAvailability(
                {
                    ...LOCAL_ENV,
                    finalConfirmationEnabled: "false",
                    privateContextEnabled: "false",
                },
                "localhost",
            ),
        ).toEqual({
            contentAttestation: true,
            finalConfirmation: false,
            privateContext: false,
        });
    });

    it("keeps an attested renderer closed when the content release gate is closed", () => {
        expect(
            appCardRenderingAllowed(true, {
                contentAttestation: false,
                finalConfirmation: false,
                privateContext: false,
            }),
        ).toBe(false);
        expect(
            appCardRenderingAllowed(false, {
                contentAttestation: true,
                finalConfirmation: false,
                privateContext: false,
            }),
        ).toBe(false);
        expect(
            appCardRenderingAllowed(true, {
                contentAttestation: true,
                finalConfirmation: false,
                privateContext: false,
            }),
        ).toBe(true);
    });
});
