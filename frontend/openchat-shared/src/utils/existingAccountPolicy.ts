/** Client-only authentication policy; omitted means the official signup flow is unchanged. */
export type ExistingAccountPolicy = { existingAccountOnly?: boolean };

export class ExistingAccountRequiredError extends Error {
    readonly code = "existing_account_required";

    constructor() {
        super(
            "Link an existing OpenChat account before signing in to this client. No new account was created.",
        );
        this.name = "ExistingAccountRequiredError";
    }
}

export function isExistingAccountRequiredError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "existing_account_required"
    );
}

export function assertAccountCreationAllowed(policy: ExistingAccountPolicy): void {
    if (policy.existingAccountOnly === true) throw new ExistingAccountRequiredError();
}

/** Creating an extra credential for an explicit account-link flow is not account signup. */
export function assertSignUpAllowed(policy: ExistingAccountPolicy, assumeIdentity: boolean): void {
    if (assumeIdentity) assertAccountCreationAllowed(policy);
}
