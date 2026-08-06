import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
        surfaceResolverCall: "chatLinkSurfaceOpening(app, chat.id)",
        surfaceHost: "AiAppSurfaceModal",
    },
    {
        label: "desktop direct chat",
        component: "src/components/home/groupdetails/AiAppsDirectSummary.svelte",
        mount: "src/components/home/groupdetails/DirectChatDetails.svelte",
        componentName: "AiAppsDirectSummary",
        mountMarkup: "<AiAppsDirectSummary chatId={chat.id} />",
        surfaceResolverCall: "chatLinkSurfaceOpening(app, chatId, $currentUserIdStore)",
        surfaceHost: "AiAppSurfaceModal",
    },
    {
        label: "mobile group chat",
        component: "src/components_mobile/home/groupdetails/AiAppsSummary.svelte",
        mount: "src/components_mobile/home/groupdetails/GroupDetails.svelte",
        componentName: "AiAppsSummary",
        mountMarkup: "<AiAppsSummary {chat} />",
        surfaceResolverCall: "chatLinkSurfaceOpening(app, chat.id)",
        surfaceHost: "AiAppSurfaceSheet",
    },
    {
        label: "mobile direct chat",
        component: "src/components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
        mount: "src/components_mobile/home/groupdetails/DirectChatDetails.svelte",
        componentName: "AiAppsDirectSummary",
        mountMarkup: "<AiAppsDirectSummary chatId={chat.id} />",
        surfaceResolverCall: "chatLinkSurfaceOpening(app, chatId, $currentUserIdStore)",
        surfaceHost: "AiAppSurfaceSheet",
    },
];

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function compact(value: string): string {
    return value.replace(/\s+/g, " ");
}

describe.each(SETTINGS_ENTRY_POINTS)("$label in-chat Settings AI apps entry point", (entry) => {
    it("is mounted in the chat Settings page", () => {
        const mount = source(entry.mount);
        expect(mount).toContain(
            `import ${entry.componentName} from \"./${entry.componentName}.svelte\"`,
        );
        expect(mount).toContain(entry.mountMarkup);
    });

    it("shows registered chat_link setup through the hardened surface host", () => {
        const component = source(entry.component);
        expect(compact(component)).toContain(compact(entry.surfaceResolverCall));
        expect(component).toContain("setup !== undefined");
        expect(component).toContain('"aiApps.openSetup"');
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
        expect(component).toContain("pendingSetup = setup");
        expect(component).toContain("const setup = pendingSetup");
        expect(component).toMatch(
            /const setup = pendingSetup; pendingSetup = undefined; if \(setup !== undefined\) \{ openSetup\(setup\); \}/,
        );
    });

    it("passes only the shared resolver's URL to the surface host", () => {
        const component = source(entry.component);
        expect(component).toContain("url={setupSurface.url}");
        expect(component).not.toMatch(/url=\{[^}\n]*(?:chatId|chat\.id|currentUserIdStore)/);
        expect(component).not.toContain("{chatKey}");
        expect(component).not.toContain("{chatId}");
        expect(component).not.toContain("{viewerId}");
    });
});

describe("shared chat_link URL privacy used by all Settings entries", () => {
    it("substitutes only public appId and rejects unresolved raw-chat placeholders", () => {
        const resolver = compact(source("src/utils/aiAppSurfaces.ts"));
        const start = resolver.indexOf("export function chatLinkSurfaceOpening(");
        const end = resolver.indexOf("export function cardSurfaceOpening(", start);
        const chatLinkResolver = resolver.slice(start, end);

        expect(chatLinkResolver).toContain("_chatId: ChatIdentifier");
        expect(chatLinkResolver).toContain("_currentUserId?: string");
        expect(chatLinkResolver).toContain("substitutePlaceholders(surface.url, app.id)");
        expect(chatLinkResolver).not.toContain("chatKeyFor(");
        expect(chatLinkResolver).not.toContain("encodeURIComponent(_chatId");
        expect(chatLinkResolver).not.toContain("encodeURIComponent(_currentUserId");

        // The existing behavior suite in aiAppSurfaces.test.ts exercises both successful appId
        // substitution and rejection of legacy {chatKey}; keep that regression alongside this
        // four-entry-point wiring contract rather than duplicating resolver implementation here.
        const resolverBehavior = compact(source("src/utils/aiAppSurfaces.test.ts"));
        expect(resolverBehavior).toContain('url: "https://app.example/setup?app={appId}"');
        expect(resolverBehavior).toContain('url: "https://app.example/setup?chat={chatKey}"');
        expect(resolverBehavior).toContain('expect(opening?.dataDisclosures).toEqual(["app_id"])');
        expect(resolverBehavior).toContain(
            'expect(chatLinkSurfaceOpening(legacy, direct, "scp3f-4qbae-aq")).toBeUndefined()',
        );
    });
});
