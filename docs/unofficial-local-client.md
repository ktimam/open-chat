# Unofficial local client

This is an experimental frontend profile, not an official OpenChat release. It uses
the checked-in official canister IDs without deploying modified OpenChat canisters.
Public branding, hosting and native Android authentication are separate release gates.

## Start and sign in

From the repository root, with the frontend dependencies installed:

```sh
node scripts/start-unofficial-local.mjs --port 5190 --layout v2
```

Use `http://localhost:5190`. The server binds loopback only. `--layout v1` selects the
classic interface; v2 uses the responsive mobile interface at mobile widths. This
profile ignores inherited environment retargeting, disables official OTA and supplies
the official service public key through a verified, read-only query.

Choose **Sign in with an existing passkey**. A passkey already linked for localhost
can be selected in the browser even if it was created on another localhost port.
It must be available in that browser/device; a desktop passkey is not automatically
available on a phone. If no linked passkey exists, the separate explicit linking flow
uses an official account-linking code and a confirmation before adding a credential.
It never automatically creates a new OpenChat account or retries a consumed code.

In the separate local-test APK, enter your existing username and choose
**Continue in browser to sign in or link**. Complete the passkey or explicit linking
step yourself in the local browser page. Each request expires after two minutes;
the adopted session is memory-only and expires no later than five minutes from
starting that request, not five minutes after successful sign-in. After expiry,
sign in again explicitly. A linked credential is not deleted when this session ends.

## Private apps

Open **Private apps** from the classic (v1) main menu or profile's apps section.
In the responsive v2 interface, use your profile's **App settings → Private apps**.
There is no floating launcher over the chat. These entries open the same private
workspace; they do not run inference or send app data.

1. In the receiving app, explicitly export its local setup catalog and processor.
   A private catalog can contain the app's private vocabulary/defaults; keep it private.
2. In **Private apps**, import the catalog, select its app/action and import the
   matching processor. The declared hash verifies an exact file, not publisher trust.
   No app code or metadata is fetched automatically during message processing.
3. Select an available local model, or a supported local-reader mode, and use
   **Propose** on one text or image message. Both UIs share this pipeline; app
   proposals do not currently accept voice messages.
   App prompts, labels, rules, extraction and normalization remain app-owned.
4. Edit the local draft using its app-labelled fields. Setup controls are collapsed
   once there is a draft; **Advanced: complete payload (JSON)** remains available
   for structured fields and repairs. Nothing is posted to the chat or sent to the
   app for card verification. Every edit invalidates the previous approval.
5. Confirm the full request, including its destination and recipient review label.
   A separate browser relay displays it again and asks before opening the receiving
   app. In the local-test APK, first pair that relay as described below.
6. Review the actual account/destination inside the app, then explicitly save there.
   **Received** is not **saved**; the latter means the app reports that it saved.

Per-chat app opt-in enables suggestions from imported declarative rules for fresh
messages only. It does not grant the app access to chat history. Models do not run
merely to display a suggestion.

The explicitly enabled unofficial browser profile offers all-WebGPU models on
desktop as well as mobile. Select/download them in **On-device models** before
processing a message. Model visibility does not bypass hardware, image-decoding
or verified-download checks. Native WebGPU packaging remains Android-only; this
does not enable desktop native/iOS or change the official client's platform policy.

### Local-test APK browser handoff

After **Send reviewed request**, the APK displays an exact localhost browser URL
and a one-use pairing code. Choose **Copy pairing code** and **Open local browser**,
enter the code only on that displayed page, then select **Load reviewed draft**.
The URL itself contains neither the code nor the draft. Copying is optional and
explicit; your device clipboard may retain the code after it expires.

The code expires after two minutes and can claim the approved draft only once.
After a successful claim, the browser has up to ten minutes to complete delivery.
Review every field and the destination again before opening the receiving app.
The receiving app asks you to allow the one-time connection before it receives the
approved payload. Review its actual account and destination, then save there.
**Received** does not mean that anything has been saved.

Discarding the draft or changing account cancels the pending native handoff. Data
already handed to the receiving app cannot be recalled. If the outcome is uncertain,
check the app before choosing the explicitly confirmed retry with the same import
ID. There is no automatic retry or automatic browser/clipboard action.
**Close** only hides the workspace; use **Cancel / discard local draft** to cancel
pending work.

