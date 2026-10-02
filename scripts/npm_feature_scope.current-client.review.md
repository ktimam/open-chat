# Current unofficial-client npm source ownership

Latest disposition: see **October 2 upstream merge and card presentation**
below. Earlier sections and their hashes remain historical evidence; they do not
describe the now-removed active browser-auth transport.

Reviewed 2026-09-29. This is a **direct-feature ownership review**, not an
advisory waiver, whole-core audit, runtime/phone qualification, or release approval.
The separate current composition is `current-client-npm`; its CLI selector is
`--scope current-client`. Historical PR1/PR2 configs, source snapshots and advisory
decisions remain unchanged and are not reused as current-source acceptance.

## Initial source boundary

The initial current-client review fingerprinted 98 dedicated production modules
plus exact ownership evidence in necessary shared consumers: 115 unique files.
CRLF-to-LF normalization is the only source normalization. Its recorded aggregate is
`33b3ad8615b578d6d0f4d36aca795ddcaeb6baef4804f842b730bcecf57f3856`.

The dedicated model and app/card/OCR families remain covered. The additional
current-client families are:

- `frontend/app/src/utils/localApp*`, `privateApp*`, `nativeApp*`, and
  `isolatedAppProcessor*`: catalog/configuration, processor isolation, extraction,
  field editing, immutable review, memory-only drafts and approved delivery.
- Shared `PrivateApp*.svelte` and `LocalAppsChatSettings.svelte`: actual editor,
  complete review, preview and chat configuration. Test shells are excluded.
- Browser relay build/headers, `localAppHandoffRelay.ts` and its fixed HTML page.
- Native relay build, `localNativeAppHandoff.ts` and its fixed HTML page.
- The dedicated service-worker relay-cache exception and Tauri JS model/handoff
  command modules.

Shared application entrypoints and Vite/Rollup configuration have exact feature
anchors, not broad import scans. Unrelated core auth, chat, wallet, media, compiler,
minifier and style consumers are not added merely because they coexist in those
files. The native browser-auth signer is outside this model/app scope. Rust source
ownership is separately reviewed; this inventory does not select backend crates
or require new OpenChat canisters.

## Current named-choice source review

The intervening setup-persistence review retained in the config covers 99 dedicated
modules / 117 fingerprinted sources at
`128c7d9a57258fb3720ae19e825d7345bf9186f84294bd8aa6adcc31f5eb9409`.
This additive review compares the named-choice changes against the clean fork
checkpoint `030fc60a81efe1369a887586b900ef20c46579b0`; it is not a formatting-only
refresh. The integrated upstream baseline is still
`d1e3712bb9ded3a1c8b652492591b7107333b23e`. No upstream merge is represented here.

The new `localAppDraftChoices.ts` is already selected by the current-client
`localApp*` family; no selector or dependency root was expanded. Its three literal
imports are `./localAppCatalog` (type only), `./localAppDrafts` and
`./localAppDraftFields`. The catalog and workspace add internal references to
these helpers only. The field component, workspace component and existing row
helper retain their prior direct-import sets. Every dedicated source was scanned
with the unchanged reviewed-root checker; no new registry dependency is needed.

The implementation was read before recording its fingerprint: the catalog accepts
only the bounded, versioned app-authored editor declaration; choice IDs, labels,
assignment targets and scalar defaults are validated against the app's row schema.
The UI shows labels alongside exact raw IDs and exposes assigned companion fields
as read-only outputs. The generic workspace retains baseline/manual-edit history
in memory, revokes review on edits, blocks inconsistent/unknown choices, and still
requires complete payload validation and explicit delivery review. Advanced JSON
remains authoritative and does not silently reapply defaults. No app-specific
field names, prompts, processor logic or model logic were introduced in this path.

Only these six inventory sources differ from that checkpoint (SHA256 uses the
existing UTF-8/LF identity):

| Source                                                            | Current SHA256                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `frontend/app/src/utils/localAppDraftChoices.ts` (new)            | `4e72cf0063dd7917d0a106b876fe53f63beb026d4b4cbbd429f811b7fe782a5d` |
| `frontend/app/src/utils/localAppCatalog.ts`                       | `809df079e4f417435c87f3c8637b3ed024711cbae3e15cdac538dbbebc2c9449` |
| `frontend/app/src/utils/localAppDraftFields.ts`                   | `035dbfa7511383b8b1b9e72f3e889603d6bc44522c628719bb406a71d6bcfd6c` |
| `frontend/app/src/utils/privateAppWorkspace.ts`                   | `7f87eaf0a02263b08cfe69557f3c184d776cf6dc9f5ec28111d4e3830147129d` |
| `frontend/app/src/components_shared/PrivateAppDraftFields.svelte` | `d92d1c009e31feac6171e3c77be9d6f9a991da16324740f3ad8b1841e198607f` |
| `frontend/app/src/components_shared/PrivateAppsWorkspace.svelte`  | `d7ad22c0df801de9d1de855b7e2f99eb8db3934608fc4c3cabd5b07dcfb37c00` |

Current composition: **100 dedicated modules, 118 fingerprinted sources, 25 roots
and 65 exact ownership anchors**. The aggregate is
`6cbb333685c4468caf582ebcd14ced145a7d62b45554a2968be803e78547e023`.
The root/anchor arrays are unchanged, as are manifests, lockfiles, historical
inventories, earlier current snapshots and advisory decisions. Choice declarations
are setup data in the existing catalog; draft history is not added to durable
storage or outgoing requests. No collection, dependency query, advisory waiver,
backend change, deployment or native runtime acceptance is implied by this review.

## Reviewed roots and disposition

The 24 still-owned roots from the prior compositions remain justified by current
consumers, not by historical membership alone:

