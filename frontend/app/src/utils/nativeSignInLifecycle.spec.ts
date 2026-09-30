// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeRouteV1 from "../components/home/HomeRoute.svelte";
import HomeRouteV2 from "../components_mobile/home/HomeRoute.svelte";
import {
    anonUserStore,
    chatsInitialisedStore,
    identityStateStore,
    querystringStore,
    routeStore,
    selectedAuthProviderStore,
} from "@client";

const calls = vi.hoisted(() => ({
    signIn: vi.fn(),
    linkAccount: vi.fn(),
    signUp: vi.fn(),
    browserSignIn: vi.fn(),
    webSignIn: vi.fn(),
    navigate: vi.fn(),
    stopVersionChecker: vi.fn(),
}));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        OpenChat: class {},
        AuthProvider: {
            PASSKEY: "Passkey",
            EMAIL: "Email",
            II: "II",
            ETH: "ETH",
            SOL: "SOL",
            NFID: "NFID",
        },
        anonUserStore: writable(true),
        userCreatedStore: writable(true),
        chatsInitialisedStore: writable(false),
        identityStateStore: writable({ kind: "anon" }),
        querystringStore: writable(new URLSearchParams()),
        selectedAuthProviderStore: writable(undefined),
        routeStore: writable({ kind: "home_route", scope: { kind: "none" } }),
    };
});
vi.mock("@shared", () => ({
    ErrorCode: { AlreadyRegistered: 1, LinkingCodeNotFound: 2, MaxLinkedIdentitiesLimitReached: 3 },
}));
vi.mock("@utils/navigation", () => ({ navigate: calls.navigate }));
vi.mock("@src/i18n/i18n", () => ({
    i18nKey: (key: string, params?: { provider?: string }) =>
        params?.provider ? `${key}:${params.provider}` : key,
    setLocale() {},
    interpolate: (_: unknown, key: string) => key,
    supportedLanguages: [{ code: "en", name: "English" }],
}));
vi.mock("svelte-i18n", async () => {
    const { writable } = await import("svelte/store");
    return { locale: writable("en"), _: writable((key: string) => key) };
});
vi.mock("@src/utils/version.svelte", () => ({
    VersionChecker: class {
        versionState = { kind: "up_to_date" };
        stop = calls.stopVersionChecker;
    },
}));
vi.mock("@src/utils/signin", async () => {
    const { writable } = await import("svelte/store");
    return {
        EmailSigninHandler: class {
            subscribe = writable(false).subscribe;
        },
    };
});

// Keep both HomeRoutes, OnboardModals, desktop ModeSelection, SignIn and
// ChooseSignInOption real. Only visual leaves, services and the post-login Home
// body are inert fixtures; the fixture does not provide an authentication UI.
async function layout() {
    return {
        default: (await import("./fixtures/NativeSignInLayoutFixture.svelte")).default,
    };
}
vi.mock("../components/Overlay.svelte", layout);
vi.mock("../components/ModalContent.svelte", layout);
vi.mock("../components/Button.svelte", layout);
vi.mock("../components/ButtonGroup.svelte", layout);
vi.mock("../components/Input.svelte", layout);
vi.mock("../components/Select.svelte", layout);
vi.mock("../components/Translatable.svelte", layout);
vi.mock("../components/ErrorMessage.svelte", layout);
vi.mock("../components/icons/FancyLoader.svelte", layout);
vi.mock("../components/home/EmailSigninFeedback.svelte", layout);
vi.mock("../components/home/profile/OnBoardOptionLogo.svelte", layout);
vi.mock("../components/home/profile/SignInOption.svelte", layout);
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
        ColourVars: { primary: "primary" },
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

