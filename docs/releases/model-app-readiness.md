# Model and app integration: PR and release readiness

Assessment: 2026-09-06. **Prepared for continued draft review; not ready for a production release.**
No PR, release, PR branch base, production switch, signing key, or deployed service was changed
by this preparation. Preparation commits belong on the integration branch, not either stale PR head.

## Source and submission state

The published integration checkpoint is `2029f00d726ca7c33de22c53c24cf1ada173d3fb`
on `codex/pr2-clean-integration`, tagged `model-integration-checkpoint-2026-09-05`.
The lint cleanup, compatible dependency updates, portable security hashes, CI coverage,
Android release safeguards and this preparation package follow that immutable checkpoint.
Use the preparation commit SHA for further validation; never move the checkpoint tag.

| Submission | Observed head | Base | State |
| --- | --- | --- | --- |
| [Upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132) | `codex/pr1-local-models`, `045f7132e` | upstream `master` | Draft; no reported check runs |
| [Fork PR #73](https://github.com/ktimam/open-chat/pull/73) | `codex/pr2-app-chat-interfaces`, `c7299aa11` | `codex/pr1-local-models` | Draft; no reported check runs |
| Tested integration checkpoint | `codex/pr2-clean-integration`, `2029f00d7` | descends from both heads above | Not either PR's current head |

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
refresh sequence. The scope split has not been executed.

This is a proposed publishing sequence, not an executed history rewrite. Keep the checkpoint
tag available for comparison; do not move it to a rebased or lint-cleaned head.

## Verification actually completed

Results below use an isolated copy of integration source plus lint cleanup and the updated
frontend lockfile, not refreshed PR1/PR2 heads and not a shipping production build.

| Check | Result |
| --- | --- |
| Full frontend unit tests | 127 files / 1,766 passed |
| Svelte typecheck | 0 errors; 564 warnings in 205 files |
| Agent TypeScript check | Passed |
| Read-only ESLint | 0 errors; 31 existing warnings (26 errors corrected) |
| Frozen isolated dependency install | Passed; model/ONNX/OCR runtime lock entries unchanged |
| Release/CI/digest policy tests | 89 passed, including historical hash proofs and negative release evidence |
| Diff whitespace check | Passed |
| App/host boundary audit | 5,106 text files / no findings; rerun after any scope split |
| Hosted checks on existing PRs | None reported; not a pass |
| Current native/backend rebuild and integration suites | Not rerun during this preparation |
| Signed shipping APK / production rollout | Not built or performed |

Earlier physical-phone evidence established all-WebGPU model generation in a local development
APK. Complete partner-app card verification still requires a passing live run. Emulator replay
does not prove physical GPU generation; its WebView had no WebGPU adapter. Do not collapse unit,
replayed integration, real inference and fully rendered/verified card evidence into one pass.

The isolated install used npm `10.8.2` and local Node `24.14.1`. Frontend, Android and security
CI now agree on Node `24.18.1`; hosted verification under that exact runtime is still required.
CI uses read-only lint and frozen install, with no ad-hoc Rollup install that mutates the lockfile.

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

Fresh npm advisory results on 2026-09-06:

| Dependency scope | High | Moderate | Low | Critical |
| --- | --- | --- | --- | --- |
| Production | 5 | 3 | 0 | 0 |
| All | 5 | 6 | 0 | 0 |

Compatible updates reduced the all-dependency total from 20 to 11 in this audit snapshot.
Tiptap is locked to 3.31.3 and DOMPurify to 3.4.14, above their patched minimums;
see the [Tiptap fix](https://github.com/ueberdosis/tiptap/releases/tag/v3.30.4) and
[DOMPurify advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-55q2-fjhq-7xh7).
Remaining chains include Coinbase SDK/axios, Transformers/ONNX Node/adm-zip,
Transformers/sharp, jayson/stream-json and rollup-styles/query-string/decoder.
Fixes require parent releases or separately tested compatibility work; no unsafe override
or model-runtime upgrade was used. Both scopes still fail policy categories.
A smaller overall total does not excuse a category increase.
These are dependency findings, not demonstrated browser exploitability. Assess runtime
reachability, especially Node-only transitive dependencies of browser model packages;
remediate or explicitly review residual risk, licenses and lockfile changes before replacing
the baseline. A new RustSec/license/SBOM review is also still required.

Frontend, backend and model/app security workflows now include the stacked PR base and
integration pushes, with regression tests for that routing. These changes are not on the
two older PR heads yet. Candid and broader integration workflows still need coordinated
validation on the final stack; private/custom-runner jobs were not enabled blindly.
Absence of hosted check runs must not be reported as success.

## Shipping behavior and Android gates: blocked

- [All-WebGPU feature gating](../../frontend/app/transformersWebGpuFeatureFlag.mjs) requires
  development + local network + explicit opt-in. It is not available in production merely
  by setting the opt-in. Production distribution of pinned/patched model assets is unresolved.
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
- Pin the remaining Android toolchain choices and verify production origin, model assets,
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
node scripts/check_openchat_pr1_security.mjs ci npm
node scripts/check_openchat_pr2_security.mjs ci npm
git diff --check
```

The security commands are currently expected to fail; preserve their findings. Run Rust,
license, formatting and SBOM gates with the documented pinned tools after dependency review.
Then run the coordinated backend integration tests and a clean shipping build. Do not update
PR readiness, publish a GitHub Release, upload APKs, enable production features or deploy until
the corresponding gates pass and those actions are explicitly authorized.
