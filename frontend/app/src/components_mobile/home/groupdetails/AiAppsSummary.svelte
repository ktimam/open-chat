<script lang="ts">
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import { Body, BodySmall, Container, Switch } from "component-lib";
    import {
        anonUserStore,
        ROLE_ADMIN,
        ROLE_OWNER,
        selectedChatSummaryStore,
        type AiAppRegistration,
        type MultiUserChat,
        type OpenChat,
    } from "openchat-client";
    import { getContext } from "svelte";
    import Translatable from "../../Translatable.svelte";
    import Separator from "../Separator.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        chat: MultiUserChat;
    }

    let { chat }: Props = $props();

    // Phase A: the AI-app directory is group-scoped only — no channels/communities yet.
    let isGroup = $derived(chat.id.kind === "group_chat");
    let myRole = $derived($selectedChatSummaryStore?.membership.role);
    // Only the group's owner or admins can enable/disable apps (the canister enforces this too).
    let canManage = $derived(!$anonUserStore && (myRole === ROLE_OWNER || myRole === ROLE_ADMIN));

    let loading = $state(true);
    let apps = $state<AiAppRegistration[]>([]);
    let enabled = $state(new Set<number>());
    let toggling = $state(new Set<number>());

    async function load() {
        loading = true;
        // Both facades resolve to [] on failure, so a load error just presents as "no apps".
        const [allApps, enabledIds] = await Promise.all([
            client.aiApps(),
            client.enabledAiApps(chat.id),
        ]);
        apps = allApps;
        enabled = new Set(enabledIds);
        loading = false;
    }

    if (chat.id.kind === "group_chat") {
        load();
    }

    async function toggleApp(app: AiAppRegistration) {
        if (!canManage || toggling.has(app.id)) return;
        const enable = !enabled.has(app.id);
        toggling = new Set(toggling).add(app.id);
        const success = await client.setAiAppEnabled(chat.id, app.id, enable);
        if (success) {
            const next = new Set(enabled);
            if (enable) {
                next.add(app.id);
            } else {
                next.delete(app.id);
            }
            enabled = next;
        } else {
            toastStore.showFailureToast(i18nKey("aiApps.toggleFailed"));
        }
        const done = new Set(toggling);
        done.delete(app.id);
        toggling = done;
    }
</script>

{#if isGroup}
    <Separator />

    <Container padding={["zero", "md"]} gap={"lg"} direction={"vertical"}>
        <Body colour={"textSecondary"} fontWeight={"bold"}>
            <Translatable resourceKey={i18nKey("aiApps.title")} />
        </Body>

        {#if loading}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.loading")} />
            </BodySmall>
        {:else if apps.length === 0}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.none")} />
            </BodySmall>
        {:else}
            {#each apps as app (app.id)}
                <Container
                    mainAxisAlignment={"spaceBetween"}
                    crossAxisAlignment={"center"}
                    gap={"md"}>
                    <Container direction={"vertical"} gap={"xs"}>
                        <Body fontWeight={"bold"}>{app.manifest.name}</Body>
                        {#if app.manifest.description.length > 0}
                            <BodySmall colour={"textSecondary"}>
                                {app.manifest.description}
                            </BodySmall>
                        {/if}
                    </Container>
                    <Switch
                        bound={false}
                        checked={enabled.has(app.id)}
                        disabled={!canManage}
                        loading={toggling.has(app.id)}
                        onChange={() => toggleApp(app)} />
                </Container>
            {/each}
        {/if}
    </Container>
{/if}
