import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PUBLIC_KEY_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_END = "-----END PUBLIC KEY-----";
const publicKeyPath = new URL("./public/public-key", import.meta.url);

function quoteForPosixShell(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveDfxInvocation(
    network,
    platform = process.platform,
    wslDistro,
    canister = "user_index",
) {
    const dfxArgs = [
        "--identity",
        "anonymous",
        "canister",
        "--network",
        network || "local",
        "call",
        "-qq",
        canister,
        "public_key",
        "(record { })",
        "--query",
    ];

    if (platform !== "win32") {
        return { command: "dfx", args: dfxArgs };
    }

    return {
        command: "wsl.exe",
        args: [
            ...(wslDistro ? ["--distribution", wslDistro] : []),
            "--",
            "bash",
            "--login",
            "-c",
            `exec dfx ${dfxArgs.map(quoteForPosixShell).join(" ")}`,
        ],
    };
}

export function extractPublicKey(result) {
    const start = result.indexOf(PUBLIC_KEY_BEGIN);
    const end = result.indexOf(PUBLIC_KEY_END, start + PUBLIC_KEY_BEGIN.length);
    if (start < 0 || end < 0) {
        throw new Error("The user_index public_key query did not return a PEM public key");
    }

    const pem = result
        .slice(start, end + PUBLIC_KEY_END.length)
        .replaceAll("\\r\\n", "\n")
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\n")
        .replaceAll("\r\n", "\n");
    const body = pem.slice(PUBLIC_KEY_BEGIN.length, -PUBLIC_KEY_END.length).replaceAll(/\s/g, "");
    if (body.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
        throw new Error("The user_index public_key query returned an invalid PEM public key");
    }

    return `${pem}\n`;
}

async function runDfx(command, args) {
    const { stdout } = await execFileAsync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    return stdout;
}

export async function writePublicKeyFile({
    network = "local",
    canister = process.env.OC_USER_INDEX_CANISTER ?? "user_index",
    outputPath = publicKeyPath,
    platform = process.platform,
    wslDistro = process.env.OC_WSL_DISTRO,
    runCommand = runDfx,
} = {}) {
    const { command, args } = resolveDfxInvocation(network, platform, wslDistro, canister);
    const result = await runCommand(command, args);
    const publicKey = extractPublicKey(result);
    const destination = outputPath instanceof URL ? outputPath : path.resolve(outputPath);
    const directory =
        outputPath instanceof URL ? new URL("./", destination) : path.dirname(destination);
    const filename =
        outputPath instanceof URL
            ? path.basename(destination.pathname)
            : path.basename(destination);
    const temporaryPath =
        outputPath instanceof URL
            ? new URL(`.${filename}.${process.pid}.${randomUUID()}.tmp`, directory)
            : path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);

    await mkdir(directory, { recursive: true });
    try {
        await writeFile(temporaryPath, publicKey, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, destination);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function publicKeyBuildPlugin(options = {}) {
    return {
        name: "openchat-public-key",
        async buildStart() {
            await writePublicKeyFile(options);
        },
    };
}
