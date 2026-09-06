# Refreshing the existing two-PR stack

Assessment: 2026-09-06. This is a scope map and work log, not a completed split or a ready-for-review claim.
Keep both existing PRs in draft while the dependency and runtime gates are unresolved.

## First isolated refresh slice

An isolated `codex/pr1-refresh-local-build` worktree now starts at the exact published PR1
head below. The first slice transfers only portable OTA ZIP packaging: literal `execFile`
arguments, Windows UTF-8 ZIP creation and archive regression tests. It deliberately excludes
the app-side `includeLocalExtractor` payload changes and leaves the native-platform guard
untouched. Its dependency fixture matches PR1's existing `fs-extra@8.1.0`; no package or lockfile
update is needed. Commit `a6fedf3e0` records this three-file slice locally: four Windows tests
pass, including the actual plugin's store/full ZIP outputs, config injection, asset bytes and
exclusions. Its frontend CI prerequisites now match the existing PR1 Node policy and pinned
`dfx` version, check frozen Rollup resolution and run the archive test. The complete PR1 build
and hosted CI have not run; this isolated branch is not pushed.

This starts the append-only refresh; it does not transfer the later model runtime or app
protocols, establish whole-PR acceptance, change either published PR head or reconcile upstream.

## Pinned comparison points

- PR1 model head: `045f7132e502ba01c56343800217070aa2ce4ea0`.
- PR2 app-interface head: `c7299aa11b87fbfd56029fc90e05e423654f54f1`.
- Combined checkpoint: `2029f00d726ca7c33de22c53c24cf1ada173d3fb`.
- Observed upstream master: `fb7c34bcc453e04480a36b4c5882cf63f362efbd`.

The checkpoint is 16 commits / 115 changed files past PR2, and 60 commits past PR1.
PR1 is an ancestor of both. Upstream and checkpoint have 124 and 98 unique commits;
upstream integration and conflict resolution remain untested. Re-read remote refs before work.

## Scope by area

Paths below are relative to the repository; globs include corresponding tests. Classification
is by responsibility, not permission to copy an entire commit or directory without review.

| Area | Destination | Review requirement |
| --- | --- | --- |
| `frontend/app/src/utils/transformersWebGpu*`, `gemma4WebGpuEmbedding.ts`, inference worker, sequential-session build helper | PR1 | Preserve GPU lifecycle, embedding identity and optional audio fixes together |
| `modelCatalog*`, `onDeviceInference*`, `webInference*`, native model manager and model command/types | PR1 | Preserve cached installations and keep readiness distinct from selection |
| Both `ModelManager.svelte` components and shared runtime settings | PR1, mixed UI hunks reviewed | Do not import app action structures into the model-only head |
| `appLocalProcessor*`, `aiAppReconnect*`, `privateMatchSurface*`, `cardBridge*`, action card components, app link sheet | PR2 | App-owned interpretation, content attestation and scoped linking remain together |
| `aiActionRunner*`, `aiActionAvailability*`, `aiActionProposalReadiness*`, local command/message/menu flow, shared action schema | Mixed | PR1 owns generic inference; PR2 adds registered app routing and action construction |
| `browserOcr*`, `inferenceImage*`, local extraction, image mode settings | Mixed | Evidence/runtime plumbing may be generic; app-specific interpretation must stay outside this repository |
| Startup, home routes, chat/message/image components, toasts, build configuration, translations | Mixed | Attribute individual hunks and tests; verify both UI versions |
| Passkey bridge, identity model, native onboarding, client authentication | Shared prerequisite | Prefer a small isolated prerequisite or generic PR1 commit, then inherit into PR2 |
| Backend capability redemption update and local app-processing protocol docs | PR2 | Preserve exact authority/content checks; never loosen for UI success |
| Model illustrations | PR1 | Documentation must match actual shipping versus development runtime |
| Lint, compatible dependency patches, portable hashes and CI/release guards after checkpoint | Shared tooling | Carry generic portions first; PR2-only policy files and historical tests stay on the app stack |

Candidate model-focused commits include `97ab1e985` (decoder compilation), `42e519e10`
(embedding identity), `1212f2d8d` (optional audio), and `9614e9c64` (model illustrations).
They still require dependency/hunk review; their titles are not proof of independent applicability.
Reconnect viewport commit `b2c3e6f6b` and app-boundary checkpoint `2029f00d7` belong to the
app review. The remaining commits touch shared runtime/UI concerns and must be split by hunk.

## Append-only refresh sequence

1. Use isolated worktrees from the exact existing PR heads. Preserve the combined integration
   branch and immutable checkpoint as reference, not as a new PR2-only head.
2. On PR1, apply generic runtime/model hunks and their tests from the checkpoint, plus generic
   preparation fixes. Keep PR2 protocols/types out. Validate source imports, model tests,
   frontend checks, native tests and the PR1 dependency review independently.
3. Append the reviewed commits to PR1. Merge that resulting head into the existing PR2 history
   (do not rebase a published branch without agreement). Resolve shared files against the
   checkpoint's final behavior, then append only the missing app/interface hunks and tests.
4. Compare the resulting combined tree to the tested checkpoint plus preparation. Explain
   every intentional delta. Re-run app/host boundary, full frontend/backend and live card gates.
5. Reconcile current upstream in the model branch, merge the updated model head into PR2,
   and revalidate. Do not resolve conflicts by replacing whole upstream files with old copies.
6. Push each refreshed existing branch only after its own checks pass; update existing PR
   descriptions. Require hosted checks for both final heads and the exact shipping commit.

Read-only starting commands:

```sh
git diff --name-status c7299aa11 2029f00d7
git log --reverse --format='%h %s' c7299aa11..2029f00d7
git diff 045f7132e 2029f00d7 -- frontend/app/src/utils
git rev-list --left-right --count upstream/master...2029f00d7
```

Do not blindly cherry-pick all 16 commits into PR1 or fast-forward PR2 to the mixed integration
branch and describe it as app-only. This plan neither rewrites history nor waives the
[release readiness gates](model-app-readiness.md).
