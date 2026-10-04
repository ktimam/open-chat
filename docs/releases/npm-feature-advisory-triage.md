# Selected npm model-dependency advisory triage — September 15

This note covers only the two public findings in the approved npm bulk-response
diagnostic, matched to the retained selected model/app dependency inventories.
The initial finding assessment is retained below, followed by the narrowly scoped
patch and installation follow-up. Neither is a whole-core audit or release approval.

## Source and response identity

The inspected published candidates are:

- PR1: `3ea234c43c576c664bce669354784d2a5d3883ce`.
- PR2: `2b17aa16e973c573f1ac28476639aa7c2417df36`.
- Reconciled upstream base: `df9d9ed52db00e87fbb7309280a325902c9bb2cc`.

The exact retained raw response has SHA-256
`bb43a9b2d6a6ef5ea522955e623c50f9f3de61ee1786d939678fbfea5b3dbe11`.
Preserve those bytes and the original failed check results. A raw diagnostic
response is not by itself complete source-bound collector or release acceptance.

## Findings and ownership

| Finding                                                                                               | Exact selected dependency path                                              | Affected and patched versions                                         |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| High — [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) | `@huggingface/transformers@4.2.0 → sharp@0.35.3`                            | Affected: `<0.35.4`. Patched: `0.35.4`.                               |
| Moderate — [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)                   | `@huggingface/transformers@4.2.0 → onnxruntime-node@1.24.3 → adm-zip@0.6.0` | Affected: `>=0.5.9 <=0.6.0`. No patched release listed when reviewed. |

The direct selected root is `@huggingface/transformers@4.2.0`. The reviewed
parent-scoped overrides select Sharp `0.35.3` and adm-zip `0.6.0`; the parent
requests are respectively `^0.34.5` and `^0.5.16`. The retained model inventory
records these effective edges as valid.

None of Transformers, Sharp, ONNX Runtime Node or adm-zip is present in the
reconciled upstream base lockfile. Both exact candidate heads contain the listed
identities. These are therefore **PR1-introduced model dependencies**, not
inherited OpenChat core findings. PR2's additive app-only inventory contains
neither advisory package; its combined assessment inherits the unchanged PR1
model dependency closure.

The September 14 user-directed inherited-advisory deferral documents ten
Rust/OSV findings in [the Rust triage](rust-feature-advisory-triage.md). It does not
cover these two npm findings. Their presence in the PR2 stack does not turn them
into upstream-inherited dependencies or extend that deferral.

## Relevant reachability and verification limits

Sharp is the Transformers Node image-decoding backend. Its maintainer describes
libheif vulnerabilities affecting untrusted input, including possible code
execution under certain glibc Linux conditions. The patch supplies libheif
`1.23.2`. Browser/WebWorker image handling in the inspected Transformers source
uses `createImageBitmap` and `OffscreenCanvas` instead. This separates the Node
dependency finding from the browser inference path; it is not a whole-artifact
absence proof or a demonstration of a phone WebGPU vulnerability.

adm-zip is used by ONNX Runtime Node's installer to extract selected NuGet
entries. The inspected `script/install-utils.js` creates a timestamp-named
directory under the system temporary directory and calls
`extractEntryTo(zipEntry, extractDir, false, true)`. The final argument enables
overwrite. The advisory requires attacker-controlled destination symlinks; this
parent call has the relevant overwrite behavior and a predictable temporary
path. No exploit against the project or its hosts was performed. This is an
installer/local-filesystem concern, not a demonstrated browser image-inference
issue.

The existing actual-parent compatibility checks exercise normal Sharp image
operations and ONNX extraction, copy and cleanup. The ZIP allocation regression
targets a different vulnerability. Those successful tests do not prove
resistance to the current symlink issue or malicious libheif inputs.

## Initial disposition (retained)

The initial conservative known-advisory gate was **failed**. No finding was suppressed
or described as harmless, and no upstream CI or release-policy exception is
claimed. Functional, build and phone checks do not replace this disposition.

