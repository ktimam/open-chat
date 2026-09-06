import { describe, expect, test, vi } from "vitest";
import {
    buildCardBusy,
    buildCardBootstrap,
    buildCardCollectConfirm,
    buildCardPrivateContextRequest,
    buildCardInit,
    beginCardCollectAttempt,
    beginCardConfirmationAttempt,
    beginCardCapabilityAttempt,
    cardAttemptKey,
    cardCollectAttemptStillCurrent,
    cardConfirmationAttemptStillCurrent,
    cardCapabilityAttemptStillCurrent,
    cardPrivateContextStatusFromMessage,
    canAcceptCardPrivateContextReady,
    canApproveCardRequest,
    canonicalCardApprovalSummary,
    cardResponseForApproval,
    cardApprovalRequestFromMessage,
    cardCollectedConfirmFromMessage,
    cardResizeHeightFromMessage,
    clampCardHeight,
    completelyReverseMapMultiRows,
    completelyReverseMapRows,
    decodeCardRecipientPublicKey,
    decodeConfirmPayload,
    deriveCardOrigin,
    isCardConfirmPayload,
    isRecord,
    isEmbeddedSurfaceConsentCurrent,
    isAppCardContentAttested,
    isMultiEntrySummaryRows,
    isCardBridgeEventForFrame,
    isCardPublicReadyMessage,
    encodeCardConfirmPayload,
    normalizeAiAppSurfaceUrl,
    reverseMapRows,
    snapshotCardConfirmPayload,
    settleCardOperationBeforeTimeout,
    startCardBootstrapRetry,
    startCardCollectTimeout,
    startCardHandshakeTimeout,
    supportsCredentiallessIframe,
    visibleRows,
    type CardInitContext,
} from "./cardBridge";

describe("deriveCardOrigin", () => {
    test("returns the origin for an https url", () => {
        expect(deriveCardOrigin("https://app.example/openchat/card?x=1")).toBe(
            "https://app.example",
        );
    });
    test("keeps a non-default port in the origin", () => {
        expect(
            deriveCardOrigin("http://localhost:5341/openchat/card", {
                allowLocalDevelopment: true,
            }),
        ).toBe("http://localhost:5341");
    });
    test("returns undefined for an unparseable url", () => {
        expect(deriveCardOrigin("not a url")).toBeUndefined();
    });
    test("returns undefined for a non-http(s) scheme", () => {
        expect(deriveCardOrigin("javascript:alert(1)")).toBeUndefined();
        expect(deriveCardOrigin("data:text/html,<h1>x</h1>")).toBeUndefined();
    });
    test("rejects credential-bearing embed URLs", () => {
        expect(deriveCardOrigin("https://user:password@app.example/openchat/card")).toBeUndefined();
    });
    test("rejects plaintext http on a non-loopback host (downgrade vector)", () => {
        expect(deriveCardOrigin("http://app.example/openchat/card")).toBeUndefined();
    });
    test("keeps allowing loopback http for local dev", () => {
        const local = { allowLocalDevelopment: true };
        expect(deriveCardOrigin("http://localhost:5341/openchat/card", local)).toBe(
            "http://localhost:5341",
        );
        expect(deriveCardOrigin("http://127.0.0.1:3000/openchat/card", local)).toBe(
            "http://127.0.0.1:3000",
        );
    });
    test("rejects non-public literal hosts unless explicit local development is enabled", () => {
        for (const host of [
            "localhost",
            "127.0.0.1",
            "2130706433", // encoded IPv4 normalized by WHATWG URL
            "10.0.0.1",
            "172.16.2.3",
            "192.168.1.2",
            "169.254.169.254",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "[::1]",
            "[fc00::1]",
            "[fe80::1]",
            "[::ffff:127.0.0.1]",
        ]) {
            expect(deriveCardOrigin(`https://${host}/card`), host).toBeUndefined();
        }
        expect(deriveCardOrigin("https://192.168.1.2/card", { allowLocalDevelopment: true })).toBe(
            "https://192.168.1.2",
        );
    });
    test("rejects a card origin equal to the OpenChat host origin (must be third-party)", () => {
        expect(
            deriveCardOrigin("https://oc.example/openchat/card", "https://oc.example"),
        ).toBeUndefined();
        // A different origin under the same host detection still resolves.
        expect(deriveCardOrigin("https://app.example/openchat/card", "https://oc.example")).toBe(
            "https://app.example",
        );
    });
});

describe("isCardBridgeEventForFrame", () => {
    const frame = {};
    const current = {
        source: frame,
        origin: "null",
        data: { type: "oc:card:ready", version: 2, frameNonce: "nonce-current" },
    };

    test("requires the exact frame source, opaque sandbox origin, and current nonce", () => {
        expect(isCardBridgeEventForFrame(current, frame, "null", "nonce-current")).toBe(true);
        expect(isCardBridgeEventForFrame(current, {}, "null", "nonce-current")).toBe(false);
        expect(
            isCardBridgeEventForFrame(current, frame, "https://app.example", "nonce-current"),
        ).toBe(false);
        expect(isCardBridgeEventForFrame(current, frame, "null", "nonce-other")).toBe(false);
    });

    test("rejects replay after navigation and tampered non-record messages", () => {
        expect(
            isCardBridgeEventForFrame(
                { ...current, data: { ...current.data, frameNonce: "nonce-before-navigation" } },
                frame,
                "null",
                "nonce-after-navigation",
            ),
        ).toBe(false);
        expect(
            isCardBridgeEventForFrame(
                { source: frame, origin: "null", data: "nonce-after-navigation" },
                frame,
                "null",
                "nonce-after-navigation",
            ),
        ).toBe(false);
    });
});

