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
uses an official account-linking code before adding a credential. For an existing
account, choose Restore/sign-in rather than Sign up. If linking has an uncertain
outcome, check that account before submitting another code; this profile now uses
the original shared authentication and linking transport.

The separate local-test APK now uses OpenChat's original onboarding UI and native
Android Credential Manager path. Restore an existing account using an available
passkey or the original account-linking-code flow. Linking verifies the code,
creates a credential through the selected Android provider, and finalises linking
with the official identity service. There is no special browser sign-in page,
browser authentication listener or browser-provided identity adoption in this build.
The browser relay described below is for private-app setup/delivery, not login.

Session storage and restoration also use the original AuthClient/IdentityStorage
lifecycle and its 30-day delegation policy, not the former custom browser-session
record. Old test-build records are not silently converted or extended. A fresh
sign-in may therefore be required after that test build; this does not delete the
provider's passkey or the existing account. Device persistence and provider acceptance
must be tested separately from the source-level restoration tests.

The current local-test profile retains the original `oc.app` RP identifier, but uses
the distinct `dev.openchatfork.localtest` package and local signing certificate.
Restoring the original code does not itself establish that Google Password Manager
accepts this package/certificate for that RP. Google's documented association
requirements and a real provider test remain separate qualification checks; they
are not evidence that missing association caused a previously successful PR APK's
regression. The local-only association asset canister under
`tools/android-passkey-association` tests hosting/response behavior, not public
HTTPS reachability or Google provider authorization.

## Private apps

Open **Private apps** from the classic (v1) main menu or profile's apps section.
In the responsive v2 interface, use your profile's **App settings → Private apps**.
There is no floating launcher over the chat. These entries open the same private
workspace; they do not run inference or send app data.

1. Open **Private apps**. Apps from the operator-configured public directory appear
   automatically; no catalog or processor files need to be uploaded.
2. Choose **Connect** and continue to the app's page. Approve the exact requester
   origin and choose the app account and destination there. Only app setup returns
   to OpenChat; discovery and connection send no messages, drafts or credentials.
   Enable the connected app in the intended chat. New apps are never auto-enabled.
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

Per-chat app opt-in enables suggestions from app-owned declarative rules for fresh
messages only. It does not grant the app access to chat history. Models do not run
merely to display a suggestion.

The operator supplies `--app-directory <HTTPS-or-loopback-public-URL>` to the local
web startup, optimized web build or APK build command. The directory lists bounded,
same-publisher catalog/processor URLs, byte lengths, SHA-256 hashes and Connect URLs.
It must contain no private account configuration. Hashes verify exact artifacts,
not publisher honesty. The APK needs one update to add this directory capability;
subsequent compatible app additions/updates at that URL do not require rebuilding it.
Changing the publisher origin or client-supported protocol still requires review.

Opening Apps refreshes the public directory with no cookies or referrer. Verified
compatible updates are atomic; failures retain the last working setup. Changes to
private recipes or trust/destination require Reconnect. Updates wait while a draft
or processing operation is active. Publisher removal disables that app's proposals
and chat opt-ins while retaining its local setup for recovery. File imports remain
under advanced recovery controls, not the normal connection workflow.

The local-test APK uses a separate ten-minute setup bridge. A one-use random launch
fragment is immediately removed from the browser URL and authenticates the initial
local request; it never goes to the app publisher. The app's response is accepted
only from the expected popup/origin and nonce, then revalidated against the public
package before installation. Neither HTTP GET nor the app receives an OpenChat
session, chat history or draft. Closing/reloading an unfinished bridge requires a
fresh Connect; it does not automatically retry.

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

Connected or explicitly imported app catalogs, the selected app/action, verified processors and
enabled chats are remembered on the same device for the same signed-in account
and configured backend. This includes private app-owned setup/context, such as
user-defined labels. A separate IndexedDB store is used; nothing is synchronized
to OpenChat or an app. This is not chat encryption or a promise of encryption at
rest. Browser profiles/origins and the APK installation have separate storage.

Restore revalidates catalog declarations and processor hashes without executing
app code, running a model or contacting an app. Chat opt-ins bind to the exact
catalog, not only its reusable app ID. Explicit replacement clears the affected
opt-ins; directory updates preserve unaffected apps and approved compatible setup.
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
Directory-managed compatible processor/catalog updates are checked automatically
when Apps opens; private setup that needs regeneration asks for Reconnect. Manually
imported recovery setups remain explicit and are not silently reassigned a publisher.

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

