# Private cards and encrypted app delivery

Required contract, approved 2026-10-01. This replaces the September 26 plaintext
local-handoff design; encrypted ledger storage alone does not satisfy this contract.
Source/test updates are not evidence that an existing server or APK is updated.

## User workflow

1. Open Apps → AI Apps, open the app's card and choose Connect in its details.
   Normal setup needs no file uploads or separate app-management page.
2. Sign in to the app and select the intended account/sheet. The app recovers or creates
   the user's delivery keypair using its existing user-controlled key recovery.
3. After explicit connection consent, the app provides its public delivery key and an
   opaque recipient binding alongside its prompts, schemas and private setup. Neither
   the private delivery key nor the sheet storage key is shared with OpenChat.
4. Propose on the selected message/image. The selected local model or local reader and
   app-owned constrained processor extract fields on-device. No plaintext remote card
   verification is permitted. OpenChat has no app-specific field or business rules.
5. Review/edit the private card. Its content is saved encrypted on this device, separately
   from chat messages; it is not posted, synchronized, or backend-attested.
6. Review the exact fields and destination, then explicitly approve delivery. OpenChat
   durably records the stable request ID and attempted state before any dispatch.
7. OpenChat encrypts the fields to the linked recipient key BEFORE BroadcastChannel,
   native IPC, loopback HTTP or app postMessage. Only the encrypted envelope leaves the
   originating client. Missing/invalid keys require reconnection; no plaintext fallback.
8. The app receives ciphertext. Its authenticated UI recovers the recipient's private
   key and checks the bound account/sheet before decrypting locally into an unsaved draft.
   The browser/native relay presents that normal app UI directly in its bound frame;
   there is no intermediate JSON page, manual pairing or second destination picker.
9. Review again in the app's existing entry form or batch review, including app-owned
   calculations and the exact receiving sheet. IOU uses Pending from chat → Review & add.
10. On explicit Save, the app separately encrypts final entry contents with the sheet key
    and submits ciphertext through its existing backend API.
11. Report receipt and saving separately, using request IDs/status only. Receipt is not
    proof of saving, and an app-reported acknowledgement is not independent attestation.
12. Retry only on explicit user action, preserving destination, payload and request ID.
    Restoring a card never restores a sending approval or automatically sends anything.

The existing Explore and connected-apps surfaces share this flow in both layouts.
Directory listing is automatic; app connection still requires an explicit gesture.
New proposals use a compact private card beside their source message in both layouts.
The original app-declared field order, labels and controls remain app-owned; encrypted
local storage does not require a separate generic draft-editor page. A source message's
**View private card** control reopens its saved card without running inference again.
There is no separate **Saved cards (N)** manager. Setup, catalog uploads and account-wide
Forget controls are not part of the card. Older stored records are not deleted by this
UI repair; do not infer that a missing source link creates a new management route.

One host editor retains the active card and moves to its source-message anchor;
virtualized messages do not create their own editors or clear the workspace. Anchors are
bound to account, backend, chat kind, chat key, message ID and thread. If a source leaves
the rendered chat, its editor is retained hidden until that source returns. Pending or
failed extraction never displays a retained card as its result. Closing or changing views
does not count as approval, and reopening a card never sends it. A pending invalid field
edit must be corrected before switching cards or approving a request.

Compact cards keep invalid-value warnings and app disclosure visible. Optional field
actions and app-controlled companion values are grouped under one optional **Details**
disclosure; the complete payload and exact reviewed request remain inspectable. No field is omitted from
the approval or encrypted delivery because its presentation is collapsed.
The directory can refresh while cards are retained, but automatic recipe changes
wait so they cannot replace a card's frozen configuration. Explicit connection is
allowed without deleting cards. This uses client-side publisher discovery and the
app's own connection page, not custom OpenChat registry/card canister APIs; no
OpenChat canister change or deployment is required.

## App-owned card presentation