| Consumers                                                             | Roots                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Model/audio execution and hashing                                     | `@huggingface/transformers`, `@wllama/wllama`, `onnxruntime-web`, `@noble/hashes`                         |
| Current Svelte model/private-app UI and retained compatibility UI     | `svelte`, `svelte-i18n`, `svelte-material-icons`, component-lib-owned `@tsconfig/svelte` and `typescript` |
| Native model and approved private-app bridge                          | root-owned `tauri-plugin-oc-api`, tauri-plugin-oc-owned `@tauri-apps/api`                                 |
| Retained model catalog/shared action interfaces and reached transport | `@sinclair/typebox`, `@icp-sdk/core`, `msgpackr`                                                          |
| Retained action-card message-cache reconciliation                     | `idb`                                                                                                     |
| App-declared optional OCR and language assets                         | `tesseract.js`, `tesseract.js-core`, `@tesseract.js-data/eng`, `@tesseract.js-data/ara`                   |
| Model/relay asset and worker builds                                   | `vite`, `@tauri-apps/cli`, `chokidar`, `rollup-plugin-copy`, exact locked `node_modules/fs-extra`         |

`idb` is not private-draft storage: those drafts remain memory-only. Retained
compatibility modules and model catalog schemas do not make remote card
verification or backend app registration a prerequisite for local drafts.

One additional root was explicitly reviewed: exact locked location
`node_modules/esbuild`, used directly by
`frontend/app/localNativeAppHandoffBuild.mjs` to bundle only the fixed first-party
native handoff entrypoint. At review it is version `0.25.12`, MIT, with lock
integrity `sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==`.
The frontend manifest does **not** declare an esbuild edge; this review records
the existing hoisted locked location instead of inventing an owner declaration.
No manifest, lock, package version or installation changed. The location's locked
dependency closure remains subject to the same collector, peer, platform,
integrity and advisory checks as every other selected location.

## Enforcement and verification

The current 25-root set is fixed independently of the seed config. Missing,
relocated or added roots, changed source ownership anchors, unreviewed direct
imports, changed source sets and changed fingerprints fail closed. Literal static,
side-effect, re-export, dynamic-import and require dependencies are checked in
dedicated modules. Relative and existing internal alias imports do not become
new registry roots. Source review does not approve advisory findings.

Current-client advisory planning accepts only its own current inventory, never a
mixture with historical PR inventories. CLI scope and plan/query mode remain
explicit. Existing bounded registry requests, runtime identity checks, immutable
input checks, sanitized failure reports and failing-advisory exit behavior are
unchanged. No network advisory lookup or whole-repository audit was run for this
source-ownership update.

Small offline regression commands:

```sh
node scripts/npm_feature_seed_review.mjs --scope current-client
node --test scripts/npm_feature_seed_review.test.mjs scripts/npm_feature_scope.test.mjs scripts/npm_feature_advisories.test.mjs scripts/npm_feature_advisories.review.test.mjs scripts/npm_feature_runtime.test.mjs
```

The existing collector/runtime commands also accept explicit
`--scope current-client`; all other required options and approvals are unchanged.

## Reviewed upstream-merge source checkpoint (2026-09-29)

This separate record reviews the resolved frontend composition for upstream
`5f00758312735f2ddac9928e3aa60349964bf73a` merged into fork checkpoint
`8a164a52a33d09ce7b4390c96723194026ea8733`. The previous integrated upstream was
`d1e3712bb9ded3a1c8b652492591b7107333b23e`; earlier records above retain their
original meaning. This is not a formatting-only refresh or proof that the merge
commit, Rust lock decision, hosted CI or runtime acceptance has completed.

Exact comparison with the fork checkpoint finds only four changed files in the
existing 118-source inventory:

| Source                                          | Reviewed merged SHA256 (UTF-8/LF)                                  |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `frontend/app/src/components/App.svelte`        | `2ceed63767ca9c00f18abb89016be88c9e9ff58d7858ab36ae11d0886d9a71c1` |
| `frontend/app/src/components_mobile/App.svelte` | `7ea0681d5d915320f704095654c0cf5c97ce8ba68a15374a3745f8c0966e56ed` |
| `frontend/app/src/i18n/i18n.ts`                 | `652babbd5f519e9235b52a3bdae96f7990cce8299356e11455c556d0c1531d63` |
| `frontend/openchat-client/src/openchat.ts`      | `b5da45a232b7c9fc1763edbe34c2e33805a7b14634d56237ffd6ea6e17d20405` |

The two App entrypoints add upstream locale-load fallback/reload handling while
retaining the private workspace imports and mounts. The i18n module uses the new
local locale fallback helper and the same existing Svelte packages. The client
adds a deleted-user filter to its direct-chat refresh loop; the exact private-app
account/backend storage getter is unchanged. These are mixed-file changes, not
new feature-owned dependency roots or approval to scan unrelated core imports.

All 100 dedicated modules, 25 roots, 65 exact ownership anchors and 118 source
paths remain unchanged. The frontend manifests and lockfile are unchanged from
the fork checkpoint. The current aggregate is
`14fb964489adca4863a72792cd229a5273594de925d2cfc80188a9f3f64fa806`.
The original source reviews, the 94-file formatter-equivalence proof, setup-only
persistence and named-choice evidence remain intact. No advisory query, package
installation, root expansion, backend deployment or release acceptance is implied.

## Approved connection and remembered-sign-in source checkpoint (2026-09-30)

The user explicitly approved scoped CI verification for the current app-owned
connection and local-test remembered-auth seam. This checkpoint reviews the actual
working-tree sources on `7fe6c8925530962a222ba6b816b3c7998cb8d91f`, including the
new browser-auth explanation copy. Earlier exclusions of this seam describe their
historical checkpoints; they do not silently grant or restrict this separate
approval. No earlier snapshot, historical PR policy or advisory decision changes.

