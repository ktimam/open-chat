import { invoke } from "@tauri-apps/api/core";

export type LocalAppSetupStart = {
    setupId: string;
    /** Contains one-use fragment authority: launch only; never log, display, copy or persist. */
    url: string;
    expiresAtMs: number;
};
export type LocalAppSetupStatus = {
    phase: "waiting" | "received" | "expired" | "cancelled";
    expiresAtMs: number;
    /** Opaque app-owned setup, consumed once. Fully validate before installing; never log. */
    catalogJson?: string;
};

/** Explicit Connect only. Never send messages, drafts or authentication material here. */
export function beginLocalAppSetup(payload: {
    appId: string;
    setupUrl: string;
}): Promise<LocalAppSetupStart> {
    return invoke("plugin:oc|begin_local_app_setup", { payload });
}
export function pollLocalAppSetup(setupId: string): Promise<LocalAppSetupStatus> {
    return invoke("plugin:oc|poll_local_app_setup", { setupId });
}
export function cancelLocalAppSetup(setupId: string): Promise<void> {
    return invoke("plugin:oc|cancel_local_app_setup", { setupId });
}
