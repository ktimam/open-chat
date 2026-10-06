import {
    localAppCardAnchorKey,
    type LocalAppCardAnchorNamespace,
    type LocalAppCardAnchorSource,
} from "./localAppCardAnchors";
import type { PrivateAppWorkspaceState } from "./privateAppWorkspace";

/** Presentation only: a retained card does not prevent a fresh, explicit extraction. */
export function hasLocalAppSourceProposal(
    state: Pick<PrivateAppWorkspaceState, "account" | "backend" | "cards" | "cardSources">,
    namespace: LocalAppCardAnchorNamespace | undefined,
    source: LocalAppCardAnchorSource,
    target: Readonly<{ appId: string; actionId: string }>,
): boolean {
    if (!namespace || state.account !== namespace.account || state.backend !== namespace.backend)
        return false;
    const sourceKey = localAppCardAnchorKey(namespace, source);
    return (
        sourceKey !== undefined &&
        state.cards.some(
            (card) =>
                card.target.appId === target.appId &&
                card.target.actionId === target.actionId &&
                localAppCardAnchorKey(namespace, state.cardSources[card.id]) === sourceKey,
        )
    );
}
