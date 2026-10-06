<script lang="ts">
    import { onDestroy, untrack } from "svelte";
    import {
        privateAppWorkspace as workspace,
        privateAppWorkspaceState,
    } from "@utils/privateAppWorkspace";
    import { localAppDirectoryPresentation } from "@utils/localAppDirectoryPresentation";
    import { navigateToMainApps } from "@utils/mainAppsNavigation";
    import AiAppCard from "../components/home/communities/explore/AiAppCard.svelte";
    import AiAppModal from "../components/home/AiAppModal.svelte";
    import MobileAiAppCard from "../components_mobile/home/communities/explore/AiAppCard.svelte";
    import AiAppSheet from "../components_mobile/home/communities/explore/AiAppSheet.svelte";
    import Button from "../components/Button.svelte";
    import { CommonButton } from "component-lib";

    interface Props {
        mobile?: boolean;
        searchTerm?: string;
        connectedOnly?: boolean;
    }
    let { mobile = false, searchTerm = "", connectedOnly = false }: Props = $props();
    const workspaceView = $derived($privateAppWorkspaceState);
    const entries = $derived(
        localAppDirectoryPresentation(
            workspaceView.directory,
            workspaceView.catalog,
            workspaceView.appUpdates,
            workspaceView.disabledAppIds,
        ),
    );
    const matches = $derived(
        entries.filter(
            (app) =>
                (!connectedOnly || app.connected) &&
                `${app.manifest.name} ${app.manifest.description}`
                    .toLocaleLowerCase()
                    .includes(searchTerm.trim().toLocaleLowerCase()),
        ),
    );
    let selectedId = $state<string>();
    const selected = $derived(entries.find((app) => app.id === selectedId));
    const busy = $derived(
        !workspaceView.account ||
            workspaceView.busy ||
            workspaceView.setupLoading ||
            workspaceView.draftLoading ||
            workspaceView.directoryLoading,
    );
    let connecting = $state(false);
    let connectionMessage = $state("");
    let operation = 0;
    let refreshScope: string | undefined;
    let accountScope: string | undefined;

    // The headless host may finish restoring account/setup after this view mounts.
    $effect(() => {
        const scope = `${workspaceView.account ?? ""}\n${workspaceView.backend ?? ""}`;
        if (scope !== accountScope) {
            accountScope = scope;
            refreshScope = undefined;
            ++operation;
            selectedId = undefined;
            connecting = false;
            connectionMessage = "";
        }
        if (!workspaceView.account || !workspaceView.directorySource || workspaceView.setupLoading)
            return;
        const next = `${scope}\n${workspaceView.directorySource}`;
        if (next !== refreshScope) {
            refreshScope = next;
            untrack(() => {
                void workspace.refreshDirectory();
            });
        }
    });

    function select(id: string) {
        selectedId = id;
        connectionMessage = "";
    }
    function cancelConnection() {
        if (!connecting) return;
        ++operation;
        workspace.cancelConnection();
        connecting = false;
        connectionMessage = "Connection cancelled. Previously connected setup is unchanged.";
    }
    function dismiss() {
        cancelConnection();
        selectedId = undefined;
    }
    async function connect() {
        if (!selected || busy || connecting || !selected.setupOrigin) return;
        const epoch = ++operation;
        const id = selected.id;
        connecting = true;
        connectionMessage =
            "Opening the app's connection screen. Confirm your selected setup there.";
        let ok = false;
        try {
            ok = await workspace.connectApp(id);
        } catch {
            /* Show fixed host text only. */
        }
        if (epoch !== operation) return;
        connecting = false;
        connectionMessage = ok
            ? "Connected. Enable this app in a chat's Apps settings to propose a message."
            : "Connection could not be completed. Previously connected setup is unchanged. Try Connect again.";
    }
    async function disconnect(): Promise<boolean> {
        if (!selected || busy) return false;
        const epoch = ++operation;
        const id = selected.id;
        const ok = await workspace.disconnectApp(id);
        if (epoch !== operation) return false;
        if (ok)
            connectionMessage =
                "Disconnected. Saved cards remain on this device and cannot be sent until you reconnect and review them.";
        return ok;
    }
    onDestroy(() => {
        cancelConnection();
        ++operation;
    });
</script>

<div class="app-directory">
    {#if workspaceView.draftStorageError}<p role="alert">{workspaceView.draftStorageError}</p>{/if}
    <div class="directory-actions">
        {#if mobile}
            <CommonButton
                size={"small_text"}
                disabled={busy}
                loading={workspaceView.directoryLoading}
                onClick={() => {
                    void workspace.refreshDirectory();
                }}>Refresh apps</CommonButton
            >
            {#if connectedOnly}<CommonButton size={"small_text"} onClick={navigateToMainApps}
                    >Discover apps</CommonButton
                >{/if}
        {:else}
            <Button
                small
                hollow
                disabled={busy}
                loading={workspaceView.directoryLoading}
                onClick={() => {
                    void workspace.refreshDirectory();
                }}>Refresh apps</Button
            >
            {#if connectedOnly}<Button small hollow onClick={navigateToMainApps}
                    >Discover apps</Button
                >{/if}
        {/if}
    </div>
    {#if !workspaceView.account}<p role="status">Sign in to connect apps.</p>
    {:else if workspaceView.directoryLoading}<p role="status">Loading apps…</p>
    {:else if workspaceView.directoryStatus}<p role="status">{workspaceView.directoryStatus}</p>
    {:else if !workspaceView.directory}<p role="status">
            The app directory is not available. Try Refresh apps.
        </p>{/if}
    {#each matches as app (app.id)}
        {#if mobile}<MobileAiAppCard
                {app}
                connected={app.connected}
                onSelect={() => select(app.id)}
            />
        {:else}<AiAppCard {app} connected={app.connected} onSelect={() => select(app.id)} />{/if}
    {:else}
        {#if !workspaceView.directoryLoading && workspaceView.account}<p>
                {connectedOnly ? "No connected apps yet." : "No matching apps."}
            </p>{/if}
    {/each}
</div>

{#if selected}
    {#if mobile}
        <AiAppSheet
            app={selected}
            connected={selected.connected}
            {busy}
            {connectionMessage}
            onDismiss={dismiss}
            onConnect={connect}
            onDisconnect={disconnect}
            onDisconnected={() => {}}
            onCancelConnection={connecting ? cancelConnection : undefined}
        />
    {:else}
        <AiAppModal
            app={selected}
            connected={selected.connected}
            {busy}
            {connectionMessage}
            onDismiss={dismiss}
            onConnect={connect}
            onDisconnect={disconnect}
            onDisconnected={() => {}}
            onCancelConnection={connecting ? cancelConnection : undefined}
        />
    {/if}
{/if}

<style lang="scss">
    .app-directory {
        width: 100%;
        min-width: 0;
    }
    .directory-actions {
        display: flex;
        gap: $sp3;
        flex-wrap: wrap;
        margin-bottom: $sp3;
    }
    p {
        color: var(--txt-light, var(--text-secondary));
        overflow-wrap: anywhere;
    }
</style>
