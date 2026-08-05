import { describe, expect, it } from "vitest";
import {
    appCardFinalConfirmationAvailable,
    appCardPrivateContextAvailable,
    appContentAttestationAvailable,
} from "./aiActionAvailability";

describe("new action-card production availability", () => {
    it("stays disabled until full-content attestation is deployed and release-verified", () => {
        expect(appContentAttestationAvailable()).toBe(false);
    });

    it("keeps edited confirmation disabled until the exact-final grant is release-verified", () => {
        expect(appCardFinalConfirmationAvailable()).toBe(false);
    });

    it("keeps private context disabled until redemption/decryption passes the release matrix", () => {
        expect(appCardPrivateContextAvailable()).toBe(false);
    });
});