describe("private-context consent gate", () => {
    const allowed = {
        explicitlyRequested: true,
        featureAvailable: true,
        alreadyGranted: false,
        pending: true,
        readonly: false,
    };

    test("accepts a recipient key only after the separate user click", () => {
        expect(canAcceptCardPrivateContextReady(allowed)).toBe(true);
        expect(canAcceptCardPrivateContextReady({ ...allowed, explicitlyRequested: false })).toBe(
            false,
        );
    });

    test("also rejects disabled, replayed, consumed, and read-only sessions", () => {
        expect(canAcceptCardPrivateContextReady({ ...allowed, featureAvailable: false })).toBe(
            false,
        );
        expect(canAcceptCardPrivateContextReady({ ...allowed, alreadyGranted: true })).toBe(false);
        expect(canAcceptCardPrivateContextReady({ ...allowed, pending: false })).toBe(false);
        expect(canAcceptCardPrivateContextReady({ ...allowed, readonly: true })).toBe(false);
    });
});

describe("full-card content attestation", () => {
    test("directory-coordinate provenance does not attest forged display/payload content", () => {
        const forged = {
            appVerified: true,
            title: "Trusted-looking title",
            rows: [{ label: "Quantity", value: "1" }],
            confirmPayload: new TextEncoder().encode('{"quantity":999}'),
        };
        expect(isAppCardContentAttested(forged)).toBe(false);
        expect(isAppCardContentAttested({ ...forged, appContentVerified: false })).toBe(false);
        expect(isAppCardContentAttested({ ...forged, appContentVerified: true })).toBe(true);
    });
});

describe("embedded surface consent binding", () => {
    test("a click for normalized URL A never auto-loads changed URL B", () => {
        const a = "https://app.example/a";
        const b = "https://app.example/b";
        expect(isEmbeddedSurfaceConsentCurrent(a, a)).toBe(true);
        expect(isEmbeddedSurfaceConsentCurrent(a, b)).toBe(false);
        expect(isEmbeddedSurfaceConsentCurrent(a, undefined)).toBe(false);
        expect(isEmbeddedSurfaceConsentCurrent(undefined, b)).toBe(false);
    });

    test("feature-detects credentialless and fails closed when unsupported", () => {
        expect(supportsCredentiallessIframe({ credentialless: false })).toBe(true);
        expect(supportsCredentiallessIframe({})).toBe(false);
    });

    test("normalizes browser and iframe destinations through the same fail-closed policy", () => {
        expect(normalizeAiAppSurfaceUrl("https://app.example/a/../card?x=1")).toBe(
            "https://app.example/card?x=1",
        );
        for (const url of [
            "not a url",
            "http://app.example/card",
            "https://user:password@app.example/card",
            "https://127.0.0.1/card",
            "https://2130706433/card",
            "https://[::1]/card",
        ]) {
            expect(normalizeAiAppSurfaceUrl(url)).toBeUndefined();
        }
        expect(
            normalizeAiAppSurfaceUrl("http://127.0.0.1:5000/card", {
                allowLocalDevelopment: true,
            }),
        ).toBe("http://127.0.0.1:5000/card");
    });
});

describe("decodeConfirmPayload", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

    test("decodes a JSON object", () => {
        expect(decodeConfirmPayload(enc({ quantity: 20, material: "wood" }))).toEqual({
            quantity: 20,
            material: "wood",
        });
    });
    test("empty / absent bytes -> {}", () => {
        expect(decodeConfirmPayload(undefined)).toEqual({});
        expect(decodeConfirmPayload(new Uint8Array())).toEqual({});
    });
    test("non-JSON bytes -> {}", () => {
        expect(decodeConfirmPayload(new TextEncoder().encode("{not json"))).toEqual({});
    });
    test("wraps a non-empty object array as editable multi-entry init data", () => {
        expect(
            decodeConfirmPayload(
                enc([
                    { quantity: 25, description: "first" },
                    { quantity: 10, description: "second" },
                ]),
            ),
        ).toEqual({
            entries: [
                { quantity: 25, description: "first" },
                { quantity: 10, description: "second" },
            ],
        });
        expect(decodeConfirmPayload(enc([1, { quantity: 10 }]))).toEqual({});
    });
});

describe("isRecord", () => {
    test("true only for plain objects", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord("x")).toBe(false);
        expect(isRecord(3)).toBe(false);
    });
});

describe("isCardConfirmPayload", () => {
    test("accepts only object or array payloads", () => {
        expect(isCardConfirmPayload({ quantity: 1 })).toBe(true);
        expect(isCardConfirmPayload([{ quantity: 1 }])).toBe(true);
        expect(isCardConfirmPayload(undefined)).toBe(false);
        expect(isCardConfirmPayload('{"quantity":1}')).toBe(false);
        expect(isCardConfirmPayload(null)).toBe(false);
    });
});

