<script lang="ts">
    import { getContext, onDestroy } from "svelte";
    import { OpenChat } from "@client";
    import {
        browserSignInError,
        type BrowserAccountLinkFlow,
        type BrowserAccountLinkState,
    } from "@client/utils/browserAccountLink";

    let { onSignedIn = () => {} }: { onSignedIn?: () => void } = $props();
    const client = getContext<OpenChat>("client");
    const localApk = client.existingAccountOnly() && client.isNativeApp();
    const restoreState = client.nativeSessionRestoreState;
    let nativeController: AbortController | undefined;
    let nativeStatus = $state("");
    let flow: BrowserAccountLinkFlow | undefined;
    let linkState = $state<BrowserAccountLinkState>({
        stage: "idle",
        message: "Nothing has been sent.",
        canStartFresh: false,
    });
    let linking = $state(false);
    let username = $state("");
    let code = $state("");
    let confirmed = $state(false);
    let signingIn = $state(false);
    let error = $state("");
    let busy = $derived(
        signingIn ||
            $restoreState === "restoring" ||
            linkState.stage === "verifying" ||
            linkState.stage === "linking",
    );

    function startLink() {
        flow?.cancel();
        flow = client.createBrowserAccountLinkFlow((state) => {
            linkState = state;
        });
        linkState = flow.state;
        linking = true;
        code = "";
        confirmed = false;
        error = "";
    }

    async function signIn() {
        if (busy) return;
        signingIn = true;
        error = "";
        try {
            if (localApk) {
                nativeController = new AbortController();
                await client.signInWithLocalBrowser(username, {
                    signal: nativeController.signal,
                    onStatus: (text) => {
                        nativeStatus = text;
                    },
                });
            } else {
                await client.signInWithWebAuthn(flow?.signInExpectation());
            }
            onSignedIn();
        } catch (failure) {
            error = browserSignInError(failure);
        } finally {
            signingIn = false;
        }
    }

    async function verify() {
        if (busy || flow === undefined) return;
        const submittedCode = code;
        code = "";
        confirmed = false;
        await flow.verify(submittedCode, username);
    }

    async function retrySavedSignIn() {
        if (busy) return;
        error = "";
        try {
            await client.retrySavedNativeSession();
        } catch (failure) {
            error = browserSignInError(failure);
        }
    }

    async function complete() {
        if (!busy && confirmed) await flow?.complete();
    }

    onDestroy(() => {
        code = "";
        flow?.cancel();
        nativeController?.abort();
    });
</script>

