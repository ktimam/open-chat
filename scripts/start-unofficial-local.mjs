#!/usr/bin/env node
/** Local full-client prototype. Importing this module never starts a process or reads credentials. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createUnofficialLocalEnvironment, parseUnofficialLocalPort, parseAppDirectoryUrl } from "../frontend/unofficialLocalProfile.mjs";

export function parseUnofficialLocalArgs(args) {
    const options = { port: 5190, layout: "v2", help: false };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === "--help" || option === "-h") { options.help = true; continue; }
        if (!["--port", "--layout", "--app-directory"].includes(option) || seen.has(option)) {
            throw new Error("Use --port, --layout, or --app-directory <public URL>");
        }
        seen.add(option);
        const value = args[++index];
        if (option === "--port") {
            if (value === undefined) throw new Error("--port requires a value");
            options.port = parseUnofficialLocalPort(value);
        } else if (option === "--app-directory") {
            if (!value) throw new Error("--app-directory requires a URL");
            options.appDirectoryUrl = parseAppDirectoryUrl(value);
        } else {
            if (value !== "v1" && value !== "v2") throw new Error("--layout must be v1 or v2");
            options.layout = value;
        }
    }
    return options;
}

/** Pure launch description for tests/review; never invokes npm/npx, installs packages, or uses a shell. */
export function unofficialLocalLaunchPlan(repositoryRoot, canisters, options, inherited = {}) {
    const env = createUnofficialLocalEnvironment(canisters, { ...options, inherited });
    const vite = path.resolve(repositoryRoot, "frontend/node_modules/vite/bin/vite.js");
    return Object.freeze({
        command: process.execPath,
        args: Object.freeze([vite, "--host", "127.0.0.1", "--port", env.OC_DEV_PORT, "--strictPort"]),
        options: Object.freeze({ cwd: path.resolve(repositoryRoot, "frontend/app"), env, shell: false, windowsHide: true, stdio: "inherit" }),
        url: env.OC_BASE_ORIGIN,
    });
}

export function main(args = process.argv.slice(2)) {
    const options = parseUnofficialLocalArgs(args);
    if (options.help) {
        console.log("Usage: node scripts/start-unofficial-local.mjs [--port 5190] [--layout v1|v2] [--app-directory <public URL>]");
        console.log("Serves only loopback; uses official OpenChat services and your existing linked account.");
        return;
    }
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canisters = JSON.parse(readFileSync(path.join(repositoryRoot, "canister_ids.json"), "utf8"));
    const plan = unofficialLocalLaunchPlan(repositoryRoot, canisters, options, process.env);
    if (!existsSync(plan.args[0])) throw new Error("Local Vite is not installed. Install the reviewed frontend dependencies before launching.");
    console.log(`Unofficial local prototype (${options.layout}): ${plan.url}`);
    console.log("No official-origin impersonation, OTA updates, telemetry keys, or custom app backend flags are enabled.");
    const child = spawn(plan.command, [...plan.args], plan.options);
    child.once("error", () => { console.error("The local Vite process could not start."); process.exitCode = 1; });
    child.once("exit", (code) => { process.exitCode = code ?? 1; });
    return child;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Local startup failed"); process.exitCode = 1; }
}
