// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@icp-sdk/core/agent";
const mocks = vi.hoisted(() => ({
    create: vi.fn(),
    createActor: vi.fn(),
    fetchRootKey: vi.fn(),
    remote: vi.fn(),
}));
vi.mock("@icp-sdk/core/agent", () => ({
    HttpAgent: { create: mocks.create },
    Actor: { createActor: mocks.createActor },
}));
import { createSetupCodeActor } from "./localAppSetupCodeActor";
const endpoint = {
    version: 1,
    kind: "ic-canister",
    host: "https://icp-api.io",
    canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
} as const;
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});
function setup() {
    mocks.create.mockResolvedValue({ fetchRootKey: mocks.fetchRootKey });
    mocks.createActor.mockReturnValue({
        create_app_setup_code: mocks.remote,
        poll_app_setup_code: mocks.remote,
        cancel_app_setup_code: mocks.remote,
    });
    const identity = {} as Identity;
    const client = createSetupCodeActor(endpoint, identity);
    return { identity, client };
}
describe("code pairing IC transport", () => {
    it("uses an ephemeral caller, verified IC agent, and fixed update calls", async () => {
        const { identity, client } = setup();
        mocks.remote.mockResolvedValue({ Ok: { Waiting: { expires_at_ms: 123n } } });
        expect(await client.poll("request", new AbortController().signal)).toEqual({
            Waiting: { expires_at_ms: 123n },
        });
        expect(mocks.create).toHaveBeenCalledWith(
            expect.objectContaining({
                identity,
                host: endpoint.host,
                retryTimes: 0,
                shouldFetchRootKey: false,
                shouldSyncTime: false,
                logToConsole: false,
            }),
        );
        expect(mocks.fetchRootKey).not.toHaveBeenCalled();
        expect(mocks.remote).toHaveBeenCalledWith("request");
        const service = mocks.createActor.mock.calls[0][0]();
        for (const [, method] of service._fields) expect(method.annotations).toEqual([]);
    });
    it("restricts network scope and omits ambient credentials/referrers", async () => {
        const { client } = setup();
        mocks.remote.mockResolvedValue({ Ok: true });
        const network = vi.fn(async () => new Response(""));
        vi.stubGlobal("fetch", network);
        await client.cancel("request", new AbortController().signal);
        const restricted = mocks.create.mock.calls[0][0].fetch as typeof fetch;
        await restricted(`${endpoint.host}/api/v3/canister/${endpoint.canisterId}/call`, {
            method: "POST",
        });
        expect(network).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
                cache: "no-store",
            }),
        );
        for (const url of [
            "https://other.example/api/v2/status",
            `${endpoint.host}/api/v2/status?code=secret`,
            `${endpoint.host}/other`,
            `${endpoint.host}/api/v2/canister/other/call`,
        ])
            expect(() => restricted(url)).toThrow();
        expect(() =>
            restricted(`${endpoint.host}/api/v2/status`, { headers: { Authorization: "secret" } }),
        ).toThrow();
        expect(() =>
            restricted(`${endpoint.host}/api/v2/status`, { headers: { Cookie: "secret" } }),
        ).toThrow();
    });
    it("does not expose untrusted backend error text or accept malformed result variants", async () => {
        const { client } = setup();
        mocks.remote.mockResolvedValue({ Err: "private remote error" });
        await expect(client.poll("request", new AbortController().signal)).rejects.not.toThrow(
            "private remote error",
        );
        mocks.remote.mockResolvedValue({ Ok: true, Err: "unexpected" });
        await expect(client.cancel("request", new AbortController().signal)).rejects.toThrow();
    });
});
