import { invoke } from "@tauri-apps/api/core";

export type LocalAppHandoffPhase =
    | "awaiting_claim"
    | "reviewing"
    | "offered"
    | "received"
    | "saved"
    | "rejected"
    | "uncertain"
    | "expired"
    | "cancelled";
export type LocalAppHandoffStatus = {
    phase: LocalAppHandoffPhase;
    expiresAtMs: number;
    deliveryMayHaveOccurred: boolean;
};
export type LocalAppHandoffStart = {
    handoffId: string;
    url: string;
    /** One-use bootstrap: only the first-party launch fragment after approval. Never display,
     * copy, log, persist, or forward it to the app; the bundled page erases it immediately. */
    pairingCode: string;
    claimExpiresAtMs: number;
};

/** Only call inside immutable draft confirmation, never extraction/reconnect effects. */
export function beginLocalAppHandoff(payload: {
    approvedRequestJson: string;
}): Promise<LocalAppHandoffStart> {
    return invoke("plugin:oc|begin_local_app_handoff", { payload });
}
export function pollLocalAppHandoff(handoffId: string): Promise<LocalAppHandoffStatus> {
    return invoke("plugin:oc|poll_local_app_handoff", { handoffId });
}
/** Cancellation cannot recall a dispatch already authorized for the paired browser. */
export function cancelLocalAppHandoff(
    handoffId: string,
): Promise<{ deliveryMayHaveOccurred: boolean }> {
    return invoke("plugin:oc|cancel_local_app_handoff", { handoffId });
}
