// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseLocalAppCatalog } from "./localAppCatalog";
import { directoryFixture } from "./localAppDirectory.testFixtures";
import { isLocalAiApp, localAppDirectoryPresentation } from "./localAppDirectoryPresentation";

describe("app-directory presentation without registry impersonation", () => {
    it("projects public metadata without claiming unknown action counts or a connection", async () => {
        const { directory } = await directoryFixture();
        const [app] = localAppDirectoryPresentation(directory, undefined, {}, []);
        expect(app).toMatchObject({
            connectionKind: "local",
            id: "sample",
            connected: false,
            actionsKnown: false,
            setupOrigin: "https://publisher.test",
        });
        expect(app.manifest.actions).toEqual([]);
        expect(app).not.toHaveProperty("owner");
        expect(app).not.toHaveProperty("published");
        expect(app.manifest).not.toHaveProperty("perUserKeys");
        expect(isLocalAiApp(app)).toBe(true);
    });
    it("projects connected action labels but never prompts, private setup, destinations, keys or schemas", async () => {
        const fixture = await directoryFixture("sample", "1", true);
        const catalog = parseLocalAppCatalog(fixture.connectedJson);
        const [app] = localAppDirectoryPresentation(fixture.directory, catalog, {}, []);
        expect(app.connected).toBe(true);
        expect(app.actionsKnown).toBe(true);
        expect(app.manifest.actions).toEqual([{ name: "add", description: "Add item" }]);
        const json = JSON.stringify(app);
        for (const privateValue of [
            "Synthetic private account",
            "Private choice",
            "Read only the selected message",
            "/import/sample",
            "draftSchema",
            "processorContext",
            "publicKey",
        ])
            expect(json).not.toContain(privateValue);
    });
    it("keeps disabled connections visible and never reports them disconnected", async () => {
        const fixture = await directoryFixture();
        const [app] = localAppDirectoryPresentation(fixture.directory, fixture.pkg.catalog, {}, [
            "sample",
        ]);
        expect(app.connected).toBe(true);
        expect(app.status).toContain("connection is retained");
    });
    it("retains removed connected apps without inventing a reconnect destination", async () => {
        const fixture = await directoryFixture();
        const [app] = localAppDirectoryPresentation(
            { version: 1, apps: [] },
            fixture.pkg.catalog,
            {},
            [],
        );
        expect(app.connected).toBe(true);
        expect(app.setupOrigin).toBeUndefined();
        expect(app.id).toBe("sample");
    });
    it("deduplicates the installed/public app and preserves update messages", async () => {
        const fixture = await directoryFixture();
        const apps = localAppDirectoryPresentation(
            fixture.directory,
            fixture.pkg.catalog,
            { sample: "Reconnect to approve the updated setup." },
            [],
        );
        expect(apps).toHaveLength(1);
        expect(apps[0].status).toBe("Reconnect to approve the updated setup.");
    });
    it("handles an empty directory and no restored setup", () => {
        expect(localAppDirectoryPresentation(undefined, undefined, {}, [])).toEqual([]);
    });
});
