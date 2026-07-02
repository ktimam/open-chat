<script lang="ts">
    // The auto-propose suggestion chip, rendered under a message bubble alongside
    // reactions/tips when the message matched a registered action's trigger keywords
    // (see utils/autoPropose.ts). Tap runs the existing propose flow; the X dismisses
    // the suggestion, and long-pressing the X mutes suggestions for the whole chat.
    import { i18nKey } from "@src/i18n/i18n";
    import { ChatFootnote, ColourVars, Container, Row } from "component-lib";
    import { _ } from "svelte-i18n";
    import Close from "svelte-material-icons/Close.svelte";
    import Robot from "svelte-material-icons/RobotOutline.svelte";
    import Translatable from "../Translatable.svelte";

    interface Props {
        me: boolean;
        // The matched action's card title.
        title: string;
        offset: boolean;
        onPropose: () => void;
        onDismiss: () => void;
        onMute: () => void;
    }

    let { me, title, offset, onPropose, onDismiss, onMute }: Props = $props();

    const LONG_PRESS_MS = 600;
    let pressTimer: number | undefined = undefined;
    let longPressed = false;

    function pressStart() {
        longPressed = false;
        pressTimer = window.setTimeout(() => {
            longPressed = true;
            pressTimer = undefined;
            onMute();
        }, LONG_PRESS_MS);
    }

    function pressEnd() {
        if (pressTimer !== undefined) {
            window.clearTimeout(pressTimer);
            pressTimer = undefined;
        }
    }

    function dismissClicked(e: MouseEvent) {
        e.stopPropagation();
        if (!longPressed) {
            onDismiss();
        }
        longPressed = false;
    }
</script>

<Container
    supplementalClass={offset ? "auto-propose-offset-top" : ""}
    gap={"xxs"}
    padding={["zero", "md"]}
    width={"hug"}
    height={"hug"}
    mainAxisAlignment={me ? "end" : "start"}
    crossAxisAlignment={"center"}>
    <Row
        supplementalClass={"auto-propose-chip"}
        onClick={onPropose}
        width={"hug"}
        height={"hug"}
        padding={["xxs", "sm"]}
        background={ColourVars.background2}
        crossAxisAlignment={"center"}
        mainAxisAlignment={"center"}
        gap={"xs"}
        borderRadius={"circle"}
        borderWidth={"thick"}
        borderColour={ColourVars.background0}>
        <Robot size={"1rem"} color={"var(--primary)"} />
        <ChatFootnote>
            <Translatable resourceKey={i18nKey("aiApps.autoPropose.suggestion", { title })} />
        </ChatFootnote>
        <button
            type="button"
            class="dismiss"
            aria-label={$_("aiApps.autoPropose.mute")}
            onpointerdown={pressStart}
            onpointerup={pressEnd}
            onpointerleave={pressEnd}
            onclick={dismissClicked}>
            <Close size={"1rem"} color={"var(--text-secondary)"} />
        </button>
    </Row>
</Container>

<style lang="scss">
    :global(.auto-propose-offset-top) {
        top: -0.5rem;
    }

    .dismiss {
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        padding: 0;
        margin: 0;
        cursor: pointer;
    }
</style>
