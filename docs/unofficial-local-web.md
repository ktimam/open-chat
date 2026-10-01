# Optimized local-only web test

This profile builds the existing fork UI against official OpenChat services. It does not
deploy canisters, register accounts, enable custom OpenChat app APIs, publish files, or
impersonate the official website. Public branding, hosting and native APK identity remain
separate decisions. Private app cards are saved locally; delivery requires explicit review
and client-side recipient encryption. See [the required workflow](private-app-encrypted-delivery.md).

Install the reviewed frontend dependencies once using the repository's normal process.
The commands below never run a package installer. First create an **empty, project-specific
temporary directory** outside the checkout, then pass its absolute path:

```sh
node scripts/build-unofficial-local-web.mjs --output /absolute/project-temp/web-build --port 5190 --layout v2
node scripts/preview-unofficial-local-web.mjs --directory /absolute/project-temp/web-build
```

The preview binds only `127.0.0.1`; visit the printed `http://localhost:5190` address,
not its IP alias. The artifact pins its origin/port, so the preview refuses host or port
overrides. Stop an existing server on that port or build for a different port. Both `v1`
and `v2` are supported; upstream uses the selected mobile layout at mobile viewport sizes.

This is optimized JavaScript with development runtime privacy policy: telemetry keys,
OTA, official Android/iOS associations, and native authentication are not bundled for this
web profile. A unique per-build version invalidates cached inference-worker code without
deleting downloaded model weights. Model downloads still use the configured immutable
upstream model repositories; the build does not fetch or host model weights.

The static profile downloads immutable model artifacts directly from the catalog's
pinned upstream URLs. It does not provide the development server's `/hf-model/`
proxy. Packaged, reviewed graph files still come from the local bundle, and the
worker's local cache identities are unchanged. The same routing applies to optional
voice support: installing it adds only the audio artifacts and retains the base model.

The explicit unofficial web profile admits desktop and mobile browsers to the
all-WebGPU model chooser. Use **On-device models** to select or download a model;
actual inference still requires the supported GPU/image APIs and verified artifacts.
The official desktop policy and non-Android native exclusions are unchanged.
Open **Private apps** from the classic main menu/profile, or from
**App settings → Private apps** in the responsive v2 interface, not a floating button.

The output must already exist, be empty, and not traverse a symbolic link/junction. No
output cleanup is performed. If a build fails, preserve that directory for diagnosis and
choose a fresh one for the next attempt. The output includes the reviewed manifest, static
assets, worker/runtime code and a first-party handoff relay. Main-page isolation headers
and the relay's exact non-isolated policy are applied by the preview server; opening
`index.html` directly or serving it through an arbitrary static server is not equivalent.

## Checks

```sh
node --test frontend/unofficialLocalProfile.test.mjs frontend/unofficialLocalWebBuild.test.mjs scripts/unofficial-local-web.test.mjs
```

These tests check configuration, output safety and actual preview HTTP behavior. They
do not prove passkey sign-in, model accuracy, IOU persistence or Android acceptance. Check
the built UI in a browser, use an existing linked localhost passkey with a user gesture,
and separately verify real image proposals and explicit app delivery. Do not silently save
test entries or treat the app's receipt as an independent cryptographic attestation.

The model-routing regressions construct the actual unofficial v1/v2 build environment,
check every base/optional artifact URL and exercise an uncached optional-audio download.
The simulated static server rejects incorrect proxy URLs instead of returning successful
mock responses. These tests reproduced the previous audio HTTP 404 before the fix;
pre-populating the audio cache had hidden that failure in the older test. The focused
runtime/audio suite passes 114 tests. Those tests use small synthetic artifact bodies,
not downloaded model weights, so real download and voice inference remain separate checks.

Both rebuilt layouts passed independent artifact verification on 2026-10-01. The
updated v2 preview restored the existing Edge account/chat and successfully installed
the optional voice add-on without removing either base model. Voice inference is **not
accepted**: a non-silent 5.665-second synthetic clip hit the 96-token completion guard
with the default action. Two bounded `/ai` requests instead copied the textual attachment
label rather than the spoken words, including a request explicitly excluding metadata.
The transcript was never supplied in their prompts. `/ai` also includes bounded recent
chat context, so these are not isolated context-free model tests. No model weights,
default prompts or output limits were changed to turn these failures into a pass.

For the local-test release, the user accepted this synthetic-voice limitation on
2026-10-02: keep voice support optional and document the failure rather than block
that release on it. This is a narrow release decision, not a passing accuracy
test or approval for general voice reliability. Keep the failing evidence and
tests; final APK, authentication, encryption, GPU cleanup and security checks
retain their separate requirements. Public release remains outside this decision.

