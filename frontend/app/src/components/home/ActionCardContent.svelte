<script lang="ts">
    import {
        type ActionCardContent,
        type AiAppCardCapability,
        aiAppCardChatContext,
        type ChatIdentifier,
        OpenChat,
    } from "openchat-client";
    import { getContext, onMount } from "svelte";
    import { currentTheme } from "../../theme/themes";
    import {
        appCardFinalConfirmationAvailable,
        appCardPrivateContextAvailable,
        appCardRenderingAvailable,
    } from "../../utils/aiActionAvailability";
    import {
        type AuthoritativeAppIdentity,
        resolveActionAppForCard,
    } from "../../utils/aiAppSurfaces";
    import {
        buildCardBusy,
        buildCardBootstrap,
        buildCardInit,
        buildCardPrivateContextRequest,
        beginCardCapabilityAttempt,
        beginCardConfirmationAttempt,
        canAcceptCardPrivateContextReady,
        canApproveCardRequest,
        canonicalCardApprovalSummary,
        cardAttemptKey,
        cardCapabilityAttemptStillCurrent,
        cardConfirmationAttemptStillCurrent,
        cardApprovalRequestFromMessage,
        cardResizeHeightFromMessage,
        clampCardHeight,
        decodeConfirmPayload,
        decodeCardRecipientPublicKey,
        deriveCardOrigin,
        encodeCardConfirmPayload,
        isCardBridgeEventForFrame,
        isCardPublicReadyMessage,
        isAppCardContentAttested,
        isRecord,
        newCardFrameNonce,
        supportsCredentiallessIframe,
        reverseMapRows,
        startCardHandshakeTimeout,
        startCardBootstrapRetry,
        visibleRows,
        type CardApprovalRequest,
        type CardCapabilityAttemptBinding,
        type CardConfirmationAttemptBinding,
    } from "../../utils/cardBridge";
    import Spinner from "../icons/Spinner.svelte";
    import AiAppIcon from "./communities/explore/AiAppIcon.svelte";

    // Generic interactive confirm card. Two render modes:
    //   1. The card's owning app declares a "card" surface, so the app owns the pixels: OpenChat
    //      embeds the app's page in an iframe and relays confirm/cancel over
    //      the postMessage bridge. The user can edit values inside the frame; the host snapshots the
    //      exact encoded bytes, obtains a one-time server grant for those bytes, then passes both on.
    //   2. No usable "card" surface → a read-only public-row summary. Confirmation fails closed because
    //      received rows are not the app's authorized exact payload.
    interface Props {
        content: ActionCardContent;
        readonly: boolean;
        // The chat this card lives in — used to locate the owning app's card surface and to build the
        // bridge `context.chatKey`.
        chatId: ChatIdentifier;
        messageId: bigint;
        threadRootMessageIndex?: number;
        viewerId: string;
        // App-rendered confirms carry exact encoded bytes plus the matching one-time server grant.
        // Classic OC-rendered cards call this with neither value and use the stored attested payload.
        onRespond?: (
            response: "confirm" | "cancel",
            confirmPayloadOverride?: Uint8Array,
            confirmationGrant?: Uint8Array,
        ) => void | Promise<unknown>;
    }

    let {
        content,
        readonly,
        chatId,
        messageId,
        threadRootMessageIndex,
        viewerId,
        onRespond,
    }: Props = $props();

    const client = getContext<OpenChat>("client");
    let resolvedAppIdentity = $state<AuthoritativeAppIdentity | undefined>(undefined);
    let candidateAppIdentity = $state<AuthoritativeAppIdentity | undefined>(undefined);
    let appResolutionComplete = $state(false);
    let credentiallessSupported = $state(false);
    let cardContentAttestationBlocked = $state(false);
    let appCardRenderingBlocked = $state(false);
    let cardContentAttested = $derived(isAppCardContentAttested(content));
    const finalConfirmationAvailable = appCardFinalConfirmationAvailable();
    const privateContextAvailable = appCardPrivateContextAvailable();

    // While a confirm/cancel round-trips to the canister (and, on confirm, encrypts + deposits the
    // action), show a spinner and lock both buttons so the press is acknowledged and can't be
    // double-fired. Resets on completion whether the call succeeds OR fails — a failed deposit now
    // surfaces as an error, and the card must become actionable again rather than spin forever.
    let busy = $state(false);
    async function doRespond(
        response: "confirm" | "cancel",
        confirmPayloadOverride?: Uint8Array,
        confirmationGrant?: Uint8Array,
    ) {
        if (
            response === "confirm" &&
            (!cardContentAttested ||
                resolvedAppIdentity === undefined ||
                !finalConfirmationAvailable)
        ) return;
        if (
            (confirmPayloadOverride === undefined) !== (confirmationGrant === undefined) ||
            (response === "cancel" &&
                (confirmPayloadOverride !== undefined || confirmationGrant !== undefined))
        ) return;
        if (busy) return;
        busy = true;
        try {
            await onRespond?.(
                response,
                confirmPayloadOverride?.slice(),
                confirmationGrant?.slice(),
            );
        } finally {
            busy = false;
        }
    }
    async function respond(response: "confirm" | "cancel", e: Event) {
        e.stopPropagation();
        if (response === "confirm" && (!cardContentAttested || !finalConfirmationAvailable)) return;
        await doRespond(response);
    }

    // A card past its expiry is treated as no longer actionable, matching the canister (which rejects
    // a confirm/cancel on an expired card). Guards against showing live buttons on a stale card.
    let expired = $derived(
        content.expiresAt !== undefined && content.expiresAt <= BigInt(Date.now()),
    );
    let pending = $derived(content.state === "pending" && !expired);
    let displayState = $derived(expired && content.state === "pending" ? "expired" : content.state);
    // If the consumer required a disclosure, confirm is gated on the human acknowledging it.
    let acknowledged = $state(false);
    let canConfirm = $derived(
        pending &&
            !readonly &&
            resolvedAppIdentity !== undefined &&
            cardContentAttested &&
            finalConfirmationAvailable &&
            (content.disclosure === undefined || acknowledged),
    );

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
    // Initial full-card attestation is enough to render the app and to cancel a pending card. It is not
    // authority for iframe-edited bytes: confirmation remains read-only until a separate server grant
    // binds the exact final payload to this viewer/card/app revision.
    let cardCancelable = $derived(
        pending && !readonly && cardContentAttested && resolvedAppIdentity !== undefined,
    );
    let cardConfirmable = $derived(cardCancelable && finalConfirmationAvailable);
    let cardReadonly = $derived(!cardConfirmable);

    // Resolved lazily from the owning app's manifest. While undefined we render today's rows, so an app
    // with no "card" surface (or any lookup failure) is fully backward compatible.
    let cardUrl = $state<string | undefined>(undefined);
    let cardOrigin = $state<string | undefined>(undefined);
    let cardAppId = $state<number | undefined>(undefined);
    let loadRequested = $state(false);
    let capabilityPending = $state(false);
    let privateContextRequested = $state(false);
    let confirmationGrantFailed = $state(false);
    let cardLoadFailed = $state(false);
    let useClassicFallback = $state(false);
    let cardCapability = $state<AiAppCardCapability | undefined>(undefined);
    let capabilityAttempt: CardCapabilityAttemptBinding | undefined;
    let confirmationAttempt: CardConfirmationAttemptBinding | undefined;
    let cancelPrivateContextTimeout: (() => void) | undefined;
    let cancelCardBootstrapRetry: (() => void) | undefined;
    let componentMounted = false;
    let frameNonce = $state(newCardFrameNonce());
    let approvalRequest = $state<CardApprovalRequest | undefined>(undefined);
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
    // Public card rendering and the optional private-context grant are separate decisions. A verified
    // ready handshake can render the message's existing card values; only a later host-owned grant may
    // mint/deliver private viewer context.
    let cardActivated = $derived(readySeen);
    let pendingApprovalAllowed = $derived(
        approvalRequest?.kind === "cancel" ? cardCancelable : cardConfirmable,
    );
    let canApprovePendingRequest = $derived(
        canApproveCardRequest(
            approvalRequest,
            pendingApprovalAllowed && cardActivated,
            busy,
            content.disclosure !== undefined,
            acknowledged,
        ),
    );

    function currentCardAttemptKey(): string | undefined {
        const chat = aiAppCardChatContext(chatId, viewerId);
        if (
            chat === undefined ||
            cardAppId === undefined ||
            content.appRevision === undefined ||
            resolvedAppIdentity?.id !== cardAppId
        ) return undefined;
        return cardAttemptKey({
            viewerId,
            chat,
            messageId,
            threadRootMessageIndex,
            appId: cardAppId,
            appRevision: content.appRevision,
            actionId: content.actionId,
        });
    }

    // Detect the owning app's card surface once. actionId + appId + chatId are stable for a given card
    // message (state transitions replace `content` but not its identity), so a single lookup on mount
    // suffices; a cancel token guards the async resolve against a teardown mid-flight. Passing
    // `content.appId` binds resolution to the EXACT producing app (see cardSurfaceForAction) — a legacy
    // card without both appId and appRevision never embeds third-party content.
    onMount(() => {
        let cancelled = false;
        componentMounted = true;
        credentiallessSupported = supportsCredentiallessIframe();
        if (content.appVerified !== true) {
            appResolutionComplete = true;
            return;
        }
        void resolveActionAppForCard(
            client,
            chatId,
            content.actionId,
            content.appId,
            content.appRevision,
        ).then((resolution) => {
            if (cancelled) return;
            appResolutionComplete = true;
            if (resolution === undefined) return;
            candidateAppIdentity = resolution.identity;
            const opening = resolution.cardSurface;
            if (opening === undefined) {
                resolvedAppIdentity = resolution.identity;
                return;
            }
            if (!cardContentAttested) {
                // appVerified currently proves only registry coordinates. The sender still controls
                // title/rows/payload, so do not load trusted app pixels until the backend attests the
                // complete canonical card content.
                resolvedAppIdentity = resolution.identity;
                cardContentAttestationBlocked = true;
                return;
            }
            if (!appCardRenderingAvailable(cardContentAttested)) {
                // Backend attestation is necessary but does not by itself activate an unfinished
                // client capability. Keep the iframe closed unless this exact local client release
                // has also been explicitly armed.
                resolvedAppIdentity = resolution.identity;
                appCardRenderingBlocked = true;
                return;
            }
            const origin = deriveCardOrigin(opening.url, {
                allowLocalDevelopment: import.meta.env.DEV,
            });
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
            componentMounted = false;
            cancelPrivateContextTimeout?.();
            cancelCardBootstrapRetry?.();
            cancelCardBootstrapRetry = undefined;
            capabilityAttempt = undefined;
            confirmationAttempt = undefined;
        };
    });

    function postInit() {
        const target = iframeEl?.contentWindow;
        if (
            target === null ||
            target === undefined ||
            cardOrigin === undefined ||
            cardAppId === undefined ||
            content.appRevision === undefined
        ) return;
        // The locally available exact confirmPayload wins. Received cards intentionally do not hydrate
        // it, so their public init is reconstructed only from safe manifest-mapped public rows. Private
        // app data is never recovered from a hidden row; it requires the separately authorized encrypted
        // private-context path.
        const decoded = decodeConfirmPayload(content.confirmPayload);
        const data: Record<string, unknown> =
            Object.keys(decoded).length > 0
                ? decoded
                : reverseMapRows(content.rows, cardLabelToField);
        const init = buildCardInit(data, {
            appId: cardAppId,
            appRevision: content.appRevision,
            actionId: content.actionId,
            theme: $currentTheme.mode,
            readonly: cardReadonly,
            privateContext: cardCapability,
        }, frameNonce);
        // `sandbox="allow-scripts"` gives the frame an opaque origin, so targetOrigin must be `*`.
        // The target is the exact frame WindowProxy and every protocol message is bound to frameNonce.
        target.postMessage(init, "*");
    }

    // The single window listener for the bridge. `allow-scripts` without `allow-same-origin` makes the
    // sender origin opaque (`null`), so every message must also come from this exact iframe WindowProxy
    // and carry its fresh per-load nonce. Confirm/cancel then pass separate host authority gates.
    function resetFrameSession() {
        cancelCardBootstrapRetry?.();
        cancelCardBootstrapRetry = undefined;
        cancelPrivateContextTimeout?.();
        cancelPrivateContextTimeout = undefined;
        frameNonce = newCardFrameNonce();
        readySeen = false;
        capabilityPending = false;
        privateContextRequested = false;
        cardCapability = undefined;
        capabilityAttempt = undefined;
        confirmationAttempt = undefined;
        confirmationGrantFailed = false;
        approvalRequest = undefined;
        acknowledged = false;
        resolvedAppIdentity = undefined;
    }

    function requestCardLoad(e: Event) {
        e.stopPropagation();
        cardLoadFailed = false;
        useClassicFallback = false;
        loadRequested = true;
        resetFrameSession();
    }

    function chooseClassicFallback(e: Event) {
        e.stopPropagation();
        loadRequested = false;
        useClassicFallback = true;
        resetFrameSession();
    }

    function requestPrivateContext(e: Event) {
        e.stopPropagation();
        const target = iframeEl?.contentWindow;
        if (
            !privateContextAvailable ||
            !cardActivated ||
            !pending ||
            readonly ||
            cardCapability !== undefined ||
            capabilityPending ||
            target === null ||
            target === undefined ||
            currentCardAttemptKey() === undefined
        ) return;
        privateContextRequested = true;
        capabilityPending = true;
        const requestedNonce = frameNonce;
        cancelPrivateContextTimeout?.();
        cancelPrivateContextTimeout = startCardHandshakeTimeout(() => {
            if (frameNonce !== requestedNonce || !privateContextRequested) return;
            privateContextRequested = false;
            capabilityPending = false;
        });
        target.postMessage(buildCardPrivateContextRequest(frameNonce), "*");
    }

    async function mintPrivateContextCapability(
        recipientKeyScheme: string,
        recipientPublicKey: Uint8Array,
    ) {
        const cardKey = currentCardAttemptKey();
        if (cardKey === undefined || !privateContextRequested) return;
        const binding: CardCapabilityAttemptBinding = {
            frameNonce,
            recipientKeyScheme,
            recipientPublicKey,
            cardKey,
        };
        const attempt = beginCardCapabilityAttempt(capabilityAttempt, binding);
        if (attempt === undefined) return;
        capabilityAttempt = attempt;
        privateContextRequested = false;
        cancelPrivateContextTimeout?.();
        cancelPrivateContextTimeout = undefined;
        try {
            const capability = await client.createAiAppCardCapability(
                chatId,
                threadRootMessageIndex,
                messageId,
                attempt.recipientKeyScheme,
                attempt.recipientPublicKey.slice(),
            );
            const currentKey = currentCardAttemptKey();
            if (currentKey === undefined) return;
            const current: CardCapabilityAttemptBinding = {
                frameNonce,
                recipientKeyScheme: attempt.recipientKeyScheme,
                recipientPublicKey: attempt.recipientPublicKey,
                cardKey: currentKey,
            };
            if (
                capability === undefined ||
                capability.expiresAt <= BigInt(Date.now()) ||
                !cardCapabilityAttemptStillCurrent(attempt, current, componentMounted)
            ) return;
            cardCapability = capability;
            postInit();
        } finally {
            if (capabilityAttempt === attempt) capabilityAttempt = undefined;
            capabilityPending = false;
        }
    }

    function onIframeLoad() {
        resetFrameSession();
        const target = iframeEl?.contentWindow;
        if (target == null) return;
        const loadedNonce = frameNonce;
        cancelCardBootstrapRetry = startCardBootstrapRetry(() => {
            // Stop a stale loop if the frame/session has changed between interval ticks. Ready is
            // also cancelled synchronously below, but this guard keeps the helper fail-safe.
            if (
                !loadRequested ||
                readySeen ||
                frameNonce !== loadedNonce ||
                iframeEl?.contentWindow !== target
            ) {
                cancelCardBootstrapRetry?.();
                cancelCardBootstrapRetry = undefined;
                return;
            }
            target.postMessage(buildCardBootstrap(loadedNonce), "*");
        });
    }

    function onBridgeMessage(event: MessageEvent) {
        if (
            iframeEl === undefined ||
            !isCardBridgeEventForFrame(event, iframeEl.contentWindow, "null", frameNonce)
        ) return;
        const msg = event.data;
        if (!isRecord(msg)) return;
        switch (msg.type) {
            case "oc:card:ready":
                if (readySeen) return;
                // Public rendering requires no recipient key. Key generation/disclosure starts only
                // after the separate host-owned private-context grant.
                if (!isCardPublicReadyMessage(msg, frameNonce) || candidateAppIdentity === undefined)
                    return;
                resolvedAppIdentity = candidateAppIdentity;
                readySeen = true;
                cancelCardBootstrapRetry?.();
                cancelCardBootstrapRetry = undefined;
                cardLoadFailed = false;
                break;
            case "oc:card:resize":
                if (cardActivated) {
                    const height = cardResizeHeightFromMessage(msg, frameNonce);
                    if (height !== undefined) {
                        cardHeight = clampCardHeight(height, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT);
                    }
                }
                break;
            case "oc:card:private-context-ready": {
                if (
                    !canAcceptCardPrivateContextReady({
                        explicitlyRequested: privateContextRequested,
                        featureAvailable: privateContextAvailable,
                        alreadyGranted: cardCapability !== undefined,
                        pending,
                        readonly,
                    })
                ) return;
                const recipientKey = decodeCardRecipientPublicKey(msg, frameNonce);
                if (recipientKey === undefined) return;
                void mintPrivateContextCapability(
                    recipientKey.scheme,
                    recipientKey.publicKey,
                );
                break;
            }
            case "oc:card:confirm":
                if (!cardConfirmable || busy || !cardActivated) return;
                approvalRequest = cardApprovalRequestFromMessage(msg, frameNonce);
                break;
            case "oc:card:cancel":
                if (!cardCancelable || busy || !cardActivated) return;
                approvalRequest = cardApprovalRequestFromMessage(msg, frameNonce);
                break;
        }
    }

    function dismissApproval(e: Event) {
        e.stopPropagation();
        approvalRequest = undefined;
        acknowledged = false;
    }

    async function approveRequest(e: Event) {
        e.stopPropagation();
        const request = approvalRequest;
        if (
            !canApproveCardRequest(
                request,
                (request?.kind === "cancel" ? cardCancelable : cardConfirmable) && cardActivated,
                busy,
                content.disclosure !== undefined,
                acknowledged,
            ) ||
            request === undefined
        ) return;
        approvalRequest = undefined;
        confirmationGrantFailed = false;
        if (request.kind === "cancel") {
            await doRespond("cancel");
            return;
        }

        const confirmPayload = encodeCardConfirmPayload(request);
        const cardKey = currentCardAttemptKey();
        if (confirmPayload === undefined || cardKey === undefined) return;
        const binding: CardConfirmationAttemptBinding = {
            frameNonce,
            cardKey,
            confirmPayload,
        };
        const attempt = beginCardConfirmationAttempt(confirmationAttempt, binding);
        if (attempt === undefined) return;
        confirmationAttempt = attempt;
        busy = true;
        try {
            const grant = await client.createAiAppCardConfirmationGrant(
                chatId,
                threadRootMessageIndex,
                messageId,
                attempt.confirmPayload.slice(),
            );
            const currentKey = currentCardAttemptKey();
            if (currentKey === undefined) return;
            const current: CardConfirmationAttemptBinding = {
                frameNonce,
                cardKey: currentKey,
                confirmPayload: attempt.confirmPayload,
            };
            if (!cardConfirmationAttemptStillCurrent(attempt, current, componentMounted)) return;
            if (grant === undefined || grant.expiresAt <= BigInt(Date.now())) {
                confirmationGrantFailed = true;
                return;
            }
            // The opaque grant never enters the iframe, URL, storage, or logs. The exact byte copy
            // attested above is passed with it to the authoritative chat canister exactly once.
            await onRespond?.(
                "confirm",
                attempt.confirmPayload.slice(),
                grant.grant.slice(),
            );
        } finally {
            if (confirmationAttempt === attempt) confirmationAttempt = undefined;
            busy = false;
            acknowledged = false;
        }
    }

    $effect(() => {
        // Only listen once we actually have an embedded card; teardown removes it (Svelte runs the
        // returned cleanup on destroy and before each re-run).
        if (cardUrl === undefined || !loadRequested) return;
        window.addEventListener("message", onBridgeMessage);
        return () => window.removeEventListener("message", onBridgeMessage);
    });

    $effect(() => {
        if (cardUrl === undefined || !loadRequested || readySeen) return;
        const expectedNonce = frameNonce;
        return startCardHandshakeTimeout(() => {
            if (!loadRequested || readySeen || frameNonce !== expectedNonce) return;
            loadRequested = false;
            cardLoadFailed = true;
            resetFrameSession();
        });
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

    $effect(() => {
        // Relay the confirm/cancel round-trip state (`busy`) into the app card so it can lock its own
        // in-frame buttons and show progress. Reading `busy` registers it as the dependency. Posted only
        // to the exact frame WindowProxy after the handshake; a bare boolean carries no data. The confirm
        // handler already screens re-entrancy and per-action authority, so this is presentation-only.
        const _busy = busy;
        const target = iframeEl?.contentWindow;
        if (readySeen && cardUrl !== undefined && cardOrigin !== undefined && target != null) {
            target.postMessage(buildCardBusy(_busy, frameNonce), "*");
        }
    });

    $effect(() => {
        // Any state/context transition invalidates a pending iframe request. The user must approve a
        // fresh snapshot from the currently active frame/card, never a stale request.
        const valid = cardCancelable && cardActivated && loadRequested && content.state === "pending";
        void messageId;
        void cardOrigin;
        if (!valid) {
            approvalRequest = undefined;
            acknowledged = false;
        }
    });
</script>

<div class="action-card" class:collapsed class:has-frame={cardUrl !== undefined}>
    <div
        class="app-identity"
        class:unverified={!cardContentAttested || (appResolutionComplete && resolvedAppIdentity === undefined)}
        aria-live="polite"
    >
        {#if resolvedAppIdentity !== undefined}
            <AiAppIcon iconUrl={resolvedAppIdentity.iconUrl} size={"1.5rem"} />
            <div class="app-identity-text">
                <span class="app-name">Directory entry: {resolvedAppIdentity.name}</span>
                <span class="app-id">App ID <code>{resolvedAppIdentity.id}</code></span>
            </div>
        {:else if appResolutionComplete}
            <span class="app-verification">Unverified card binding</span>
            <span class="app-id">Directory coordinates unavailable</span>
        {:else}
            <span class="app-verification">Verifying app identity…</span>
        {/if}
        {#if resolvedAppIdentity !== undefined}
            <span class="app-verification">Directory binding only; card content is untrusted</span>
        {/if}
    </div>

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
        }}
    >
        <div class="sender-title">
            <span class="sender-title-label">Untrusted card text</span>
            <span class="title">{content.title}</span>
        </div>
        {#if consumed}
            <div class="state state-{displayState}">{displayState}</div>
            <span class="chevron" class:collapsed>▾</span>
        {/if}
    </div>

    {#if !collapsed}
        {#if cardUrl !== undefined && !useClassicFallback}
            {#if !loadRequested}
                <div class="card-load-gate">
                    <strong>{candidateAppIdentity?.name ?? "Registered app"}</strong>
                    <span>
                        App ID <code>{candidateAppIdentity?.id ?? cardAppId}</code>
                    </span>
                    <span>Destination: <code>{cardOrigin}</code></span>
                    <span>Exact card URL: <code>{cardUrl}</code></span>
                    <span>
                        Loading contacts this external origin and shares the existing card fields plus
                        app/revision/action, message, optional thread, and stable chat identifiers. In
                        a direct chat, the chat identity contains both participant identifiers.
                    </span>
                    <span>
                        If you separately grant private context later, redemption also reveals your
                        stable OpenChat user ID and this tab's recipient-key scheme/public key, then
                        returns encrypted app-defined private data. Capabilities never enter this URL.
                    </span>
                    <button
                        disabled={readonly || !pending || !credentiallessSupported}
                        onclick={requestCardLoad}
                    >
                        {cardLoadFailed ? "Retry app card" : "Load app card"}
                    </button>
                    {#if !credentiallessSupported}
                        <span class="card-load-error">
                            Secure embedded loading is unavailable in this browser.
                        </span>
                    {/if}
                    {#if cardLoadFailed}
                        <span class="card-load-error">
                            The app card did not complete its isolated handshake in time.
                        </span>
                        <button onclick={chooseClassicFallback}>Use read-only OpenChat summary</button>
                    {/if}
                </div>
            {:else}
            <div class="untrusted-frame-label">Untrusted app content</div>
            <!-- App-rendered card pixels remain untrusted. The opaque sandbox prevents redirects from
                 inheriting any destination origin; the height is driven by the nonce-bound bridge. -->
            <!-- credentialless: OpenChat is cross-origin-isolated (COEP: credentialless) for its wasm
                 inference, which otherwise ERR_BLOCKED_BY_RESPONSE a cross-origin iframe. The
                 credentialless attribute loads the app card in an anonymous context (no cookies /
                 partitioned storage — the card page needs no session anyway), which is permitted
                 inside a COEP document. -->
            <iframe
                bind:this={iframeEl}
                class="card-frame"
                class:inactive={!cardActivated}
                title="Isolated action app card"
                src={cardUrl}
                credentialless
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                onload={onIframeLoad}
                style={`height: ${cardActivated ? cardHeight : 1}px;`}
            ></iframe>
            {#if !cardActivated}
                <div class="card-loading" aria-live="polite">
                    {capabilityPending ? "Verifying app card…" : "Waiting for the isolated app…"}
                </div>
            {/if}

            {#if approvalRequest !== undefined && cardActivated}
                <div class="host-approval" role="group" aria-label="Approve app card request">
                    <strong>
                        {approvalRequest.kind === "confirm"
                            ? "The app requests confirmation"
                            : "The app requests cancellation"}
                    </strong>
                    <pre class="approval-summary">{canonicalCardApprovalSummary(approvalRequest)}</pre>
                    {#if approvalRequest.kind === "confirm" && content.disclosure !== undefined}
                        <label class="disclosure" onclick={(e) => e.stopPropagation()}>
                            <input type="checkbox" bind:checked={acknowledged} disabled={busy} />
                            <span>{content.disclosure}</span>
                        </label>
                    {/if}
                    <div class="actions">
                        <button class="cancel" disabled={busy} onclick={dismissApproval}>Dismiss</button>
                        <button
                            class="confirm"
                            disabled={!canApprovePendingRequest}
                            onclick={approveRequest}
                        >
                            {#if busy}
                                <Spinner size="1.1em" foregroundColour="transparent" />
                            {:else if approvalRequest.kind === "confirm"}
                                Confirm request
                            {:else}
                                Cancel card
                            {/if}
                        </button>
                    </div>
                </div>
            {/if}

            {#if cardActivated && cardCancelable && !finalConfirmationAvailable}
                <div class="host-approval" role="group" aria-label="Card actions">
                    <span class="card-load-error">
                        Confirmation is disabled until the server binds the exact final payload to
                        this viewer, card, and app revision.
                    </span>
                    <div class="actions">
                        <button
                            class="cancel"
                            disabled={busy}
                            onclick={(e) => respond("cancel", e)}>Cancel card</button>
                    </div>
                </div>
            {/if}

            {#if confirmationGrantFailed}
                <div class="card-load-error" role="alert">
                    The exact confirmation payload could not be authorized. Review the request and try
                    again; no payload was submitted.
                </div>
            {/if}

            {#if cardActivated && cardCapability === undefined}
                <div class="private-context-consent">
                    <strong>Private app context is not shared</strong>
                    <span>
                        A separate grant can let the registered app show viewer-owned details, such as
                        an account-defined type. Redemption is bound to this viewer, chat, thread,
                        message, app revision, action, frame nonce, and recipient key. OpenChat treats
                        the returned app payload as opaque.
                    </span>
                    <button
                        disabled={!privateContextAvailable || capabilityPending || !pending || readonly}
                        onclick={requestPrivateContext}
                    >
                        {capabilityPending ? "Preparing private context…" : "Share private context"}
                    </button>
                    {#if !privateContextAvailable}
                        <span>
                            Private-context grant remains disabled until the backend and registered app
                            redemption/decryption contracts align.
                        </span>
                    {:else}
                        <span>
                            The short-lived capability is delivered only to this isolated frame and is
                            never stored or shown in the URL. Other chat members receive no
                            viewer-private fields.
                        </span>
                    {/if}
                </div>
            {/if}
            {/if}
        {:else}
            {#if cardContentAttestationBlocked}
                <div class="card-load-error" role="alert">
                    This card's app/revision/action coordinates match the directory, but its title,
                    rows, and payload are not attested as app-authored. App rendering and confirmation
                    are disabled.
                </div>
            {/if}
            {#if appCardRenderingBlocked}
                <div class="card-load-error" role="status">
                    App rendering is disabled by this client's release gate.
                </div>
            {/if}
            {#if cardUrl !== undefined && useClassicFallback}
                <div class="card-load-error" role="status">
                    Showing the OpenChat summary only. Exact app payload is not available to this
                    authorized view, so confirmation is disabled.
                    <button onclick={requestCardLoad}>Retry isolated app card</button>
                </div>
            {/if}
            <table class="rows">
                <tbody>
                    <!-- Reserved legacy rows are discarded fail-closed; they are never parsed or
                         forwarded as app data. -->
                    {#each visibleRows(content.rows) as row}
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
                        disabled={!pending || readonly || !cardContentAttested}
                    />
                    <span>{content.disclosure}</span>
                </label>
            {/if}

            {#if pending}
                {#if !cardContentAttested}
                    <span class="card-load-error">
                        Confirmation requires a verified app-rendered card or an authorized
                        exact-payload endpoint.
                    </span>
                {/if}
                <!-- stopPropagation: in the mobile layout the whole bubble is wrapped in a MenuTrigger, so an
                     unstopped click on these controls would also open the message context menu. -->
                <div class="actions">
                    <button
                        class="cancel"
                        disabled={readonly || busy}
                        onclick={(e) => respond("cancel", e)}
                    >
                        {content.cancelLabel}
                    </button>
                    <button
                        class="confirm"
                        disabled={!canConfirm || busy}
                        onclick={(e) => respond("confirm", e)}
                    >
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

        // Collapsed (consumed) cards shrink to a slim strip: just the header line (title + status +
        // chevron), tighter padding, smaller type. The min-width nudges the hugging bubble wider, but
        // it MUST be bounded by the space actually available: the bubble is capped at a percentage of
        // the message COLUMN, which is far narrower than the viewport (a left panel, and optionally a
        // right one, sit beside it). A viewport-relative `min(75vw, 480px)` therefore pushed the strip
        // straight through the bubble — measured up to +285px past its right edge, escaping entirely
        // because .message-bubble sets no overflow — which is the card visibly outside the UI bounds.
        // `min(480px, 100%)` keeps the widening intent but can never exceed the parent.
        &.collapsed {
            max-width: none;
            min-width: min(480px, 100%);
            gap: 0;
            padding: $sp2 $sp3;
            font-size: 0.8em;
        }
    }

    .app-identity {
        display: flex;
        align-items: center;
        gap: $sp2;
        min-width: 0;
        padding-bottom: $sp2;
        border-bottom: var(--bw) solid var(--bd);
        font-size: var(--font-size-small, 0.85em);

        &.unverified {
            color: var(--warning);
        }
    }

    .app-identity-text {
        display: flex;
        align-items: baseline;
        gap: $sp2;
        min-width: 0;
        flex-wrap: wrap;
    }

    .app-name,
    .app-verification {
        font-weight: 700;
    }

    .app-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .app-id {
        color: var(--currentChat-msg-muted);
        white-space: nowrap;

        code {
            font-family: monospace;
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

    .sender-title {
        display: flex;
        align-items: baseline;
        gap: $sp2;
        flex: 1;
        min-width: 0;
    }

    .sender-title-label {
        color: var(--currentChat-msg-muted);
        font-size: 0.72em;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
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
        // An <iframe> is a replaced element: `width: 100%` contributes NOTHING to intrinsic sizing, so
        // in a shrink-to-fit bubble the card hugged the iframe's default intrinsic 300px and the
        // `max-width: min(90vw, 420px)` above was never reached. A narrower frame also makes the same
        // content taller (measured 487px tall at 300px wide vs 450px at 420px), so this fed the
        // "too tall when expanded" symptom. Give it the intended width, bounded by the bubble.
        width: 420px;
        max-width: 100%;
        border: none;
        border-radius: var(--rd);
        display: block;
        background-color: transparent;
        // Height is authoritative from the resize bridge; this is only the pre-handshake floor.
        min-height: 140px;

        &.inactive {
            position: absolute;
            width: 1px;
            min-height: 0;
            visibility: hidden;
            pointer-events: none;
        }
    }

    .card-load-gate,
    .card-loading,
    .host-approval,
    .private-context-consent {
        display: flex;
        flex-direction: column;
        gap: $sp2;
        padding: $sp3;
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }

    .card-load-gate button,
    .private-context-consent button {
        align-self: flex-start;
    }

    .card-load-error {
        color: var(--warning);
    }

    .untrusted-frame-label {
        color: var(--warning);
        font-size: 0.8em;
        font-weight: 700;
    }

    .approval-summary {
        max-height: 14rem;
        margin: 0;
        padding: $sp2;
        overflow: auto;
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        direction: ltr;
        unicode-bidi: plaintext;
        isolation: isolate;
        font: inherit;
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
