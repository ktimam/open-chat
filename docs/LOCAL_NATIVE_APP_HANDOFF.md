# Local-test native private-app handoff

This is a separate feature from browser-mediated account sign-in. It neither changes
the OpenChat backend nor sends chat history, image bytes, processor context, or account
credentials. Its only input is the immutable six-field private draft already reviewed
and explicitly confirmed in the native host. It is generic; it contains no app schema.

## Consent and transport

1. The host calls `beginLocalAppHandoff({ approvedRequestJson })` only after confirmation.
   The returned URL is a fixed `http://localhost:<ephemeral-port>/handoff`, with no token,
   code, payload, account identifier, query or fragment. The separate native UI may show
   and explicitly copy the 100-bit, twenty-character base32 pairing code.
2. The user opens the fixed browser page, pastes the code, and explicitly claims the
   draft. `POST /claim` includes that code and a fresh browser-memory 256-bit proof.
   The claim atomically consumes the code and returns the exact UTF-8 approved JSON once.
   Native state releases its payload/code references. Response loss is uncertain and
   is never automatically retried. The same approved import ID is retained for an
   explicitly requested new attempt, allowing app-side deduplication.
3. The browser displays every approved field using text, including destination and
   recipient. A separate user action opens the exact destination, never a model-returned
   URL. Public connect/connected metadata and the receiver's explicit origin consent
   establish the exact opener, receiver window, origin and receiver-generated nonce.
4. Immediately after receiver READY and before the single private offer, the relay
   must successfully call `POST /dispatch`. This is the atomic point beyond which
   cancellation cannot promise recall. Cancelled/expired/missing native sessions forbid
   delivery, even if the browser previously claimed and retained the draft.
5. App acknowledgements are reported through authenticated `POST /result`:
   `received` means pending app review, not saved. Only a subsequent `saved` report
   after `received` changes that state. This is an app-reported status, not an independent
   attestation that an app has saved anything. No acknowledgement triggers a resend.

The native code never opens a browser or app on its own. The host owns Copy/Open/Cancel
UI and must cancel the native session on account change, logout, discard, pagehide and
session expiration. Browser code must scrub all retained payload/code/proof references
on teardown and stop when native authorization disappears. Data already delivered to an
app cannot be recalled. App review and final save remain in the receiving app.

## Wire contract, version 1

Native commands:

- `beginLocalAppHandoff({approvedRequestJson})` returns
  `{handoffId,url,pairingCode,claimExpiresAtMs}`.
- `pollLocalAppHandoff(handoffId)` returns
  `{phase,expiresAtMs,deliveryMayHaveOccurred}`.
- `cancelLocalAppHandoff(handoffId)` returns `{deliveryMayHaveOccurred}`.

`handoffId` is 32 lowercase hex characters. `importId` is the existing canonical
43-character base64url idempotency key. The proof is 64 lowercase hex characters.
The pairing code is exactly twenty uppercase `[A-Z2-7]` characters.

HTTP on an IPv4 loopback-only listener, accepting only the exact localhost Host:

- `GET /handoff` and `GET /handoff.js` return fixed bundled assets only.
- `POST /claim`: `{version:1,code,browserProofHex}` returns
  `{version:1,handoffId,approvedRequestJson,expiresAtMs}` once.
- `POST /status`: `{version:1,handoffId,browserProofHex}` returns native status.
- `POST /dispatch`: same authorization plus `importId`; returns status `offered` once.
- `POST /result`: same authorization plus `importId,outcome`; returns native status.

Phases: `awaiting_claim`, `reviewing`, `offered`, `received`, `saved`, `rejected`,
`uncertain`, `expired`, `cancelled`. `reviewing` is not delivery. Only `offered` or a
later state has `deliveryMayHaveOccurred=true`. Receipt is preserved on expiry, never
upgraded to saved. Late, duplicate, conflicting and out-of-order results are rejected.

No payload GET, CORS, cookies, redirect, arbitrary filesystem route, or request logging
exists. POSTs require exact Origin, JSON type and bounded unique-key bodies. Fetch
Metadata is checked; the only cross-site exception is the fixed static entry document's
Chrome Custom Tab navigation, not a data route. Responses use no-store, no-referrer,
same-origin resource policy and a self-only connection CSP. Popup-compatible COOP/COEP
apply only to this relay, never the model's isolated WebView.

## Bounds and limitations

The code expires after two minutes or five invalid claims. A successful claim begins a
ten-minute delivery lifetime. Native deadlines use a monotonic clock. The server allows
four concurrent connections, three-second headers, five-second requests, at most 32
headers, 16 KiB header buffers and 2 KiB POST bodies. The approved envelope is at most
72 KiB and its payload at most 64 KiB, 16 levels and 4096 nodes; collections have at most
256 items. Duplicate/forbidden object keys, unknown envelope fields, noncanonical
destinations and invalid UTF-8 fail closed. JSON is preserved verbatim, not reserialized
through Rust numeric or Unicode normalization.

The bearer pairing code must not enter URLs, logs, persistent storage, automatic retries
or automatic clipboard writes. An explicitly copied code can be observed by a compromised
clipboard/browser/OS; this is not protection against a compromised device. Local processes
can deny service by consuming failed-claim attempts. Clearing references is not a claim
of cryptographically secure RAM erasure. Transport authorization does not prove that app
content is trustworthy or that an app honors its own review screen.

The feature, commands, manual permission, bundled marker and assets are enabled only for
the distinct local-test APK. Ordinary official builds do not start this listener. No new
model weights, inference settings, official app links, account canisters or OTA policy
are introduced by the handoff.
