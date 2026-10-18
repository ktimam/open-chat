// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/communities"}
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "@client/utils/stores";
import { connectCodeAppSetup, localAppCodeConnection } from "./localAppSetupCode";
import { decryptSetupCode, encryptSetupCode } from "./appSetupCodeCrypto";
import type { SetupCodeActor, SetupCodeCreate } from "./localAppSetupCodeActor";
import type { LocalAppDirectoryDescriptor } from "./localAppDirectory";
import type { LocalAppCatalogEntry } from "./localAppCatalog";
import type { LocalAppSetupContext } from "./localAppScopedSetup";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
const descriptor = {
    id: "sample",
    name: "Sample",
    description: "Synthetic",
    revision: "v1",
    setupUrl: "https://app.example/connect",
} as LocalAppDirectoryDescriptor;
const app = {
    id: "sample",
    revision: "v1",
    setupCode: {
        version: 1,
        kind: "ic-canister",
        host: "https://icp-api.io",
        canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    },
} as LocalAppCatalogEntry;
const context: LocalAppSetupContext = {
    version: 2,
    scope: "chat",
    accountId: "A".repeat(43),
    handle: "B".repeat(42) + "A",
};
const catalogJson = JSON.stringify({ version: 1, apps: [{ id: "sample" }] });
const scopedJson = JSON.stringify({
    version: 2,
    scope: "chat",
    appId: "sample",
    accountId: context.accountId,
    catalogJson,
    routes: [{ handle: context.handle, catalogJson }],
});
let request: SetupCodeCreate;
let actor: SetupCodeActor;
let controller: AbortController;
let currentTime: number;