The app's `definition.card.rows` supplies the default order and labels of its review fields.
Fields omitted from those rows remain visible; presentation never removes payload
fields. Existing schema enums and `draftEditor` named choices remain authoritative.

An action may supply `draftPresentation` version 1 with `enumLabels` and optional
`controls`. Each control names one plain, non-enum string field and selects `kind`
`text`, `multiline`, `date` or `select`, with an optional boolean `fullWidth`. Text
controls may provide `suggestions`; select controls require them. These lists are
suggestions, not a new enum: an existing value absent from the list remains visible
and is not replaced or normalized. It is accepted only when it satisfies the field
schema. Named choices take precedence over string-control hints.

There may be at most 32 controls and 256 unique suggestions per text or select control. Each
suggestion is trimmed, nonempty, at most 128 characters, free of control/invisible
format characters, and valid under the existing string schema. The complete metadata
retains the 64 KiB safe-JSON limit. Unknown keys, hidden-field flags, HTML controls,
duplicate fields and value defaults are rejected. `enumLabels` remains required but
may be empty when nonempty controls are supplied. Earlier label-only catalogs remain
valid and catalogs without presentation hints use the generic controls.

Date hints use exact Gregorian `YYYY-MM-DD` dates in years 0001–9999. The shared
`isValidLocalDraftIsoDate` helper only checks: it never trims, normalizes or replaces a
value. A supplied malformed date must remain visible as text and require correction
before review; it must not become an empty native date input and silently disappear.
An absent optional date remains absent. These hints contain no executable markup,
app business rules or delivery authority, and are never added to the encrypted DTO.

Final draft string schemas may declare a bounded `pattern`, separate from the app's
model extraction schema. The supported form is an anchored character class containing
one or more distinct ASCII ranges `A-Z`, `a-z` or `0-9`, followed by `{n}` or `{min,max}`;
for example, `^[A-Z]{3}$`. Bounds must be ordered nonnegative integers no greater than
65,536. OpenChat parses this limited notation and checks characters and length; it
never compiles or executes an app-supplied regular expression. Other pattern syntax
is rejected. A pattern does not trim, normalize or replace values: invalid edits remain
visible but fail final draft validation before review or delivery.

### Optional inert layout: `draftView` version 1

An action may also include `draftView: { version: 1, nodes, theme? }`. This is
app-owned presentation data, not HTML, JavaScript, arbitrary CSS or an iframe.
The authoritative contract is
[`LocalAppViewV1` and its validator](../frontend/app/src/utils/localAppView.ts);
the host renders it in
[`PrivateAppDraftFields`](../frontend/app/src/components_shared/PrivateAppDraftFields.svelte).
One tree describes one canonical item selected by the action's `single`, `list`
or `wrapped-list` handoff. The host owns item count/order and edit/read-only mode.

The supported nodes are:

- `group` and `row`: nonempty `children`, with optional `gap` and `padding`
  (`none`, `small`, `medium`), `surface` (`plain`, `card`) and `radius`
  (`none`, `small`, `medium`). Rows wrap at the available width.
- `field`: a unique reference to a declared scalar field in that item's schema.
  Its name must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`; unknown, duplicate,
  object and array references are rejected. Optional `minWidth` is an integer
  from 80 to 320; `fullWidth` is a boolean. Optional `control` is `single-line`
  or `multiline`, permitted only for non-enum strings. Existing named choices,
  date/select hints, suggestions, defaults and validation remain authoritative;
  a layout hint cannot replace those semantics.
- `text`: nonblank inert text, with optional `tone` (`normal`, `muted`, `accent`)
  and `size` (`small`, `normal`, `heading`). The host renders text, never markup.

The tree allows at most six node levels, 128 nodes and 32 entries in each child
list, including the top-level `nodes`. Each text node is limited to 512 UTF-16
code units, with 4,096 total across text nodes; control/format characters,
line/paragraph separators and unpaired surrogates are rejected. The existing
64 KiB safe-JSON snapshot bounds also apply; accessors and executable values
are not accepted or invoked. Unknown keys and unsupported tokens are rejected.

Optional `theme` contains nonempty `light` and/or `dark` palettes. A palette
may contain only `background`, `surface`, `field`, `text`, `muted`, `border`
and `accent`, each an exact `#RRGGBB` value. The host chooses its current theme
and maps these roles inside the app-presentation subtree only. Host review,
destination and delivery controls remain outside that subtree. Controls retain
a minimum 44-pixel height; the host also controls native date color scheme.
Validated colors are not a contrast or accessibility guarantee: app text/paint
can still mislead, so it must never substitute for complete host review.

