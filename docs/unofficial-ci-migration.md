# Current unofficial client CI: replacement coverage

The active product is a single-main frontend using unchanged official OpenChat
services. Historical PR1/PR2 custom-canister contracts are not its release gate.
This migration does not modify backend sources, upstream backend/Candid workflows
or scripts, reviewed dependency ownership, advisory decisions or security jobs.

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

## Security composition remains unresolved

Passing this offline client gate is **not** advisory/security-scope acceptance.
Existing model/app security workflows, scopes and deferred inherited advisories
are unchanged. Their old branch routes and custom-backend assumptions must not be
retargeted into known-invalid main scans. `current-client` reports
`securityScopeAcceptance: false` and `advisoryAcceptance: false` explicitly.

Valid model/app-interface security coverage must be preserved through a separately
reviewed current-composition mapping. This is not permission for a core OpenChat
audit, broader dependency collection, weakened checks, automatic deployment or
publication. Historical security-mode requirements remain enforced by their
explicit historical checker modes; current topology is not mislabeled as PR2.
