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
</script>

<div class="action-card">
    <div class="title">{content.title}</div>

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
        <label class="disclosure">
            <input type="checkbox" bind:checked={acknowledged} disabled={!pending || readonly} />
            <span>{content.disclosure}</span>
        </label>
    {/if}

    {#if pending}
        <div class="actions">
            <button class="cancel" disabled={readonly} onclick={() => onRespond?.("cancel")}>
                {content.cancelLabel}
            </button>
            <button class="confirm" disabled={!canConfirm} onclick={() => onRespond?.("confirm")}>
                {content.confirmLabel}
            </button>
        </div>
    {:else}
        <div class="state state-{displayState}">{displayState}</div>
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
    }

    .title {
        font-weight: 700;
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
    }
</style>
