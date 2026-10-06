# Unofficial local client

This is an experimental frontend profile, not an official OpenChat release. It uses
the checked-in official canister IDs without deploying modified OpenChat canisters.
Public branding, hosting and public Android-provider qualification remain outside
the local-only acceptance below.

## Current checkpoint — October 6, 2026

The later normal-flow repair removes the remaining transport JSON/pairing pages and
extra Open/Load steps. Apps → Connect/Reconnect shows the app's normal connection
page; confirming an inline card opens its normal review/save flow directly. Sender
approval, recipient encryption and the receiving app's separate review/save remain.

The active browser candidate is an explicitly uncommitted UI overlay on
`e8ff0811660e705c377e1fef0addde133536f85b`, not a newly published release. Its r3
build is `2.0.0-localtest.63d10d313e0ac88441122a01a18cdd98`, served at localhost:5190
from `F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/web-r3/v2`. Source receipt SHA-256:
`c3a20e4544efd427fbde3b6d12947962295c33ee3ef796effb6e104ace2ee631`;
independent `VERIFIED.json` SHA-256:
`c9625f04a83038c585e33b68451792bb65bd2bae548c9cc83aa22c49bc9528d4`.
This supersedes r2 for serving, not its retained acceptance evidence. The r3 build
includes the narrow Saved-status fix, now confirmed in the browser and the matching
refreshed x86 APK. The companion IOU r4 source record is SHA-256
`bc0779909901f43369a64a8ff385058eff081aae8c8cda748f4e722cba523ff2`, retained at
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/iou-r4/source.json`. Its app/node
TypeScript checks, 228 unit tests and 90 integration tests passed. The HTTP framing
policy remains restricted to exact localhost origins 5190, 5192 and 5193.

| Repair acceptance | Observed result | Boundary |
| --- | --- | --- |
| Browser connection | Normal Apps reconnect retained sign-in and showed friendly account/sheet names, Types and Connect directly | No manual IDs, file uploads, JSON page or extra transport button |
| Browser review/save | A synthetic 45.67 card opened normal IOU Sheet → Pending from chat → Review & add. Its original entry form applied the Type's 10% fee; explicit Add entry produced an in-session Saved acknowledgement. Fresh sheet navigation found exactly one row, gross 45.67/net 41.10 | This end-to-end interaction ran r1. The r2 browser change is recovery wording; native-only deltas do not establish browser or APK runtime acceptance |
| r2 reload | The stored card remained available and selecting it did not resend | Restore requires fresh acknowledgement to reopen; a trusted Saved status or sending approval is not restored |
| r3 browser artifact | Build and independent source/relay checks passed; all 27 AI assets match retained r2. Same-origin server replacement and exact HTTP/security-header checks passed | This artifact check is not another browser inference, delivery or Saved-status runtime pass |
| r3 browser runtime with IOU r4 | Reload retained the account and source-linked card without sending or opening a tab; acknowledgement remained unchecked and Reopen disabled. Explicit same-ID reopening and saving returned the earlier-save-already-accepted result, inline Saved and the corrected saved-status sentence | Fresh history showed the browser and native test-note rows once each. Restoring the card itself did not restore trusted Saved status or approval |
| App navigation | Details opened a new top-level IOU account tab; Open active sheet then navigated normally | No frame-policy refusal; the exact CSP was retained, not weakened |
| Initial repaired native save | The fixed-origin x86 APK passed normal connection and review/save on persistent emulator-5554, followed by backend reload readback | A later fresh browser page independently confirmed the native test-note row; this does not turn the earlier saving-page reload into an independent-session check |
| Final status-corrected APK | In-place installation retained the account and card. Explicit same-ID reopening, original entry-form review and save returned earlier-save-already-accepted, one native test-note row and corrected native Saved status | Same persistent emulator and retained card, not a fresh image-inference test. Both architecture artifacts passed verification; the ARM APK has not been tested on a physical phone |

The repaired emulator flow used normal Apps → IOU reconnect, with friendly sheet
names and Types; cancel/reopen on the same fixed ports passed. Propose → inline
card → Add to IOU opened the normal sheet's Pending from chat → Review & add and
unchanged entry form. Explicit Add entry for synthetic 45.67 USD, 2026-10-06,
You owe, note `TEST ONLY - APK UI repair`, and the 10%-fee Type produced net 41.10.
IOU showed Saved in IOU and the native card showed Add to IOU Saved. The normal
submit handler awaited its backend reload; a subsequent sheet snapshot included the
new row with that unique test note, gross 45.67 and net 41.10. This is backend reload
readback, not an independent fresh-session readback. The form screenshot is retained as
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/emulator-normal-iou-form.png`.
No native GPU inference or physical-phone pass is claimed.

That run also exposed stale delivered-status text beneath the Saved header and an
existing Open active sheet navigation blocked when followed inside the restricted
app frame. Both are resolved and runtime-checked in browser r3/IOU r4; the corrected
Saved status also passed in the final x86 APK. A fresh browser history page separately
confirmed the native row and, after explicit replay, both test-note rows remained unique.
Details now opens the normal app account in a new top-level tab, where Open active sheet
works; this does not weaken the receiving frame's exact CSP.

The final x86 replay retained the original 45.67 USD, 2026-10-06, You owe,
`TEST ONLY - APK UI repair` note and Type's 10% fee/net 41.10. Only after the explicit
checked acknowledgement did Reopen proceed through the existing sign-in and normal
Pending from chat → Review & add entry form. Add entry returned
"Saved in IOU — the earlier save was already accepted." Back in OpenChat, the card
showed Saved and "The app reports that this request was saved." The final screenshots
are retained locally as `final-apk-normal-iou-review.png` and `final-apk-saved-card.png`
under `F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/`; the latter has SHA-256
`368b2374908818eb0eea0726782bd99b21e2d8ef8a705a0a1160378bb481ac73`.

The final status-corrected APKs are retained in
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/apk-saved-status/artifacts/`:
`openchat-fork-local-test-x86_64.apk` SHA-256
`1dab809a8af3aea89546c8b1f58499d29cf24842dc249bb48b1da5fdd56dd769`, and
`openchat-fork-local-test-aarch64.apk` SHA-256
`84aa572be993bcf0f7f22265eda4ecbfdd78747414c45baf84b2d0ede351f0e0`.
Their shared frontend build ID is `ab7e55a2161f1747404a2699cd01a3ea`; the 41-overlay
source record SHA-256 is `b90916cbf31b0695af427b4ae27d59baee105d8518c01b07c804deb3e2988f8c`.
All 38 common web-r3 overlay hashes match. `APK-COMPACT.json`, linking both independent
artifact reports, has SHA-256 `27d8ce6f75c13f08421c2e6d41313d60e774f5153d20aed070dbebd157a5e64a`.
The final status regression passed 204 focused tests; this overlaps earlier coverage,
not an additional disjoint total. No native source, authentication or model change
was needed for this last status correction.

The earlier fixed-origin APKs, before the final status correction, are preserved in
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/apk-fixed-origins/artifacts/`:
`openchat-fork-local-test-x86_64.apk` SHA-256
`e422ae0a601a984383805c53ab35331e7fd90273580dd731e043c8475c5d12fd`, and
`openchat-fork-local-test-aarch64.apk` SHA-256
`5bd814b568f3946770ae3cd10ee16255b4edac1ea30c60b6c22edef446eb554f`.
Their shared frontend build ID is `f2a32f83dfddd29e5242ab54c3b652a2`.
The 40-overlay source record SHA-256 is
`144598e98b4f066175ea63ae7fd03b29de6a5df16208ec2eef4bc7578980efa9`;
`APK-COMPACT.json` links the independent per-architecture reports and has SHA-256
`d23a0786139d60e8a7fb84b949875f8cbc7d564d8b409fd5c48f6bfa2a4d299e`.
These are local repair artifacts, not published releases. Runtime acceptance is
limited to the observed browser and x86 emulator flows described above.

