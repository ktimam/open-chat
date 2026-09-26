import type { LocalAppCatalog, LocalAppCatalogEntry } from "./localAppCatalog";
import { buildBoundedAutoProposeVocabulary } from "./autoProposeVocabulary";
import { matchesKeyword } from "./keywordMatch";

export type LocalAppSuggestion = Readonly<{
    appId: string;
    appRevision: string;
    actionId: string;
    title: string;
    appName: string;
    viewerId: string;
    chatKey: string;
    configurationRevision: number;
}>;

/** Local, per-viewer opt-in only. Does not change group permissions or register an app. */
export class LocalAppChatConfiguration {
    #account?: string;
    #catalog?: LocalAppCatalog;
    #revision = 0;
    #enabled = new Map<string, Set<string>>();
    constructor(private readonly changed: () => void = () => {}) {}
    get revision(): number { return this.#revision; }
    #notify() { ++this.#revision; this.changed(); }
    setContext(account: string | undefined, catalog: LocalAppCatalog | undefined): void {
        if (account === this.#account && catalog === this.#catalog) return;
        this.#account = account; this.#catalog = catalog; this.#enabled.clear(); this.#notify();
    }
    setEnabled(account: string, chatKey: string, appId: string, enabled: boolean): boolean {
        if (!account || account !== this.#account || !chatKey || chatKey.length > 512 ||
            !this.#catalog?.apps.some(app => app.id === appId)) return false;
        if (!this.#enabled.has(chatKey) && this.#enabled.size >= 256) return false;
        const apps = new Set(this.#enabled.get(chatKey));
        if (enabled) apps.add(appId); else apps.delete(appId);
        if (apps.size) this.#enabled.set(chatKey, apps); else this.#enabled.delete(chatKey);
        this.#notify(); return true;
    }
    enabled(account: string, chatKey: string, appId: string): boolean {
        return account === this.#account && this.#enabled.get(chatKey)?.has(appId) === true;
    }
    enabledApps(account: string, chatKey: string): readonly LocalAppCatalogEntry[] {
        return this.#catalog?.apps.filter(app => this.enabled(account, chatKey, app.id)) ?? [];
    }
    current(suggestion: LocalAppSuggestion): boolean {
        return suggestion.configurationRevision === this.#revision &&
            this.enabled(suggestion.viewerId, suggestion.chatKey, suggestion.appId) &&
            this.#catalog?.apps.some(app => app.id === suggestion.appId && app.revision === suggestion.appRevision &&
                app.actions.some(action => action.definition.name === suggestion.actionId)) === true;
    }
    /** Only declarative public/private-imported rules; never inspect opaque app processor context. */
    suggestions(account: string, chatKey: string, content: { kind: string; text?: string }): LocalAppSuggestion[] {
        const sources = this.enabledApps(account, chatKey).flatMap(app => app.actions.map(action => ({ app, action })));
        const vocabulary = buildBoundedAutoProposeVocabulary(sources.map(source => source.action.definition));
        const matches = new Set<number>();
        if (content.kind === "image_content") for (const entry of vocabulary.imageEntries) matches.add(entry.actionIndex);
        else if (content.kind === "text_content" && typeof content.text === "string" && content.text.length <= 32768) {
            for (const entry of vocabulary.keywordEntries) if (entry.keywords.some(keyword => matchesKeyword(content.text!, keyword))) matches.add(entry.actionIndex);
        }
        return [...matches].flatMap(index => {
            const source = sources[index];
            return source ? [Object.freeze({ appId: source.app.id, appRevision: source.app.revision,
                actionId: source.action.definition.name, title: source.action.definition.card.title,
                appName: source.app.name, viewerId: account, chatKey, configurationRevision: this.#revision })] : [];
        });
    }
}
