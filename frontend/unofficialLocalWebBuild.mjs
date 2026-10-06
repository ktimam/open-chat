import { cpSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { localAppRelayOrigin } from "./app/localAppRelayHeaders.mjs";
import {
    createUnofficialLocalEnvironment,
    parseUnofficialLocalPort,
} from "./unofficialLocalProfile.mjs";

export const UNOFFICIAL_LOCAL_WEB_MANIFEST = "unofficial-local-web.json";
export const UNOFFICIAL_LOCAL_WEB_VERSION_PREFIX = "2.0.0-localtest.";

export function parseUnofficialLocalWebBuildId(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
        throw new Error(
            "The optimized local web build identifier must contain 32 lowercase hexadecimal characters",
        );
    }
    return value;
}

/** The CLI creates a fresh directory. This path can never authorize a clean/delete operation. */
export function validateUnofficialWebOutput(output, repositoryRoot) {
    if (typeof output !== "string" || !path.isAbsolute(output) || output.includes("\0")) {
        throw new Error(
            "The optimized local web output must be an absolute existing empty directory",
        );
    }
    const resolved = path.resolve(output);
    const root = path.parse(resolved).root;
    if (resolved === root || resolved === path.resolve(repositoryRoot)) {
        throw new Error("The optimized local web output cannot be a filesystem or repository root");
    }
    // Reject symbolic links/junctions anywhere in the chain before any build write occurs.
    for (let entry = resolved; entry !== path.dirname(entry); entry = path.dirname(entry)) {
        if (lstatSync(entry).isSymbolicLink())
            throw new Error("The optimized local web output cannot traverse a link");
    }
    if (!lstatSync(resolved).isDirectory() || readdirSync(resolved).length !== 0) {
        throw new Error("The optimized local web output must already exist and be empty");
    }
    if (path.resolve(realpathSync(resolved)).toLowerCase() !== resolved.toLowerCase()) {
        throw new Error("The optimized local web output must resolve to its literal path");
    }
    return resolved;
}

/** Optimization is independent from deployment policy; this is still localhost-only development. */
export function createUnofficialLocalWebBuildEnvironment(canisters, options = {}) {
    const { output, repositoryRoot, buildId: requestedBuildId, ...profileOptions } = options;
    const validatedOutput = validateUnofficialWebOutput(output, repositoryRoot);
    const buildId = parseUnofficialLocalWebBuildId(
        requestedBuildId ?? randomBytes(16).toString("hex"),
    );
    return Object.freeze({
        ...createUnofficialLocalEnvironment(canisters, profileOptions),
        NODE_ENV: "production",
        OC_NODE_ENV: "development",
        OC_UNOFFICIAL_WEB_BUILD: "true",
        OC_UNOFFICIAL_WEB_OUTPUT: validatedOutput,
        OC_UNOFFICIAL_WEB_BUILD_ID: buildId,
        OC_WEBSITE_VERSION: `${UNOFFICIAL_LOCAL_WEB_VERSION_PREFIX}${buildId}`,
    });
}

export function unofficialLocalWebManifest(environment) {
    const port = parseUnofficialLocalPort(environment.OC_DEV_PORT);
    const buildId = parseUnofficialLocalWebBuildId(environment.OC_UNOFFICIAL_WEB_BUILD_ID);
    if (
        environment.OC_UNOFFICIAL_CLIENT !== "true" ||
        environment.OC_UNOFFICIAL_WEB_BUILD !== "true" ||
        environment.OC_APP_TYPE !== "web" ||
        environment.OC_BUILD_ENV !== "development" ||
        environment.NODE_ENV !== "production" ||
        environment.OC_NODE_ENV !== "development" ||
        environment.OC_DFX_NETWORK !== "ic" ||
        environment.OC_OTA_UPDATES !== "none" ||
        environment.OC_WEBAUTHN_ORIGIN !== "localhost" ||
        environment.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY !== "immutable-hub-v1" ||
        environment.OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE !== "true" ||
        environment.OC_WEBSITE_VERSION !== `${UNOFFICIAL_LOCAL_WEB_VERSION_PREFIX}${buildId}` ||
        environment.OC_IC_URL !== "https://icp-api.io" ||
        environment.OC_BASE_ORIGIN !== `http://localhost:${port}` ||
        !["v1", "v2"].includes(environment.OC_MOBILE_LAYOUT)
    ) {
        throw new Error("The optimized web artifact must use the pinned unofficial local profile");
    }
    return Object.freeze({
        schemaVersion: 1,
        profile: "unofficial-local-web",
        buildMode: "optimized",
        version: environment.OC_WEBSITE_VERSION,
        runtimeNodeEnvironment: "development",
        port,
        origin: environment.OC_BASE_ORIGIN,
        layout: environment.OC_MOBILE_LAYOUT,
        officialBackend: "https://icp-api.io",
        // The original OpenChat authentication flow was restored; this marker must not
        // claim that the optional existing-account-only guard is active.
        existingAccountOnly: false,
        clientOnlyApps: true,
        ota: "none",
        native: false,
        relay: {
            html: "/local-app-handoff.html",
            script: "/local-app-handoff.js",
            appOrigin: localAppRelayOrigin(environment.OC_APP_DIRECTORY_URL),
        },
    });
}

/** Public files complement the generated bundle, never replace generated scripts/key/relay. */
export function copyUnofficialWebPublicFiles(publicDirectory, outputDirectory) {
    cpSync(publicDirectory, outputDirectory, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter(source) {
            const relative = path.relative(publicDirectory, source).replaceAll("\\", "/");
            if (!relative) return true;
            const segments = relative.split("/");
            if (
                segments.some((segment) => segment.startsWith(".")) ||
                [
                    "public-key",
                    "local-app-handoff.html",
                    "local-app-handoff.js",
                    "local-app-setup.html",
                    "local-app-setup.js",
                    "index.html",
                    "service_worker.js",
                    UNOFFICIAL_LOCAL_WEB_MANIFEST,
                ].includes(relative)
            )
                return false;
            if (lstatSync(source).isSymbolicLink())
                throw new Error("Local web public assets cannot contain links");
            return true;
        },
    });
}