The previous accepted snapshot was independently reconstructed from Git commit
`9e8c88ece52860e6d0e3569969cc676072016227`, using its selectors, evidence paths and
source bytes, and both the previous and current UTF-8/LF fingerprint functions.
It exactly reproduces `14fb964489adca4863a72792cd229a5273594de925d2cfc80188a9f3f64fa806`
over 100 dedicated owners and 118 fingerprinted sources. The current comparison
adds 31 paths, changes 14 existing source files and removes none. No prior temporary
candidate hash was accepted as current evidence.

The current aggregate is
`bf0884970516515d0cd38b6a405e858c2db331bcbf633b6371320e91275153c9`:
**119 dedicated modules, 149 fingerprinted sources, 25 unchanged roots and 90
exact ownership anchors**. The same fail-closed import, root, anchor and source-set
checks apply. The current-only test-fixture exclusion keeps test data out of the
production inventory and does not change either historical selector.

### Added owners and narrowly reached sources

Nine dedicated app-connection owners cover `localAppDirectory.ts`,
`localAppSetupConnection.ts`, `localAppSetupPopup.ts`, the browser setup relay and
public HTML, the native setup entrypoint/HTML/build plugin, and the native setup
guest command. The directory fetch path accepts bounded same-publisher public
metadata and verifies processor hashes. Setup requires an explicit app-owned
consent exchange, exact popup origin/window/nonce validation and package
revalidation. The native bootstrap uses a short-lived one-use fragment secret,
scrubs it from the visible URL and does not transfer account credentials. Restored
setup remains bounded, strict-key, account/backend-scoped data: selected catalog
actions, verified processors, connected installations and chat opt-ins. Drafts,
messages, approvals, credentials and delivery payloads remain excluded.

Ten dedicated auth owners are added: `local-browser-auth.html`,
`localBrowserAuthBuild.mjs`, `src/localBrowserAuth.ts`, the client
`nativeBrowserAuth.ts`, `nativeBrowserSigner.ts`, `nativeBrowserSignInFlow.ts` and
`nativeBrowserSessionStorage.ts`, agent `nativeBrowserAccountSession.ts`, shared
`nativeBrowserSession.ts`, and the `localBrowserAuth.ts` guest command. Their direct
imports use already reviewed SDK, idb, Tauri and esbuild roots; relative/internal
aliases do not invent package roots. All 119 dedicated sources were scanned, not
only the additions.

Twelve newly fingerprinted mixed/reached paths are `rollup.extras.mjs`, desktop
and mobile `OnboardModal.svelte`, `ExistingAccountSignIn.svelte`, agent
`identityAgent.ts` and `singleSubmissionFetch.ts`, client `config.ts`,
`browserAccountLink.ts`, `browserPasskey.ts` and `browserSignInDiagnostics.ts`,
shared `domain/worker.ts`, and `openchat-worker/src/worker.ts`. Each has an exact
feature anchor. Existing mixed `openchat.ts`, Rollup and guest index sources also
gain scoped anchors. Whole-file fingerprints detect drift, but mixed/reached
files do not enter the dedicated direct-import scan or approve unrelated core
dependencies by coexistence.

### Auth, persistence and cleanup findings

The browser signer validates the fixed challenge/delegation target, challenge
origin/RP, P-256 signature and required user presence/verification. A new sign-in
attempt has a 120-second gesture window; the APK-only key/delegation is distinct
from that attempt. Existing-account proof uses the pinned ICP API configuration,
verified queries, bounded credential-omitting requests and a single-submission
identity update transport. Restore rechecks the fresh existing account against the
saved user/principal and configured backend before client/worker activation.

The separate `oc-native-browser-session` IndexedDB store uses the existing `idb`
root and saves a nonextractable P-256 key, bounded delegation and exact account/
backend scope. Record validation, generation checks and metadata-only logout
tombstones prevent stale restoration/clearing races. There is no localStorage
fallback. This is not private-app setup storage or durable draft history, nor a
claim of hardware-backed storage or protection against a compromised device.

The shared worker helper is structural/delegation-scope validation, not a second
independent cryptographic account proof. The client performs the fresh account
proof before adopting the worker session. Transient restoration errors retain the
saved record for an explicit retry while leaving the client anonymous; invalid or
expired sessions are cleared. Logout clears saved sign-in. The `7fe6c8925` cleanup
path preserves anonymous rollback even if deleting a just-saved record fails;
the fixed diagnostic and sign-in UI require explicit saved-sign-in clearing before
another attempt. The current HTML distinguishes the 120-second attempt from the
up-to-30-day remembered session and its online verification requirement.

Optional account-link/passkey helpers retain explicit credential interaction,
required user verification and cancellation propagation. Source checks do not
qualify any browser/Android credential provider, prove real-device remembered
restore, or establish runtime acceptance. No additional dependency root or new
scoped source-ownership finding was found; this is not a general security audit.

### Existing-source delta and verification boundary

The 14 changed previously fingerprinted sources are `localAppRelayBuild.mjs`,
`rollup.config.mjs`, desktop/mobile `App.svelte`, `PrivateAppsWorkspace.svelte`,
`localAppHandoffRelay.ts`, `localNativeAppHandoff.ts`, `localAppSetupStore.ts`,
`privateAppWorkspace.ts`, `vite.config.ts`, client `openchat.ts`, service-worker
`local_app_relay.ts`, guest `index.ts` and `scripts/build-unofficial-local-apk.mjs`.
They integrate setup launch/discovery, consented connection/persistence and
the narrowly reached auth flow with existing workspace, relay and local-test
build entrypoints. Existing handoff validation and delivery review remain in
place. The runtime sources themselves were not edited by this inventory update.

Added regression coverage pins all nineteen added production owners, their exact
direct imports, historical-scope separation and the setup fixture exclusion.
The ten auth owners additionally reject per-file removal and content mutation;
unreviewed setup/auth package imports fail closed. Exact counts and all four
mixed-client ownership anchors remain asserted. No test, root allowlist or
advisory disposition is relaxed to accept this snapshot.

