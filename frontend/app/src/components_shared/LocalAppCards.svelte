<script lang="ts">
    import { onDestroy, tick } from "svelte";
    import { currentUserIdStore, identityStateStore, type OpenChat } from "@client";
    import { ANON_USER_ID } from "@shared";
    import {
        privateAppWorkspace as workspace,
        privateAppWorkspaceState,
    } from "../utils/privateAppWorkspace";
    import { localAppDeliveryStatus } from "../utils/localAppRelayDelivery";
    import { nativeAppDelivery, nativeAppPairing } from "../utils/nativeAppDelivery";
    import PrivateAppDraftFields from "./PrivateAppDraftFields.svelte";
    import { connectLocalAppSetup } from "../utils/localAppSetupConnection";
    import LocalAppCardSurface from "./LocalAppCardSurface.svelte";
    import ActionCardLayout from "./ActionCardLayout.svelte";
    import AiAppIcon from "../components/home/communities/explore/AiAppIcon.svelte";
    import { localAppCardAnchorKey, localAppCardAnchors } from "../utils/localAppCardAnchors";
    import { currentTheme } from "../theme/themes";
    import { formatLocalDraftJson } from "../utils/localAppDrafts";

    let { client }: { client: OpenChat } = $props();
    let acknowledged = $state(false);
    let retryConfirmed = $state(false);
    let confirmationFailed = $state(false);
    let blockedFieldDraft = $state<{ id: string | undefined; blocked: boolean }>();
    const workspaceView = $derived($privateAppWorkspaceState);
    const errorScope = $derived(
        JSON.stringify([workspaceView.draft?.id, workspaceView.editorJson]),
    );
    const proposing = $derived(workspaceView.busy && workspaceView.phase !== undefined);
    const cardSource = $derived(
        workspaceView.draft ? workspaceView.cardSources[workspaceView.draft.id] : undefined,
    );
    const namespace = $derived(
        workspaceView.account && workspaceView.backend
            ? { account: workspaceView.account, backend: workspaceView.backend }
            : undefined,
    );
    const presentationKey = $derived(
        workspaceView.cardPresentation === "source"
            ? localAppCardAnchorKey(namespace, workspaceView.presentationSource)
            : undefined,
    );
    const inline = $derived(presentationKey !== undefined);
    const anchor = $derived(
        $localAppCardAnchors.find((entry) => entry.key === presentationKey)?.node,
    );
    const sourceMatches = $derived(
        workspaceView.cardPresentation === "saved" ||
            (cardSource?.chatKey === workspaceView.presentationSource?.chatKey &&
                cardSource?.chatKind === workspaceView.presentationSource?.chatKind &&
                cardSource?.messageId === workspaceView.presentationSource?.messageId &&
                cardSource?.threadRootMessageIndex ===
                    workspaceView.presentationSource?.threadRootMessageIndex),
    );
    const showDraft = $derived(
        !!workspaceView.draft &&
            !proposing &&
            sourceMatches &&
            (workspaceView.cardPresentation === "saved" ||
                workspaceView.presentationDraftId === workspaceView.draft.id),
    );
    const revealScope = $derived(
        JSON.stringify([workspaceView.open, presentationKey, workspaceView.presentationDraftId]),
    );
    const fieldEditBlocked = $derived(
        blockedFieldDraft?.id === workspaceView.draft?.id && blockedFieldDraft?.blocked === true,
    );
    const connectionBlocked = $derived(!!workspaceView.cardReviewBlockedReason);
    const accountReady = $derived(
        $identityStateStore.kind === "logged_in" &&
            $currentUserIdStore !== ANON_USER_ID &&
            workspaceView.account === $currentUserIdStore,
    );
    const selected = $derived(workspaceView.activeCardApp);
    const selectedAction = $derived(
        selected?.actions.find((action) => action.definition.name === workspaceView.actionId),
    );
    const unavailableActionFields = $derived.by(() => {
        if (selectedAction) return undefined;
        try {
            return formatLocalDraftJson(JSON.parse(workspaceView.editorJson));
        } catch {
            return "Invalid saved fields. This card cannot be sent.";
        }
    });
    const editable = $derived(
        !connectionBlocked &&
            (workspaceView.draft?.status === "draft" || workspaceView.draft?.status === "reviewed"),
    );
    const delivery = $derived(
        $localAppDeliveryStatus?.importId === workspaceView.draft?.approval?.request.idempotencyKey
            ? $localAppDeliveryStatus
            : undefined,
    );
    const pairing = $derived(
        $nativeAppPairing?.importId === workspaceView.draft?.approval?.request.idempotencyKey
            ? $nativeAppPairing
            : undefined,
    );
    const consumed = $derived(showDraft && workspaceView.draft?.status === "delivered" && !pairing);
    const confirmDisabled = $derived(
        !accountReady ||
            !showDraft ||
            !editable ||
            workspaceView.busy ||
            workspaceView.draftLoading ||
            fieldEditBlocked ||
            connectionBlocked ||
            (!!selectedAction?.definition.card.disclosure && !acknowledged),
    );
    const consentScope = $derived(
        JSON.stringify([
            accountReady,
            workspaceView.open,
            presentationKey,
            workspaceView.draft?.id,
            workspaceView.draft?.revision,
            workspaceView.draft?.status,
            delivery?.status,
        ]),
    );

    $effect(() => {
        const scope = revealScope;
        let current = true;
        void tick().then(() => {
            if (
                current &&
                scope === revealScope &&
                workspaceView.open &&
                inline &&
                anchor?.isConnected
            )
                anchor.scrollIntoView({ block: "start", inline: "nearest" });
        });
        return () => {
            current = false;
        };
    });
    $effect(() => {
        consentScope;
        acknowledged = false;
        retryConfirmed = false;
    });
    $effect(() => {
        errorScope;
        confirmationFailed = false;
    });
    $effect(() => {
        const kind = $identityStateStore.kind;
        const account = $currentUserIdStore;
        if (kind === "logged_in" && account !== ANON_USER_ID) {
            workspace.setAccount(account, client.privateAppStorageBackend?.());
            workspace.setClient(client);
        } else if (kind === "anon" || kind === "registering") workspace.setAccount(undefined);
    });
    $effect(() => {
        client.onLogout(async () => workspace.setAccount(undefined));
    });
    $effect(() => {
        workspace.setConnectAppSetup(connectLocalAppSetup);
        workspace.configureDirectory(client.appDirectoryUrl?.());
    });
    function closeCard() {
        acknowledged = false;
        retryConfirmed = false;
        workspace.close();
    }
    function cancelCard(event: MouseEvent) {
        event.stopPropagation();
        workspace.discard();
        closeCard();
    }
    function updateFields(editorJson: string) {
        acknowledged = false;
        workspace.edit(editorJson, workspaceView.recipient);
    }
    function blockFieldEdit(blocked: boolean) {
        blockedFieldDraft = { id: workspaceView.draft?.id, blocked };
        workspace.setFieldEditBlocked(blocked);
        if (blocked) {
            acknowledged = false;
            retryConfirmed = false;
        }
    }
    function confirmCard(event: MouseEvent) {
        event.stopPropagation();
        if (confirmDisabled || !workspaceView.open) return;
        const draftId = workspaceView.draft?.id;
        // This explicit click is the only initial send path. Validate the CURRENT fields,
        // then confirm their new approval synchronously to preserve the browser gesture.
        if (!workspace.review()) {
            confirmationFailed = true;
            return;
        }
        confirmationFailed = false;
        const reviewed = workspace.state.draft;
        if (
            reviewed &&
            reviewed.id === draftId &&
            reviewed.status === "reviewed" &&
            reviewed.approval
        )
            void workspace.confirm(reviewed.approval.approvalId);
    }
    function retryCard(event: MouseEvent) {
        event.stopPropagation();
        if (
            !retryConfirmed ||
            !accountReady ||
            !workspaceView.open ||
            workspaceView.busy ||
            workspaceView.draftLoading ||
            fieldEditBlocked ||
            connectionBlocked ||
            delivery?.status === "saved"
        )
            return;
        const draftId = workspaceView.draft?.id;
        if (!workspaceView.draft?.approval && !workspace.review()) return;
        const reviewed = workspace.state.draft;
        retryConfirmed = false;
        if (reviewed?.id !== draftId || !reviewed?.approval) return;
        if (reviewed.status === "uncertain")
            void workspace.retryUncertain(reviewed.approval.approvalId);
        else if (reviewed.status === "delivered")
            void workspace.reopenDelivered(reviewed.approval.approvalId);
    }
    onDestroy(() => workspace.clear());