Four additional tests execute the installed Transformers.js Gemma forward/merge code
with deterministic session outputs. They verify that distinct audio feature values
reach the correct decoder positions, preserve text/per-layer inputs and reject token
count mismatches before decoding. These pass without model downloads. Learned encoder
output is still a test double: these checks do not qualify actual WebGPU speech recognition.

A separate no-weight diagnostic verified the pinned public tokenizer and processor
metadata and used the real tokenizer, template and feature extractor on the same clip.
It produced 142 numeric audio-token IDs with the expected boundaries and finite audio
features. This excludes missing or wrong token placeholders for that input, but not
incorrect learned encoder output or context-dependent generation. The full frontend
rerun including the merge tests passes 5,073 tests in 339 files; the live voice failures
remain failures, not covered by that test count.

A subsequent browser diagnostic used the actual audio decoder and a real Worker on
the synthetic clip. All 90,640 decoded samples reached the Worker unchanged, with
finite features and the exact expected frame mask. Browser decoding differed from
the direct 16-bit PCM reference by less than one sample step. The original feature
comparison nevertheless exceeded its numerical tolerance and remains a failure.
An identical-PCM control passed that same tolerance (maximum feature error below
0.0000005), distinguishing input conversion differences from a demonstrated
same-input extractor defect. Neither check runs the learned audio encoder or proves
speech recognition. Initial diagnostic-only runtime packaging failures are retained
separately; the application CSP was not changed for these tests.

The focused worker-transfer unit suite also passes 55 tests after replacing its
unrealistic three-sample fixture with a valid 161-sample view surrounded by sentinel
data. This checks exact buffer slicing and preservation of caller-owned samples;
the codec and Worker remain doubles in that unit test. The full 5,073-test run above
predates this fixture-only strengthening.

An isolated learned-encoder check then used the pinned optional audio graph and
weights, current WebGPU session settings and production shader wrapper. Synthetic
speech and equal-length silence produced finite, different outputs of shape
`[142, 1536]`. None of the 57 observed shaders was modified by the wrapper, and
the session/device were released. This establishes input sensitivity and no shader
rewrite in that run, not encoder accuracy, complete per-operator GPU assignment,
decoder behavior or successful voice transcription. No default prompt, model
selection, model package or production inference code changed for these diagnostics.

A controlled context-only comparison also failed. The unchanged default action on
the same captionless recording reached the 96-token limit. A candidate that omitted
only the quoted author/attachment-marker context completed with “Okay, I'm ready.
Please provide the audio.” It did not transcribe the recording. The audio bytes,
model, default request and generation settings were unchanged, and the expected
transcript was not supplied to the model. The candidate and its associated CI
snapshot were reverted; passing unit tests and a verified build did not qualify
it as an accuracy fix. Voice support remains optional and its live acceptance is
still outstanding.

A CPU/WebGPU encoder comparison used identical pinned graph, weights, features
and masks. Both returned finite `[142, 1536]` outputs. Speech relative L2 error
was about 0.56% (cosine similarity 0.999984); silence was about 5.28% (0.998608).
CPU ONNX Runtime was 1.24.3 and the browser runtime was the pinned 1.29 development
build, so this is a cross-runtime numerical observation, not an accuracy pass
or proof that the differences are harmless. An optional offline speech-recognizer
check was blocked before execution by Windows policy; it was not bypassed.

The full-worker diagnostic then observed the actual first decoder call, not a
test double. All 142 learned audio rows reached `inputs_embeds` bit-for-bit
unchanged (218,112 finite values, maximum difference zero). With the original
audio prompt and no chat context, generation still ended normally after 13 tokens
with “Okay, I'm ready. Please provide the audio.” Cleanup completed and no reply
was posted. This rules out dropped encoder output at that boundary for this
fixture, but leaves speech accuracy unresolved. Increasing the output limit
would not explain this normally terminated response. The diagnostic did not
change production sources, cached model weights or prompts.

The next first-step check also verified the real decoder's attention mask,
zero-based positions, empty key/value caches and single-logit request. Text
embeddings and per-layer inputs reached that boundary unchanged and finite.
The model returned the same incorrect response; this is a data-preservation
check, not independent verification of learned embedding scales or decoder
accuracy. A stale diagnostic worker and an incorrect diagnostic HTML link
were excluded before accepting this evidence. The successful run verified
the hash-named worker's identity without clearing application or model caches.

An independent comparison with the unmodified official Python Transformers
5.5.0 audio extractor passed the existing absolute `1e-4` plus relative `1e-5`
tolerance for all 72,576 feature values. Maximum error was `9.203e-5`, RMSE
was `2.050e-6`, and the mask was byte-identical with 566 valid frames. This
used the same direct-PCM reference input on both sides, not the slightly
different browser-decoded PCM. It therefore does not reclassify the earlier
browser-versus-direct-input failure. The comparison ran offline without
model inference or changes to application dependencies. Audio transcription
acceptance remains open despite these passing preprocessing and feed checks.

