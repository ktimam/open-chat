// @vitest-environment jsdom
import { flushSync, tick } from "svelte";
import { createClassComponent } from "svelte/legacy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BrowserAccountLinkFlow,
    type BrowserAccountLinkState,
} from "@client/utils/browserAccountLink";
import { BrowserSignInFailure } from "@client/utils/browserSignInDiagnostics";
import HomeRouteV1 from "../components/home/HomeRoute.svelte";
import HomeRouteV2 from "../components_mobile/home/HomeRoute.svelte";
import {
    anonUserStore,
    chatsInitialisedStore,
    identityStateStore,
    querystringStore,
    routeStore,
} from "@client";

const calls = vi.hoisted(() => ({
    signIn: vi.fn(),
    webSignIn: vi.fn(),
    navigate: vi.fn(),
    verify: vi.fn(),
    createPasskey: vi.fn(),
    finalize: vi.fn(),
}));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        OpenChat: class {},
        anonUserStore: writable(true),
        chatsInitialisedStore: writable(false),
        identityStateStore: writable({ kind: "anon" }),
        querystringStore: writable(new URLSearchParams()),
        routeStore: writable({ kind: "home_route", scope: { kind: "none" } }),
    };
});
vi.mock("@src/i18n/i18n", () => ({
    i18nKey: (key: string) => key,
    setLocale() {},
    interpolate: (key: string) => key,
    supportedLanguages: [{ code: "en", name: "English" }],
}));
vi.mock("svelte-i18n", async () => {
    const { writable } = await import("svelte/store");
    return { locale: writable("en"), _: writable((key: string) => key) };
});
vi.mock("@src/utils/version.svelte", () => ({
    VersionChecker: class {
        versionState = { kind: "up_to_date" };
        stop() {}
    },
}));
vi.mock("@utils/navigation", () => ({ navigate: calls.navigate }));
vi.mock("@src/utils/nativeAuthErrorKey", () => ({
    nativeAuthErrorKey: (value: string) => value,
}));
vi.mock("@src/utils/androidWebAuthnError", () => ({
    classifyAndroidWebAuthnSignInFailure: () => ({ kind: "cancelled" }),
}));
vi.mock("@shared", () => ({ ErrorCode: {} }));

// Real HomeRoute, OnboardModal and ExistingAccountSignIn components remain mounted. Only layout
// chrome, the post-login Home body and unused legacy-provider surfaces are inert fixtures.
async function layout() {
    return {
        default: (await import("./fixtures/NativeSignInLayoutFixture.svelte")).default,
    };
}
vi.mock("../components/Overlay.svelte", layout);
vi.mock("../components/ModalContent.svelte", layout);
vi.mock("../components/Select.svelte", layout);
vi.mock("../components/Translatable.svelte", layout);
vi.mock("../components/icons/FancyLoader.svelte", layout);
vi.mock("../components/onboard/ModeSelection.svelte", layout);
vi.mock("../components/onboard/SignIn.svelte", layout);
vi.mock("../components/onboard/SignUp.svelte", layout);
vi.mock("../components_mobile/onboard/SignUp.svelte", layout);
vi.mock("../components_mobile/ErrorMessage.svelte", layout);
vi.mock("../components_mobile/Progress.svelte", layout);
vi.mock("../components_mobile/Translatable.svelte", layout);
vi.mock("@shared_components/Markdown.svelte", layout);
vi.mock("@shared_components/Loading.svelte", layout);
vi.mock("../components/landingpages/LandingPage.svelte", layout);
vi.mock("../components/home/Home.svelte", layout);
vi.mock("../components_mobile/home/Home.svelte", layout);
vi.mock("svelte-material-icons/ChevronLeft.svelte", layout);
vi.mock("component-lib", async () => {
    const { default: Fixture } = await layout();
    return {
        Body: Fixture,
        BodySmall: Fixture,
        Button: Fixture,
        ColourVars: {},
        Column: Fixture,
        CommonButton: Fixture,
        Container: Fixture,
        H1: Fixture,
        Overview: Fixture,
        Sheet: Fixture,
        Subtitle: Fixture,
        Title: Fixture,
    };
});

