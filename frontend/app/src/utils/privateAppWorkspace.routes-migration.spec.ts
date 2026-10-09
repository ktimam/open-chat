// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PrivateAppWorkspace, type ConnectLocalAppSetup } from "./privateAppWorkspace";
import { directorySource } from "./localAppDirectory.testFixtures";
import { scopedAppFixture, scopedAccountId } from "./localAppChatRoutes.testFixtures";
import { resolveLocalAppForChat } from "./localAppChatRoutes";
import {
    encodeLocalAppSetup,
    decodeLocalAppSetup,
    type LocalAppSetupStorage,
} from "./localAppSetupStore";
import { verifyImportedLocalProcessor } from "./isolatedAppProcessor";
import type { LocalAppSetupContext } from "./localAppScopedSetup";

vi.mock("@client", () => ({ currentUserIdStore: { value: "synthetic-account" } }));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./nativeAppDelivery", () => ({
    nativeAppDelivery: {},
    nativeDeliveryAllowed: () => false,
}));
vi.mock("./localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: vi.fn(),
    cancelLocalAppHandoffs: vi.fn(),
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));

async function fixture() {
    const f = await scopedAppFixture();
    let scoped = false;
    let saved: string | undefined;
    let pause: Promise<void> | undefined;
    const contexts: LocalAppSetupContext[] = [];
    const oldCatalogJson = JSON.stringify({
        version: 1,
        apps: [{ ...f.pkg.catalog.apps[0], recipientLabel: "Existing shared destination" }],
    });
    const refreshedCatalogJson = JSON.stringify({
        version: 1,
        apps: [{ ...f.catalog.apps[0], recipientLabel: "Existing shared destination" }],
    });
    const storage: LocalAppSetupStorage = {
        read: async (scope) => (saved ? decodeLocalAppSetup(scope, saved) : undefined),
        write: async (scope, value) => {
            saved = await encodeLocalAppSetup(scope, value);
        },
        remove: async () => {
            saved = undefined;
        },
    };
    const connect = vi.fn<ConnectLocalAppSetup>(async (_descriptor, _signal, pending) => {
        const context = await pending;
        if (!context) return oldCatalogJson;
        contexts.push(context);
        await pause;
        return JSON.stringify({
            version: 2,
            scope: context.scope,
            appId: "sample",
            accountId: scopedAccountId,
            catalogJson: refreshedCatalogJson,
            routes:
                context.scope === "chat"
                    ? [
                          {
                              handle: context.handle,
                              catalogJson: f.route("not-transmitted", 2).catalogJson,
                          },
                      ]
                    : context.routes,
        });
    });
    const deps = {
        extract: vi.fn(),
        runProcessor: vi.fn(),
        verifyProcessor: verifyImportedLocalProcessor,
        deliver: vi.fn(),
        deliverySaved: () => false,
        cancelDelivery: vi.fn(),
        setupStorage: storage,
        loadDirectory: vi.fn(async () => ({
            version: 1 as const,
            apps: [scoped ? f.installation.descriptor : f.descriptor],
        })),
        loadPublicPackage: vi.fn(async () =>
            scoped
                ? {
                      catalog: f.catalog,
                      catalogJson: f.installation.publicCatalogJson,
                      processor: f.processor,
                  }
                : f.pkg,
        ),
        connectAppSetup: connect,
    };
    const workspace = new PrivateAppWorkspace(deps);
    workspace.setAccount("viewer", "https://backend.test|index");
    await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
    workspace.configureDirectory(directorySource);
    await workspace.refreshDirectory();
    expect(await workspace.connectApp("sample")).toBe(true);
    workspace.replaceEnabledChats("viewer", workspace.state.catalog!, [
        { chatKey: "private-chat-A", appIds: ["sample"] },
        { chatKey: "private-chat-B", appIds: ["sample"] },
    ]);
    const resolve = (chat: string) =>
        resolveLocalAppForChat(
            workspace.state.catalog,
            workspace.state.connections,
            workspace.state.chatSetups,
            "sample",
            chat,
        );
    return {
        workspace,
        deps,
        contexts,
        resolve,
        oldCatalogJson,
        async upgrade() {
            scoped = true;
            await workspace.refreshDirectory();
        },
        pause(value: Promise<void>) {
            pause = value;
        },
    };
}

describe("legacy shared setup migration", () => {
    it("keeps only previously enabled chats on the old destination and assigns one chat independently", async () => {
        const f = await fixture();
        await f.upgrade();
        expect(f.workspace.state.catalog?.apps[0].setupScopes).toBeUndefined();
        expect(await f.workspace.connectApp("sample")).toBe(true);
        expect(f.contexts[0]).toEqual({
            version: 2,
            scope: "account",
            legacyCatalogJson: f.oldCatalogJson,
            routes: [],
        });
        expect(JSON.stringify(f.contexts)).not.toContain("private-chat-");
        expect(f.workspace.state.connections[0].legacyChatKeys).toEqual([
            "private-chat-A",
            "private-chat-B",
        ]);
        expect(f.resolve("private-chat-A")?.recipientLabel).toBe("Existing shared destination");
        expect(f.resolve("private-chat-B")?.recipientLabel).toBe("Existing shared destination");
        f.workspace.replaceEnabledChats("viewer", f.workspace.state.catalog!, [
            ...f.workspace.state.enabledChats,
            { chatKey: "new-private-chat", appIds: ["sample"] },
        ]);
        expect(f.resolve("new-private-chat")).toBeUndefined();
        await f.workspace.configureChat("sample", "private-chat-A");
        expect(f.workspace.state.connections[0].legacyChatKeys).toEqual(["private-chat-B"]);
        expect(f.resolve("private-chat-A")?.recipientLabel).toBe("Destination 2");
        expect(f.resolve("private-chat-B")?.recipientLabel).toBe("Existing shared destination");
        expect(f.resolve("new-private-chat")).toBeUndefined();
        expect(f.deps.deliver).not.toHaveBeenCalled();
    });
    it("does not install a scoped reconnect response after account logout", async () => {
        const f = await fixture();
        await f.upgrade();
        let release!: () => void;
        f.pause(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const connecting = f.workspace.connectApp("sample");
        await vi.waitFor(() => expect(f.contexts).toHaveLength(1));
        f.workspace.setAccount(undefined);
        expect(await connecting).toBe(false);
        release();
        await Promise.resolve();
        expect(f.workspace.state.catalog).toBeUndefined();
        expect(f.workspace.state.connections).toEqual([]);
        expect(f.workspace.state.chatSetups).toEqual([]);
        expect(f.deps.deliver).not.toHaveBeenCalled();
    });
});
