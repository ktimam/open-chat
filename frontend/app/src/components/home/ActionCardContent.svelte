<script lang="ts">
    import { type ActionCardContent, type ChatIdentifier, chatKeyFor, OpenChat } from "openchat-client";
    import { getContext, onMount } from "svelte";
    import { currentTheme } from "../../theme/themes";
    import { cardSurfaceForAction } from "../../utils/aiAppSurfaces";
    import {
        buildCardInit,
        clampCardHeight,
        decodeConfirmPayload,
        deriveCardOrigin,
        isRecord,
        reverseMapRows,
    } from "../../utils/cardBridge";
    import Spinner from "../icons/Spinner.svelte";

    // Generic interactive confirm card. Two render modes:
    //   1. The card's owning app declares a "card" surface (fork-notes/08-app-rendered-cards.md) → the
    //      app OWNS the pixels: OpenChat embeds the app's page in an iframe and relays confirm/cancel over
    //      the postMessage bridge. The user can edit values inside the frame; the edited object is passed
    //      back to `onRespond` as the payload.
    //   2. No "card" surface → today's behaviour, unchanged: the `rows` shown ARE the exact frozen values
    //      forwarded to the app on confirm — what the human sees is what gets sent.
    interface Props {
        content: ActionCardContent;
        readonly: boolean;
        // The chat this card lives in — used to locate the owning app's card surface and to build the
        // bridge `context.chatKey`.
        chatId: ChatIdentifier;
        // On confirm from an app card, `payload` carries the app's final edited object; classic
        // OC-rendered cards call this with no payload.
        onRespond?: (
            response: "confirm" | "cancel",
            payload?: Record<string, unknown>,
        ) => void | Promise<unknown>;
    }

    let { content, readonly, chatId, onRespond }: Props = $props();

    const client = getContext<OpenChat>("client");

    // While a confirm/cancel round-trips to the canister (and, on confirm, encrypts + deposits the
    // action), show a spinner and lock both buttons so the press is acknowledged and can't be
    // double-fired. Resets on completion whether the call succeeds OR fails — a failed deposit now
    // surfaces as an error, and the card must become actionable again rather than spin forever.
    let busy = $state(false);
    async function doRespond(response: "confirm" | "cancel", payload?: Record<string, unknown>) {
        if (busy) return;
        busy = true;
        try {
            await onRespond?.(response, payload);
        } finally {
            busy = false;
        }
    }
    async function respond(response: "confirm" | "cancel", e: Event) {
        e.stopPropagation();
        await doRespond(response);
    }

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

    // ---- App-rendered card (iframe) -------------------------------------------------------------
    // The card is actionable exactly when today's buttons would be: pending, not readonly. This is the
    // ONE gate for the bridge — it feeds `context.readonly` and screens inbound confirm/cancel. (App
    // cards own their own field validation, so disclosure ack — an OC-rows affordance — is not applied
    // here; the app renders whatever consent UI it needs inside the frame.)
    let cardActionable = $derived(pending && !readonly);
    let cardReadonly = $derived(!cardActionable);

    // Resolved lazily from the owning app's manifest. While undefined we render today's rows, so an app
    // with no "card" surface (or any lookup failure) is fully backward compatible.
    let cardUrl = $state<string | undefined>(undefined);
    let cardOrigin = $state<string | undefined>(undefined);
    let cardAppId = $state<number | undefined>(undefined);
    // The owning action's label -> field-key map, used to reverse-map the message's hydrated rows into
    // structured prefill data (the frozen confirmPayload is not hydrated on a received card today).
    let cardLabelToField = $state<Record<string, string>>({});

    let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
    const MIN_CARD_HEIGHT = 140;
    const MAX_CARD_HEIGHT = 1200;
    let cardHeight = $state(MIN_CARD_HEIGHT);
    // The iframe has completed its ready→init handshake at least once; gates re-sending init when the
    // context (theme / readonly) changes while the card is open.
    let readySeen = $state(false);

    // Detect the owning app's card surface once. actionId + chatId are stable for a given card message
    // (state transitions replace `content` but not its actionId), so a single lookup on mount suffices;
    // a cancel token guards the async resolve against a teardown mid-flight.
    onMount(() => {
        let cancelled = false;
        void cardSurfaceForAction(client, chatId, content.actionId).then((opening) => {
            if (cancelled || opening === undefined) return;
            const origin = deriveCardOrigin(opening.url);
            // No parseable origin → decline to embed; stay on the OC-rendered rows rather than talk to
            // an unknown origin.
            if (origin === undefined) return;
            cardOrigin = origin;
            cardAppId = opening.app.id;
            cardLabelToField = opening.labelToField;
            cardUrl = opening.url;
        });
        return () => {
            cancelled = true;
        };
    });

    function postInit() {
        const target = iframeEl?.contentWindow;
        if (target === null || target === undefined || cardOrigin === undefined) return;
        // Prefill precedence: the decoded confirmPayload wins WHEN present (future-proof — the moment
        // the canister hydrates confirm_payload on receive, the exact frozen object flows straight
        // through). Today it decodes to {} on a received card, so we fall back to reverse-mapping the
        // hydrated {label, value} rows onto the manifest's field keys — recovering the real extracted
        // values (e.g. { amount, currency, direction, note }) instead of an empty form.
        const decoded = decodeConfirmPayload(content.confirmPayload);
        const data =
            Object.keys(decoded).length > 0
                ? decoded
                : reverseMapRows(content.rows, cardLabelToField);
        const init = buildCardInit(data, {
            chatKey: chatKeyFor(chatId),
            appId: cardAppId ?? 0,
            actionId: content.actionId,
            theme: $currentTheme.mode,
            readonly: cardReadonly,
        });
        target.postMessage(init, cardOrigin);
    }

    // The single window listener for the bridge. Origin-checked BOTH ways: we ignore any message whose
    // origin is not the card's registered surface origin, and (belt-and-braces) any not sourced from our
    // own iframe. confirm/cancel are additionally screened by `cardActionable`, mirroring today's gating.
    function onBridgeMessage(event: MessageEvent) {
        if (cardOrigin === undefined || event.origin !== cardOrigin) return;
        if (iframeEl !== undefined && event.source !== iframeEl.contentWindow) return;
        const msg = event.data;
        if (!isRecord(msg)) return;
        switch (msg.type) {
            case "oc:card:ready":
                readySeen = true;
                postInit();
                break;
            case "oc:card:resize":
                if (typeof msg.height === "number") {
                    cardHeight = clampCardHeight(msg.height, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT);
                }
                break;
            case "oc:card:confirm":
                if (!cardActionable || busy) return;
                void doRespond("confirm", isRecord(msg.payload) ? msg.payload : undefined);
                break;
            case "oc:card:cancel":
                if (!cardActionable || busy) return;
                void doRespond("cancel");
                break;
        }
    }

    $effect(() => {
        // Only listen once we actually have an embedded card; teardown removes it (Svelte runs the
        // returned cleanup on destroy and before each re-run).
        if (cardUrl === undefined) return;
        window.addEventListener("message", onBridgeMessage);
        return () => window.removeEventListener("message", onBridgeMessage);
    });

    $effect(() => {
        // Keep the frame in sync after the handshake: re-send init when the theme mode or the
        // readonly/actionable state changes (the contract allows the host to re-send init). Reading these
        // here registers them as dependencies.
        const _mode = $currentTheme.mode;
        const _readonly = cardReadonly;
        void _mode;
        void _readonly;
        if (readySeen) postInit();
    });