const cleanup: (() => void)[] = [];
async function settle() {
    await tick();
    await tick();
    flushSync();
}
function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function button(label: string) {
    const result = [...document.querySelectorAll("button")].find((element) =>
        element.textContent?.includes(label),
    );
    expect(result, `Missing button ${label}`).toBeDefined();
    return result!;
}
function username() {
    return document.querySelector('input[autocomplete="username"]') as HTMLInputElement | null;
}
function render(component: typeof HomeRouteV1 | typeof HomeRouteV2, native = true) {
    const target = document.createElement("div");
    document.body.append(target);
    const client = {
        existingAccountOnly: () => true,
        isNativeApp: () => native,
        signInWithLocalBrowser: calls.signIn,
        signInWithWebAuthn: calls.webSignIn,
        updateIdentityState: identityStateStore.set,
        createBrowserAccountLinkFlow: vi.fn(
            (onChange: (state: BrowserAccountLinkState) => void) => {
                if (native) throw new Error("Native linking belongs in the browser");
                return new BrowserAccountLinkFlow(
                    {
                        verify: calls.verify,
                        createPasskey: calls.createPasskey,
                        finalize: calls.finalize,
                        forget() {},
                    },
                    onChange,
                );
            },
        ),
    };
    const context = new Map<string, unknown>([["client", client]]);
    const mounted =
        component === HomeRouteV1
            ? createClassComponent({
                  component: HomeRouteV1,
                  target,
                  context,
                  props: { showLandingPage: false },
              })
            : createClassComponent({ component: HomeRouteV2, target, context });
    let destroyed = false;
    const destroy = () => {
        if (!destroyed) {
            mounted.$destroy();
            target.remove();
            destroyed = true;
        }
    };
    cleanup.push(destroy);
    return { destroy, client };
}
async function begin() {
    const field = username();
    expect(field).not.toBeNull();
    field!.value = "synthetic-user";
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    button("Continue in browser").click();
    await settle();
    expect(calls.signIn).toHaveBeenCalledOnce();
    return calls.signIn.mock.calls[0][1].signal as AbortSignal;
}

beforeEach(() => {
    calls.signIn.mockReset();
    calls.webSignIn.mockReset();
    calls.verify.mockReset().mockResolvedValue("synthetic-user");
    calls.createPasskey.mockReset().mockResolvedValue({
        credentialId: Uint8Array.of(1, 2, 3),
        publicKey: Uint8Array.of(4, 5, 6),
        origin: "localhost",
        crossPlatform: false,
        aaguid: new Uint8Array(16),
    });
    calls.finalize.mockReset().mockResolvedValue(undefined);
    calls.navigate.mockReset();
    (anonUserStore as unknown as { set(value: boolean): void }).set(true);
    chatsInitialisedStore.set(false);
    identityStateStore.set({ kind: "anon" });
    routeStore.set({ kind: "home_route" } as never);
    (querystringStore as unknown as { set(value: URLSearchParams): void }).set(
        new URLSearchParams(),
    );
});
afterEach(() => cleanup.splice(0).forEach((destroy) => destroy()));

