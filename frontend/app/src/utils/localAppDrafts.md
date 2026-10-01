# Private local proposal seam

`LocalAppDraftStore` is an in-memory host-owned draft lifecycle, not a chat message,
an `ActionCardContent`, an app attestation, or an app authorization token. It never
loads app code, uses an iframe, calls a canister, persists data, or performs network
requests. Existing chat cards and their verification flags are not reused.

The workspace now wraps this lifecycle with encrypted device-local persistence.
The **current required workflow** is [private cards and encrypted delivery](../../../../docs/private-app-encrypted-delivery.md).
The September 26 plaintext handoff and memory-only workspace described in historical
acceptance below are superseded and do not prove the new encryption/storage boundary.

## Integration

1. Create one store with a trusted delivery adapter and call `setAccount` on account
   change/logout. The adapter is invoked only by explicit `confirm`, `retryUncertain`
   or `reopenDelivered`.
2. After local extraction, `create({ target, schema, payload })`. Target app ID, action
   ID, destination and recipient come from trusted user-approved app configuration,
   never model output. Supply a closed supported declarative schema; unsupported
   schema keywords fail closed. No external app processor may receive data here.
3. Render/edit the returned draft locally. `edit` revokes its previous review.
4. `review(id)` returns a deeply frozen request and full canonical JSON `summary`.
   Render the summary as host-owned text, including destination and recipient. A
   separate explicit user confirmation passes that review's `approvalId` to `confirm`.
5. The adapter must encrypt exactly the reviewed payload in OpenChat before any
   BroadcastChannel, IPC, loopback or postMessage boundary. Never remap fields or relax
   the approved-origin binding. Version-2 encrypted delivery binds the app/action/revision,
   destination, request ID and connected recipient context using AES-GCM AAD. The app
   verifies its current authenticated recipient before local decryption and review. If
   app configuration changed, refuse delivery; do not silently rewrite the target.
   Map `request.idempotencyKey` to the import protocol's `importId`. It is 32 random
   bytes encoded as canonical, unpadded 43-character base64url. The protocol's
   independent handshake/session nonce belongs to the adapter, not the payload.
6. An acknowledged handoff is `delivered`, not evidence that an app action was
   saved. Transport errors, missing acknowledgements and ambiguous replies are
   `uncertain`. The UI must not label those failures as safely unsent.

The supported schema subset is object (explicit `additionalProperties: false`,
properties, required), array (items, min/maxItems), string (min/maxLength),
number/integer (minimum/maximum), boolean, null, and scalar enums. JSON values are
bounded, cloned and frozen; accessors, functions, class instances, sparse arrays,
dangerous object keys and unsupported schema features are rejected. Rich app
schemas must be compiled explicitly into this subset or supported deliberately;
do not silently discard validation keywords.

## Cancellation and uncertain delivery

After dispatch starts, edits and new reviews are blocked. A reconnect must not
automatically call delivery. The user can explicitly retry an uncertain outcome;
the same frozen request and idempotency key are retained. The app must deduplicate
that key (a new handshake nonce does not mean a new import). Repeated confirmation
and retry clicks are locked synchronously.

If the app acknowledged receipt but its review page was lost before saving,
`reopenDelivered` is a separate explicit operation. Ordinary `confirm` and
`retryUncertain` remain blocked for acknowledged drafts. The workspace checks the
current app save report again before reopening; the UI requires fresh consent
after the user checks for an existing save. The same frozen approval and import
ID are reused, without extraction or inference. Delivery adapters cancel the old
attempt and create a fresh transport binding; old status callbacks cannot affect
the replacement. Users must choose the same receiving account and destination:
an app's deduplication may be scoped to that destination, not global. Receipt is
still not saving, and no reconnect or rendering callback initiates reopening.

Calling `setAccount` with the same account preserves the in-memory view. A real
account change/logout aborts pending adapters and clears that view, not the encrypted
device-local card. The workspace restores only the matching account/backend, without
approval tokens or automatic delivery. An attempted request is immutable and restored
as uncertain with the same import ID. Fresh review and explicit retry are required.
Write-ahead persistence precedes dispatch; per-write record revisions prevent an older
tab overwriting the attempted lock. Explicit discard/Forget removes the stored card/key
and invalidates stale writers. Cancellation cannot undo an already accepted handoff.

Unit tests use only synthetic values and a mocked delivery adapter. They cover
the lifecycle boundary, not real browser handoff or app-side idempotency. Those
remain separate integration tests when the adapter and private-draft UI are wired.