Use the two offline commands in **Enforcement and verification** above to verify
the current inventory and the five scoped npm contract suites. Both passed for
this checkpoint: the source gate reports 149 sources and the aggregate above;
all 147 contract tests pass with zero skipped or cancelled tests. The initial stale
inventory failed its two expected source-snapshot assertions; the new receipt
records the reviewed current bytes rather than bypassing those checks. No network
query, package installation/upgrade, core audit, advisory waiver, APK rebuild,
browser/device test or deployment was performed by this source-review change.

## Original-auth restoration source review (2026-09-30)

This additional, user-approved current-source review binds the restored original
auth flow after the client/worker/UI owners declared their production changes
stable. The earlier browser-auth snapshot is preserved unchanged, not silently
relabelled as acceptance of the restored path.

The current aggregate is
`425a64c8f66fb23956590bc0a698e865bbf1e606d3144b2e8411ad3dc2f1898c`:
**119 dedicated modules, 148 fingerprinted sources, 25 unchanged dependency roots
and 86 exact ownership anchors**. Dedicated selectors, dependency allowlists,
strict UTF-8/LF identity and all historical PR records are unchanged.

Reviewed source changes restore the original desktop/mobile onboarding UI,
Android passkey entrypoint, AuthClient with original IdentityStorage, worker
auth-principal cache lookup and delegation refresh, and ordinary account-linking
transport. Worker initialization/linking functions and the SetAuthIdentity type
match pinned upstream `5f00758312735f2ddac9928e3aa60349964bf73a`; worker reply
logging remains redacted. Client auth methods were independently compared with
the same baseline. This is a bounded restoration review, not a broad core audit.

The custom ExistingAccountSignIn screen is deleted. Active browser-session
adoption, custom remembered-session saves/clears and the browser-auth Rollup plugin
are absent. The builder rejects browser-auth assets and no longer enables the
browser-auth Cargo feature. Original account-creation UI and behavior are again
available: this review does not claim an existing-account-only guard, and no real
account was created by verification. The App entrypoints, native delivery and
private workspace use clientOnlyApps independently of authentication policy.

Exactly five stale anchors now identify original onboarding/native identity/
worker/protocol source. Four removed-use anchors are retired: the deleted screen,
the two removed custom-session save/clear calls and the removed Rollup plugin
invocation. The source count falls by exactly the deleted screen. All ten legacy
browser-auth helper owners remain scanned and fingerprinted as dormant source,
including their idb/esbuild/SDK/Tauri edges; none is represented as active sign-in.
The standalone structural validator's type no longer imports the worker protocol.
Tests continue to reject helper removal, source drift and unreviewed imports, and
now additionally require original bootstrap/worker fields and independent app
guards while rejecting active custom browser-auth/session references. Exact
counts are updated for reviewed removal, not waived or made conditional.

No dependency installation/upgrade, advisory request/waiver, new dependency root,
APK build, device persistence test or authentication ceremony is part of this
review. Google Password Manager/RP association, real provider behavior and binary
acceptance remain separate gates. Native Cargo/profile/license binding is a
separate current-client review and is not inferred from this npm receipt.

Verification: the current source gate reports the aggregate and counts above;
all **148** tests in the same five offline npm contract suites pass, with zero
failed, skipped or cancelled tests. Existing root-removal, import-drift, malformed
source, ownership-anchor and historical-scope checks remain enabled.

## Mobile error-translation checkpoint (2026-09-30)

The reviewed current aggregate is
`09b7e91e437cfbfb58c6029fbd51066967ffd27899a3406206dee87514e16341`.
All **119 dedicated owners, 148 fingerprinted sources, 25 dependency roots and
86 exact anchors** are unchanged. The preceding `425a64c8` snapshot remains intact.

Exactly one fingerprinted file changes:
`frontend/app/src/components_mobile/onboard/OnboardModal.svelte`. Its strict
UTF-8/LF SHA256 changes from
`1c93d07d7b15826a5c0af8a593a86cffc092ff3dd1eb39911cb4a37114fb7785` to
`251df92cfea239711f19508c72e08c50c0a5424c9285c7762ba9bf262ffae6e8`.
Restoring the original component had also restored its bare `i18nKey(error)`
lookup, although handlers produce short codes and the real catalogs require
`native.auth.errors.*`. The existing 44 renderer tests correctly caught this
display regression; their expectations were not weakened or replaced.

The two-line exception to exact upstream UI equivalence imports the existing
local `nativeAuthErrorKey` helper and applies it only to the error resource key.
Known codes select translated messages; legacy or unknown provider strings select
the existing generic message. Original handlers, layout, sign-in/account-link
routing, native commands, session persistence and private-app boundaries remain
unchanged. Reversing only these two lines reproduces both the prior file hash and
the prior full aggregate; the added offline contract asserts that exact delta.

Focused renderer/onboarding/lifecycle verification passes **87/87**, including all
44 former failures with real English/Arabic catalogs. The same five offline npm
contract suites pass **149/149** and the source gate reports the aggregate above.
No selectors, roots, ownership anchors, package/lock identities, historical PR
policies or advisory decisions change. This is not a core audit, provider/DAL
qualification or binary acceptance: existing APK015 assets remain unchanged and
do not contain this later source-only display correction.

## Upstream c0ac3178 merge checkpoint (2026-09-30)

The reviewed working-tree source aggregate is
`3e5e911fe406ba81cee7320c706bc1482ffdc02b977f684b5cc55185e0fcdb33`.
This compares the resolved merge of upstream
`c0ac3178f70f5e9de2f6ee532ce1415ab32a47cd` against committed fork restoration
`77346e24cb4711485b51e6beb2c1ce183b23228b`. It does not claim a completed merge
commit, installed dependency tree or rebuilt APK. Counts remain **119 dedicated
owners, 148 fingerprinted sources, 25 roots and 86 exact anchors**. No selector,
ownership anchor or dependency root changes; all dedicated sources are unchanged.

