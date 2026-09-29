import { describe, expect, it } from "vitest";
import {
    assertAccountCreationAllowed,
    assertSignUpAllowed,
    ExistingAccountRequiredError,
    isExistingAccountRequiredError,
} from "./existingAccountPolicy";

describe("existing-account-only policy", () => {
    it.each([{}, { existingAccountOnly: false }])(
        "preserves official account creation for %j",
        (policy) => {
            expect(() => assertAccountCreationAllowed(policy)).not.toThrow();
            expect(() => assertSignUpAllowed(policy, true)).not.toThrow();
        },
    );

    it("blocks account creation and ordinary signup when explicitly enabled", () => {
        expect(() => assertAccountCreationAllowed({ existingAccountOnly: true })).toThrow(
            ExistingAccountRequiredError,
        );
        expect(() => assertSignUpAllowed({ existingAccountOnly: true }, true)).toThrow(
            ExistingAccountRequiredError,
        );
    });

    it("permits explicit creation of a credential for linking an existing account", () => {
        expect(() => assertSignUpAllowed({ existingAccountOnly: true }, false)).not.toThrow();
    });

    it("identifies the safe error after worker serialization, not generic provider errors", () => {
        const error = new ExistingAccountRequiredError();
        expect(isExistingAccountRequiredError(error)).toBe(true);
        expect(isExistingAccountRequiredError(JSON.parse(JSON.stringify(error)))).toBe(true);
        expect(isExistingAccountRequiredError(new Error("provider failure"))).toBe(false);
        expect(isExistingAccountRequiredError(null)).toBe(false);
    });
});
