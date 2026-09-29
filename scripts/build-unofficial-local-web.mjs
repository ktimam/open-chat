#!/usr/bin/env node
/** Optimized local-only build. No package installation, deploy, or output deletion. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseUnofficialLocalPort, parseAppDirectoryUrl } from "../frontend/unofficialLocalProfile.mjs";
import { createUnofficialLocalWebBuildEnvironment } from "../frontend/unofficialLocalWebBuild.mjs";

export function parseBuildArgs(args) {
    const options = { port: 5190, layout: "v2", output: undefined, help: false };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === "--help" || option === "-h") { options.help = true; continue; }
        if (!["--output", "--port", "--layout", "--app-directory"].includes(option) || seen.has(option)) {
            throw new Error("Use --output <empty absolute directory>, --port, --layout, and --app-directory");
        }
        seen.add(option);
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
        if (option === "--port") options.port = parseUnofficialLocalPort(value);
        if (option === "--app-directory") options.appDirectoryUrl = parseAppDirectoryUrl(value);
        if (option === "--layout") {
            if (value !== "v1" && value !== "v2") throw new Error("--layout must be v1 or v2");
            options.layout = value;
        }
        if (option === "--output") options.output = value;
    }
    if (!options.help && !options.output) throw new Error("--output is required; create an empty project-specific temporary directory first");
    return options;
}

export function localWebBuildPlan(repositoryRoot, canisters, options, inherited = {}) {
    const env = createUnofficialLocalWebBuildEnvironment(canisters, { ...options, repositoryRoot, inherited });
    return Object.freeze({
        command: process.execPath,
        args: [path.resolve(repositoryRoot, "frontend/node_modules/rollup/dist/bin/rollup"), "--config", "rollup.config.mjs"],
        options: { cwd: path.resolve(repositoryRoot, "frontend/app"), env, shell: false, windowsHide: true, stdio: "inherit" },
    });
}

export function main(args = process.argv.slice(2)) {
    const options = parseBuildArgs(args);
    if (options.help) {
        console.log("Usage: node scripts/build-unofficial-local-web.mjs --output <existing empty absolute directory> [--port 5190] [--layout v1|v2]");
        return;
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canisters = JSON.parse(readFileSync(path.join(root, "canister_ids.json"), "utf8"));
    const plan = localWebBuildPlan(root, canisters, options, process.env);
    if (!existsSync(plan.args[0])) throw new Error("Reviewed frontend dependencies must already be installed");
    console.log(`Building optimized local-only web client for ${plan.options.env.OC_BASE_ORIGIN}. No deployment or model downloads.`);
    const child = spawn(plan.command, plan.args, plan.options);
    child.once("error", () => { console.error("Local web build could not start"); process.exitCode = 1; });
    child.once("exit", (code) => { process.exitCode = code ?? 1; });
    return child;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Local web build failed"); process.exitCode = 1; }
}