The eight changed fingerprint inputs were read before refreshing the checkpoint:

- Rollup config/extras: upstream app/locale preloads, dark startup background and
  prestarted worker; the resolved CSP still hashes the script and retains the
  fork's development/local-client arguments. Browser development builds disable
  worker prestarting so existing service-worker preparation happens first.
  Model/OCR copying, private handoff/setup and absent browser-auth asset selection
  remain intact.
- Vite config: only the obsolete canonical-locales polyfill alias is removed.
- App i18n: language/dialect helpers for supported correction targets; existing
  translation loaders and fallback behavior remain in place.
- chatsDb: per-instance cached chat/community detail timestamps. Retained
  action-card reconciliation and principal-scoped database behavior are unchanged.
- OpenChat client and worker protocol/implementation: details-last-updated and
  details-synced-up-to requests avoid rebuilding unchanged details; translation
  corrections use the current locale. Original identity bootstrap, passkey flows,
  session persistence, account/backend scope and client-only app guards are intact.

Separate review of the two startup conflict seams is recorded in the regression
without making either file a new dependency owner. `main.ts` retains bounded
browser cleanup before app mounting, model restoration and native layout/routing,
then clears the temporary background after successful or recovery mounting. Its
UTF-8/LF hash is
`ee353591455581bda225592981fbc9ec9f0f56641c50fe9b070d6f84f0327696`.
`workerAgent.ts` consumes and clears the prestarted worker inside the existing
guarded constructor; reversing only that addition reproduces its previous source
exactly. Watchdogs, fatal callbacks, policy enforcement and payload-safe logging
are unchanged. Its hash is
`e6542c4c3900ac708aa7d3df2a9f2f038e41b40cda3e6682d6da71d50274e5a6`.
Focused worker/original-auth suites pass **75/75**, including both constructed and
prestarted worker failure paths. This is not provider or device execution.

The mobile error-translation file and its exact two-line reversal are unchanged.
The regression retains both original file hashes and full `425a64c8` / `09b7e91e`
aggregate identities: only the eight pre-merge file hashes, independently read
from `77346e24c`, are substituted when reconstructing those historical snapshots.
All other hashes still come from live source; a separate assertion binds the new
live aggregate. No historical snapshot is rewritten or represented as new source.

Upstream's package/lock changes include `svelte-i18n` 3.7.4 and its esbuild edge;
esbuild already belongs to the reviewed root set. Fresh locked collection and any
advisory/license decisions are separate from this source-only checkpoint. This
review does not change advisory deferrals, historical PR policies, native/Rust
records, model prompts, backend code, app-specific business logic or APK015 evidence.

Verification with pinned Node **24.18.1**: all **150/150** tests in the five offline
npm contract suites pass with zero failures/skips, and the current source gate
reports the new aggregate and unchanged counts above with advisory acceptance
explicitly false. Temporary files and logs remain under `F:/Temp/OpenChat-IOU`.

## Windows startup module-ID checkpoint (2026-09-30)

The reviewed current aggregate is
`f987610e19dd0790765bbe2209b109c7a987d10d09f082a0400e702efca5c67d`.
Against committed merge `28cda7221d920557664249cb71e2f4a6670a9996`, only
`frontend/app/rollup.extras.mjs` changes among the fingerprinted production files.
Its strict UTF-8/LF SHA256 changes from
`ed9641516ca65a821c6b4a5f4bcae1e51449be786d1ddbed04fdc2b2d7e32203` to
`22bf93228b94a0cf4666eade3ca004278dc351fdfddc8937a69a86a11c3d5658`.

The real optimized web build failed because upstream startup preload discovery
matched only slash-separated locale IDs. An independent in-memory Rollup 4.61.1
build with the installed JSON plugin and actual English catalog returned a native
Windows backslash-separated module ID: the previous expression found no locale,
while separator normalization found `en`. No generated bundle was written or
application code executed by that isolated check; it required no network access.

The repair normalizes separators at exactly two comparisons: App component roots
and locale IDs. It does not change manual chunks, generated startup behavior,
CSP policy, development-browser worker ordering, authentication, models, prompts,
private apps or business logic. Regression fixtures cover Windows and mixed IDs.
The new source contract reverses only those comparisons and their explanatory
comment to reproduce the committed file hash and full `3e5e911f` aggregate.
Existing exact mobile translation proofs and earlier checkpoints remain intact.

Counts remain **119 dedicated owners, 148 fingerprinted sources, 25 dependency
roots and 86 ownership anchors**. Selectors, root lists, package/lock identities,
historical PR policies and advisory decisions are unchanged. This is a bounded
startup-build source review, not a core audit, advisory waiver, completed web
artifact qualification, APK rebuild, provider/DAL test or deployment approval.

Verification with pinned Node **24.18.1**: the current source gate reports the
aggregate and unchanged counts above; the same five offline npm contract suites
pass **151/151**, with no failed, skipped or cancelled tests. The exact-reversal
test is additive; no preceding test expectation or enforcement rule is waived.

## Encrypted private delivery and local card recovery checkpoint (2026-10-01)

The reviewed source aggregate is
`84f4494dc4a493fa56ac72f31a10c9a0055ab06ae493e4e073b2e4c30d590e08`.
It binds committed fork `6249be2431cdae3c4b9fd61b44aa186e223121e6` plus the
approved, still-uncommitted encrypted-handoff and draft-recovery source. It does
not claim a clean checkout or include the two separately pending Android
diagnostic tools in runtime ownership. Counts are **122 dedicated owners, 151
fingerprinted sources, 25 dependency roots and 86 exact anchors**. Selectors,
root sets, advisory rules, deferrals and historical PR records are unchanged.

