# Browser vision — enabling image input for on-device inference in the browser

Proposing on an image in a browser used to fail with *"the model doesn't support images"*. That was
believed to be a platform limit of llama.cpp-in-WASM. It was not. It was **three gates in our own
code**, all in `frontend/app/src/utils/`:

| # | Gate | What it did |
|---|------|-------------|
| 1 | `webInference.ts` — `webInfer` | returned `unavailable` for **any** request carrying an image, before touching wllama |
| 2 | `modelCatalog.ts` — `webEligibleModels` | filtered on `files.length === 1`, which excludes **every vision model that exists** (llama.cpp takes the projector as a second file) |
| 3 | `onDeviceInference.ts` — `onDeviceInferenceCapability` | hardcoded `selectedModalities: ["text"]` for the browser branch |

Gate 3 is the one the UI reads: `aiActionRunner.imageUnsupportedReason` looks at
`selectedModalities` and nothing else. It was already written to allow images the moment the probe
said so, so removing the gates needed **no change to the gate or its tests**.

`@wllama/wllama` has shipped llama.cpp's multimodal stack since 3.0.0 (it runs llama-server's
server-context). We were already on 3.5.1. The API used:

```ts
// download: the projector is a second URL on the same ModelSource
await new ModelManager().getModelOrDownload({ url, mmprojUrl }, { progressCallback });
// load: pass both blobs — wllama sorts them by reading each GGUF header
await runtime.loadModel(model);            // general.architecture == "clip" ⇒ that blob is the mmproj
runtime.supportInputModality("image");     // the truth, only after loadModel
// infer: OAI-style structured content, raw PNG/JPEG bytes
messages: [{ role: "user", content: [{ type: "image", data: arrayBuffer }, { type: "text", text }] }]
```

## Decisions worth knowing

**The size budget is the TOTAL, not per file.** `WEB_MODEL_MAX_BYTES` (2 GB) is now compared against
`entry.sizeBytes` (weights + mmproj). Both files live in the *same* wasm heap at once — the projector
is not a sidecar — so the sum is what has to fit alongside the KV cache and compute buffers. A
per-file cap would wave through a pair that OOMs. Pinned by a spec (`over-budget`: each file under
the cap, sum over it ⇒ excluded).

**Which file is the projector is read from the URL basename.** `isMmprojFile` tests for `mmproj` in
the basename (not the path — a repo called `mmproj-repo` must not poison its weights). That
convention is already load-bearing in three other places: llama.cpp's converter names projectors
`mmproj-*.gguf`, the native downloader's `find_mmproj` classifies on-disk files the same way, and the
"Add a model from URL" form force-renames the projector to `mmproj.gguf`. wllama re-checks the GGUF
header at load time, so a misnamed file costs a load error, never a silently wrong model.

**Modalities are answered from the strongest evidence available.** Loaded model's
`supportInputModality` > catalog claim > `["text"]`. The catalog claim is needed because the propose
gate runs *before* any inference, so an attached-but-not-yet-loaded model would otherwise always
refuse the first image. `webInfer` re-checks the loaded truth before sending any image bytes, so a
mislabelled entry degrades to a clear `unavailable` instead of throwing *"Media marker is undefined"*
from inside wllama.

**Browser downloads are now SHA-256 verified.** They never were — verification lived only in the
native Rust downloader, so the catalog's `sha256` was inert in the browser. That mattered more once a
*second* URL joined the download. `crypto.subtle.digest` has no streaming form, so each file is
materialised as one ArrayBuffer; if that allocation fails we log and skip rather than report a false
corruption. A real mismatch removes the cached model and surfaces the failing filename.

## Measurements (2026-07-30, Chrome 150.0.7871.187, 32-core / 32 GB host, `crossOriginIsolated: true`)

### The memory ceiling — the old comment was wrong

`WEB_MODEL_MAX_BYTES` was justified by "wasm32 address space is 4 GB". Measured by binary-searching
`new WebAssembly.Memory({...})` in the live page:

| reservation | granted |
|---|---|
| Memory64 (`address: "i64"`), `shared: true` | **≥ 16384 MB** — the probe's own upper bound, the browser never refused |
| Memory64, `shared: false` | ≥ 16384 MB |
| wasm32, `shared: true` | **exactly 4096 MB** |

So 4 GB is no longer the platform's limit. It remains the ceiling *in practice* only because wllama
caps itself: `getWasmMemory` asks for `maximum: 65536` pages (4 GiB) and probes downward in 128 MB
steps. 2 GB stays as the model budget — it leaves the headroom the KV cache and compute buffers need
— but the *reason* in the comment is now the real one.

### Model A/B — real IOU extraction prompt, canvas-rendered receipt, ground truth `settlement / 45.00 / GBP / 2026-07-12`

