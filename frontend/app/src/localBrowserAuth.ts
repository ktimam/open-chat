import { ECDSAKeyIdentity, WebAuthnIdentity } from "@icp-sdk/core/identity";
import { DER_COSE_OID, unwrapDER } from "@icp-sdk/core/agent";
import { IdentityAgent } from "@agent/services/identityAgent";
import { lookupNativeBrowserCredential } from "@agent/services/nativeBrowserAccountSession";
import { BrowserAccountLinkFlow, createBrowserLinkPasskey, browserSignInError } from "@client/utils/browserAccountLink";
import { createNativeBrowserAuthVerifier, type NativeBrowserAuthChallenge } from "@client/utils/nativeBrowserAuth";
import { signNativeBrowserChallenge } from "@client/utils/nativeBrowserSigner";

declare const __LOCAL_IDENTITY_CANISTER__: string;
const officialIdentity = __LOCAL_IDENTITY_CANISTER__;
const icUrl = "https://icp-api.io";
const element = <T extends HTMLElement>(id: string) => {
    const value = document.getElementById(id);
    if (!value) throw new Error("Missing sign-in control");
    return value as T;
};
const signIn = element<HTMLButtonElement>("sign-in");
const startLink = element<HTMLButtonElement>("start-link");
const code = element<HTMLInputElement>("code");
const verify = element<HTMLButtonElement>("verify-code");
const confirm = element<HTMLInputElement>("confirm");
const create = element<HTMLButtonElement>("create-passkey");
const status = element("status");
const controller = new AbortController();
let challenge: NativeBrowserAuthChallenge | undefined;
let busy = false;
let submitted = false;
let flow: BrowserAccountLinkFlow | undefined;
let linkFinalizationStarted = false;

function active(): NativeBrowserAuthChallenge {
    if (!challenge || controller.signal.aborted || Date.now() >= challenge.expiresAtMs || submitted) throw new Error("Sign-in request expired");
    return challenge;
}
function controls() {
    const unavailable = busy || submitted || !challenge || Date.now() >= challenge.expiresAtMs;
    signIn.disabled = unavailable;
    startLink.disabled = unavailable || flow?.state.stage === "uncertain" || flow?.state.stage === "linked";
    verify.disabled = unavailable || !(flow?.state.stage === "idle" ||
        (flow?.state.stage === "error" && !flow.state.canStartFresh));
    code.disabled = verify.disabled;
    create.disabled = unavailable || !confirm.checked || flow?.state.stage !== "verified";
}
function failure(error: unknown) {
    status.textContent = browserSignInError(error);
    controls();
}
window.addEventListener("pagehide", () => { controller.abort(); flow?.cancel(); code.value = ""; }, { once: true });

signIn.addEventListener("click", async () => {
    if (busy || submitted) return;
    busy = true; controls();
    try {
        const request = active();
        status.textContent = "Choose your existing localhost passkey. Nothing has been submitted to the APK yet.";
        const candidate = await signNativeBrowserChallenge(request, officialIdentity,
            id => lookupNativeBrowserCredential(officialIdentity, icUrl, id, controller.signal), controller.signal);
        active();
        submitted = true; // No retries after uncertain delivery; another attempt needs a new APK key.
        const response = await fetch("/candidate", { method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidate), signal: controller.signal });
        if (!response.ok) throw new Error("APK submission failed");
        status.textContent = "Response submitted, not yet verified. Return to the APK to finish checking this account.";
    } catch (error) {
        if (submitted) status.textContent = "Delivery failed or its outcome is unknown. Return to the APK; do not resubmit this attempt.";
        else failure(error);
    } finally { busy = false; controls(); }
});

