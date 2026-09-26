import { describe, expect, it } from "vitest";
import type { WorkerRequest } from "../domain/worker";
import {
    assertUnofficialApiRequestAllowed,
    ClientOnlyAppRequestError,
    CUSTOM_APP_REQUEST_KINDS,
} from "./unofficialApiPolicy";

describe("unofficial client backend boundary", () => {
    it.each(CUSTOM_APP_REQUEST_KINDS)("rejects %s before transport", (kind) => {
        const request = { kind, payload: "private-marker" } as unknown as WorkerRequest;
        expect(() => assertUnofficialApiRequestAllowed(request, true)).toThrow(ClientOnlyAppRequestError);
        try {
            assertUnofficialApiRequestAllowed(request, true);
        } catch (error) {
            expect(String(error)).not.toContain("private-marker");
            expect(error).toHaveProperty("code", "client_only_app_request");
        }
    });

    it.each([false, undefined])("preserves the official/legacy policy when flag is %s", (flag) => {
        for (const kind of CUSTOM_APP_REQUEST_KINDS) {
            expect(() => assertUnofficialApiRequestAllowed({ kind } as WorkerRequest, flag)).not.toThrow();
        }
    });

    it.each(["sendMessage", "editMessage"] as const)("blocks custom card content through %s", (kind) => {
        const message = { content: { kind: "action_card_content", payload: "private-marker" } };
        const request = (kind === "sendMessage"
            ? { kind, event: { event: message } }
            : { kind, msg: message }) as unknown as WorkerRequest;
        expect(() => assertUnofficialApiRequestAllowed(request, true)).toThrow(ClientOnlyAppRequestError);
        expect(() => assertUnofficialApiRequestAllowed(request, false)).not.toThrow();
    });

    it.each(["sendMessage", "editMessage"] as const)("preserves ordinary chat through %s", (kind) => {
        const message = { content: { kind: "text_content", text: "ordinary message" } };
        const request = (kind === "sendMessage"
            ? { kind, event: { event: message } }
            : { kind, msg: message }) as unknown as WorkerRequest;
        expect(() => assertUnofficialApiRequestAllowed(request, true)).not.toThrow();
    });

    it.each(["getCurrentUser", "setAuthIdentity", "getUpdates", "logout", "finaliseAccountLinkingWithCode"])(
        "preserves official %s",
        (kind) => expect(() => assertUnofficialApiRequestAllowed({ kind } as WorkerRequest, true)).not.toThrow(),
    );
});
