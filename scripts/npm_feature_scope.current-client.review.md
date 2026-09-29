# Current unofficial-client npm source ownership

Reviewed 2026-09-29. This is a **direct-feature ownership review**, not an
advisory waiver, whole-core audit, runtime/phone qualification, or release approval.
The separate current composition is `current-client-npm`; its CLI selector is
`--scope current-client`. Historical PR1/PR2 configs, source snapshots and advisory
decisions remain unchanged and are not reused as current-source acceptance.

## Source boundary

The current gate fingerprints 98 dedicated production modules plus exact ownership
evidence in necessary shared consumers: 115 unique files. CRLF-to-LF normalization
is the only source normalization. The recorded aggregate is
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
