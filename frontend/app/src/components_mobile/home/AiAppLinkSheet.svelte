<script lang="ts">
    // The one-time consent sheet for a per-user-keys AI app the user hasn't linked yet: shows a
    // high-entropy claim token (user_index create_ai_app_link_code) which the user pastes in the app;
    // the exact registered app canister calls c2c_claim_ai_app_link_code. Success returns and the app
    // retains {app_subject, subject_version, app_id, app_revision, app_canister_id, key_version};
    // revocation binds that exact app-subject/app/key_version/public-key tuple plus timestamp and
    // signature. The deprecated public
    // claim_ai_app_link_code method is never an integration path. "Check
    // connection" re-queries my_ai_app_keys and, once the key appears, hands control back to the
    // caller so the propose flow that triggered the sheet resumes automatically.
    import { i18nKey } from "@src/i18n/i18n";
    import { connectSurfaceOpening, openSurfaceExternally } from "@utils/aiAppSurfaces";
    import { cancelAiAppLinkConsent } from "@utils/aiAppLinkConsent";
    import { Body, BodySmall, CommonButton, Container, Sheet, Title } from "component-lib";
    import type { AiAppLinkCode, AiAppRegistration, OpenChat } from "@client";
    import { getContext } from "svelte";
    import Check from "svelte-material-icons/Check.svelte";
    import ContentCopy from "svelte-material-icons/ContentCopy.svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Refresh from "svelte-material-icons/Refresh.svelte";
    import { now500 } from "../../stores/time";
    import { toastStore } from "../../stores/toast";
    import Translatable from "../Translatable.svelte";
    import AiAppSurfaceDestination from "../../components/home/AiAppSurfaceDestination.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        app: AiAppRegistration;
        onDismiss: () => void;
        // The app has claimed the code (the user's key is now registered) — the caller closes the
        // sheet and resumes the propose that triggered it.
        onLinked: () => void;
    }

    let { app, onDismiss, onLinked }: Props = $props();

    // The app's registered "connect" surface — its pairing-code entry page. When declared, the
    // sheet offers a one-tap "open the right page" shortcut instead of leaving the user to hunt
    // through the app's menus for where the code goes.
    let connectSurface = $derived(connectSurfaceOpening(app));

    let loadingCode = $state(false);
    let codeFailed = $state(false);
    let checking = $state(false);
    let cancelling = $state(false);
    let completed = $state(false);
    let notLinkedYet = $state(false);
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

    void fetchCode();

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
        const keys = await client.myAiAppKeys();
        checking = false;
        if (cancelling || completed) return;
        if (keys.some((k) => k.appId === app.id && k.publicKey.length > 0)) {
            completed = true;
            onLinked();
        } else {
            notLinkedYet = true;
        }
    }
</script>

<Sheet onDismiss={cancelLink}>
    <Container height={"hug"} padding={"xl"} gap={"lg"} direction={"vertical"}>
        <Title fontWeight={"bold"}>
            <Translatable resourceKey={i18nKey("aiApps.linkTitle", { name: app.manifest.name })} />
        </Title>

        {#if app.manifest.description.length > 0}
            <BodySmall colour={"textSecondary"}>{app.manifest.description}</BodySmall>
        {/if}

        <Body>
            <Translatable
                resourceKey={i18nKey("aiApps.linkExplain", { name: app.manifest.name })}
            />
        </Body>
        <BodySmall colour={"textSecondary"}>
            Only the exact registered app canister can redeem this code. Replacement keys are
            versioned so an old disconnect proof cannot revoke the new connection.
        </BodySmall>

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

            <!-- How-to: numbered steps; when the app registered a "connect" surface the second
                 step is a one-tap button that opens its code-entry page directly. -->
            <ol class="steps">
                <li>
                    <BodySmall>
                        <Translatable resourceKey={i18nKey("aiApps.linkStepCopy")} />
                    </BodySmall>
                </li>
                <li>
                    {#if connectSurface !== undefined}
                        <BodySmall>
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkStepOpen", {
                                    name: app.manifest.name,
                                })}
                            />
                        </BodySmall>
                        <div class="connect-destination">
                            <AiAppSurfaceDestination
                                title={app.manifest.name}
                                displayUrl={connectSurface.url}
                                dataDisclosures={connectSurface.dataDisclosures}
                            />
                        </div>
                        <CommonButton
                            onClick={() => openSurfaceExternally(client, connectSurface.url)}
                            size={"small_text"}
                        >
                            {#snippet icon(color, size)}
                                <OpenInNew {color} {size} />
                            {/snippet}
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkOpenConnectPage", {
                                    name: app.manifest.name,
                                })}
                            />
                        </CommonButton>
                    {:else}
                        <BodySmall>
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkInstruction", {
                                    name: app.manifest.name,
                                })}
                            />
                        </BodySmall>
                    {/if}
                </li>
                <li>
                    <BodySmall>
                        <Translatable resourceKey={i18nKey("aiApps.linkStepPaste")} />
                    </BodySmall>
                </li>
                <li>
                    <BodySmall>
                        <Translatable resourceKey={i18nKey("aiApps.linkStepCheck")} />
                    </BodySmall>
                </li>
            </ol>

            {#if notLinkedYet}
                <BodySmall colour={"textSecondary"}>
                    <Translatable
                        resourceKey={i18nKey("aiApps.linkNotYet", { name: app.manifest.name })}
                    />
                </BodySmall>
            {/if}
        {:else if codeFailed}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.linkCodeFailed")} />
            </BodySmall>
        {/if}

        <Container gap={"md"} mainAxisAlignment={"end"} crossAxisAlignment={"center"}>
            {#if linkCode !== undefined && !expired}
                <CommonButton onClick={copyCode} size={"medium"}>
                    {#snippet icon(color, size)}
                        <ContentCopy {color} {size} />
                    {/snippet}
                    <Translatable resourceKey={i18nKey("aiApps.linkCodeCopy")} />
                </CommonButton>
            {/if}
            {#if codeFailed || expired}
                <CommonButton loading={loadingCode} onClick={fetchCode} size={"medium"}>
                    {#snippet icon(color, size)}
                        <Refresh {color} {size} />
                    {/snippet}
                    <Translatable resourceKey={i18nKey("aiApps.linkNewCode")} />
                </CommonButton>
            {/if}
            <CommonButton
                mode={"active"}
                loading={checking}
                disabled={loadingCode || cancelling || linkCode === undefined}
                onClick={checkConnection}
                size={"medium"}
            >
                {#snippet icon(color, size)}
                    <Check {color} {size} />
                {/snippet}
                <Translatable resourceKey={i18nKey("aiApps.checkConnection")} />
            </CommonButton>
        </Container>
    </Container>
</Sheet>

<style>
    .steps {
        margin: 0;
        padding-inline-start: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        width: 100%;

        li::marker {
            color: var(--text-secondary, inherit);
        }
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

    .connect-destination {
        display: flex;
        flex-direction: column;
        gap: var(--pad-xs);
        margin: var(--pad-xs) 0;
        padding: var(--pad-sm);
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
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