Main-page isolation and exact relay/app framing policies were checked after the r3
server switch. There is no backend, prompt, weight or model-setting change in this UI
repair. Existing advisory, optional-voice, physical-phone and public-release limits
remain; this checkpoint does not upgrade them to passes.

### Earlier October 6 checkpoint — before the transport UI repair

**The PR-only UI is restored on fork main. Desktop original-image checks and the
final emulator's reconnect/encrypted delivery checks passed. Native all-WebGPU
image inference is not qualified: the emulator returns no adapter, and the matching
ARM APK has not been tested on a physical phone. This is not public-release approval.**

#### Earlier source and scope

The tested OpenChat source is `d0b00668c342d6b4bc09f93e19c2f023c6c07926`;
the companion app's tested IOU source is
`1ce9eef2105ced88aaa8b533018dbe6926223a40`. Both were verified on their
respective remote `main` branches. Later documentation commits do not change the
source identity of these binaries. The backend tree remains
`5dd2d8447467dde7b3eb59a25bf0a06bc2af0e2a`, identical to integrated official
upstream `0519aa39964a34d165173587b4d63e572c89670d`; no OpenChat canister
change or deployment was required.

That checkpoint used normal Apps connection and the restored app-authored inline
card at its source message, not the removed technical draft/setup workspace.
Private cards remain encrypted device-local records; explicit sender review,
recipient encryption, app-side decryption and a second review/save remain required.
No prompts, weights, UI, inference runtime or backend were changed during this
verification run. Uncommitted experiments were excluded from the frozen builds.

#### Earlier local-test completion checklist

| Area | Verified result | Limit |
| --- | --- | --- |
| Reconnect | Three focused suites passed 50 tests. Final x86 APK normal Apps → Reconnect → approved app setup → return reached Connected without restarting the PC | Earlier intermittent timeout cause remains unproven; no timeout or security guard was weakened |
| Desktop image proposals | Model-only Gemma passed the original Arabic and date-range images. Small all-q4 Qwen passed Arabic → date-range → Arabic without restart/model switch. Switching back to cached Gemma passed the date-range image | Fresh v2 normal-UI observations, not emulator inference, a fresh v1 run or general image/multi-document accuracy |
| Image fields | Arabic: 12,900 EGP, 2026-08-14, settlement. Date-range: 1,912.15 USD, 2026-07-19, correct app-defined Type/default direction and full printed from–to note | The Type is companion-app configuration, not an OpenChat keyword or schema rule |
| Browser delivery | Gemma Arabic proposal completed encrypted handoff, recipient review, one save and fresh sheet readback of exactly one matching entry | Other image proposals were inspected and canceled unsaved; their extraction passes are not delivery passes |
| Final APK delivery | A reviewed synthetic 44.45 USD / 2026-10-06 / You owe / IOU card completed encrypted handoff, app decryption, second review, save, helper/APK Saved acknowledgement and fresh sheet readback exactly once | Its source Note and saved Type were not populated. This proves fidelity to the reviewed card, not text extraction accuracy. An earlier 44.44 receipt-only attempt was not saved |
| Restart persistence | In-place APK update and subsequent app restart retained the existing account/chat, app setup and a prior private-card link without new sign-in | The restart preceded the 44.45 save; post-save restart/replay was not rerun on this artifact |
| Native image inference | Final APK secure-context/foreground preflight exposes WebGPU but default requestAdapter returns null; no GPU device/model/download was started | Emulator GPU inference is unpassed. No fallback or blocklist override was used. Physical-phone qualification remains deferred |
| CI and advisories | Historical source-bound functional test evidence below remains valid for its own commits | No fresh hosted-CI or advisory-scan pass is claimed. Existing exact-version local-test deferrals remain disclosed, not clean scans or public-release approval |

#### Earlier local-test APKs

Both APKs contain the same frozen frontend build ID
`e6f28ecbdd7a5edc5a194b0f7f329552` and frontend SHA-256
`73a51596588660ee72459fa631763b6b09283d79c64eb1ee4a5cfdc07a8d80f5`.
Independent packaging checks verified all 1,606 embedded frontend assets,
the existing package/signing identity, official canister profile, Credential
Manager route and disabled OTA. Native source and DEX match the reviewed baseline.
Static verification does not establish phone runtime or GPU support.

| File | SHA-256 | Runtime |
| --- | --- | --- |
| `openchat-fork-local-test-x86_64.apk` | `09e9f1aee2bb6e0b4c1cee3217c0bb0e52b6df94dc253fc92e9c2b72987e3682` | Installed in place; reconnect, persistence and delivery checks above |
| `openchat-fork-local-test-aarch64.apk` | `e19253bf1746ecdc401f20c76098dbb770442c44021ee6240b249006a403588f` | Built and statically verified; not installed/tested on a phone |

Local artifacts are retained under
`F:/Temp/OpenChat-IOU/pr-only-final-20261006/artifacts/`, not published releases.
The desktop run used the restored r3 v2 preview; the final APK's seven card
components were independently compared with its emitted UI. Desktop observations
must not be relabeled as a run of the final APK or a newly served web bundle.

Evidence records: `acceptance-progress.json` (SHA-256
`0ce13040039e2462974256e717e6c243b1b5188a76e1d44e991298a644c5a5f8`),
`independent-acceptance-inventory.json` (SHA-256
`bae4253681950ea742015c6f3353c3fec83dc7d2b235e0dfb6a42708c74e4f88`),
`APK-VERIFIED-x86_64.json`, `APK-VERIFIED-aarch64.json`, and
`emulator-webgpu-preflight-final.jsonl`. Browser image results include live operator
observations, not an independent second inference replay. Raw images, screenshots,
account identifiers and one-time handoff material are not published with these docs.

At that earlier checkpoint, only native image/phone qualification remained open in
the bounded PR-parity run. It does not qualify the repaired APK flow above.
Expanded image-contract experiments are not activated or added to this release's
scope. Optional voice's documented synthetic-recording limitation, public branding,
hosting/provider qualification and publication retain their existing deferrals.

## Historical checkpoint — October 5, 2026

**App-owned card presentation is packaged in verified build031 artifacts; final model/IOU
end-to-end acceptance is not complete.** Earlier dated checkpoints below remain
historical evidence, not a claim that their artifacts were rebuilt from current main.

### October 5: upstream integration and recovered local environment

Official upstream `0519aa39964a34d165173587b4d63e572c89670d` is integrated
with the output-budget fix at `08f8cf846fccddaa7f4ea7cdcd064616beee41a7`.
The only manual merge resolutions combine the existing `onDestroy` imports with
upstream's `untrack` imports in both message composers. The backend tree is
exactly upstream's `5dd2d8447467dde7b3eb59a25bf0a06bc2af0e2a`; no custom
OpenChat backend was deployed. The combined frontend passed 6,207/6,207 tests,
Svelte checking reported zero errors and 573 existing warnings, and the existing
214 scoped CI-policy tests passed. The full test report is
`F:/Temp/OpenChat-IOU/merge-verification-20261005/frontend-full-tests.json`,
SHA-256 `b731bc121b1bc059a7ce4a5ada6682dbf7bf6ac5c2c557aa9f46d95a287c954c`.
The byte-identical dirty snapshot anomaly was left unstaged.

The approved IOU recovery first made and byte-verified a backup of 1,220 files
(5,998,945,219 bytes), then checkpointed and strictly reopened the existing
state. Gateway 8080 is healthy; no reset, deployment or new canister occurred.
See `F:/Temp/OpenChat-IOU/recovery-20261005/result.json` (SHA-256
`0f905a97262bf01f81ce98a6d20f8935f21893d3ef6d619034f5890a44544893`).