startLink.addEventListener("click", () => {
    if (busy || submitted) return;
    try { active(); } catch (error) { failure(error); return; }
    flow?.cancel();
    let key: ECDSAKeyIdentity | undefined;
    let agent: IdentityAgent | undefined;
    let forgotten = false;
    flow = new BrowserAccountLinkFlow({
        verify: async (value) => {
            active(); key = await ECDSAKeyIdentity.generate();
            if (forgotten) throw new Error("Link cancelled");
            agent = await IdentityAgent.create(key, officialIdentity, icUrl, false, true);
            active();
            const result = await agent.verifyAccountLinkingCode(value);
            if (forgotten || result.kind !== "success") throw new Error("Link verification failed");
            return result.username;
        },
        createPasskey: async (username) => { active(); return createBrowserLinkPasskey("localhost", username); },
        finalize: async (credential) => {
            active();
            if (forgotten || !agent || !key) throw new Error("No verified account link");
            // Verification and finalization are two distinct, explicit updates. Each gets
            // its own no-retry transport while retaining the same verified ephemeral key.
            const finalizingKey = key;
            const finalizingAgent = await IdentityAgent.create(finalizingKey, officialIdentity, icUrl, false, true);
            active();
            if (forgotten || key !== finalizingKey) throw new Error("Account link changed");
            const identity = new WebAuthnIdentity(credential.credentialId, unwrapDER(credential.publicKey, DER_COSE_OID), undefined);
            linkFinalizationStarted = true;
            await finalizingAgent.finaliseAccountLinkingWithCode(identity.getPrincipal().toString(), credential.publicKey, finalizingKey, credential);
        },
        forget: () => { forgotten = true; key = undefined; agent = undefined; },
    }, state => {
        element("link-status").textContent = state.message;
        element("link-confirmation").hidden = state.stage !== "verified";
        controls();
    });
    code.value = ""; confirm.checked = false;
    element("link").hidden = false; element("link-confirmation").hidden = true;
    element("link-status").textContent = flow.state.message;
    controls();
});
verify.addEventListener("click", async () => {
    if (busy || !flow) return;
    busy = true; const value = code.value; code.value = ""; controls();
    try { await flow.verify(value, active().expectedUsername); }
    catch (error) { failure(error); }
    finally { busy = false; controls(); }
});
confirm.addEventListener("change", controls);
create.addEventListener("click", async () => {
    if (busy || !confirm.checked || !flow) return;
    busy = true; controls();
    try { active(); await flow.complete(); }
    catch (error) { failure(error); }
    finally { busy = false; controls(); }
});

void (async () => {
    try {
        if (location.protocol !== "http:" || location.hostname !== "localhost" || location.pathname !== "/sign-in") throw new Error("Unexpected page origin");
        const response = await fetch("/challenge", { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok) throw new Error("No active APK attempt");
        const body = await response.text();
        if (body.length > 8192) throw new Error("Invalid APK attempt");
        const request = JSON.parse(body) as NativeBrowserAuthChallenge;
        createNativeBrowserAuthVerifier(request).cancel();
        if (request.origin !== location.origin || request.identityCanister !== officialIdentity) throw new Error("Unexpected APK request");
        challenge = Object.freeze({ ...request });
        element("username").textContent = request.expectedUsername;
        element("expiry").textContent = `This request expires at ${new Date(request.expiresAtMs).toLocaleTimeString()}. The test session expires by ${new Date(request.delegationExpiresAtMs).toLocaleTimeString()}.`;
        status.textContent = "Review the username and short lifetime, then choose an explicit sign-in or account-linking action.";
        controls();
        window.setTimeout(() => {
            if (!submitted) {
                controller.abort(); flow?.cancel(); code.value = "";
                status.textContent = linkFinalizationStarted
                    ? "This request expired. Account linking may have completed; do not repeat linking. Start a fresh APK sign-in and choose the existing passkey."
                    : "This request expired. Start a fresh sign-in from the APK. No account-link finalization was requested.";
                controls();
            }
        }, Math.max(0, request.expiresAtMs - Date.now()));
    } catch { status.textContent = "This APK sign-in request is unavailable or invalid. Return to the APK and start again. No passkey was used."; }
})();
