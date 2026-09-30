// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopOnboard from "../components/onboard/OnboardModal.svelte";
import MobileOnboard from "../components_mobile/onboard/OnboardModal.svelte";

const calls = vi.hoisted(() => ({ navigate: vi.fn(), stopVersionChecker: vi.fn() }));
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
        identityStateStore: writable({ kind: "anon" }),
        querystringStore: writable(new URLSearchParams("auth=PASSKEY")),
        selectedAuthProviderStore: writable(undefined),
    };
});
vi.mock("@shared", () => ({
    ErrorCode: { AlreadyRegistered: 1, LinkingCodeNotFound: 2, MaxLinkedIdentitiesLimitReached: 3 },
}));
vi.mock("@utils/navigation", () => ({ navigate: calls.navigate }));
vi.mock("@src/i18n/i18n", () => ({
    i18nKey: (key: string, params?: { provider?: string }) =>
        params?.provider ? `${key}:${params.provider}` : key,
    interpolate: (_: unknown, key: string) => key,
    setLocale: vi.fn(),
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

// Keep both real onboarding components, desktop ModeSelection, SignIn and
// ChooseSignInOption mounted. Stub visual leaves and services only. No credential
// provider, network, account creation or browser bridge executes in this test.
vi.mock("../components/ModalContent.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/icons/FancyLoader.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/Select.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/Button.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/ButtonGroup.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/Input.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/Translatable.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/ErrorMessage.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/home/EmailSigninFeedback.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/home/profile/OnBoardOptionLogo.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/home/profile/SignInOption.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components/onboard/SignUp.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/Translatable.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/ErrorMessage.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/Progress.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components_shared/Markdown.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/onboard/SignUp.svelte", async () => ({
    default: (await import("./originalOnboard.spec.shell.svelte")).default,
}));
vi.mock("component-lib", async () => {
    const shell = (await import("./originalOnboard.spec.shell.svelte")).default;
    return {
        Body: shell,
        BodySmall: shell,
        Button: shell,
        Column: shell,
        CommonButton: shell,
        Container: shell,
        H1: shell,
        Overview: shell,
        Sheet: shell,
        Subtitle: shell,
        Title: shell,
        ColourVars: { primary: "primary" },
    };
});

let mounted: ReturnType<typeof mount>[] = [];
function render(mobile: boolean, native = true) {
    const target = document.createElement("div");
    document.body.append(target);
    const client = {
        isNativeApp: () => native,
        // Even a stale policy flag must not select the replacement UI.
        existingAccountOnly: () => true,
        signInWithAndroidWebAuthn: vi.fn(async () => undefined),
        signInWithWebAuthn: vi.fn(async () => undefined),
        signInWithLocalBrowser: vi.fn(),
        linkAccountsWithAndroidWebAuthn: vi.fn(async (_code: string) => undefined),
        signUpWithAndroidWebAuthn: vi.fn(),
        gaTrack: vi.fn(),
    };
    const context = new Map([["client", client]]);
    mounted.push(
        mobile
            ? mount(MobileOnboard, { target, context })
            : mount(DesktopOnboard, { target, context, props: { onClose: vi.fn() } }),
    );
    flushSync();
    return { target, client };
}
function button(target: Element, label: string): HTMLButtonElement {
    const found = [...target.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === label,
    );
    expect(found, `Expected original button: ${label}`).toBeDefined();
    return found!;
}
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
    for (const component of mounted) await unmount(component);
    mounted = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("original OpenChat mounted onboarding", () => {
    it.each([true, false])(
        "desktop native=%s uses the original mode selection and passkey route",
        async (native) => {
            const { target, client } = render(false, native);
            button(target, "loginDialog.signin").click();
            await settle();
            button(target, "loginDialog.signinWith:Passkey").click();
            await settle();
            expect(client.signInWithAndroidWebAuthn).toHaveBeenCalledTimes(native ? 1 : 0);
            expect(client.signInWithWebAuthn).toHaveBeenCalledTimes(native ? 0 : 1);
            expect(client.signInWithLocalBrowser).not.toHaveBeenCalled();
            expect(client.signUpWithAndroidWebAuthn).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])(
        "mobile native=%s existing-user button uses the original platform route",
        async (native) => {
            const { target, client } = render(true, native);
            expect(button(target, "Create new account")).toBeDefined();
            button(target, "I'm an existing user").click();
            await settle();
            expect(client.signInWithAndroidWebAuthn).toHaveBeenCalledTimes(native ? 1 : 0);
            expect(client.signInWithWebAuthn).toHaveBeenCalledTimes(native ? 0 : 1);
            expect(client.signInWithLocalBrowser).not.toHaveBeenCalled();
            expect(client.signUpWithAndroidWebAuthn).not.toHaveBeenCalled();
        },
    );

    it.each(["NO_PASSKEY", "USER_CANCELLED"])(
        "mobile %s offers the original code-linking screen without auto-linking",
        async (code) => {
            const { target, client } = render(true);
            client.signInWithAndroidWebAuthn.mockRejectedValueOnce({ code });
            button(target, "I'm an existing user").click();
            await settle();
            const link = button(target, "Link with existing account");
            expect(link.disabled).toBe(true);
            expect(client.linkAccountsWithAndroidWebAuthn).not.toHaveBeenCalled();
            const input = target.querySelector<HTMLInputElement>('input[maxlength="6"]')!;
            expect(input).not.toBeNull();
            input.value = "ABC123";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await settle();
            expect(link.disabled).toBe(false);
            link.click();
            await settle();
            expect(client.linkAccountsWithAndroidWebAuthn).toHaveBeenCalledExactlyOnceWith(
                "ABC123",
            );
            expect(client.signInWithLocalBrowser).not.toHaveBeenCalled();
            expect(client.signUpWithAndroidWebAuthn).not.toHaveBeenCalled();
        },
    );

    it("mobile AUTH_FAILED keeps the original visible error and does not offer code linking", async () => {
        const { target, client } = render(true);
        client.signInWithAndroidWebAuthn.mockRejectedValueOnce("AUTH_FAILED");
        button(target, "I'm an existing user").click();
        await settle();
        expect(target.textContent).toContain("native.auth.error");
        expect(target.querySelector('input[maxlength="6"]')).toBeNull();
        expect(client.linkAccountsWithAndroidWebAuthn).not.toHaveBeenCalled();
    });

    it("neither production onboarding entrypoint imports or calls the fork browser bridge", () => {
        for (const layout of ["components", "components_mobile"]) {
            const source = readFileSync(
                resolve(process.cwd(), `app/src/${layout}/onboard/OnboardModal.svelte`),
                "utf8",
            );
            expect(source).not.toMatch(
                /ExistingAccountSignIn|signInWithLocalBrowser|nativeBrowser|existingAccountOnly/,
            );
        }
    });
});