## Optional declarative draft editor

An action may include `draftEditor: { version: 1, choices: [...] }`. Each choice
names an optional string field, a visible label, a distinct None label and bounded
options. Each option supplies an exact string value/label, `assign` companion
fields, and `defaults` fields. All targets must be scalar properties of the same
object row, declared in the draft schema. Selector/companion fields are optional;
targets cannot overlap between choices or form chains. Options have unique values
and labels and identical target sets. Unknown keys, hidden labels, out-of-schema
values and oversized declarations are rejected during catalog import/restoration.

`localAppDraftChoices.ts` provides immutable, draft-session-only editing history.
Initialization captures the pre-choice baseline once. Selection atomically updates
companions and applies defaults only to fields the user has not edited, including
same-value edits. None removes companions and restores the captured baseline or
absence. Rows are independent. Raw JSON editing deliberately ends baseline inference:
all subsequent defaults are protected, even after invalid JSON recovery or reordering.
Payload/schema/declaration binding rejects accidental reuse of stale history.

`PrivateAppWorkspace` owns this session, separate from persisted setup and delivery
DTOs. Recipient-only changes and panel visibility do not reset it. Failed edits
revoke approval and block review until corrected; successful edits also require a
fresh review. Schema validation and choice/companion consistency checks both run
before approval. No editing operation executes processor/model/app code or sends
data. Existing catalogs without the optional declaration keep their previous
schema/JSON behavior. Final handoffs contain no baseline/manual-edit metadata, so
receivers cannot reconstruct the sender's earlier values from the delivered DTO.

Encrypted card recovery does not persist this editing history. Restored fields are
initialized as manual values: choosing an option still updates companions, but cannot
reapply defaults or restore the pre-choice baseline on clearing. Reload/logout recovery
therefore preserves the saved values until the user explicitly edits them.

## Relay trust boundary

The cross-origin-isolated model client opens a fixed same-origin nonisolated relay
only after explicit confirmation. A fresh 256-bit nonce binds their BroadcastChannel;
the relay immediately clears its own opener and receives only an already encrypted
request. The user then explicitly opens the app; ciphertext plus bounded routing/key
metadata pass an exact-origin/window/session handshake. Neither source messages,
processor context, nor account credentials are added by the relay.
The browser handshake binds the destination origin and exact popup, not its final URL
pathname. A cross-origin redirect cannot receive an offer; a same-origin redirect stays
inside the explicitly trusted app origin. The host cannot inspect its cross-origin
popup's final pathname. The encrypted envelope authenticates the approved destination
string and opaque recipient context; the recipient UI must validate both before decryption.

An app acknowledgement means received for review, not saved. A later committed
acknowledgement means **the app reports saved**, not an independent host attestation
or proof of an actual backend write. A malicious approved app can lie about its own
state. It also retains an opener to the relay for the handshake and can navigate or
close that relay; it cannot use that link to access the isolated main client because
the relay has severed its parent opener. The relay holds no unapproved chat data.

This boundary does not defend against arbitrary malicious same-origin client code,
browser compromise, or the receiving app leaking a payload the user chose to deliver.
Cancelling/navigation/logout closes host monitoring and sends best-effort relay cancel;
it cannot recall data already received. Exact relay HTML/JS paths bypass the service
worker's main document and stale-script caches and fail closed offline.

## Synthetic browser integration evidence

Historical, superseded plaintext-protocol evidence only: on 2026-09-26, actual Edge exercised the real draft store, delivery adapter and relay
against the actual receiving app review component with mocked identity/backend only.
The parent remained cross-origin isolated; the relay displayed the exact approved
request. The app's synthetic identity popup retained its opener and returned a bound
callback. No backend write occurred during receipt, sheet/type selection or final
review. Explicit Save produced exactly one encrypted mock write (no plaintext entry
in its request), followed by separate received and app-reported-saved states. No real
account, message, image or backend write was used. This does not replace Android/APK
or real identity-provider compatibility tests.

That browser test caught the development HTML plugin rewriting relay navigations to
the app shell: relay middleware must run with `enforce: "pre"`, before HTML history
fallback. HTTP smoke checks must include a browser-style `Accept: text/html` header;
an ordinary fetch request alone did not expose this failure. Regression tests also
cover exact hidden-Unicode review rendering and host teardown of a pending relay.
