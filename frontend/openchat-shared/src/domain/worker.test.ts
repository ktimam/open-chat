import { describe, expect, it } from "vitest";
import type { AiAppRegistration } from "./aiAction";
import type { WorkerRequest, WorkerResponseInner, WorkerResult } from "./worker";

type MyAiAppsRequest = Extract<WorkerRequest, { kind: "myAiApps" }>;

describe("worker response contracts", () => {
    it("accepts the paginated my-ai-apps result in the worker response envelope", () => {
        const apps: AiAppRegistration[] = [];
        const result: WorkerResult<MyAiAppsRequest> = { apps, total: 0 };
        const response: WorkerResponseInner = result;

        expect(response).toEqual({ apps: [], total: 0 });
    });
});
