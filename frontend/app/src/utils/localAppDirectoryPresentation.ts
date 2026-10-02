import type { AiAppRegistration } from "@client";
import type { LocalAppCatalog, LocalAppCatalogEntry } from "./localAppCatalog";
import type { LocalAppDirectory } from "./localAppDirectory";

/** Display-only adapter. A publisher directory entry is not a canister registration. */
export interface LocalAiAppPresentation {
    readonly connectionKind: "local";
    readonly id: string;
    readonly manifest: {
        readonly name: string;
        readonly description: string;
        readonly iconUrl?: undefined;
        readonly actions: readonly { readonly name: string; readonly description: string }[];
    };
    readonly connected: boolean;
    readonly actionsKnown: boolean;
    readonly setupOrigin?: string;
    readonly status?: string;
}

export type AiAppPresentation = AiAppRegistration | LocalAiAppPresentation;

export function isLocalAiApp(app: AiAppPresentation): app is LocalAiAppPresentation {
    return "connectionKind" in app && app.connectionKind === "local";
}

export function localAppDirectoryPresentation(
    directory: LocalAppDirectory | undefined,
    catalog: LocalAppCatalog | undefined,
    updates: Readonly<Record<string, string>>,
    disabledAppIds: readonly string[],
): LocalAiAppPresentation[] {
    const installed = new Map(catalog?.apps.map((app) => [app.id, app]) ?? []);
    const entries = (directory?.apps ?? []).map((descriptor) => {
        const app = installed.get(descriptor.id);
        installed.delete(descriptor.id);
        return entry(
            descriptor.id,
            descriptor.name,
            descriptor.description,
            app,
            descriptor.setupUrl,
        );
    });
    // Retain an honest connection/disconnect surface when a publisher removes an app.
    for (const app of installed.values())
        entries.push(entry(app.id, app.name, app.description, app));
    return entries;

    function entry(
        id: string,
        name: string,
        description: string,
        app?: LocalAppCatalogEntry,
        setupUrl?: string,
    ): LocalAiAppPresentation {
        return {
            connectionKind: "local",
            id,
            manifest: {
                name,
                description,
                actions:
                    app?.actions.map(({ definition }) => ({
                        name: definition.name,
                        description: definition.description,
                    })) ?? [],
            },
            connected: app !== undefined,
            actionsKnown: app !== undefined,
            setupOrigin: setupUrl === undefined ? undefined : new URL(setupUrl).origin,
            status: disabledAppIds.includes(id)
                ? "This app is disabled for new proposals. Its connection is retained; reconnect or disconnect below."
                : updates[id],
        };
    }
}