</script>

<div class="action-card" class:collapsed class:has-frame={cardUrl !== undefined}>
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
        {#if cardUrl !== undefined}
            <!-- App-rendered card: the owning app owns the pixels AND the confirm/cancel controls, which
                 arrive over the bridge. sandbox="allow-scripts allow-same-origin" lets the app's page run
                 and hold its own (storage-partitioned) session; the height is driven by oc:card:resize. -->
            <!-- credentialless: OpenChat is cross-origin-isolated (COEP: credentialless) for its wasm
                 inference, which otherwise ERR_BLOCKED_BY_RESPONSE a cross-origin iframe. The
                 credentialless attribute loads the app card in an anonymous context (no cookies /
                 partitioned storage — the card page needs no session anyway), which is permitted
                 inside a COEP document. -->
            <iframe
                bind:this={iframeEl}
                class="card-frame"
                title={content.title}
                src={cardUrl}
                credentialless
                sandbox="allow-scripts allow-same-origin"
                style={`height: ${cardHeight}px;`}></iframe>
        {:else}
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
                    <input
                        type="checkbox"
                        bind:checked={acknowledged}
                        disabled={!pending || readonly} />
                    <span>{content.disclosure}</span>
                </label>
            {/if}

            {#if pending}
                <!-- stopPropagation: in the mobile layout the whole bubble is wrapped in a MenuTrigger, so an
                     unstopped click on these controls would also open the message context menu. -->
                <div class="actions">
                    <button
                        class="cancel"
                        disabled={readonly || busy}
                        onclick={(e) => respond("cancel", e)}>
                        {content.cancelLabel}
                    </button>
                    <button
                        class="confirm"
                        disabled={!canConfirm || busy}
                        onclick={(e) => respond("confirm", e)}>
                        {#if busy}
                            <Spinner size="1.1em" foregroundColour="transparent" />
                        {:else}
                            {content.confirmLabel}
                        {/if}
                    </button>
                </div>
            {/if}
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
        // Pair the text with the message-bubble background this card sits on. Without this the card
        // inherited the surrounding bubble's colour (e.g. the sender's white "me"-bubble text) while
        // forcing the received-message background — rendering white-on-light-grey (~1.1:1, unreadable).
        // Every theme defines msg-bg/msg-txt as a readable pair, so this is correct light AND dark.
        color: var(--currentChat-msg-txt);
        max-width: 360px;

        // An app-rendered (iframe) card owns its own layout and typically wants more room than the
        // rows do — give it the wider cap while still hugging the bubble.
        &.has-frame:not(.collapsed) {
            max-width: min(90vw, 420px);
        }

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
        color: var(--currentChat-msg-muted);
        font-size: 0.9em;
        transition: transform 0.15s ease;

        &.collapsed {
            transform: rotate(-90deg);
        }
    }

    .card-frame {
        width: 100%;
        border: none;
        border-radius: var(--rd);
        display: block;
        background-color: transparent;
        // Height is authoritative from the resize bridge; this is only the pre-handshake floor.
        min-height: 140px;
    }

    .rows {
        border-collapse: collapse;
        width: 100%;

        .label {
            color: var(--currentChat-msg-muted);
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
        color: var(--currentChat-msg-muted);
    }

    .actions {
        display: flex;
        gap: $sp3;
        justify-content: flex-end;

        button {
            padding: $sp2 $sp4;
            border-radius: var(--rd);
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;

            &:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            &.confirm {
                background-color: var(--button-bg);
                color: var(--button-txt);
                border: none;
                // Hold width when the label swaps to the spinner so the button doesn't collapse.
                min-width: 6rem;
            }

            &.cancel {
                background-color: transparent;
                color: var(--currentChat-msg-txt);
                border: var(--bw) solid var(--bd);
            }
        }
    }

    .state {
        text-transform: capitalize;
        color: var(--currentChat-msg-muted);
        font-weight: 600;
        white-space: nowrap;
    }
</style>