let mounted: ReturnType<typeof mount>[] = [];
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}
function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function button(target: Element, label: string): HTMLButtonElement {
    const result = [...target.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
    );
    expect(result, `Missing original button ${label}`).toBeDefined();
    return result!;
}
function render(component: typeof HomeRouteV1 | typeof HomeRouteV2) {
    const target = document.createElement("div");
    document.body.append(target);
    const client = {
        isNativeApp: () => true,
        // A stale profile flag must not restore the removed replacement screen.
        existingAccountOnly: () => true,
        signInWithAndroidWebAuthn: calls.signIn,
        linkAccountsWithAndroidWebAuthn: calls.linkAccount,
        signUpWithAndroidWebAuthn: calls.signUp,
        signInWithLocalBrowser: calls.browserSignIn,
        signInWithWebAuthn: calls.webSignIn,
        updateIdentityState: identityStateStore.set,
        gaTrack: vi.fn(),
        logout: vi.fn(),
    };
    const context = new Map([["client", client]]);
    mounted.push(
        component === HomeRouteV1
            ? mount(HomeRouteV1, { target, context, props: { showLandingPage: false } })
            : mount(HomeRouteV2, { target, context }),
    );
    flushSync();
    return target;
}
async function beginPasskey(target: Element, component: typeof HomeRouteV1 | typeof HomeRouteV2) {
    if (component === HomeRouteV1) {
        button(target, "loginDialog.signin").click();
        await settle();
        button(target, "loginDialog.signinWith:Passkey").click();
    } else {
        button(target, "I'm an existing user").click();
    }
    await settle();
    expect(calls.signIn).toHaveBeenCalledExactlyOnceWith();
}
function markAuthenticated() {
    (anonUserStore as unknown as { set(value: boolean): void }).set(false);
    identityStateStore.set({ kind: "logged_in" });
}
function expectNoOtherAuth() {
    expect(calls.signUp).not.toHaveBeenCalled();
    expect(calls.browserSignIn).not.toHaveBeenCalled();
    expect(calls.webSignIn).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.resetAllMocks();
    calls.signIn.mockResolvedValue(undefined);
    calls.linkAccount.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    localStorage.clear();
    (anonUserStore as unknown as { set(value: boolean): void }).set(true);
    chatsInitialisedStore.set(false);
    identityStateStore.set({ kind: "anon" });
    routeStore.set({ kind: "home_route" } as never);
    (selectedAuthProviderStore as unknown as { set(value: undefined): void }).set(undefined);
    (querystringStore as unknown as { set(value: URLSearchParams): void }).set(
        new URLSearchParams(),
    );
});
afterEach(async () => {
    for (const component of mounted) await unmount(component);
    mounted = [];
    document.body.innerHTML = "";
    expectNoOtherAuth();
    vi.restoreAllMocks();
});

for (const [label, component] of [
    ["v1", HomeRouteV1],
    ["v2", HomeRouteV2],
] as const) {
    describe(`${label} original native onboarding parent lifecycle`, () => {
        it("offers the original choices before chat discovery without starting any auth", async () => {
            const target = render(component);
            await settle();
            expect(target.querySelector(".welcome")).not.toBeNull();
            expect(target.querySelector(".loading")).toBeNull();
            button(
                target,
                component === HomeRouteV1 ? "loginDialog.signin" : "I'm an existing user",
            );
            button(
                target,
                component === HomeRouteV1 ? "register.createAccount" : "Create new account",
            );
            expect(target.textContent).not.toContain("Continue in browser");
            expect(target.querySelector(".existing-account-sign-in")).toBeNull();
            expect(calls.signIn).not.toHaveBeenCalled();
            expect(calls.linkAccount).not.toHaveBeenCalled();
        });

        it("allows the native passkey operation to finish after logging_in changes to loading_user", async () => {
            const completion = deferred();
            const accepted = vi.fn(markAuthenticated);
            calls.signIn.mockImplementation(() => {
                identityStateStore.set({ kind: "logging_in" });
                return completion.promise.then(accepted);
            });
            const abort = vi.spyOn(AbortController.prototype, "abort");
            const target = render(component);
            const welcome = target.querySelector(".welcome");
            await beginPasskey(target, component);
            expect(target.querySelector(".welcome")).toBe(welcome);
            chatsInitialisedStore.set(true);
            await settle();
            expect(target.querySelector(".welcome")).toBe(welcome);
            expect(accepted).not.toHaveBeenCalled();

            identityStateStore.set({ kind: "loading_user", registering: false });
            await settle();
            expect(target.querySelector(".welcome")).toBeNull();
            expect(target.querySelector(".loading")).not.toBeNull();
            expect(abort).not.toHaveBeenCalled();
            expect(calls.linkAccount).not.toHaveBeenCalled();

            completion.resolve();
            await settle();
            expect(accepted).toHaveBeenCalledOnce();
            expect(get(identityStateStore).kind).toBe("logged_in");
            expect(target.querySelector(".welcome")).toBeNull();
            expect(target.querySelector(".loading")).toBeNull();
            expect(calls.signIn).toHaveBeenCalledExactlyOnceWith();
            expect(abort).not.toHaveBeenCalled();
        });

        it("shows startup restoration progress without invoking a passkey or account creation", async () => {
            identityStateStore.set({ kind: "loading_user", registering: false });
            const target = render(component);
            await settle();
            expect(target.querySelector(".welcome")).toBeNull();
            expect(target.querySelector(".loading")).not.toBeNull();
            markAuthenticated();
            await settle();
            expect(target.querySelector(".loading")).not.toBeNull();
            chatsInitialisedStore.set(true);
            await settle();
            expect(target.querySelector(".welcome")).toBeNull();
            expect(target.querySelector(".loading")).toBeNull();
            expect(calls.signIn).not.toHaveBeenCalled();
            expect(calls.linkAccount).not.toHaveBeenCalled();
        });

        it("returns failed startup restoration to original onboarding without automatic retry", async () => {
            identityStateStore.set({ kind: "loading_user", registering: false });
            const target = render(component);
            await settle();
            identityStateStore.set({ kind: "anon" });
            await settle();
            expect(target.querySelector(".welcome")).not.toBeNull();
            expect(target.querySelector(".loading")).toBeNull();
            button(
                target,
                component === HomeRouteV1 ? "loginDialog.signin" : "I'm an existing user",
            );
            expect(calls.signIn).not.toHaveBeenCalled();
            expect(calls.linkAccount).not.toHaveBeenCalled();
        });
    });
}

