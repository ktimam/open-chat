import type { OpenChat } from "@client";
import type { AiAppRegistration, AiAppUserKey } from "@shared";

const DIRECT_AI_APP_DIRECTORY_PAGE_SIZE = 8;
const MAX_DIRECT_AI_APP_EXACT_LOOKUPS = 32;

export interface DirectChatAiApps {
    apps: AiAppRegistration[];
    connectedKeys: ReadonlyMap<number, string>;
    connectedKeyVersions: ReadonlyMap<number, bigint>;
    exactAppIds: ReadonlySet<number>;
}

export interface ConnectedDirectChatAiApp {
    app: AiAppRegistration;
    recipientKey: string;
}

type AiAppUserKeyInput = Pick<AiAppUserKey, "appId" | "publicKey"> &
    Partial<Pick<AiAppUserKey, "keyVersion">>;

interface DirectChatAiAppConnection {
    publicKey: string;
    keyVersion: bigint;
}

// The backend stores one row per (user, app), but normalize defensively so malformed duplicates do
// not make connection state depend on wire order. Empty keys and lower epochs sort first, causing a
// duplicate conflict to retain the least-authoritative state.
export function directChatAiAppConnections(
    keys: readonly AiAppUserKeyInput[],
): Map<number, DirectChatAiAppConnection> {
    const sorted = [...keys].sort((left, right) => {
        const byId = left.appId - right.appId;
        if (byId !== 0) return byId;
        const byKey = left.publicKey.localeCompare(right.publicKey);
        if (byKey !== 0) return byKey;
        const leftVersion = left.keyVersion ?? 0n;
        const rightVersion = right.keyVersion ?? 0n;
        return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0;
    });
    const byAppId = new Map<number, DirectChatAiAppConnection>();
    for (const key of sorted) {
        if (!byAppId.has(key.appId)) {
            byAppId.set(key.appId, {
                publicKey: key.publicKey,
                keyVersion: key.keyVersion ?? 0n,
            });
        }
    }
    return byAppId;
}

export function directChatAiAppKeys(keys: readonly AiAppUserKeyInput[]): Map<number, string> {
    return new Map(
        [...directChatAiAppConnections(keys)].map(([appId, connection]) => [
            appId,
            connection.publicKey,
        ]),
    );
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
    const allConnections = directChatAiAppConnections(keys);
    const allKeys = new Map(
        [...allConnections].map(([appId, connection]) => [appId, connection.publicKey]),
    );
    const exactIds = [...allKeys.keys()]
        .sort((left, right) => left - right)
        .slice(0, MAX_DIRECT_AI_APP_EXACT_LOOKUPS);
    const exact =
        exactIds.length === 0 ? [] : await client.aiApps(exactIds.map((appId) => ({ appId })));
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

    const connectedKeys = new Map([...allKeys].filter(([, publicKey]) => publicKey.length > 0));
    const connectedKeyVersions = new Map(
        [...allConnections]
            .filter(([, connection]) => connection.publicKey.length > 0)
            .map(([appId, connection]) => [appId, connection.keyVersion]),
    );
    return {
        apps: [...byAppId.values()].sort((left, right) => left.id - right.id),
        connectedKeys,
        connectedKeyVersions,
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
