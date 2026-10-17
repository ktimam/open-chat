// @vitest-environment node
import { describe, expect, it } from "vitest";
import { derived, get, LocalStorageStore, writable } from "@client/reactiveStores";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonConfigFileContent, readConfigFile, resolveModuleName, sys } from "typescript";

describe("DOM-free public store entry point", () => {
    it("loads real store primitives without initializing the browser client", () => {
        expect(typeof window).toBe("undefined");
        const source = writable(2);
        const doubled = derived(source, (value) => value * 2);
        expect(get(doubled)).toBe(4);
        source.set(3);
        expect(get(doubled)).toBe(6);
        expect(typeof LocalStorageStore).toBe("function");
    });

    it.each([
        ["./stores", "openchat-client/src/openchat.ts", "openchat-client/src/stores/index.ts"],
        [
            "../../stores",
            "openchat-client/src/state/unread/markRead.ts",
            "openchat-client/src/stores/index.ts",
        ],
        [
            "@client/reactiveStores",
            "app/src/utils/nativeAppDelivery.ts",
            "openchat-client/src/reactiveStores.ts",
        ],
    ])("keeps %s resolved to its intended public module", (specifier, importer, expected) => {
        const frontend = fileURLToPath(new URL("../../", import.meta.url));
        const config = readConfigFile(resolve(frontend, "tsconfig.json"), sys.readFile);
        expect(config.error).toBeUndefined();
        const { options } = parseJsonConfigFileContent(config.config, sys, frontend);
        expect(existsSync(resolve(frontend, importer))).toBe(true);
        const result = resolveModuleName(specifier, resolve(frontend, importer), options, sys);
        expect(result.resolvedModule).toBeDefined();
        const resolved = result.resolvedModule!.resolvedFileName;
        expect(relative(frontend, resolved).replaceAll("\\", "/")).toBe(expected);
    });
});