| | SmolVLM 256M | SmolVLM 500M |
|---|---|---|
| download + SHA-256 of both files | 66 s | 188 s |
| first load into wasm | 9.6 s | — |
| clean PNG | 10.8 s → **nested, structurally invalid JSON** | 7.0 s → flat JSON, `amount "40.00"`, `currency GBP` |
| photo-like JPEG (3° rotation, noise, q0.6) | 4.5 s → invalid | 2.9 s → flat JSON + read `VISA #4419` off the noisy image |
| text-only control (no image) | **also invalid** (`"unit": "rupe"`) | correct `45.00 GBP` |

**SmolVLM 256M was measured and rejected.** Its text-only control is as broken as its image runs, so
the failure is instruction-following, not OCR — it can never produce a card (the post-pass drops it as
missing required fields), and offering it would only teach users that browser vision doesn't work.

**SmolVLM 500M ships.** It genuinely reads the picture. It is also a 500M model: on the receipt it took
`40.00` (the *Subtotal* line) rather than `45.00` (the TOTAL), used today's date rather than the
receipt's, and said `iou` rather than `settlement` — the last two are its instruction-following, since
the text control made the same `kind` error. Hence the catalog copy tells the user to check the
amount before confirming, and it is ranked **below** the text models, not as the default.

### Qwen3-VL 2B — measured second, and it beats everything else on BOTH axes

A 26-agent survey of every GGUF+mmproj pair under the 2 GB budget (every byte count and SHA-256
re-verified against the HF `paths-info` API by an independent agent) ranked
`Qwen/Qwen3-VL-2B-Instruct-GGUF` first, on the strength of being the only candidate with a published
*strict-format* benchmark (IFEval 68.2) as well as class-best OCR (OCRBench 858, DocVQA 93.3). The
open risk was architectural: does wllama 3.5.1's pinned llama.cpp actually support `qwen3vl_merger`
in the wasm build? Tested rather than assumed — it loads and runs.

Same harness, same receipt, same three text cases:

| case (ground truth) | SmolVLM 500M | Gemma 3 1B (best text) | **Qwen3-VL 2B** |
|---|---|---|---|
| receipt IMAGE | `iou`, `"40.00"` string — the *Subtotal* line | cannot read images | **`settlement`, `45.0` NUMBER, GBP**, notes the line items |
| `Paid GBP 45.00 … 12/07/2026` | `iou`, `"45.00"`, date=today | `settlement`, `45.00`, date=today | **all correct, incl. `date 2026-07-12`** |
| `I owe you 300 for the uber` | `300`, `credit` ✗ | `300`, `debt` ✓ | **`300`, `debt`** ✓ |
| `reservation 3-8 august 7777 gbp` | **`"3.00"`** ✗ | `7777`, `date 2026-08-07` ✗ | **`7777`, `date 2026-08-03`** ✓ |

It is the only model of the five tested to apply the prompt's date-range rule ("use the START date"),
and the only one to return a number rather than a string from an image. That makes it the best TEXT
model in the catalog as well as the best vision one — which dissolves the one-slot tension below for
anyone willing to spend the download.

Costs: 1.55 GB (72% of budget), 521s to download + SHA-256 both files, 11.5s first load, ~9.8s per
image, 1.1–3.5s per text message. Apache-2.0, clean.

**It ships at index 0 — it is the default.** Catalog order is the only mechanism: `webEligibleModels`
preserves it and both ModelManager trees render `i === 0` as the primary "Download & use (default)"
button. Nothing hardcodes an id, so moving the default is a reordering, not a code change. The
trade the default now makes is ~2x Gemma 3 1B's download (1.55 GB vs 806 MB) for a model that beat
it on every text case as well as reading images; the smaller text-only models sit directly below it.

A spec pins that index 0 is image-capable — asserting the MODALITY, not the id. Which model wins is
a product call that will change again; a default that silently cannot read a photo is the regression
this whole change existed to fix, and that is what deserves a test.

