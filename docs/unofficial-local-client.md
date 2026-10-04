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

## Connect apps and review local cards

Open **Apps**, then **AI Apps** in the normal Explore interface. In the responsive
v2 interface, the entry is **App settings → Apps**. The profile's connected-apps
view uses the same app cards and offers **Discover apps**. There is no separate
Private apps management page or floating launcher over the chat. Opening the list
does not run inference or send chat data.

1. Open **Apps → AI Apps**. Apps from the operator-configured public directory appear
   automatically; no catalog or processor files need to be uploaded.
2. Open an app's card, choose **Connect** in its details, and continue to the app's page.
   Approve the exact requester origin and choose the app account and destination there.
   Only app setup returns
   to OpenChat; discovery and connection send no messages, drafts or credentials.
   Enable the connected app in the intended chat. New apps are never auto-enabled.
3. Select an available local model, or a supported local-reader mode, and use
   **Propose** on one text or image message. Both UIs share this pipeline; app
   proposals do not currently accept voice messages.
   App prompts, labels, rules, extraction and normalization remain app-owned.
4. Edit the local card using its app-labelled fields. This panel contains card review,
   not app setup; **Advanced: complete payload (JSON)** remains available
   for structured fields and repairs. Nothing is posted to the chat or sent to the
   app for card verification. Every edit invalidates the previous approval.
5. Confirm the full request, including its destination and recipient review label.
   OpenChat encrypts the fields before handing them to a separate browser relay.
   The relay displays only routing/key metadata and asks before opening the receiving
   app; it cannot read the fields. In the local-test APK, first pair that relay below.
6. Sign in to the app, decrypt for the linked destination, review the full fields and
   actual account/destination again, then explicitly save there.
   **Received** is not **saved**; the latter means the app reports that it saved.

Per-chat app opt-in enables suggestions from app-owned declarative rules for fresh
messages only. It does not grant the app access to chat history. Models do not run
merely to display a suggestion.

The operator supplies `--app-directory <HTTPS-or-loopback-public-URL>` to the local
web startup, optimized web build or APK build command. The directory lists bounded,
same-publisher catalog/processor URLs, byte lengths, SHA-256 hashes and Connect URLs.
It must contain no private account configuration. Hashes verify exact artifacts,
not publisher honesty. Clients supporting this directory can discover compatible
app additions/updates at that URL without rebuilding the APK.
Changing the publisher origin or client-supported protocol still requires review.

Opening Apps refreshes the public directory with no cookies or referrer. A busy
processing operation defers the refresh. With saved cards retained, the list can
refresh, but automatic recipe changes wait; each card keeps its frozen configuration.
Explicit Connect can still establish or change a connection without deleting cards.
Verified compatible updates are atomic; failures retain the last working setup.
Private recipe or trust/destination changes require an explicit connection. When
updates can be applied, publisher removal disables that app's proposals and chat
opt-ins while retaining its setup for recovery. Manual file-import controls are not
part of the normal Apps interface.

**Saved cards (N)** in Apps opens the card-only panel, including cards whose app is
disconnected. It restores neither sending consent nor a handoff. **Disconnect** in
app details removes that app's connection and chat opt-ins but retains its cards.
Those cards stay inspect-only until a matching connection is restored and reviewed;
a changed connection cannot silently retarget their fields or destination.

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

The code expires after two minutes and can claim the encrypted approved draft only once.
After a successful claim, the browser has up to ten minutes to complete delivery.
Check the destination and recipient-key metadata before opening the receiving app.
The relay cannot display or decrypt the fields; they were encrypted inside OpenChat.
The receiving app asks you to allow the one-time connection before it receives the
encrypted payload. After signing in and decrypting locally, review every field and
its actual account and destination, then save there.
**Received** does not mean that anything has been saved.

Discarding the draft or changing account cancels the pending native handoff. Data
already handed to the receiving app cannot be recalled. If the outcome is uncertain,
check the app before choosing the explicitly confirmed retry with the same import
ID. There is no automatic retry or automatic browser/clipboard action.
**Close** only hides the card panel; use **Cancel / discard local draft** to cancel
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

### Remembered setup and locally saved private cards

Connected app catalogs, the selected app/action, verified processors and
enabled chats are remembered on the same device for the same signed-in account
and configured backend. This includes private app-owned setup/context, such as
user-defined labels. A separate IndexedDB store is used; nothing is synchronized
to OpenChat or an app. This is not chat encryption or a promise of encryption at
rest. Browser profiles/origins and the APK installation have separate storage.

Restore revalidates catalog declarations and processor hashes without executing
app code, running a model or contacting an app. Chat opt-ins bind to the exact
catalog, not only its reusable app ID. Explicit replacement clears the affected
opt-ins; directory updates preserve unaffected apps and approved compatible setup.
Connection controls wait for restoration; a failed read/write is shown rather than
reported as saved. Invalid or future-version records are not silently accepted.

Up to eight private cards are saved encrypted on this device, separately from setup,
scoped to their OpenChat account/backend. Closing the panel does not delete them.
**Discard local draft** removes only the selected card. Disconnecting its app does
not discard it; use **Saved cards (N)** to inspect retained cards. The former setup
import and account-wide Forget buttons are not present in the normal Apps flow.
Source images/chat history and approval/transport tokens are not persisted.
Restoration requires fresh review and never sends automatically. Attempted deliveries
retain their original fields, destination and import ID for explicit retry.
Storage failures must be shown, and delivery stops if its attempted state cannot be saved.
Downloaded model caches remain separate. See [encrypted delivery and storage](private-app-encrypted-delivery.md)
for the complete workflow and device-local key threat boundary.

### App-defined choices in the private draft

An imported app can declare named choices and their scalar companion fields/defaults.
The private editor shows the app's labels alongside the exact outgoing values. Choosing
an option updates its declared companion fields atomically; those fields are read-only
outside Advanced JSON. Clearing a choice removes its companions and restores the
original defaulted values, unless the user has explicitly edited those values.

Choice history remains in the current draft session through closing/reopening the
panel and changing the recipient. It is not saved with app setup/card or sent to the app.
After reload or logout/return, restored card values are treated as manually supplied:
choices still update their companion fields, but do not reapply defaults or reconstruct
the previous baseline on clearing. Edit those values explicitly after restoration.
Advanced JSON is authoritative: editing it clears that history, and later choices do
not reapply automatic defaults. Unknown choices or inconsistent companion values block
review. Every edit invalidates the previous approval; changing a choice does not run a
model or processor again or contact the receiving app.

Apps own the declarations and meanings. OpenChat implements only the bounded generic
editor contract; it does not interpret app-specific Types, dates or business rules.
The receiver sees only the final reviewed payload, not the sender's editing history.
Directory-managed compatible processor/catalog updates are checked when Apps opens,
subject to the saved-card and processing deferrals above. Private setup that needs
regeneration asks for an explicit connection. Previously imported setups are not
silently reassigned a publisher; this does not restore the removed file-import UI.

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
- The handoff binds exact origin, popup and fresh nonce; encrypted AAD binds destination,
  app/action/revision, request ID and the connected recipient context. IOU checks its
  current authenticated recipient before decryption. This is not sender attestation or
  protection from malicious app frontend code after authorized decryption.
