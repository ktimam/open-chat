<script lang="ts">
    import { onDestroy } from "svelte";
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
    import { localAppSourceNavigation } from "../utils/localAppSourceNavigation";
    import { navigate } from "@utils/navigation";
    import OverlayWrapper from "../components/portal/OverlayWrapper.svelte";

    let { client }: { client: OpenChat } = $props();
    let confirmed = $state(false);
    let retryConfirmed = $state(false);
    let blockedFieldDraft = $state<{ id: string | undefined; blocked: boolean }>();
    let fieldEditorGeneration = $state(0);
    const workspaceView = $derived($privateAppWorkspaceState);
    const fieldDraftScope = $derived(workspaceView.draft?.id);
    const fieldEditBlocked = $derived(
        blockedFieldDraft?.id === fieldDraftScope && blockedFieldDraft?.blocked === true,
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
    const editable = $derived(
        !connectionBlocked &&
            (workspaceView.draft?.status === "draft" || workspaceView.draft?.status === "reviewed"),
    );
    const selectedSource = $derived(
        localAppSourceNavigation(
            workspaceView.draft ? workspaceView.cardSources[workspaceView.draft.id] : undefined,
        ),
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
    // Polling may replace a status object without changing its meaning. Reset consent only
    // when this primitive scope changes, not on every identical native receipt poll.
    const retryConsentScope = $derived(
        JSON.stringify([
            accountReady,
            workspaceView.open,
            workspaceView.draft?.id,
            workspaceView.draft?.approval?.approvalId,
            workspaceView.draft?.status,
            delivery?.status,
        ]),
    );

    $effect(() => {
        workspaceView.draft?.id;
        workspaceView.draft?.revision;
        workspaceView.open;
        confirmed = false;
    });
    $effect(() => {
        retryConsentScope;
        retryConfirmed = false;
    });
    $effect(() => {
        const kind = $identityStateStore.kind;
        const account = $currentUserIdStore;
        // Authentication briefly clears currentUser before loading the same account again.
        // Keep drafts hidden but intact during that transition; actual logout clears them.
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
        confirmed = false;
        retryConfirmed = false;
        workspace.close();
    }
    function updateJson(event: Event) {
        // An explicit advanced edit also replaces any oversized pending field value,
        // including when the user restores the byte-identical canonical JSON.
        fieldEditorGeneration += 1;
        blockedFieldDraft = undefined;
        updateFields((event.currentTarget as HTMLTextAreaElement).value);
    }
    function updateFields(editorJson: string) {
        confirmed = false;
        workspace.edit(editorJson, workspaceView.recipient);
    }
    function blockFieldEdit(blocked: boolean) {
        blockedFieldDraft = { id: workspaceView.draft?.id, blocked };
        workspace.setFieldEditBlocked(blocked);
        if (blocked) {
            confirmed = false;
            retryConfirmed = false;
            // An unrepresentable edit must not leave the previous payload approved.
        }
    }
    function updateRecipient(event: Event) {
        confirmed = false;
        workspace.editRecipient((event.currentTarget as HTMLInputElement).value);
    }
    function viewSource() {
        if (
            !accountReady ||
            !selectedSource ||
            workspaceView.busy ||
            workspaceView.draftLoading ||
            fieldEditBlocked
        )
            return;
        const route = selectedSource.route;
        confirmed = false;
        retryConfirmed = false;
        workspace.invalidateReview();
        workspace.close();
        navigate(route);
    }
    onDestroy(() => workspace.clear());
</script>

{#if client.clientOnlyApps() && accountReady && (workspaceView.open || fieldEditBlocked)}
    <!-- Keep invalid pending editor text mounted while closed; it must not revert to a stale payload. -->
    <div hidden={!workspaceView.open} aria-label="Local app cards">
        <OverlayWrapper dismissible={workspaceView.open} onClose={closeCard}>
            <div
                class="local-app-card"
                role="dialog"
                tabindex="-1"
                aria-modal="true"
                aria-label="Local app card"
                aria-busy={workspaceView.busy || workspaceView.draftLoading}
            >
                <header>
                    <h2>
                        {workspaceView.draft
                            ? (selectedAction?.definition.card.title ?? "Review app draft")
                            : "App action"}
                    </h2>
                    <button type="button" onclick={closeCard}>Close</button>
                </header>
                {#if workspaceView.draft && workspaceView.cards.length > 1}
                    <nav aria-label="Saved private cards on this device" class="card-selector">
                        <p class="small">
                            Saved locally, not posted in chat. Select a card to review it.
                        </p>
                        {#each workspaceView.cards as card, index (card.id)}
                            {@const source = localAppSourceNavigation(
                                workspaceView.cardSources[card.id],
                            )}
                            <button
                                type="button"
                                aria-pressed={workspaceView.draft?.id === card.id}
                                disabled={workspaceView.busy ||
                                    workspaceView.draftLoading ||
                                    fieldEditBlocked}
                                onclick={() => workspace.selectCard(card.id)}
                            >
                                <span>Card {index + 1} · {card.status}</span>
                                {#if source}<span class="small source-label">{source.label}</span
                                    >{:else if workspaceView.cardSources[card.id]}<span
                                        class="small source-label"
                                        >Propose again from the original message to restore its link</span
                                    >{:else}<span class="small source-label"
                                        >No source message available</span
                                    >{/if}
                            </button>
                        {/each}
                    </nav>
                {/if}
                {#if selectedSource}
                    <div class="card-source" aria-label="Selected card source">
                        <p class="small">{selectedSource.label}</p>
                        <button
                            type="button"
                            disabled={workspaceView.busy ||
                                workspaceView.draftLoading ||
                                fieldEditBlocked}
                            onclick={viewSource}>{selectedSource.linkLabel}</button
                        >
                    </div>
                {/if}
                <p role="status">{workspaceView.message}</p>
                {#if workspaceView.phase}<p>
                        Local processing: {workspaceView.phase.replaceAll("_", " ")}
                    </p>{/if}
                {#if workspaceView.draft}
                    <div class="draft">
                        {#if selectedAction}
                            <section
                                aria-label={fieldEditBlocked
                                    ? undefined
                                    : "App-declared draft preview"}
                                class="primary-card"
                            >
                                {#key `${workspaceView.draft.id}:${fieldEditorGeneration}`}
                                    <PrivateAppDraftFields
                                        showTitle={false}
                                        action={selectedAction}
                                        editorJson={workspaceView.editorJson}
                                        disabled={!editable || workspaceView.busy}
                                        onchange={updateFields}
                                        onblocked={blockFieldEdit}
                                        onfieldedit={(item, field, value) =>
                                            workspace.editDraftField(item, field, value)}
                                        onchoiceedit={(item, field, value) =>
                                            workspace.selectDraftChoice(item, field, value)}
                                    />
                                {/key}
                            </section>
                            {#if selectedAction.draftEditor && workspaceView.draftManualValues}
                                <p class="small">
                                    Advanced JSON keeps your explicit field values. Selecting a
                                    named choice updates its controlled fields, but does not reapply
                                    automatic defaults.
                                </p>
                            {/if}
                            {#if fieldEditBlocked}
                                <p role="status">
                                    A field edit is incomplete or invalid. Correct it before review;
                                    no previous payload can be approved or sent.
                                </p>
                            {/if}
                        {/if}
                        <h3>Review destination and recipient</h3>
                        <p>
                            <strong>Exact destination:</strong>
                            <span class="destination">{workspaceView.draft.target.destination}</span
                            >
                        </p>
                        <label
                            >Recipient review label (confirm the actual account in the receiving
                            app)
                            <input
                                type="text"
                                value={workspaceView.recipient}
                                disabled={!editable || workspaceView.busy}
                                oninput={updateRecipient}
                            />
                        </label>
                        <details class="advanced-editor">
                            <summary>Advanced: complete payload (JSON)</summary>
                            <label
                                >Complete payload (JSON)
                                <textarea
                                    aria-label="Complete payload (JSON)"
                                    spellcheck={false}
                                    value={workspaceView.editorJson}
                                    disabled={!editable || workspaceView.busy}
                                    oninput={updateJson}
                                ></textarea>
                            </label>
                        </details>
                        {#if workspaceView.cardReviewBlockedReason}
                            <p role="status" aria-label="Saved card connection required">
                                {workspaceView.cardReviewBlockedReason}
                            </p>
                        {/if}
                        {#if editable}<button
                                type="button"
                                disabled={workspaceView.busy || fieldEditBlocked}
                                onclick={() => {
                                    if (!fieldEditBlocked) workspace.review();
                                }}>Review full request</button
                            >{/if}
                        {#if (workspaceView.draft.status === "uncertain" || workspaceView.draft.status === "delivered") && !workspaceView.draft.approval}
                            <button
                                type="button"
                                disabled={workspaceView.busy ||
                                    fieldEditBlocked ||
                                    connectionBlocked}
                                onclick={() => {
                                    if (!fieldEditBlocked && !connectionBlocked) workspace.review();
                                }}
                            >
                                Review recovered request before retrying
                            </button>
                        {/if}
                        {#if workspaceView.draft.approval}
                            <details class="request-details">
                                <summary>Advanced: exact reviewed request</summary>
                                <pre>{workspaceView.draft.approval.summary}</pre>
                            </details>
                            {#if workspaceView.draft.status === "reviewed"}
                                <label class="confirmation"
                                    ><input
                                        type="checkbox"
                                        bind:checked={confirmed}
                                        disabled={workspaceView.busy}
                                    /><span
                                        >I reviewed every field and the destination. Send exactly
                                        this request outside OpenChat.</span
                                    ></label
                                >
                                <button
                                    class="confirm"
                                    type="button"
                                    aria-label="Send reviewed request"
                                    disabled={!confirmed ||
                                        workspaceView.busy ||
                                        fieldEditBlocked ||
                                        connectionBlocked}
                                    onclick={() => {
                                        const id = workspaceView.draft?.approval?.approvalId;
                                        if (
                                            confirmed &&
                                            id &&
                                            !fieldEditBlocked &&
                                            !connectionBlocked
                                        )
                                            void workspace.confirm(id);
                                    }}
                                    ><span
                                        >{selectedAction?.definition.card.confirmLabel ??
                                            "Send reviewed request"}</span
                                    ><small>Send reviewed request</small></button
                                >
                            {/if}
                        {/if}
                        {#if pairing && client.isNativeApp() && client.clientOnlyApps()}
                            <section class="pairing" aria-label="Pair local browser handoff">
                                <h3>Open the reviewed draft in your browser</h3>
                                <p>
                                    This one-use code unlocks only the request you approved above.
                                    Enter it only on this exact local browser page, then review the
                                    destination there.
                                </p>
                                <p>
                                    <strong>Local browser page:</strong>
                                    <span class="destination">{pairing.url}</span>
                                </p>
                                <p>
                                    <strong>One-use pairing code:</strong>
                                    <code class="pairing-code">{pairing.pairingCode}</code>
                                </p>
                                <p class="small">
                                    Expires at {new Date(pairing.expiresAtMs).toLocaleTimeString()}.
                                    The code is not included in the browser URL. Copying puts it on
                                    your device clipboard.
                                </p>
                                <div class="pairing-actions">
                                    <button
                                        type="button"
                                        onclick={() =>
                                            void nativeAppDelivery.copyCode(pairing.importId)}
                                        >Copy pairing code</button
                                    >
                                    <button
                                        type="button"
                                        onclick={() =>
                                            void nativeAppDelivery.openBrowser(pairing.importId)}
                                        >Open local browser</button
                                    >
                                </div>
                                {#if pairing.message}<p role="status">{pairing.message}</p>{/if}
                            </section>
                        {/if}
                        {#if workspaceView.draft.status === "uncertain" && workspaceView.draft.approval}
                            <label class="confirmation"
                                ><input
                                    type="checkbox"
                                    bind:checked={retryConfirmed}
                                    disabled={workspaceView.busy}
                                /><span
                                    >I checked the receiving app. Retry exactly this reviewed
                                    request with the same import ID; a prior delivery may already
                                    have occurred.</span
                                ></label
                            >
                            <button
                                type="button"
                                disabled={!retryConfirmed ||
                                    workspaceView.busy ||
                                    fieldEditBlocked ||
                                    connectionBlocked}
                                onclick={() => {
                                    const id = workspaceView.draft?.approval?.approvalId;
                                    if (
                                        retryConfirmed &&
                                        id &&
                                        !fieldEditBlocked &&
                                        !connectionBlocked
                                    ) {
                                        retryConfirmed = false;
                                        void workspace.retryUncertain(id);
                                    }
                                }}>Retry the same reviewed request</button
                            >
                        {/if}
                        {#if workspaceView.draft.status === "delivered" && workspaceView.draft.approval && delivery?.status !== "saved"}
                            <label class="confirmation"
                                ><input
                                    type="checkbox"
                                    bind:checked={retryConfirmed}
                                    disabled={workspaceView.busy}
                                /><span
                                    >I checked the receiving app; this request may already have been
                                    saved. Reopen the same reviewed request and import ID, using the
                                    same receiving account and destination. Choosing another account
                                    or destination may create a duplicate.</span
                                ></label
                            >
                            <button
                                type="button"
                                disabled={!retryConfirmed ||
                                    workspaceView.busy ||
                                    fieldEditBlocked ||
                                    connectionBlocked}
                                onclick={() => {
                                    const id = workspaceView.draft?.approval?.approvalId;
                                    if (
                                        retryConfirmed &&
                                        id &&
                                        !fieldEditBlocked &&
                                        !connectionBlocked &&
                                        delivery?.status !== "saved"
                                    ) {
                                        retryConfirmed = false;
                                        void workspace.reopenDelivered(id);
                                    }
                                }}>Reopen the same reviewed request</button
                            >
                        {/if}
                        <p class="small">
                            Receiving an app handoff does not save an entry. Finish review and save
                            in the app. Uncertain deliveries are never retried automatically.
                        </p>
                        {#if delivery}
                            <p role="status">
                                {delivery.status === "saved"
                                    ? "The receiving app reports that this request was saved."
                                    : delivery.status === "rejected"
                                      ? "The receiving app rejected or cancelled this request."
                                      : delivery.status === "received"
                                        ? "The receiving app has the request; finish its review before saving."
                                        : delivery.status === "opening"
                                          ? "Opening the approved handoff…"
                                          : "The handoff outcome is unknown; check the receiving app."}
                            </p>
                        {/if}
                    </div>
                {/if}
                {#if workspaceView.draft || workspaceView.busy}<button
                        type="button"
                        onclick={() => workspace.discard()}
                        >{workspaceView.busy
                            ? "Cancel / discard local draft"
                            : "Discard local draft"}</button
                    >{/if}
            </div>
        </OverlayWrapper>
    </div>
{/if}

<style>
    .local-app-card {
        width: min(42rem, calc(100vw - 2rem));
        max-height: calc(100dvh - 2rem);
        box-sizing: border-box;
        overflow-y: auto;
        background: var(--modal-bg, #fff);
        color: var(--txt, #1b1b1b);
        border: var(--modal-bd, 1px solid #888);
        border-radius: var(--modal-rd, 1rem);
        padding: 1.25rem;
        box-shadow: var(--modal-sh, 0 0.5rem 2rem #0004);
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    @media (max-width: 600px) {
        .local-app-card {
            width: 100%;
            max-height: calc(100dvh - 1rem);
            border-radius: 1rem 1rem 0 0;
        }
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
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
    .draft {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    summary {
        cursor: pointer;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    details > label {
        margin-top: 0.75rem;
    }
    .draft {
        gap: 0.75rem;
    }
    .primary-card {
        min-width: 0;
    }
    .card-selector,
    .card-source {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
    }
    .card-selector button {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        text-align: start;
    }
    .source-label {
        overflow-wrap: anywhere;
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        min-width: 0;
    }
    button,
    input,
    textarea {
        font: inherit;
        box-sizing: border-box;
        max-width: 100%;
        min-width: 0;
    }
    button {
        min-height: 44px;
        padding: 0.65rem 0.8rem;
        border-radius: 0.5rem;
        border: 1px solid #888;
        cursor: pointer;
    }
    input[type="text"],
    textarea {
        min-height: 44px;
        width: 100%;
        padding: 0.65rem;
        border: 1px solid #888;
        border-radius: 0.5rem;
    }
    textarea {
        min-height: 15rem;
        resize: vertical;
        font-family: monospace;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .destination,
    code {
        overflow-wrap: anywhere;
        word-break: break-word;
    }
    pre {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 0.75rem;
        border: 1px solid #888;
        border-radius: 0.5rem;
        max-height: 28rem;
        overflow: auto;
    }
    .confirmation {
        flex-direction: row;
        align-items: flex-start;
        gap: 0.75rem;
    }
    .confirmation input {
        flex: 0 0 auto;
        margin-top: 0.4rem;
    }
    .confirm {
        background: #292345;
        color: white;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.2rem;
    }
    .small {
        font-size: 0.875rem;
    }
    .pairing {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem;
        border: 1px solid #888;
        border-radius: 0.5rem;
    }
    .pairing-actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
    }
    .pairing-code {
        user-select: text;
        letter-spacing: 0.1em;
    }
</style>
