<script lang="ts">
    import { i18nKey } from "@src/i18n/i18n";
    import AccountLinkingCodeFlow from "@src/components/home/profile/AccountLinkingCode.svelte";
    import { Container } from "component-lib";
    import SlidingPageContent from "../SlidingPageContent.svelte";
</script>

<SlidingPageContent
    title={i18nKey("accountLinkingCode.settingsMenu.title")}
    subtitle={i18nKey("General options")}
>
    <Container
        padding={["xxl", "lg"]}
        gap={"lg"}
        height={"fill"}
        crossAxisAlignment={"center"}
        direction={"vertical"}
    >
        <AccountLinkingCodeFlow />
    </Container>
</SlidingPageContent>