If the receiving page closes or reloads after **Received** but before saving,
return to the still-open client and choose **Reopen the same reviewed request**.
First check the receiving app for an existing save, then explicitly acknowledge
the warning. Reopening preserves the entire approved request and import ID; it
does not rerun extraction or inference. The previous handoff is cancelled and a
new browser relay or native pairing is created. Review the same receiving account
and destination again: an app may deduplicate only within that destination, not
across different accounts or sheets. Reopening is unavailable once the current
handoff reports **Saved**, and never occurs automatically.

Private drafts provide generic scalar-field controls from the app's declared schema
for single items and lists. These edit the same canonical payload used for review;
there is no second submission object. Optional absent values are different from an
empty string, zero, false or null. Removing an optional field omits it. Incomplete
numbers do not become zero, and invalid or oversized edits cannot approve or send
the previously valid request. Non-scalar values remain available through the full
JSON editor and complete preview. These controls do not run inference again or
interpret an app's private processor context. App-specific dependent choices, such
as selecting a saved template and applying its defaults, remain in the receiving
app unless the app supplies a supported declarative contract for them.

Private drafts also show an app-declared preview: title, disclosure and labelled
fields, repeated for each item. It is derived from the current valid JSON editor,
not a second submission payload. Additional fields remain visible; hidden text
controls are escaped. Invalid edits remove the preview until corrected. The full
JSON editor and exact-request review remain authoritative. Imported app button
labels never replace OpenChat's explicit external-send or discard controls.
This renderer is shared by both UIs and contains no app-specific formatting rules.

### Process with AI and `/ai` are chat actions

**Process with AI** runs local inference on the selected message, then automatically
posts its answer as a normal reply to the current chat. It does **not** open a private
draft or provide an app-delivery review step. `/ai` likewise posts its output to chat.
Local inference therefore does not mean the resulting answer stays only on-device;
chat participants can see the posted answer. Do not use these actions when you want
an unsent private app proposal; use **Propose** instead.

Voice messages are supported by **Process with AI** when a compatible model's
optional audio support is enabled. This does not add voice input to app proposals.

### Remembered setup; session-only drafts

Imported app catalogs, the selected app/action, its verified processor file and
enabled chats are remembered on the same device for the same signed-in account
and configured backend. This includes private app-owned setup/context, such as
user-defined labels. A separate IndexedDB store is used; nothing is synchronized
to OpenChat or an app. This is not chat encryption or a promise of encryption at
rest. Browser profiles/origins and the APK installation have separate storage.

Restore revalidates catalog declarations and processor hashes without executing
app code, running a model or contacting an app. Chat opt-ins bind to the exact
catalog, not only its reusable app ID. Replacing a catalog clears those opt-ins.
Setup controls wait for restoration; a failed read/write is shown rather than
reported as saved. Invalid or future-version records are not silently accepted.

**Forget this account's app setup on this device** removes catalog, processor,
selection and chat opt-in content. A minimal account/backend invalidation marker
remains to reject writes started by an older tab before Forget. Another tab may
still hold its previous setup in memory, but cannot silently save that stale copy
over the removal. Clearing browser/app storage also removes these markers.

Drafts, source messages/images, extraction results, edited fields, recipients,
approvals and handoff details stay in memory only. Reload/logout/account change
discards them. An uncertain delivery is never retried automatically. Check the
receiving app first, then use **Retry the same reviewed request** if the draft is
still available, preserving its import ID. Create a new draft only after checking
that the earlier request was not already saved. Downloaded model caches are
separate and are not deleted when changing apps or models.

### App-defined choices in the private draft

An imported app can declare named choices and their scalar companion fields/defaults.
The private editor shows the app's labels alongside the exact outgoing values. Choosing
an option updates its declared companion fields atomically; those fields are read-only
outside Advanced JSON. Clearing a choice removes its companions and restores the
original defaulted values, unless the user has explicitly edited those values.

Choice history remains in the current draft session through closing/reopening the
panel and changing the recipient. It is not saved with app setup or sent to the app.
Advanced JSON is authoritative: editing it clears that history, and later choices do
not reapply automatic defaults. Unknown choices or inconsistent companion values block
review. Every edit invalidates the previous approval; changing a choice does not run a
model or processor again or contact the receiving app.