describe("v2 original native code-link parent lifecycle", () => {
    async function openCodeForm() {
        calls.signIn.mockRejectedValueOnce({ code: "NO_PASSKEY" });
        const target = render(HomeRouteV2);
        await beginPasskey(target, HomeRouteV2);
        const input = target.querySelector<HTMLInputElement>('input[maxlength="6"]');
        expect(input).not.toBeNull();
        expect(button(target, "Link with existing account").disabled).toBe(true);
        expect(calls.linkAccount).not.toHaveBeenCalled();
        input!.value = "ABC123";
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        return { target, input };
    }

    it("keeps the explicit code-link operation alive through parent loading and finishes once", async () => {
        const completion = deferred();
        const accepted = vi.fn(markAuthenticated);
        calls.linkAccount.mockImplementation(() => {
            identityStateStore.set({ kind: "logging_in" });
            return completion.promise.then(accepted);
        });
        const abort = vi.spyOn(AbortController.prototype, "abort");
        const { target, input } = await openCodeForm();
        const link = button(target, "Link with existing account");
        expect(link.disabled).toBe(false);
        link.click();
        await settle();
        expect(calls.linkAccount).toHaveBeenCalledExactlyOnceWith("ABC123");
        expect(link.disabled).toBe(true);
        chatsInitialisedStore.set(true);
        await settle();
        expect(target.querySelector('input[maxlength="6"]')).toBe(input);
        expect(accepted).not.toHaveBeenCalled();

        identityStateStore.set({ kind: "loading_user", registering: false });
        await settle();
        expect(target.querySelector('input[maxlength="6"]')).toBeNull();
        expect(target.querySelector(".loading")).not.toBeNull();
        expect(calls.stopVersionChecker).toHaveBeenCalledOnce();
        expect(abort).not.toHaveBeenCalled();
        completion.resolve();
        await settle();
        expect(accepted).toHaveBeenCalledOnce();
        expect(target.querySelector(".welcome")).toBeNull();
        expect(target.querySelector(".loading")).toBeNull();
        expect(calls.linkAccount).toHaveBeenCalledExactlyOnceWith("ABC123");
        expect(abort).not.toHaveBeenCalled();
    });

    it("keeps a linking failure in the original code form for explicit retry", async () => {
        const completion = deferred();
        calls.linkAccount.mockReturnValueOnce(completion.promise);
        const { target, input } = await openCodeForm();
        button(target, "Link with existing account").click();
        await settle();
        expect(button(target, "Link with existing account").disabled).toBe(true);
        completion.reject({ code: 2 });
        await settle();
        expect(target.querySelector('input[maxlength="6"]')).toBe(input);
        expect(input!.value).toBe("ABC123");
        expect(target.textContent).toContain("linkingCodeNotFound");
        expect(button(target, "Link with existing account").disabled).toBe(false);
        expect(calls.linkAccount).toHaveBeenCalledOnce();
    });
});
