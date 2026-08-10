import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "../..");

type SettingsEntryPoint = {
    label: string;
    component: string;
    mount: string;
    componentName: "AiAppsSummary" | "AiAppsDirectSummary";
    mountMarkup: string;
    surfaceResolverCall: string;
    surfaceHost: "AiAppSurfaceModal" | "AiAppSurfaceSheet";
};

const SETTINGS_ENTRY_POINTS: SettingsEntryPoint[] = [
    {
        label: "desktop group chat",
        component: "src/components/home/groupdetails/AiAppsSummary.svelte",
        mount: "src/components/home/groupdetails/GroupDetailsBody.svelte",
        componentName: "AiAppsSummary",
        mountMarkup: "<AiAppsSummary {chat} />",
        surfaceResolverCall: "createChatLinkSurfaceOpening(client, app, chatId)",
        surfaceHost: "AiAppSurfaceModal",
    },
    {
        label: "desktop direct chat",
        component: "src/components/home/groupdetails/AiAppsDirectSummary.svelte",
        mount: "src/components/home/groupdetails/DirectChatDetails.svelte",
        componentName: "AiAppsDirectSummary",
        mountMarkup: "<AiAppsDirectSummary chatId={chat.id} />",
        surfaceResolverCall: "createChatLinkSurfaceOpening(client, app, chatId)",
        surfaceHost: "AiAppSurfaceModal",
    },
    {
        label: "mobile group chat",
        component: "src/components_mobile/home/groupdetails/AiAppsSummary.svelte",
        mount: "src/components_mobile/home/groupdetails/GroupDetails.svelte",
        componentName: "AiAppsSummary",
        mountMarkup: "<AiAppsSummary {chat} />",
        surfaceResolverCall: "createChatLinkSurfaceOpening(client, app, chatId)",
        surfaceHost: "AiAppSurfaceSheet",
    },
    {
        label: "mobile direct chat",
        component: "src/components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
        mount: "src/components_mobile/home/groupdetails/DirectChatDetails.svelte",
        componentName: "AiAppsDirectSummary",
        mountMarkup: "<AiAppsDirectSummary chatId={chat.id} />",
        surfaceResolverCall: "createChatLinkSurfaceOpening(client, app, chatId)",
        surfaceHost: "AiAppSurfaceSheet",
    },
];

function source(path: string): string {
    return readFileSync(resolve(APP_ROOT, path), "utf8");
}

function compact(value: string): string {
    return value.replace(/\s+/g, " ");
}

describe.each(SETTINGS_ENTRY_POINTS)("$label in-chat Settings AI apps entry point", (entry) => {
    it("is mounted in the chat Settings page", () => {
        const mount = source(entry.mount);
        expect(mount).toContain(
            `import ${entry.componentName} from "./${entry.componentName}.svelte"`,
        );
        expect(mount).toContain(entry.mountMarkup);
    });

    it("shows registered chat_link setup through the hardened surface host", () => {
        const component = source(entry.component);
        expect(compact(component)).toContain(compact(entry.surfaceResolverCall));
        expect(component).toContain("hasChatLinkSurface(app)");
        expect(component).toContain('"aiApps.openSetup"');
        expect(component).toContain("openingSetup === app.id");
        expect(component).toContain('i18nKey("aiApps.openSetupFailed")');
        expect(component).toContain(`<${entry.surfaceHost}`);
        expect(component).toContain("url={setupSurface.url}");
    });

    it("never labels an already-connected app as Connect", () => {
        const component = compact(source(entry.component));
        const mergedPrimaryLabel = 'needsPairing ? "aiApps.connect" : "aiApps.openSetup"';
        const explicitConnectionLabel =
            'connected.has(app.id) ? "aiApps.reconnect" : "aiApps.connect"';

        expect(component).toContain('"aiApps.reconnect"');
        expect(
            component.includes(mergedPrimaryLabel) || component.includes(explicitConnectionLabel),
        ).toBe(true);
    });

    it("defers an unconnected per-user-key app's setup until pairing succeeds", () => {
        const component = compact(source(entry.component));

        expect(component).toContain(
            "const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)",
        );
        expect(component).toContain("onClick={() => startConnect(app)}");
        expect(component).toContain("bindPendingChatLinkSetup(app");
        expect(component).toContain("pendingChatLinkSetupAppForChat(");
        expect(component).toContain("pendingSetup = undefined");
        expect(component).toContain("if (app !== undefined) void openSetup(app)");
    });

    it("cancels the exact minted token only when setup is dismissed before handoff", () => {
        const component = compact(source(entry.component));
        expect(component).toContain("let setupHandedOff = $state(false)");
        expect(component).toContain("onConsent={() => (setupHandedOff = true)}");
        expect(component).toContain("onDismiss={dismissSetup}");
        expect(component).toContain("client.cancelAiAppChatLinkToken(opening.chatLinkToken)");
        expect(component).toContain("opening !== undefined && !setupHandedOff");
    });

    it("serializes setup mints and cancels a result made stale by chat change or unmount", () => {
        const component = compact(source(entry.component));

        expect(component).toContain(
            "if (openingSetup !== undefined || setupSurface !== undefined) return",
        );
        expect(component).toContain("let openingRequest = 0");
        expect(component).toContain("const request = ++openingRequest");
        expect(component).toContain("openingSetup = app.id");
        expect(component).toContain("request !== openingRequest");
        expect(component).toContain("$effect(() => {");
        expect(component).toContain("chatIdentifierToString(");
        expect(component).toContain("openingRequest += 1");
        expect(component).toContain(
            "disabled={openingSetup !== undefined && openingSetup !== app.id}",
        );
        expect(component).toContain("await client.cancelAiAppChatLinkToken(opening.chatLinkToken)");
    });

    it("passes only the shared resolver's URL to the surface host", () => {
        const component = source(entry.component);
        expect(component).toContain("url={setupSurface.url}");
        expect(component).not.toMatch(/url=\{[^}\n]*(?:chatId|chat\.id|currentUserIdStore)/);
        // `chatId` is now intentionally passed to the local, sandboxed private-match consent
        // control. The external setup surface must still receive only the URL minted by the shared
        // resolver; the URL-specific assertion above is the actual disclosure boundary.
    });
});