APK031's approved cold-reopen observation passed: two complete normal Chats
snapshots showed the existing account and Kiko chat without sign-in or provider
UI. No authentication, model, card or delivery interaction was performed.
See `F:/Temp/OpenChat-IOU/emulator-public-ui-20261002/apk031-cold-reopen-observe-r1/result.json`,
SHA-256 `63619ce6cb3f2859ddfa15f42c8a711d70196b7d9c2a4ffc1e91dc38323c26e7`.
This supersedes only the pending home/session observation below, not card or
delivery acceptance. Served web031 and installed APK031 still contain their
original source, not this merge or the later output-budget fix. Fresh Connect,
model regressions, encrypted end-to-end delivery and rebuilt artifacts remain
release gates.

#### Fresh web031 card and two-entry delivery observations

After recovery, normal Edge Apps → Refresh apps → IOU Reconnect → existing IOU
identity → existing synthetic sheet → Share setup completed without imported
files. An initial stale-directory hash mismatch was resolved by Refresh apps;
validation was not weakened. A new proposal on the existing synthetic Kiko text
message used IOU's compact app-authored `draftView`. Editing revoked approval;
reload/reopen retained the edited fields and presentation, but not approval.
The [fresh-card receipt](F:/Temp/OpenChat-IOU/card-view-release-20261005/fresh-connect/result.json)
has SHA-256 `482272eff7b607913be24d52742fde6b97f18044092504035378906f696c8618`.

The separate delivery check used the supported payload editor for two explicitly
synthetic rows: 11.11 USD / You owe / October 5, and 22.22 USD / Owed to you /
October 6. These were edited test inputs, **not model extraction**. Complete
OpenChat review, encrypted handoff, recipient-bound IOU decryption, second review
and one Save action completed. Both exact rows appeared once in the normal
ledger. After refreshing the same existing IOU sign-in, a direct sheet reload
retained each row once. No new identity was created. OpenChat reload retained
the card without restored approval or resend. The
[delivery/readback receipt](F:/Temp/OpenChat-IOU/card-view-release-20261005/fresh-connect/two-entry-delivery-result.json)
has SHA-256 `34e740725352e77a9975b0a21a4590e746065e728d59b73d4b3765f8916a3475`.
This qualifies the observed web031 flow, not a network capture, cryptographic
audit, APK delivery or the newly merged build.

An inactive four-key Qwen grouping candidate completed in 44.2 seconds but still
returned only Invoice A from the two-invoice fixture. All 14 cached artifacts
were SHA-verified; cleanup was acknowledged. Valid complete JSON did not pass
the unchanged two-row factual oracle. The active prompt, weights and processor
were not changed. Evidence is
`F:/Temp/OpenChat-IOU/qwen-four-key-grouping-reviewed-20261005/visible-result.txt`.
The one-shot diagnostic was closed and the normal preview restored.

A separate title-only probe returned both document titles using the same image,
worker and cache. The next inactive candidate scoped all four existing fields to
their own document and required an array. It returned both exact totals and their
own dates in 45.4 seconds, with complete output and acknowledged cleanup at the
unchanged 96-token ceiling. Evidence is
`F:/Temp/OpenChat-IOU/qwen-document-scoped-array-20261005/visible-result.txt`.
This isolates a useful app-prompt correction, not a general accuracy claim:
original-image, absence and repeated-use checks are required before activation.
No production prompt or OpenChat app-specific logic was changed by these tests.

### Current build031 source, artifacts and normal-browser checks

APK031 (x86_64 and aarch64) and web031 (v1 and v2) were independently verified
against fork main commit `7eba7881bd6b63a65f662804543a32dd7740e232`, tree
`ad585947e4b94c1e541e11f77ea822c451cbaa8c`. At that packaging checkpoint, the
read-only remote check found both local HEAD and origin/main at that commit.
The later tested main checkpoint is `168ea567521d19e7a75654ae1b9ab0eccb989c4d`: its only changes
from the packaged commit are the card/native UI test and two documentation files.
The 031 artifacts were not rebuilt or relabelled for that test/docs-only follow-up.
Upstream/master remains `65e265f027cc50a1ea333dd94acbb7816992b54c`, already incorporated. Both backend
trees remain exactly `57820102df62dcfbb50fc934cf7d41171228d81c`. No OpenChat
backend change or deployment is needed for this presentation update.

The frozen source inventory covers 6,675 committed files (80,711,097 bytes),
SHA-256 `69b15c66221c93472b254e759497f96e8310dc784552e6db3884f597900f82b7`.
The APK frontend receipt covers 1,803 files (154,942,008 bytes), SHA-256
`33eed09be468688fcd83086ea4a427da4ec1ab4694ab9c0d9495e003123aec4b`.
The pre-existing, byte-identical baseline snapshot status anomaly remains
preserved; only committed bytes entered the frozen snapshots. APK build ID is
`5f8f55359679e7787c83263dae96d26b`, package `dev.openchatfork.localtest`.

| APK031 target | APK SHA-256 | Independent report SHA-256 |
| --- | --- | --- |
| [x86_64 APK](F:/Temp/OpenChat-IOU/native-transport-apk-031/artifacts/openchat-fork-local-test-x86_64.apk) | `dac1c303528d9fc3c800f645563e0b6443752be36ce71dd595497036dd5610f0` | `1e424412d6e2551009697a91d3026053d5ca875cf8e9c8f0b31d184499d8128a` |
| [aarch64 APK](F:/Temp/OpenChat-IOU/native-transport-apk-031/artifacts/openchat-fork-local-test-aarch64.apk) | `dc8d1113851129594c0ae2bc6844addd929343eb8e35c363a10b21bec6878501` | `93a4e0b9c393e46a219311793ab6ff047930dcd3557bee96291380bd480929d7` |

The reports are `APK031-VERIFIED-x86_64.json` and
`APK031-VERIFIED-aarch64.json` under
`F:/Temp/OpenChat-IOU/native-transport-apk-031/artifacts/`; they include 45
compiled-source proofs. The x86 APK was installed in place on emulator-5554;
its installed hash matched and the original September 30 first-install time
was retained. No uninstall or data clearing occurred. **Post-install emulator
UI, session/card restoration and delivery are not yet verified for build031.** The
ARM artifact pass does not establish physical-phone runtime acceptance.

[Web031 v1 files](F:/Temp/OpenChat-IOU/web-qualification-031/v1/) are
`2.0.0-localtest.887244465192628c46c469246472b7ed`; [v2 files](F:/Temp/OpenChat-IOU/web-qualification-031/v2/) are
`2.0.0-localtest.bd397f187297fa0950796e8667665aeb`. Reports under
`F:/Temp/OpenChat-IOU/web-qualification-031/artifacts/` are
`WEB031-VERIFIED-v1.json` (SHA-256
`2723c37f12c8b06d0d5771f6d7bbdbf95bfbed6fe5aac2b93bdd8af9b097cd92`)
and `WEB031-VERIFIED-v2.json` (SHA-256
`4419c43420fd0f85407406a4c8649f4334dfadb9d235e8f8c00bc9d10c44670d`).
They check 14 emitted card sources and the complete unchanged WebGPU
distribution. Both preserve the official backend, localhost:5190 profile and
disabled official OTA; v2 is the restored normal preview.

Normal Edge reloads of v1 and mobile-width v2 retained the existing account,
Kiko chat and seven saved cards. Normal Apps navigation, saved-card initial
focus, Tab/Shift-Tab containment and focus restoration on close passed. At
390 by 844 CSS pixels the actual mobile UI mounted, the dialog and document
width were 390, and the observed field controls were at least 44 pixels high.
The viewport was restored afterward. No card was edited, discarded or sent.
Receipts are `web031-rollout.json` and `mobile-and-apk031-verification.json`
under `F:/Temp/OpenChat-IOU/card-view-release-20261005/`.

