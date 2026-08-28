import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
    extractPublicKey,
    publicKeyBuildPlugin,
    resolveDfxInvocation,
    writePublicKeyFile,
} from "../publicKeyBuild.mjs";

const queryResult =
    'variant { Success = "-----BEGIN PUBLIC KEY-----\\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\\n-----END PUBLIC KEY-----\\n" }';
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "openchat-public-key-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
});

describe("public key build plugin", () => {
    test("uses native dfx on Unix and a WSL login shell without output redirection on Windows", () => {
        const unix = resolveDfxInvocation("local", "linux");
        expect(unix.command).toBe("dfx");
        expect(unix.args).toContain("local");

        const windows = resolveDfxInvocation("local", "win32", "OpenChatDistro", "aaaaa-aa");
        expect(windows.command).toBe("wsl.exe");
        expect(windows.args.slice(0, 6)).toEqual([
            "--distribution",
            "OpenChatDistro",
            "--",
            "bash",
            "--login",
            "-c",
        ]);
        expect(windows.args[6]).toContain("exec dfx '--identity' 'anonymous'");
        expect(windows.args[6]).toContain("'(record { })'");
        expect(windows.args[6]).toContain("'aaaaa-aa' 'public_key'");
        expect(windows.args[6]).not.toContain(">");
        expect(windows.args).not.toContain("../../scripts/get-public-key.sh");
    });

    test("extracts a standard LF-delimited PEM without Candid escape sequences", () => {
        const publicKey = extractPublicKey(queryResult);
        expect(publicKey).toBe(
            "-----BEGIN PUBLIC KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PUBLIC KEY-----\n",
        );
        expect(publicKey).not.toContain("\\n");
        expect(() => extractPublicKey("variant { NotInitialised }")).toThrow(
            "did not return a PEM public key",
        );
        expect(() =>
            extractPublicKey(
                'variant { Success = "-----BEGIN PUBLIC KEY-----\\n!\\n-----END PUBLIC KEY-----" }',
            ),
        ).toThrow("invalid PEM public key");
    });

    test("atomically replaces the destination only after a valid query", async () => {
        const directory = await temporaryDirectory();
        const outputPath = path.join(directory, "public-key");
        await writeFile(outputPath, "previous-key", "utf8");

        await expect(
            writePublicKeyFile({
                outputPath,
                platform: "win32",
                runCommand: async () => {
                    throw new Error("dfx failed");
                },
            }),
        ).rejects.toThrow("dfx failed");
        expect(await readFile(outputPath, "utf8")).toBe("previous-key");

        const calls: Array<{ command: string; args: string[] }> = [];
        await writePublicKeyFile({
            network: "local",
            outputPath,
            platform: "win32",
            runCommand: async (command, args) => {
                calls.push({ command, args });
                return queryResult;
            },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.command).toBe("wsl.exe");
        expect(await readFile(outputPath, "utf8")).toBe(extractPublicKey(queryResult));
        expect(await readdir(directory)).toEqual(["public-key"]);
    });

    test("propagates generation failures from buildStart", async () => {
        const plugin = publicKeyBuildPlugin({
            runCommand: async () => {
                throw new Error("query unavailable");
            },
        });
        await expect(plugin.buildStart()).rejects.toThrow("query unavailable");
    });
});
