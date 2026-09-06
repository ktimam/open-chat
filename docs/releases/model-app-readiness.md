# Model and app integration: PR and release readiness

Assessment: 2026-09-06. **Prepared for continued draft review; not ready for a production release.**
No PR, release, PR branch base, production switch, signing key, or deployed service was changed
by this preparation. Preparation commits belong on the integration branch, not either stale PR head.

## Current delivery scope: source preparation and local-test APK

The developer requested a locally testable APK, **not the publisher's signed release APK**.
Use the existing configured local signing identity, local backend/origin and OTA-disabled
all-WebGPU build. Do not require a new publishing keystore, distribution-service credentials
or a publishing versionCode to produce that local test artifact. The publishing-only checklist
below remains guidance for the eventual publisher; it is not a prerequisite for local testing.
Local APK acceptance still requires checking bundled assets, application/account identity,
startup and the model flows. Neither local signing nor successful unit tests proves production
deployment or physical-device GPU acceptance.

## Source and submission state

The published integration checkpoint is `2029f00d726ca7c33de22c53c24cf1ada173d3fb`
on `codex/pr2-clean-integration`, tagged `model-integration-checkpoint-2026-09-05`.
The lint cleanup, compatible dependency updates, portable security hashes, CI coverage,
Android release safeguards and this preparation package follow that immutable checkpoint.
Use the preparation commit SHA for further validation; never move the checkpoint tag.
The APK preparation source assessed here is `e02bd70d4017b92f534f03ad50712ae7729227b3`.
The local-test APK below contains that preparation's frontend/native source. Subsequent
backend CI repairs are separate checkpoints and require their own exact-commit checks;
they do not change this APK's frontend or native runtime.

