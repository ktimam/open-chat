<script lang="ts">
    import { currentUserIdStore, type ChatIdentifier } from "@client";
    import { chatIdentifierToString } from "@shared";
    import { navigateToMainApps } from "../utils/mainAppsNavigation";
    import { privateAppWorkspaceState } from "../utils/privateAppWorkspace";
    import { localAppChatConfiguration, localAppChatRevision } from "../utils/localAppChatState";
    let { chatId }: { chatId: ChatIdentifier } = $props();
    const chatKey = $derived(chatIdentifierToString(chatId));
    const apps = $derived($privateAppWorkspaceState.catalog?.apps ?? []);
    const revision = $derived($localAppChatRevision);
    function enabled(appId: string) {
        void revision;
        return localAppChatConfiguration.enabled($currentUserIdStore, chatKey, appId);
    }
</script>

<section class="local-apps" aria-label="Private apps for this chat">
    <h3>Private apps for this chat</h3>
    <p>
        These are your local settings only, not group-wide permissions. Suggestions inspect new
        message text locally using each connected app’s declared keywords; images are offered only
        for image-capable actions. Nothing is sent to an app until you review and confirm a handoff.
    </p>
    <button type="button" onclick={navigateToMainApps}>Explore or connect apps</button>
    {#if $privateAppWorkspaceState.setupLoading}
        <p role="status">Loading saved app setup…</p>
    {:else if apps.length === 0}<p>No apps connected for this account.</p>{/if}
    {#if $privateAppWorkspaceState.setupStatus}<p role="status">
            {$privateAppWorkspaceState.setupStatus}
        </p>{/if}
    {#each apps as app (app.id)}
        <label
            ><input
                type="checkbox"
                disabled={$privateAppWorkspaceState.setupLoading || $privateAppWorkspaceState.busy}
                checked={enabled(app.id)}
                onchange={(event) =>
                    localAppChatConfiguration.setEnabled(
                        $currentUserIdStore,
                        chatKey,
                        app.id,
                        event.currentTarget.checked,
                    )}
            /><span>Suggest {app.name} actions in this chat</span></label
        >
        <p class="small">{app.description}</p>
    {/each}
    <p class="small">
        Off by default. Enabled chats are remembered for this account on this device, not shared
        with other accounts. Connect or disconnect apps from Explore. The global AI suggestions
        setting and chat mute still apply. Private cards are kept separately in encrypted local
        storage and are not sent until you confirm them.
    </p>
</section>

<style>
    .local-apps {
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
        padding: 1rem;
        overflow-wrap: anywhere;
    }
    h3,
    p {
        margin: 0;
    }
    label {
        display: flex;
        align-items: flex-start;
        gap: 0.65rem;
    }
    input {
        flex: 0 0 auto;
        margin-top: 0.2rem;
    }
    button {
        font: inherit;
        padding: 0.6rem;
        border: 1px solid #888;
        border-radius: 0.4rem;
        cursor: pointer;
    }
    .small {
        font-size: 0.85rem;
    }
</style>
