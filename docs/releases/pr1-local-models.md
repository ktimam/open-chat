# Draft update: optional on-device inference and local model management

Target: existing [upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132).
Keep draft status. Replace the source SHA and verification evidence after the model-only
refresh has been assembled and independently checked; this body is not a publication action.

## Summary

Provide optional on-device model management and a generic inference interface for chat and
other host features. Keep model selection, installation state, cached artifacts, runtime
readiness and bounded failures visible to the user. Retain optional audio support without
requiring an audio download for image/text use.

Later integration work includes browser WebGPU image inference, mobile GPU lifecycle and
compilation fixes, cache-preserving model switching, updated model settings, optional Gemma
audio, and Android/native bridge recovery. These changes need a reviewed model-only refresh
of this PR; the current integration checkpoint also contains app-interface work for PR2.

## Boundaries

- No third-party app imports, app-defined field semantics or domain-specific extraction.
- Models and runtimes are optional. Disabled/unavailable states remain explicit.
- Preserve pinned model assets, verification, license notices and bounded resource cleanup.
- Keep desktop/native and browser/WebGPU runtime claims separate.
- All-WebGPU phone inference is currently local-development-only; this PR does not claim
  that the existing production Android release workflow ships that path.

## Verification and readiness

Combined integration source plus lint cleanup and compatible dependency updates: 1,766 frontend tests passed; both
typechecks and read-only lint passed with existing warnings. This is not evidence for the
not-yet-created refreshed model-only head. Existing upstream PR check runs are absent.

Before ready-for-review: validate the refreshed head against current upstream, repair and
refresh the expired dependency policy through an actual audit, run the expanded hosted checks,
repeat native/runtime tests and provide bounded real-device evidence. Signed artifact,
production model-asset distribution and OTA decisions remain separate release gates.

See [release readiness](model-app-readiness.md) for exact observed refs, audit results,
commands, scope separation and outstanding gates. No production activation is requested.