describe("direct Settings app discovery", () => {
    for (const entry of SETTINGS_ENTRY_POINTS.filter(
        (candidate) => candidate.componentName === "AiAppsDirectSummary",
    )) {
        it(`${entry.label} uses the shared deterministic direct-app catalog`, () => {
            const component = source(entry.component);
            expect(component).toContain(
                'import { isDirectChatCardApp, loadDirectChatAiApps } from "@utils/aiAppDirectChat"',
            );
            expect(component).toContain("const direct = await loadDirectChatAiApps(client)");
            expect(component).toContain("apps = direct.apps");
            expect(component).toContain("connected = new Set(direct.connectedKeys.keys())");
            expect(component).toContain("exactAppIds = new Set(direct.exactAppIds)");
            expect(component).toContain("isDirectChatCardApp(app)");
            expect(component).toContain("!connected.has(app.id) || exactAppIds.has(app.id)");
            expect(component).not.toContain("client.exploreAiApps(");
            expect(component).not.toContain("client.aiApps(");
            expect(component).not.toContain("client.myAiAppKeys(");
        });
    }
});

describe("shared chat_link URL privacy used by all Settings entries", () => {
    it("mints one canonical opaque fragment token and rejects raw-chat placeholders", () => {
        const resolver = compact(source("src/utils/aiAppSurfaces.ts"));
        const start = resolver.indexOf("export async function createChatLinkSurfaceOpening(");
        const end = resolver.indexOf("export interface PendingChatLinkSetup", start);
        const chatLinkResolver = resolver.slice(start, end);

        expect(resolver).toContain("export function hasChatLinkSurface(");
        expect(chatLinkResolver).toContain("const descriptor = chatLinkDescriptor(app)");
        expect(chatLinkResolver).toContain("descriptor.appId");
        expect(chatLinkResolver).toContain("descriptor.appRevision");
        expect(chatLinkResolver).toContain("CHAT_LINK_TOKEN_PLACEHOLDER");
        expect(resolver).toContain("template.split(CHAT_LINK_TOKEN_PLACEHOLDER)");
        expect(resolver).toContain('template.indexOf("#")');
        expect(chatLinkResolver).not.toContain("chatKeyFor(");
        expect(chatLinkResolver).not.toContain("encodeURIComponent(chatId");
        expect(chatLinkResolver).not.toContain("currentUserId");

        // The existing behavior suite in aiAppSurfaces.test.ts exercises both successful appId
        // substitution and rejection of legacy {chatKey}; keep that regression alongside this
        // four-entry-point wiring contract rather than duplicating resolver implementation here.
        const resolverBehavior = compact(source("src/utils/aiAppSurfaces.test.ts"));
        expect(resolverBehavior).toContain(
            'url: "https://app.example/setup#app={appId}&token={chatLinkToken}"',
        );
        expect(resolverBehavior).toContain(
            'url: "https://app.example/settings#openchat-routing/{chatLinkToken}"',
        );
        expect(resolverBehavior).toContain('url: "https://app.example/setup?chat={chatKey}"');
        expect(resolverBehavior).toContain('"one_time_chat_link_token"');
        expect(resolverBehavior).toContain("expect(first?.url).not.toBe(second?.url)");
        expect(resolverBehavior).toContain("expect(hasChatLinkSurface(legacy)).toBe(false)");
    });
});