| Submission | Observed head | Base | State |
| --- | --- | --- | --- |
| [Upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132) | `codex/pr1-local-models`, `045f7132e` | upstream `master` | Draft; no reported check runs |
| [Fork PR #73](https://github.com/ktimam/open-chat/pull/73) | `codex/pr2-app-chat-interfaces`, `c7299aa11` | `codex/pr1-local-models` | Draft; no reported check runs |
| APK preparation source | `codex/pr2-clean-integration`, `e02bd70d4` | descends from both heads above | Not either PR's current head |

The integration checkpoint is 16 commits / 115 changed files beyond PR #73's head.
Those commits mix later model-runtime fixes and app-interface fixes. It is 60 commits beyond
PR #9132's head. Do not present this checkpoint as a PR2-only refresh without separating scope.
Upstream `master` was `fb7c34bcc453e04480a36b4c5882cf63f362efbd` at assessment:
the checkpoint and upstream have 98 and 124 unique commits respectively. Re-check these refs
before any rebase or publication; conflict resolution against current upstream is not verified.

## Preserve the two-PR structure

1. Refresh PR1 with generic model catalog/runtime, installation/cache, optional audio,
   native bridge, model settings and their tests. Keep third-party app structures out.
2. Refresh PR2 on the resulting PR1 head with manifests, registered processing surfaces,
   cards, scoped linking/private context, attestation, confirmation and inbox delivery.
3. Review mixed files such as inference routing, message menus, startup and native identity
   by hunk and dependency. Do not blindly cherry-pick all 16 integration commits into either PR.
4. Validate each resulting head independently, then validate the combined stack. Retarget
   PR2 to upstream `master` only after PR1 integration is agreed with maintainers.
5. Update existing PR descriptions rather than create duplicate submissions. Prepared bodies:
   [PR1](pr1-local-models.md) and [PR2](pr2-app-interfaces.md).

The [stack refresh plan](pr-stack-refresh-plan.md) identifies mixed areas and an append-only
refresh sequence. An isolated PR1 refresh has started with generic ZIP packaging only; the
model/app scope split is not complete and neither published PR head has changed.

This is a proposed publishing sequence, not an executed history rewrite. Keep the checkpoint
tag available for comparison; do not move it to a rebased or lint-cleaned head.

## Verification actually completed

Results below use isolated integration source plus the current fixes and exact updated
frontend lockfile, not refreshed PR1/PR2 heads. The production web build was run; no signed
shipping APK was built or accepted.

The local-test ARM64 APK was subsequently built and installed over the emulator's existing
package without uninstalling or clearing data. It is 82,954,970 bytes, SHA-256
`05239e790f1b5b69b89dad761b81322a82b157dabf5fa39032af910bdb9e4070`, with the existing
local Android debug certificate and `com.oc.app` identity (native version `0.1.0`, code `1000`).
The running APK serves frontend version `2.0.0-local-webgpu-20260906-142434` and OTA policy
`none`. Its 26 served runtime/graph/notice assets match the built hashes; the actual WebView
imports ORT, compiles the pinned WASM and receives acknowledgement from its packaged worker.
The v2 onboarding UI renders. The emulator is at sign-in, so authenticated model settings,
account linking and model proposals were not verified. This artifact is not publisher-signed
and was not uploaded. Kotlin's cross-drive incremental-cache failure recovered using its
ordinary full-compilation fallback; the overall build and fresh-artifact checks passed.

| Check | Result |
| --- | --- |
| Full frontend unit tests | 127 files / 1,783 passed with four workers; unchanged assertions/timeouts and zero skipped tests |
| Svelte typecheck | 0 errors; 564 warnings in 205 files |
| Agent TypeScript check | Passed |
| Read-only ESLint | 0 errors; 31 existing warnings (26 errors corrected) |
| Frozen isolated dependency install | Passed; model/ONNX/OCR runtime lock entries unchanged |
| Release/CI/digest/format/preflight/archive/notice tests | 147 passed, zero skipped |
| Production WebGPU candidate build | Passed in 2m55.5s with the final frozen dependency tree, explicit immutable-delivery contract and real public-key query; both store/full OTA ZIPs produced |
| Built WebGPU payload | 26 exact assets verified: worker, ORT pair, two Qwen graphs and 21 notices/sidecars; this is packaging evidence, not inference |
| Built module browser smoke | Chrome 152.0.7977.76 imports actual ORT JS, compiles pinned WASM and receives disposal acknowledgement from the compiled worker under the built CSP; no model inference or full-app UI claim |
| Immutable download endpoints | 52/52 public HEAD checks passed: 26 unbundled base/audio files × web/APK origins, expected lengths and CORS headers; no body-hash or browser-enforcement claim |
| Actual OTA ZIP round trip | 3 tests passed on Windows; corrected UTF-8 archive also extracted with Android's actual `zip@2.4.2` dependency, preserving six files' exact names and bytes |
| Diff whitespace check | Passed |
| App/host boundary audit | 5,137 text files / no findings; rerun after any scope split |
| Hosted checks on existing PRs | None reported; not a pass |
| Affected backend Rust packages | 57 tests passed, 1 existing ignored test; strict Clippy and workspace formatting passed |
| Hosted native model checks on `e02bd70d4` | Linux and Windows hermetic tests and both feature builds passed; separate pinned native CPU model inference passed |
| Signed shipping APK / production rollout | Not built or performed |

### Latest hosted checks: exact `e02bd70d4`

- [Frontend](https://github.com/ktimam/open-chat/actions/runs/34031336098): passed the
  complete frontend pipeline and the separate opt-in production WebGPU candidate build and
  asset verification, using Node `24.18.1` and repository-pinned `dfx@0.31.0-beta.1`.
- [Model checks](https://github.com/ktimam/open-chat/actions/runs/34031336128): frontend
  model contracts, Windows/Linux native tests and feature builds, and actual inference with
  the pinned 14 MB native CPU fixture all passed. That CPU fixture is not phone WebGPU proof.
  The dependency job failed on changed reviewed digests and the expired baseline after
  successfully checking formatting; its later Rust/license/SBOM steps were skipped.
- [Backend](https://github.com/ktimam/open-chat/actions/runs/34031336096): failed strict
  Clippy and unit-test compilation. The failures include chat-event lint violations and an
  unreachable duplicate action-card permission arm. These are genuine source failures;
  frontend success does not cover them. Repairs must pass a new exact-commit run.
- [App security](https://github.com/ktimam/open-chat/actions/runs/34031336108): failed
  review expiry, reviewed dependency drift and unreviewed native manifests. Fresh npm audits
  in this run reported two moderate findings and no high/critical findings in both scopes;
  the moderate count exceeds the old policy's one-finding allowance. No allowance was raised.

Local backend follow-up repairs the duplicate permission arm, adds exhaustive provenance and
role tests, applies narrow documented lint expectations to existing public API representations,
and boxes only three private prepared-deposit payloads. The affected chat-events, group-chat,
group, community and user targets pass 146 tests and focused strict Clippy. A further mechanical
inbox cleanup preserves cursor iteration and replaces test-only temporary vectors; its 60
tests pass, bringing the focused total to 206. The full Windows
workspace Clippy attempt stops at the local Cygwin-Perl/MSVC OpenSSL build incompatibility;
that is not a source pass. Further targeted checks expose additional lint failures in the
user-index, group-index and local-user-index implementations. These remain outstanding; the
first repaired targets do not establish full backend acceptance. Public wire payloads and
card-authorization requirements are unchanged by this repair batch.

### Earlier build failures and their repairs

Hosted checks on `808a75d3e` exposed failures that unit tests did not cover:

- [Frontend run](https://github.com/ktimam/open-chat/actions/runs/33994920416):
  unit, type and lint checks passed; the production bundle failed because `dfx` was absent.
  Both frontend and Android CI now install the repository-pinned `dfx` version using the
  immutable official setup action. The real public-key query is retained, not replaced with a fixture.
- [Backend run](https://github.com/ktimam/open-chat/actions/runs/33994920435):
  fixed formatting, an equivalent derived `Default`, and deprecated fixed-array conversions.
  The affected packages passed local strict tests; the subsequent complete hosted run exposed
  the additional backend failures recorded above.
- [Model security run](https://github.com/ktimam/open-chat/actions/runs/33994920417)
  and [app security run](https://github.com/ktimam/open-chat/actions/runs/33994920407):
  security expiry/drift remains a failure. Separately, all 82 source formatting failures were
  corrected with exact Prettier output; all 284 policy candidates including manifests now pass.
  The checker invokes installed Prettier directly in bounded batches so Windows' shell command
  length limit cannot prevent checking large candidate sets. Every batch failure remains fatal.

The local Windows production build passed the real public-key query and Rollup type declarations,
then exposed a missing `zip` executable at OTA packaging. Packaging now uses Windows' built-in
ZIP-capable `bsdtar`, retaining Info-ZIP on Unix, and passes literal arguments without a shell.
The complete typecheck/lint/test/production pipeline then passed with the final dependency tree.
A subsequent UTF-8 charset repair passed a broader Japanese/Arabic filename regression and
Android's actual Rust archive consumer; both real OTA ZIPs were regenerated with that repair.
The browser smoke imports the actual emitted runtime and starts its compiled worker. The pinned
ORT module retains Node-only guarded imports of `module` and `worker_threads`; a blanket claim
that all emitted modules have no bare imports would be incorrect. Optional dependency warnings
alone were not treated as proof of a broken browser bundle. Unix Info-ZIP retains a pre-existing
non-ASCII filename/Rust-reader incompatibility: current public/build payload paths are ASCII,
but qualify non-ASCII paths before introducing them into Unix-built OTA archives.

Earlier physical-phone evidence established all-WebGPU model generation in a local development
APK. Complete partner-app card verification still requires a passing live run. Emulator replay
does not prove physical GPU generation; its WebView had no WebGPU adapter. Do not collapse unit,
replayed integration, real inference and fully rendered/verified card evidence into one pass.
The 2026-09-06 emulator check used WebView 151.0.7922.199 in the running APK: `navigator.gpu`
exists but both default and high-performance adapter requests return null. It cannot prove the all-WebGPU path.

The isolated install used npm `10.8.2` and local Node `24.14.1`. Frontend, Android and security
CI now agree on Node `24.18.1`; the complete hosted frontend checks on `e02bd70d4` passed
under that runtime. Later source changes still require their own validation.
CI uses read-only lint and frozen install, with no ad-hoc Rollup install that mutates the lockfile.
The local Windows production query used installed WSL `dfx@0.27.0`; CI pins the repository's
declared `0.31.0-beta.1`; the hosted frontend run above now passes with that exact toolchain.

## Security gates: blocked

Both [PR1](../../.github/security/openchat-pr1-security-baseline.json) and
[PR2](../../.github/security/openchat-pr2-security-baseline.json) policies expired on
2026-08-31. Current manifests/lockfiles no longer match their reviewed digests. PR2 also reports
unreviewed native Cargo manifests. These failures were observed, not waived.

The cross-platform hash defect is corrected without approving new dependencies: 23 historical
records now hash UTF-8 with CRLF normalized to LF, backed by exact reconstruction of their
original reviewed bytes. The unproven PR2 root Cargo manifest remains byte-exact and fails.
Tests preserve every non-digest policy field, expiry and reviewed file set. Actual content
changes still fail. No expiry extension or advisory waiver was added.

Fresh npm advisory results on 2026-09-06 for published `e02bd70d4`, after the scoped overrides:

| Dependency scope | High | Moderate | Low | Critical |
| --- | --- | --- | --- | --- |
| Production | 0 | 2 | 0 | 0 |
| All | 0 | 2 | 0 | 0 |

The public lockfile was byte-matched to SHA-256
`b68b016ac2d66b72e80a383db020b8b8502a36cb57802d29e72463f0bdc51b01` before the
independent audit. Hosted PR2 checks report the same counts. Both moderate entries arise from
one dependency chain, `@solana/web3.js@1.98.4` → `jayson@4.3.0` → `stream-json@1.9.1`,
and [GHSA-528h-pc64-c93x](https://github.com/uhop/stream-json/security/advisories/GHSA-528h-pc64-c93x).
The advertised patched `stream-json` major is incompatible with the installed parent; an
unverified override is not a fix. An isolated `jayson@4.1.3` downgrade satisfied Solana's
declared range and its Node/browser client checks, but restored parser regressions: malformed
JSON acceptance, missing incomplete-input errors and broken split UTF-8 input. It also retained
the demonstrated nested-prototype mutation. The downgrade was rejected and the current lockfile
retained; `npm audit`'s `fixAvailable` field is not a verified safe remediation. These results
do not close the Rust, license, SBOM or
exact-PR-base dependency review.

Historical npm results for `808a75d3e`, before those scoped overrides:

| Dependency scope | High | Moderate | Low | Critical |
| --- | --- | --- | --- | --- |
| Production | 5 | 3 | 0 | 0 |
| All | 5 | 6 | 0 | 0 |

Compatible updates reduced the all-dependency total from 20 to 11 in this audit snapshot.
Tiptap is locked to 3.31.3 and DOMPurify to 3.4.14, above their patched minimums;
see the [Tiptap fix](https://github.com/ueberdosis/tiptap/releases/tag/v3.30.4) and
[DOMPurify advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-55q2-fjhq-7xh7).
At that snapshot, remaining chains included Coinbase SDK/axios, Transformers/ONNX Node/adm-zip,
Transformers/sharp, jayson/stream-json and rollup-styles/query-string/decoder.
The local follow-up now pins only the reviewed Coinbase SDK `1.52.0`'s Axios to `1.18.1`.
An offline test against the actual installed SDK verifies signed request paths, BigInt serialization,
headers, responses, error mapping and retry integration, with an ephemeral key and no requests.
The compatibility check runs in frontend CI and requires reassessment if the SDK version changes.
The `query-string@8.2.0` decoder is separately pinned to `decode-uri-component@0.5.0` after
275 decoding cases, actual query-string option checks and a bounded malformed-input regression.
The repeatable installed-tree test is also in CI. Further scoped overrides now select
`adm-zip@0.6.0` only under `onnxruntime-node@1.24.3` and `sharp@0.35.3` only under
`@huggingface/transformers@4.2.0`. The actual ONNX installer passes 11 extraction/copy/cleanup
and bounded-allocation checks using an offline NuGet fixture. The actual Transformers Node
image helper passes 42 checks across image formats, channels, resampling, crop and padding;
24 independent old/new pixel-hash comparisons are identical. The frozen install retains all
optional packages, including cross-platform native wrappers. No model, ONNX or OCR runtime
version was changed. A `stream-json@3` override was rejected because the current `jayson`
parent requires incompatible CommonJS subpaths. Its Node TCP/CLI parser also reproduces
inherited-property injection; browser client reachability differs, which does not remediate the
installed Node package. Both security policies still fail; the older counts are retained
only to explain the remediation, not as the current lockfile audit.
A smaller overall total does not excuse a category increase.
These are dependency findings, not demonstrated browser exploitability. Assess runtime
reachability, especially Node-only transitive dependencies of browser model packages;
remediate or explicitly review residual risk, licenses and lockfile changes before replacing
the baseline. A complete license/SBOM review is also still required.

A fresh official RustSec database (`5a0ebedfe8bdd2e295b171f4162f8c977bcad9a5`, updated
2026-09-02) was fetched into isolated storage without uploading dependency inventory. The
unchanged Cargo lockfile now reports **7 vulnerabilities / 32 warnings**, above the reviewed
5/30 snapshot. New findings include `RUSTSEC-2026-0258` for `h2@0.3.27` and `h2@0.4.15`,
plus yanked `chacha20@0.10.1` and `wnaf@0.14.0`. Do not reuse the earlier stale offline audit
as release evidence. Follow-up fixes update `h2@0.4` to `0.4.16` and `event-listener` to `5.4.2`,
and select the existing DynamoDB SDK's modern default HTTPS client without its unused legacy
TLS feature. This removes the vulnerable old `rustls-webpki` chain. Tests exercise real signed
DynamoDB requests against a local fixture server; strict Clippy passes. The native plugin's
22 tests also pass. Developer telemetry is now an explicit optional Cargo feature; normal and
all-WebGPU Android dependency graphs no longer contain the legacy `h2@0.3` chain. The
existing development opt-in remains available through `npm run mobile` and its tested launcher.

The current lockfile audit with that database and `--no-fetch --no-yanked` reports 3
vulnerabilities, 3 unsound findings and 26 unmaintained findings. Remaining vulnerabilities
are `h2@0.3.27` in explicitly enabled developer tooling and two RSA versions without a patched
range (`0.9.10`, `0.10.0-rc.18`). Optional dependencies remain visible in the lockfile audit;
they were not suppressed. This command does not recheck registry yanks. Residual-risk review
and the expired security policies remain unresolved; no baseline was raised.

Offline Cargo metadata still matches the 19 PR1 introduced and four PR2 direct reviewed
package/license tuples. This is narrower than distribution clearance. The all-WebGPU asset
configuration now emits version-checked Wllama/embedded component notices independently of OCR,
and ORT/Transformers/model notices with the WebGPU payload. Modified Qwen graphs receive adjacent
notice sidecars. Immutable source cards and hashes document Gemma's optional audio and both graph
transform stages; the missing conversion-publisher metadata is stated, not invented. The built
distribution verifier requires the exact runtime, graphs and all 21 notice/sidecar outputs.
These checks establish packaging and attribution coverage, not inference or complete conversion
reproducibility. The stale `open` notice now matches locked `5.4.1`.

Frontend, backend and model/app security workflows now include the stacked PR base and
integration pushes, with regression tests for that routing. These changes are not on the
two older PR heads yet. Candid and broader integration workflows still need coordinated
validation on the final stack; private/custom-runner jobs were not enabled blindly.
Absence of hosted check runs must not be reported as success.

## Publisher-only shipping guidance: not a local APK prerequisite

The developer will not build or publish the actual distribution APK. The signing, release
version, upload and rollout items in this section are handoff guidance for its publisher,
not outstanding requests for the developer's credentials or barriers to using the local APK.
Source/PR review and physical-device testing remain separate from APK publication.

- [All-WebGPU feature gating](../../frontend/app/transformersWebGpuFeatureFlag.mjs) retains
  development + local network + explicit opt-in. A separate production candidate contract,
  `OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY=immutable-hub-v1`, uses immutable Hub weight URLs
  and same-origin packaged Qwen graphs, ORT and worker. The development flag alone still
  cannot enable production. CI separately builds and verifies this candidate; that does not
  activate the shipping workflow or substitute for device/cache/CORS acceptance.
- [App capability gates](../../frontend/app/rollup.config.mjs) deliberately disable unfinished
  app-card features in production/testnet. Keep these security brakes until backend rollout
  and authorization acceptance are complete; frontend flags are not backend authority.
- [Android release workflow](../../.github/workflows/android_release.yaml) now accepts only
  exact `vX.Y.Z-android` tags or explicit manual version/code inputs. It requires successful
  frontend, backend and both security workflows for the exact checked-out SHA before building
  and again before uploading. Missing, failed, queued, skipped, truncated, wrong-source or
  PR synthetic-merge evidence is rejected; workflow paths and individual jobs are checked.
  It uses read-only [GitHub Actions evidence](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
  not display-name matching. Old immutable tags still contain their old workflow:
  **do not publish the checkpoint tag as a GitHub Release**.
- That workflow builds native `inference` / `inference,store`, not the tested local
  `transformers-webgpu-android` path. Select and validate the intended shipping runtime first.
- CI now requires configured release signing and a pinned certificate for manual and published
  artifacts; no temporary/debug-key fallback. Local developer signing is unchanged. Actual
  release key configuration and application-link identity still require verification.
- Explicit native version/code overrides are supplied to both Tauri builds and inspected in
  the APK alongside application ID and certificate. Patch versions above 999 are supported.
  Configure `ANDROID_RELEASE_VERSION_CODE` for published releases and verify monotonicity
  against the last distributed artifact; no code is inferred from a guessed semver formula.
- Android CI and Gradle now pin NDK `26.1.10909125` and build-tools `35.0.0`, matching
  the inspected local APK's native build note and Gradle execution history. APK verification
  requires that exact build-tools version. The existing Gradle `8.14.4` distribution has its
  [official SHA-256](https://gradle.org/release-checksums/) pinned; `dfx` is `0.31.0-beta.1`.
  These are source/toolchain preparation checks, not a rebuilt signed APK acceptance result.
- Verify production origin, model assets,
  optional audio, application links, account reuse and OTA policy in the final artifact.
- Run actual repeated image proposals and optional voice-message flows on supported hardware,
  including model switching, cached model reuse and explicit disabled/unavailable paths.

Generated APK resources are excluded by the precise root ignore rule. Source model graphs,
manifests and their notices remain tracked. No local account state, private environment file,
test profile, generated APK or signing material belongs in the submission.

## Backend rollout gate

Follow the [app-link security contract](../../architecture/ai-app-link-security.md) and
[ActionInbox rollout requirements](../../backend/canisters/action_inbox/README.md#v4-rollout-compatibility).
Coordinated versioned delivery, signing-key activation and independent consumer pins, inbox
wiring, legacy-queue handling and snapshot/rollback restrictions are separate acceptance gates.
Direct-chat deposits are not currently a supported backend rollout claim. Do not relax these
requirements to obtain a successful UI test.

## Reproduction and next actions

Run from a fresh isolated checkout of each proposed head with its exact dependency lockfile.
Do not reuse the running development server's checkout for a production build.

```sh
cd frontend
npm ci
npm test -- --reporter=dot
npm run typecheck
npm run typecheck:agent
npm run lint:check
cd ..
node --test scripts/pr-ci-policy.test.mjs scripts/security_dependency_hash.test.mjs scripts/android_release_policy.test.mjs scripts/android_release_checks.test.mjs
node --test scripts/release_preflight.test.mjs scripts/android_bundle.test.mjs scripts/frontend_format_check.test.mjs
node scripts/cdp_axios_compatibility.mjs
node scripts/decoder_compatibility.mjs
node scripts/release_preflight.mjs
node scripts/check_openchat_pr1_security.mjs ci npm
node scripts/check_openchat_pr2_security.mjs ci npm
git diff --check
```

The security commands are currently expected to fail; preserve their findings. Run Rust,
license, formatting and SBOM gates with the documented pinned tools after dependency review.
Then run the coordinated backend integration tests and a clean shipping build. Do not update
PR readiness, publish a GitHub Release, upload APKs, enable production features or deploy until
the corresponding gates pass and those actions are explicitly authorized.

`release_preflight.mjs` is an offline inventory, not a release approval command. It checks the
actual immutable model manifests, optional audio separation, source assets, toolchain declarations
and security drift without downloads, signing or deployment. It intentionally returns a nonzero
status while external acceptance remains unverified. Optional version progression inputs must
come from the last actually distributed artifact, not guessed examples.
The report separates `gitHeadRevision` and `worktreeDirty`: it reads current working-tree and
installed asset bytes, not an atomic attestation that every input belongs to the Git commit.