### September 30 native-restore checkpoint

The original OpenChat onboarding and native Credential Manager flow are restored
in both layouts. The separate browser-login screen and browser-auth assets are no
longer selected by the local-test APK. App connection/delivery remains separate
from authentication. See [the native authentication boundary](LOCAL_TEST_APK_AUTH.md).

The restored source passes all 4,640 frontend tests in 319 files, both typechecks,
and non-mutating frontend lint (zero errors; existing warnings remain). The complete
suite caught a mobile authentication error-translation regression that the focused
checks had missed. Its fix restores the existing error-key mapper without changing
the original sign-in, account-linking or credential-provider flow.

APK015's independently verified x86 and ARM artifacts contain the restored native
flow but predate that final translation fix. The x86 artifact was installed over
the existing separate test package and launched without a reported native fatal
error. This is startup evidence, not proof of successful account restoration,
remembered-session behavior or Google Password Manager compatibility. Physical
phone testing remains deferred; no official app data was replaced.

Earlier browser acceptance demonstrated retained-cache Qwen/Gemma switching and
real private-app delivery with exact-once replay after a lost save acknowledgement.
Those results belong to that earlier browser artifact, not APK015 or newer source.
Automatic image direction and Type matching are still not fully qualified: IOU's
pinned extraction contract omits some image fields and supplies a default direction.
Manually corrected delivery does not establish automatic extraction accuracy.

New upstream commits fetched after the reviewed `5f0075831` baseline have not yet
been integrated at this checkpoint. Hosted scoped-security results, actual native
account restore/reopen and current-artifact app delivery remain separate gates;
none is waived by a passing build or unit suite.

### September 30 upstream integration checkpoint

The later integration advances the fork to official upstream
`c0ac3178f70f5e9de2f6ee532ce1415ab32a47cd`. All backend source matches that
upstream tree; this integration deploys no canisters or backend changes. The
original native account-linking, passkey creation and sign-in operations remain
unchanged from the restored-flow checkpoint. The user confirms that the older
PR APK restored with a fresh linking code and saved a new Google Password Manager
passkey. That was not merely a cached login; the new package's provider behavior
still needs direct testing, and missing public association is not a diagnosed
cause of its prior failures.

Upstream's startup preloads and early worker are retained for production and
native builds. Local browser builds defer worker creation until the existing
bounded stale-service-worker preparation finishes. Both client and worker retain
their private-app policy checks before dispatch. Model prompts, cached-model
retention, optional audio and the all-WebGPU selection are unchanged.

With the merged lockfile's `svelte-i18n` 3.7.4 installed, the complete frontend
suite passes 4,792 tests in 328 files under Node 24.18.1. Both typechecks and
non-mutating lint pass with zero errors (576 Svelte warnings and 31 lint warnings
remain). Focused startup, worker, formatting and scoped source-review checks also
pass. These are source-level results, not acceptance of a new web/APK artifact,
Google Password Manager sign-in, automatic image accuracy or actual app delivery.
Keep APK015's older evidence separate from the forthcoming rebuilt artifacts.

The first actual Windows web build of that merge stopped before producing a
usable bundle: upstream's new startup preload lookup assumed slash-separated
module IDs, but JSON plugin IDs used Windows separators. The original unit
fixtures were POSIX-only. Windows-only and mixed-separator fixtures reproduce
the failure before the fix. Startup lookup now normalizes both app and locale
module IDs; the ordinary layout selection, CSP and worker-ordering behavior are
unchanged. A rebuilt artifact must pass separately; the failed build is retained
and was never served to the user.

The corrected source passes 4,794 frontend tests in 328 files. An in-memory build
using the installed Rollup and JSON plugin confirms that the real English module
ID has Windows separators, fails the former lookup, and matches after normalization.

### September 30 current web and APK016 acceptance checkpoint

The rebuilt artifacts use committed main
`07aa47ba01fa896a607193d3ea36bf4487dc2222`, including the Windows startup repair.
They do not inherit APK015 or earlier browser acceptance results. Evidence below
is retained locally under `F:/Temp/OpenChat-IOU`; the receipts are not repository
fixtures or a public release.