Compared with committed checkpoint `07aa47ba`, 14 existing inputs change and
three modules are newly selected by the existing `localApp*` rule:

- `localAppDraftPresentation.ts`: bounded immutable, app-declared enum labels;
  exact scalar values, required validation and choice/default behavior remain.
- `localAppEncryption.ts`: authenticated-connect recipient key/context binding,
  P-256 ECDH, HKDF-SHA256 and AES-256-GCM through built-in Web Crypto. A fresh
  ephemeral key, salt and IV are generated for every send. Routing, app revision,
  import ID and recipient key/context are authenticated. Only the encrypted
  envelope reaches BroadcastChannel, native IPC, loopback and app postMessage;
  no plaintext payload or recipient label is in those wire objects. Public
  routing metadata remains visible. This is recipient confidentiality, not
  sender authentication or backend attestation.
- `localAppDraftPersistence.ts`: bounded account/backend-scoped IndexedDB storage
  with a nonextractable AES-GCM key, fresh IV and authenticated generation and
  record revision. Atomic compare-and-write rejects both stale writes after
  Forget and stale-tab edits after another tab marks the request attempted.
  Same-origin code can still use the stored key; this is not XSS isolation.

Catalog, public-directory, editor/workspace and both delivery paths were reviewed
with these owners. The public directory rejects private recipient keys. The
workspace durably records possible dispatch before either adapter releases an
encrypted request. Recovery keeps the exact request, schema, destination and
idempotency key, restores neither approval nor transport state, protects manual
values, never auto-sends, and blocks changed app configuration. The separate
setup store continues to exclude drafts and approvals. No app-specific business
logic or new package import is introduced.

The other three changed mixed inputs are the OpenChat client and worker protocol/
implementation: upstream `a4cc691e` adds swap token/amount fields and tipping
metadata/routing. Existing auth/session and unofficial policy guards remain
intact; their unrelated core dependency imports are not selected or accepted by
this source review. Model assets, runtime choices and prompts are unchanged.

The exact mobile error-translation reversal and Windows startup-path reversal
remain checked against their original file and aggregate hashes. Their September
148-file inputs are reconstructed using only the 14 independently read `07aa47ba`
pre-extension hashes and omission of the three later files. Unchanged inputs
remain live; the separate current fingerprint binds all 151 current inputs.
No historical snapshot is relabelled as current or silently rehashed.

Native envelope tests compile the two actual Rust handoff modules on Windows
with offline canonical-lock package identities: **18/18 pass**, including actual
loopback claim/dispatch/origin/lifecycle tests and plaintext/malformed-envelope
rejection. This is not Android packaging, provider qualification or a rebuilt
APK. Dependency collection, advisory acceptance, hosted CI and release acceptance
remain separate gates; this checkpoint performs no core audit or waiver.

## October 2 upstream merge and card presentation

This source-only review binds merged main `bb2a8d712bdac6f59c183951e453bc0e18bb64bb`
(upstream `944efe4a7`) plus the reviewed card-presentation worktree. The aggregate is
`166cb8127e259451ac0041463ca814a941322ed5cf11894a990cbe0df7fe264d`.
The source set remains **122 dedicated modules, 151 fingerprinted files, 25 npm
roots and 86 exact ownership anchors**. No selector, root, import-denial rule or
historical PR inventory changes.

The preceding aggregate `68f06f6f5cf986b836f570e42102cf68125e425b08469a41a0073997c6c2cd42`
was independently reproduced from all 151 Git blobs in committed parent
`240007855dbec16b77bc532a78dc121a75ad058d`. Only eight fingerprinted inputs differ:

- The three `PrivateApp` Svelte components and `localAppDraftPresentation.ts`
  implement app-owned labels/order, bounded text/date/multiline controls and
  nonrestrictive suggestions. Schema enums and named-choice IDs stay exact.
  Additional fields remain visible; raw JSON is secondary, not discarded.
  Malformed supplied dates remain text and block review. Destination/recipient
  review, explicit delivery consent and the encrypted transport boundary remain.
  Their new imports are relative helpers and the existing Svelte root only.
- The anchored `chatsDb.ts`, OpenChat client, worker protocol and worker dispatch
  adopt upstream details cache version 153, member paging/search, access-gate
  payment dispatch, mention/preview refresh and operator migration requests.
  Their mixed core imports are not new feature owners. Original auth, client-only
  app guards, private persistence and model/prompt sources remain unchanged.

The regression reconstructs the preceding aggregate using only the eight exact
parent hashes. The earlier cache-yield, immutable-asset routing and September
proofs retain their original hashes; all unchanged inputs remain live. Separate
current-source assertions and per-file drift/import tests prevent these historical
substitutions from accepting an unreviewed current change. Frontend manifests and
the npm lockfile are unchanged by this merge and presentation update.

The parallel native review still has **26 seeds, eight profiles and 28 sources**.
Only the workspace `Cargo.toml` source pin changes: upstream registers the backend
`chat_rooms` package and its development optimization. The new normalized Cargo
lock hash is `838a61f0d25f13fa92fd1d118a139d2cd00c2dfbcf625949e45a8f589e5f3ae4`.
Its changes are one new local package block and dependency links in four other
backend-local blocks. Exact reversal reproduces the prior manifest and lock
hashes. A conservative lock-graph traversal from the existing 26 seeds finds the
same 512 package blocks, including their dependency edges, with aggregate
`eab474e68deb86860dafb04295ffa864cb9d5c8714983b2131880f7a853b9f34`.
This is not a target/feature-filtered Cargo collection or a refreshed SBOM.
Native source, dependency identities, profiles and historical PR2 records remain
unchanged; the source-review receipt is rebound to the current inventory bytes.

