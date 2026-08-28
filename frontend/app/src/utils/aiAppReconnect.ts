import type { AiAppRegistration, ChatIdentifier, OpenChat } from "@client";
import { cardSurfaceOpening } from "./aiAppSurfaces";
import type { AiAppConnectionSnapshot } from "./aiAppLinkConsent";

/** Immutable coordinates of the registration for which card provenance was refused. */
export interface AiAppReconnectRequest {
    appId: number;
    appRevision: bigint;
    actionId: string;
}

/** Returned only after the user explicitly completes the code flow and Check connection succeeds. */
export interface AiAppReconnectCompletion {
    retryCoordinates: AiAppReconnectRequest;
    previousKeyVersion: bigint;
}

export interface AiAppReconnectTarget {
    kind: "available";
    app: AiAppRegistration;
    // Snapshot taken only after the exact current app/action/surface was resolved. Recovery must
    // observe a later epoch; rediscovering this key (or merely rotating the PEM) is not completion.
    previousConnection: AiAppConnectionSnapshot;
    // The current registration may be newer than the failed historical card. Retry resolution is
    // pinned to this exact current revision and the same action id after explicit completion.
    retryCoordinates: AiAppReconnectRequest;
}

export type AiAppReconnectResolution =
    | AiAppReconnectTarget
    // Deliberately coalesces every authoritative directory/policy mismatch. The UI must not reveal
    // whether the app, revision, action, route, or card surface was the missing predicate.
    | { kind: "app_or_action_unavailable" }
    // A deferred lookup completed after the proposal/account/chat context changed. Stay silent.
    | { kind: "stale" };

/**
 * Resolve the current registration that is allowed to offer a manual reconnect.
 *
 * Reconnect is recovery, so it deliberately asks UserIndex for the current row instead of opening
 * a surface from the failed historical revision. The failed revision is still a lower bound: an
 * unexpected rollback, unpublished app, non-per-user app, or incomplete route fails closed. This
 * helper never changes a key. It captures the current binding epoch and exact current registration;
 * only the modal's explicit code/check flow may authorize one freshly re-resolved retry.
 */
export async function resolveAiAppReconnectTarget(
    client: OpenChat,
    request: AiAppReconnectRequest,
    chatId: ChatIdentifier,
    stillCurrent: () => boolean = () => true,
): Promise<AiAppReconnectResolution> {
    // Do not catch transport/query failures here: callers distinguish a temporary inability to
    // check from an authoritative, privacy-coalesced unavailable result below.
    const apps = await client.aiApps([{ appId: request.appId }]);
    if (!stillCurrent()) return { kind: "stale" };
    const app = apps.find(
        (app) =>
            app.id === request.appId &&
            app.updated >= request.appRevision &&
            app.published &&
            app.manifest.perUserKeys &&
            app.manifest.appCanisterId !== undefined &&
            app.manifest.inboxCanisterId !== undefined &&
            app.manifest.actions.some((action) => action.name === request.actionId) &&
            cardSurfaceOpening(app, chatId) !== undefined,
    );
    if (app === undefined) return { kind: "app_or_action_unavailable" };

    // Backend storage has one row per (user, app). Coalesce any impossible duplicate or malformed
    // epoch into the same authoritative-unavailable category rather than exposing policy details.
    const keys = await client.myAiAppKeys();
    if (!stillCurrent()) return { kind: "stale" };
    const matching = keys.filter((key) => key.appId === app.id);
    if (
        matching.length > 1 ||
        matching.some(
            (key) => key.keyVersion < 0n || (key.publicKey.trim().length === 0 && key.keyVersion !== 0n),
        )
    ) {
        return { kind: "app_or_action_unavailable" };
    }
    const key = matching[0];
    const previousConnection: AiAppConnectionSnapshot =
        key === undefined
            ? { publicKey: "", keyVersion: 0n }
            : { publicKey: key.publicKey, keyVersion: key.keyVersion };
    return {
        kind: "available",
        app,
        previousConnection,
        retryCoordinates: {
            appId: app.id,
            appRevision: app.updated,
            actionId: request.actionId,
        },
    };
}