- The relay holds only encrypted fields and severs its opener to the main client. The
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

### October 1 encrypted delivery and persistent cards

The [current encrypted-delivery workflow](private-app-encrypted-delivery.md) supersedes
the older plaintext and memory-only draft descriptions. The active card is encrypted
in device-local storage; restart/logout do not discard it or restore approval.
App setup must include a recipient public key, obtained through Connect. The relay
receives ciphertext only, and the receiving app decrypts for a second review before
its existing encrypted save.

Both web layouts and APK018 ABIs were rebuilt from main `6249be2431` plus the reviewed
uncommitted changes. The local preview serves the verified v2 bundle. Actual desktop
Edge testing passed card recovery, authenticated encrypted delivery and saved-entry
readback. An explicit same-ID retry after reload was deduplicated by IOU; a fresh
sheet reload still contained only one matching synthetic entry. V1 restored the same
locked card and required new consent. The source-test and native artifact boundaries
are detailed in the workflow document; this does not qualify phone inference or
native authentication/handoff.

Local artifacts and receipts remain under `F:/Temp/OpenChat-IOU`:

- Web: `encrypted-handoff-20261001`, with separate v1/v2 independent receipts and
  `live-browser-acceptance.json` recording the actual browser checks and their limits.
- APK018 x86: `auth-native-restore-018/artifacts/openchat-fork-local-test-x86_64.apk`,
  SHA256 `8f13f5310f9445a2a6087463160e26bd94c5545cc573bab603946830c400db86`.
- APK018 ARM: `auth-native-restore-018/artifacts/openchat-fork-local-test-aarch64.apk`,
  SHA256 `1d36bd5bbcad87d3afc9a77f439055bda8ec347b53f9eddb5929e6202b8d4553`.

The APKs keep the separate test package and signer. Independent verification checks
the frozen source, native binaries and embedded non-map assets; it explicitly leaves
CI and release acceptance false. Documentation and a test-mock-only repair made after
the freeze are not compiled into these artifacts. No model weights/prompts, official
backend or account credentials changed. The unresolved security/tool, image-accuracy
and native runtime gates above remain open; public publication is still deferred.

The x86 APK018 was installed over the existing emulator test package with `install -r`.
The installed bytes match the verified APK; UID and original installation time were
preserved. Cold startup succeeded, the process stayed alive on follow-up, and its
crash buffer was empty. This verifies update/startup only, not visible account restore,
provider sign-in, card recovery or encrypted handoff. No phone install was performed.

### October 1 APK019 artifact checkpoint

At this checkpoint, APK019 superseded APK018 as the build candidate. Both
architectures included the encrypted local-card and recipient-delivery implementation,
the corrected optional-audio download routing and the approved installer lock update. The
catalog, model weights, default prompts and completion guard remain unchanged.
The build did not install dependencies; its existing installed adm-zip remains
0.6.0 while the frozen lock selects 0.6.1. The installer fix was tested separately.

- x86: `auth-native-restore-019/artifacts/openchat-fork-local-test-x86_64.apk`,
  SHA256 `7391571912ec8573198dc222d3535c6a14d754fac1633a985544f53fde356a33`.
- ARM: `auth-native-restore-019/artifacts/openchat-fork-local-test-aarch64.apk`,
  SHA256 `73bdc0a1ac64505650eee9342cab1d663af45414d91e71736d8d2f6be06dc278`.

Independent verification passed for both frozen builds, their embedded assets,
eight exact feature-source emissions, native libraries, unchanged package/signer
and original authentication code. Two earlier verifier-only source-map failures
remain recorded; their corrections did not change the APKs or waive checks.
Neither APK019 was installed or runtime-tested. Original authentication code and
an `oc.app` association declaration do not prove that this fork package is
authorized by the public association file. Native/provider acceptance, voice
accuracy, current-source hosted CI and release acceptance remain open.

### October 2 source and hosted checks