Runners-up, all verified but not shipped: `LiquidAI/LFM2.5-VL-1.6B` (best MM-IFEval in class, but a
custom `lfm1.0` licence with a $10M revenue cap), `ggml-org/InternVL3-2B` (Apache-2.0, OCRBench 835,
no published format benchmark), `ggml-org/SmolVLM2-2.2B` (MM-IFEval **19.42** — a negative finding
that independently corroborates the SmolVLM family's format weakness measured here).

### The "(ABORT)" crash — a real bug report, and why the first hypothesis was wrong

Reported from use: proposing on a photo failed with **"Action failed: (ABORT)"**. The obvious
hypothesis — image tokens overflowing the fixed `n_ctx: 4096` — was wrong. The stack says so:

```
__wrap_abort <- ggml_abort <- ggml_backend_webgpu_wait_queue
             <- ggml_backend_webgpu_synchronize <- clip_image_batch_encode <- mtmd_encode_impl
```

It is llama.cpp's **WebGPU backend** aborting inside the **vision encoder**, before the language model
is involved at all. An emscripten `abort()` kills the whole wasm module.

It is size-dependent because Qwen3-VL is dynamic-resolution: more pixels → more patches → a bigger
WebGPU dispatch. Measured: 1000x1333 ok, 1500x2000 abort. Three candidate fixes tested against the
failing sizes:

| candidate | result |
|---|---|
| `image_max_tokens` at load | **works** — 12 MP photo fine at 768 and 1024 |
| `n_gpu_layers: 0` (force CPU) | **still aborts** — that flag governs the LANGUAGE model; the vision encoder picks its own backend |
| downscale the image in our own JS | works, but re-implements in JS what mtmd already does model-correctly |

`image_max_tokens` won: one parameter, model-aware resizing, no image round-trip. Tuning it against a
12 MP photo of a receipt (ground truth: total 45.00, service 5.00, card ****4419, date 12/07/2026):

| value | outcome | time | accuracy |
|---|---|---|---|
| 768 | ok | 13.5s | all four fields correct, small print included |
| 1024 | ok | 22.4s | all four correct |
| 2048 | **ABORT** | — | — |
| 3072 | **ABORT** | — | — |

**768** ships: under half the observed threshold (headroom for a slower GPU), the fastest working
value, and no accuracy cost even on the fine print. Verified end-to-end through the real `webInfer`
path afterwards at 1500x2000, 3000x4000 and 4000x3000 — all extract `45.00 GBP`. SmolVLM tiles at a
fixed resolution so its token count never tracked pixels; measured identical with and without the cap,
which is why one parameter safely covers the whole catalog.

Two defects were fixed, not one. The second: an abort **poisons the runtime** — every later inference
on that instance fails too, so one oversized image killed the model for the rest of the session. The
catch now drops the runtime so the next call rebuilds it, and translates the bare `(ABORT)` into
something actionable ("the model ran out of room decoding that image — try a smaller picture"). Four
specs pin it, including that a non-abort error still passes through untouched.

### There is ONE model slot — so the vision model's TEXT quality matters

`webInference` keeps a single `state` object, a single `runtime`, and a single localStorage key;
every attach path calls `unloadWebModel()` and overwrites. Attaching the VLM therefore *replaces*
your text model — it is not an additional image-only engine running alongside one. So the VLM handles
text messages too, and how well it does that is a shipping concern, not a footnote:

| message (ground truth) | SmolVLM 500M | Qwen2.5 0.5B | Gemma 3 1B |
|---|---|---|---|
| `Paid GBP 45.00 at The Olive Tree on 12/07/2026`<br>(settlement / 45 / GBP) | `iou`, `"45.00"` **string** | `iou`, `45.00` | **`settlement`, `45.00`, `debt`** — only one fully right |
| `I owe you 300 for the uber`<br>(iou / 300 / debt) | `iou`, `"300"` string, `credit` | `iou`, `300`, `credit`, spurious `settlement` key | `iou`, `300`, **`debt`** |
| `reservation 3-8 august 7777 gbp`<br>(iou / 7777 / GBP) | **`"3.00"`** — read the `3` out of the range `3-8` | `7777` | `7777` |

Two systematic differences: SmolVLM emits `amount` as a **string** every time (the prompt says "as a
JSON number (never a string)"; the deterministic post-pass coerces it, so cards still build), and it
mis-parsed a date range as the amount — a failure neither text model made. Gemma 3 1B is the
strongest of the three and remains the default.

The catalog copy says this plainly: one model at a time, this one is worse at text, switch back when
you're done with pictures. An earlier draft said "keep a text model selected for text messages",
which is impossible with one slot — the fix was prompted by exactly that question.

Every model also gets `date` wrong (all three return today rather than the stated date). That is
pre-existing and orthogonal to vision.

The desktop `gemma-4-e2b` leg of the A/B was **not run**: the live WebView2 instance was launched
without `--remote-debugging-port`, and restarting the user's app was out of scope. It does not gate
the decision — no VLM was made the browser default.

### End-to-end, in the browser

Child profile (Chrome, `:5003`), SmolVLM 500M attached, receipt posted as an image message, message
menu → **Propose action**:

- capability at propose time: `{available: true, selectedModelId: "SmolVLM 500M (vision)", selectedModalities: ["text","image"]}`
- outcome: a real **Add to IOU** card, `Amount 40`, Note **`Paid VISA ***4419`**

That note is the proof: the string `VISA ****4419` exists only inside the picture — not in the
prompt, not in any message text. The model read it off the image.

## Follow-ups

- A better small VLM would lift extraction quality far more than any prompt work. Anything in the
  1–2B class fits the 2 GB budget; nothing in the current catalog occupies that slot.
- The disk-file picker still takes ONE file, so a disk-picked VLM cannot get its projector. Only the
  catalog path can attach a pair today. `showOpenFilePicker({ multiple: true })` plus wllama's
  header-based sorting would cover it — `loadModel` already accepts the two blobs in any order.
- A disk-picked model reports `["text"]` until its first inference loads it, because there is no
  catalog row to ask. That costs one text-only propose, never a wrong answer.
