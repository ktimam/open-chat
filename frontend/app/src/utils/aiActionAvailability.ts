import { resolveDevAllowedHost } from "../../devAllowedHost.mjs";

export interface LocalAiActionAvailabilityEnvironment {
    buildEnvironment?: string;
    dfxNetwork?: string;
    devAllowedHost?: string;
    cardsEnabled?: string;
    contentAttestationEnabled?: string;
    finalConfirmationEnabled?: string;
    privateContextEnabled?: string;
}

export interface AiActionAvailability {
    contentAttestation: boolean;
    finalConfirmation: boolean;
    privateContext: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// These switches are release brakes, not authorization. Even an explicitly armed local build must
// still receive the backend attestations and scoped grants checked by each call path. Requiring the
// exact lowercase value and an exact local/development/loopback triple prevents a copied environment
// file or a Vite server exposed on the LAN from enabling unfinished capabilities.
export function evaluateLocalAiActionAvailability(
    environment: LocalAiActionAvailabilityEnvironment,
    hostname: string | undefined,
): AiActionAvailability {
    const normalizedHostname = hostname?.toLowerCase();
    let devAllowedHost: string | undefined;
    try {
        devAllowedHost = resolveDevAllowedHost(environment.devAllowedHost);
    } catch {
        // Build configuration validates this value before serving or bundling. Retain a fail-closed
        // runtime boundary in case this pure evaluator is ever called with an untrusted value.
        devAllowedHost = undefined;
    }
    const hostnameAllowed =
        normalizedHostname !== undefined &&
        (LOOPBACK_HOSTNAMES.has(normalizedHostname) || normalizedHostname === devAllowedHost);
    const locallyArmed =
        environment.buildEnvironment === "development" &&
        environment.dfxNetwork === "local" &&
        hostnameAllowed &&
        environment.cardsEnabled === "true";
    const contentAttestation = locallyArmed && environment.contentAttestationEnabled === "true";

    return {
        contentAttestation,
        // Final/private flows both depend on the canonical card content being attested first.
        finalConfirmation: contentAttestation && environment.finalConfirmationEnabled === "true",
        privateContext: contentAttestation && environment.privateContextEnabled === "true",
    };
}

function currentAvailability(): AiActionAvailability {
    return evaluateLocalAiActionAvailability(
        {
            buildEnvironment: import.meta.env.OC_BUILD_ENV,
            dfxNetwork: import.meta.env.OC_DFX_NETWORK,
            devAllowedHost: import.meta.env.OC_DEV_ALLOWED_HOST,
            cardsEnabled: import.meta.env.OC_LOCAL_AI_APP_CARDS_ENABLED,
            contentAttestationEnabled: import.meta.env.OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED,
            finalConfirmationEnabled: import.meta.env.OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED,
            privateContextEnabled: import.meta.env.OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED,
        },
        typeof window === "undefined" ? undefined : window.location.hostname,
    );
}

export function appContentAttestationAvailable(): boolean {
    return currentAvailability().contentAttestation;
}

export function appCardFinalConfirmationAvailable(): boolean {
    return currentAvailability().finalConfirmation;
}

export function appCardPrivateContextAvailable(): boolean {
    return currentAvailability().privateContext;
}

export function appCardRenderingAllowed(
    contentAttested: boolean,
    availability: AiActionAvailability,
): boolean {
    return contentAttested && availability.contentAttestation;
}

export function appCardRenderingAvailable(contentAttested: boolean): boolean {
    return appCardRenderingAllowed(contentAttested, currentAvailability());
}
