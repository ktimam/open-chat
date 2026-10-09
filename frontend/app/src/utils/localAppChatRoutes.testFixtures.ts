import { directoryFixture, directorySource } from "./localAppDirectory.testFixtures";
import { parseLocalAppCatalog } from "./localAppCatalog";
import type { LocalAppInstallation } from "./localAppDirectory";
import type { LocalAppAccountConnection, LocalAppChatSetup } from "./localAppChatRoutes";

export const scopedAccountId = "A".repeat(43);
export const routeHandle = (n: number) => `${"A".repeat(41)}${String.fromCharCode(65 + n)}A`;
export async function scopedAppFixture() {
    const fixture = await directoryFixture();
    const app = { ...fixture.pkg.catalog.apps[0], setupScopes: ["account", "chat"] as const };
    const catalog = parseLocalAppCatalog(JSON.stringify({ version: 1, apps: [app] }));
    const publicCatalogJson = JSON.stringify(catalog);
    const bytes = new TextEncoder().encode(publicCatalogJson);
    const sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const installation: LocalAppInstallation = {
        appId: app.id,
        sourceUrl: directorySource,
        publicCatalogJson,
        descriptor: {
            ...fixture.descriptor,
            catalog: { ...fixture.descriptor.catalog, sha256, byteLength: bytes.byteLength },
        },
    };
    const connections: readonly LocalAppAccountConnection[] = [
        { appId: app.id, accountId: scopedAccountId },
    ];
    const route = (chatKey: string, n: number, keyword = `choice${n}`): LocalAppChatSetup => ({
        appId: app.id,
        chatKey,
        handle: routeHandle(n),
        accountId: scopedAccountId,
        catalogJson: JSON.stringify({
            version: 1,
            apps: [
                {
                    ...app,
                    recipientLabel: `Destination ${n}`,
                    actions: app.actions.map((action) => ({
                        ...action,
                        processorContext: { privateOptions: [keyword] },
                        definition: {
                            ...action.definition,
                            rules: [
                                {
                                    kind: "keyword_map",
                                    field: "value",
                                    mode: "hint",
                                    map: [{ value: String(n), keywords: [keyword] }],
                                },
                            ],
                        },
                    })),
                },
            ],
        }),
    });
    return { ...fixture, catalog, installation, connections, route };
}