This checkpoint covers commit
`5a36a3c22bf53b4111824606ec51b23c8c3e80ee`, not the subsequent uncommitted
card, schema or CI changes. The committed frontend passed 5,423 local tests with
no failures or pending tests; Svelte checking reported zero errors and 572
warnings. The [hosted frontend run](https://github.com/ktimam/open-chat/actions/runs/36937390340)
also completed its production build successfully.

The [separate scoped-security run](https://github.com/ktimam/open-chat/actions/runs/36937390360)
passed the model contracts, Linux and Windows native hermetic checks, and the
real small-model inference fixture. Its dependency job passed 32 hash contracts,
format checking of 477 selected files, 774 offline scoped contracts and the
exact CI wiring check. The npm advisory gate still failed on seven `devalue`
5.8.1 findings. Their [explicit local-test deferral](releases/npm-feature-advisory-triage.md#october-2-local-test-deferral)
preserves that failure; it is not a clean scan, dependency fix or public-release
approval. Under that workflow's original success gating, the later Rust metadata,
license and advisory steps did not run. The missing Rust report was a secondary
failure, not evidence that those checks passed.

Android passed its 57 preliminary tool and wiring tests but failed downloading
the pinned Kotlin 2.2.0 compiler before compilation. The unchanged Android-only
rerun failed at the same download stage. The two attempts reported 68 ms and
85 ms respectively, `deadlineExceeded: false`, and `TypeError`/`Error` cause
names without a more specific transport cause. These are download failures,
not demonstrated compiler or application regressions. The rerun did not
re-execute the successful native/model jobs or the dependency advisory gate.

This checkpoint does not qualify later working-tree changes, a new APK, native
sign-in, phone inference or public release. The earlier APK019 artifact and
runtime-acceptance limits remain in force.

### October 2 multi-card web and APK020 checkpoint

Both optimized web layouts and both APK020 architectures were built from commit
`94cb746197cd9ac0c05a0235a64a959ff259da0e`, with reviewed feature fingerprint
`8cc7a0ec5387cc68d875eb71e10f54e60efdf07c4ac020cbf9e23650954554a9`.
Independent artifact checks passed. They bind the compact app-defined card UI,
encrypted eight-card collection, source references and frozen app definitions to
the packaged bytes. Official service configuration, disabled OTA, original native
authentication code and unchanged pinned model assets were verified. No OpenChat
backend deployment was performed. At that checkpoint, APK020 superseded APK019 as
the local-test artifact candidate, not as a runtime-qualified release.

The web receipts are
`card-collection-release-20261002/web-v1-independent-verification.json` and
`card-collection-release-20261002/web-v2-independent-verification.json` under the
project temporary directory. APK files and receipts are under
`card-first-apk-020/artifacts`:

- `openchat-fork-local-test-x86_64.apk`: 72,334,219 bytes, SHA256
  `dc919cf9ae5e021c2dc124d6c57fc541196695871c83d2075d12bf67d2e3c07c`;
  final receipt `independent-x86_64-verification-v2.json`.
- `openchat-fork-local-test-aarch64.apk`: 79,609,609 bytes, SHA256
  `9e28a3767268a136e3cf67b57b2f5d1a54ebbb421c616c8c50b9ac44c01bcee3`;
  receipt `independent-aarch64-verification.json`.

A fresh read-only emulator check matched the installed
`dev.openchatfork.localtest` APK exactly to the verified x86 artifact. Device
package metadata reported `firstInstallTime: 2026-09-30 18:30:29` and
`lastUpdateTime: 2026-10-02 03:25:57`; these times are quoted without timezone
reinterpretation. Receipt `emulator-installed-identity-20261002.json`, SHA256
`0cbc3af090667f0482e7733b97e9ec34c7b2eeb357c2562035055920deb8afc1`,
records file identity and selected package metadata only. It did not launch the
app or verify account restoration, provider behavior, card storage or delivery.

The [hosted frontend run for this commit](https://github.com/ktimam/open-chat/actions/runs/36942932312)
succeeded. The [scoped-security run](https://github.com/ktimam/open-chat/actions/runs/36942932279)
failed and is not accepted. Unlike the earlier workflow, its Rust checks ran
after the npm failure. The Rust preflight rejected the installed Linux Cargo
binary because its 42,185,192 bytes exceeded the collector's 32 MiB input-file
limit; this failure was not an advisory finding.

A subsequent CI-only correction gives Cargo and rustc binaries a separate 64 MiB
cap while retaining the 32 MiB source-file and 128 MiB aggregate-input limits,
path checks, proxy rejection and exact hash bindings. It passed 277 scoped
offline tests and 373 scoped CI-guard tests with no failures or skips; workflow wiring
and targeted formatting also passed. Read-only preparation with the actual installed
Linux Cargo and rustc passed all eight configured profiles, recorded in
`card-collection-release-20261002/ci-repair/canonical-linux-binary-preflight.json`.
That preparation did not execute either tool, collect metadata or query
advisories. The correction was committed as
`49450039825edaa2bade427e2525696a7c5d9d22`. Its
[hosted frontend run](https://github.com/ktimam/open-chat/actions/runs/36947883175)
passed. The [scoped-security run](https://github.com/ktimam/open-chat/actions/runs/36947883187)
also passed model contracts, Linux/Windows native checks and actual small-model
inference. All eight Rust collection profiles now completed with verified source
bindings and SBOM schemas; the report's ten advisory records match the documented
local-test deferrals. The raw security gate remains failed: the seven npm findings
and deferred Rust findings are not waived or described as a clean scan. Android
again failed fetching the pinned compiler before compilation, not in application
code. No runtime/source-navigation acceptance follows from this CI-only commit.

Current-artifact runtime checks remain open: familiar compact-card editing and
responsive layout, multi-card recovery and source association, reviewed encrypted
delivery, native account/provider restoration and repeated inference. Neither
static artifacts nor installed-file identity prove visual or interaction parity
with the earlier app cards. The RP/association declaration does not prove public
authorization of this fork package. Physical-phone testing remains deferred;
public-release and general voice-accuracy acceptance are not claimed.

### October 2 main Apps web and APK022 checkpoint

The restored main Apps flow is built from commit
`7a95466f1dd34220b4e8fe78f0210f2a53810d46` plus the explicitly reviewed working-tree
overlay and deletions, not from a new clean commit. The shared feature fingerprint is
`83d70d96f0b74618f59ef52327f2d3bf104a2895231e686f9557cb9e068a5b14`.
The source includes upstream through `944efe4a7270d42f62dc3bfa5bad853b237d4b69`;
newer upstream commits have not been integrated into this checkpoint.

The separate management page is removed. Both interfaces reuse the normal AI Apps
cards and app details for Connect; the local card panel retains editing, source
navigation, encryption and explicit delivery review. App-specific definitions stay
app-owned. No OpenChat canister change or deployment, model prompt/weight change,
authentication bridge or OTA update is introduced by this flow.

Independent verification passed for the optimized v2 web build and both APK022
architectures against the same frozen source inventory. The web build is
`2.0.0-localtest.97e550caa950a73371bc695846e50cf0`; its final receipt is
`main-ui-web-20261002/web-v2-independent-verification-v4.json` under the project
temporary directory. The APK receipts are under `main-ui-apk-022/artifacts`.
These checks bind source, official service configuration, original authentication,
disabled OTA, package/signing identity and packaged assets. This checkpoint does
not rebuild v1 web or inherit its earlier runtime acceptance. The local-test APK
permits cleartext only to its localhost/127.0.0.1 development endpoints; remote
cleartext remains blocked and the production policy is unchanged.

The emulator's installed x86 APK matches SHA256
`9b2ab2ffc968b80092219b8d9ae7ee3694862cba8f7e9ba5e02dca9f1014f45d`.
A normal UI test followed App settings → Apps → AI Apps, observed the automatically
listed IOU card and its original details/Connect control, and confirmed the removed
management UI was absent. Pressing Connect left OpenChat, but the observed foreground
was the Launcher, not a browser. This is not successful setup handoff or connection
completion. The bounded UI receipt is
`emulator-public-ui-20261002/runner-v10/observations/apk022-main-apps-r1/result.json`.

The web preview serves the verified version and returns HTTP 200 for normal
communities navigation; current normal-browser runtime acceptance is still pending.
APK connection completion, familiar card editing/layout, recovery/source navigation,
encrypted app review/save/retry, provider restoration and model inference remain
separate current-artifact checks. ARM has static verification only; physical-phone
testing remains deferred. Neither this UI check nor the packaging proofs waive the
recorded CI/advisory gates or establish public-release readiness.

A subsequent persistent observer resolved the Launcher ambiguity: before the
instrumentation ended, the same APK022 opened the known Chrome package, displayed
the native **Connect an app** page and its enabled **Continue to app** control,
then reached **Connect IOU setup** after a normal tap. Receipt
`emulator-public-ui-20261002/runner-v11/observations/apk022-native-setup-r1/result.json`
records this narrower successful native-opening sequence. IOU was signed out and
displayed **Sign in to IOU**, so the observer stopped without credential actions.
The native opening is verified; setup sharing, proposals, encrypted delivery and
saved-entry readback remain unverified on this APK. No account or data was reset.

### October 2 upstream integrated web and APK023 checkpoint

This checkpoint uses committed fork `main`
`064eda188571f9cfc962b98d48842d83c51bdbd2`, including upstream
`5ca61b627809807b5c29300a46d539567249f1cd`, with feature fingerprint
`7e72d8ee0dbb5bd42a8ee8546f4c21a6f992a8c10c4f83a7d5959198144774cd`.
The builds use committed source with no working-tree overlays. Three pre-existing
working-file changes were excluded, not packaged. No OpenChat canister was changed
or deployed for this client flow.

| Check | Completed evidence | Limit |
| --- | --- | --- |
| Merged source | 5,654/5,654 frontend tests; both typechecks reported zero errors; post-commit backend baseline and scoped format/wiring checks passed | Source checks do not establish runtime acceptance |
| Optimized web v1 and v2 | Both layouts built sequentially and passed independent source/configuration/asset verification | Browser runtime is recorded separately below |
| APK023 x86 and ARM | Both ABIs built and passed independent source, packaged-asset, native-binary, signer and network-policy checks | ARM has no new device-runtime result |
| APK023 emulator | Existing account was remembered; normal Apps → AI Apps listed IOU; original app details and Connect were visible; the removed management page was absent | This check did not press Connect or test provider sign-in, proposals, models or saves |
| Current Edge connection | Normal Apps → IOU → Reconnect, authenticated IOU account/sheet selection and Connect/share setup completed; OpenChat reported Connected and retained the existing saved card | Connection is not a proposal, delivery or saved-entry acceptance result |

The browser connection initially failed because IOU's public catalog was internally
hash-consistent but stale relative to its current private setup producer. The pinned
card declaration and final currency schema differed. OpenChat correctly rejected
that mismatch. Regenerating IOU's public catalog/directory repaired the connection
without changing OpenChat, relaxing validation, rebuilding the client or changing
model prompts/processor bytes. The repair passed 86 targeted IOU tests and 100
cross-checkout integration tests. The added integration case binds an actual generated
P256 recipient setup to the shipped public catalog and revalidates its persisted
provenance; altered pinned fields still fail.
The IOU repair is committed as `a46fcce`. Its hosted CI run
[37033647731](https://github.com/ktimam/IOU/actions/runs/37033647731) failed at
`audit:deps`, before hosted typecheck, tests or build; those later steps were skipped,
not failed tests. The 186 local tests and both local typechecks passed independently.
This checkpoint does not classify every advisory as previously deferred or introduce
a dependency waiver.

Developer-machine evidence is retained under `F:/Temp/OpenChat-IOU`, not supplied as
portable repository fixtures:

- [Web v1 proof](F:/Temp/OpenChat-IOU/upstream-5ca-web-20261002/web-v1-independent-verification.json)
  and [web v2 proof](F:/Temp/OpenChat-IOU/upstream-5ca-web-20261002/web-v2-independent-verification.json).
- [APK023 x86 proof](F:/Temp/OpenChat-IOU/upstream-main-apk-023/artifacts/independent-x86_64-verification.json)
  and [ARM proof](F:/Temp/OpenChat-IOU/upstream-main-apk-023/artifacts/independent-aarch64-verification.json).
- [Emulator main Apps result](F:/Temp/OpenChat-IOU/emulator-public-ui-20261002/runner-v13/observations/apk023-main-apps-ready-r5/result.json).
- [Catalog-binding first-red observation](F:/Temp/OpenChat-IOU/iou-connect-catalog-20261002/first-red-observation.json)
  and [100-test passing log](F:/Temp/OpenChat-IOU/iou-connect-catalog-20261002/green-run.log).
- [Current browser reconnect observation](F:/Temp/OpenChat-IOU/iou-connect-catalog-20261002/browser-reconnect-observation.json)
  records visible UI observations, not a captured network trace.

Current-artifact card editing/recovery/source navigation, encrypted delivery followed
by IOU review/save/readback and same-ID retry, and model inference remain separate
runtime checks. Earlier passes are not relabelled as passes for these artifacts.
The raw hosted scoped-security gate remains failed despite documented local-test
advisory deferrals; those decisions do not produce a clean scan. Hosted Android also
failed fetching its pinned Kotlin compiler before compilation, not compiling the
application. Local APK build success does not erase that failure. Physical-phone
testing remains explicitly deferred, rather than an outstanding local-test gate.
Public branding, domain/provider qualification and publication remain deferred;
this checkpoint does not claim public-release readiness.

The retained legacy card also exposed a recovery-feedback defect: changed app setup
correctly blocked its old request, but the review button appeared usable and gave no
explanation. Separately, chat opt-in was incorrectly blocked while cards were retained.
Five new regressions reproduced these cases. Narrow source fixes now pass 65 focused
tests, preserving strict matching, the frozen request and import ID; their rebuilt
artifact and runtime acceptance remain pending. No recovered request was sent or
discarded to work around either defect.
Final source verification passed 5,662/5,662 frontend tests and both typechecks with
zero errors (572 existing Svelte warnings); this is not an APK024 or rebuilt-web
runtime acceptance result.

### October 2 saved-card fixes, current web and APK024 checkpoint

The rebuilt artifacts use committed source
`d9b6d3e48a6a42d3dc411f41e892de2a9728341b` and feature fingerprint
`86b7835254837140bd452b4a0f722cbfd207d1ad15d5f6c7b9b66757e0e11dbc`, with no
working-tree overlays and the same three unrelated working edits excluded. All four
artifacts passed independent source/configuration/asset verification:
[web v1](F:/Temp/OpenChat-IOU/private-card-ui-web-024/web-v1-independent-verification.json),
[web v2](F:/Temp/OpenChat-IOU/private-card-ui-web-024/web-v2-independent-verification.json),
[APK024 x86](F:/Temp/OpenChat-IOU/private-card-ui-apk-024/artifacts/independent-x86_64-verification.json)
and [APK024 ARM](F:/Temp/OpenChat-IOU/private-card-ui-apk-024/artifacts/independent-aarch64-verification.json).
Original authentication, official OpenChat services, disabled OTA and the existing
local-test package/signing and loopback-only network policy remain unchanged. No
model, prompt or backend change is introduced by these fixes.

The [browser UI observations](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-ui-observations.json)
confirm retained sign-in, IOU connection and saved cards; normal main Apps navigation;
chat opt-in with an old card, retained after reload; and visible, disabled review for
a card whose original setup no longer matches. Both web bundles were exercised at
the observed 1454-pixel desktop width and mounted **v1**. Building and testing the
v2-enabled bundle does not establish actual mobile-v2 runtime acceptance.

The [delivery observations](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-delivery-observations.json)
record a new two-entry synthetic proposal while preserving the old card, edited
dates/notes retained after reload, and source navigation back to the original chat.
The reviewed encrypted-delivery flow required explicit sender confirmation and
IOU's separate review before saving. Fresh sheet readback matched both entries,
including the existing Type's 10% fee. Replaying the exact same payload/import ID
required fresh review, reported the earlier save as already accepted, and left one
row per unique test note. These are visible UI/readback observations, not a wire
capture or model-inference result.

The earlier [model-settings observations](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-model-settings-observations.json)
retain the background-cancelled Qwen activation attempt, during which Gemma stayed
selected. A subsequent normal-UI [cached-model roundtrip](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-cache-roundtrip-observation.json)
passed: Qwen became Current with all three stages showing WebGPU/q4 while Gemma
remained Downloaded; switching back restored Gemma Current with WebGPU/q4f16,
Qwen Downloaded and the optional voice add-on retained. Normal reload preserved
Gemma Current, Model only, the 96-token limit and optional voice. No weights were
deleted. This is successful UI switching and retained settings, not a network trace,
fresh byte-level cache audit or inference-after-switch acceptance.

The subsequent [normal post-switch `/ai` observation](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-post-switch-inference-observation.json)
completed inference but failed instruction-following. The request
`Reply with exactly APK024 SWITCH OK.` produced
`Amount: 123.45 USD | Direction: You owe | TEST ONLY — OpenChat IOU acceptance`
instead. Source review found no instruction truncation, message-order defect or
stale-completion reuse. A cache-only [11-run context investigation](F:/Temp/OpenChat-IOU/text-context-024/observations.json)
reproduced the wrong-task behavior by placing the visible older multiline extraction
request in the current wrapper. The same new request succeeds without history.
JSON quoting alone and moving the current request first did not fix that case.
Explicit current-task framing with JSON-quoted history returned the intended words
on both models; both also answered a question requiring the historical amount.
Gemma returned the intended words with a reconstructed 24-message history. Qwen's
24-message case returned a worker error with cleanup acknowledged. An
[error-visible replay](F:/Temp/OpenChat-IOU/text-context-024-errors/qwen-long-context-observation.json)
confirmed the existing context guard: the request needed 1,025 positions against
Qwen's 1,024-position limit, including the catalog-clamped 96-token output allowance.
This is a bounded rejection before generation, not a GPU crash or a successful
long-context answer. History remains character-bounded rather than tokenizer-aware;
the fix does not silently trim more history or reduce the requested output allowance.
Most intended-word answers omitted the final period, so these are semantic
task-following observations, not byte-exact response passes. The reconstructed
history is not a capture of the production request, and framing is not a security
guarantee against arbitrary historical instructions.

The generic command builder now uses that tested framing, valid JSON within its
existing 8,000-character/newest-24 history bounds, and unchanged no-context input.
The actual builder reproduced all three executed candidate prompt strings exactly.
The regression-first run failed 13 assertions against the old builder; after the
fix, [151 tests in six focused suites pass](F:/Temp/OpenChat-IOU/text-context-024/local-ai-context-green.json).
Model weights, worker code, media prompt constants and app-owned image prompts are
unchanged. These source changes are not yet packaged into a replacement for 024;
normal-UI acceptance of the replacement remains pending. Cached-model switching
and reload remain valid observations, not evidence that the original 024 command
failure has been fixed in the running browser or installed APK.

Separate [four-case image observations](F:/Temp/OpenChat-IOU/image-worker-024/actual-image-observations.json)
record actual Qwen and Gemma WebGPU runs using the unchanged compiled 024 worker,
original IOU prompts and cached weights. Every run reverified the selected model's
complete base cache by SHA-256 and confirmed cleanup. The authoritative output record
has SHA-256 `2784c20f62a7106b7f98aa069c2c50b99a1497d8a94a651d3052f45df690d040`.
The [direct normalization check](F:/Temp/OpenChat-IOU/image-worker-024/normalization-observations.json)
fed those exact four outputs to the unchanged shipped IOU processor
`bbf1aa6b1d50431f7280d0ee64b343443869abd7baf20e4a0fb0d95a2df0acaa`
in an isolated VM without network access or private context. Only complete outer
JSON fences were removed; all four candidates were accepted without field rewriting.

| Fixture | Qwen and Gemma normalized result | Evidence limit |
| --- | --- | --- |
| Arabic transfer | 12,900 EGP; settlement; 2026-08-14; Arabic heading retained as the note | Gemma omitted the printed clock time; the app date field retains the calendar date |
| Reservation | 1,912.15 USD; IOU; 2026-07-19; note retains both Jul 19 and Aug 6 endpoints | No year is printed; IOU derives 2026 from the explicit reference date |

The reference timestamps were `2026-09-08T09:43:14.229Z` for the transfer and
`2026-07-03T12:00:00Z` for the reservation. Gemma's unchanged hyphen-separated range
was accepted by IOU's existing parser; its existing dollar-symbol rule supplied USD.
Both results use the app's default `credit` direction without private Types. These
checks establish raw-worker results and app normalization for these fixtures, not
normal-app image proposals, native inference or private-Type matching. The temporary
diagnostic route is off and the normal preview was restored (observed PID 77136).

The [normal image-proposal observation](F:/Temp/OpenChat-IOU/private-card-ui-web-024/browser-image-proposal-observation.json)
then used the existing synthetic invoice in message 28 through the normal Propose
action. It produced a new local card with 123.45 USD and 2026-09-27 while retaining
both older cards. Gemma was selected in the preceding settings observation; this
check did not capture a fresh inference-configuration trace. The card retained the
invoice heading, but not its printed direction, description or footer keyword:
it displayed **Owed to you**, not the printed **You owe**, and selected no saved Type.
This matches the existing heading-only image contract and its explicit
`localProcessorArtifact.test.ts` limitation test, rather than demonstrating a new
024 regression. Missing direction defaults to `credit`; the omitted `TEST ONLY`
footer cannot match the private Type's keyword. The normal proposal flow completed,
but this is not full image-fidelity or private-Type matching acceptance. The new
card remains unsent; no IOU entry was saved by this check.

The [emulator installation receipt](F:/Temp/OpenChat-IOU/private-card-ui-apk-024/artifacts/emulator-install-receipt.json)
records successful in-place x86 replacement with app data and the original install
date preserved. After Chrome repeatedly stopped responding during the IOU connection,
one data-preserving cold restart of the same
AVD, using 4 GB memory, host GPU and no snapshots, restored the existing account and
chat without relinking or resetting data. Phase A subsequently reached IOU's final
**Review the setup you will share** page with the approved existing account and
sheet selected. The final Share action stopped at an explicit human approval
boundary. Native connection now awaits approval for the IOU-to-APK setup share;
the recovered ANRs are not the current blocker. Phase A is not yet accepted.
No native setup Share, send or save occurred, and phase B has not run. ARM remains
statically verified only. The current
commit's hosted [frontend checks](https://github.com/ktimam/open-chat/actions/runs/37037525607)
passed; its [scoped security workflow](https://github.com/ktimam/open-chat/actions/runs/37037525477)
failed. Its model contracts, small-fixture inference and both native hermetic jobs
passed. The current Rust report validates all eight collection profiles and the
435-component SBOM, but its advisory gate remains failed. All ten reported
package/version/advisory tuples match the [existing local-test deferrals](releases/rust-feature-advisory-triage.md#october-2-local-test-deferral);
none is newly uncovered. This is not a clean scan or release acceptance.

The current Android job's direct log confirms that attempt 1 failed acquiring the
pinned Kotlin 2.2.0 compiler from Maven Central before component compilation. It
reports `pinned-tool-download-failed` after 99 ms, with no deadline expiry; the deeper
transport cause remains unknown. The single Android-only rerun also failed before
compilation: attempt 2 passed its 57 preliminary tests, then reported the same
compiler-acquisition failure after 81 ms, again without a deadline expiry. Its deeper
transport cause is likewise unknown. Attempt 1 remains recorded; the other model,
native and Rust/npm results were carried forward, not rerun. No further retry was
requested.
The [hosted observation record](F:/Temp/OpenChat-IOU/private-card-ui-web-024/current-hosted-checks.json)
records these classifications and the successful scoped npm query and license check. Earlier raw scoped
security and IOU audit failures remain recorded: no advisory waiver, clean-scan claim or
core audit follows from these builds. This is local-test evidence, not public-release
readiness.

### October 3: packaged generic-context correction (025)

This checkpoint supersedes the 024 paragraph's statement that the generic `/ai`
correction is not yet packaged. Both web layouts and both local-test APK ABIs now
contain source `4be9f67c0b543dfd9ae996ec046abb0264426306`, with source-scope fingerprint
`69372966bb88cca0332f8d9750119d6efb627b419c195fa3267202d1c4641651`.
The backend, worker, weights, media prompts, IOU image prompts and app processor
remain unchanged. The two pending Android-download diagnostic edits and an
unrelated newline-only snapshot change were excluded and preserved.

Independent artifact checks bind both web bundles to 48 compiled source checks and
the APK frontend to 39 compiled source checks plus four Vite-worker bindings.
The APK build ID is `6feb450952fd147dda72ba8109b79494`; the separate package
`dev.openchatfork.localtest` and its existing signer remain unchanged.

| Artifact | Identity | Independent evidence |
| --- | --- | --- |
| Web v1 | `2.0.0-localtest.1081972ab19e8ba4c24632ef4bb985b5` | [v1 proof](F:/Temp/OpenChat-IOU/generic-context-web-025/web-v1-independent-verification.json) |
| Web v2 | `2.0.0-localtest.525a5ef6fdbf163b9a1cc3cc1218a6f9` | [v2 proof](F:/Temp/OpenChat-IOU/generic-context-web-025/web-v2-independent-verification.json) |
| x86 emulator APK | SHA-256 `6f3124fcb638a630acfebb7db84825cbf6cdd0208ea701801511c014d3fc6de9` | [x86 proof](F:/Temp/OpenChat-IOU/generic-context-apk-025/artifacts/independent-x86_64-verification.json) |
| ARM local-test APK | SHA-256 `6942b2295be73c7cee8ff9279ade40b870b941a7213b482c696e7f9b4498d042` | [ARM proof](F:/Temp/OpenChat-IOU/generic-context-apk-025/artifacts/independent-aarch64-verification.json) |

The [normal browser observations](F:/Temp/OpenChat-IOU/generic-context-web-025/browser-ui-observations.json)
record a fresh v2 reload, the existing signed-in account/chat, connected IOU in the
normal Apps screen, three restored private cards requiring fresh review, and
retained model downloads/settings. The normal composer then ran Gemma, switched
to the cached 1.7 GB Qwen model, and switched back to Gemma without restarting.
All three replies addressed the current request instead of performing the older
quoted extraction task. The first Gemma reply was exact; Qwen and the switch-back
reply omitted the final period. These close the observed wrong-task regression,
not universal accuracy or byte-exact instruction following. UI v1 was separately
served and reloaded at the same origin: it retained the same account, connected
app and three cards. The normal v2 preview was restored afterward. No new image,
audio, app handoff or IOU save test is claimed by these checks.

The [025 emulator update observation](F:/Temp/OpenChat-IOU/generic-context-apk-025/artifacts/emulator-install-observations.json)
records an in-place install, exact installed-APK hash match, unchanged first-install
time/data directory, and the normal v2 Chats screen showing the existing account
and Kiko chat without signing in or relinking. The official app was not changed.
This is startup/account-retention evidence, not native model inference or native
IOU delivery acceptance. Native setup Share remains approval-bound; phase B has
not run. ARM remains statically verified, with physical-phone testing deferred.

The 4be9f67c source passes all 821 scoped offline contracts. Its hosted
[frontend workflow](https://github.com/ktimam/open-chat/actions/runs/37072089720)
passed. The [scoped security workflow](https://github.com/ktimam/open-chat/actions/runs/37072089642)
passed model contracts, real inference and both native hermetic jobs, but remains
failed on the same ten deferred Rust advisories and Kotlin compiler acquisition
before Android component compilation. The transport cause is still unknown; no
security policy, pin, redirect rule or advisory gate was waived. Local APK success
does not substitute for that hosted Android gate.

### October 3: subsequent upstream source integration

Fork main now includes official upstream `42a4d64fd681887c930926827d20eefe924b96a1`
in merge commit `3b259b2f53c4d7b6bad30d9747bf3554281ca72f`. The only conflict was
the mobile composer's wallet-approval `chatId` property; the model/app/card additions
were preserved. The backend tree is exactly upstream's
`82776d77f29bebae0f255c234772ebef1ee0d6ea`; no canisters were deployed. Two scoped
test runs passed 1,001 and 1,019 tests, and both frontend typechecks passed. The
merge has not been pushed, and the served web/installed APK remain build025:
their earlier runtime evidence is not evidence for a newly packaged merge.

A separate normal build025 v2 UI check opened Apps and three retained cards,
reviewed one synthetic card without consenting to send, then reloaded. The same
fields and cards were restored while the card returned to draft and required a
fresh review. Nothing was sent or saved in IOU. The source-details/labels prompt
experiments remain inactive and do not replace this build's app package.

### Current local-test completion checklist

Use this finite checklist rather than treating each historical checkpoint above as a
new requirement to rebuild or repeat all tests. Runtime evidence remains bound to its
actual artifact; documentation-only changes do not change the packaged source identity.

| Requirement | Current evidence | Remaining boundary |
| --- | --- | --- |
| One fork main; official OpenChat services and unchanged OpenChat backend | Implementation/test checkpoint `6630ae711201983919245aa471100e4f4f857044` is pushed on fork `main`; later documentation-only commits do not change that runtime checkpoint. Integrated official upstream is `319fb436857f35f61e12a9d47bebf6ddb0a72307`; the backend tree exactly matches its `74b32ad8a9f39a5dc60e56461db767f85026039c` tree | No custom canister or OpenChat backend deployment is required. Build026 remains bound to its actual `3b259b2f53c4d7b6bad30d9747bf3554281ca72f` source; it is not relabelled as HEAD |
| Normal Apps UI; no technical setup/import page | Both build026 web layouts passed independent verification. The same profile retained the connected IOU app and three private cards; actual 393-by-851 v1 and mobile-v2 smoke checks passed, and the reopened card fit the phone width and required fresh review | This is startup, restoration and responsive-layout evidence, not model inference or native delivery |
| Automatic app discovery and explicit connection | Desktop IOU reconnect remains passed, and build026 web retained the connected app. October 4 installed APK normal Apps → IOU Connect → existing IOU sign-in → approved synthetic sheet → one setup share passed. IOU reported setup sent; the APK independently reported Connected. The account and enabled IOU setting in the approved chat survived a normal APK restart | Connection acceptance is not entry delivery, image inference or public provider qualification. No new identity, passkey, canister or entry was created during connection |
| Encrypted persistent private cards | Both build026 layouts retain their earlier restoration checks. Five desktop local cards restored without approval or automatic resend. October 4 APK normal text Send → IOU Propose produced the synthetic 123.45 USD / 2026-09-27 / You owe card with its Synthetic acceptance Type. After Close, force-stop and normal launch, Apps → Saved cards reopened the same fields and Type with fresh review required. A subsequent post-save restart retained the original import ID, payload and encryption descriptor; recovery again required explicit review and confirmation | The native text test used the app-owned local text processor, not a model or OCR; its expected empty note does not qualify note extraction. UI restoration does not independently inspect at-rest ciphertext |
| Confirmed encrypted app delivery | Earlier desktop v2 Gemma exact-request review, encrypted handoff, IOU review/save and post-reload sheet readback remain passed. October 4 APK explicit review/confirmation, native pairing, sender-bound IOU consent, local decryption, second review and one Save passed. IOU applied the synthetic Type's 10% fee: 123.45 USD gross, 12.35 fee and 111.10 net. Independent normal sheet readback found exactly one new matching entry. Foregrounding the existing relay without resubmission completed its saved receipt; the APK then showed Saved with send/retry/reopen controls absent | Post-save same-ID deduplication is not yet qualified: its separate restart/retry passed pairing and IOU consent but did not expose a received draft, and the APK later reported an unknown handoff. No second IOU Save occurred; callback diagnosis remains open. Natural Back is unverified, and the exact background scheduling cause is not established. Recipient decryption and the approved account/sheet were checked, but full principal/backend context was not independently pinned |
| Preserved model features and accurate image proposals | Earlier actual Qwen/Gemma image runs and exact-output IOU normalization remain valid for their tested artifacts. Fresh build026 desktop v2 Gemma proposals passed core fields; a matching heading also selected the existing private Type and its You owe default. Prompts, weights and all-WebGPU settings are unchanged | Fresh normal-UI Qwen acceptance remains pending, with Edge control unavailable. October 4 emulator APK preflight exposed navigator.gpu but default requestAdapter returned null before model loading; its existing host-GPU configuration was not changed. Android Vulkan profile checks also failed, but the exact WebView rejection is not established. No model weights were downloaded, no inference was run, and no CPU/OCR fallback was used. This is not evidence of a phone or model-accuracy regression. Qwen's 1,024-position context limit still applies; inactive expanded-image experiments remain inactive |
| Separate local APK and account preservation | Both APK026 ABIs passed independent package-aware verification. The x86_64 APK was installed in place without clearing data, and its guarded cold reopen restored the remembered account, normal Chats UI and Kiko row without sign-in, browser or provider UI | Startup restoration does not independently prove principal/provider identity; native delivery has the separate evidence and limits above. ARM physical-phone testing and public provider qualification are deferred, not passed |
| Scoped source and hosted verification | Exact pushed commit `6630ae711` passed all four frontend jobs and all five scoped security test/compilation jobs, including hosted Android, Windows and Ubuntu. The targeted cache-cancellation suite passed 71 tests. At the later documentation commit `87a9b605d`, scoped run [37188618758](https://github.com/ktimam/open-chat/actions/runs/37188618758) passed its model contracts, Android compilation, Windows/Ubuntu native tests and pinned real-inference test; frontend workflow [37188618749](https://github.com/ktimam/open-chat/actions/runs/37188618749) reported overall success. Build026 retains its separate artifact-bound proofs | Security CI is not clean: the later scoped run failed its npm/Rust advisory gates. IOU commit `577f059` run [37188618011](https://github.com/ktimam/IOU/actions/runs/37188618011) failed dependency audit; its downstream typecheck, coverage, card UI, build and Rust jobs were skipped, not fresh passes. Complete later failure logs were unavailable, so their full finding sets have not been reconciled to prior deferrals. The exact documented Rust findings and [braces local-test-only deferral](releases/npm-feature-advisory-triage.md#october-4-local-test-braces-deferral) remain open/disclosed without scanner suppression. Earlier passes and documentation-only commits do not relabel build026 or qualify an untested later runtime |

Optional synthetic-voice accuracy, physical-phone testing, public branding/domain,
public provider qualification and public publication retain the user's explicit
deferrals. They must not silently become passing tests or new local-test gates.

#### October 4: native handoff lifecycle diagnosis

A separate, explicitly confirmed same-ID retry reached the already-authenticated
IOU receiver and its normal connection consent, but no draft arrived. A bounded
45-second, metadata-only observation saw one `/dispatch` request start with no
response or failure. Android independently reported the APK as cached and frozen
(`curProcState=16`, `isFrozen=true`) while Chrome was foreground. Bringing the APK
to the foreground changed those to `curProcState=2`, `isFrozen=false`, without
resending or saving. The loopback server is hosted in that APK process and had no
active Android lifecycle component keeping it runnable during the browser handoff.
This is a concrete native lifecycle defect, not a model, prompt or OCR failure.

A bounded, local-test-only foreground-service fix has been implemented. Android
must acknowledge foreground retention before a transfer URL is returned. Setup
and handoff have independent owners and retain their existing deadlines; terminal
responses drain before the service is released. Cancellation and service loss
invalidate native authority without treating a previously dispatched request as
assuredly recalled. Consent, encryption, recipient and proof checks are unchanged.
Expired transfers do not restart, and notifications contain no private app data.

The actual-source native harness passed 42/42 tests, including startup refusal,
pre/post-dispatch service loss, Received-to-Saved cleanup, independent owners,
expiry and consumed-setup response draining. The five pure Kotlin policy tests
passed, and the actual Android service compiled against SDK 36 and pinned real
AndroidX core 1.18.0; only generated R was a fixture. The scoped CI contracts
passed 340/340. CI now explicitly tests the feature-enabled Rust listeners on
Windows/Linux and compiles the service rather than relying on unrelated Android
component tests. Full APK compilation and emulator regression are still separate
pending gates. No second IOU Save occurred during these source tests.

#### October 4: existing hosted advisory evidence recovered

Subsequent retrieval of the existing scoped run 37188618758 recovered its complete
report; no new advisory query was run. Its npm finding is exactly braces 3.0.3,
GHSA-vfj7-8cjw-p6xm, covered by the explicit local-test deferral. Its ten Rust rows
match the previously documented exact identities: two glib advisory IDs, h2,
proc-macro-error, rustls, and the five unic packages. The original failed results
and the report's completeness/freshness limitations remain intact; this is not a
clean security scan or public-release acceptance.

The existing IOU run 37188618011 also reports ip-address, fast-uri,
brace-expansion and additional Hono findings. The braces decision does not
automatically defer the different brace-expansion package or new advisory IDs.
Those findings still need a scoped disposition; no dependency was upgraded and
the functional jobs skipped behind that failed audit remain skipped.

### October 3: build026 and HEAD8ac checkpoint

Build026 is frozen to merged-main source
`3b259b2f53c4d7b6bad30d9747bf3554281ca72f`: 6,654 committed files with source
inventory SHA-256
`9430c924aa51cb1a36d38318e940c7c9484057a5bb3ba85e17415b70fffa5f3f`.
Web v1 (`2.0.0-localtest.124e0653069cecb33963a578f3b43233`) and v2
(`2.0.0-localtest.8bdee372e6eba9e335ecdcec35c701bb`) each verified 1,792 files
and 48 source-map proofs. Their independent-verification report SHA-256 values are
`c3312ad51e18e437acf7403a6284bfaf1a2521125555b2420b96abeea32f5bb0` and
`267d7b094a6ea5cc9ef9d7386681ff068220bd1f4334da66cf6a7a533004346e`.
The responsive v1/mobile-v2 result is
`F:/Temp/OpenChat-IOU/merged-main-web-026/mobile-layout-smoke.json`, SHA-256
`308687957cdda3028a220f46929747ba4e1f04206e5a6ce63e2e51ed2621b51c`.

APK026 uses the same source inventory, compiled 1,795 frontend files and has build ID
`9d0c5ffa5d2b94c12f1fa91e698746a8`. The x86_64 APK SHA-256 is
`32415d862d5212caa6a144cd3f0946fe7599ed628c5c35816aa45e520d3847dc`;
the aarch64 APK SHA-256 is
`7a3d433265fe2311eaecc9611b1cdc5e509f03c41565adbbe7e5edde224ebddb`.
Their independent-verification report SHA-256 values are
`9b35bd31ba010facbc47d930e940a8b685c11080a0656874e9bc23d066efccaaf` and
`f51376c66070b12c07ae78bded32cf802fea49221dba8e5a30a5dd884fd38424`.
The x86_64 in-place install and controlled cold reopen passed 87 policy assertions
and 33 static contracts; its artifact-bound result SHA-256 is
`e3bd951b1f5251af8e6187997a6359989e35d6e8010996710ace064d74c909ff`.

The later upstream-only merge is HEAD
`8ac17d9e63d19b7388fa9df914a1e93ed6c8c40c`, tree
`2adf18832c68df0740da112cc37389e84fa2fcad`, with official upstream parent
`319fb436857f35f61e12a9d47bebf6ddb0a72307`. Its backend tree is the exact
upstream tree `74b32ad8a9f39a5dc60e56461db767f85026039c`; only 21 backend paths
changed. Every tracked path outside `backend/`--including frontend/native sources,
build scripts, root Cargo manifests/lockfile and CI definitions--is unchanged from
the build026 source, and the native manifests reference no changed backend path.
Accordingly, build026 stays labelled against `3b259b2f5`; no artifact was relabelled
or rebuilt for HEAD8ac, and its verified non-backend package inputs remain unchanged.
No backend deployment, running-client replacement or saved-data change occurred.

At that historical HEAD8ac checkpoint, native setup Share and subsequent native
prepare/restart/delivery/readback, separately gated same-ID retry and hosted CI
remained pending. Use the current checklist above and the later checkpoint below
for their present disposition. Physical-phone testing, public provider qualification,
public branding/domain and public publication remain deferred.

### October 3: pushed main, hosted compilation and desktop image delivery

At this verified implementation/test checkpoint, fork main and origin/main matched at
`6630ae711201983919245aa471100e4f4f857044`. The pinned Kotlin redirect correction
was pushed in `23b99c25c5aa105d6bdfafa7ce8fc7e08ea79c7d`; the later commit adds only
a regression test for cancellation while checking a downloaded model's cache.
The 71-test targeted suite passes. The test verifies cancellation retains both
downloaded caches and the previously selected model, without another preload,
cache deletion or runtime refresh. No visibility safeguard or runtime code was changed.

The exact-commit [frontend workflow](https://github.com/ktimam/open-chat/actions/runs/37143795106)
finished successfully with all four jobs passing. The
[scoped security workflow](https://github.com/ktimam/open-chat/actions/runs/37143795163)
passed all five test/compilation jobs: frontend contracts, real small-fixture
inference, Android component compilation, Windows and Ubuntu native checks.
Only its [advisory job](https://github.com/ktimam/open-chat/actions/runs/37143795163/job/111263495943)
failed, on the same ten Rust advisory IDs and the separate new braces finding.
Collection and schema checks passed. The earlier Kotlin acquisition failure is
resolved; native app runtime acceptance and advisory disposition are not implied.

Fresh normal desktop v2 build026 observations are recorded separately from the
earlier raw-worker tests. Both proposals used Gemma, Model only, WebGPU for
embeddings/vision/decoder, greedy generation and the unchanged 96-token allowance:

- The [synthetic invoice proposal](F:/Temp/OpenChat-IOU/ui-image-acceptance-20261003/normal-ui-gemma-invoice.json)
  returned 123.45 USD, 2026-09-27 and its invoice heading without manual edits.
  Its fields persisted after reload and required fresh review. A printed direction
  and footer-only Type keyword were not extracted; these are outside the active
  original-PR image contract, not passing fidelity assertions.
- The [heading-match delivery](F:/Temp/OpenChat-IOU/ui-image-acceptance-20261003/normal-ui-gemma-heading-match-delivery.json)
  returned 321.09 USD, 2026-09-30 and the matching heading, selected the existing
  private Type and applied its **You owe** default. The fixture had no printed
  direction. Exact-request review, encrypted relay, receiving-app sign-in,
  decryption, second review and one explicit save completed. IOU's existing Type
  applied its 10% fee: 321.09 gross became 288.98 net. The correct row persisted
  after reloading the approved synthetic test sheet. Reloading OpenChat retained
  the card as uncertain with the original fields/import ID, no restored approval
  and no automatic retry. No second send or save was performed.

These are actual desktop UI observations, not a network capture, a comprehensive
cryptographic audit, APK qualification or a second execution in UI v1. The active
IOU profiles and shipped processor are unchanged. The inactive source/labels prompt
experiments have not been activated or used to redefine original-PR acceptance.

The fresh Qwen attempt reached downloaded-cache SHA-256 verification but was
cancelled when Edge reported the page as backgrounded; Gemma remained selected.
Qwen inference did not start, so that attempt supplies no new reading-accuracy
result. The remaining Qwen check must use the normal UI after successful selection,
without deleting the cache or changing the tested prompt. The native IOU login
return separately remains unresolved, with narrow diagnostics permission-bound.
Desktop login success does not prove that native return is fixed.
