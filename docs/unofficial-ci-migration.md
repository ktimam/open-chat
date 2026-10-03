# Current unofficial client CI: replacement coverage

The active product is a single-main frontend using unchanged official OpenChat
services. Historical PR1/PR2 custom-canister contracts are not its release gate.
This migration does not modify backend sources, upstream backend/Candid workflows
or deployment scripts. The separately approved current-client security route and
ownership inventories below preserve historical inventories and advisory decisions.

## Superseded hosted contracts

| Historical hosted suite                            | Why it no longer describes this product                                                                             | Current executable coverage                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/pr-ci-policy.test.mjs`                    | Stacked branches, monolithic CI job and PR2-only backend hardening/temporary-Candid behavior                        | `scripts/unofficial-client-ci.test.mjs`; `check_feature_ci.mjs current-client`; existing model coverage, web-profile and APK contract suites                    |
| `scripts/app_model_integration.test.mjs`           | Requires removed custom-canister integration modules and an ActionInbox backend deployment                          | Unchanged official-backend identity guard; actual client/worker rejection tests; private-draft, local processor and browser/native handoff tests in full Vitest |
| `scripts/message_content_candid_contract.test.mjs` | Requires absent custom ActionCard/AiApp Rust/Candid definitions                                                     | Unchanged upstream backend identity; every unsupported request and new/edited custom-card message rejected by the actual policy before transport                |
| `scripts/upgrade_canister.test.mjs`                | Requires removed custom base-upgrader SHA enforcement and argument semantics; this frontend never deploys canisters | Exact upstream base-script Git identity, plus explicit frozen historical wrapper identities; no deployment or SHA-enforcement acceptance is claimed             |

These old suites remain in Git/source for historical reference; none is counted
as a current pass or silently skipped conditionally. Do not restore custom backend
APIs merely to make their fixtures pass. Upstream's own backend verification is
unchanged and is not replaced by frontend tests.

## Preserved requirements

The frontend gate still installs the frozen dependency graph without implicit
audits, runs non-mutating lint, both typechecks and the complete frontend test
suite, builds the normal client and separate immutable-WebGPU candidate, verifies
emitted bytes, and requires the pinned dfx/public-key prerequisite. Failure of
either split job or change detection fails the final required gate. Policy tests
must execute as commands, not appear only in comments or skipped steps.

The build job additionally packages the actual optimized unofficial-local-web
profile into a fresh `RUNNER_TEMP/openchat-unofficial-web.*` directory, validates
its local-only manifest/relay files, and checks the emitted WebGPU distribution
bytes. It preserves the normal official and opt-in candidate builds. No local
server, APK, model download, deployment or cleanup command is invoked by that
additional step. This is artifact evidence, not browser inference or accuracy.
Changes to `Cargo.lock`, `rust-toolchain.toml`, and `dfx.json` explicitly trigger
the same policy gates.

The client boundary suite executes the real pure request policy, with independent
expected request kinds, before a transport spy. Existing Vitest tests exercise
the actual worker/client handlers and local consent/cancellation/delivery paths.
Source-level call-order and test-discovery contracts complement those runtime
tests; they are not a substitute for them, model accuracy or real-device proof.

`.github/unofficial-client-baseline.json` records the reviewed upstream backend
tree and root Cargo manifest. CI compares those actual Git objects and refuses
local tracked/untracked backend changes, without fetching, building or deploying.
An upstream merge requires review of an explicit baseline update. The additive
native-only Cargo.lock is intentionally outside the exact-upstream identity test.

Only `scripts/upgrade-canister.sh` is identical to that upstream commit. The three
local/prod/prod-test wrappers still contain historical digest validation/forwarding
changes; they are pinned separately, not described as upstream-identical or tested
deployment entrypoints. The old deployment suite remains a historical failing
contract, outside the current frontend release gate. No deployment script is
changed by this migration and no backend-deployment readiness is asserted.

The optional `OC_UNOFFICIAL_CI_REPOSITORY_ROOT` is only for isolated review staging:
the guard requires the same real backend directory and byte-identical guarded
manifest/scripts, then checks that repository's actual Git identities and dirty
state. Missing/unrelated repositories cannot become a skipped or successful gate.
Hosted CI leaves it unset and checks its own checkout.

## Reviewed current-client security composition

Passing this offline client gate is **not** advisory/security-scope acceptance.
Historical model/app security workflows, scopes and deferred inherited advisories
are unchanged. Their old branch routes and custom-backend assumptions are not
retargeted into main scans. The frontend topology mode `current-client` reports
`securityScopeAcceptance: false` and `advisoryAcceptance: false` explicitly.

The September 29 approved mapping adds `unofficial_client_security.yaml` for main
pull requests, pushes, merge queues and explicit dispatch. Its separate
`current-client-security` wiring mode requires the same fail-closed scoped
collectors, offline contracts, formatting and model runtime jobs. This is not
permission for a core OpenChat audit, advisory waiver, automatic deployment or
publication. Historical security-mode requirements remain enforced by their
explicit historical checker modes; current topology is not mislabeled as PR2.

The npm inventory covers 25 source-owned roots and 117 fingerprinted files,
including private drafts, the generic editor, isolated processors and browser/native
handoff, including setup-only account/backend-scoped persistence. There are 99
dedicated modules and 65 mixed/dedicated source anchors; the backend-scope getter
does not make the whole client a dependency root. Browser IndexedDB adds no npm
dependency. The Rust inventory covers 24 source files and 25 direct owner edges across
eight explicit Android/host profiles. Removed custom backend roots are not current
owners. Review receipts and current inventories are separate from historical PR
files; source, lock, graph or profile drift still fails closed.

`check_current_client_licenses.mjs` checks the exact union of current native owner
packages and all 19 retained model license requirements: 39 unique packages. It
requires reviewed lock/source hashes, actual locked offline Cargo metadata, and
notice packaging in both the base and effective local-test APK configuration.
No missing package, changed license, configuration drift or unknown license is
waived. It does not query advisories or assert whole-repository coverage.

Local pure/offline contract passes do not prove hosted collection or advisory
acceptance. Five missing checksum-locked Cargo archives were subsequently prepared;
the actual locked/offline license command now passes. A reviewed current-only
mapping records the existing wrapper `llama-cpp-2` 0.1.150 dependency on
`llama-cpp-sys-2` 0.1.154, validating its archive checksum, selected graph edge and
unchanged license. All 19 model license obligations remain enforced; historical
policies, dependencies and lockfiles are unchanged. No hosted workflow, advisory
query or public release has run for this update.

After explicit approval of the exact formatting command change, the current main
workflow runs `check_current_client_format.mjs --scope current-client`. Historical
commands and registries remain unchanged. The actual current gate passes 442
frontend candidates (12 existing policy exclusions), including live proof for 12
files whose remaining formatter edits are byte-identical to pinned upstream edits.
Repeated identical lines are not used as ambiguous diff anchors. Exact source,
formatter/config identity and duplicate-edit counts are checked, with live proof
recomputation; refreshing only a fingerprint cannot exempt new fork formatting.

Earlier cleanup proved equivalent full formatter output for 94 frontend files.
Three separate source-wiring test fixes allow line wrapping with negative controls.
The later setup-persistence feature is a separate reviewed runtime change, not a
formatting-only claim. The complete frontend suite now passes 4,388 tests; both
typechecks pass with zero errors. The offline scoped CI contract suite passes 749
tests with zero skips. These results do not establish hosted execution, advisory
acceptance, current APK runtime acceptance or whole-release readiness.

Independent review also found that two sequential Windows native compile commands
could mask failure of the first with success of the second. The current workflow
now exits on each nonzero native result. Negative controls require both guards;
the historical workflow remains unchanged. This is failure-handling strengthening,
not a relaxed check or hosted execution result.

## Upstream synchronization checkpoint (2026-09-28)

The client integrates upstream `d1e3712bb9ded3a1c8b652492591b7107333b23e`.
Backend sources, the root Cargo manifest and `dfx.json` match that commit;
the obsolete custom ActionInbox deployment entry is removed. This source merge
does not deploy or upgrade any canister. The local profile permits the retired
AirdropBot to be absent, but continues to require checked-in production IDs for
every live service. Network-blocked tests exercise legacy and indexed MultiUser
request routing through the actual agent, retaining the intended recipient.

Local validation passed both typechecks, non-fixing ESLint (31 warnings), the
45-test local profile/startup suite, and the complete 4,240-test frontend suite
with `vitest run --maxWorkers=4`. No tests were filtered, skipped, or given longer
timeouts. Two default-concurrency runs on a 32-thread host each timed out only
the video-store import test at its existing five-second limit; both failures
remain recorded. Upstream adds a transitive call-bridge/navigation/client import
to this store. The same test passes alone and with the four-worker full suite,
supporting concurrency sensitivity, not proving optimized startup performance.
Neither the test timeout nor the checked-in Vitest configuration was changed.

The release identity baseline was reviewed and updated on September 29 to this
integrated upstream commit. Its backend tree, root Cargo manifest and base
deployment script match the actual upstream Git objects; the three historical
wrapper identities are unchanged. The unmodified identity/transport guard suite
passes 8/8 against that baseline. This does not deploy any canister.

Current-composition model/private-app/native dependency inventories and main
security-workflow routing were migrated separately under explicit approval.
Historical PR inventories and advisory decisions are retained as historical
material, not presented as current-source acceptance. No core dependency audit,
advisory waiver or hosted release pass is implied. Matching builds, browser/native
acceptance and IOU persisted delivery remain separate requirements.

## Incoming upstream merge checkpoint (2026-09-29)

The current-only CI baseline now records incoming upstream
`5f00758312735f2ddac9928e3aa60349964bf73a`, following fork checkpoint
`8a164a52a33d09ce7b4390c96723194026ea8733` and its previously integrated upstream
`d1e3712bb9ded3a1c8b652492591b7107333b23e`. The reviewed immutable upstream backend
tree is `cf00604a2ca33c96c00a403b813a83d9221fd56f` and root Cargo manifest blob is
`dcdd0c5f0b123d6ab15622a46199b6eb4a94256a`. The base deployment script, all three
explicitly frozen historical wrapper identities and `dfx.json` are unchanged.
This baseline update does not modify or deploy backend code. The actual backend
identity guard still requires the expected tree represented by the tested Git
`HEAD` and refuses tracked or untracked guarded changes; an in-progress merge is
not a successful identity check.

All 12 current inherited-format record paths have byte-identical upstream blobs
between the old and incoming upstream commits. Their existing candidate hashes,
formatter/config identities, exact edit proofs and multiplicities are unchanged.
Only the current upstream base pins and corresponding current workflow fallback
and contract fixtures advance. Live proof recomputation remains mandatory; this
does not add an exclusion, accept new inherited debt or exempt merge-resolution
formatting. Historical formatting registries and workflows remain unchanged.

The appended npm ownership checkpoint reviews only four changed mixed files:
desktop/mobile App locale-load fallback, i18n locale fallback registration and
the client deleted-user refresh filter. The private workspace mounts and exact
account/backend storage getter remain intact. The existing 100 dedicated modules,
118 fingerprinted sources, 25 roots, 65 ownership anchors and frontend package
identities are retained. Its aggregate is
`14fb964489adca4863a72792cd229a5273594de925d2cfc80188a9f3f64fa806`; prior runtime and
formatting reviews are preserved as separate evidence.

The root Cargo manifest and lockfile change upstream, including a `thiserror`
identity shared with a current native owner. Their resolved dependency graph,
license identities and Rust inventory bindings require a separate exact review;
this non-Rust checkpoint neither accepts a candidate lock nor refreshes Rust
policy. Unrelated upstream backend dependencies do not become model/app audit
roots. Conflict resolution, focused local checks, complete runtime tests and
hosted execution are separate evidence. Security/advisory acceptance remains
unresolved, and no installation, advisory query, deployment or publication is
authorized or claimed by this checkpoint.

After the source merge was committed as `9e8c88ece`, the focused offline identity,
current/historical wiring, source-ownership and live-format contract suites passed
322/322 tests with zero skips. The unchanged actual backend identity guard passes
against that merged `HEAD`. The npm source gate reports 25 roots / 118 sources and
the exact aggregate above. The explicit current formatting command also passes
445 candidates, retains the existing 12 policy exclusions, and recomputes all 12
unchanged inherited proofs. Its `advisoryChecksPerformed` and `releaseAcceptance`
results remain false. A final repeat of the exact source comparison found no
fingerprint drift. These local results do not establish Rust/native qualification,
hosted workflow execution, advisory acceptance or release readiness.

The separate current Rust policy review is bound to merge commit
`9e8c88ece52860e6d0e3569969cc676072016227`, lockfile digest
`0816a350d574b1a43bf7b5cbf4928862f1e5dd524878cec2c707e11a3e719cb9`, and
scope digest `08dc4954f77f27197ae5181982445adaa242cf925c62c5e343a7c1c4b28da007`.
Upstream PocketIC requires exactly `thiserror 2.0.18`; keeping `2.0.19` failed
actual offline Cargo resolution. The native workspace's compatible `"2"` range
and unchanged derive use accept the upstream version. Its cached archive and
implementation archive match their lockfile checksums, and its license remains
`MIT OR Apache-2.0`. Only current source/lock/version bindings and the review
explanation change; all eight profiles, 25 direct seeds, 39 license entries and
19 model obligations are preserved. Thirty-eight focused pure source/policy
tests pass. The base inventory deliberately declares an incomplete review; its
separately bound receipt resolves that source-owner gap across 24 sources, 29
review units and 152 seed/profile pairs. That validated source-review result is
not full collection acceptance: the collector publishes overall completeness
only after every locked metadata profile and SBOM check succeeds. Offline Cargo
metadata stops at the missing cached `candid 0.10.37` archive. These checks are
not complete dependency-resolution, advisory, native-build or device acceptance.

With both current policy updates present, the combined offline frontend build,
Android packaging/startup, release-policy, identity, formatting and scoped security
contract suites pass 1,167/1,167 tests with zero skips (four test processes). They
use local fixtures only; no advisory query, package download or native compilation
is included. Separately, the merged frontend passes 4,505 tests and both typechecks
with zero errors; the existing 577 Svelte warnings remain. These results do not
replace browser authentication, real image inference, app-save or APK runtime tests.

## Current Android component compilation checkpoint (2026-09-29)

Running the actual cached Kotlin/SDK job on the merged source caught stale host
fixtures: they still supplied ProcessLifecycleOwner, while the app now uses
Application.ActivityLifecycleCallbacks, Bundle and a generated local-test build
flag. This was a test-harness compilation failure, not a passing native result;
the original failure log is retained. Only the component-test folder is updated.
The production MyApplication and IntentsManager implementations are unchanged.

The runner still compiles those actual production files. Its recording doubles
now match the framework API, and all existing four-path intent assertions remain.
Five tests across package-identity, API-level and official/local-test combinations
pass 40/40. They cover Firebase success/failure and local-test exclusion, cold
startup before service calls, background intent creation, main-versus-other
activity routing and the production foreground field's volatile modifier. A
separate compilation excludes Android doubles and passes against SDK 36; all
seven recorded Android constants match the SDK. The existing 32 CI coverage
contracts pass, and the combined focused tool/startup/APK/CI contract run passes
71/71 with no skips. No download, Gradle dependency resolution, production change,
emulator action or APK installation is part of this evidence. It is not complete
native compilation or device acceptance.

## Current onboarding formatting checkpoint (2026-09-30)

The restored desktop `OnboardModal.svelte` is fully formatted by the installed
formatter and remains in the normal current-client formatting candidates. Its
obsolete current-client inherited-formatting record is removed, leaving 11
records. Every remaining mismatch still requires the exact live upstream edit
proof; the regression checks both the complete record set and that onboarding
needs no exemption. The upstream comparison baseline, historical registries and
candidate-selection rules are unchanged.

## Current upstream baseline integration (2026-09-30)

The current-client baseline and complete-fork formatting comparison advance to
upstream `c0ac3178f70f5e9de2f6ee532ce1415ab32a47cd`, whose backend tree is
`6f285e41b0b06ce273fc47ac551270479547263f`. The root Cargo manifest and
upstream deployment-script blob identities are unchanged. All 11 current
inherited-formatting records have identical upstream source blobs and candidate
source hashes; only their base-commit pins advance. Exact live edit proofs and
the normal formatting candidate rules remain required, including the formatted
onboarding file without an exemption.

Current workflow wiring rejects both the previous integrated upstream pin and
the historical formatting base. Historical workflows, review records and
exceptions stay frozen; no dependency root, advisory decision or release gate is
waived. The backend identity guard still checks committed HEAD and requires the
merge commit before it can pass. This baseline update is not device, account,
provider, APK, advisory or release acceptance.

## Current upstream baseline refresh (2026-10-01)

The approved current-only comparison now pins merged upstream
`a4cc691e2c30a73b93c0fb52563168e88082c40e` and backend tree
`2aa18d204b5ce4aeee13998c271c839f7af65dca`. Root Cargo and deployment-script
blob identities did not change. All 11 existing formatter records have the same
upstream and candidate source hashes and the same recomputed installed-CLI edit
proofs; only their current baseline pins advance. No exemption was added.

The six previously reported formatting failures in the two `P2PSwapContent`
components, generated ledger candid files, and `signer.ts`/`signer.spec.ts` are
byte-identical (CRLF-to-LF only) to this merged upstream. They are not new fork
edits. Future fork changes remain subject to normal candidate selection and
formatting. Historical registries, advisory rules and deferrals stay unchanged.
This baseline refresh is source/format identity evidence, not dependency audit,
device, hosted CI, provider or release acceptance.

## Current scoped verification results (2026-10-01)

The approved encryption and local-card persistence composition passed the actual
offline license check (39 packages and 19 model obligations), all eight Rust
collection profiles and validation of the 435-component SBOM. The npm runtime
smoke check and current plan passed with 25 reviewed feature roots, 151 source
files and 322 selected package locations. The Android resolver and CI coverage
contracts passed 64 tests. No dependency was installed or changed by these checks.

The subsequent feature-only advisory requests exported public package names and
versions, not repository source, chat contents, card fields or credentials. npm
received 318 names and 322 versions; OSV received 435 selected crates.io identities,
with none left unqueried. Source, lockfile and collection bindings stayed unchanged.
Neither request expanded into a whole-core OpenChat audit.

Both advisory gates remain failed. The first npm response returned eight findings:
seven for `adm-zip 0.6.0` and one for `devalue 5.8.1`. Following the separately
approved installer-only patch, the same scoped query, verified at 17:38 UTC, returned no
findings for locked `adm-zip 0.6.1`, but seven for `devalue 5.8.1` (six newly
returned advisory IDs). The installed repository copy was subsequently aligned
to `adm-zip 0.6.1` using the approved narrow upgrade, with a verified backup and
17 passing offline checks against the canonical ONNX installer. This does not
resolve the remaining findings or change the historical APK019 build evidence.
The Rust response still returned the same ten advisory IDs across nine package
identities, including two IDs for `glib 0.18.5`. Existing
documented deferrals cover only their exact recorded findings; they do not waive
new findings or turn the scanner result into a pass. No advisory policy was relaxed.

Hosted run [36774407598](https://github.com/ktimam/open-chat/actions/runs/36774407598)
tested the older pushed commit `ce5b7990da`, not this uncommitted implementation.
Its real inference fixture, frontend model contracts, and Linux and Windows native
jobs passed. The dependency job failed at its advisory step. The Android component
job failed while resolving its pinned Kotlin compiler from Maven, before reaching
compilation; the recorded generic fetch error does not establish its network cause.
Local APK build success is not a substitute for that hosted gate. Current-source
hosted execution and native runtime acceptance remain separate unfinished checks.

The later optional-audio routing correction has its own approved source identity,
`95eb35428d98c8af8b7d7a81af121ccae5275d3aa09b2f8a0adc2a9e0abb0e62`.
Only two fingerprinted runtime files changed: the exact unofficial static-profile
asset predicate and the artifact download URL selection. The current gate retains
151 sources, 25 roots and 86 anchors; 153 focused offline contracts pass, including
exact reversal to the preceding source aggregate. Historical snapshots and advisory
enforcement are unchanged. The full frontend rerun, including four actual HF audio-merge
regressions, passes 5,073 tests in 339 files. Runtime source identity remains unchanged.
The source refresh itself does not establish advisory acceptance. The later
scoped query described above retained exactly these roots and source identities;
only the approved adm-zip version changed in its dependency inventory. Its receipt
is `scoped-advisories-20261001-post-adm061/receipt.json` under the project temporary
root. No new deferral, scanner waiver or core OpenChat audit was applied.

## October 3 hosted checkpoint and CI corrections

Fork main at `ceb61f214846ea23c7eadd96edd443ad012830ed` includes official
upstream `319fb436857f35f61e12a9d47bebf6ddb0a72307`. Hosted security run
[37134381565](https://github.com/ktimam/open-chat/actions/runs/37134381565)
passed frontend model contracts, both Linux/Windows native jobs, and the pinned
small real-inference fixture. The separate frontend run
[37134381560](https://github.com/ktimam/open-chat/actions/runs/37134381560)
passed lint/type/unit checks but failed production-build policy checks: the
new provenance assertion could not resolve the reviewed upstream commit in its
shallow checkout. The production job now requests full history, with positive
and mutation regressions; the provenance assertion is not skipped or weakened.

The Android component job reported `redirect-rejected` for its pinned Kotlin
compiler, before compilation. The diagnostic-only revision inspected only the first HTTP
response and reported a bounded status and fixed redirect classification. It
never followed redirects or logged full Location values, paths, query strings,
or credentials. To identify the public compiler's unexpected hosting destination,
diagnostics included only its bounded HTTPS origin, path-equality and query-presence
flags; that did not authorize requesting the destination. Status 200, exact URL,
byte count, and SHA-256 remained required;
all redirect responses failed before artifact creation. That improved diagnosis,
not evidence that the hosted acquisition issue was fixed.

The next hosted run [37138513559](https://github.com/ktimam/open-chat/actions/runs/37138513559)
at `d0d6c68ad4b2e920053f997fb7381bb491ff897a` confirmed HTTP 301 to a
GitHub origin, not a download timeout. [Sonatype documents publisher-coordinated
301 redirects](https://central.sonatype.org/faq/429-operational-dependencies/#artifact-redirects)
for high-volume artifacts, although its example list does not name Kotlin.
[JetBrains' official v2.2.0 release metadata](https://api.github.com/repos/JetBrains/kotlin/releases/tags/v2.2.0)
independently lists asset `598661100`, `kotlin-compiler-embeddable-2.2.0.jar`,
added September 29, 2026, with exactly the existing 56,255,947-byte size and
SHA-256 `b2f743ea5ba12f69e0f35e5d8d46069d74c8e2861087548a7e0e14a784bc4cf1`.
The hosted origin-only evidence did not establish its exact destination path.

The resolver now permits only the matching compiler's Maven 301 to the exact
`JetBrains/kotlin/releases/download/v2.2.0/kotlin-compiler-embeddable-2.2.0.jar`
HTTPS URL. An October 3 header-only request to that verified publisher URL
returned 302 to the exact CDN object
`release-assets.githubusercontent.com/github-production-release-asset/3432266/e2a79dcf-39b6-4c79-b41f-130a3894fc1a`.
The [official repository metadata](https://api.github.com/repos/JetBrains/kotlin)
confirms repository ID `3432266`; [GitHub documents this release-asset host](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#communication-requirements-for-github-hosted-runners).
Only that exact second hop is permitted, with a bounded, nonduplicated set of
observed signed-query keys kept in memory only. No signature/query values were
recorded. No wildcard repositories, CDN objects, mirrors, automatic redirects,
userinfo, ports, fragments, retry loops, or third redirects are allowed.
Both hops share the original deadline; redirect bodies are cancelled, not read.
Every response must match its exact requested URL, and the final response must
still be 200 with the pinned byte count and SHA-256. The other eight artifacts
retain redirect rejection. Errors retain only the original public Maven URL;
downstream diagnostics omit Location-derived fields. All 96 focused offline resolver
tests pass,
including complete synthetic chains, rejected destinations/stages, final size
and hash failures, one shared deadline, cancelled bodies, and signed-query
redaction in both exported errors and actual CLI output.

After the redirect-chain correction, all 1,342 tests selected by the two
workflows' 41 existing offline suites pass on pinned Node 24.18.1, with no
failures or skips. Scoped formatting and workflow-wiring checks also pass.
The correction was pushed as `23b99c25c5aa105d6bdfafa7ce8fc7e08ea79c7d` and
hosted Android component compilation subsequently passed. The later exact-commit
[frontend run for 6630ae711](https://github.com/ktimam/open-chat/actions/runs/37143795106)
passed all four jobs, and its
[scoped security run](https://github.com/ktimam/open-chat/actions/runs/37143795163)
passed all five test/compilation jobs, including Android, Windows and Ubuntu.
The remaining advisory failure below is not a compiler-acquisition failure.
Native app-delivery runtime acceptance remains separate. No model, prompt,
application runtime, account, or OpenChat backend was changed by these CI corrections.

The completed scoped Rust collection, source binding, SBOM schema validation,
and query transcript passed; the advisory gate still rejects the ten previously
documented findings. Existing exact-version local-test deferrals do not turn
that scanner result green. The npm query returned a new finding for
`braces@3.0.3`, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It is reached through the reviewed build-asset root `rollup-plugin-copy@3.5.0`,
then `globby@10.0.1`, `fast-glob@3.3.3`, and `micromatch@4.0.8`. These versions
and integrities match the pinned upstream baseline; inheritance is not proof
of non-exploitability. The October 3 advisory page lists no patched version.
This exact new finding is not covered by earlier deferrals and remains
unresolved pending the user's local-test decision. No waiver or dependency
change has been made.