The initial triage recommended assessing Sharp's patch and a narrow ONNX installer
mitigation. No patched adm-zip release was listed; an
[upstream proposed fix](https://github.com/cthackers/adm-zip/pull/575) is not a
verified released dependency. No fork was installed or inherited Rust deferral reused.

## September 15 patch and installation follow-up

The Transformers-scoped Sharp override is now `0.35.4`, with the corresponding
`@img` native packages and libvips `8.18.6`. This is the maintainer's patched
release for the high-severity finding above. Exactly 27 existing Sharp-related
lock records change in each PR; no unrelated package versions, model weights,
prompts, Transformers or ONNX runtime versions change.

An isolated Windows x64 check using Node `24.18.1` imported the unchanged
Transformers `4.2.0` Node ESM entry and passed all 42 existing image API checks
against Sharp `0.35.4`. It downloaded only the two required public Windows
archives (8,703,196 bytes total), verified their registry SHA-512 digests and ran
no lifecycle scripts or model inference. This is patch compatibility evidence,
not malicious-image testing, a fresh advisory query or a new phone acceptance
run. The previous mixed pad/crop limitation remains explicitly tested as a
rejection, not counted as a working transformation.

The relevant frontend, model-security and Android dependency-install steps now
set `ONNXRUNTIME_NODE_INSTALL=skip`. PR2's app-interface security install does
the same. ONNX Runtime Node `1.24.3` documents this setting in its installer:
it exits before selecting or downloading optional Node GPU binaries. The setting
does not disable browser WebGPU, the separate native Rust runtime, other npm
lifecycle scripts, or the already bundled Node CPU libraries. The Android install
also uses `npm ci --no-audit`; no whole-core audit is introduced.

A benign check of the pinned installer passed four skip cases and two guarded
ordinary-setup controls, with all file/network/extraction operations inert.
No archive or adversarial filesystem fixture was constructed. Module imports and
proxy bootstrap precede the skip, so this is **not** a claim that the affected
library is absent or never initialized. Workflow regressions require the setting
on every reviewed install and reject additional unguarded install commands.

For a local frontend dependency install, set the variable for that command too:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit
```

In PowerShell, set `$env:ONNXRUNTIME_NODE_INSTALL = 'skip'` for the install
process, then run `npm ci --no-audit`. Do not mistake CI's step-local setting for
a global policy on other manual installs.

The moderate adm-zip finding remains **open**: `0.6.0` is still selected and
no patched release was listed in the reviewed advisory. Disabling this optional
download path is a bounded prevention measure, not a dependency fix or an
allowlist entry. The inherited Rust deferral and accepted model note limitation
do not cover this separate finding.
No advisory gate has been suppressed or changed to report a clean result.

### User-directed deferral — September 15

After reviewing the installer risk and the bounded skip setting, the user chose
to defer this finding and approved the respective branch pushes and disclosed CI.
Retain `GHSA-vwc7-r8mq-g2x9` as an open, deferred moderate finding for the
local-testing/PR-preparation handoff. This is not a dependency fix, a clean scan,
or a change to upstream maintainer release policy. The configured advisory check
may remain failed for the recorded finding; its raw result must stay visible.
Keep the optional Node download mitigation and do not silently enable that path.

Private local compatibility receipts are retained beneath the project-specific
temporary root in `sharp-0354-candidate-20260915-OanUei/` and
`sharp-0354-pr1-candidate-20260915-ee2qMa/`. The initial response identity and
failed historical results above remain intact.

## October 1 narrow adm-zip patch

The user separately approved changing only the existing
`onnxruntime-node@1.24.3` override from adm-zip `0.6.0` to `0.6.1`.
The frontend lock changes only that package's version, archive URL and integrity;
all other package records, parent ranges, model runtimes, prompts and assets are
unchanged. The normalized frontend lock SHA-256 is
`dcba45844bb8ddc1a3acd2e9cd31df61e0a466324ce641462cec4eb398d9689d`.
No shared frontend or Rust dependency was upgraded.

The 35,489-byte registry archive was fetched with lifecycle scripts disabled and
verified against registry SHA-512
`Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==`.
It was first extracted into isolated project temporary storage. The actual
installed ONNX `1.24.3` package metadata and `script/install-utils.js` were copied
byte-for-byte there; no ONNX lifecycle installer, optional binary download or
repository `node_modules` update was performed during that initial validation.

The approved narrow upgrade was then applied to the existing installed package.
All 20 candidate files were checked against the pinned official archive; its file
list was identical to the old package. Only the eight changed files and the
package's single generated npm metadata record were replaced, after backing up
and verifying the original files. The installed package now resolves to `0.6.1`,
and the real canonical ONNX parent passes the same 17 offline checks. No other
dependency, source file, lifecycle script or model asset changed. The backup,
exact file inventories and test log remain in `installed-alignment/` beneath
the patch's project temporary directory.

The real parent extraction/copy helper passes all 11 preceding compatibility and
cleanup checks plus six checks for rejecting dishonest zero-size DEFLATE data and
duplicate entry names without copying an output or leaving temporary extraction
files. The new fixture expands to at most 4 KiB even with the old library; it is
not a large decompression bomb. The old `0.6.0` actual-parent control fails the
new zero-size rejection as expected. A separate bounded old/new comparison
confirms that `0.6.0` accepts both inputs while `0.6.1` rejects both. Socket
creation is forbidden and the parent's HTTPS calls receive only a fixed in-memory
synthetic feed. These checks are not an exhaustive exploit assessment of every
advisory or a Linux/physical-device qualification.

The five existing offline npm contract suites and model CI coverage suite pass
188 tests with zero skips. The real pinned npm/Arborist offline smoke and current
inventory plan pass without forbidden network/install operations. The runtime
source fingerprint remains
`95eb35428d98c8af8b7d7a81af121ccae5275d3aa09b2f8a0adc2a9e0abb0e62`:
151 source files, 25 roots and 86 ownership anchors; no source-review baseline or
historical fixture was rebound for this dependency patch.

One separately approved npm bulk request sent only `{"adm-zip":["0.6.1"]}`
without credentials. At `2026-10-01T16:04:27Z`, npm returned HTTP 200 and the exact
two-byte response `{}` (SHA-256
`44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`).
This establishes no advisories returned for that one requested package/version
at that time, not a new whole-feature scan or a clean overall advisory gate.
The [maintainer's 0.6.1 release](https://github.com/cthackers/adm-zip/releases/tag/v0.6.1)
describes the ZIP fixes. Earlier failed receipts and the exact historical
deferral remain preserved; other npm/Rust findings are not waived or resolved.
All new private receipts are under `adm-zip-061-20261001/` beneath the
project-specific temporary root. No hosted run, commit, push, build or deployment
was performed by this patch validation.

The subsequent already-approved feature-scoped query, verified at 17:38 UTC, used the same
25 roots, 151 source files, 318 public package names and 322 versions. Its only
dependency-inventory change was adm-zip 0.6.0 to 0.6.1, which again returned no
findings. The overall gate still fails: devalue 5.8.1 returned seven advisories,
including six IDs absent from the previous response. These are
`GHSA-j22f-vq7h-c4qm`, `GHSA-hx4r-w6wj-j8fg`, `GHSA-mcm9-63f2-9j32`,
`GHSA-wf3x-273g-mvxv`, `GHSA-x5rw-q4pp-hg5g` and `GHSA-4q55-j62x-fr9h`,
in addition to the previously reported `GHSA-9rgm-9g3h-6x36`.
This records the returned findings, not a determination of application
exploitability. The existing deferrals were not extended to these IDs. No shared
dependency upgrade or additional waiver was authorized by the adm-zip approval.
The exact request, response and scope bindings are retained in
`scoped-advisories-20261001-post-adm061/receipt.json` under the project temporary
root; the repeated Rust query returned the same ten earlier finding records.

## October 2 local test deferral

After reviewing the pending findings, the user explicitly chose to defer the
seven recorded advisories for `devalue@5.8.1` listed above for the unofficial
local-test release. That exact package version, archive URL and integrity are
already present in the integrated upstream baseline; this comparison does not
establish application exploitability or make the findings harmless.

Keep these findings open and disclosed, but do not treat their disposition as
a remaining local-test approval blocker. Preserve the raw failed scanner result;
this decision is not a clean scan, dependency fix, scanner suppression or a
public-release approval. It does not cover other versions or future findings,
and does not authorize a broad OpenChat core audit or shared dependency upgrade.
The separate approved `adm-zip@0.6.1` fix remains unchanged.

## October 4 local test braces deferral

The user explicitly chose to defer the newly reported finding for the exact
selected package `braces@3.0.3`:
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
also identified as `CVE-2026-93687`. This decision applies only to the unofficial
local-test release, not public publication or other package versions/findings.

The reviewed build-asset dependency path is
`rollup-plugin-copy@3.5.0 -> globby@10.0.1 -> fast-glob@3.3.3 -> micromatch@4.0.8 -> braces@3.0.3`.
Its versions and integrities match the pinned upstream baseline. The advisory
describes stack-exhaustion denial of service from deeply nested brace patterns;
build-time ownership and inherited versions do not establish that attacker input
cannot reach the affected functions or that the finding is harmless.

The October 4 primary-source recheck still lists affected versions `<=3.0.3`
and no patched version. The [upstream fix proposal](https://github.com/micromatch/braces/pull/72)
remains open, not a released dependency. No dependency, override, installation,
model prompt or model weight was changed by this decision.

Keep this exact finding open and disclosed, but its disposition is no longer a
remaining local-test approval blocker. Preserve raw failed advisory results and
existing strict scanner behavior: this is not a clean scan, suppression, broad
allowlist, mitigation claim or public-release approval. All earlier exact-version
deferrals remain intact; no other finding is waived. The fresh Qwen normal-UI
acceptance and native IOU connection, encrypted delivery, recovery and readback
checks remain required. No core OpenChat audit or shared dependency upgrade is
authorized by this deferral.
