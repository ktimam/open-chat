# Imported local apps and isolated processors

This client-only path does not need an app registry, inbox, attestation service, or modified OpenChat canister. An explicit user import supplies a declarative catalog and, when required, a separately imported hash-pinned JavaScript artifact. Import is a trust decision; a matching hash establishes byte identity, not publisher authenticity.

## Integration

1. Parse an explicitly selected JSON file using `parseLocalAppCatalog`. The host validates strict known catalog fields and preserves the app-authored extraction schema, prompts, model prompt profiles, OCR descriptors, and normalization configuration as bounded JSON.
2. Verify imported artifact bytes with `verifyImportedLocalProcessor` against the catalog's SHA-256 and byte length. No URL fetch occurs in these modules. Re-verify immediately before execution; reject mismatches without creating an execution context or providing source data.
3. Supply `action.definition` to the existing local model/OCR runner. Replace only the legacy remote processor transport with `runIsolatedAppProcessor(artifact, actionId, JSON.stringify(input), { signal, contextJson })`. Optional imported `processorContext` is app-owned setup data, not an automatically delivered field.
4. Project final candidates with `projectLocalAppPayload`. The app declares a single, list, or named wrapped-list envelope and the strict final draft schema. The host contains no app-specific field, label, or type rules.
5. Create an in-memory `LocalAppDraftStore` draft using the imported destination and declared recipient context, never a model-selected destination. Show every projected field, exact destination, and declared recipient context before immutable review/confirmation. Do not copy the catalog, processor context, prompts, source message, or intermediate transcripts into the delivery unless they are explicitly represented in the reviewed payload.
6. Abort processors on account/logout, source, or configuration changes. Clear account-scoped drafts on logout/account change. Never fall back to the legacy network iframe or remote processor when the isolated runtime is unavailable.

`recipientLabel` is only declared review context. It is not a cryptographically verified account/sheet binding. The receiving app must review its own signed-in identity and final destination before saving. Receipt by that app does not mean saved.

## Isolation and deployment CSP

Only fixed host bootstrap code runs in a hidden `sandbox="allow-scripts"` opaque `srcdoc` frame. The app artifact is passed as message data and runs inside a blob DedicatedWorker created by that frame. It is never interpolated into HTML or executed in the host origin. Parent/frame messages check exact WindowProxy, opaque origin, one-use nonce, protocol, and version.

The frame enforces `default-src 'none'; connect-src 'none'; script-src <bootstrap-hash>; worker-src blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`. The worker inherits that policy. A host prelude locks out nested workers, BroadcastChannel, and app console output. Opaque origin blocks origin-bound storage. Timeouts, cancellation, bounded input/output, and a two-worker concurrency cap limit failures. No remote fallback is permitted.

The embedding document's `script-src` must also authorize the exact fixed bootstrap hash because `srcdoc` inherits parent CSP. Current value:

```text
'sha256-I/prlf8CUg20D4Y+eHWS9nTAgsMREJwX8s/3ln5NZms='
```

The unit test pins this value. A deployment test must assert the same value in its actual response policy; changing bootstrap bytes requires updating deployment policy together. Never use `unsafe-inline` or relax `connect-src` to make a failing processor work.

References: [CSP worker inheritance](https://www.w3.org/TR/CSP2/#processing-model-workers), [CSP inheritance for local schemes](https://www.w3.org/TR/CSP/#csp-inheriting-to-avoid-bypasses), [HTML worker lifecycle](https://html.spec.whatwg.org/multipage/workers.html).

## Verification and limits

Synthetic actual-runtime Edge tests on 2026-09-26 passed output delivery with an opaque worker origin. Fetch, WebSocket, and importScripts were blocked with zero observed requests; IndexedDB threw SecurityError; nested Worker and BroadcastChannel were unavailable. These tests used synthetic markers, not account/chat data. Unit tests cover malformed pins, input/output bounds, wrong-origin messages, cancellation, explicit context handling, and no iframe construction on pin failure. Catalog and draft tests cover strict imports, schema projection, immutable approval, explicit uncertain retries, account clearing, and no delivery before confirmation.

This is not a hard memory quota or protection against all browser bugs. A malicious artifact can consume memory/CPU before termination. Browser/APK runtime-specific isolation tests remain necessary before release; an unsupported platform must fail closed. The import UI must identify the selected app and artifact and make clear that its app-owned prompts and code affect extraction results.
