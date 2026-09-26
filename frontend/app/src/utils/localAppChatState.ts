import { writable } from "svelte/store";
import { privateAppWorkspaceState } from "./privateAppWorkspace";
import { LocalAppChatConfiguration, type LocalAppSuggestion } from "./localAppChatConfiguration";

export const localAppChatRevision = writable(0);
export const localAutoProposeSuggestions = writable<Map<string, readonly LocalAppSuggestion[]>>(new Map());
export const localAppChatConfiguration = new LocalAppChatConfiguration(() => {
    localAppChatRevision.update(value => value + 1);
    localAutoProposeSuggestions.set(new Map());
});
const unsubscribe = privateAppWorkspaceState.subscribe(state => localAppChatConfiguration.setContext(state.account, state.catalog));
import.meta.hot?.dispose(() => { unsubscribe(); localAppChatConfiguration.setContext(undefined, undefined); });

export function dismissLocalAutoProposeSuggestion(messageKey: string, suggestion: LocalAppSuggestion): void {
    localAutoProposeSuggestions.update(map => {
        const remaining = (map.get(messageKey) ?? []).filter(item => item.appId !== suggestion.appId || item.actionId !== suggestion.actionId);
        const next = new Map(map);
        if (remaining.length) next.set(messageKey, remaining); else next.delete(messageKey);
        return next;
    });
}
