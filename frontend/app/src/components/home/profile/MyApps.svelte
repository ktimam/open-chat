<script lang="ts">
    // "My apps": the signed-in user's OWN registered AI apps, fetched through a bounded owner-only
    // page. Each shows its published status; an
    // unpublished one gets a Publish button (owner + governance/test_mode gated in the canister).
    // Self-gating: owns its CollapsibleCard and renders nothing unless the user owns ≥1 app, so the
    // vast majority of users (who register none) see no empty section. v1 port of
    // components_mobile/home/user_profile/MyApps.svelte.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import { type AiAppRegistration, type OpenChat } from "openchat-client";
    import { getContext, onMount } from "svelte";
    import CheckDecagram from "svelte-material-icons/CheckDecagram.svelte";
    import Upload from "svelte-material-icons/Upload.svelte";
    import { myAppsSectionOpen } from "../../../stores/settings";
    import Button from "../../Button.svelte";
    import CollapsibleCard from "../../CollapsibleCard.svelte";
    import Translatable from "../../Translatable.svelte";

    const client = getContext<OpenChat>("client");

    let apps = $state<AiAppRegistration[]>([]);
    let total = $state(0);
    let loadingMore = $state(false);
    let publishing = $state(new Set<number>());

    async function load(reset = true) {
        const pageIndex = reset ? 0 : Math.floor(apps.length / 8);
        const page = await client.myAiAppsPage(pageIndex, 8);
        apps = reset ? page.apps : [...apps, ...page.apps];
        total = page.total;
    }

    async function loadMore() {
        if (loadingMore || apps.length >= total) return;
        loadingMore = true;
        await load(false);
        loadingMore = false;
    }

    onMount(load);

    async function publishApp(app: AiAppRegistration) {
        if (publishing.has(app.id)) return;
        publishing = new Set(publishing).add(app.id);
        const ok = await client.publishAiApp(app.id);
        if (ok) {
            toastStore.showSuccessToast(i18nKey("aiApps.published"));
            await load();
        } else {
            toastStore.showFailureToast(i18nKey("aiApps.publishFailed"));
        }
        const done = new Set(publishing);
        done.delete(app.id);
        publishing = done;
    }
</script>

{#if apps.length > 0}
    <CollapsibleCard
        onToggle={myAppsSectionOpen.toggle}
        open={$myAppsSectionOpen}
        headerText={i18nKey("aiApps.myApps")}>
        <div class="apps">
            {#each apps as app (app.id)}
                <div class="app">
                    <div class="app-info">
                        <div class="name-row">
                            <span class="name">{app.manifest.name}</span>
                            {#if app.published}
                                <CheckDecagram size={"1rem"} color={"var(--accent)"} />
                            {/if}
                        </div>
                        <div class="status">
                            <Translatable
                                resourceKey={i18nKey(
                                    app.published
                                        ? "aiApps.statusPublished"
                                        : "aiApps.statusPrivate",
                                )} />
                        </div>
                    </div>
                    {#if !app.published}
                        <Button
                            small
                            loading={publishing.has(app.id)}
                            onClick={() => publishApp(app)}>
                            <Upload size="1em" color="currentColor" />
                            <Translatable resourceKey={i18nKey("aiApps.publish")} />
                        </Button>
                    {/if}
                </div>
            {/each}
            {#if apps.length < total}
                <Button small loading={loadingMore} onClick={loadMore}>
                    <Translatable resourceKey={i18nKey("communities.loadMore")} />
                </Button>
            {/if}
            <p class="hint">
                <Translatable resourceKey={i18nKey("aiApps.myAppsHint")} />
            </p>
        </div>
    </CollapsibleCard>
{/if}

<style lang="scss">
    .apps {
        display: flex;
        flex-direction: column;
        gap: $sp3;
    }

    .app {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: $sp3;
    }

    .app-info {
        display: flex;
        flex-direction: column;
        gap: $sp2;
        min-width: 0;
    }

    .name-row {
        display: flex;
        align-items: center;
        gap: $sp2;
    }

    .name {
        @include font(bold, normal, fs-90);
    }

    .status {
        @include font-size(fs-80);
        color: var(--txt-light);
    }

    .hint {
        @include font-size(fs-80);
        color: var(--txt-light);
        margin: $sp2 0 0 0;
    }
</style>
