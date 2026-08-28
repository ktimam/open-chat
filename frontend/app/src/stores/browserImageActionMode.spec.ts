import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "openchat_browser_image_action_mode";

describe("browser image action mode", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    it("defaults fresh browsers to the selected image model without invoking OCR", async () => {
        const {
            browserImageActionMode,
            browserUsesLocalReaderOnly,
            browserUsesModelOnly,
            browserUsesModelWithLocalVerification,
        } = await import("./browserImageActionMode");
        let selected: string | undefined;
        const unsubscribe = browserImageActionMode.subscribe((mode) => (selected = mode));

        expect(selected).toBe("model_only");
        expect(browserUsesModelOnly()).toBe(true);
        expect(browserUsesModelWithLocalVerification()).toBe(false);
        expect(browserUsesLocalReaderOnly()).toBe(false);
        unsubscribe();
    });

    it("treats an unknown persisted value as model-only", async () => {
        localStorage.setItem(STORAGE_KEY, "retired_mode");

        const { browserImageActionMode } = await import("./browserImageActionMode");
        let selected: string | undefined;
        const unsubscribe = browserImageActionMode.subscribe((mode) => (selected = mode));

        expect(selected).toBe("model_only");
        unsubscribe();
    });

    it("migrates the old local-reader-first choice to OCR-only", async () => {
        localStorage.setItem(STORAGE_KEY, "local_reader_first");

        const { browserImageActionMode, browserUsesLocalReaderOnly } =
            await import("./browserImageActionMode");
        let selected: string | undefined;
        const unsubscribe = browserImageActionMode.subscribe((mode) => (selected = mode));

        expect(selected).toBe("local_reader_only");
        expect(browserUsesLocalReaderOnly()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe("local_reader_only");
        unsubscribe();
    });

    it("persists only the truthful OCR-only mode name", async () => {
        const { browserImageActionMode, browserUsesLocalReaderOnly } =
            await import("./browserImageActionMode");

        browserImageActionMode.set("local_reader_only");

        expect(browserUsesLocalReaderOnly()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe("local_reader_only");
    });

    it("persists every explicit three-way choice without collapsing either isolation mode", async () => {
        const {
            browserImageActionMode,
            browserUsesLocalReaderOnly,
            browserUsesModelOnly,
            browserUsesModelWithLocalVerification,
        } = await import("./browserImageActionMode");

        browserImageActionMode.set("model_with_local_verification");
        expect(browserUsesModelOnly()).toBe(false);
        expect(browserUsesModelWithLocalVerification()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBe("model_with_local_verification");

        browserImageActionMode.set("model_only");
        expect(browserUsesModelOnly()).toBe(true);
        expect(browserUsesModelWithLocalVerification()).toBe(false);
        expect(browserUsesLocalReaderOnly()).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBe("model_only");
    });

    it("skips the outer model readiness gate for browser images with a local recovery path", async () => {
        const { browserImageActionMode, browserImageProposalRequiresModelReadiness } =
            await import("./browserImageActionMode");

        browserImageActionMode.set("local_reader_only");
        expect(browserImageProposalRequiresModelReadiness(true, false)).toBe(false);
        expect(browserImageProposalRequiresModelReadiness(false, false)).toBe(true);
        expect(browserImageProposalRequiresModelReadiness(true, true)).toBe(true);

        browserImageActionMode.set("model_only");
        expect(browserImageProposalRequiresModelReadiness(true, false)).toBe(true);

        browserImageActionMode.set("model_with_local_verification");
        expect(browserImageProposalRequiresModelReadiness(true, false)).toBe(false);
    });
});