for (const [label, component] of [
    ["v1", HomeRouteV1],
    ["v2", HomeRouteV2],
] as const) {
    describe(`${label} actual native sign-in parent lifecycle`, () => {
        it("reaches native existing-account UI without exposing legacy registration or native passkey paths", async () => {
            const view = render(component);
            await settle();
            expect(username()).not.toBeNull();
            expect(button("Continue in browser")).toBeDefined();
            expect(document.body.textContent).toContain("separate local-test APK");
            expect(document.body.textContent).not.toContain("Create account");
            expect(calls.signIn).not.toHaveBeenCalled();
            expect(view.client.createBrowserAccountLinkFlow).not.toHaveBeenCalled();
        });
        it("retains the same component and uncancelled signal through logging_in; destroys it only after success", async () => {
            const completion = deferred();
            calls.signIn.mockReturnValue(completion.promise);
            render(component);
            await settle();
            const field = username();
            const signal = await begin();
            identityStateStore.set({ kind: "logging_in" });
            await settle();
            expect(username()).toBe(field);
            expect(signal.aborted).toBe(false);
            expect(button("Cancel this sign-in")).toBeDefined();
            // Simulate the final accepted onCreatedUser transition, after all asynchronous adoption.
            (anonUserStore as unknown as { set(value: boolean): void }).set(false);
            identityStateStore.set({ kind: "logged_in" });
            completion.resolve();
            await settle();
            expect(username()).toBeNull();
            expect(signal.aborted).toBe(true); // Teardown after commit is harmless.
        });
        it("returns a failed worker adoption to the same form, preserves username and permits a fresh explicit retry", async () => {
            const completion = deferred();
            calls.signIn.mockReturnValue(completion.promise);
            render(component);
            await settle();
            const field = username();
            const signal = await begin();
            identityStateStore.set({ kind: "logging_in" });
            await settle();
            identityStateStore.set({ kind: "anon" });
            completion.reject(new Error("Synthetic worker adoption failed"));
            await settle();
            expect(username()).toBe(field);
            expect(username()!.value).toBe("synthetic-user");
            expect(signal.aborted).toBe(false);
            expect(document.body.textContent).toContain("Passkey sign-in could not finish");
            expect(button("Continue in browser").disabled).toBe(false);
            expect(calls.signIn).toHaveBeenCalledOnce();
        });
        it("explicit cancellation and user navigation abort the pending native attempt", async () => {
            const completion = deferred();
            calls.signIn.mockReturnValue(completion.promise);
            const view = render(component);
            await settle();
            const signal = await begin();
            identityStateStore.set({ kind: "logging_in" });
            await settle();
            button("Cancel this sign-in").click();
            expect(signal.aborted).toBe(true);
            completion.reject(new DOMException("Cancelled", "AbortError"));
            await settle();
            const second = deferred();
            calls.signIn.mockReturnValue(second.promise);
            button("Continue in browser").click();
            await settle();
            const nextSignal = calls.signIn.mock.calls[1][1].signal as AbortSignal;
            expect(nextSignal.aborted).toBe(false);
            view.destroy();
            await settle();
            expect(nextSignal.aborted).toBe(true);
            second.reject(new DOMException("Cancelled", "AbortError"));
            await settle();
        });
    });

    describe(`${label} actual browser sign-in parent lifecycle`, () => {
        async function linkExplicitly() {
            button("Link this client to my account").click();
            await settle();
            const user = username()!;
            user.value = "synthetic-user";
            user.dispatchEvent(new Event("input", { bubbles: true }));
            const code = document.querySelector('input[autocomplete="off"]') as HTMLInputElement;
            code.value = "ABC123";
            code.dispatchEvent(new Event("input", { bubbles: true }));
            await settle();
            button("Verify code").click();
            await settle();
            const confirmation = document.querySelector(
                'input[type="checkbox"]',
            ) as HTMLInputElement;
            confirmation.click();
            await settle();
            button("Create passkey and link this account").click();
            await settle();
            expect(calls.verify).toHaveBeenCalledOnce();
            expect(calls.createPasskey).toHaveBeenCalledOnce();
            expect(calls.finalize).toHaveBeenCalledOnce();
        }

        it.each(["account-delegation", "account-profile", "session-storage"] as const)(
            "keeps a %s failure visible and retains the expected linked credential for explicit retry",
            async (stage) => {
                const first = deferred();
                calls.webSignIn.mockReturnValue(first.promise);
                render(component, false);
                await settle();
                expect(calls.webSignIn).not.toHaveBeenCalled();
                await linkExplicitly();
                const form = document.querySelector(".existing-account-sign-in");
                button("Sign in with an existing passkey").click();
                await settle();
                const expected = {
                    username: "synthetic-user",
                    credentialId: Uint8Array.of(1, 2, 3),
                };
                expect(calls.webSignIn).toHaveBeenCalledExactlyOnceWith(expected);
                // The OpenChat class acceptance test independently verifies this actual post-assertion transition.
                identityStateStore.set({ kind: "logging_in" });
                await settle();
                expect(document.querySelector(".existing-account-sign-in")).toBe(form);
                identityStateStore.set({ kind: "anon" });
                first.reject(new BrowserSignInFailure(stage));
                await settle();
                expect(document.querySelector(".existing-account-sign-in")).toBe(form);
                expect(document.querySelector('[role="alert"]')?.textContent).toContain(
                    `[SIGNIN/${stage}]`,
                );
                expect(button("Sign in with an existing passkey").disabled).toBe(false);
                expect(calls.webSignIn).toHaveBeenCalledOnce();
                expect(calls.verify).toHaveBeenCalledOnce();
                expect(calls.createPasskey).toHaveBeenCalledOnce();
                expect(calls.finalize).toHaveBeenCalledOnce();
                const second = deferred();
                calls.webSignIn.mockReturnValue(second.promise);
                button("Sign in with an existing passkey").click();
                await settle();
                expect(calls.webSignIn).toHaveBeenCalledTimes(2);
                expect(calls.webSignIn).toHaveBeenLastCalledWith(expected);
                second.reject(new BrowserSignInFailure(stage));
                await settle();
            },
        );

        it("keeps discovery mounted through loading and destroys it only after successful account activation", async () => {
            const completion = deferred();
            calls.webSignIn.mockReturnValue(completion.promise);
            render(component, false);
            await settle();
            const form = document.querySelector(".existing-account-sign-in");
            button("Sign in with an existing passkey").click();
            await settle();
            expect(calls.webSignIn).toHaveBeenCalledExactlyOnceWith(undefined);
            identityStateStore.set({ kind: "logging_in" });
            await settle();
            expect(document.querySelector(".existing-account-sign-in")).toBe(form);
            (anonUserStore as unknown as { set(value: boolean): void }).set(false);
            identityStateStore.set({ kind: "logged_in" });
            completion.resolve();
            await settle();
            expect(document.querySelector(".existing-account-sign-in")).toBeNull();
            expect(calls.verify).not.toHaveBeenCalled();
            expect(calls.createPasskey).not.toHaveBeenCalled();
            expect(calls.finalize).not.toHaveBeenCalled();
        });
    });
}