</script>

{#if client.clientOnlyApps() && accountReady && (workspaceView.open || fieldEditBlocked)}
    <!-- One live editor: virtualization/closing must not replace a pending invalid edit. -->
    <LocalAppCardSurface target={anchor} {inline} open={workspaceView.open} onClose={closeCard}>
        <div
            class="local-card"
            role={inline ? "region" : "dialog"}
            tabindex="-1"
            aria-modal={inline ? undefined : true}
            aria-label="Local app card"
            aria-busy={workspaceView.busy || workspaceView.draftLoading}
        >
            {#key showDraft ? workspaceView.draft?.id : "processing"}
                <ActionCardLayout
                    title={showDraft
                        ? (selectedAction?.definition.card.title ?? "App action")
                        : "App action"}
                    wide={selectedAction?.draftView !== undefined}
                    {consumed}
                    status={delivery?.status === "saved" ? "saved" : "sent"}
                >
                    {#snippet identity()}
                        <AiAppIcon size="1.5rem" />
                        <div class="app-identity-text">
                            <span class="app-name">{selected?.name ?? "App action"}</span>
                        </div>
                    {/snippet}
                    {#snippet children()}
                        {#if proposing}
                            <div class="card-loading" role="status">{workspaceView.message}</div>
                            {#if workspaceView.phase}<div class="card-loading">
                                    {workspaceView.phase.replaceAll("_", " ")}
                                </div>{/if}
                        {:else if showDraft && workspaceView.draft}
                            <div class="card-url" title={workspaceView.draft.target.destination}>
                                {workspaceView.draft.target.destination}
                            </div>
                            {#if selectedAction}
                                <section
                                    aria-label={fieldEditBlocked
                                        ? undefined
                                        : "App-declared draft preview"}
                                >
                                    <PrivateAppDraftFields
                                        showTitle={false}
                                        showDisclosure={false}
                                        compact
                                        compactDetails
                                        action={selectedAction}
                                        editorJson={workspaceView.editorJson}
                                        view={selectedAction.draftView}
                                        viewTheme={$currentTheme.mode}
                                        reviewing={false}
                                        readOnly={!editable}
                                        disabled={!editable || workspaceView.busy}
                                        onchange={updateFields}
                                        onblocked={blockFieldEdit}
                                        onfieldedit={(item, field, value) =>
                                            workspace.editDraftField(item, field, value)}
                                        onchoiceedit={(item, field, value) =>
                                            workspace.selectDraftChoice(item, field, value)}
                                    >
                                        {#snippet detailsActions()}
                                            {#if !editable}
                                                <button
                                                    class="cancel"
                                                    type="button"
                                                    disabled={workspaceView.busy ||
                                                        workspaceView.draftLoading}
                                                    onclick={cancelCard}
                                                    >Remove from this device</button
                                                >
                                            {/if}
                                        {/snippet}
                                    </PrivateAppDraftFields>
                                </section>
                            {:else}
                                <details class="payload-details">
                                    <summary>Details</summary>
                                    <pre
                                        aria-label="Complete canonical outgoing values">{unavailableActionFields}</pre>
                                    <button
                                        class="cancel"
                                        type="button"
                                        disabled={workspaceView.busy || workspaceView.draftLoading}
                                        onclick={cancelCard}>Remove from this device</button
                                    >
                                </details>
                            {/if}
                            {#if connectionBlocked}<div
                                    class="card-load-error"
                                    role="status"
                                    aria-label="Saved card connection required"
                                >
                                    {workspaceView.cardReviewBlockedReason}
                                </div>{/if}
                            {#if fieldEditBlocked}<div class="card-load-error" role="status">
                                    Correct the incomplete field before sending. No previous payload
                                    will be sent.
                                </div>{/if}
                            {#if editable}
                                <div class="host-approval" role="group" aria-label="Card actions">
                                    <span class="handoff-notice"
                                        >Send these fields encrypted to {selected?.name ??
                                            "the app"}; review and save there.</span
                                    >
                                    {#if workspaceView.recipient}<span class="handoff-notice"
                                            >{workspaceView.recipient}</span
                                        >{/if}
                                    {#if selectedAction?.definition.card.disclosure}
                                        <label class="disclosure"
                                            ><input
                                                type="checkbox"
                                                bind:checked={acknowledged}
                                                disabled={workspaceView.busy}
                                            /><span
                                                >{selectedAction.definition.card.disclosure}</span
                                            ></label
                                        >
                                    {/if}
                                    <div class="actions">
                                        <button
                                            class="cancel"
                                            type="button"
                                            disabled={workspaceView.busy}
                                            onclick={cancelCard}
                                            >{selectedAction?.definition.card.cancelLabel ??
                                                "Cancel"}</button
                                        >
                                        <button
                                            class="confirm"
                                            type="button"
                                            disabled={confirmDisabled}
                                            onclick={confirmCard}
                                            title="Send the displayed fields encrypted to the receiving app"
                                            >{selectedAction?.definition.card.confirmLabel ??
                                                "Send to app"}</button
                                        >
                                    </div>
                                </div>
                            {:else if !connectionBlocked && (workspaceView.draft.status === "uncertain" || workspaceView.draft.status === "delivered") && delivery?.status !== "saved"}
                                <div class="host-approval">
                                    <label class="disclosure"
                                        ><input
                                            type="checkbox"
                                            bind:checked={retryConfirmed}
                                            disabled={workspaceView.busy}
                                        /><span
                                            >I checked the receiving app. Reopen this same request
                                            and import ID; it may already have been saved.</span
                                        ></label
                                    >
                                    <div class="actions">
                                        <button
                                            class="confirm"
                                            type="button"
                                            disabled={!retryConfirmed ||
                                                workspaceView.busy ||
                                                workspaceView.draftLoading ||
                                                fieldEditBlocked}
                                            onclick={retryCard}>Reopen in app</button
                                        >
                                    </div>
                                </div>
                            {/if}
                            {#if pairing && client.isNativeApp()}
                                <section class="pairing" aria-label="Pair local browser handoff">
                                    <p>Open the reviewed draft in your browser</p>
                                    <p>{pairing.url}</p>
                                    <code class="pairing-code">{pairing.pairingCode}</code>
                                    <p>
                                        One-use code. Expires at {new Date(
                                            pairing.expiresAtMs,
                                        ).toLocaleTimeString()}.
                                    </p>
                                    <div class="actions">
                                        <button
                                            type="button"
                                            onclick={() =>
                                                void nativeAppDelivery.copyCode(pairing.importId)}
                                            >Copy pairing code</button
                                        ><button
                                            type="button"
                                            onclick={() =>
                                                void nativeAppDelivery.openBrowser(
                                                    pairing.importId,
                                                )}>Open local browser</button
                                        >
                                    </div>
                                    {#if pairing.message}<p role="status">{pairing.message}</p>{/if}
                                </section>
                            {/if}
                            {#if workspaceView.draft.status !== "draft" || connectionBlocked || confirmationFailed}
                                <div class="card-loading" role="status">
                                    {workspaceView.message}
                                </div>
                            {/if}
                        {:else}<div class="card-loading" role="status">
                                {workspaceView.message}
                            </div>{/if}
                    {/snippet}
                    {#snippet actions()}
                        {#if proposing}<button class="cancel" type="button" onclick={cancelCard}
                                >Cancel</button
                            >
                        {:else if !showDraft || connectionBlocked}<button
                                class="cancel"
                                type="button"
                                onclick={closeCard}>Close</button
                            >{/if}
                    {/snippet}
                </ActionCardLayout>
            {/key}
        </div>
    </LocalAppCardSurface>
{/if}

<style>
    .local-card {
        max-width: 100%;
        min-width: 0;
    }
    .local-card[role="dialog"] {
        max-height: calc(100dvh - 2rem);
        overflow-y: auto;
    }
    .handoff-notice {
        font-size: 0.75em;
        overflow-wrap: anywhere;
    }
    section {
        min-width: 0;
    }
    .payload-details {
        color: var(--txt, #1b1b1b);
        background: var(--bg, #fff);
        font-size: 0.75em;
    }
    .payload-details summary {
        cursor: pointer;
    }
    .payload-details pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .pairing {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 0.8em;
    }
    .pairing p {
        margin: 0;
        overflow-wrap: anywhere;
    }
    .pairing-code {
        user-select: text;
        overflow-wrap: anywhere;
    }
</style>