async function start(publicApp = app) {
    const outcome = connectCodeAppSetup(
        descriptor,
        controller.signal,
        context,
        Promise.resolve(publicApp),
        {
            actor: async () => actor,
            now: () => currentTime,
        },
    ).then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    await vi.waitFor(() => expect(get(localAppCodeConnection)).toBeDefined());
    const transport = get(localAppCodeConnection)!.transport;
    const code = await transport.createCode();
    return { transport, code: code!.code, outcome };
}
async function completed(code: string, changes: Record<string, unknown> = {}) {
    const encrypted_result = await encryptSetupCode(
        code,
        "result",
        JSON.stringify({
            version: 1,
            appId: descriptor.id,
            setupUrl: descriptor.setupUrl,
            requestId: request.request_id,
            catalogJson: scopedJson,
            ...changes,
        }),
    );
    vi.mocked(actor.poll).mockResolvedValue({
        Completed: { expires_at_ms: request.expires_at_ms, encrypted_result },
    });
}
beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    currentTime = Date.now();
    controller = new AbortController();
    actor = {
        create: vi.fn(async (value) => {
            request = value;
            return { expires_at_ms: value.expires_at_ms };
        }),
        poll: vi.fn(async () => ({ Waiting: { expires_at_ms: request.expires_at_ms } })),
        cancel: vi.fn(async () => true),
    };
    vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(async () => {
    await get(localAppCodeConnection)?.transport.cancel();
    controller.abort();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("publisher-owned connection code transport", () => {
    it.each([-60000, -1, 0, 1, 2000, 60000])(
        "creates on the first attempt with independent server time and requester skew %i ms",
        async (requesterSkewMs) => {
            const serverNow = 1000000;
            currentTime = serverNow + requesterSkewMs;
            vi.mocked(actor.create).mockImplementation(async (value) => {
                request = value;
                // Match the unchanged canister bound, not an echo of the client clock.
                if (
                    value.expires_at_ms <= BigInt(serverNow) ||
                    value.expires_at_ms - BigInt(serverNow) > 600000n
                )
                    throw new Error("synthetic strict server TTL rejection");
                return { expires_at_ms: value.expires_at_ms };
            });
            const { transport, code, outcome } = await start();
            expect(actor.create).toHaveBeenCalledTimes(1);
            expect(request.expires_at_ms).toBe(BigInt(currentTime + 540000));
            expect(request.expires_at_ms - BigInt(serverNow)).toBeLessThanOrEqual(600000n);
            const decoded = JSON.parse(
                await decryptSetupCode(code, "context", request.encrypted_context),
            );
            expect(decoded.expiresAtMs).toBe(Number(request.expires_at_ms));
            await transport.cancel();
            await outcome;
        },
    );
    it("keeps the exact uncertain request across clock-offset retries without automatic retry or extension", async () => {
        let serverNow = 1000000;
        currentTime = serverNow + 40000;
        let accepted: SetupCodeCreate | undefined;
        vi.mocked(actor.create).mockImplementation(async (value) => {
            request = value;
            if (value.expires_at_ms - BigInt(serverNow) > 600000n)
                throw new Error("synthetic strict server TTL rejection");
            if (!accepted) {
                accepted = value;
                throw new Error("synthetic accepted response lost");
            }
            return { expires_at_ms: accepted.expires_at_ms };
        });
        const outcome = connectCodeAppSetup(
            descriptor,
            controller.signal,
            context,
            Promise.resolve(app),
            { actor: async () => actor, now: () => currentTime },
        ).catch(() => undefined);
        await vi.waitFor(() => expect(get(localAppCodeConnection)).toBeDefined());
        const transport = get(localAppCodeConnection)!.transport;
        await expect(transport.createCode()).rejects.toThrow("synthetic accepted response lost");
        const first = request;
        await Promise.resolve();
        expect(actor.create).toHaveBeenCalledTimes(1);
        expect(await transport.checkConnection()).toBe(false);
        expect(actor.poll).not.toHaveBeenCalled();
        serverNow += 2500;
        currentTime += 2500;
        await transport.createCode();
        expect(actor.create).toHaveBeenCalledTimes(2);
        expect(vi.mocked(actor.create).mock.calls[1][0]).toBe(first);
        expect(request.encrypted_context).toBe(first.encrypted_context);
        expect(request.expires_at_ms).toBe(first.expires_at_ms);
        currentTime = Number(first.expires_at_ms);
        await expect(transport.createCode()).rejects.toThrow();
        expect(actor.create).toHaveBeenCalledTimes(2);
        await transport.cancel();
        await outcome;
    });
    it("never returns a code when an asynchronous create reply arrives at the exact expiry", async () => {
        let deliver!: (value: { expires_at_ms: bigint }) => void;
        vi.mocked(actor.create).mockImplementation((value) => {
            request = value;
            return new Promise((resolve) => {
                deliver = resolve;
            });
        });
        const outcome = connectCodeAppSetup(
            descriptor,
            controller.signal,
            context,
            Promise.resolve(app),
            { actor: async () => actor, now: () => currentTime },
        ).catch(() => undefined);
        await vi.waitFor(() => expect(get(localAppCodeConnection)).toBeDefined());
        const transport = get(localAppCodeConnection)!.transport;
        // Report only a boolean if this fails: never print the generated bearer code.
        const returnedCode = transport.createCode().then(
            () => true,
            () => false,
        );
        await vi.waitFor(() => expect(actor.create).toHaveBeenCalledTimes(1));
        currentTime = Number(request.expires_at_ms);
        deliver({ expires_at_ms: request.expires_at_ms });
        expect(await returnedCode).toBe(false);
        expect(await transport.checkConnection()).toBe(false);
        expect(actor.poll).not.toHaveBeenCalled();
        await expect(transport.openApp()).rejects.toThrow();
        expect(window.open).not.toHaveBeenCalled();
        await transport.cancel();
        await outcome;
    });
    it("retries an uncertain create only explicitly, with identical request and ciphertext", async () => {
        const outcome = connectCodeAppSetup(
            descriptor,
            controller.signal,
            context,
            Promise.resolve(app),
            {
                actor: async () => actor,
                now: () => currentTime,
            },
        ).catch(() => undefined);
        await vi.waitFor(() => expect(get(localAppCodeConnection)).toBeDefined());
        const transport = get(localAppCodeConnection)!.transport;
        vi.mocked(actor.create).mockImplementationOnce(async (value) => {
            request = value;
            throw new Error("network outcome unknown");
        });
        await expect(transport.createCode()).rejects.toThrow();
        const first = request;
        expect(actor.create).toHaveBeenCalledTimes(1);
        expect(await transport.checkConnection()).toBe(false);
        await expect(transport.openApp()).rejects.toThrow();
        expect(actor.poll).not.toHaveBeenCalled();
        currentTime += 1000;
        const code = await transport.createCode();
        expect(code?.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(actor.create).toHaveBeenCalledTimes(2);
        expect(vi.mocked(actor.create).mock.calls[1][0]).toBe(first);
        expect(request.encrypted_context).toBe(first.encrypted_context);
        expect(request.expires_at_ms).toBe(first.expires_at_ms);
        await transport.cancel();
        await outcome;
    });
    it("shows a stable code and opens only the actual public app URL, never a localhost wrapper", async () => {
        const { transport, code, outcome } = await start();
        expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(window.open).not.toHaveBeenCalled();
        expect(request.expires_at_ms).toBe(BigInt(currentTime + 540000));
        expect(new TextDecoder().decode(request.encrypted_context)).not.toContain(
            context.accountId,
        );
        const decoded = JSON.parse(
            await decryptSetupCode(code, "context", request.encrypted_context),
        );
        expect(decoded).toEqual({
            version: 1,
            appId: "sample",
            setupUrl: descriptor.setupUrl,
            clientOrigin: "https://client.example",
            expiresAtMs: currentTime + 540000,
            setupContext: context,
        });
        expect(await transport.createCode()).toEqual({ code, expiresAt: request.expires_at_ms });
        expect(actor.create).toHaveBeenCalledTimes(1);
        await transport.openApp();
        expect(window.open).toHaveBeenCalledExactlyOnceWith(
            descriptor.setupUrl,
            "_blank",
            "noopener,noreferrer",
        );
        await transport.cancel();
        expect(await outcome).toHaveProperty("error");
        expect(get(localAppCodeConnection)).toBeUndefined();
    });
    it("checks explicitly and adopts only the exact encrypted app/scope result", async () => {
        const { transport, code, outcome } = await start();
        expect(actor.poll).not.toHaveBeenCalled();
        expect(await transport.checkConnection()).toBe(false);
        await completed(code);
        expect(await transport.checkConnection()).toBe(true);
        expect(await outcome).toEqual({ value: scopedJson });
        expect(get(localAppCodeConnection)).toBeUndefined();
        expect(actor.cancel).toHaveBeenCalledWith(request.request_id, expect.any(AbortSignal));
    });
    it.each([
        { appId: "other" },
        { setupUrl: "https://other.example/connect" },
        { requestId: "f".repeat(64) },
        { extra: "forbidden" },
        {
            catalogJson: JSON.stringify({
                version: 2,
                scope: "chat",
                appId: "sample",
                accountId: "C".repeat(42) + "A",
                catalogJson,
                routes: [{ handle: context.handle, catalogJson }],
            }),
        },
    ])("rejects a mismatched result binding %j", async (changes) => {
        const { transport, code, outcome } = await start();
        await completed(code, changes);
        await expect(transport.checkConnection()).rejects.toThrow();
        expect(get(localAppCodeConnection)).toBeDefined();
        await transport.cancel();
        expect(await outcome).toHaveProperty("error");
    });
    it("does not adopt a reply after cancellation", async () => {
        const { transport, code, outcome } = await start();
        await completed(code);
        const response = await actor.poll(request.request_id, controller.signal);
        let deliver!: (value: typeof response) => void;
        vi.mocked(actor.poll).mockImplementation(
            () =>
                new Promise((resolve) => {
                    deliver = resolve;
                }),
        );
        const checking = transport.checkConnection();
        controller.abort();
        deliver(response);
        await expect(checking).rejects.toThrow();
        expect(await outcome).toHaveProperty("error");
        expect(get(localAppCodeConnection)).toBeUndefined();
    });
    it("never polls or opens an expired code", async () => {
        const { transport, outcome } = await start();
        currentTime += 600001;
        expect(await transport.checkConnection()).toBe(false);
        expect(actor.poll).not.toHaveBeenCalled();
        await expect(transport.openApp()).rejects.toThrow();
        expect(window.open).not.toHaveBeenCalled();
        await transport.cancel();
        await outcome;
    });
    it("fails closed without a published code endpoint; no legacy browser fallback", async () => {
        await expect(
            connectCodeAppSetup(
                descriptor,
                controller.signal,
                context,
                Promise.resolve({ ...app, setupCode: undefined }),
            ),
        ).rejects.toThrow("publisher must update");
        expect(get(localAppCodeConnection)).toBeUndefined();
        expect(window.open).not.toHaveBeenCalled();
    });
});