A second waveform produced a successful isolated control: the public 11-second
JFK sample used by the model maintainer completed in about seven seconds using
the unchanged production worker, default audio prompt and 96-token cap. Its
22 words matched the reference published alongside that sample in the installed
Transformers.js speech-recognition example, ignoring case and punctuation.
The transcript was not included in the prompt, no reply was posted, and cleanup
completed. This demonstrates successful recognition of that clip, not general
speech accuracy or recovery of the still-failing synthetic clip. It is an
audio-only control, not a reproduction of the maintainer's combined image/audio
example with a different output limit.

The normal **Process with AI** message action also transcribed that recording
correctly in the private test chat, without a caption or supplied transcript.
The original stereo WAV exceeded the composer's existing 1 MB limit, so this
run used a derived 970,244-byte mono WAV containing the complete 11 seconds.
The reply included all 22 reference words plus a tentative regional-accent
description; that accent description was not independently evaluated. The
normal action took roughly two to three minutes, versus seven seconds for the
isolated worker control. Those UI timings are not an instrumented breakdown
of loading and inference. Both the latency difference and the earlier synthetic
recording failure remain unresolved; neither result qualifies Android audio.

A repeat of the same normal message action, without reloading or changing the
model, returned the same reply within 37.2 seconds of the click. This is an
observed upper bound, not a profiler timestamp. The cold-to-warm difference is
consistent with the per-page cache-body verification performed before worker
startup; it is not yet a measured attribution to that stage. Integrity checks
were retained in both runs.

A subsequent read-only timing control ran the canonical cache-body verifier
against those already-downloaded files, deliberately bypassing its per-page
memoization. All 15 artifacts and 3,401,448,652 bytes passed their pinned SHA-256
checks in 134.6 seconds: 130.6 seconds for the base model and 4.1 seconds for the
optional audio files. The decoder and embedding weight shards accounted for
127.8 seconds; cache lookup itself took milliseconds. No inference, downloads
or cache writes occurred. This directly demonstrates a large first-verification
cost on that desktop, but does not instrument the earlier message action or
establish timings on Android. It does not justify weakening integrity checks.
The normal preview was restored after that diagnostic. A later same-file
timer/scheduler/scheduler/timer comparison retained full SHA-256 verification:
the 171 MB audio shard took 9.15 and 10.02 seconds with timer yields, versus 2.28
and 2.32 seconds with browser scheduler yields. All four checks passed. The
implementation now uses feature-detected, receiver-bound `scheduler.yield()`;
unavailable, throwing or rejecting implementations fall back to real timers.
Aborting a stalled cache read also settles verification without waiting for a
stalled underlying cancellation promise, and does not evict intact cached data.

The updated canonical verifier then checked all of the same 15 artifacts and
3,401,448,652 bytes in 43.8 seconds (41.6 base, 2.2 optional audio), with all
pinned hashes matching and no downloads, inference or cache writes. This is
about 67% less time than the earlier 134.6-second desktop control, not a promised
end-to-end message latency or Android result. The runs were not simultaneous
and do not control for all system load. The 62 inference-helper tests, including
stalled reads, timer fallback and cancellation during a yielded turn, pass;
TypeScript reports no errors. Final web/APK packaging and native runtime checks
remain separate. The failing synthetic voice recording remains unresolved.

A four-condition control then kept the same production worker, model, default
audio request and 96-token cap. Both the original 11-second JFK recording and
its first 5.665 seconds transcribed successfully. The original 5.665-second
synthetic recording returned a request to provide audio; padding those unchanged
samples with trailing silence to 11 seconds reached the output-token limit.
All four runs verified their exact PCM inputs and completed GPU cleanup. This
rules out a simple minimum-duration explanation for these failures; it does
not establish their cause or qualify synthetic speech or Android audio. No
production prompt, weights or output limit were changed for this control.

The desktop v2 encrypted-delivery flow also passed a two-entry synthetic batch
test: both entries were reviewed, encrypted for the recipient, reviewed again
in IOU, saved and read back from a freshly loaded sheet. After reloading OpenChat,
the attempted local card restored locked without consent. A separately approved
same-ID retry reported that the earlier save was already accepted; a fresh
sheet reload showed one copy of each entry, with the older saved test entry
untouched. Dates in this transport test were entered manually; it does not
qualify automatic date extraction or model accuracy. The live sender predates
the cache-helper update, though its delivery code is unchanged, and the recipient
used the existing local development build. Final-bundle and APK acceptance
remain separate.
