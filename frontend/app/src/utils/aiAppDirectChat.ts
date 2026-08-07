import type { OpenChat } from "@client";
import type { AiAppRegistration, AiAppUserKey } from "@shared";

const DIRECT_AI_APP_DIRECTORY_PAGE_SIZE = 8;
const MAX_DIRECT_AI_APP_EXACT_LOOKUPS = 32;

export interface DirectChatAiApps {
    apps: AiAppRegistration[];
    connectedKeys: ReadonlyMap<number, string>;
    exactAppIds: ReadonlySet<number>;
}

export interface ConnectedDirectChatAiApp {
    app: AiAppRegistration;
    recipientKey: string;
}

// The backend stores one row per (user, app), but normalize defensively so malformed duplicate
// responses cannot make connection state depend on wire order. Empty sorts first and therefore wins
// a duplicate conflict fail-closed.
export function directChatAiAppKeys(keys: AiAppUserKey[]): Map<number, string> {
    const sorted = [...keys].sort(
        (left, right) =>
            left.appId - right.appId || left.publicKey.localeCompare(right.publicKey),
    );
    const byAppId = new Map<number, string>();
    for (const key of sorted) {
        if (!byAppId.has(key.appId)) byAppId.set(key.appId, key.publicKey);
    }
    return byAppId;
}

export function isDirectChatCardApp(app: AiAppRegistration): boolean {
    return app.published && app.manifest.perUserKeys === true;
}

// Direct chats have no owner/admin enablement set. Their generic app catalog is the bounded
// published directory page plus exact registrations for apps this user has paired before. Exact
// rows override directory snapshots, ids are deduplicated, and presentation/action order is stable.
export async function loadDirectChatAiApps(client: OpenChat): Promise<DirectChatAiApps> {
    const [keys, directory] = await Promise.all([
        client.myAiAppKeys(),
        client.exploreAiApps(undefined, 0, DIRECT_AI_APP_DIRECTORY_PAGE_SIZE),
    ]);
    const allKeys = directChatAiAppKeys(keys);
    const exactIds = [...allKeys.keys()]
        .sort((left, right) => left - right)
        .slice(0, MAX_DIRECT_AI_APP_EXACT_LOOKUPS);
    const exact =
        exactIds.length === 0
            ? []
            : await client.aiApps(exactIds.map((appId) => ({ appId })));
    const requestedExactIds = new Set(exactIds);
    const exactAppIds = new Set<number>();
    const byAppId = new Map<number, AiAppRegistration>();

    for (const app of directory.matches) {
        if (app.published) byAppId.set(app.id, app);
    }
    for (const app of exact) {
        if (!requestedExactIds.has(app.id) || !app.published) continue;
        byAppId.set(app.id, app);
        exactAppIds.add(app.id);
    }

    const connectedKeys = new Map(
        [...allKeys].filter(([, publicKey]) => publicKey.length > 0),
    );
    return {
        apps: [...byAppId.values()].sort((left, right) => left.id - right.id),
        connectedKeys,
        exactAppIds,
    };
}

// Resolve a stored direct-chat card only through its immutable producer coordinates and only for a
// viewer who is currently paired to that per-user-key app. No directory/action-name fallback.
export async function resolveConnectedDirectChatAiApp(
    client: OpenChat,
    appId: number,
    appRevision: bigint,
): Promise<ConnectedDirectChatAiApp | undefined> {
    const keys = directChatAiAppKeys(await client.myAiAppKeys());
    const recipientKey = keys.get(appId);
    if (recipientKey === undefined || recipientKey.length === 0) return undefined;

    const apps = await client.aiApps([{ appId, revision: appRevision }]);
    const app = apps.find(
        (candidate) =>
            candidate.id === appId &&
            candidate.updated === appRevision &&
            isDirectChatCardApp(candidate),
    );
    return app === undefined ? undefined : { app, recipientKey };
}
