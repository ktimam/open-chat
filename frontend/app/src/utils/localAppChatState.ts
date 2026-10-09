import { get, writable } from "svelte/store";
import { privateAppWorkspace, privateAppWorkspaceState } from "./privateAppWorkspace";
import { LocalAppChatConfiguration, type LocalAppSuggestion } from "./localAppChatConfiguration";

export const localAppChatRevision = writable(0);
export const localAutoProposeSuggestions = writable<Map<string, readonly LocalAppSuggestion[]>>(
    new Map(),
);
export const localAppChatConfiguration = new LocalAppChatConfiguration((cause) => {
    localAppChatRevision.update((value) => value + 1);
    localAutoProposeSuggestions.set(new Map());
    if (cause !== "enabled") return;
    const state = get(privateAppWorkspaceState);
    if (state.account && state.catalog && !state.setupLoading) {
        const accepted = privateAppWorkspace.replaceEnabledChats(
            state.account,
            state.catalog,
            localAppChatConfiguration.snapshotEnabled(state.account, state.catalog),
        );
        if (!accepted)
            localAppChatConfiguration.restoreEnabled(
                state.account,
                state.catalog,
                state.enabledChats,
            );
    } else if (state.account && state.catalog) {
        localAppChatConfiguration.restoreEnabled(state.account, state.catalog, state.enabledChats);
    }
});
let previousEnabledChats: unknown;
let previousAccount: unknown;
let previousCatalog: unknown;
let previousSetupLoading: unknown;
const unsubscribe = privateAppWorkspaceState.subscribe((state) => {
    localAppChatConfiguration.setContext(
        state.account,
        state.catalog,
        state.connections,
        state.chatSetups,
    );
    const contextChanged = state.account !== previousAccount || state.catalog !== previousCatalog;
    previousAccount = state.account;
    previousCatalog = state.catalog;
    const finishedLoading = previousSetupLoading === true && !state.setupLoading;
    previousSetupLoading = state.setupLoading;
    if (!contextChanged && !finishedLoading && state.enabledChats === previousEnabledChats) return;
    previousEnabledChats = state.enabledChats;
    if (state.account && state.catalog && !state.setupLoading)
        localAppChatConfiguration.restoreEnabled(state.account, state.catalog, state.enabledChats);
});
import.meta.hot?.dispose(() => {
    unsubscribe();
    localAppChatConfiguration.setContext(undefined, undefined);
});

export function dismissLocalAutoProposeSuggestion(
    messageKey: string,
    suggestion: LocalAppSuggestion,
): void {
    localAutoProposeSuggestions.update((map) => {
        const remaining = (map.get(messageKey) ?? []).filter(
            (item) => item.appId !== suggestion.appId || item.actionId !== suggestion.actionId,
        );
        const next = new Map(map);
        if (remaining.length) next.set(messageKey, remaining);
        else next.delete(messageKey);
        return next;
    });
}
