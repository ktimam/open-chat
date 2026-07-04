<script lang="ts">
    // The auto-propose suggestion chip, rendered under a message bubble alongside reactions/tips
    // when the message matched a registered action's trigger keywords (see utils/autoPropose.ts).
    // Tap runs the existing propose flow; the X dismisses the suggestion, and long-pressing the X
    // mutes suggestions for the whole chat. v1 port of components_mobile/home/AutoProposeChip.svelte.
    import { i18nKey } from "@src/i18n/i18n";
    import { _ } from "svelte-i18n";
    import Close from "svelte-material-icons/Close.svelte";
    import Robot from "svelte-material-icons/RobotOutline.svelte";
    import Translatable from "../Translatable.svelte";

    interface Props {
        me: boolean;
        // The matched action's card title.
        title: string;
        onPropose: () => void;
        onDismiss: () => void;
        onMute: () => void;
    }

    let { me, title, onPropose, onDismiss, onMute }: Props = $props();

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

<div class="auto-propose" class:me>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="chip" onclick={onPropose}>
        <Robot size={"1rem"} color={"var(--primary)"} />
        <span class="label">
            <Translatable resourceKey={i18nKey("aiApps.autoPropose.suggestion", { title })} />
        </span>
        <button
            type="button"
            class="dismiss"
            aria-label={$_("aiApps.autoPropose.mute")}
            onpointerdown={pressStart}
            onpointerup={pressEnd}
            onpointerleave={pressEnd}
            onclick={dismissClicked}>
            <Close size={"1rem"} color={"var(--txt-light)"} />
        </button>
    </div>
</div>

<style lang="scss">
    .auto-propose {
        display: flex;
        justify-content: flex-start;
        padding: 0 $sp4;
        margin-top: $sp1;

        &.me {
            justify-content: flex-end;
        }
    }

    .chip {
        display: inline-flex;
        align-items: center;
        gap: $sp2;
        padding: $sp1 $sp3;
        border-radius: var(--button-rd, 999px);
        background-color: var(--chatSummary-bg, var(--input-bg));
        border: var(--bw) solid var(--bd);
        cursor: pointer;
        @include font-size(fs-70);

        &:hover {
            background-color: var(--chatSummary-hv, var(--input-bg));
        }
    }

    .label {
        color: var(--txt);
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
