// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSingleSubmissionFetch } from "./singleSubmissionFetch";

const call = "https://icp-api.io/api/v2/canister/aaaaa-aa/call";
describe("one-submission account-link transport", () => {
    it("rejects a second submission even if SDK changes API versions after a clock correction", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(
            async () => new Response(null, { status: 202 }),
        );
        const send = createSingleSubmissionFetch(fetch);
        await send(call, { method: "POST" });
        await expect(send(call.replace("/v2/", "/v4/"), { method: "POST" })).rejects.toThrow(
            "resubmission",
        );
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("does not resend after a network failure and hides raw request/provider errors", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
            throw new Error("secret-request-payload");
        });
        const send = createSingleSubmissionFetch(fetch);
        await expect(send(call)).rejects.toThrow("outcome may be unknown");
        await expect(send(call)).rejects.toThrow("resubmission");
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("permits certified read-state polling and delegation queries after one update", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(
            async () => new Response(null, { status: 202 }),
        );
        const send = createSingleSubmissionFetch(fetch);
        await send(call);
        await send(call.replace("/call", "/read_state"));
        await send(call.replace("/call", "/query"));
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error" });
    });

    it("does not submit after the flow deadline", async () => {
        const fetch = vi.fn();
        const deadline = new AbortController();
        deadline.abort();
        await expect(createSingleSubmissionFetch(fetch, deadline.signal)(call)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});
