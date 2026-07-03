<script lang="ts">
    // "My apps": the signed-in user's OWN registered AI apps (ai_apps already returns the caller's
    // unpublished apps alongside the published directory). Each shows its published status; an
    // unpublished one gets a Publish button. Fully generic — reads only manifest + published +
    // owner. Publishing is owner + governance/test_mode gated in the canister.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        Body,
        BodySmall,
        CommonButton,
        Container,
        Subtitle,
    } from "component-lib";
    import { currentUserIdStore, type AiAppRegistration, type OpenChat } from "openchat-client";
    import { getContext, onMount } from "svelte";
    import CheckDecagram from "svelte-material-icons/CheckDecagram.svelte";
    import Upload from "svelte-material-icons/Upload.svelte";
    import Translatable from "../../Translatable.svelte";
    import SlidingPageContent from "../SlidingPageContent.svelte";

    const client = getContext<OpenChat>("client");

    let loading = $state(true);
    let apps = $state<AiAppRegistration[]>([]);
    let publishing = $state(new Set<number>());

    async function load() {
        loading = true;
        const all = await client.aiApps();
        // owner is a stringified principal, same form as currentUserIdStore.value.
        apps = all.filter((a) => a.owner === currentUserIdStore.value);
        loading = false;
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

<SlidingPageContent title={i18nKey("aiApps.myApps")}>
    <Container
        padding={["xxl", "lg", "huge"]}
        gap={"lg"}
        height={"fill"}
        direction={"vertical"}>
        {#if loading}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.loading")} />
            </BodySmall>
        {:else if apps.length === 0}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.myAppsNone")} />
            </BodySmall>
        {:else}
            {#each apps as app (app.id)}
                <Container
                    mainAxisAlignment={"spaceBetween"}
                    crossAxisAlignment={"center"}
                    gap={"md"}>
                    <Container direction={"vertical"} gap={"xs"}>
                        <Container crossAxisAlignment={"center"} gap={"sm"}>
                            <Subtitle fontWeight={"bold"}>{app.manifest.name}</Subtitle>
                            {#if app.published}
                                <CheckDecagram size={"1rem"} color={"var(--secondary)"} />
                            {/if}
                        </Container>
                        <BodySmall colour={"textSecondary"}>
                            <Translatable
                                resourceKey={i18nKey(
                                    app.published
                                        ? "aiApps.statusPublished"
                                        : "aiApps.statusPrivate",
                                )} />
                        </BodySmall>
                    </Container>
                    {#if !app.published}
                        <CommonButton
                            onClick={() => publishApp(app)}
                            loading={publishing.has(app.id)}
                            size={"small_text"}>
                            {#snippet icon(color, size)}
                                <Upload {color} {size} />
                            {/snippet}
                            <Translatable resourceKey={i18nKey("aiApps.publish")} />
                        </CommonButton>
                    {/if}
                </Container>
            {/each}
            <Body colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.myAppsHint")} />
            </Body>
        {/if}
    </Container>
</SlidingPageContent>