The optimized web output is `merged-web-20260930-fixed`, version
`2.0.0-localtest.edd1680a1ef59661cf0fb840b855ac92`. Independent verification passes
for official backend/canister configuration, localhost RP, automatic local app
directory, disabled OTA, exact inline-script CSP hashes and deferred browser worker
startup. Both worker source maps match current source; pinned WebGPU assets and
seven OCR assets verify, with no model weight download or new bundled weights.
The 1,732-file inventory aggregate SHA256 is
`da253f7140371fbe3388f6ac9e4db386b86b9f514ffe35ae533e60e20e425f28`.
Receipt: `fork-main-closeout-20260930/merged-web-independent-verification.json`,
SHA256 `fa9740013fd77e28f8c83dbcd1c00d98aaf8660ae60712b128e95b19576fbf42`.
Its noted `existingAccountOnly: true` manifest field is stale metadata, not an
enforced restriction; the original authentication UI/behavior is restored.

Both APK016 ABIs passed independent source, package, signer, RP and embedded-asset
verification from the same immutable source/frontend snapshot. Files and receipts
are in `auth-native-restore-016/artifacts`:

- `openchat-fork-local-test-x86_64.apk`: SHA256
  `ba9c6bf9c746f2b5257118e8080f597dd492d56db860dd050191cf3d14999787`.
  Receipt `independent-x86_64-verification.json`: SHA256
  `3f92776037e6f04cc400e103e66891504486e8868e74d36b6c0a8a94c63baf10`.
- `openchat-fork-local-test-aarch64.apk`: SHA256
  `a21b9fd8d0d7b7a22d8b4ee5b2777e2a5b8778927e55adc3a4830057f07081b5`.
  Receipt `independent-aarch64-verification.json`: SHA256
  `bbfde3bac139aba5886e26cd5bd2b3fd54f0d6590ea2d01e151acc96a16cd145`.

The current browser reloaded the existing account/chat, restored private-app setup,
showed the automatic IOU directory and completed a synthetic local text request.
A fresh-tab image proposal read the synthetic fixture's amount (`123.45 USD`) and
date (`2026-09-27`) correctly, but supplied `credit` despite the printed "You owe"
and used its heading rather than its description. The app's pinned four/five-field
image profiles do not request those omitted values; IOU supplies the missing image
direction default. That is an app-owned extraction-contract failure, not a passing
image result. The incorrect draft was left unsaved. An IOU-only extended private
profile is a separate candidate requiring real inference qualification; legacy
phone-tested prompt bytes are not relabelled. The x86 APK installed over the separate test package,
cold-launched and remained alive with an empty crash buffer on follow-up. That is
startup evidence only: native account restore/reopen, Google Password Manager and
native model/app delivery remain unverified. The ARM APK has not been installed or
runtime-tested on a physical phone; phone testing remains deferred. The runtime
record is `fork-main-closeout-20260930/current-runtime-checkpoint.json`.

The [hosted frontend run](https://github.com/ktimam/open-chat/actions/runs/36769207255)
passed. The separate
[scoped-security run](https://github.com/ktimam/open-chat/actions/runs/36769207174)
passed model contracts, Windows/Ubuntu native hermetic tests and real small-model
inference, but did not pass overall. Its Android tool resolver failed fetching
before compilation; an Android-only rerun failed at the same stage without
re-executing the dependency audit. The underlying transport cause was not logged.
Bounded artifact/elapsed/cause-code diagnostics now preserve JSON stdout and all
existing download integrity checks so a later run can identify the failure. Scoped npm
reported 11 findings across `adm-zip` 0.6.0, `brace-expansion` 1.1.18 and `devalue`
5.8.1 (six high, five moderate). Hosted Rust metadata/license/advisory steps then
did not run; the missing Rust artifact is a secondary failure, not a successful
collection. No advisory waiver or dependency update is implied by these receipts.

The remaining gates are current image extraction and reviewed app-save acceptance,
native restore/reopen/provider and app-flow acceptance, and the unresolved scoped
security/tool checks. This checkpoint is not release-ready. Public branding/domain
and publication remain deferred; it requires no OpenChat backend deployment.