describe("buildCardInit", () => {
    test("wraps data + context in the init envelope", () => {
        const context: CardInitContext = {
            appId: 7,
            appRevision: 123n,
            actionId: "sample.add",
            theme: "dark",
            readonly: false,
            privateContext: {
                capability: "opaque",
                expiresAt: 456n,
                context: {
                    contextVersion: 1,
                    appSubject: "subject",
                    chatHandle: "chat",
                    messageHandle: "message",
                    appId: 7,
                    appRevision: 123n,
                    actionId: "sample.add",
                },
            },
        };
        const init = buildCardInit({ quantity: 5 }, context, "nonce-1");
        expect(init).toEqual({
            type: "oc:card:init",
            version: 2,
            frameNonce: "nonce-1",
            data: { quantity: 5 },
            context,
        });

        context.theme = "light";
        context.privateContext!.capability = "changed";
        context.privateContext!.context.chatHandle = "changed";
        expect(init.context.theme).toBe("dark");
        expect(init.context.privateContext?.capability).toBe("opaque");
        expect(init.context.privateContext?.context.chatHandle).toBe("chat");
    });

    test("copies a proxied capability context into a structured-clone-safe init message", () => {
        const proxiedContext = new Proxy<CardInitContext>(
            {
                appId: 7,
                appRevision: 123n,
                actionId: "sample.add",
                theme: "dark",
                readonly: false,
                privateContext: {
                    capability: "opaque",
                    expiresAt: 456n,
                    context: {
                        contextVersion: 1,
                        appSubject: "subject",
                        chatHandle: "chat",
                        messageHandle: "message",
                        appId: 7,
                        appRevision: 123n,
                        actionId: "sample.add",
                    },
                },
            },
            {},
        );

        expect(() => structuredClone(proxiedContext)).toThrow();
        const init = buildCardInit({ quantity: 5 }, proxiedContext, "nonce-1");
        expect(() => structuredClone(init)).not.toThrow();
        expect(init.context).not.toBe(proxiedContext);
        expect(init.context).toEqual(proxiedContext);
    });

    test("removes a nested app-scoped context Proxy without changing its security bindings", () => {
        const proxiedAppContext = new Proxy(
            {
                contextVersion: 1 as const,
                appSubject: "subject",
                chatHandle: "chat",
                messageHandle: "message",
                appId: 7,
                appRevision: 123n,
                actionId: "sample.add",
            },
            {},
        );
        const proxiedPrivateContext = new Proxy(
            {
                capability: "opaque",
                expiresAt: 456n,
                context: proxiedAppContext,
            },
            {},
        );
        const context: CardInitContext = {
            appId: 7,
            appRevision: 123n,
            actionId: "sample.add",
            theme: "light",
            readonly: true,
            privateContext: proxiedPrivateContext,
        };

        expect(() => structuredClone(proxiedPrivateContext)).toThrow();
        expect(() => structuredClone(proxiedAppContext)).toThrow();
        const init = buildCardInit({}, context, "nonce-2");
        expect(() => structuredClone(init)).not.toThrow();
        expect(init.context.privateContext).not.toBe(proxiedPrivateContext);
        expect(init.context.privateContext?.context).not.toBe(proxiedAppContext);
        expect(init.context.privateContext).toEqual({
            capability: "opaque",
            expiresAt: 456n,
            context: {
                contextVersion: 1,
                appSubject: "subject",
                chatHandle: "chat",
                messageHandle: "message",
                appId: 7,
                appRevision: 123n,
                actionId: "sample.add",
            },
        });
    });
});

