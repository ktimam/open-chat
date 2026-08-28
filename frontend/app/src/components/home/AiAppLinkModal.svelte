<script lang="ts">
    // The one-time consent modal for a per-user-keys AI app the user hasn't linked yet: shows a
    // high-entropy claim token (user_index create_ai_app_link_code) which the user pastes in the app;
    // the exact registered app canister calls c2c_claim_ai_app_link_code. Success returns and the app
    // retains {app_subject, subject_version, app_id, app_revision, app_canister_id, key_version};
    // revocation binds that exact app-subject/app/key_version/public-key tuple plus timestamp and
    // signature. The deprecated public
    // claim_ai_app_link_code method is never an integration path. "Check
    // connection" re-queries my_ai_app_keys and, once the key appears, hands control back to the
    // caller so the propose flow that triggered the modal resumes automatically.
    import { i18nKey } from "@src/i18n/i18n";
    import { now500 } from "@src/stores/time";
    import { toastStore } from "@src/stores/toast";
    import { connectSurfaceOpening, openSurfaceExternally } from "@utils/aiAppSurfaces";
    import { aiAppLinkCompleted, cancelAiAppLinkConsent } from "@utils/aiAppLinkConsent";
    import {
        mobileWidth,
        type AiAppLinkCode,
        type AiAppRegistration,
        type OpenChat,
    } from "@client";
    import { getContext } from "svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Button from "../Button.svelte";
    import ButtonGroup from "../ButtonGroup.svelte";
    import ModalContent from "../ModalContent.svelte";
    import Overlay from "../Overlay.svelte";
    import Translatable from "../Translatable.svelte";
    import AiAppSurfaceDestination from "./AiAppSurfaceDestination.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        app: AiAppRegistration;
        onDismiss: () => void;
        // The app has claimed the code (the user's key is now registered) — the caller closes the
        // modal and resumes the propose that triggered it.
        onLinked: () => void;
        // Provenance recovery is a distinct flow even when no key exists and the presentation says
        // Connect. It never treats key presence as proof or resumes the failed action automatically.
        purpose?: "connect" | "recovery";
        previousPublicKey?: string;
        previousKeyVersion?: bigint;
    }

    let {
        app,
        onDismiss,
        onLinked,
        purpose = "connect",
        previousPublicKey,
        previousKeyVersion,
    }: Props = $props();

    let previousConnection = $derived(
        previousPublicKey !== undefined && previousKeyVersion !== undefined
            ? { publicKey: previousPublicKey, keyVersion: previousKeyVersion }
            : undefined,
    );
    let recoveryHasExistingKey = $derived((previousPublicKey?.trim().length ?? 0) > 0);

    // The app's registered "connect" surface — its pairing-code entry page. When declared, the
    // modal offers a one-tap "open the right page" shortcut.
    let connectSurface = $derived(connectSurfaceOpening(app));

    let loadingCode = $state(false);
    let codeFailed = $state(false);
    let checking = $state(false);
    let cancelling = $state(false);
    let completed = $state(false);
    let notLinkedYet = $state(false);
    let linkCheckFailed = $state(false);
    let linkCode = $state<AiAppLinkCode | undefined>(undefined);
    let pendingCodeRequest: Promise<void> | undefined;

    let expired = $derived(linkCode !== undefined && $now500 >= Number(linkCode.expiresAt));
    let remaining = $derived(
        linkCode !== undefined
            ? client.durationFromMilliseconds(Math.max(0, Number(linkCode.expiresAt) - $now500))
            : undefined,
    );

    function formatRemaining(): string {
        if (remaining === undefined) return "";
        const pad = (n: number) => n.toString().padStart(2, "0");
        return `${pad(remaining.minutes)}:${pad(remaining.seconds)}`;
    }

    function fetchCode(): Promise<void> {
        if (pendingCodeRequest !== undefined) return pendingCodeRequest;
        const request = (async () => {
            loadingCode = true;
            codeFailed = false;
            notLinkedYet = false;
            linkCheckFailed = false;
            try {
                // Creating a new code for the same (user, app) replaces the old one, so this doubles
                // as the "get a new code" action once the current one expires.
                linkCode = await client.createAiAppLinkCode(app.id);
                codeFailed = linkCode === undefined;
            } catch {
                linkCode = undefined;
                codeFailed = true;
            } finally {
                loadingCode = false;
            }
        })();
        pendingCodeRequest = request;
        void request.finally(() => {
            if (pendingCodeRequest === request) pendingCodeRequest = undefined;
        });
        return request;
    }

    // First-time Connect keeps its existing one-step flow. Provenance recovery is advisory because
    // AppUnavailable is ambiguous, so merely opening it must not rotate/replace a live bearer.
    if (purpose === "connect") void fetchCode();

    async function cancelLink() {
        if (completed || cancelling) return;
        cancelling = true;
        await cancelAiAppLinkConsent(client, () => linkCode?.code, pendingCodeRequest);
        completed = true;
        onDismiss();
    }

    async function copyCode() {
        if (linkCode === undefined) return;
        try {
            await navigator.clipboard.writeText(linkCode.code);
            toastStore.showSuccessToast(i18nKey("aiApps.linkCodeCopied"));
        } catch {
            toastStore.showFailureToast(i18nKey("aiApps.linkCodeCopyFailed"));
        }
    }

    async function checkConnection() {
        checking = true;
        notLinkedYet = false;
        linkCheckFailed = false;
        try {
            const keys = await client.myAiAppKeys();
            if (cancelling || completed) return;
            const linked =
                purpose === "connect"
                    ? aiAppLinkCompleted(keys, app.id)
                    : previousConnection !== undefined &&
                      aiAppLinkCompleted(keys, app.id, previousConnection);
            if (linked) {
                completed = true;
                onLinked();
            } else {
                notLinkedYet = true;
            }
        } catch {
            if (!cancelling && !completed) linkCheckFailed = true;
        } finally {
            checking = false;
        }
    }