Those existing cards deliberately retain their frozen old app setup and use
the compact fallback renderer. **Fresh IOU Connect and new proposals are still
needed to adopt and qualify the new app-owned `draftView`.** The original 031
rollout observed the IOU frontend at frozen commit
`7b4692508daa7eeb3da55418081db2e47588cfe8`; its public directory returned
HTTP 200, SHA-256
`063aeb2be32702ca6fc4179b0f464bf97bf37f9aa88e5d8b451bc8beea5d25ae`.
The subsequent frozen frontend rollout now serves IOU
`d3ed5dc0ed1d876a79d08197c207dbba3074b2aa`. This narrowly fixes handling of
negative/sign-ambiguous total rows by rejecting them rather than treating negative
amounts as positive; the active model prompts and `draftView` producer are unchanged.
All four public catalog/processor files were fetched
read-only and matched their committed snapshot hashes and sizes; the directory
is now SHA-256 `76198bda084ef5f47c7532485739e1c946ca81eff646d3f68d02e4c4f7387fb1`,
and `/openchat/import` returned HTTP 200. The 598-file committed snapshot and
guarded launcher checks are recorded in `postcommit-tree-proof.json` and
`launcher-verification.json` under
`F:/Temp/OpenChat-IOU/iou-sign-fix-publication-20261005/evidence/`.
The local backend on port 8080 was still unreachable at the latest readiness
check; these public frontend checks did not recover it or verify an account.
Fresh connection, new proposals, encrypted delivery and APK acceptance remain
pending. A public directory response is not backend readiness.

