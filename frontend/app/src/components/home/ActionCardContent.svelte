<script lang="ts">
    import {
        type ActionCardContent,
        type AiAppCardCapability,
        aiAppCardChatContext,
        chatIdentifierToString,
        type ChatIdentifier,
        OpenChat,
    } from "@client";
    import { getContext, onMount, untrack } from "svelte";
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
        buildCardCollectConfirm,
        buildCardInit,
        buildCardPrivateContextRequest,
        beginCardCapabilityAttempt,
        beginCardCollectAttempt,
        beginCardConfirmationAttempt,
        canAcceptCardPrivateContextReady,
        cardAttemptKey,
        cardCapabilityAttemptStillCurrent,
        cardCollectAttemptStillCurrent,
        cardConfirmationAttemptStillCurrent,
        cardCollectedConfirmFromMessage,
        cardPrivateContextStatusFromMessage,
        cardResizeHeightFromMessage,
        clampCardHeight,
        completelyReverseMapMultiRows,
        completelyReverseMapRows,
        decodeConfirmPayload,
        decodeCardRecipientPublicKey,
        deriveCardOrigin,
        encodeCardConfirmPayload,
        isCardBridgeEventForFrame,
        isCardPublicReadyMessage,
        isAppCardContentAttested,
        isMultiEntrySummaryRows,
        isRecord,
        newCardFrameNonce,
        settleCardOperationBeforeTimeout,
        supportsCredentiallessIframe,
        startCardHandshakeTimeout,
        startCardPrivateContextHydrationTimeout,
        startCardBootstrapRetry,
        startCardCollectTimeout,
        visibleRows,
        type CardCapabilityAttemptBinding,
        type CardCollectAttemptBinding,
        type CardConfirmationAttemptBinding,
    } from "../../utils/cardBridge";
    import Spinner from "../icons/Spinner.svelte";
    import AiAppIcon from "./communities/explore/AiAppIcon.svelte";

    // Generic interactive confirm card. Two render modes:
    //   1. The card's owning app declares a "card" surface, so the app owns the pixels: OpenChat
    //      embeds the app's page in an iframe. The user edits values inside the frame, then one
    //      host-owned click challenges it for a nonce-bound snapshot; the host obtains a one-time
    //      exact-byte server grant and submits directly. Unsolicited app confirms have no authority.
    //   2. No safely reconstructable "card" surface → host-owned public rows plus the immutable,
    //      backend-attested stored-payload confirmation path.
    interface Props {
        content: ActionCardContent;
        readonly: boolean;
        // The chat this card lives in — used to locate the owning app's card surface and to build the
        // bridge `context.chatKey`.
        chatId: ChatIdentifier;
        messageId: bigint;
        threadRootMessageIndex?: number;
        viewerId: string;
        // Production reconciles an optimistic message in place, then flips the enclosing message's
        // authoritative edge. This value is only a reactive wake-up signal: trust is always reread
        // from the backend-hydrated card fields below and is never inferred from this boolean.
        reconciliationTrigger?: boolean;
        // App-rendered confirms carry exact encoded bytes plus the matching one-time server grant.
        // Classic OC-rendered cards call this with neither value and use the stored attested payload.
        onRespond?: (
            response: "confirm" | "cancel",
            confirmPayloadOverride?: Uint8Array,
            confirmationGrant?: Uint8Array,
        ) => boolean | Promise<boolean>;
    }

    let {
        content,
        readonly,
        chatId,
        messageId,
        threadRootMessageIndex,
        viewerId,
        reconciliationTrigger = false,
        onRespond,
    }: Props = $props();

    const client = getContext<OpenChat>("client");
    let resolvedAppIdentity = $state<AuthoritativeAppIdentity | undefined>(undefined);
    let candidateAppIdentity = $state<AuthoritativeAppIdentity | undefined>(undefined);
    let hasPersistentUserPairing = $state(false);
    let appResolutionComplete = $state(false);
    let appResolutionLookupAttempted = $state(false);
    let appResolutionRetryAttempt = $state(0);
    let credentiallessSupported = $state(false);
    let cardContentAttestationBlocked = $state(false);
    let appCardRenderingBlocked = $state(false);
    let cardContentAttested = $derived.by(() => {
        // Wake this derivation after an in-place optimistic -> authoritative mutation, then inspect
        // the actual attestation fields. The edge itself confers no authority.
        void reconciliationTrigger;
        return isAppCardContentAttested(content);
    });
    // Keep resolution dependent on primitive security coordinates. Equivalent message-object
    // replacements must not tear down a live frame, while the reconciliation edge still makes each
    // primitive reread an in-place authoritative mutation.
    let resolutionAppVerified = $derived.by(() => {
        void reconciliationTrigger;
        return content.appVerified === true;
    });
    let resolutionContentAttested = $derived(cardContentAttested);
    let resolutionActionId = $derived.by(() => {
        void reconciliationTrigger;
        return content.actionId;
    });
    let resolutionAppId = $derived.by(() => {
        void reconciliationTrigger;
        return content.appId;
    });
    let resolutionAppRevision = $derived.by(() => {
        void reconciliationTrigger;
        return content.appRevision;
    });
    // A locally-posted provenance-backed card is intentionally untrusted until the send response
    // reconciles it with the canister's verification bits. Keep one stable neutral shell during
    // that short window; never flash sender-controlled title/rows as an "unverified card" first.
    let optimisticVerificationPending = $derived.by(() => {
        void reconciliationTrigger;
        return (
            !reconciliationTrigger &&
            content.appProvenance !== undefined &&
            content.appProvenance.byteLength > 0 &&
            (content.appVerified !== true || !isAppCardContentAttested(content))
        );
    });
    let resolutionChatKey = $derived(chatIdentifierToString(chatId));
    const finalConfirmationAvailable = appCardFinalConfirmationAvailable();
    const privateContextAvailable = appCardPrivateContextAvailable();

    // The canister response may arrive before the authoritative message replacement. Keep the exact
    // card locally consumed across that reconciliation window so repeated Add clicks cannot submit
    // the same action twice. Equivalent chat objects intentionally produce the same semantic key.
    let cardSubmissionKey = $derived(
        JSON.stringify([
            viewerId,
            resolutionChatKey,
            threadRootMessageIndex ?? null,
            messageId.toString(),
            content.actionId,
            content.appId ?? null,
            content.appRevision?.toString() ?? null,
        ]),
    );
    let submittedCardKey = $state<string | undefined>(undefined);
    let submitted = $derived(submittedCardKey === cardSubmissionKey);

    // While a confirm/cancel round-trips to the canister (and, on confirm, encrypts + deposits the
    // action), show a spinner and lock both buttons so the press is acknowledged and can't be
    // double-fired. Resets on completion whether the call succeeds OR fails — a failed deposit now
    // surfaces as an error, and the card must become actionable again rather than spin forever.
    let busy = $state(false);
    async function doRespond(
        response: "confirm" | "cancel",
        confirmPayloadOverride?: Uint8Array,
        confirmationGrant?: Uint8Array,
    ): Promise<boolean> {
        if (
            response === "confirm" &&
            (!cardContentAttested ||
                resolvedAppIdentity === undefined ||
                !finalConfirmationAvailable)
        )
            return false;
        if (
            (confirmPayloadOverride === undefined) !== (confirmationGrant === undefined) ||
            (response === "cancel" &&
                (confirmPayloadOverride !== undefined || confirmationGrant !== undefined))
        )
            return false;
        if (busy || (response === "confirm" && submitted)) return false;
        const submissionKey = cardSubmissionKey;
        busy = true;
        try {
            const succeeded =
                (await onRespond?.(
                    response,
                    confirmPayloadOverride?.slice(),
                    confirmationGrant?.slice(),
                )) === true;
            if (
                response === "confirm" &&
                succeeded &&
                cardSubmissionKey === submissionKey
            ) {
                submittedCardKey = submissionKey;
            }
            return succeeded;
        } catch {
            return false;
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
    let useClassicFallback = $state(false);
    // A trusted card whose public rows cannot be losslessly reconstructed as one app input (most
    // notably an Entry 1..N batch) stays in OpenChat's immutable stored-payload renderer. Keep the
    // exact registered URL visible without loading the external frame.
    let useStoredPayloadCard = $state(false);
    let canConfirm = $derived(
        pending &&
            !readonly &&
            resolvedAppIdentity !== undefined &&
            cardContentAttested &&
            finalConfirmationAvailable &&
            !submitted &&
            !useClassicFallback &&
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
    let cardConfirmable = $derived(cardCancelable && finalConfirmationAvailable && !submitted);
    let cardReadonly = $derived(!cardConfirmable);

    // Resolved lazily from the owning app's manifest. While undefined we render today's rows, so an app
    // with no "card" surface (or any lookup failure) is fully backward compatible.
    let cardUrl = $state<string | undefined>(undefined);
    let cardOrigin = $state<string | undefined>(undefined);
    let cardAppId = $state<number | undefined>(undefined);
    let loadRequested = $state(false);
    let capabilityPending = $state(false);
    let privateContextRequested = $state(false);
    let privateContextHydrated = $state(false);
    let confirmationFailed = $state(false);
    let cardCollectionFailed = $state(false);
    let cardCapability = $state<AiAppCardCapability | undefined>(undefined);
    let capabilityAttempt: CardCapabilityAttemptBinding | undefined;
    let collectAttempt: CardCollectAttemptBinding | undefined;
    let confirmationAttempt: CardConfirmationAttemptBinding | undefined;
    let cancelPrivateContextTimeout: (() => void) | undefined;
    let cancelPrivateContextHydrationTimeout: (() => void) | undefined;
    let cancelCardBootstrapRetry: (() => void) | undefined;
    let cancelCollectTimeout: (() => void) | undefined;
    let componentMounted = false;
    let frameNonce = $state(newCardFrameNonce());
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
    // A durable per-user pairing means the app may have account-private values (for example a saved
    // Type) to restore. Do not let the host collect the public-only first render while that restoration
    // is absent or in flight. An unpaired card has no private context to wait for and stays one-click
    // confirmable without any Share/Restore ceremony.
    let persistentPrivateContextReady = $derived(
        !hasPersistentUserPairing ||
            (privateContextAvailable &&
                cardCapability !== undefined &&
                privateContextHydrated &&
                !capabilityPending),
    );
    let canCollectConfirm = $derived(
        cardConfirmable &&
            cardActivated &&
            persistentPrivateContextReady &&
            !busy &&
            (content.disclosure === undefined || acknowledged),
    );

    function currentCardAttemptKey(): string | undefined {
        const chat = aiAppCardChatContext(chatId, viewerId);
        if (
            chat === undefined ||
            cardAppId === undefined ||
            content.appRevision === undefined ||
            resolvedAppIdentity?.id !== cardAppId
        )
            return undefined;
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

    // Component lifetime is separate from the reactive app-resolution lifetime below.
    onMount(() => {
        componentMounted = true;
        credentiallessSupported = supportsCredentiallessIframe();
        return () => {
            componentMounted = false;
            cancelPrivateContextTimeout?.();
            cancelPrivateContextHydrationTimeout?.();
            cancelCardBootstrapRetry?.();
            cancelCollectTimeout?.();
            cancelCardBootstrapRetry = undefined;
            cancelPrivateContextHydrationTimeout = undefined;
            cancelCollectTimeout = undefined;
            capabilityAttempt = undefined;
            collectAttempt = undefined;
            confirmationAttempt = undefined;
        };
    });

    // Re-run app resolution when an optimistic local card is replaced by backend-hydrated
    // verification, or when any immutable producer coordinate changes. The lookup remains gated on
    // appVerified and exact app/revision/action/chat coordinates; full content attestation remains a
    // separate prerequisite for loading trusted app pixels.
    $effect(() => {
        // A retry click only causes a fresh attempt. It is not a trust claim; the derived primitives
        // above always come from the backend-hydrated card marker, attestation, and coordinates.
        const retryAttempt = appResolutionRetryAttempt;
        void retryAttempt;
        const appVerified = resolutionAppVerified;
        const contentAttested = resolutionContentAttested;
        const actionId = resolutionActionId;
        const appId = resolutionAppId;
        const appRevision = resolutionAppRevision;
        const activeChatKey = resolutionChatKey;
        const activeChatId = untrack(() => chatId);
        let cancelled = false;

        // Session reset reads timers and handshake state. Keep those reads outside this effect's
        // dependency graph so iframe activity cannot restart authoritative app resolution.
        untrack(() => {
            resetFrameSession();
            appResolutionComplete = false;
            appResolutionLookupAttempted = false;
            resolvedAppIdentity = undefined;
            candidateAppIdentity = undefined;
            hasPersistentUserPairing = false;
            cardContentAttestationBlocked = false;
            appCardRenderingBlocked = false;
            cardOrigin = undefined;
            cardAppId = undefined;
            cardLabelToField = {};
            cardUrl = undefined;
            loadRequested = false;
            useClassicFallback = false;
            useStoredPayloadCard = false;
        });

        if (!appVerified) {
            appResolutionComplete = true;
            return () => {
                cancelled = true;
            };
        }
        appResolutionLookupAttempted = true;
        void settleCardOperationBeforeTimeout(() =>
            resolveActionAppForCard(client, activeChatId, actionId, appId, appRevision),
        ).then((settlement) => {
                if (cancelled || resolutionChatKey !== activeChatKey) return;
                appResolutionComplete = true;
                if (settlement.status !== "settled") return;
                const resolution = settlement.value;
                if (resolution === undefined) return;
                appResolutionLookupAttempted = false;
                candidateAppIdentity = resolution.identity;
                resolvedAppIdentity = resolution.identity;
                hasPersistentUserPairing = resolution.hasPersistentUserPairing;
                const opening = resolution.cardSurface;
                if (opening === undefined) return;
                if (!contentAttested) {
                    // appVerified currently proves only registry coordinates. The sender still controls
                    // title/rows/payload, so do not load trusted app pixels until the backend attests the
                    // complete canonical card content.
                    cardContentAttestationBlocked = true;
                    return;
                }
                if (!appCardRenderingAvailable(contentAttested)) {
                    // Backend attestation is necessary but does not by itself activate an unfinished
                    // client capability. Keep the iframe closed unless this exact local client release
                    // has also been explicitly armed.
                    appCardRenderingBlocked = true;
                    return;
                }
                const origin = deriveCardOrigin(opening.url, {
                    allowLocalDevelopment: import.meta.env.DEV,
                });
                // No parseable origin → decline to embed; stay on the OC-rendered rows rather than talk to
                // an unknown origin.
                if (origin === undefined) return;
                // A successful provenance-backed send retains a defensive in-memory copy of the
                // exact attested payload for this sender session. That is sufficient to restore the
                // app's editable multi form (`decodeConfirmPayload` wraps its array as `{entries}`).
                // Received/reloaded canonical multi cards reconstruct only their manifest-declared
                // public summary fields. Ambiguous or legacy summaries remain immutable.
                const decodedPayload = decodeConfirmPayload(content.confirmPayload);
                const hasDecodedPayload = Object.keys(decodedPayload).length > 0;
                const mappedPayload = isMultiEntrySummaryRows(content.rows)
                    ? completelyReverseMapMultiRows(content.rows, opening.labelToField)
                    : completelyReverseMapRows(content.rows, opening.labelToField);
                if (!hasDecodedPayload && mappedPayload === undefined) {
                    cardUrl = opening.url;
                    useStoredPayloadCard = true;
                    return;
                }
                cardOrigin = origin;
                cardAppId = opening.app.id;
                cardLabelToField = opening.labelToField;
                cardUrl = opening.url;
                // App enablement/pairing plus complete backend content attestation is the durable
                // public-rendering boundary. Keep the anonymous iframe requirement fail-closed.
                credentiallessSupported = supportsCredentiallessIframe();
                if (credentiallessSupported) {
                    loadRequested = true;
                    resetFrameSession();
                } else {
                    useClassicFallback = true;
                }
            });
        return () => {
            cancelled = true;
        };
    });

    function retryAppResolution(e: Event) {
        e.stopPropagation();
        appResolutionRetryAttempt += 1;
    }

    function postInit() {
        const target = iframeEl?.contentWindow;
        if (
            target === null ||
            target === undefined ||
            cardOrigin === undefined ||
            cardAppId === undefined ||
            content.appRevision === undefined
        )
            return;
        // The locally available exact confirmPayload wins. Received cards intentionally do not hydrate
        // it, so their public init is reconstructed only from safe manifest-mapped public rows. Private
        // app data is never recovered from a hidden row; it requires the separately authorized encrypted
        // private-context path.
        const decoded = decodeConfirmPayload(content.confirmPayload);
        const mappedRows = isMultiEntrySummaryRows(content.rows)
            ? completelyReverseMapMultiRows(content.rows, cardLabelToField)
            : completelyReverseMapRows(content.rows, cardLabelToField);
        if (Object.keys(decoded).length === 0 && mappedRows === undefined) {
            // Revalidate at the bridge boundary. If live content ever changes without immutable
            // producer coordinates changing, remove the frame instead of sending partial data.
            loadRequested = false;
            useClassicFallback = true;
            resetFrameSession();
            return;
        }
        const data: Record<string, unknown> =
            Object.keys(decoded).length > 0 ? decoded : (mappedRows ?? Object.create(null));
        const init = buildCardInit(
            data,
            {
                appId: cardAppId,
                appRevision: content.appRevision,
                actionId: content.actionId,
                theme: $currentTheme.mode,
                readonly: cardReadonly,
                privateContext: cardCapability,
            },
            frameNonce,
        );
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
        cancelPrivateContextHydrationTimeout?.();
        cancelPrivateContextHydrationTimeout = undefined;
        cancelCollectTimeout?.();
        cancelCollectTimeout = undefined;
        if (collectAttempt !== undefined || confirmationAttempt !== undefined) busy = false;
        frameNonce = newCardFrameNonce();
        readySeen = false;
        capabilityPending = false;
        privateContextRequested = false;
        privateContextHydrated = false;
        cardCapability = undefined;
        capabilityAttempt = undefined;
        collectAttempt = undefined;
        confirmationAttempt = undefined;
        confirmationFailed = false;
        cardCollectionFailed = false;
        acknowledged = false;
    }

    function requestCardLoad(e: Event) {
        e.stopPropagation();
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

    function beginPrivateContextRequest() {
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
        )
            return;
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

    function requestPrivateContext(e: Event) {
        e.stopPropagation();
        beginPrivateContextRequest();
    }

    function clearPrivateContextAfterHydrationFailure(
        expectedFrameNonce: string,
        expectedCapability: string,
    ) {
        if (frameNonce !== expectedFrameNonce || cardCapability?.capability !== expectedCapability)
            return;
        cancelPrivateContextHydrationTimeout?.();
        cancelPrivateContextHydrationTimeout = undefined;
        privateContextHydrated = false;
        cardCapability = undefined;
        // Revoke the failed capability from the live frame as well as host state. A fresh Restore
        // request is then the only route back to paired confirmation readiness.
        postInit();
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
            const capabilityResult = await settleCardOperationBeforeTimeout(() =>
                client.createAiAppCardCapability(
                    chatId,
                    threadRootMessageIndex,
                    messageId,
                    attempt.recipientKeyScheme,
                    attempt.recipientPublicKey.slice(),
                ),
            );
            if (capabilityResult.status === "failed") return;
            const capability = capabilityResult.value;
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
                capability.capability.length === 0 ||
                capability.expiresAt <= BigInt(Date.now()) ||
                !cardCapabilityAttemptStillCurrent(attempt, current, componentMounted)
            )
                return;
            cardCapability = capability;
            privateContextHydrated = false;
            const capabilityNonce = attempt.frameNonce;
            const capabilityValue = capability.capability;
            cancelPrivateContextHydrationTimeout?.();
            cancelPrivateContextHydrationTimeout = startCardPrivateContextHydrationTimeout(() =>
                clearPrivateContextAfterHydrationFailure(capabilityNonce, capabilityValue),
            );
            postInit();
        } catch {
            // A durable pairing may carry account-private values that affect the exact payload, so a
            // failed restoration stays fail closed. `finally` exposes one explicit paired retry and
            // never auto-loops or leaks dependency details.
        } finally {
            // A stale mint may finish after navigation/reset or after a newer retry started. It must
            // not release the newer attempt's latch or enable Add against an unhydrated frame.
            if (capabilityAttempt === attempt) {
                capabilityAttempt = undefined;
                capabilityPending = false;
            }
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
        )
            return;
        const msg = event.data;
        if (!isRecord(msg)) return;
        switch (msg.type) {
            case "oc:card:ready":
                if (readySeen) return;
                // Public rendering requires no recipient key. Key generation/disclosure starts only
                // after the separate host-owned private-context grant.
                if (
                    !isCardPublicReadyMessage(msg, frameNonce) ||
                    candidateAppIdentity === undefined
                )
                    return;
                resolvedAppIdentity = candidateAppIdentity;
                readySeen = true;
                cancelCardBootstrapRetry?.();
                cancelCardBootstrapRetry = undefined;
                // The viewer's non-empty per-user app key is durable app-specific consent. Restore
                // encrypted app context once per ready handshake only while this card is actionable;
                // beginPrivateContextRequest retains all pending/readonly/feature/key guards.
                if (hasPersistentUserPairing) beginPrivateContextRequest();
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
                )
                    return;
                const recipientKey = decodeCardRecipientPublicKey(msg, frameNonce);
                if (recipientKey === undefined) return;
                void mintPrivateContextCapability(recipientKey.scheme, recipientKey.publicKey);
                break;
            }
            case "oc:card:private-context-status": {
                const capability = cardCapability;
                if (capability === undefined) return;
                const status = cardPrivateContextStatusFromMessage(
                    msg,
                    frameNonce,
                    capability.capability,
                );
                if (status === undefined) return;
                if (status === "error" || capability.expiresAt <= BigInt(Date.now())) {
                    clearPrivateContextAfterHydrationFailure(frameNonce, capability.capability);
                    return;
                }
                cancelPrivateContextHydrationTimeout?.();
                cancelPrivateContextHydrationTimeout = undefined;
                privateContextHydrated = true;
                break;
            }
            case "oc:card:confirm-collected":
                void submitCollectedConfirm(msg);
                break;
        }
    }

    function requestHostConfirmation(e: Event) {
        e.stopPropagation();
        const target = iframeEl?.contentWindow;
        const cardKey = currentCardAttemptKey();
        if (!canCollectConfirm || target == null || cardKey === undefined) return;
        const binding: CardCollectAttemptBinding = {
            frameNonce,
            requestNonce: newCardFrameNonce(),
            cardKey,
        };
        const attempt = beginCardCollectAttempt(collectAttempt, binding);
        if (attempt === undefined) return;
        collectAttempt = attempt;
        busy = true;
        confirmationFailed = false;
        cardCollectionFailed = false;
        cancelCollectTimeout?.();
        cancelCollectTimeout = startCardCollectTimeout(() => {
            if (collectAttempt !== attempt) return;
            collectAttempt = undefined;
            cancelCollectTimeout = undefined;
            busy = false;
            cardCollectionFailed = true;
        });
        // This is the authority-bearing human gesture. The trusted frame may return its current
        // snapshot only for this fresh challenge; unsolicited app confirm/cancel messages are ignored.
        target.postMessage(buildCardCollectConfirm(attempt.frameNonce, attempt.requestNonce), "*");
    }

    async function submitCollectedConfirm(message: unknown) {
        const attempt = collectAttempt;
        const cardKey = currentCardAttemptKey();
        const submissionKey = cardSubmissionKey;
        if (attempt === undefined || cardKey === undefined || !cardConfirmable || !cardActivated)
            return;
        const currentCollection: CardCollectAttemptBinding = {
            frameNonce,
            requestNonce: attempt.requestNonce,
            cardKey,
        };
        if (!cardCollectAttemptStillCurrent(attempt, currentCollection, componentMounted)) return;
        const payload = cardCollectedConfirmFromMessage(
            message,
            attempt.frameNonce,
            attempt.requestNonce,
        );
        if (payload === undefined) return;

        // Consume the click challenge before any async grant call. An exact replay therefore cannot
        // mint twice even while the first submission is still in flight.
        collectAttempt = undefined;
        cancelCollectTimeout?.();
        cancelCollectTimeout = undefined;
        const confirmPayload = encodeCardConfirmPayload({ kind: "confirm", payload });
        if (confirmPayload === undefined) {
            busy = false;
            cardCollectionFailed = true;
            return;
        }
        const binding: CardConfirmationAttemptBinding = {
            frameNonce: attempt.frameNonce,
            cardKey,
            confirmPayload,
        };
        const confirmation = beginCardConfirmationAttempt(confirmationAttempt, binding);
        if (confirmation === undefined) {
            busy = false;
            return;
        }
        confirmationAttempt = confirmation;
        const stillCurrent = (): boolean => {
            const currentKey = currentCardAttemptKey();
            if (currentKey === undefined) return false;
            const current: CardConfirmationAttemptBinding = {
                frameNonce,
                cardKey: currentKey,
                confirmPayload: confirmation.confirmPayload,
            };
            return !cardConfirmable ||
                !cardActivated ||
                !cardConfirmationAttemptStillCurrent(confirmation, current, componentMounted)
                ? false
                : true;
        };
        try {
            const grantResult = await settleCardOperationBeforeTimeout(() =>
                client.createAiAppCardConfirmationGrant(
                    chatId,
                    threadRootMessageIndex,
                    messageId,
                    confirmation.confirmPayload.slice(),
                ),
            );
            if (!stillCurrent()) return;
            if (grantResult.status === "failed") {
                confirmationFailed = true;
                return;
            }
            const grant = grantResult.value;
            if (grant === undefined || grant.expiresAt <= BigInt(Date.now())) {
                confirmationFailed = true;
                return;
            }
            // The opaque grant never enters the iframe, URL, storage, or logs. The exact byte copy
            // attested above is passed with it to the authoritative chat canister exactly once.
            const submitResult = await settleCardOperationBeforeTimeout(() =>
                onRespond?.("confirm", confirmation.confirmPayload.slice(), grant.grant.slice()),
            );
            if (!stillCurrent()) return;
            if (submitResult.status === "failed" || submitResult.value !== true) {
                confirmationFailed = true;
                return;
            }
            if (cardSubmissionKey === submissionKey) submittedCardKey = submissionKey;
        } finally {
            if (confirmationAttempt === confirmation) {
                confirmationAttempt = undefined;
                busy = false;
                acknowledged = false;
            }
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
        // Relay collect/grant/submit state into the app card so it freezes the values behind the
        // host-owned action. Reading `busy` registers it as the dependency. This bare boolean is posted
        // only to the exact frame WindowProxy and carries no app/canister data or authority.
        const _busy = busy;
        const target = iframeEl?.contentWindow;
        if (readySeen && cardUrl !== undefined && cardOrigin !== undefined && target != null) {
            target.postMessage(buildCardBusy(_busy, frameNonce), "*");
        }
    });

    $effect(() => {
        // Any state/context or final-grant availability transition invalidates a pending host-click
        // collection challenge. A response from an old frame/card can never inherit a newer card's
        // authority.
        const valid =
            cardConfirmable && cardActivated && loadRequested && content.state === "pending";
        void messageId;
        void cardOrigin;
        if (!valid && (collectAttempt !== undefined || confirmationAttempt !== undefined)) {
            collectAttempt = undefined;
            confirmationAttempt = undefined;
            cancelCollectTimeout?.();
            cancelCollectTimeout = undefined;
            busy = false;
            acknowledged = false;
        }
    });
</script>

<div
    class="action-card"
    class:collapsed
    class:pending-verification={optimisticVerificationPending}
    class:has-frame={cardUrl !== undefined && !useClassicFallback && !useStoredPayloadCard}
>
    <div
        class="app-identity"
        class:unverified={!optimisticVerificationPending &&
            (!cardContentAttested ||
                (appResolutionComplete && resolvedAppIdentity === undefined))}
        aria-live="polite"
    >
        {#if optimisticVerificationPending}
            <Spinner size="1.1em" foregroundColour="transparent" />
            <span class="app-verification">Verifying app card…</span>
        {:else if resolvedAppIdentity !== undefined}
            <AiAppIcon
                iconUrl={resolvedAppIdentity.iconUrl}
                size={"1.5rem"}
                trustedAutoLoad={cardContentAttested}
            />
            <div class="app-identity-text">
                <span class="app-name">{resolvedAppIdentity.name}</span>
            </div>
        {:else if appResolutionComplete}
            <span class="app-verification">Unverified card binding</span>
            <span class="app-id">Directory coordinates unavailable</span>
            {#if appResolutionLookupAttempted}
                <button class="retry-verification" onclick={retryAppResolution}
                    >Retry verification</button
                >
            {/if}
        {:else}
            <span class="app-verification">Verifying app identity…</span>
        {/if}
        {#if resolvedAppIdentity !== undefined}
            {#if !cardContentAttested}
                <span class="app-verification"
                    >Directory binding only; card content is untrusted</span
                >
            {/if}
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
            {#if optimisticVerificationPending}
                <span class="title">Preparing verified card…</span>
            {:else}
                {#if !cardContentAttested}
                    <span class="sender-title-label">Untrusted card text</span>
                {/if}
                <span class="title">{content.title}</span>
            {/if}
        </div>
        {#if consumed}
            <div class="state state-{displayState}">{displayState}</div>
            <span class="chevron" class:collapsed>▾</span>
        {/if}
    </div>

    {#if !collapsed}
        {#if optimisticVerificationPending}
            <div class="pending-card-shell" aria-hidden="true">
                <span></span>
                <span></span>
                <span></span>
            </div>
        {:else if cardUrl !== undefined && !useClassicFallback && !useStoredPayloadCard}
            {#if !loadRequested}
                <div class="card-load-gate">
                    <span class="card-load-error" role="alert">App card unavailable.</span>
                    <span class="card-url" title={cardUrl}>{cardUrl}</span>
                    <div class="actions">
                        <button onclick={requestCardLoad}>Retry app card</button>
                        <button onclick={chooseClassicFallback}>Show values</button>
                    </div>
                </div>
            {:else}
                <div class="card-url" title={cardUrl}>{cardUrl}</div>
                <!-- App-rendered pixels are not OpenChat-owned UI. The opaque sandbox prevents redirects
                 from inheriting any destination origin; the height is driven by the nonce-bound bridge. -->
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
                        {capabilityPending
                            ? "Verifying app card…"
                            : "Waiting for the isolated app…"}
                    </div>
                {/if}

                {#if cardActivated && cardCancelable}
                    <div class="host-approval" role="group" aria-label="Card actions">
                        {#if content.disclosure !== undefined}
                            <label class="disclosure" onclick={(e) => e.stopPropagation()}>
                                <input
                                    type="checkbox"
                                    bind:checked={acknowledged}
                                    disabled={busy || submitted}
                                />
                                <span>{content.disclosure}</span>
                            </label>
                        {/if}
                        <div class="actions">
                            <button
                                class="cancel"
                                disabled={busy || submitted}
                                onclick={(e) => respond("cancel", e)}>{content.cancelLabel}</button
                            >
                            <button
                                class="confirm"
                                disabled={!canCollectConfirm}
                                onclick={requestHostConfirmation}
                            >
                                {#if busy}
                                    <Spinner size="1.1em" foregroundColour="transparent" />
                                {:else}
                                    {content.confirmLabel}
                                {/if}
                            </button>
                        </div>
                    </div>
                {/if}

                {#if cardActivated && cardCancelable && !finalConfirmationAvailable}
                    <div class="card-load-error" role="status">
                        Confirmation is disabled until the server binds the exact final payload to
                        this viewer, card, and app revision.
                    </div>
                {/if}

                {#if cardCollectionFailed}
                    <div class="card-load-error" role="alert">
                        The app did not return valid card values. Review the card and try again; no
                        payload was submitted.
                    </div>
                {/if}

                {#if confirmationFailed}
                    <div class="card-load-error" role="alert">Confirmation failed. Try again.</div>
                {/if}

                {#if cardActivated && hasPersistentUserPairing && !privateContextAvailable}
                    <div class="card-load-error" role="alert">
                        Saved app data is unavailable in this browser. Confirmation is disabled.
                    </div>
                {/if}

                {#if cardActivated && hasPersistentUserPairing && cardCapability === undefined && privateContextAvailable && !privateContextRequested}
                    <div class="private-context-action">
                        <button
                            disabled={capabilityPending || !pending || readonly}
                            onclick={requestPrivateContext}
                        >
                            {capabilityPending ? "Restoring app data…" : "Restore app data"}
                        </button>
                    </div>
                {/if}
            {/if}
        {:else}
            {#if cardUrl !== undefined && useStoredPayloadCard}
                <div class="card-url" title={cardUrl}>{cardUrl}</div>
            {/if}
            {#if cardContentAttestationBlocked}
                <div class="card-load-error" role="alert">
                    This card's app/revision/action coordinates match the directory, but its title,
                    rows, and payload are not attested as app-authored. App rendering and
                    confirmation are disabled.
                </div>
            {/if}
            {#if appCardRenderingBlocked}
                <div class="card-load-error" role="status">
                    App rendering is disabled by this client's release gate.
                </div>
            {/if}
            {#if cardUrl !== undefined && useClassicFallback}
                <div class="card-load-error" role="status">
                    Secure app card unavailable; confirmation is disabled.
                    {#if credentiallessSupported}
                        <button onclick={requestCardLoad}>Retry app card</button>
                    {/if}
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
                        disabled={!pending || readonly || !cardContentAttested || submitted}
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
                        disabled={readonly || busy || submitted}
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

        &.pending-verification:not(.collapsed) {
            width: min(90vw, 420px);
            min-height: 140px;
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

    .pending-card-shell {
        display: flex;
        flex-direction: column;
        gap: $sp2;
        min-height: 58px;
        justify-content: center;

        span {
            display: block;
            height: 0.7rem;
            border-radius: 999px;
            background: var(--currentChat-msg-muted);
            opacity: 0.18;

            &:nth-child(1) {
                width: 72%;
            }

            &:nth-child(2) {
                width: 88%;
            }

            &:nth-child(3) {
                width: 56%;
            }
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
    .private-context-action {
        display: flex;
        flex-direction: column;
        gap: $sp2;
        padding: $sp3;
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }

    .card-load-gate button,
    .private-context-action button {
        align-self: flex-start;
    }

    .card-url {
        color: var(--currentChat-msg-muted);
        direction: ltr;
        font-size: 0.75em;
        unicode-bidi: plaintext;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .card-load-error {
        color: var(--warning);
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
