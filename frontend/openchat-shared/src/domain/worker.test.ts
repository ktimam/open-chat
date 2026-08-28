import { describe, expect, it } from "vitest";
import type { AiAppCardProvenanceResult, AiAppRegistration } from "./aiAction";
import type { WorkerRequest, WorkerResponseInner, WorkerResult } from "./worker";

type MyAiAppsRequest = Extract<WorkerRequest, { kind: "myAiApps" }>;
type CreateAiAppCardProvenanceRequest = Extract<
    WorkerRequest,
    { kind: "createAiAppCardProvenance" }
>;

describe("worker response contracts", () => {
    it("accepts the paginated my-ai-apps result in the worker response envelope", () => {
        const apps: AiAppRegistration[] = [];
        const result: WorkerResult<MyAiAppsRequest> = { apps, total: 0 };
        const response: WorkerResponseInner = result;

        expect(response).toEqual({ apps: [], total: 0 });
    });

    it("carries a typed card-provenance failure instead of an ambiguous undefined", () => {
        const result: WorkerResult<CreateAiAppCardProvenanceRequest> = {
            kind: "transport_error",
        };
        const response: WorkerResponseInner = result;
        const domainResult: AiAppCardProvenanceResult = response;

        expect(domainResult).toEqual({ kind: "transport_error" });
    });
});