describe("private card-context handshake", () => {
    const nonce = "host-generated-nonce";
    const bytes = Uint8Array.from({ length: 48 }, (_, i) => i);
    const key = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");

    test("public ready v2 needs no recipient key", () => {
        expect(
            isCardPublicReadyMessage(
                { type: "oc:card:ready", version: 2, frameNonce: nonce },
                nonce,
            ),
        ).toBe(true);
        expect(
            isCardPublicReadyMessage(
                { type: "oc:card:ready", version: 1, frameNonce: nonce },
                nonce,
            ),
        ).toBe(false);
        expect(
            isCardPublicReadyMessage(
                { type: "oc:card:ready", version: 2, frameNonce: "wrong" },
                nonce,
            ),
        ).toBe(false);
        expect(buildCardPrivateContextRequest(nonce)).toEqual({
            type: "oc:card:private-context-request",
            version: 2,
            frameNonce: nonce,
        });
    });

    test("keeps an app-defined Type out of public rows, init, URL, and the opaque private grant", () => {
        const privateValue = "Confidential sample";
        const publicData = reverseMapRows(
            [
                { label: "Quantity", value: "350" },
                { label: "Material", value: "wood" },
            ],
            { Quantity: "quantity", Material: "material" },
        );
        const context: CardInitContext = {
            appId: 7,
            appRevision: 123n,
            actionId: "sample.add",
            theme: "dark",
            readonly: true,
            privateContext: {
                capability: "opaque-capability",
                expiresAt: 456n,
                context: {
                    contextVersion: 1,
                    appSubject: "subject-handle",
                    chatHandle: "chat-handle",
                    messageHandle: "message-handle",
                    appId: 7,
                    appRevision: 123n,
                    actionId: "sample.add",
                },
            },
        };
        const init = buildCardInit(publicData, context, nonce);
        const destination = normalizeAiAppSurfaceUrl("https://app.example/card?app=7")!;
        const publicChannels = JSON.stringify({
            rows: Object.entries(publicData),
            init: {
                ...init,
                context: {
                    ...init.context,
                    appRevision: init.context.appRevision.toString(),
                    privateContext: init.context.privateContext && {
                        ...init.context.privateContext,
                        expiresAt: init.context.privateContext.expiresAt.toString(),
                        context: {
                            ...init.context.privateContext.context,
                            appRevision: init.context.privateContext.context.appRevision.toString(),
                        },
                    },
                },
            },
            destination,
            privateRequest: buildCardPrivateContextRequest(nonce),
        });
        expect(publicChannels).not.toContain('"Type"');
        expect(publicChannels).not.toContain(privateValue);
        expect(init.context).not.toHaveProperty("chat");
        expect(init.context).not.toHaveProperty("messageId");
        expect(init.context).not.toHaveProperty("threadRootMessageIndex");
        // OpenChat delivers only opaque authority. The registered app redeems and decrypts its own
        // private payload after authorization; OpenChat never hydrates the private value itself.
        expect(init.context.privateContext).toEqual({
            capability: "opaque-capability",
            expiresAt: 456n,
            context: {
                contextVersion: 1,
                appSubject: "subject-handle",
                chatHandle: "chat-handle",
                messageHandle: "message-handle",
                appId: 7,
                appRevision: 123n,
                actionId: "sample.add",
            },
        });
    });

    test("accepts private-context-ready v2 with a bounded opaque scheme + unpadded base64url key", () => {
        expect(
            decodeCardRecipientPublicKey(
                {
                    type: "oc:card:private-context-ready",
                    version: 2,
                    frameNonce: nonce,
                    privateContext: { recipientKeyScheme: "bls-g1-v1", recipientPublicKey: key },
                },
                nonce,
            ),
        ).toEqual({ scheme: "bls-g1-v1", publicKey: bytes });
        expect(
            decodeCardRecipientPublicKey(
                { type: "oc:card:private-context-ready", version: 1 },
                nonce,
            ),
        ).toBeUndefined();
        expect(
            decodeCardRecipientPublicKey(
                {
                    type: "oc:card:private-context-ready",
                    version: 2,
                    frameNonce: nonce,
                    privateContext: {
                        recipientKeyScheme: "UPPERCASE NOT ALLOWED",
                        recipientPublicKey: key,
                    },
                },
                nonce,
            ),
        ).toBeUndefined();
        expect(
            decodeCardRecipientPublicKey(
                {
                    type: "oc:card:private-context-ready",
                    version: 2,
                    frameNonce: nonce,
                    privateContext: {
                        recipientKeyScheme: "bls-g1-v1",
                        recipientPublicKey: `${key}=token`,
                    },
                },
                nonce,
            ),
        ).toBeUndefined();
        expect(
            decodeCardRecipientPublicKey(
                {
                    type: "oc:card:private-context-ready",
                    version: 2,
                    frameNonce: "attacker",
                    privateContext: {
                        recipientKeyScheme: "bls-g1-v1",
                        recipientPublicKey: key,
                    },
                },
                nonce,
            ),
        ).toBeUndefined();
    });

    test("keeps OpenChat generic while rejecting tiny and oversized keys", () => {
        const encode = (value: Uint8Array) =>
            btoa(String.fromCharCode(...value))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
        const message = (value: Uint8Array) => ({
            type: "oc:card:private-context-ready",
            version: 2,
            frameNonce: nonce,
            privateContext: {
                recipientKeyScheme: "x25519-v1",
                recipientPublicKey: encode(value),
            },
        });
        expect(
            decodeCardRecipientPublicKey(message(new Uint8Array(16)), nonce)?.publicKey,
        ).toHaveLength(16);
        expect(
            decodeCardRecipientPublicKey(message(new Uint8Array(512)), nonce)?.publicKey,
        ).toHaveLength(512);
        expect(decodeCardRecipientPublicKey(message(new Uint8Array(15)), nonce)).toBeUndefined();
        expect(decodeCardRecipientPublicKey(message(new Uint8Array(513)), nonce)).toBeUndefined();
    });

    test.each(["ready", "error"] as const)(
        "accepts an exact private-context %s status bound to nonce and capability",
        (status) => {
            expect(
                cardPrivateContextStatusFromMessage(
                    {
                        type: "oc:card:private-context-status",
                        version: 2,
                        frameNonce: nonce,
                        capability: "opaque-capability",
                        status,
                    },
                    nonce,
                    "opaque-capability",
                ),
            ).toBe(status);
        },
    );

    test.each([
        ["wrong type", { type: "oc:card:private-context-ready" }],
        ["wrong version", { version: 1 }],
        ["wrong nonce", { frameNonce: "stale-frame" }],
        ["wrong capability", { capability: "stale-capability" }],
        ["unknown status", { status: "loading" }],
        ["missing status", { status: undefined }],
    ])("rejects private-context status with %s", (_label, override) => {
        expect(
            cardPrivateContextStatusFromMessage(
                {
                    type: "oc:card:private-context-status",
                    version: 2,
                    frameNonce: nonce,
                    capability: "opaque-capability",
                    status: "ready",
                    ...override,
                },
                nonce,
                "opaque-capability",
            ),
        ).toBeUndefined();
    });

    test("latches repeated ready and discards navigation, key/card changes, and teardown", () => {
        const binding = {
            frameNonce: "n1",
            recipientKeyScheme: "x25519-v1",
            recipientPublicKey: new Uint8Array(32),
            cardKey: "group:g|thread:-|message:1|app:7@2|action:add",
        };
        const attempt = beginCardCapabilityAttempt(undefined, binding)!;
        expect(beginCardCapabilityAttempt(attempt, binding)).toBeUndefined();
        expect(cardCapabilityAttemptStillCurrent(attempt, binding, true)).toBe(true);
        expect(
            cardCapabilityAttemptStillCurrent(attempt, { ...binding, frameNonce: "n2" }, true),
        ).toBe(false);
        expect(
            cardCapabilityAttemptStillCurrent(
                attempt,
                { ...binding, recipientPublicKey: new Uint8Array(32).fill(1) },
                true,
            ),
        ).toBe(false);
        expect(
            cardCapabilityAttemptStillCurrent(
                attempt,
                { ...binding, cardKey: `${binding.cardKey}:changed` },
                true,
            ),
        ).toBe(false);
        expect(cardCapabilityAttemptStillCurrent(attempt, binding, false)).toBe(false);
    });
});