For example, an action whose item schema declares numeric `reading` and plain
string `annotation` may use this view; the schema, labels and actual values
remain in their existing action/draft declarations:

```json
{
  "version": 1,
  "nodes": [
    {
      "kind": "row",
      "gap": "small",
      "children": [
        { "kind": "field", "field": "reading", "minWidth": 96 },
        { "kind": "field", "field": "annotation", "control": "single-line" }
      ]
    }
  ]
}
```

Catalog import validates the view against `draftSchema` and `handoff`, retains
only the frozen raw view, and rejects invalid metadata. The validator's coverage
fields and `requiresCompleteHostReview` result are host diagnostics, not catalog
properties. Public-directory verification binds the view to the published
action; private Connect setup cannot add, remove or alter it. JSON object-key
ordering does not change that equality. A view contains no field values,
replacement labels, destinations, approval or send instructions.

The normal card revalidates the view and uses the existing field-edit callbacks.
Absent metadata uses the compact generic renderer. If supplied metadata is
invalid at rendering time, canonical fields remain visible but review is blocked;
invalid metadata is not silently treated as an acceptable fallback. Unrepresented
scalar fields appear outside app paint, while complex/envelope values remain in
the canonical preview and advanced JSON. After **Review**, every outgoing value
is shown in host-owned review outside app paint before explicit confirmation.
Edits revoke approval; incomplete edits block review/send. Delivered app-view
cards are read-only. Layout does not project the payload or change encryption,
request identity, recipient binding or retry rules.

