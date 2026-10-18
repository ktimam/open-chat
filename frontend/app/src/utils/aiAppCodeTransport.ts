import type { AiAppLinkCode } from "@client";

export class AppSetupCodeUnavailableError extends Error {
    constructor() {
        super(
            "This publisher must update its app connection service before code connection is available.",
        );
    }
}

/** Transport injection for the original PR's code/copy/open/check presentation. */
export interface AiAppCodeTransport {
    readonly setupUrl: string;
    createCode(): Promise<AiAppLinkCode | undefined>;
    checkConnection(): Promise<boolean>;
    cancel(): Promise<void>;
    openApp(): Promise<void>;
}