</script>

<Overlay dismissible onClose={cancelLink}>
    <ModalContent closeIcon onClose={cancelLink}>
        {#snippet header()}
            <div class="hdr">
                {#if purpose === "recovery"}
                    <Translatable
                        resourceKey={i18nKey(
                            recoveryHasExistingKey
                                ? "aiApps.reconnectTitle"
                                : "aiApps.reconnectMissingTitle",
                            { name: app.manifest.name },
                        )}
                    />
                {:else}
                    <Translatable
                        resourceKey={i18nKey("aiApps.linkTitle", { name: app.manifest.name })}
                    />
                {/if}
            </div>
        {/snippet}
        {#snippet body()}
            <div class="body">
                {#if app.manifest.description.length > 0}
                    <p class="desc">{app.manifest.description}</p>
                {/if}
                {#if purpose === "recovery"}
                    <p>
                        <Translatable
                            resourceKey={i18nKey(
                                recoveryHasExistingKey
                                    ? "aiApps.reconnectExplain"
                                    : "aiApps.reconnectMissingExplain",
                                { name: app.manifest.name },
                            )}
                        />
                    </p>
                    <p>
                        <Translatable
                            resourceKey={i18nKey("aiApps.reconnectRetryExplain", {
                                name: app.manifest.name,
                            })}
                        />
                    </p>
                {:else}
                    <p>
                        <Translatable
                            resourceKey={i18nKey("aiApps.linkExplain", {
                                name: app.manifest.name,
                            })}
                        />
                    </p>
                {/if}
                <p class="desc">
                    Only the exact registered app canister can redeem this code. Replacement keys
                    are versioned so an old disconnect proof cannot revoke the new connection.
                </p>

                {#if linkCode !== undefined}
                    <code class="code" class:expired>{linkCode.code}</code>

                    <div class="remaining" class:expired>
                        {#if expired}
                            <Translatable resourceKey={i18nKey("aiApps.linkCodeExpired")} />
                        {:else}
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkCodeExpires", {
                                    remaining: formatRemaining(),
                                })}
                            />
                        {/if}
                    </div>

                    <ol class="steps">
                        <li><Translatable resourceKey={i18nKey("aiApps.linkStepCopy")} /></li>
                        <li>
                            {#if connectSurface !== undefined}
                                <Translatable
                                    resourceKey={i18nKey("aiApps.linkStepOpen", {
                                        name: app.manifest.name,
                                    })}
                                />
                                <div class="connect-destination">
                                    <AiAppSurfaceDestination
                                        title={app.manifest.name}
                                        displayUrl={connectSurface.url}
                                        dataDisclosures={connectSurface.dataDisclosures}
                                    />
                                </div>
                                <div class="inline-btn">
                                    <Button
                                        hollow
                                        small
                                        onClick={() =>
                                            openSurfaceExternally(client, connectSurface.url)}
                                    >
                                        <OpenInNew size="1em" color="currentColor" />
                                        <Translatable
                                            resourceKey={i18nKey("aiApps.linkOpenConnectPage", {
                                                name: app.manifest.name,
                                            })}
                                        />
                                    </Button>
                                </div>
                            {:else}
                                <Translatable
                                    resourceKey={i18nKey("aiApps.linkInstruction", {
                                        name: app.manifest.name,
                                    })}
                                />
                            {/if}
                        </li>
                        <li><Translatable resourceKey={i18nKey("aiApps.linkStepPaste")} /></li>
                        <li>
                            {#if purpose === "recovery"}
                                <Translatable
                                    resourceKey={i18nKey("aiApps.reconnectStepCheck", {
                                        name: app.manifest.name,
                                    })}
                                />
                            {:else}
                                <Translatable resourceKey={i18nKey("aiApps.linkStepCheck")} />
                            {/if}
                        </li>
                    </ol>

                    {#if notLinkedYet}
                        <p class="desc">
                            <Translatable
                                resourceKey={i18nKey(
                                    purpose === "recovery"
                                        ? "aiApps.reconnectNotYet"
                                        : "aiApps.linkNotYet",
                                    { name: app.manifest.name },
                                )}
                            />
                        </p>
                    {/if}
                    {#if linkCheckFailed}
                        <p class="desc">
                            <Translatable resourceKey={i18nKey("aiApps.linkCheckFailed")} />
                        </p>
                    {/if}
                {:else if codeFailed}
                    <p class="desc">
                        <Translatable resourceKey={i18nKey("aiApps.linkCodeFailed")} />
                    </p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <ButtonGroup>
                {#if linkCode !== undefined && !expired}
                    <Button secondary small={!$mobileWidth} tiny={$mobileWidth} onClick={copyCode}>
                        <Translatable resourceKey={i18nKey("aiApps.linkCodeCopy")} />
                    </Button>
                {/if}
                {#if (purpose === "recovery" && linkCode === undefined) || codeFailed || expired}
                    <Button
                        secondary
                        loading={loadingCode}
                        small={!$mobileWidth}
                        tiny={$mobileWidth}
                        onClick={fetchCode}
                    >
                        {#if purpose === "recovery"}
                            <Translatable
                                resourceKey={i18nKey(
                                    recoveryHasExistingKey
                                        ? "aiApps.reconnectGenerateCode"
                                        : "aiApps.reconnectGenerateConnectionCode",
                                )}
                            />
                        {:else}
                            <Translatable resourceKey={i18nKey("aiApps.linkNewCode")} />
                        {/if}
                    </Button>
                {/if}
                {#if purpose === "recovery"}
                    <Button
                        secondary
                        disabled={loadingCode || cancelling}
                        small={!$mobileWidth}
                        tiny={$mobileWidth}
                        onClick={cancelLink}
                    >
                        <Translatable resourceKey={i18nKey("aiApps.close")} />
                    </Button>
                {/if}
                <Button
                    loading={checking}
                    disabled={loadingCode || cancelling || linkCode === undefined}
                    small={!$mobileWidth}
                    tiny={$mobileWidth}
                    onClick={checkConnection}
                >
                    <Translatable resourceKey={i18nKey("aiApps.checkConnection")} />
                </Button>
            </ButtonGroup>
        {/snippet}
    </ModalContent>
</Overlay>

<style>
    .hdr {
        font-weight: 700;
    }
    .body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        text-align: start;
    }
    .desc {
        color: var(--txt-light);
        margin: 0;
    }
    .steps {
        margin: 0;
        padding-inline-start: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        width: 100%;
    }
    .steps li::marker {
        color: var(--txt-light, inherit);
    }
    .inline-btn {
        margin-top: 0.25rem;
    }
    .connect-destination {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        margin-top: 0.5rem;
        padding: 0.5rem;
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }
    .code {
        display: block;
        width: 100%;
        box-sizing: border-box;
        font-family: monospace;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1.5;
        letter-spacing: 0.08em;
        overflow-wrap: anywhere;
        padding: 0.75rem;
        text-align: center;
        border: 0.125rem solid var(--primary);
        border-radius: 0.25rem;
        user-select: all;
    }
    .code.expired {
        opacity: 0.4;
    }
    .remaining {
        display: flex;
        justify-content: center;
        width: 100%;
        color: var(--warning);
    }
    .remaining.expired {
        color: var(--error);
    }
</style>
