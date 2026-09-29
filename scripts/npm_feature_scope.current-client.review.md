# Current unofficial-client npm source ownership

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
