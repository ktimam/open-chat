import type { WorkerRequest } from "../domain/worker";

/** These extensions are absent from the official OpenChat services. Private drafts never use them. */
export const CUSTOM_APP_REQUEST_KINDS = [
    "respondToActionCard",
    "modelCatalog",
    "aiApps",
    "myAiApps",
    "setAiAppEnabled",
    "enabledAiApps",
    "myAiAppKeys",
    "aiAppUserKeys",
    "createAiAppLinkCode",
    "cancelAiAppLinkCode",
    "createAiAppChatLinkToken",
    "cancelAiAppChatLinkToken",
    "createAiAppCardProvenance",
    "createAiAppCardCapability",
    "createAiAppPrivateMatchCapability",
    "createAiAppCardConfirmationGrant",
    "removeMyAiAppKey",
    "publishAiApp",
    "exploreAiApps",
] as const satisfies readonly WorkerRequest["kind"][];

const customRequests: ReadonlySet<string> = new Set(CUSTOM_APP_REQUEST_KINDS);

export class ClientOnlyAppRequestError extends Error {
    readonly code = "client_only_app_request";

    constructor() {
        super(
            "This client uses private local app drafts, not custom OpenChat app services. No request was sent.",
        );
        this.name = "ClientOnlyAppRequestError";
    }
}

/** Call in both the UI transport and the worker, before dispatch. Never include payloads in errors. */
export function assertUnofficialApiRequestAllowed(
    request: WorkerRequest,
    clientOnlyApps?: boolean,
): void {
    if (clientOnlyApps !== true) return;
    const message =
        request.kind === "sendMessage"
            ? request.event.event
            : request.kind === "editMessage"
              ? request.msg
              : undefined;
    if (customRequests.has(request.kind) || message?.content.kind === "action_card_content") {
        throw new ClientOnlyAppRequestError();
    }
}