At build031's exact commit, the [frontend workflow](https://github.com/ktimam/open-chat/actions/runs/37257405954)
and all six functional jobs in the [scoped workflow](https://github.com/ktimam/open-chat/actions/runs/37257406050)
passed. The full local frontend run passed 6,020 tests in 359 files; Svelte
checking reported zero errors and 573 existing warnings. The scoped workflow's
advisory job remains red only for the previously recorded exact deferrals below;
this is not a clean security scan or public-release approval.

At that main checkpoint, `168ea567521d19e7a75654ae1b9ab0eccb989c4d`, all four jobs in
the [frontend workflow](https://github.com/ktimam/open-chat/actions/runs/37266684333)
and all six functional jobs in the [scoped workflow](https://github.com/ktimam/open-chat/actions/runs/37266684269)
finished successfully. Only the dependency/advisory job failed. Read-only comparison
of its existing reports found the same deferred braces finding and ten Rust
package/version/advisory tuples, with no new finding tuples. The gate remains red;
this comparison is not a fresh audit, reachability assessment or security clearance.

That main follow-up's **test-only** addition exercises `draftView` in both saved and source
presentations using the real workspace with mocked native/browser delivery.
The focused card/native UI suites pass 87 tests, including eight new cases for
complete canonical review outside app paint, edit revocation, explicit native-only
pairing, separate Copy/Open consent, no automatic send/retry on reopening, and
fail-closed native routing. The subsequent full frontend run passed all 6,028 tests
in 359 files, with zero failed or pending tests. Its retained JSON report is
`F:/Temp/OpenChat-IOU/card-view-native-coverage-20261005/frontend-full-tests.json`
(SHA-256 `1bba8d890ec8d57293e683568760333d6bc7f3d2c758fabb66bd406658383a1f`).
These tests and this checkpoint postdate build031's source commit; they do not
change its production bytes or relabel its artifacts. The earlier 6,020-test
result remains the exact-commit evidence for build031. Mocked adapter tests are
not emulator, cryptographic transport or receiver-save evidence.

The exact 17 offline feature-helper suites subsequently passed all 705 tests
without failures or skips using the pinned Node 24.18.1 runtime. The log is
`F:/Temp/OpenChat-IOU/card-view-native-coverage-20261005/offline-release-contracts.log`
(SHA-256 `4f11353856d62e0806614d5b56d308453ed34421bbe9ad95351bb37dc9aeafa6`).
This is local offline contract coverage, not a hosted run, advisory query or
clean-security claim.

### Historical030 source and artifacts

APK030 and web030 v1/v2 were independently verified against fork main commit
`9b203c76e0c49b68f16def97aff462c7d974e32d`, tree
`0f9a35a46da95a10237e486349c41637bd1cae43`. This includes upstream
`65e265f027cc50a1ea333dd94acbb7816992b54c` through merge `b76e411fe`.
The OpenChat backend tree is exactly upstream's
`57820102df62dcfbb50fc934cf7d41171228d81c`; no modified OpenChat canister is
required or deployed for these client changes. The frozen source inventory covers
6,672 selected committed files, SHA-256
`f8b6ecabb391489d98886ad94a438e2509ba8e35e8e520a08c65f3479c32a9d5`.
The pre-existing snapshot status anomaly was recorded, preserved and excluded as
a working-tree input; its committed and working bytes matched. This is not a
claim that the checkout was clean. Later documentation edits do not relabel builds.

Both APKs use package `dev.openchatfork.localtest`, version `0.0.1`/code `1`,
build ID `93196addd14106dc1e3455224a46f2bc`, and the same local-test signer as
APK029. The frozen frontend and embedded APK assets were checked independently.

| APK030 target | Bytes | APK SHA-256 |
| --- | ---: | --- |
| x86_64 | 72,400,315 | `f1688e0afd36c8617e2632136e3c03a6249ce087a471f6ac11a8b08be1c55881` |
| aarch64 | 79,675,705 | `acd4dbaaa5ae57d8c89c7fe0569bab519ba5086e39dfbf2f1584470dd780e8c9` |

Retained reports under `F:/Temp/OpenChat-IOU/native-transport-apk-030/artifacts/`
are `APK030-VERIFIED-x86_64.json` (SHA-256
`da15ab16aa16290c393f5b11ff4ce644cdff2d64062eac34b7d912b7af1579be`)
and `APK030-VERIFIED-aarch64.json` (SHA-256
`06d5820d600b38c1f1dcdae49efafe1efdce7e3bd3fe30bd7e5d0d3ff19c6769`).
Their static artifact passes expressly do not grant device/provider, model,
delivery, CI or release acceptance.

Web030 v1 is `2.0.0-localtest.c13dcd443fb3d40c7a52a0283981f687`; v2 is
`2.0.0-localtest.67c940418b9778d2c3ff7d01192fe0b9`. Both retain official
backend configuration, local-only app support and disabled official OTA. Reports
under `F:/Temp/OpenChat-IOU/web-qualification-030/artifacts/` are
`WEB030-VERIFIED-v1.json` (SHA-256
`56229d931cd628b12a58457fd3c6da5a281ee174680d6c7ed15d48c2cb05ab2e`)
and `WEB030-VERIFIED-v2.json` (SHA-256
`6d3fa39734222fdd92295a984a62aff357888704eb9acd6123bbe049b5f512a0`).
These verify exact tracked source, emitted card sources and output bytes/config;
they are distinct from the normal-UI observations below.

The APK build was **not fully offline**. The Gradle wrapper downloaded its
8.14.4 binary distribution before the dependency-resolution offline policy took
effect. `GRADLE-WRAPPER-BOOTSTRAP-OBSERVATION.json` records that the ZIP matched
the committed and published SHA-256 and all 317 unpacked files matched that ZIP.
The preflight had checked the launcher, not every wrapper cache-readiness condition.
This verified toolchain bootstrap was not a model download; offline dependency
resolution does not imply an offline wrapper bootstrap.

### Earlier UI and CI evidence, with limits

Normal browser checks on web030 v1 desktop and v2 at 390 CSS pixels restored the
existing synthetic saved card at its source message as a non-modal inline region.
The amount/date/Type fields were retained, with two-column controls, a full-width
note and no horizontal overflow. The respective UI receipts are
`web-v1-inline-card-ui.json` and `web-v2-mobile-inline-card-ui.json` beside the web
reports. No new model proposal, send or IOU save was established by those checks.

On the persistent emulator, APK030 x86_64 was installed over APK029 with
`adb install -r`; package signature and installed APK hash matched the reports.
No uninstall, data clearing, new passkey or account creation was used. Normal
launch restored the existing account/chat and enabled app setting. The existing
device-local synthetic card retained all seven fields and was attached to its
original message row, not shown in a modal. At 411 CSS pixels, the card and all
controls fit the viewport. Restoring it required fresh review; no approval or
send was restored. The receipt is
`F:/Temp/OpenChat-IOU/card-ui-restoration-20261005/apk030-emulator-inline-card.json`.
This proves upgrade/restoration/layout, not fresh inference, delivery, receiver
persistence or ARM/physical-phone runtime. Screenshots and private fixtures remain
outside the repository.

Presentation fidelity means the compact source-attached card flow is restored.
It does **not** mean pixel-identical reproduction of the former backend-authored
arbitrary-HTML card. The current host renders generic schema fields and keeps
the card private to this device; app-owned interpretation and encrypted, explicitly
approved delivery remain separate from presentation.

**App-authored card presentation acceptance remains a release requirement.**
Build030's inline placement alone did not restore it: its generic form differs in row
grouping, control style, note control, review chrome and consumed/read-only behavior.
The original app's pure card UI remains available in its own repository. Restoring
that presentation must not restore a remote app iframe receiving unapproved draft
values, per-draft backend attestation or application-specific fields in OpenChat.
The implementation committed in build031 supports optional action-level `draftView` metadata: the
verified public catalog binds a bounded, inert layout, palette and canonical field
references. Private connection setup must contain exactly that public view. No
new iframe, executable DOM code, network endpoint or app-specific host field is
introduced. Existing choice/default callbacks, date validation and pending-edit
guards remain authoritative. The main card uses the app layout while editing,
then displays the complete canonical outgoing values outside app paint after
Review, before the existing explicit confirmation and encrypted send. Any edit
revokes that review. Delivered cards use host-owned read-only mode and labels.
The original IOU row groups/palette and single-line note are supplied by IOU;
its catalog-only export retains the exact published processor bytes and
prompts. The normal-flow mounted web/native suite passes 79 tests, including seven
new view-flow cases. This source integration is not present in build030, and unit
tests are not proof of rendered browser/APK fidelity or final delivery acceptance.
Subsequent working-tree verification passed all 5,995 frontend tests in 359 files;
Svelte checking remained at zero errors and 573 existing warnings. The later
modal-only keyboard fix brings the full passing suite to 6,020 tests in 359 files.
It adds initial focus, Tab containment and safe focus restoration only for the
saved-card modal, without trapping inline cards or replacing the live editor.
Its targeted surface/parent suite passes 91 tests. The build031 normal-browser checks
above now cover keyboard behavior; installed-APK UI verification remains pending. A separate
synthetic Edge component harness exercised the actual IOU package producer and
OpenChat renderer at 390 and 720 pixels, in both themes, with one/two entries.
It confirmed 44-pixel controls, no horizontal overflow, visible dark-mode native
date controls, Type defaults/manual overrides, optional-date removal, a None-only
empty Type roster and wrapping of an unbroken 630-character read-only note.
The harness has no account, persistence, model or delivery capability. Its source
receipt and screenshot are under
`F:/Temp/OpenChat-IOU/card-view-visual-final-20261005/`; these observations do not
qualify the normal browser flow or emulator, and do not relabel build030.
Arbitrary app JavaScript must not run in a DOM frame with the draft; an opaque
sandbox and network CSP alone are not a complete self-navigation/leakage boundary.

At build030's exact source commit, the [frontend workflow](https://github.com/ktimam/open-chat/actions/runs/37244560682)
passed. All six functional jobs in the [scoped feature workflow](https://github.com/ktimam/open-chat/actions/runs/37244560738)
passed, including both native platforms, Android compilation/lifecycle contracts,
frontend model contracts and the small pinned real-inference fixture. That fixture
does not qualify the production image models. The retained local final frontend
log reports 5,849 tests in 357 files passing; Svelte checking reports zero errors
and 573 warnings, not a warning-free check.

The scoped workflow remains **red** at its dependency/advisory job. The npm result
is the already deferred `braces@3.0.3` / `GHSA-vfj7-8cjw-p6xm`; the ten Rust
advisory rows match the recorded exact-version deferrals. See the
[npm disposition](releases/npm-feature-advisory-triage.md#october-4-local-test-braces-deferral)
and [Rust disposition](releases/rust-feature-advisory-triage.md#october-2-local-test-deferral).
Collection/schema checks and scoped licenses passed; findings and conservative
scope/freshness limits remain disclosed. Deferral is local-test-only, not a clean
scan, suppression, broader waiver or public-release approval.

### Historical build031 acceptance work

The list below records the earlier build031 state. The October 6 checklist above
supersedes its current-status claims, including local IOU readiness and final
reconnect/delivery. Inactive expanded-contract research is not a new PR-parity gate.

- **Restored app presentation:** packaging and normal-browser saved-card keyboard
  checks are complete for build031. Complete fresh IOU Connect/new proposals for app-view
  adoption, then normal inline editing, saved-card restoration and encrypted
  delivery on the emulator. Installing build031 and the synthetic native adapter tests
  do not establish its post-install UI/session or delivery behavior.
- **App-owned image contract:** the expanded direction/multi-entry candidates are
  inactive; shipped prompts, weights and configuration have not been replaced.
  The later R3 compact six-slot Gemma candidate returned both synthetic invoices
  within the unchanged 96-token cap and passed the Arabic and missing-date cases.
  A fourth case repeated the printed currency inside the amount slot: the original
  strict format failure remains recorded. A separately versioned inactive adapter
  accepts only the exact repeated currency token and passes retained-output replay;
  this is not a fresh end-to-end inference pass. Qwen's R3 grouping candidate still
  truncated the two-entry output. A synthetic-only instrumented trace proved both
  96-token exhaustion and an already-complete first entry omitting printed direction;
  raising the limit alone would not fix it. Single-entry Arabic/missing-date cases
  passed their prospectively declared output policy. Structured-output replay alone
  is not image accuracy. Qualify the chosen contract on the retained corpus, conflicting/missing
  evidence and repeated use before activation; keep resource and complete-output
  guards intact.
- **Footer-only user Type matching:** factual matching remains unqualified.
  Private Type data must reach an app-owned prompt through an allowed, verified
  contract without weakening publisher binding or introducing IOU logic into
  OpenChat. The inactive template-mutating approach fails current binding;
  existing generic rule guidance is a possible route to investigate, not yet a
  qualified solution or proof that a new host API is required.
- **Local IOU readiness:** the strict existing-state restart rejected an incomplete
  saved NNS checkpoint and port 8080 was unavailable. No reset, new canister,
  deployment or repair was performed by that check. A separately authorized,
  fresh-backup-verified recovery and readiness check are still required; prior
  backups must be retained and uncheckpointed writes may be unrecoverable.
- **Final normal flows:** after recipe qualification and IOU recovery, verify fresh
  web/APK proposals, local persistence, exact-request approval, encrypted handoff,
  receiving-app review/save/readback and repeat/recovery behavior on the intended
  configuration. Earlier successful delivery receipts remain labelled to their
  original builds; APK030's saved-card check does not replace these steps.

Physical-phone testing, public branding/domain, public provider qualification and
public publication remain deferred. Optional voice retains its documented
synthetic-recording limitation. Neither those choices nor exact advisory deferrals
waive the image/Type/IOU acceptance work above.

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
4. Edit the inline card using its app-labelled fields. The optional **Details**
   disclosure contains exact outgoing values and secondary field controls, not a
   separate JSON editor or setup page. Nothing is posted to the chat or sent to the
   app for card verification. Every edit invalidates the previous approval.
5. Confirm the full request, including its destination and recipient review label.
   OpenChat encrypts the fields before handing them to a separate browser relay.
   The relay directly presents the receiving app's normal UI in its bound frame;
   it cannot read the fields. There is no intermediate transport review, manual
   pairing step or extra Open button in either browser or local-test APK.
6. Sign in to the app, decrypt for the linked destination, review the full fields and
   actual account/destination again, then explicitly save there. IOU uses its normal
   sheet's **Pending from chat → Review & add** and existing entry/batch review.
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

Use **View private card** at a retained card's source message to reopen it. There is
no separate saved-card manager, and reopening restores neither sending consent nor
a handoff. **Disconnect** in
app details removes that app's connection and chat opt-ins but retains its cards.
Those cards stay inspect-only until a matching connection is restored and reviewed;
a changed connection cannot silently retarget their fields or destination.

The local-test APK uses a separate ten-minute setup bridge. A one-use random launch
fragment is immediately removed from the browser URL and authenticates the initial
local request; it never goes to the app publisher. The app's response is accepted
only from the expected app frame/origin and nonce, then revalidated against the public
package before installation. Neither HTTP GET nor the app receives an OpenChat
session, chat history or draft. Closing/reloading an unfinished bridge requires a
fresh Connect; it does not automatically retry.

The explicitly enabled unofficial browser profile offers all-WebGPU models on
desktop as well as mobile. Select/download them in **On-device models** before
processing a message. Model visibility does not bypass hardware, image-decoding
or verified-download checks. Native WebGPU packaging remains Android-only; this
does not enable desktop native/iOS or change the official client's platform policy.

### Local-test APK browser handoff

Confirming the inline card opens the normal receiving app directly through the
local transport. No pairing-code entry, clipboard step or second Open/Load button
is required. Internally, a one-use launch fragment is removed before the app frame
loads; it contains a transport capability, never fields, account IDs or credentials.

The capability expires after two minutes and can claim the encrypted approved draft only once.
After a successful claim, the browser has up to ten minutes to complete delivery.
Review the destination and recipient on the inline card before confirming.
The relay cannot display or decrypt the fields; they were encrypted inside OpenChat.
The receiver accepts only its configured exact sender origin and bound parent/nonce.
After signing in and decrypting locally, review every field and
its actual account and destination, then save there.
**Received** does not mean that anything has been saved.

Discarding the draft or changing account cancels the pending native handoff. Data
already handed to the receiving app cannot be recalled. If the outcome is uncertain,
check the app before choosing the explicitly confirmed retry with the same import
ID. There is no automatic retry, unsolicited browser launch or clipboard action.
Closing a view is not approval or deletion. Use the card's Cancel action to discard
an unsent proposal; retained read-only cards offer **Remove from this device** in Details.

If the receiving page closes or reloads after **Received** but before saving,
return to the still-open client and choose **Reopen in app**.
First check the receiving app for an existing save, then explicitly acknowledge
the warning. Reopening preserves the entire approved request and import ID; it
does not rerun extraction or inference. The previous handoff is cancelled and a
new browser relay or native transport session is created. Review the same receiving account
and destination again: an app may deduplicate only within that destination, not
across different accounts or sheets. Reopening is unavailable once the current
handoff reports **Saved**, and never occurs automatically.

Private drafts provide generic scalar-field controls from the app's declared schema
for single items and lists. These edit the same canonical payload used for review;
there is no second submission object. Optional absent values are different from an
empty string, zero, false or null. Removing an optional field omits it. Incomplete
numbers do not become zero, and invalid or oversized edits cannot approve or send
the previously valid request. Non-scalar values remain visible in the exact outgoing
values in Details; there is no JSON-editing page in the normal flow. These controls
do not run inference again or interpret an app's private processor context. App-specific dependent choices, such
as selecting a saved template and applying its defaults, remain in the receiving
app unless the app supplies a supported declarative contract for them.

Private drafts also show an app-declared preview: title, disclosure and labelled
fields, repeated for each item. It is derived from the current canonical field values,
not a second submission payload. Additional fields remain visible; hidden text
controls are escaped. Invalid edits block confirmation until corrected. The exact
outgoing values remain inspectable in Details. App-declared button labels do not
change the host's explicit approval, encryption, validation or cancellation boundaries.
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

Private cards are saved encrypted on this device, separately from setup,
scoped to their OpenChat account/backend, without an eight-card count limit. The
collection retains a 16 MiB safety budget and a 256 KiB per-card bound. Closing a view does not delete them.
**Propose again** on the same message/image performs fresh extraction and preserves
the previous card; **View private card** opens the previous result without inference.
Neither operation sends to the app. A new proposal has a new request ID and needs
explicit review/send; the existing card's delivery retry keeps its original request ID.
Canceling an unsent proposal or using **Remove from this device** on a read-only
card removes only that card. Disconnecting its app does not discard it; use its
source message's **View private card** link to inspect it. The former setup
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
an option updates its declared companion fields atomically; their exact values are
inspectable in Details rather than separate main-form controls. Clearing a choice
removes its companions and restores the original defaulted values, unless the user
has explicitly edited those values.

Choice history remains in the current draft session through closing/reopening the
panel and changing the recipient. It is not saved with app setup/card or sent to the app.
After reload or logout/return, restored card values are treated as manually supplied:
choices still update their companion fields, but do not reapply defaults or reconstruct
the previous baseline on clearing. Edit those values explicitly after restoration.
The normal flow has no Advanced JSON editor. Unknown choices or inconsistent companion
values block review. Every edit invalidates the previous approval; changing a choice does not run a
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
- The handoff binds exact origin, receiver frame/parent and fresh nonce; encrypted AAD binds destination,
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

### Historical build031 completion checklist

Use the [October 6 checklist](#current-local-test-completion-checklist) for current
status. The following retains historical evidence, not new requirements to rebuild
or repeat every test. Documentation changes do not change packaged source identity.
This checklist reflects the [October 5 build031 checkpoint](#historical-checkpoint--october-5-2026);
the dated build026–030 results below remain historical rather than current-build passes.
The latest local-only evidence also includes 705 passing offline feature-helper
contracts from 17 suites; it does not change the failed advisory-gate disposition.

| Requirement | Current evidence | Remaining boundary |
| --- | --- | --- |
| One fork main; official OpenChat services and unchanged OpenChat backend | The tested/published main checkpoint is `168ea567521d19e7a75654ae1b9ab0eccb989c4d`, a test/docs-only follow-up to packaged source `7eba7881bd6b63a65f662804543a32dd7740e232`, incorporating upstream `65e265f027cc50a1ea333dd94acbb7816992b54c`. Both web031 layouts and APK031 ABIs remain bound to `7eba788`; fork/upstream backend trees both equal `57820102df62dcfbb50fc934cf7d41171228d81c` | No custom OpenChat canister or backend deployment is required. Later test/documentation changes do not relabel the 031 binaries; historical runtime evidence keeps its original artifact identity |
| Normal Apps UI; no technical setup/import page | Both web031 layouts passed independent source/artifact verification and normal Edge reloads. The existing account, Kiko chat and seven saved cards remained; normal Apps navigation and saved-card focus entry, Tab containment and close-focus restoration passed. Actual mobile v2 at 390 CSS pixels had no document overflow and at least 44-pixel observed fields. V2 was restored at localhost:5190 | These normal-browser observations used saved cards with frozen old app setup and the new compact fallback renderer. They do not qualify fresh app-owned draftView adoption, new proposal editing, inference or delivery. APK031 post-install UI remains unverified |
| Automatic app discovery and explicit connection | The frozen IOU frontend now serves `d3ed5dc0ed1d876a79d08197c207dbba3074b2aa`; all four public catalog/processor files matched the committed snapshot, and the import page returned HTTP 200. Its sign-guard fix leaves active prompts and draftView unchanged from the earlier `7b469` rollout. Earlier desktop reconnect and the October 4 APK Apps → IOU Connect → approved setup-share/restart evidence remain bound to those historical checks | Fresh IOU Connect and new proposals are still required to adopt the public draftView in 031. Existing saved-card snapshots intentionally do not update. A directory response is not local-backend readiness or new connection acceptance |
| Encrypted persistent private cards | Web031 reloads retained seven existing saved cards without editing or sending. Historical build026 desktop, APK028 restart, APK029 retained-card and APK030 source-inline restoration receipts remain applicable only to their tested artifacts. The later synthetic card/native suites pass 87 tests, including saved/source views with canonical review, edit revocation, native-only routing and no automatic send/retry | APK031 is installed but its session/card restoration has not been observed. Fresh app-view proposals, persistence and recovery still need current normal-flow acceptance. Mocked adapters do not prove ciphertext, device storage or receiver persistence; delivery receipts remain session-only and attempted requests restore as uncertain |
| Confirmed encrypted app delivery | Earlier desktop delivery and the first native Save retain their artifact-bound evidence. APK028's separately approved same-ID retry passed sender-bound consent, encrypted delivery, IOU decryption and second review: 123.45 USD gross, 2026-09-27, You owe, IOU kind and Synthetic acceptance Type; the Type's 10% fee produced 12.35 fee and 111.10 net. One normal Save returned the earlier-save-accepted replay status. A fresh normal sheet reload remained at 14 visible rows and exactly one matching synthetic entry. Natural Back through IOU → relay Saved → APK Saved completed, and the foreground service then cleaned up | This remains APK028 acceptance, not fresh 031 delivery. The receiver account/principal/backend-context digest was compared with the sender after Save, not independently asserted before sending. Earlier expired harness attempts remain failed/unqualified. Current fresh review/encrypted handoff/receiver save/readback and recovery remain pending after local IOU readiness; this text test is not model-image or public-provider acceptance |
| Preserved model features and accurate image proposals | Earlier Qwen/Gemma image results retain their tested artifact/prompt identities, including build026 Gemma core fields and private Type/default matching from a heading. Build031 retains the active prompts, weights and all-WebGPU configuration. Edge control is available again and completed the normal 031 browser checks; separate expanded-image candidates remain inactive | Chosen-contract Qwen/Gemma accuracy, multi-entry/direction, footer-only private Type matching and repeated use remain unqualified as described in the current checkpoint. The October 4 emulator null WebGPU-adapter/Vulkan observations are historical preflight failures, not current 031 inference or phone-regression evidence. No fallback or token-limit waiver follows from those observations |
| Separate local APK and account preservation | Both APK031 ABIs passed independent package/source, embedded-asset, native-library, signer, manifest and DEX verification. X86 was installed in place; the installed SHA matched `dac1c303528d9fc3c800f645563e0b6443752be36ce71dd595497036dd5610f0`, first-install time remained September 30, and no data clearing occurred. ARM SHA is `dc8d1113851129594c0ae2bc6844addd929343eb8e35c363a10b21bec6878501` | Installation and hashes do not prove APK031 launch/account/card restoration, native delivery or inference. Those post-install UI checks remain pending. Historical APK029/030 account/card observations are not relabelled. Physical-phone and public-provider qualification remain deferred |
| Scoped OpenChat source and hosted verification | Build031's exact source passed 6,020 frontend tests in 359 files; Svelte had zero errors and 573 existing warnings. Exact-commit [frontend run 37257405954](https://github.com/ktimam/open-chat/actions/runs/37257405954) and all six functional jobs of [scoped run 37257406050](https://github.com/ktimam/open-chat/actions/runs/37257406050) passed. The `168ea` follow-up passed 6,028/6,028 locally with eight test-only additions; all four jobs of its [frontend run 37266684333](https://github.com/ktimam/open-chat/actions/runs/37266684333) and six functional jobs of its [scoped run 37266684269](https://github.com/ktimam/open-chat/actions/runs/37266684269) finished successfully | Only the dependency/advisory job remains failed, for the recorded exact [braces deferral](releases/npm-feature-advisory-triage.md#october-4-local-test-braces-deferral) and ten Rust advisory tuples covered by the [local-test deferrals](releases/rust-feature-advisory-triage.md#october-2-local-test-deferral); the current run added no finding tuples. These are not clean scans, freshness guarantees, future-finding waivers or public-release approval. The 6,028 result does not relabel 031's source snapshot |
| IOU functional verification and advisory disposition | The current frozen frontend is IOU `d3ed5dc0ed1d876a79d08197c207dbba3074b2aa`; public file verification is recorded above, but port 8080 remained unreachable and no recovery was performed. Historical isolated IOU `577f05938d27de0169bb86a1b3a1871a064295c4` passed 1,980 scoped unit tests, 100 integration tests and scoped no-emit checking against OpenChat `ed3587edf17647645722bc9eeb89c6e90309e5c1`; these are not new 031 acceptance | Backed-up authorized recovery/readiness and final normal flows remain required. Mocked boundaries do not establish live persistence/UI/accuracy. The October 4 [IOU advisory deferral](https://github.com/ktimam/IOU/blob/main/docs/unofficial-openchat-client-release-plan.md#october-4-local-test-iou-advisory-deferral) covers the recorded ip-address, fast-uri, brace-expansion and Hono findings only; reachability is unestablished and the audit remains failed. Previously skipped hosted jobs remain skipped |

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
component tests. At that source-only checkpoint, full APK compilation and emulator
regression remained separate pending gates; the APK028 checkpoint below records
their later outcome. No second IOU Save occurred during those source tests.

The first hosted checkpoint, `a9ddd2ed1`, exposed two incomplete CI inventory
updates: the collector still capped profiles at eight after the two listener-test
profiles were added, and the license policy still bound the previous source-scope
hash. The selected local suites had not included these collection/license checks.
The complete offline workflow command is now required before packaging this fix.
The bounded collector accepts ten profiles and tests rejection at eleven; the
license binding is refreshed only after confirming all 26 dependency owners,
39 license package entries, model identity resolutions and lock identity are
unchanged. No advisory, license obligation or completeness check is waived.

#### October 4: APK028 build and emulator lifecycle acceptance

Both APK028 ABIs use source `d5674086e08070e96e4955db86f143f2ab424bae`,
tree `4738098e9feaacd91b1284cb1c9f232c7ac7eb7e` and build ID
`c70f4acd75095751078cac6a3b7fc7e1`. Independent verification covered 6,662 source
files, 1,795 frozen frontend files, 39 compiled feature-source proofs, exact native
library packaging and the original package/signing identity. The new nonexported
dataSync service and its defined lifecycle/command DEX signatures were verified.
The first verifier rejected an R8 inline frame as ambiguous; its failure and source
were preserved. The corrected outer-frame parser passed positive/negative fixtures
before both final artifact checks passed.

| Artifact | SHA-256 | Independent report |
| --- | --- | --- |
| [APK028 x86_64](F:/Temp/OpenChat-IOU/native-transport-apk-028/artifacts/openchat-fork-local-test-x86_64.apk) | `44a06e3717870a83f199fbe91430b05533a7ce0db1c7a10a6316ac93762ada7a` | [Report](F:/Temp/OpenChat-IOU/native-transport-apk-028/artifacts/APK028-VERIFIED-x86_64.json), SHA-256 `90c522fbc23fa73468187d1ceb950fdb1a17d48ae0f6317ea6450993401e2d60` |
| [APK028 ARM](F:/Temp/OpenChat-IOU/native-transport-apk-028/artifacts/openchat-fork-local-test-aarch64.apk) | `173ee712eeabde42ee7949d6e6a39729c0e00ebcc256c86bdada4c0d216c38ad` | [Report](F:/Temp/OpenChat-IOU/native-transport-apk-028/artifacts/APK028-VERIFIED-aarch64.json), SHA-256 `bdeb747907e99dd934188413043076877558fb035e569778ed5780346ca7a9cc` |

The [sanitized emulator acceptance receipt](F:/Temp/OpenChat-IOU/native-auth-callback-20261004/native-post-fix-lifecycle-acceptance.json),
SHA-256 `d00e4b23bdec178f3bad5dcfca50202a42d807690d99d8b659824a7d7394b69a`,
records the in-place update, retained account/chat/card, same-ID recovery with fresh
approval, encrypted IOU delivery, one replayed Save, unchanged bounded visible
ledger and natural IOU → relay → APK return described in the checklist. Android
kept the APK at process state 4, unfrozen, with its foreground service active for
more than 45 seconds while Chrome was foreground; the service count returned to
zero after completion. This closes those APK028 native lifecycle/delivery gates,
not model-image accuracy or physical-phone acceptance.

The IOU identity/sheet and public backend context were independently pinned before
Save; their digest was compared with the sender's descriptor only **after** Save.
No independent pre-send identity proof is claimed. The accepted attempt used an
already-authenticated receiver. The earlier background-Chrome diagnostic timeout
and authentication-return consent expiry remain failed/unqualified observations;
the latter's reload/return cause is not established. No total-ledger count or
ledger-row-to-import-ID link is inferred from the bounded readback. Fresh normal-UI
Qwen acceptance remains pending while Edge control is unresponsive; the emulator's
null WebGPU adapter supplies no inference result. ARM remains static-only, and
later documentation commits are not relabelled as APK028's packaged source.

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
The user subsequently deferred that recorded newer IOU finding set for local
testing on October 4; see [the exact decision](https://github.com/ktimam/IOU/blob/main/docs/unofficial-openchat-client-release-plan.md#october-4-local-test-iou-advisory-deferral).
Reachability remains unestablished. No dependency was upgraded, the audit remains
failed, and the functional jobs skipped behind it remain skipped.

#### October 4: final merged-source web029 and APK029 checkpoint

Pushed main `4f4f23c6f022b4051ae86c49f0f8e7c3f7a13ef4`, tree
`1fd2efead0028bab6c5e45adb0789a373976b55f`, integrates fixed upstream
`98a178bef2d67efb6b85a5772a6164fe7134074c`. Its one incoming commit restores
draft text when the desktop/mobile composer editor is recreated; five files
change with 195 insertions. No backend, dependency, model, prompt or native
transport implementation changed. Both build families materialize the same
6,664-file committed source inventory, SHA-256
`d43f68809f78f6ee7ea6063fdf5c2a22d2dc1c49eaa553a622e50dcb1633df30`.

The [web029 result](F:/Temp/OpenChat-IOU/merged-main-web-029/WEB029-RESULT.json),
SHA-256 `6fea12847c229d0c8bfaee4e916d9651ad816deffb65cb73b032f3d8ea94a893`,
records independent verification of both layouts: 1,793 files and 50 source-map
proofs per layout, including both composer implementations. The v1 version is
`2.0.0-localtest.e405e008996d975e5889e95931a0603a`; v2 is
`2.0.0-localtest.54759ae4ad5b3f6f795a0baa89629d25`. The
[served-v2 receipt](F:/Temp/OpenChat-IOU/merged-main-web-029/SERVED029-RESULT.json),
SHA-256 `fad9ed19137ec72a97cf78f1f87c7025106039a2d2cd7a28c7cc5b6fdf03bf81`,
confirms the unchanged localhost:5190 origin, manifest/communities HTTP 200,
expected isolation headers and available IOU directory. Browser profile/storage
were not changed. V1 was verified but not served; these checks do not prove a
fresh browser sign-in or image proposal.

Both APK029 architectures use build ID `c00b49dc0224d3d85c06ae78fc481b4f`,
1,796 frozen frontend files and 39 compiled feature proofs. The separate
`dev.openchatfork.localtest` package and signer are retained. Original native
authentication and OTA-disabled configuration remain unchanged.

| Artifact | APK SHA-256 | Independent verification |
| --- | --- | --- |
| [APK029 x86_64](F:/Temp/OpenChat-IOU/native-transport-apk-029/artifacts/openchat-fork-local-test-x86_64.apk) | `7e56e4d35f12cffeb427fd895d385a7b367f361e512986cc4d137bb1f05db14f` | [Report](F:/Temp/OpenChat-IOU/native-transport-apk-029/artifacts/APK029-VERIFIED-x86_64.json), SHA-256 `c67170ee0c2f98141a200f4ad7a8f36985261785829eac0557c705dd32703149` |
| [APK029 ARM](F:/Temp/OpenChat-IOU/native-transport-apk-029/artifacts/openchat-fork-local-test-aarch64.apk) | `906d673ba5c76a224b615a906c26c338c226b1c7dd83437661fa8976896d2633` | [Report](F:/Temp/OpenChat-IOU/native-transport-apk-029/artifacts/APK029-VERIFIED-aarch64.json), SHA-256 `2714e31cec5193bf4666b3b5eb9419c1fe5f5d599fdc056a70f40a01485b52ce` |

The x86_64 in-place install matched the verified APK hash and retained the
existing account/Chats/Kiko state. The
[normal Apps saved-card smoke](F:/Temp/OpenChat-IOU/native-auth-callback-20261004/apk029-saved-card-smoke.json),
SHA-256 `8420384a72bf414b690f3136f31a6c45dfed81411c5d719af62d61c3512a07ec`,
restored the known 123.45 USD / 2026-09-27 / You owe fields, IOU kind,
Synthetic acceptance Type and empty note. It required recovered-request review,
with no restored approval or active send/retry/pairing controls. The previous
Saved receipt was not displayed: delivery receipts are session-only, and an
attempted request restores as uncertain. No new review, transmission, IOU save,
ledger readback, model operation or authentication action was performed.
APK028 retains the earlier encrypted-delivery/dedup/lifecycle acceptance; it is
not relabelled as an APK029 delivery test. ARM phone runtime remains untested.

A separate manual daemon-stop command used the wrong Gradle home and
unexpectedly downloaded/unpacked 289,481,711 bytes across 320 duplicate files.
The exact duplicate home was removed after validation; the approved cache was
retained. The [incident receipt](F:/Temp/OpenChat-IOU/native-transport-apk-029/artifacts/GRADLE-WRAPPER-STOP-INCIDENT.json),
SHA-256 `1cdfd6f23c59c147c17f605641adfbcc798626415301031a1a33ab922f08f479`,
preserves that interruption and the uncertainty about execution before it.
The x86 verification predates the incident; ARM used the unchanged reviewed
builder and correct cache. This checkpoint does not claim that every surrounding
command was download-free.

The [initial hosted CI observation](F:/Temp/OpenChat-IOU/upstream-98a178b-verification/hosted-ci-4f4f23c6.json),
SHA-256 `c132ed491dc3708da16229e2dac6898930da96d68dff827037e95a5753be133f`,
preserves the earlier retrieval limitations. The later
[existing-report reconciliation](F:/Temp/OpenChat-IOU/upstream-98a178b-verification/rust-report-recovery-20261004/reconciled-rust-findings.json),
SHA-256 `564e88bd32c6e603eda47d98df0a118fe7212e6009e1705d4879d0935ed298d7`,
matches all ten Rust findings to existing exact deferrals and all 29 source
bindings, Cargo lock and scope configuration to the tested commit. The recovered
collection is complete, but the advisory gate remains failed, its database
freshness is unverified, and release acceptance remains false. This recovery
read an existing report; no new scan, suppression or dependency change occurred.
The [offline 829-contract receipt](F:/Temp/OpenChat-IOU/upstream-98a178b-verification/current-client-security-offline-merged.json)
supports the functional checklist. The
[isolated IOU functional receipt](F:/Temp/OpenChat-IOU/iou-main-577f059-functional-20261004/results/functional-verification.json),
SHA-256 `046b53a05c0a79915384186da7729d62ae0311a24097760dc3994a4a4ebead6f`,
binds its 1,980 unit and 100 integration tests to the source identities stated
above, not to new browser/emulator behavior. Fresh normal-UI Qwen image acceptance
remains open. The newer IOU advisory decision is now deferred for local testing,
not fixed or suppressed. Optional voice, phone and public-release deferrals are
unchanged.

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
without deleting the cache or changing the tested prompt. At that October 3
checkpoint the native IOU login return remained unresolved. The later APK028
checkpoint proves post-save native return using an already-authenticated IOU
receiver; it does not establish the cause of the earlier authentication-return
timeout or convert desktop login into public-provider proof.
