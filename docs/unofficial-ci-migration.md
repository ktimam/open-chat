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
tests pass. Source completeness remains explicitly incomplete, and offline Cargo
metadata stops at the missing cached `candid 0.10.37` archive. These checks are
not complete dependency-resolution, advisory, native-build or device acceptance.

With both current policy updates present, the combined offline frontend build,
Android packaging/startup, release-policy, identity, formatting and scoped security
contract suites pass 1,167/1,167 tests with zero skips (four test processes). They
use local fixtures only; no advisory query, package download or native compilation
is included. Separately, the merged frontend passes 4,505 tests and both typechecks
with zero errors; the existing 577 Svelte warnings remain. These results do not
replace browser authentication, real image inference, app-save or APK runtime tests.
