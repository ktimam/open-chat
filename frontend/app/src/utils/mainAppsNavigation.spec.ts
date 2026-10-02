import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    invalidateReview: vi.fn(),
    close: vi.fn(),
    clear: vi.fn(),
    discard: vi.fn(),
    forgetSetup: vi.fn(),
    navigate: vi.fn(),
}));

vi.mock("./privateAppWorkspace", () => ({
    privateAppWorkspace: {
        invalidateReview: calls.invalidateReview,
        close: calls.close,
        clear: calls.clear,
        discard: calls.discard,
        forgetSetup: calls.forgetSetup,
    },
}));
vi.mock("./navigation", () => ({ navigate: calls.navigate }));

import { isMainAppsRoute, MAIN_APPS_ROUTE, navigateToMainApps } from "./mainAppsNavigation";

beforeEach(() => vi.clearAllMocks());

describe("main apps navigation", () => {
    it("recognises only the explicit apps view query", () => {
        expect(isMainAppsRoute("?view=apps")).toBe(true);
        expect(isMainAppsRoute("?q=receipt&view=apps")).toBe(true);
        expect(isMainAppsRoute("")).toBe(false);
        expect(isMainAppsRoute("?view=communities")).toBe(false);
        expect(isMainAppsRoute("?view=apps-extra")).toBe(false);
    });

    it("revokes review and closes the card host before routing without deleting cards", () => {
        navigateToMainApps();

        expect(calls.invalidateReview).toHaveBeenCalledOnce();
        expect(calls.close).toHaveBeenCalledOnce();
        expect(calls.invalidateReview.mock.invocationCallOrder[0]).toBeLessThan(
            calls.close.mock.invocationCallOrder[0],
        );
        expect(calls.close.mock.invocationCallOrder[0]).toBeLessThan(
            calls.navigate.mock.invocationCallOrder[0],
        );
        expect(calls.navigate).toHaveBeenCalledExactlyOnceWith(MAIN_APPS_ROUTE);
        expect(calls.clear).not.toHaveBeenCalled();
        expect(calls.discard).not.toHaveBeenCalled();
        expect(calls.forgetSetup).not.toHaveBeenCalled();
    });
});