describe("host-owned card approval", () => {
    test("partitions attempt identity across viewer, chat, message, thread, app, revision, and action", () => {
        const base = {
            viewerId: "viewer-a",
            chat: { kind: "channel", communityId: "community-a", channelId: 7 } as const,
            messageId: 99n,
            threadRootMessageIndex: 3,
            appId: 5,
            appRevision: 12n,
            actionId: "sample.confirm",
        };
        const baseKey = cardAttemptKey(base);
        const variants = [
            { ...base, viewerId: "viewer-b" },
            {
                ...base,
                chat: { kind: "channel", communityId: "community-b", channelId: 7 } as const,
            },
            { ...base, messageId: 100n },
            { ...base, threadRootMessageIndex: 4 },
            { ...base, appId: 6 },
            { ...base, appRevision: 13n },
            { ...base, actionId: "sample.other" },
        ];
        for (const variant of variants) expect(cardAttemptKey(variant)).not.toBe(baseKey);
    });

    test("copies and freezes a JSON-only confirm payload", () => {
        const source = { quantity: 5, rows: [{ description: "leaf" }] };
        const snapshot = snapshotCardConfirmPayload(source)!;
        expect(snapshot).toEqual(source);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen((snapshot as typeof source).rows[0])).toBe(true);
        source.quantity = 99;
        source.rows[0].description = "mutated";
        expect(snapshot).toEqual({ quantity: 5, rows: [{ description: "leaf" }] });
    });

    test("encodes the exact frozen payload bytes used for the final grant and response", () => {
        const request = cardApprovalRequestFromMessage(
            {
                type: "oc:card:confirm",
                version: 2,
                frameNonce: "n",
                payload: { quantity: 5, nested: ["one", 2] },
            },
            "n",
        )!;
        expect(new TextDecoder().decode(encodeCardConfirmPayload(request))).toBe(
            '{"quantity":5,"nested":["one",2]}',
        );
    });

    test("latches one final-grant attempt and rejects tamper, replay, navigation, and cross-viewer scope", () => {
        const cardKey = cardAttemptKey({
            viewerId: "viewer-a",
            chat: { kind: "channel", communityId: "community", channelId: 7 },
            messageId: 99n,
            threadRootMessageIndex: 3,
            appId: 5,
            appRevision: 12n,
            actionId: "sample.confirm",
        });
        const binding = {
            frameNonce: "nonce-a",
            cardKey,
            confirmPayload: new TextEncoder().encode('{"quantity":5}'),
        };
        const attempt = beginCardConfirmationAttempt(undefined, binding)!;
        expect(beginCardConfirmationAttempt(attempt, binding)).toBeUndefined();
        expect(cardConfirmationAttemptStillCurrent(attempt, binding, true)).toBe(true);
        expect(
            cardConfirmationAttemptStillCurrent(
                attempt,
                { ...binding, confirmPayload: new TextEncoder().encode('{"quantity":6}') },
                true,
            ),
        ).toBe(false);
        expect(
            cardConfirmationAttemptStillCurrent(
                attempt,
                { ...binding, frameNonce: "nonce-after-navigation" },
                true,
            ),
        ).toBe(false);
        expect(
            cardConfirmationAttemptStillCurrent(
                attempt,
                {
                    ...binding,
                    cardKey: cardAttemptKey({
                        viewerId: "viewer-b",
                        chat: { kind: "channel", communityId: "community", channelId: 7 },
                        messageId: 99n,
                        threadRootMessageIndex: 3,
                        appId: 5,
                        appRevision: 12n,
                        actionId: "sample.confirm",
                    }),
                },
                true,
            ),
        ).toBe(false);
        expect(cardConfirmationAttemptStillCurrent(attempt, binding, false)).toBe(false);
    });

    test("binds host-initiated payload collection to one fresh request and the current card", () => {
        const cardKey = cardAttemptKey({
            viewerId: "viewer-a",
            chat: { kind: "channel", communityId: "community", channelId: 7 },
            messageId: 99n,
            appId: 5,
            appRevision: 12n,
            actionId: "sample.confirm",
        });
        const binding = {
            frameNonce: "frame-a",
            requestNonce: "request-a",
            cardKey,
        };
        const attempt = beginCardCollectAttempt(undefined, binding)!;

        expect(buildCardCollectConfirm("frame-a", "request-a")).toEqual({
            type: "oc:card:collect-confirm",
            version: 2,
            frameNonce: "frame-a",
            requestNonce: "request-a",
        });
        expect(beginCardCollectAttempt(attempt, binding)).toBeUndefined();
        expect(cardCollectAttemptStillCurrent(attempt, binding, true)).toBe(true);
        expect(
            cardCollectAttemptStillCurrent(
                attempt,
                { ...binding, requestNonce: "unsolicited-or-replayed" },
                true,
            ),
        ).toBe(false);
        expect(
            cardCollectAttemptStillCurrent(
                attempt,
                { ...binding, frameNonce: "after-navigation" },
                true,
            ),
        ).toBe(false);
        expect(
            cardCollectAttemptStillCurrent(
                attempt,
                { ...binding, cardKey: `${cardKey}-other` },
                true,
            ),
        ).toBe(false);
        expect(cardCollectAttemptStillCurrent(attempt, binding, false)).toBe(false);
    });

    test("accepts collected bytes only for the exact active host-click challenge", () => {
        const message = {
            type: "oc:card:confirm-collected",
            version: 2,
            frameNonce: "frame-a",
            requestNonce: "request-a",
            payload: { quantity: 5, opaque_ref: "opaque" },
        };
        expect(cardCollectedConfirmFromMessage(message, "frame-a", "request-a")).toEqual({
            quantity: 5,
            opaque_ref: "opaque",
        });
        expect(
            cardCollectedConfirmFromMessage(message, "frame-a", "wrong-request"),
        ).toBeUndefined();
        expect(
            cardCollectedConfirmFromMessage(message, "wrong-frame", "request-a"),
        ).toBeUndefined();
        expect(
            cardCollectedConfirmFromMessage(
                { ...message, type: "oc:card:confirm" },
                "frame-a",
                "request-a",
            ),
        ).toBeUndefined();
        expect(
            cardCollectedConfirmFromMessage({ ...message, version: 1 }, "frame-a", "request-a"),
        ).toBeUndefined();
    });

    test("collection timeout is cancellable and cannot fire after completion", () => {
        vi.useFakeTimers();
        try {
            const timedOut = vi.fn();
            const cancel = startCardCollectTimeout(timedOut, 50);
            vi.advanceTimersByTime(49);
            expect(timedOut).not.toHaveBeenCalled();
            cancel();
            vi.advanceTimersByTime(1);
            expect(timedOut).not.toHaveBeenCalled();

            startCardCollectTimeout(timedOut, 50);
            vi.advanceTimersByTime(50);
            expect(timedOut).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    test("bounds card operations and converts throws or rejection into a fail-closed result", async () => {
        expect(await settleCardOperationBeforeTimeout(() => "ok", 50)).toEqual({
            status: "settled",
            value: "ok",
        });
        await expect(
            settleCardOperationBeforeTimeout(() => {
                throw new Error("synchronous failure");
            }, 50),
        ).resolves.toEqual({ status: "failed" });
        await expect(
            settleCardOperationBeforeTimeout(
                () => Promise.reject(new Error("asynchronous failure")),
                50,
            ),
        ).resolves.toEqual({ status: "failed" });

        vi.useFakeTimers();
        try {
            const neverSettles = settleCardOperationBeforeTimeout(
                () => new Promise(() => undefined),
                50,
            );
            await vi.advanceTimersByTimeAsync(50);
            await expect(neverSettles).resolves.toEqual({ status: "failed" });
        } finally {
            vi.useRealTimers();
        }
    });

    test("rejects non-JSON, prototype-polluting, deep, and oversized payloads", () => {
        expect(snapshotCardConfirmPayload({ value: 1n })).toBeUndefined();
        expect(snapshotCardConfirmPayload({ value: Number.NaN })).toBeUndefined();
        const polluted = Object.create(null) as Record<string, unknown>;
        polluted.__proto__ = { admin: true };
        expect(snapshotCardConfirmPayload(polluted)).toBeUndefined();
        let deep: Record<string, unknown> = {};
        for (let i = 0; i < 20; i++) deep = { nested: deep };
        expect(snapshotCardConfirmPayload(deep)).toBeUndefined();
        // `{\"text\":\"\"}` is 11 UTF-8 bytes: cover the backend's exact 16,384-byte boundary.
        expect(snapshotCardConfirmPayload({ text: "x".repeat(16_373) })).toBeDefined();
        expect(snapshotCardConfirmPayload({ text: "x".repeat(16_374) })).toBeUndefined();
    });

    test("turns iframe messages into requests, never approval", () => {
        const request = cardApprovalRequestFromMessage(
            { type: "oc:card:confirm", version: 2, frameNonce: "n", payload: { quantity: 5 } },
            "n",
        );
        expect(request).toEqual({ kind: "confirm", payload: { quantity: 5 } });
        expect(
            cardApprovalRequestFromMessage(
                { type: "oc:card:cancel", version: 2, frameNonce: "n" },
                "n",
            ),
        ).toEqual({
            kind: "cancel",
        });
        expect(
            cardApprovalRequestFromMessage(
                { type: "oc:card:confirm", version: 2, frameNonce: "n", payload: "5" },
                "n",
            ),
        ).toBeUndefined();
        expect(
            cardApprovalRequestFromMessage(
                { type: "oc:card:cancel", version: 2, frameNonce: "wrong" },
                "n",
            ),
        ).toBeUndefined();
        for (const version of [undefined, 1, 3]) {
            expect(
                cardApprovalRequestFromMessage(
                    {
                        type: "oc:card:confirm",
                        version,
                        frameNonce: "n",
                        payload: { quantity: 5 },
                    },
                    "n",
                ),
            ).toBeUndefined();
            expect(
                cardApprovalRequestFromMessage(
                    { type: "oc:card:cancel", version, frameNonce: "n" },
                    "n",
                ),
            ).toBeUndefined();
        }
    });

    test("resize requires the exact v2 protocol and matching nonce", () => {
        expect(
            cardResizeHeightFromMessage(
                { type: "oc:card:resize", version: 2, frameNonce: "n", height: 300 },
                "n",
            ),
        ).toBe(300);
        for (const version of [undefined, 1, 3]) {
            expect(
                cardResizeHeightFromMessage(
                    { type: "oc:card:resize", version, frameNonce: "n", height: 300 },
                    "n",
                ),
            ).toBeUndefined();
        }
        expect(
            cardResizeHeightFromMessage(
                { type: "oc:card:resize", version: 2, frameNonce: "wrong", height: 300 },
                "n",
            ),
        ).toBeUndefined();
    });

    test("requires actionable state, idle host, and disclosure acknowledgement", () => {
        const request = { kind: "confirm", payload: { quantity: 5 } } as const;
        expect(canApproveCardRequest(request, true, false, false, false)).toBe(true);
        expect(canApproveCardRequest(request, false, false, false, false)).toBe(false);
        expect(canApproveCardRequest(request, true, true, false, false)).toBe(false);
        expect(canApproveCardRequest(request, true, false, true, false)).toBe(false);
        expect(canApproveCardRequest(request, true, false, true, true)).toBe(true);
        expect(canApproveCardRequest({ kind: "cancel" }, true, false, true, false)).toBe(true);
    });

    test("shows and submits the same frozen canonical payload snapshot", () => {
        const request = cardApprovalRequestFromMessage(
            {
                type: "oc:card:confirm",
                version: 2,
                frameNonce: "n",
                payload: { z: [2, { html: "<script>not markup</script>" }], a: 1 },
            },
            "n",
        )!;
        const summary = canonicalCardApprovalSummary(request);
        expect(summary.indexOf('"a"')).toBeLessThan(summary.indexOf('"z"'));
        const approved = cardResponseForApproval(request);
        expect(approved.response).toBe("confirm");
        expect(approved.payload).toBe(request.kind === "confirm" ? request.payload : undefined);
        expect(JSON.parse(summary)).toEqual(approved.payload);
    });

    test("visibly escapes bidi and zero-width controls without changing the approved object", () => {
        const request = cardApprovalRequestFromMessage(
            {
                type: "oc:card:confirm",
                version: 2,
                frameNonce: "n",
                payload: { [`quantity\u202e":"999`]: `12\u200b34`, description: "safe" },
            },
            "n",
        )!;
        if (request.kind !== "confirm") throw new Error("expected confirm request");
        const summary = canonicalCardApprovalSummary(request);
        expect(summary).toContain("\\u202e");
        expect(summary).toContain("\\u200b");
        expect(summary).not.toContain("\u202e");
        expect(summary).not.toContain("\u200b");
        const approved = cardResponseForApproval(request);
        expect(approved.payload).toBe(request.payload);
        expect(JSON.parse(summary)).toEqual(request.payload);
    });
});

describe("buildCardBusy", () => {
    test("wraps a bare boolean progress flag (no app/canister data)", () => {
        expect(buildCardBootstrap("n")).toEqual({
            type: "oc:card:bootstrap",
            version: 2,
            frameNonce: "n",
        });
        expect(buildCardBusy(true, "n")).toEqual({
            type: "oc:card:busy",
            version: 2,
            frameNonce: "n",
            busy: true,
        });
        expect(buildCardBusy(false, "n")).toEqual({
            type: "oc:card:busy",
            version: 2,
            frameNonce: "n",
            busy: false,
        });
    });
});

describe("card handshake timeout", () => {
    test("fires once after the bounded deadline", () => {
        vi.useFakeTimers();
        try {
            const timedOut = vi.fn();
            startCardHandshakeTimeout(timedOut, 50);
            vi.advanceTimersByTime(49);
            expect(timedOut).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(timedOut).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test("cleanup prevents a stale frame deadline from failing a ready/retried session", () => {
        vi.useFakeTimers();
        try {
            const timedOut = vi.fn();
            const cleanup = startCardHandshakeTimeout(timedOut, 50);
            cleanup();
            vi.advanceTimersByTime(100);
            expect(timedOut).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("card bootstrap retry", () => {
    test("sends immediately and retries when the iframe listener missed the load-time bootstrap", () => {
        vi.useFakeTimers();
        try {
            const send = vi.fn();
            const cleanup = startCardBootstrapRetry(send, 25);
            expect(send).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(75);
            expect(send).toHaveBeenCalledTimes(4);
            cleanup();
        } finally {
            vi.useRealTimers();
        }
    });

    test("ready cleanup cancels every later retry", () => {
        vi.useFakeTimers();
        try {
            const send = vi.fn();
            const ready = startCardBootstrapRetry(send, 25);
            vi.advanceTimersByTime(24);
            ready();
            ready();
            vi.advanceTimersByTime(100);
            expect(send).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test("session-reset cleanup stops an old nonce while a new session retries independently", () => {
        vi.useFakeTimers();
        try {
            const oldSession = vi.fn();
            const newSession = vi.fn();
            const cancelOld = startCardBootstrapRetry(oldSession, 25);
            cancelOld();
            const cancelNew = startCardBootstrapRetry(newSession, 25);
            vi.advanceTimersByTime(50);
            expect(oldSession).toHaveBeenCalledTimes(1);
            expect(newSession).toHaveBeenCalledTimes(3);
            cancelNew();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("reverseMapRows", () => {
    // The manifest card template's label -> field-key map (client-side card.rows use `valueKey`).
    const fieldMap: Record<string, string> = {
        Quantity: "quantity",
        Material: "material",
        Location: "location",
        Description: "description",
    };

    test("joins hydrated {label,value} rows onto field keys", () => {
        const rows = [
            { label: "Quantity", value: "350" },
            { label: "Material", value: "paper" },
            { label: "Location", value: "indoor" },
            { label: "Description", value: "seeds" },
        ];
        expect(reverseMapRows(rows, fieldMap)).toEqual({
            quantity: "350",
            material: "paper",
            location: "indoor",
            description: "seeds",
        });
    });

    test("drops unmatched labels rather than inventing untrusted object keys", () => {
        const rows = [
            { label: "Quantity", value: "10" },
            { label: "Mystery Field", value: "x" },
        ];
        expect(reverseMapRows(rows, fieldMap)).toEqual({ quantity: "10" });
    });

    test("empty rows -> {}", () => {
        expect(reverseMapRows([], fieldMap)).toEqual({});
        expect(reverseMapRows([], {})).toEqual({});
    });

    test("empty map -> no untrusted keys", () => {
        expect(reverseMapRows([{ label: "Quantity", value: "5" }], {})).toEqual({});
    });

    test("ignores reserved legacy rows without treating their values as app data", () => {
        const rows = [
            { label: "Quantity", value: "10" },
            { label: "__oc_reserved__", value: "untrusted legacy value" },
        ];
        expect(reverseMapRows(rows, fieldMap)).toEqual({ quantity: "10" });
    });

    test("requires own safe mappings and returns a null-prototype result", () => {
        const inheritedMap = Object.create({ Quantity: "quantity" }) as Record<string, string>;
        inheritedMap.Description = "__proto__";
        const result = reverseMapRows(
            [
                { label: "Quantity", value: "10" },
                { label: "Description", value: "pollute" },
            ],
            inheritedMap,
        );
        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(result).toEqual({});
        expect(Object.hasOwn(result, "__proto__")).toBe(false);
    });

    test("requires every visible row to map completely and uniquely before app rendering", () => {
        expect(
            completelyReverseMapRows(
                [
                    { label: "Quantity", value: "350" },
                    { label: "Material", value: "paper" },
                ],
                fieldMap,
            ),
        ).toEqual({ quantity: "350", material: "paper" });
        expect(
            completelyReverseMapRows(
                [
                    { label: "Entry 1", value: "Sample · 350 paper" },
                    { label: "Entry 2", value: "Specimen · 20 paper" },
                ],
                fieldMap,
            ),
        ).toBeUndefined();
        expect(
            completelyReverseMapRows(
                [
                    { label: "Quantity", value: "350" },
                    { label: "Total", value: "350" },
                ],
                { Quantity: "quantity", Total: "quantity" },
            ),
        ).toBeUndefined();
    });

    test("recognizes only the host-owned contiguous multi-entry summary convention", () => {
        expect(
            isMultiEntrySummaryRows([
                { label: "Entry 1" },
                { label: "Entry 2" },
                { label: "Entry 3" },
            ]),
        ).toBe(true);
        expect(
            isMultiEntrySummaryRows([
                { label: "Entry 1" },
                { label: "__oc_reserved__" },
                { label: "Entry 2" },
            ]),
        ).toBe(true);
        expect(isMultiEntrySummaryRows([{ label: "Entry 1" }])).toBe(false);
        expect(isMultiEntrySummaryRows([{ label: "Entry 1" }, { label: "Entry 3" }])).toBe(false);
        expect(isMultiEntrySummaryRows([{ label: "Entry 1" }, { label: "Quantity" }])).toBe(false);
    });

    test("losslessly reconstructs canonical multi-entry summaries for editable app cards", () => {
        expect(
            completelyReverseMapMultiRows(
                [
                    {
                        label: "Entry 1",
                        value: "Quantity: 200 · Material: paper · Type: specimen · Location: indoor · Description: fern",
                    },
                    {
                        label: "Entry 2",
                        value: "Quantity: 400 · Type: sample · Location: outdoor · Observed: 2026-08-10 · Description: moss",
                    },
                ],
                {
                    Quantity: "quantity",
                    Material: "material",
                    Type: "kind",
                    Location: "location",
                    Observed: "observedAt",
                    Description: "description",
                },
            ),
        ).toEqual({
            entries: [
                {
                    quantity: "200",
                    material: "paper",
                    kind: "specimen",
                    location: "indoor",
                    description: "fern",
                },
                {
                    quantity: "400",
                    kind: "sample",
                    location: "outdoor",
                    observedAt: "2026-08-10",
                    description: "moss",
                },
            ],
        });
    });

    test("rejects ambiguous, reordered, duplicate, and non-canonical multi summaries", () => {
        const map = { Quantity: "quantity", Type: "kind", Description: "description" };
        expect(
            completelyReverseMapMultiRows(
                [
                    { label: "Entry 1", value: "Quantity: 200 · Description: safe" },
                    {
                        label: "Entry 2",
                        value: "Quantity: 300 · Description: text · Type: specimen",
                    },
                ],
                map,
            ),
        ).toBeUndefined();
        expect(
            completelyReverseMapMultiRows(
                [
                    { label: "Entry 1", value: "Quantity: 200 · Quantity: 300" },
                    { label: "Entry 2", value: "Quantity: 400" },
                ],
                map,
            ),
        ).toBeUndefined();
        expect(
            completelyReverseMapMultiRows(
                [
                    { label: "Entry 1", value: "Sample · 200 paper" },
                    { label: "Entry 2", value: "Specimen · 400 paper" },
                ],
                map,
            ),
        ).toBeUndefined();
    });

    test("ignores reserved host rows but rejects inherited or unsafe field mappings", () => {
        expect(
            completelyReverseMapRows(
                [
                    { label: "Quantity", value: "10" },
                    { label: "__oc_reserved__", value: "not app data" },
                ],
                fieldMap,
            ),
        ).toEqual({ quantity: "10" });
        const inheritedMap = Object.create({ Quantity: "quantity" }) as Record<string, string>;
        expect(
            completelyReverseMapRows([{ label: "Quantity", value: "10" }], inheritedMap),
        ).toBeUndefined();
        expect(
            completelyReverseMapRows([{ label: "Quantity", value: "10" }], {
                Quantity: "__proto__",
            }),
        ).toBeUndefined();
    });
});

describe("visibleRows (classic fallback fail-closed filter)", () => {
    test("drops reserved legacy rows without parsing them, and keeps human rows in order", () => {
        const rows = [
            { label: "Quantity", value: "350" },
            { label: "__oc_reserved__", value: "untrusted legacy value" },
            { label: "Material", value: "paper" },
        ];
        expect(visibleRows(rows)).toEqual([
            { label: "Quantity", value: "350" },
            { label: "Material", value: "paper" },
        ]);
    });

    test("drops any __oc_-prefixed label, not just the entries sentinel", () => {
        expect(
            visibleRows([
                { label: "__oc_future_control__", value: "x" },
                { label: "Description", value: "n" },
            ]),
        ).toEqual([{ label: "Description", value: "n" }]);
    });

    test("passes ordinary rows through unchanged, and [] -> []", () => {
        const rows = [{ label: "Quantity", value: "1" }];
        expect(visibleRows(rows)).toEqual(rows);
        expect(visibleRows([])).toEqual([]);
    });
});

describe("clampCardHeight", () => {
    test("clamps within range and rounds up", () => {
        expect(clampCardHeight(300.2, 120, 1200)).toBe(301);
        expect(clampCardHeight(50, 120, 1200)).toBe(120);
        expect(clampCardHeight(5000, 120, 1200)).toBe(1200);
    });
    test("non-finite -> min", () => {
        expect(clampCardHeight(Number.NaN, 120, 1200)).toBe(120);
        expect(clampCardHeight(Number.POSITIVE_INFINITY, 120, 1200)).toBe(120);
    });
});