This refresh runs offline contract tests only. It does not perform an advisory
query, install packages, waive failures, audit OpenChat core, deploy, or establish
model accuracy, browser/APK acceptance or release readiness. Existing advisory
decisions and their separate gates remain in force.

## October 2 card collection and proposal entry points

This source-only checkpoint binds main
`5a36a3c22bf53b4111824606ec51b23c8c3e80ee` plus the frozen card-collection and
bounded-control changes. Its aggregate is
`8cc7a0ec5387cc68d875eb71e10f54e60efdf07c4ac020cbf9e23650954554a9`:
**153 fingerprinted files, 88 exact anchors, 122 dedicated modules and 25 npm
roots**. The two additional files are the desktop/mobile `ChatMessage.svelte`
proposal entry points. Their captured-message anchors belong to the existing
Svelte root; neither becomes a dedicated owner or subjects unrelated core imports
to scanning. Dedicated selectors and import-denial rules are unchanged.

Six previously fingerprinted feature files change:

- `localAppDraftPersistence.ts` and `privateAppWorkspace.ts` retain up to eight
  encrypted private cards, migrate version-one single-card records, bind saved
  app presentation to the original target/schema, and retain bounded host-only
  source references. Generation/revision compare-and-write and captured read
  observations reject stale writes, including writes queued before a refresh.
  Recovery grants no consent or automatic handoff; corrupt or full collections
  do not silently replace retained cards.
- `localAppDrafts.ts` and `PrivateAppsWorkspace.svelte` revoke consent when cards
  change, retain attempted requests and import IDs, expose saved-card selection,
  and distinguish selected-card Discard from account-wide Forget. Forget remains
  available with retained cards, but cannot interrupt their active work or
  loading. Setup persistence remains separate from card/delivery state.
- `localAppDrafts.ts`, `localAppDraftPresentation.ts` and
  `PrivateAppDraftFields.svelte` add only generic bounded ASCII-range string
  constraints and nonrestrictive select hints. The host never executes app regex
  code or names app-specific fields. Supplied values stay exact; suggestions do
  not override final schema validation.

The two mixed chat entry points preserve the captured chat/message/thread
identity when proposing and use the card-preserving selection method. The source
reference is local navigation/deduplication metadata, not an outgoing app field.
The reviewed files add only relative helpers and existing Svelte imports.

All 151 committed Git blobs independently reproduce both the `166cb8127` source
checkpoint above and the earlier `68f06f6f` checkpoint from
`240007855dbec16b77bc532a78dc121a75ad058d`. Historical tests exclude only the two
newly tracked paths, substitute the six verified pre-collection hashes and retain
the earlier eight pre-merge substitutions where applicable. The original
151-file and September 148-file aggregate identities are unchanged. Separate
current-source tests reject drift/removal in all six owners and both entry
points, changed/missing anchors, and new unreviewed dedicated imports. The setup
snapshot test follows the extracted private selection helper instead of assuming
that the public wrapper still writes setup directly.

This is source ownership and identity verification only. No dependency root,
manifest/lockfile, historical PR inventory, advisory decision or model/prompt
changes; no audit, network request, installation, build, deployment or native
acceptance is performed or implied by this refresh.

Verification with pinned Node 24.18.1: all **158/158** tests in the same five
offline npm contract suites pass, with zero failures, skips or cancellations.
The initial stale-source run failed ten of 65 seed-review tests; its source
identity and selection-delegation failures were repaired rather than waived.

## October 2 saved card source navigation

This source review binds main
`49450039825edaa2bade427e2525696a7c5d9d22` plus the source-navigation changes.
The aggregate is
`a52d271ac945ba6ebd5971f10ca94d256db981fac53979542cbed8377025e4d9`:
**158 fingerprinted files, 123 dedicated owners, 96 exact anchors and 26 roots**.

Five existing files change: both proposal entry points capture the host chat kind
and message index; persistence validates these optional values; the workspace
backfills missing location only for the same retained source; and the card UI
shows host-owned labels and guarded source links. Navigation revokes approval,
including approval of recovered uncertain or delivered requests. Source metadata
does not enter the encrypted delivery payload.

The new helper uses the actual `chatIdentifierToString` format and the existing
route builders. It validates principals, chat kind, safe nonnegative indices and
canonical roundtrip. A legacy channel key can identify its channel; a legacy bare
principal cannot distinguish a direct chat from a group and produces no guessed
link. Message IDs are never interpreted as message indices.

The shared chat, routes and string helpers, and the existing app navigation
module, receive exact function/import/call anchors. They remain mixed sources,
not dedicated owners subject to unrelated core import scanning. The navigation
call reaches the already declared `page` dependency through the normal router.
Current-client therefore adds that exact root: manifest `^1.3.7`, locked version
`1.11.6`. No package or lockfile changes, installation, historical PR root changes
or advisory acceptance are included.

All 153 committed source blobs independently reproduce the preceding `8cc7a0ec`
aggregate. Historical tests omit only the five newly tracked paths and substitute
the five independently verified pre-navigation hashes where needed. Earlier
151-file and 148-file proofs retain their exact identities. Separate current
checks cover drift, missing files, changed anchors and removal of the reached
router root. The dedicated-source import denial remains unchanged.

With pinned Node 24.18.1, the five offline npm contract suites pass **166/166**
with no failures, skips or cancellations. The source gate reports the aggregate
above with advisory acceptance explicitly false; all four changed review files
pass the existing formatter. This checkpoint records source ownership only,
not advisory, browser, APK, provider, model-quality or release acceptance.

## October 2 main Apps flow, retained cards and startup completion

This superseding source-only checkpoint binds committed fork
`7a95466f1dd34220b4e8fe78f0210f2a53810d46` plus the frozen main Apps/card-host
and startup-completion working tree. Its aggregate is
`83d70d96f0b74618f59ef52327f2d3bf104a2895231e686f9557cb9e068a5b14`:
**171 fingerprinted files, 123 dedicated owners, 108 exact anchors and the
unchanged 26 npm roots**.