<section class="existing-account-sign-in" aria-busy={busy}>
    <h2>Use your existing OpenChat account</h2>
    <p>
        This is an unofficial client connected to OpenChat. Signing in does not create a new
        account.
    </p>
    {#if localApk}
        <label
            >Existing OpenChat username
            <input
                type="text"
                autocomplete="username"
                maxlength="100"
                bind:value={username}
                disabled={busy}
            />
        </label>
        <p class="hint">
            This separate local-test APK uses your browser's localhost passkey. Sign-in and optional
            account linking happen in that browser, then return here. Sign-in is saved on this
            device for up to 30 days, or until you sign out. The browser request itself expires in
            two minutes.
        </p>
        {#if $restoreState === "restoring"}<p role="status">Verifying your saved sign-in…</p>{/if}
        {#if $restoreState === "retry"}
            <p role="alert">
                Your saved sign-in could not be verified. Check your connection and retry; you do
                not need to create another passkey.
            </p>
            <button type="button" disabled={busy} onclick={retrySavedSignIn}
                >Retry saved sign-in</button
            >
        {:else if $restoreState === "invalid"}
            <p role="status">
                Your saved sign-in is invalid or expired. Use your existing passkey to sign in
                again.
            </p>
        {/if}
    {/if}
    <button
        class="primary"
        type="button"
        disabled={busy || (localApk && !username.trim())}
        onclick={signIn}
    >
        {signingIn
            ? "Waiting for passkey sign-in…"
            : localApk
              ? "Continue in browser to sign in or link"
              : "Sign in with an existing passkey"}
    </button>
    {#if localApk && signingIn}
        <button type="button" onclick={() => nativeController?.abort()}>Cancel this sign-in</button>
    {/if}
    {#if nativeStatus}<p role="status">{nativeStatus}</p>{/if}
    {#if !localApk}<p class="hint">
            Already linked on this hostname? Choose that existing passkey. You do not need another
            linking code.
        </p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if localApk}
        <p class="hint">
            Your official OpenChat app and its saved model downloads are not changed.
        </p>
    {:else if !linking}
        <button type="button" disabled={busy} onclick={startLink}
            >Link this client to my account</button
        >
    {:else}
        <div class="link-account">
            <h3>Link an existing account</h3>
            <p>
                Generate an account-linking code in the official OpenChat client. Verification
                consumes the code. Adding a passkey requires a separate confirmation.
            </p>
            {#if linkState.stage === "idle" || (linkState.stage === "error" && !linkState.canStartFresh)}
                <label
                    >Existing OpenChat username
                    <input
                        type="text"
                        autocomplete="username"
                        maxlength="100"
                        bind:value={username}
                        disabled={busy}
                    />
                </label>
                <label
                    >Official six-character account-linking code
                    <input
                        type="text"
                        autocomplete="off"
                        spellcheck={false}
                        bind:value={code}
                        disabled={busy}
                    />
                </label>
                <button
                    type="button"
                    disabled={busy || !username.trim() || !code.trim()}
                    onclick={verify}>Verify code</button
                >
            {:else if linkState.stage === "verified"}
                <p>Verified username: <strong>{linkState.username}</strong></p>
                <label class="confirmation">
                    <input type="checkbox" bind:checked={confirmed} disabled={busy} />
                    <span
                        >I confirm this is my account and want to add a passkey for this unofficial
                        client.</span
                    >
                </label>
                <button
                    class="primary"
                    type="button"
                    disabled={busy || !confirmed}
                    onclick={complete}>Create passkey and link this account</button
                >
            {/if}
            <p
                role={linkState.stage === "error" || linkState.stage === "uncertain"
                    ? "alert"
                    : "status"}
            >
                {linkState.message}
            </p>
            {#if linkState.canStartFresh}
                <button type="button" disabled={busy} onclick={startLink}
                    >Enter a fresh linking code</button
                >
            {/if}
        </div>
    {/if}
</section>

<style>
    .existing-account-sign-in {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        width: 100%;
        min-width: 0;
        max-width: 36rem;
        margin: 0 auto;
    }
    h2,
    h3,
    p {
        margin: 0;
    }
    p,
    label {
        line-height: 1.5;
        overflow-wrap: anywhere;
    }
    .hint {
        font-size: 0.875rem;
        opacity: 0.85;
    }
    .link-account {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        border-top: 1px solid var(--bd, #888);
        padding-top: 1rem;
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }
    input[type="text"] {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--bd, #888);
        border-radius: 0.5rem;
        padding: 0.75rem;
    }
    button {
        font: inherit;
        color: inherit;
        border: 1px solid var(--bd, #888);
        border-radius: 0.5rem;
        padding: 0.8rem 1rem;
        cursor: pointer;
        background: transparent;
    }
    button.primary {
        border-color: var(--primary, #6259c7);
        background: var(--primary, #6259c7);
        color: white;
    }
    button:disabled {
        opacity: 0.55;
        cursor: default;
    }
    .confirmation {
        flex-direction: row;
        align-items: flex-start;
        gap: 0.75rem;
    }
    .confirmation input {
        width: auto;
        flex: 0 0 auto;
        margin-top: 0.35rem;
    }
    .error {
        color: var(--error, #b42318);
    }
</style>
