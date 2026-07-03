<script lang="ts">
    // One published AI app in the explorer. Everything shown is manifest data — the card is fully
    // generic. There is no app detail screen yet; per-chat enablement (the actionable surface)
    // lives in each chat's Apps settings, which this card points the user towards.
    import { BodySmall, Container, Subtitle } from "component-lib";
    import type { AiAppRegistration } from "openchat-client";
    import { i18nKey } from "../../../../i18n/i18n";
    import Translatable from "../../../Translatable.svelte";
    import AiAppIcon from "./AiAppIcon.svelte";

    interface Props {
        app: AiAppRegistration;
        // The signed-in user already holds a delivery key for this app (per-user-keys pairing).
        connected: boolean;
        // Opens the app's detail sheet (connection lifecycle + full action list).
        onSelect: () => void;
    }

    let { app, connected, onSelect }: Props = $props();

    let actionCount = $derived(app.manifest.actions.length);
</script>

<Container onClick={onSelect} padding={["sm", "zero"]} direction={"vertical"}>
    <Container overflow={"hidden"} gap={"md"}>
        <AiAppIcon iconUrl={app.manifest.iconUrl} size={"3rem"} />
        <Container gap={"xs"} direction={"vertical"}>
            <Container crossAxisAlignment={"center"} gap={"sm"}>
                <Subtitle fontWeight={"bold"}>
                    {app.manifest.name}
                </Subtitle>
                {#if connected}
                    <BodySmall colour={"secondary"} width={"hug"}>
                        <Translatable resourceKey={i18nKey("aiApps.connectedBadge")} />
                    </BodySmall>
                {/if}
            </Container>
            {#if app.manifest.description.length > 0}
                <BodySmall colour={"textSecondary"}>
                    {app.manifest.description}
                </BodySmall>
            {/if}
            <BodySmall colour={"textSecondary"}>
                <Translatable
                    resourceKey={i18nKey(
                        actionCount === 1 ? "aiApps.actionCountOne" : "aiApps.actionCount",
                        { count: actionCount.toString() },
                    )} />
            </BodySmall>
        </Container>
    </Container>
</Container>