The technical `PrivateAppsWorkspace.svelte` management page is removed. The
replacement `LocalAppCards.svelte` is a card-only host: it retains saved-card
selection, schema-driven fields, review/approval, retry and guarded source
navigation, but exposes no setup import, directory management or Forget panel.
Desktop and mobile App roots mount that host only for the unofficial client.
The normal Apps menu/settings entries now route to the existing Explore Apps
surface. `LocalAppDirectory.svelte` adapts public and connected local entries to
the existing desktop/mobile app cards, modal and sheet; both Explore variants,
both My Apps variants and their reached renderers are exact anchored mixed UI.
The app-owned presentation helper is the only new selector-matched dedicated
owner. A visible Saved cards control reopens retained encrypted cards, including
disconnected or legacy cards, without model inference. Navigation invalidates
review and closes the host without deleting cards; missing proposal selection
routes to Apps rather than opening an empty technical panel.

The workspace changes preserve the explicit approval boundary and encrypted
device-local collection. Connecting or disconnecting setup does not discard
cards, restore consent or send a request. Source references remain host-only and
do not enter delivery DTOs. Existing per-chat enablement remains the selectable
action path. No OpenChat backend/canister, app credential, model asset, model
prompt, package manifest or lockfile changes are included by this receipt.

The startup portion is narrow. `getCurrentUser` now rejects a cache miss while
offline instead of leaving its stream unresolved. The existing IndexedDB
connection manager reports a fixed cache-unavailable error after a bounded open,
does not delete the database, avoids retry flooding while an uncancellable open
is pending, closes a late stale handle, and preserves version-change cleanup.
These reached core files are fingerprinted by exact anchors only; this does not
expand their unrelated import ownership or constitute a broader core audit.

Relative to the preceding source-navigation checkpoint, fourteen paths are newly
reached, the deleted workspace path is removed and ten prior inputs have new
bytes. The regression independently reconstructs the prior **158-file**
`a52d271ac945ba6ebd5971f10ca94d256db981fac53979542cbed8377025e4d9`
aggregate using its committed blob identities. All earlier 153/151/148-file
proofs and historical records remain unchanged. Selectors, direct-import
denials, dependency roots, exclusions and advisory decisions are not relaxed.

Local evidence is separate from the source receipt: the focused seed-review
suite passes **77/77**; the supplied combined feature suites pass **418/418**;
the Svelte check reports zero errors (572 existing warnings across 211 files),
and the OpenChat agent TypeScript check passes. These are local checks only.
This checkpoint does not claim live browser, phone, APK/provider, hosted,
deployment or release acceptance.

## October 2 upstream replica-port integration

The pending merge of pinned upstream `5ca61b627809807b5c29300a46d539567249f1cd`
into committed main `33888e4f58f6b9374c3b7250dd564138acb5ca0b` has source aggregate
`7e72d8ee0dbb5bd42a8ee8546f4c21a6f992a8c10c4f83a7d5959198144774cd`.
All 171 committed Git blobs independently reproduce the preceding `83d70d96`
checkpoint. Only Rollup config, Vite config and the OpenChat client's local
metrics URL change within that source set. The optional replica port retains
its 8080/default-network behavior; the fork model proxy, forwarded-header
removal, original auth/startup, normal Apps UI, encrypted cards/delivery and
official-backend profile remain intact. Exact three-file reversal tests retain
the earlier aggregate and all historical checkpoint proofs.

Counts remain 171 sources, 123 dedicated owners, 108 anchors and 26 roots.
There is no selector, import-ownership or advisory-policy expansion. The
upstream devalue 5.9.4 lock change requires separate installed-dependency and
security evidence; this source checkpoint supplies neither. The guarded local
canister deployment wrapper deliberately stays byte-identical with its trusted
SHA requirement and fixed port 8080, rather than adopting the unguarded stock
wrapper call. No deployment is performed or authorized by this review.

The current formatter baseline advances to that same upstream commit. Its ten
remaining exceptions retain identical source/edit proofs; the now fully
formatted MainMenu no longer has a current exception. Historical formatter and
PR inventories remain unchanged. This is source/inventory evidence only, not
frontend, artifact, browser/device, advisory or release acceptance.

## October 2 saved-card opt-in and recovery feedback

This source-only checkpoint binds committed main
`064eda188571f9cfc962b98d48842d83c51bdbd2` plus the three reviewed generic
UI/controller changes. Its aggregate is
`86b7835254837140bd452b4a0f722cbfd207d1ad15d5f6c7b9b66757e0e11dbc`.
Counts remain **171 fingerprinted sources, 123 dedicated owners, 108 exact
anchors and 26 dependency roots**; no path, selector or dependency is added.

`LocalAppsChatSettings.svelte` permits per-chat app opt-in changes while a
finished private card is retained, preserving loading and busy restrictions.
`privateAppWorkspace.ts` permits the corresponding opt-in persistence path and
publishes fixed host-authored feedback when the saved card's original app target
does not match the connected setup. `LocalAppCards.svelte` shows this reason and
disables editing, review, sending and retrying for that mismatch. Existing
target matching, exact saved requests, encryption, approval and write-ahead
persistence remain authoritative; no setup is rebound, card discarded or
delivery initiated by this change.

All 171 committed Git blobs independently reproduce the preceding `7e72d8ee`
aggregate. The regression binds the three new LF hashes and substitutes only
their independently verified pre-change hashes to retain that checkpoint and
the older historical proofs. Test-only fixture edits do not enter the runtime
fingerprint. Source ownership and advisory acceptance remain separate: no
package/lock, auth, model/prompt, backend/canister, advisory rule or historical
policy change is included, and this record does not claim artifact, live
browser/device/provider, model-quality or release acceptance.
