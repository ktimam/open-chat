# Local app processing

An app can own deterministic text extraction and interpretation of model results by declaring
`"x-openchat-local-processor": { "version": 1 }` on its response schema. OpenChat runs the
registered card surface with `oc-app-process=1` and communicates through a short-lived iframe.
The app document supplies the implementation. No app module is imported into OpenChat.

For text, the app receives an `extract` request. OCR-only mode also sends `extract`, with
independent `ocrTranscripts` collected using the app-selected profiles, without loading a model.
For model output, the app receives `normalize` with generic candidate objects. In verified mode,
each independent reading is normalized separately before the generic field comparison. Audio continues through the
selected model before normalization. The app owns the field names, meanings, labels, calendar
interpretation and any other domain rules.

The model response schema must accept the raw values the app needs to interpret. For example,
if an app wants to interpret a visible timestamp itself, its raw field can be a bounded string.
OpenChat's ordinary schema validation runs before the processor and again on its returned
candidates. Final application constraints also belong in the app's backend verifier.

## Protocol

Every envelope carries `version: 1`, a random `frameNonce`, and a random `requestNonce`.

| Message | Direction | Additional data |
| --- | --- | --- |
| `oc:app-process:bootstrap` | Host → app | None |
| `oc:app-process:ready` | App → host | None |
| `oc:app-process:request` | Host → app | `actionId`, `input` |
| `oc:app-process:result` | App → host | `kind`, and `candidates` when successful |

`input` has an `operation` (`extract` or `normalize`), `modality` (`text`, `image`, or `audio`),
and optional `text`, `ocrTranscripts` (objects with `profile` and `text`),
`sourceTimestamp` (epoch milliseconds), and `candidates`. Source text is
limited to 32 KiB; the complete request and result are each limited to 64 KiB. A successful
response contains 1–16 candidate objects. Other results are `none`, `ambiguous`, or `error`.

## Isolation and lifecycle

The host resolves the card URL from the selected registered app before creating the frame.
The iframe uses `sandbox="allow-scripts"`, credentialless storage, and no referrer. It receives
no account credentials, consumer keys, chat identifiers or private-context capabilities. The
app still receives the supplied source text or candidate data, so its processor must follow
the app's own privacy contract. The protocol does not grant backend access.

OpenChat accepts messages only from the exact iframe window with its opaque `null` origin
and both matching nonces. It validates envelope keys, bounded JSON, candidate count and schema.
Attempts time out after 30 seconds; at most two run concurrently. Account/context changes
cancel delivery. Completion removes the iframe and listeners. Existing provenance attestation,
review, and final confirmation still run after processing.

Generic host tests use independent measurement and specimen schemas. App integration examples
and app-specific parser tests belong in the corresponding app repository.
