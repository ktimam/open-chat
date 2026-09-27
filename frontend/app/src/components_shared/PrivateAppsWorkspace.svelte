<script lang="ts">
    import { onDestroy } from "svelte";
    import { currentUserIdStore, identityStateStore, type OpenChat } from "@client";
    import { ANON_USER_ID } from "@shared";
    import { privateAppWorkspace as workspace, privateAppWorkspaceState } from "../utils/privateAppWorkspace";
    import { localAppDeliveryStatus } from "../utils/localAppRelayDelivery";
    import { nativeAppDelivery, nativeAppPairing } from "../utils/nativeAppDelivery";

    let { client }: { client: OpenChat } = $props();
    let confirmed = $state(false);
    let retryConfirmed = $state(false);
    const workspaceView = $derived($privateAppWorkspaceState);
    const accountReady = $derived($identityStateStore.kind === "logged_in" && $currentUserIdStore !== ANON_USER_ID && workspaceView.account === $currentUserIdStore);
    const selected = $derived(workspaceView.catalog?.apps.find(app => app.id === workspaceView.appId));
    const locked = $derived(workspaceView.busy || workspaceView.draft !== undefined);
    const editable = $derived(workspaceView.draft?.status === "draft" || workspaceView.draft?.status === "reviewed");
    const delivery = $derived($localAppDeliveryStatus?.importId === workspaceView.draft?.approval?.request.idempotencyKey ? $localAppDeliveryStatus : undefined);
    const pairing = $derived($nativeAppPairing?.importId === workspaceView.draft?.approval?.request.idempotencyKey ? $nativeAppPairing : undefined);

    $effect(() => { workspaceView.draft?.revision; confirmed = false; });
    $effect(() => { workspaceView.draft?.status; retryConfirmed = false; });
    $effect(() => {
        const kind = $identityStateStore.kind;
        const account = $currentUserIdStore;
        // Authentication briefly clears currentUser before loading the same account again.
        // Keep drafts hidden but intact during that transition; actual logout clears them.
        if (kind === "logged_in" && account !== ANON_USER_ID) workspace.setAccount(account);
        else if (kind === "anon" || kind === "registering") workspace.setAccount(undefined);
    });
    $effect(() => { client.onLogout(async () => workspace.setAccount(undefined)); });

    async function importFile(event: Event, processor: boolean) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        const context = workspace.contextVersion;
        try {
            if (file.size > 1024 * 1024) throw new Error("File too large");
            const text = await file.text();
            if (context !== workspace.contextVersion) return;
            if (processor) await workspace.importProcessor(text);
            else workspace.importCatalog(text);
        } catch { workspace.reportImportFailure(); }
    }
    function selectAction(event: Event) {
        const actionId = (event.currentTarget as HTMLSelectElement).value;
        if (selected) workspace.select(selected.id, actionId);
    }
    function updateJson(event: Event) {
        confirmed = false;
        workspace.edit((event.currentTarget as HTMLTextAreaElement).value, workspaceView.recipient);
    }
    function updateRecipient(event: Event) {
        confirmed = false;
        workspace.edit(workspaceView.editorJson, (event.currentTarget as HTMLInputElement).value);
    }
    onDestroy(() => workspace.clear());
</script>