Apps own the declarations and meanings. OpenChat implements only the bounded generic
editor contract; it does not interpret app-specific Types, dates or business rules.
The receiver sees only the final reviewed payload, not the sender's editing history.
After updating a processor/catalog pair, explicitly import the new matching files;
old imported setup is not silently replaced.

## Boundaries and developer checks

- The client and worker both reject unsupported custom-registry/card APIs in this
  profile. The bundled frontend catalog replaces custom-backend model discovery.
- Imported processors run in a bounded, opaque-origin worker with network/storage
  blocked. This is not a hard CPU/memory quota or protection from browser compromise.
- In the localhost browser profile, the model page stays cross-origin isolated.
  Only the exact fixed relay routes use non-isolated headers; those routes bypass
  the service worker's document cache. The local-test APK WebView is a separate
  secure-context profile and does not require cross-origin isolation: its local
  inference runtime uses single-threaded WASM support alongside WebGPU. Imported
  app processors still run in the separately isolated, network-blocked sandbox.
- The handoff binds exact origin, popup and fresh nonce. It does not authenticate a
  destination pathname, receiving account, or the honesty of an approved app.
- The relay holds only approved data and severs its opener to the main client. The
  app cannot gain the main client's chat access through that opener chain.

See `frontend/app/src/utils/localAppDrafts.md` and `isolatedAppProcessor.md` for the
protocol and threat boundaries. Run frontend `npm run typecheck`,
`npm run typecheck:agent` and `npm test`; relay, worker and both-UI wiring regressions
are part of the default suite. Real browser navigation tests must use a normal HTML
navigation Accept header, not only plain fetch/HEAD checks.

Synthetic browser coverage is not proof of real model accuracy, existing-account
sign-in, ledger delivery or native APK behavior. Keep these acceptance gates separate.

## Rebuilding the separate local-test APK

Use a clean source snapshot and retain its complete root `Cargo.toml` and
`Cargo.lock`. With the reviewed frontend dependencies and Android/Rust toolchains
already installed, the repository's build entry point is:

```sh
node scripts/build-unofficial-local-apk.mjs --target x86_64
node scripts/build-unofficial-local-apk.mjs --target aarch64
```

Each command builds frontend assets for the separate `dev.openchatfork.localtest`
package with official OTA disabled; neither installs an APK nor accesses an account.
For a no-download run, require offline Cargo and Gradle dependency resolution and
stop if a dependency is missing. A native-only reuse of frontend output must preserve
and verify its exact hashes/build ID; do not reuse an older frontend after UI changes.
Export each ABI's APK before the next build, and verify its signature, package,
embedded assets and source identity. Building does not qualify device behavior.

Record acceptance separately for browser authentication, model completion and
accuracy, private proposals, receiving-app persistence, APK integrity, native
startup and real native authentication. A passing screenshot of the sign-in form
does not prove account sign-in or app delivery; a completed model response does
not prove that its contents match the source.

At the September 28 local checkpoint, existing-account Edge sign-in and session
restoration, real Qwen/Gemma text inference and retained-cache model switching
have been observed. Generic text summarization still has a known fidelity issue:
it can infer a relationship absent from the source. App-owned image proposals and
real receiving-app saves remain pending, not covered by those text checks.

The normal x86 APK005 passed independent binary checks and three process-cold
startup/stability checks after closing an unrelated hung emulator Chrome process.
Earlier inconclusive inspections and APK004's native startup crash remain recorded.
The app-owned startup-order mitigation initializes the existing WebView provider
before Wry's timed runtime lookup; it does not fix every possible upstream lookup
timeout. Its separate intentional-delay diagnostics remain approval-blocked.
The later APK007 x86 and ARM builds from `e6091abff` both passed static package,
signer, source and embedded-asset checks; they have no new device-runtime pass and
predate the received-request reopen fix above. Real native sign-in and physical-phone
tests are not passed; physical-phone testing is explicitly deferred for this checkpoint.
Keep all source commits, reused-frontend hashes, limitations and later results in
the artifact's own build and acceptance records. Do not relabel older evidence.