Saved cards retain their frozen app/view setup. Connecting a newer published
view enables it for new proposals; it does not rewrite existing cards, restore
approval or send anything. This contract is packaged in build031, but fresh
connection/new-view adoption and final APK delivery still need the separate
[current acceptance checks](unofficial-local-client.md#current-local-test-completion-checklist).

## Cryptographic and transport contract

Private setup contains `deliveryEncryption` version 1, scheme
`p256-hkdf-sha256-aes-256-gcm-v1`, SHA-256 SPKI `keyId` (lowercase hex), canonical
base64url P-256 `publicKeySpki` and opaque base64url `recipientContext`. Public
discovery catalogs must not contain recipient keys. The exact-origin/window/nonce
Connect flow and the app's signed-in key recovery establish the binding; this is not
an OpenChat-backend identity attestation. Do not accept model-supplied keys or routes.

The app-import message protocol is version 2. An offer contains exactly type,
version, sessionNonce, importId, appId, appRevision, actionId, destination and envelope.
It has NO payload property. The envelope has version, scheme, keyId, recipientContext,
ephemeralPublicKey, salt, iv and ciphertext. All binary values use canonical unpadded
base64url. Each encryption uses fresh ephemeral P-256 ECDH, 32-byte salt, HKDF-SHA256,
AES-256-GCM and a 12-byte IV with a 128-bit authentication tag. HKDF info is UTF-8
`openchat/private-app/handoff/v1`. AES additional authenticated data is UTF-8 JSON:

```text
["openchat/private-app/handoff/v1",appId,appRevision,actionId,destination,importId,keyId,recipientContext]
```

The encrypted plaintext is the exact reviewed payload JSON. The independent transport
nonce is not in the encryption AAD, so explicit retries use the same request ID with
a fresh handshake. Re-encrypting identical fields must not create a second entry;
changing fields under the same ID must fail. Reject legacy plaintext offers, mixed
plaintext/encrypted objects, malformed keys, noncanonical binary values and unknown
protocol versions. Maximum plaintext is 64 KiB; total bounded relay request is 112 KiB.

Routing identifiers, recipientContext, key fingerprint, ciphertext length and status
are visible metadata. Base64url does not hide recipientContext. Do not put entry fields
or source text in that context. Encryption provides confidentiality/integrity to the
recipient, not proof of who authored the message or truthfulness of the extracted fields.

## Local storage and restart

The October 2 collection format retains up to eight private cards, with a combined
256 KiB plaintext limit including their schemas, frozen app configuration and local
references. Each card retains its editor, recipient, draft/request IDs and attempted
state. The collection and active-card selection are encrypted with AES-GCM and a
nonextractable device-local IndexedDB key, scoped to OpenChat account and backend.
Capacity failure never evicts or replaces an existing card. App/action presentation,
choice semantics and delivery keys remain pinned to the card that used them; changed
configuration cannot silently retarget a saved request. New proposals use the current
connected configuration, not an old card's frozen configuration.

Only host-captured chat/message identifiers, an optional chat kind and optional
message/thread indices associate a card with its source. These references stay
inside the encrypted local collection;
they are not source content, chat messages or outgoing app DTO fields. Re-proposing
the same source for the same app/action resumes its retained card without inference.
The source message's **View private card** control selects its retained card. An old
bare-principal reference does not distinguish a direct chat from a group, so the
client does not guess a navigation URL. Re-proposing that same message fills in the
missing kind/position without inference or creating another card. Navigation preserves
the card and its edits, requires a new review, and sends nothing to the receiving app.
Malformed references cannot become navigation URLs. None of this posts a card to
chat or persists original message content. Do not persist approval tokens, transport
pairing codes, original images or chat history.

Panel close/navigation do not discard cards. Logout clears the live view but keeps
the encrypted collection for the same account/backend. Discard removes only the
selected card; an empty encrypted collection may remain. Disconnect removes only
the selected app's connection and chat opt-ins, retaining its cards as inspect-only.
A matching reconnect and fresh review are required before delivery; different
configuration cannot silently retarget a retained card. Neither operation recalls
a delivery or undoes an entry saved in the receiving app. Cancelling new inference
retains existing cards. Switching cards revokes approval tokens and resets explicit consent; pending unrepresentable
field edits block switching rather than hiding a stale payload.

Version 2 is bound in both the outer record and authenticated data, so an older
single-card client cannot read or overwrite it. An authenticated legacy card is read
without rewriting storage and migrates atomically on the next explicit write, keeping
its exact draft and request IDs. A legacy card lacking frozen app metadata uses matching
current configuration only; unavailable or changed bindings remain inspect-only.
Per-write revisions and atomic compare-and-swap prevent stale tabs from replacing a
newer collection or erasing attempted-send state. The internal `forgetSetup()`
operation removes setup and all cards/key and rotates the generation to prevent stale
asynchronous or other-tab writes from resurrecting removed data. It remains covered
by storage tests but is not exposed as a normal Apps button.
Show storage failures honestly and block delivery if write-ahead persistence fails.

Restore an unsent card as unreviewed. Restore an attempted card conservatively as
uncertain, retaining the original fields/destination/request ID and requiring fresh
review and explicit retry. Do not rerun inference or silently apply new app defaults.
Storage is device-local, not backup/sync or chat E2EE. A same-origin malicious script
or compromised device can still invoke its nonextractable key. After authorized local
decryption, the receiving app frontend can read the fields and must itself be trusted.

## Required tests and release gates

- Real sender encryption to actual app decryption, exact field round trip, wrong key and
  tampered route/action/revision/request/context rejection, and no plaintext fallback.
- No plaintext marker on browser BroadcastChannel/postMessage or native IPC/loopback;
  no release before confirmation or successful write-ahead, nor after abort/logout.
- No ledger write on receipt/decrypt/review; only second approval triggers encrypted save.
- Same-ID equal-field re-encryption dedupes; changed-field replay fails; receipt is not saved.
- Card reload/account/backend separation, local ciphertext tampering, interrupted send,
  explicit discard, internal Forget, disconnect/reconnect, stale-write races and
  visible quota/storage failures.
- Run scoped CI without waivers. Browser/native acceptance must be reported separately
  from unit tests; old plaintext-handoff acceptance does not prove this protocol.

## Source verification checkpoint: 2026-10-01

The October 1 single-card checkpoint had the following local results. These historical
counts do not establish acceptance of the later multi-card extension:

| Check | Result | Boundary |
| --- | --- | --- |
| OpenChat private-app feature tests | 588/588, 27 files | Crypto, transports, persistence, workspace and UI |
| IOU OpenChat/batch tests | 1,946/1,946, 78 files | Earlier checkpoint, before the later image-test additions; recipient keys, decryption, consent and encrypted saves |
| Cross-checkout integration | 98/98 | Actual OpenChat encryption to IOU decryption; no write before second approval; retained image-output replay |
| Image contract and recipient feature tests | 421/421, 7 files | Includes two explicit source-fidelity limitation characterizations; not new model inference |
| IOU recipient key lifecycle tests | 42/42, 2 files | Includes delayed secure-storage writes and recovery during key deletion |
| Scoped offline CI contracts | 777/777, no skips | Current inventories, baseline, formatter and security wiring; not an online advisory audit |
| Native handoff source harness | 18/18 | Actual Rust protocol/bridge source; not a full plugin or APK build |
| Type checks | No errors | OpenChat Svelte check and both IOU TypeScript configs |
| Full OpenChat frontend regression | 5,073/5,073, 339 files | Rerun after the optional-audio routing correction and actual HF audio-merge tests; no skips, failures or unhandled errors |

The OpenChat check retains 572 existing Svelte warnings. The CI refresh retains
historical inventories and existing advisory decisions; it does not waive failures
or audit unrelated OpenChat core dependencies.

The full regression initially exposed an outdated native workspace test mock missing
`setClient`. Adding that one mock method preserved all assertions and corrected the
fixture; no production-code repair or runtime fingerprint change was needed.

Four existing, sanitized small-Qwen/Gemma Arabic and date-range outputs were replayed
verbatim through the actual host parser, app processor, generic Type initialization,
sender review, encryption and recipient decryption. The tests preserve the expected
amounts, dates, notes and Type direction without a ledger write. They do not rerun the
models or upgrade a historical strict-format failure to a passing inference result.

Two separate synthetic tests expose a limitation in the unchanged image contracts:
printed direction, description and footer-only Type evidence are not requested by
those contracts. Successfully parsing their output therefore does not establish that
all source facts survived. These tests explicitly assert that mismatch; they are not
image-accuracy passes. No prompt, processor or model package was changed.

Final review found and fixed a recipient key-clear race in IOU. Receive-only recovery
could finish a native secure-storage write after key deletion. It now joins the same
active-operation tracking as normal recovery and rejects new recovery while deletion
is pending. Both new regressions failed before the fix and passed afterward; recovery
still cannot create or replace a delivery key. This is tested source behavior, not
native device acceptance. The IOU production frontend was rebuilt successfully after
the correction, and the running local frontend serves the corrected module.

An isolated actual Edge test loaded the production draft/storage modules, saved a
synthetic card to IndexedDB with a nonextractable key, reloaded the page and restored
the exact fields and stable request ID without sending approval. It also checked
account/backend separation, Forget and stale-writer rejection. A second test proved
that a stale editor cannot overwrite the durable attempted-send state: the restored
card stays uncertain and unapproved. Synthetic cards/keys were removed afterward;
no real chat or ledger entry was sent or saved.

These source and isolated-browser checks are distinct from the built-artifact and
authenticated browser results below. Model packages and prompts are unchanged;
neither checkpoint is new image-accuracy or physical-phone GPU acceptance.

### October 2 multi-card source checks

The collection, workspace, UI and existing private-app suites pass 734/734 tests in
28 files. They include authenticated legacy migration, two-card reload and selection,
per-card discard, attempted-A/editable-B isolation, source resumption, frozen app
configuration, stale-writer/Forget races, capacity/quota failures and mandatory
write-ahead delivery. Svelte checking reports zero errors with 572 existing warnings;
targeted TypeScript lint passes. These are source checks, not browser, APK or native
provider acceptance. Existing installed artifacts and the earlier single-card browser
receipts must not be relabeled as multi-card verification.

### October 2 source-navigation correction

The source correction uses the actual host `chatIdentifierToString` format in
both message layouts, adds optional chat kind/message position to encrypted local
references, and uses the existing OpenChat route/navigation functions. Legacy
references are not rewritten into a different key format. Re-proposing the same
source backfills missing navigation metadata without inference or a duplicate card;
an ambiguous old direct/group reference cannot invent a link.

The complete frontend suite passes 5,606 tests with no failures or pending tests.
The checks include real direct/group/channel key formats, index zero, thread
navigation, immutable attempted requests, and invalidation of recovery review
tokens when leaving both delivered and uncertain cards. The initial complete run
failed nine native UI cases because their mocks omitted the added state/import;
the final run includes those repaired fixtures without skipping tests. The recovery
approval defect found by independent review was fixed in production code, not by
relaxing the tests.

Final-source Svelte checking reports zero errors and 572 warnings; the agent
TypeScript check also passes. Changed-file ESLint reports zero errors, with three
ignored-Svelte-file warnings from the existing lint configuration. Svelte source
validation is covered by the separate Svelte check, not claimed as ESLint coverage.

The approved source inventory binds 158 files, 123 dedicated owners, 96 exact
anchors and 26 dependency roots under fingerprint
`a52d271ac945ba6ebd5971f10ca94d256db981fac53979542cbed8377025e4d9`.
All 816 offline scoped security contracts pass (166 npm and 650 remaining
contracts), along with the CI wiring and 480-file scoped formatting checks. This
adds only the already-installed router dependency reached by source navigation;
no package upgrade, advisory waiver or whole-repository audit is included.

These are source-test results only. They do not qualify the already-built APK020
or prove current browser/native layout, navigation, account restoration or delivery.
The new release inventory and rebuilt-artifact/runtime checks remain separate gates.

## Built artifacts and authenticated browser verification

Both optimized web layouts were rebuilt on 2026-10-01 from fork main `6249be2431`
plus the reviewed, uncommitted encryption/persistence changes. Independent checks
verified official OpenChat service configuration, disabled OTA, CSP, included
encryption/storage modules and unchanged pinned model/runtime assets. The local
preview served the v2 build at that checkpoint. IOU's existing local frontend served
its updated receiver; its production build also passed. No canister was deployed
or reset.

In the existing Edge profile, a synthetic text proposal completed the real workflow:

- The existing OpenChat account/chat and connected app setup survived the new bundle.
  Reconnecting IOU supplied the recipient public key without manual file uploads.
- Reload before sending restored the exact card and request ID, without restoring
  consent or a handoff session. Only an explicit reviewed send opened the ciphertext
  relay. The signed-in IOU user selected the bound sheet and decrypted the same fields.
- IOU's second review showed its final fees, schedule and destination. Explicit Save
  succeeded, and a fresh sheet reload read back the exact synthetic entry.
- Closing both delivery windows and reloading restored the attempted card as locked
  and uncertain. After a fresh review, an explicit same-ID retry was acknowledged as
  already saved. Another fresh sheet reload showed exactly one matching entry.
- Switching to the verified v1 web build restored the same card and request ID with
  retry disabled until separate consent. Returning to v2 preserved it again.

The live delivery test used the desktop interface. It does not prove image extraction
or APK handoff. Transport plaintext rejection is separately
covered by the instrumented tests; this run was not a network packet capture.
The test left the saved card on the device. Its conservative uncertain status after
restart is deliberate, even when the previous session received a saved acknowledgement.

Separate Edge checks used a verified 390 by 844 viewport for both web layouts. Each
restored the existing account, chat and encrypted card without approval. Neither card
had horizontal overflow. Both model screens displayed retained Qwen and Gemma downloads,
the existing model-only/WebGPU configuration and optional voice controls. These checks
did not change models, download weights or send the card. Responsive browser testing
does not establish Android WebView, emulator or physical-phone acceptance.

Both Android ABIs were rebuilt from the same frozen source and UI. Their independent
checks passed for package/signer continuity, official service configuration, original
Credential Manager code and embedded assets. These are local-test artifacts, not a
release: installed account/provider, card recovery, encrypted handoff and repeated
model inference still require native runtime acceptance. Physical-phone testing is
deferred. Remaining hosted/security gates are not waived by these local results.

The verified x86 APK was subsequently installed over the existing emulator test app
without uninstalling or resetting data. Its installed hash matches; UID and original
installation time are unchanged. Cold startup and an empty crash buffer passed, but
these diagnostics do not establish visible account restoration or native handoff.

A subsequent web rebuild corrected optional model/audio download routing in both
layouts; independent checks retained the same encryption, storage, auth and pinned
model assets. The live v2 browser successfully installed voice support, but actual
synthetic voice transcription still failed. A public recording subsequently passed
both isolated inference and the normal message action. See
[the web test boundary](unofficial-local-web.md#checks) for the remaining accuracy
and latency limits. Both verified APK019 artifacts included the routing fix;
neither was installed or runtime-qualified at that checkpoint.

The subsequent October 2 web and APK020 artifacts include the compact app-defined
card UI and encrypted eight-card collection from commit `94cb746197`. Independent
artifact checks passed for both layouts and architectures, and a read-only check
matched the emulator's installed x86 APK to the verified artifact. These are
packaging and installed-file identity results, not current multi-card UI,
storage, provider or delivery runtime acceptance. See
[the historical APK020 checkpoint](unofficial-local-client.md#october-2-multi-card-web-and-apk020-checkpoint)
for exact identities, hosted CI results and remaining gates. The earlier browser
acceptance above must not be relabeled as acceptance of these newer artifacts.

The October 2 main Apps UI replacement removed the separate management page while
retaining encrypted cards and app-owned presentation. The
[historical APK022 and web checkpoint](unofficial-local-client.md#october-2-main-apps-web-and-apk022-checkpoint)
records its static artifact proofs and limited emulator list/details/Connect
interaction, not completed connection or card delivery for that build.

The later build026 desktop image-to-encrypted-delivery/save/readback result and
the [October 4 APK028 native lifecycle acceptance](unofficial-local-client.md#october-4-apk028-build-and-emulator-lifecycle-acceptance)
remain evidence for their exact artifacts. APK028's approved same-ID retry
reached encrypted IOU delivery, receiving-app review, replayed Save/readback
and natural return, with foreground-service cleanup. That result is not a fresh
build031 delivery test or evidence that APK022 passed those checks.

For the October 5 build031 checkpoint, both web layouts and APK ABIs have static
artifact proofs. Normal-browser checks retained old saved cards and their frozen
setup; the new compact fallback renderer was observed, not fresh adoption of the
app-owned view. The x86 APK was installed in place with matching bytes, but its
post-install UI/session/card restoration remains unverified. Fresh Connect/new
`draftView` proposals, model accuracy and final encrypted receiver save/readback
remain separate pending gates. Use the
[current local-test completion checklist](unofficial-local-client.md#current-local-test-completion-checklist)
for their status; neither historical delivery nor static packaging grants public
release acceptance.