{#if client.clientOnlyApps() && accountReady && workspaceView.open}
        <section class="workspace" aria-label="Private app workspace" aria-busy={workspaceView.busy}>
            <header><h2>Private app draft</h2><button type="button" onclick={() => workspace.close()}>Close</button></header>
            <p>Local prototype: imports and drafts exist only in this page's memory. Reloading or changing account discards them. Nothing is posted to the chat.</p>
            <div class="setup">
                <label>Import app catalog (JSON, up to 1 MB)
                    <input type="file" accept=".json,application/json" disabled={locked} onchange={event => importFile(event, false)} />
                </label>
                {#if workspaceView.catalog}
                    <label>App
                        <select value={workspaceView.appId ?? ""} disabled={locked} onchange={event => workspace.chooseApp(event.currentTarget.value)}>
                            <option value="">Choose an app</option>
                            {#each workspaceView.catalog.apps as app}<option value={app.id}>{app.name}</option>{/each}
                        </select>
                    </label>
                    {#if selected}
                        <p>{selected.description}</p>
                        <p><strong>Destination declared by app:</strong> <span class="destination">{selected.destination}</span></p>
                        <p><strong>Recipient declared by app:</strong> {selected.recipientLabel ?? "Not specified; choose in the receiving app."} This label is not proof of the receiving account.</p>
                        <label>Action
                            <select value={workspaceView.appId === selected.id ? (workspaceView.actionId ?? "") : ""} disabled={locked} onchange={selectAction}>
                                <option value="">Choose an action</option>
                                {#each selected.actions as action}<option value={action.definition.name}>{action.definition.name} — {action.definition.description}</option>{/each}
                            </select>
                        </label>
                        {#if selected.processor}
                            <label>Import matching local processor (JavaScript, up to 1 MB)
                                <input type="file" accept=".js,.mjs,text/javascript,application/javascript" disabled={locked || workspaceView.appId !== selected.id || !workspaceView.actionId} onchange={event => importFile(event, true)} />
                            </label>
                            <p class="small">SHA-256: <code>{selected.processor.sha256}</code>. {workspaceView.appId === selected.id && workspaceView.processorReady ? "Verified imported file." : "No matching processor imported for this selection."}</p>
                        {/if}
                    {/if}
                {/if}
            </div>
            <p role="status">{workspaceView.message}</p>
            {#if workspaceView.phase}<p>Local processing: {workspaceView.phase.replaceAll("_", " ")}</p>{/if}
            {#if workspaceView.draft}
                <div class="draft">
                    <h3>Edit the complete outgoing payload</h3>
                    <p><strong>Exact destination:</strong> <span class="destination">{workspaceView.draft.target.destination}</span></p>
                    <label>Recipient review label (confirm the actual account in the receiving app)
                        <input type="text" value={workspaceView.recipient} disabled={!editable || workspaceView.busy} oninput={updateRecipient} />
                    </label>
                    <label>Complete payload (JSON)
                        <textarea spellcheck={false} value={workspaceView.editorJson} disabled={!editable || workspaceView.busy} oninput={updateJson}></textarea>
                    </label>
                    {#if editable}<button type="button" disabled={workspaceView.busy} onclick={() => workspace.review()}>Review full request</button>{/if}
                    {#if workspaceView.draft.approval}
                        <h3>Exact request to be handed off</h3>
                        <pre>{workspaceView.draft.approval.summary}</pre>
                        {#if workspaceView.draft.status === "reviewed"}
                            <label class="confirmation"><input type="checkbox" bind:checked={confirmed} disabled={workspaceView.busy} /><span>I reviewed every field and the destination. Send exactly this request outside OpenChat.</span></label>
                            <button class="confirm" type="button" disabled={!confirmed || workspaceView.busy} onclick={() => { const id = workspaceView.draft?.approval?.approvalId; if (confirmed && id) void workspace.confirm(id); }}>Send reviewed request</button>
                        {/if}
                    {/if}
                    {#if pairing && client.isNativeApp() && client.existingAccountOnly()}
                        <section class="pairing" aria-label="Pair local browser handoff">
                            <h3>Open the reviewed draft in your browser</h3>
                            <p>This one-use code unlocks only the request you approved above. Enter it only on this exact local browser page, then review the destination there.</p>
                            <p><strong>Local browser page:</strong> <span class="destination">{pairing.url}</span></p>
                            <p><strong>One-use pairing code:</strong> <code class="pairing-code">{pairing.pairingCode}</code></p>
                            <p class="small">Expires at {new Date(pairing.expiresAtMs).toLocaleTimeString()}. The code is not included in the browser URL. Copying puts it on your device clipboard.</p>
                            <div class="pairing-actions">
                                <button type="button" onclick={() => void nativeAppDelivery.copyCode(pairing.importId)}>Copy pairing code</button>
                                <button type="button" onclick={() => void nativeAppDelivery.openBrowser(pairing.importId)}>Open local browser</button>
                            </div>
                            {#if pairing.message}<p role="status">{pairing.message}</p>{/if}
                        </section>
                    {/if}
                    {#if workspaceView.draft.status === "uncertain" && workspaceView.draft.approval}
                        <label class="confirmation"><input type="checkbox" bind:checked={retryConfirmed} disabled={workspaceView.busy} /><span>I checked the receiving app. Retry exactly this reviewed request with the same import ID; a prior delivery may already have occurred.</span></label>
                        <button type="button" disabled={!retryConfirmed || workspaceView.busy} onclick={() => { const id = workspaceView.draft?.approval?.approvalId; if (retryConfirmed && id) { retryConfirmed = false; void workspace.retryUncertain(id); } }}>Retry the same reviewed request</button>
                    {/if}
                    <p class="small">Receiving an app handoff does not save an entry. Finish review and save in the app. Uncertain deliveries are never retried automatically.</p>
                    {#if delivery}
                        <p role="status">{delivery.status === "saved" ? "The receiving app reports that this request was saved."
                            : delivery.status === "rejected" ? "The receiving app rejected or cancelled this request."
                            : delivery.status === "received" ? "The receiving app has the request; finish its review before saving."
                            : delivery.status === "opening" ? "Opening the approved handoff…"
                            : "The handoff outcome is unknown; check the receiving app."}</p>
                    {/if}
                </div>
            {/if}
            {#if workspaceView.draft || workspaceView.busy}<button type="button" onclick={() => workspace.discard()}>{workspaceView.busy ? "Cancel / discard local draft" : "Discard local draft"}</button>{/if}
        </section>
{/if}

<style>
    .workspace { position: fixed; inset: 1rem 1rem 1rem auto; z-index: 1100; width: min(42rem, calc(100vw - 2rem)); box-sizing: border-box; overflow-y: auto; background: var(--bg, #fff); color: var(--txt, #1b1b1b); border: 1px solid #888; border-radius: 1rem; padding: 1.25rem; box-shadow: 0 0.5rem 2rem #0004; display: flex; flex-direction: column; gap: 1rem; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    h2, h3, p { margin: 0; }
    p, label { line-height: 1.5; overflow-wrap: anywhere; }
    .setup, .draft { display: flex; flex-direction: column; gap: 1rem; }
    .draft { padding-top: 1rem; border-top: 1px solid #888; }
    label { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
    button, input, select, textarea { font: inherit; box-sizing: border-box; max-width: 100%; min-width: 0; }
    button { padding: 0.65rem 0.8rem; border-radius: 0.5rem; border: 1px solid #888; cursor: pointer; }
    input[type="text"], select, textarea { width: 100%; padding: 0.65rem; border: 1px solid #888; border-radius: 0.5rem; }
    textarea { min-height: 15rem; resize: vertical; font-family: monospace; }
    button:disabled { opacity: 0.5; cursor: default; }
    .destination, code { overflow-wrap: anywhere; word-break: break-word; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 0.75rem; border: 1px solid #888; border-radius: 0.5rem; max-height: 28rem; overflow: auto; }
    .confirmation { flex-direction: row; align-items: flex-start; gap: 0.75rem; }
    .confirmation input { flex: 0 0 auto; margin-top: 0.4rem; }
    .confirm { background: #292345; color: white; }
    .small { font-size: 0.875rem; }
    .pairing { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; border: 1px solid #888; border-radius: 0.5rem; }
    .pairing-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .pairing-code { user-select: text; letter-spacing: 0.1em; }
</style>
