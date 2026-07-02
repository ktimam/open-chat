<script lang="ts">
    import type { ActionCardContent } from "openchat-client";

    // Generic interactive confirm card. The `rows` shown here ARE the exact values that will be
    // forwarded to the registered app on confirm — what the human sees is what gets sent.
    interface Props {
        content: ActionCardContent;
        readonly: boolean;
        onRespond?: (response: "confirm" | "cancel") => void;
    }

    let { content, readonly, onRespond }: Props = $props();

    // A card past its expiry is treated as no longer actionable, matching the canister (which rejects
    // a confirm/cancel on an expired card). Guards against showing live buttons on a stale card.
    let expired = $derived(content.expiresAt !== undefined && content.expiresAt <= BigInt(Date.now()));
    let pending = $derived(content.state === "pending" && !expired);
    let displayState = $derived(expired && content.state === "pending" ? "expired" : content.state);
    // If the consumer required a disclosure, confirm is gated on the human acknowledging it.
    let acknowledged = $state(false);
    let canConfirm = $derived(pending && !readonly && (content.disclosure === undefined || acknowledged));

    // Once the card leaves "pending" (confirmed / cancelled / expired) it is "consumed": there is
    // nothing left to act on, so collapse it to just a title + status header. Clicking the header
    // toggles it back open. `content.state` is durable (re-hydrated on the message), so the effect
    // fires the moment a confirm/cancel lands, and a consumed card re-defaults to collapsed after
    // it is scrolled off-screen and back — the intended behavior. While pending the header is inert.
    let consumed = $derived(!pending);
    let collapsed = $state(false);
    $effect(() => {
        if (consumed) collapsed = true;
    });
    function toggleCollapsed(e: Event) {
        if (!consumed) return;
        e.stopPropagation();
        collapsed = !collapsed;
    }
</script>

<div class="action-card" class:collapsed>
    <!-- Header: the title, plus (once consumed) the status and a chevron. Clicking a CONSUMED
         card's header toggles the collapse; while pending it is inert. stopPropagation (in
         toggleCollapsed) matters because the mobile bubble is wrapped in a MenuTrigger — an
         unstopped click would also open the message context menu. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="header"
        class:clickable={consumed}
        role={consumed ? "button" : undefined}
        tabindex={consumed ? 0 : undefined}
        onclick={toggleCollapsed}
        onkeydown={(e) => {
            if (consumed && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                toggleCollapsed(e);
            }
        }}>
        <div class="title">{content.title}</div>
        {#if consumed}
            <div class="state state-{displayState}">{displayState}</div>
            <span class="chevron" class:collapsed>▾</span>
        {/if}
    </div>

    {#if !collapsed}
        <table class="rows">
            <tbody>
                {#each content.rows as row}
                    <tr>
                        <td class="label">{row.label}</td>
                        <td class="value">{row.value}</td>
                    </tr>
                {/each}
            </tbody>
        </table>

        {#if content.disclosure !== undefined}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <label class="disclosure" onclick={(e) => e.stopPropagation()}>
                <input type="checkbox" bind:checked={acknowledged} disabled={!pending || readonly} />
                <span>{content.disclosure}</span>
            </label>
        {/if}

        {#if pending}
            <!-- stopPropagation: in the mobile layout the whole bubble is wrapped in a MenuTrigger, so an
                 unstopped click on these controls would also open the message context menu. -->
            <div class="actions">
                <button
                    class="cancel"
                    disabled={readonly}
                    onclick={(e) => {
                        e.stopPropagation();
                        onRespond?.("cancel");
                    }}>
                    {content.cancelLabel}
                </button>
                <button
                    class="confirm"
                    disabled={!canConfirm}
                    onclick={(e) => {
                        e.stopPropagation();
                        onRespond?.("confirm");
                    }}>
                    {content.confirmLabel}
                </button>
            </div>
        {/if}
    {/if}
</div>

<style lang="scss">
    .action-card {
        display: flex;
        flex-direction: column;
        gap: $sp3;
        padding: $sp4;
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
        background-color: var(--currentChat-msg-bg);
        max-width: 360px;

        // Collapsed (consumed) cards shrink to a slim, full-width strip: just the header line
        // (title + status + chevron), tighter padding, smaller type. The mobile bubble hugs its
        // content up to a ~75vw cap, so width:100% cannot grow it — a viewport-based min-width
        // pushes the bubble out to its cap instead (clamped for the wide desktop layout).
        &.collapsed {
            max-width: none;
            min-width: min(75vw, 480px);
            gap: 0;
            padding: $sp2 $sp3;
            font-size: 0.8em;
        }
    }

    .header {
        display: flex;
        align-items: center;
        gap: $sp3;
        min-width: 0;

        &.clickable {
            cursor: pointer;
        }
    }

    .title {
        font-weight: 700;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .chevron {
        color: var(--txt-light);
        font-size: 0.9em;
        transition: transform 0.15s ease;

        &.collapsed {
            transform: rotate(-90deg);
        }
    }

    .rows {
        border-collapse: collapse;
        width: 100%;

        .label {
            color: var(--txt-light);
            padding-right: $sp4;
            white-space: nowrap;
            vertical-align: top;
        }

        .value {
            font-weight: 500;
            word-break: break-word;
        }
    }

    .disclosure {
        display: flex;
        gap: $sp2;
        align-items: flex-start;
        font-size: var(--font-size-small, 0.85em);
        color: var(--txt-light);
    }

    .actions {
        display: flex;
        gap: $sp3;
        justify-content: flex-end;

        button {
            padding: $sp2 $sp4;
            border-radius: var(--rd);
            cursor: pointer;

            &:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            &.confirm {
                background-color: var(--button-bg);
                color: var(--button-txt);
                border: none;
            }

            &.cancel {
                background-color: transparent;
                color: var(--txt);
                border: var(--bw) solid var(--bd);
            }
        }
    }

    .state {
        text-transform: capitalize;
        color: var(--txt-light);
        font-weight: 600;
        white-space: nowrap;
    }
</style>
