<script lang="ts">
    import { i18nKey } from "@src/i18n/i18n";
    import { BodySmall, Button, Caption, Container, H2 } from "component-lib";
    import type { OpenChat } from "openchat-client";
    import type { AiActionDefinition } from "openchat-shared";
    import { getContext } from "svelte";
    import Translatable from "../../Translatable.svelte";
    import SlidingPageContent from "../SlidingPageContent.svelte";

    const client = getContext<OpenChat>("client");

    // A generic, app-neutral example — nothing here names any consumer. The integrating app supplies its own
    // values (especially the recipient public key, below). Endpoint must be a valid URL and responseSchema valid
    // JSON; both are validated on-chain.
    const sample = JSON.stringify(
        {
            name: "example.action",
            description: "An example AI action",
            promptTemplate:
                "Read the message and extract the relevant fields as a JSON object.",
            responseSchema: { type: "object", properties: {} },
            card: {
                title: "Example action",
                rows: [{ label: "Amount", valueKey: "amount" }],
                confirmLabel: "Confirm",
                cancelLabel: "Cancel",
                disclosure: "On confirm, an encrypted draft is delivered to the registered app.",
            },
            endpoint: "https://example.com/hook",
        },
        null,
        2,
    );

    let definitionJson = $state(sample);
    let recipientKey = $state("");
    let busy = $state(false);
    let result = $state("");
    let error = $state("");

    async function register() {
        error = "";
        result = "";
        let def: AiActionDefinition;
        try {
            def = JSON.parse(definitionJson) as AiActionDefinition;
        } catch (e) {
            error = "Definition is not valid JSON: " + String(e);
            return;
        }
        const key = recipientKey.trim();
        if (key.length > 0) {
            def.consumerPublicKey = key;
        }
        busy = true;
        try {
            const ok = await client.registerAiAction(def);
            result = ok
                ? "Action registered. It will now appear to clients that can propose it."
                : "Registration was rejected by the server.";
        } catch (e) {
            error = String(e);
        } finally {
            busy = false;
        }
    }
</script>

<SlidingPageContent
    title={i18nKey("Register AI action")}
    subtitle={i18nKey("Let an app's drafts be proposed from chat")}>
    <Container padding={"xxl"} gap={"lg"} height={"fill"} direction={"vertical"}>
        <BodySmall colour={"textSecondary"}>
            <Translatable
                resourceKey={i18nKey(
                    "Register a generic AI action — a prompt, an output schema, and a confirm-card template that any app can trigger in chat. App-specific values (recipient key, endpoint) come from the integrating app; OpenChat stores them opaquely.",
                )}></Translatable>
        </BodySmall>

        <H2 fontWeight={"bold"} colour={"primary"}>
            <Translatable resourceKey={i18nKey("Action definition (JSON)")}></Translatable>
        </H2>
        <textarea class="oc-area" rows="16" spellcheck="false" bind:value={definitionJson}></textarea>

        <H2 fontWeight={"bold"} colour={"primary"}>
            <Translatable resourceKey={i18nKey("Recipient public key (P-256 SPKI PEM)")}></Translatable>
        </H2>
        <BodySmall colour={"textSecondary"}>
            <Translatable
                resourceKey={i18nKey(
                    "Confirmed actions are encrypted to this key and delivered to the app's inbox. Paste it from the consuming app.",
                )}></Translatable>
        </BodySmall>
        <textarea
            class="oc-area"
            rows="5"
            spellcheck="false"
            placeholder="-----BEGIN PUBLIC KEY-----&#10;…&#10;-----END PUBLIC KEY-----"
            bind:value={recipientKey}></textarea>

        <Container gap={"sm"} direction={"horizontal"}>
            <Button disabled={busy} onClick={register}>
                <Translatable resourceKey={i18nKey(busy ? "Registering…" : "Register action")}
                ></Translatable>
            </Button>
        </Container>

        {#if result}
            <Caption colour={"primary"}>{result}</Caption>
        {/if}
        {#if error}
            <Caption colour={"error"}>{error}</Caption>
        {/if}
    </Container>
</SlidingPageContent>

<style lang="scss">
    .oc-area {
        width: 100%;
        font-family: monospace;
        font-size: 0.8rem;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid var(--input-bd, rgba(0, 0, 0, 0.2));
        background-color: var(--input-bg, rgba(0, 0, 0, 0.03));
        color: var(--txt, inherit);
        resize: vertical;
        box-sizing: border-box;
    }
</style>
