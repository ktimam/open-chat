# Third-party notices: on-device inference and browser OCR

This notice applies to OpenChat native bundles built with the `inference` feature and to the browser
OCR assets redistributed with OpenChat web builds. It supplements OpenChat's AGPL-3.0 license; it
does not replace it.

## Native code and Rust packages included in the bundle

| Component                                                           | Version                                                                           | License           | Disposition                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| llama.cpp / ggml                                                    | `9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66`, vendored by `llama-cpp-sys-2` 0.1.150 | MIT               | Compiled into the native inference runtime. Copyright 2023-2026 the ggml authors.     |
| `llama-cpp-2`, `llama-cpp-sys-2`                                    | 0.1.150                                                                           | MIT OR Apache-2.0 | OpenChat elects Apache-2.0 for the Rust wrapper code; vendored llama.cpp remains MIT. |
| `open`                                                              | 5.3.6                                                                             | MIT               | Opens validated external URLs. Copyright 2015 Sebastian Thiel.                        |
| `minijinja`, `minijinja-contrib`                                    | 2.21.0                                                                            | Apache-2.0        | Renders model-provided chat templates. Copyright Armin Ronacher and contributors.     |
| `memo-map`                                                          | 0.3.3                                                                             | Apache-2.0        | Transitive template cache. Copyright Armin Ronacher and contributors.                 |
| `is-docker`, `is-wsl`                                               | 0.2.0, 0.4.0                                                                      | MIT               | Platform detection. Copyright 2023 Sean Larkin.                                       |
| `sha2`, `hex`, `cc`, `find-msvc-tools`, `find_cuda_helper`, `shlex` | versions pinned in `Cargo.lock`                                                   | MIT OR Apache-2.0 | OpenChat elects Apache-2.0 for these integrity, build, and platform dependencies.     |
| `bindgen`                                                           | 0.72.1                                                                            | BSD-3-Clause      | Build-time tool; it is not linked into or bundled with the application.               |

The complete MIT and Apache-2.0 texts are bundled in `THIRD_PARTY_LICENSES`; the table preserves the
copyright notices for MIT-only code compiled into the application. `bindgen` is a build-time tool,
so its BSD-3-Clause source and notice are not redistributed in the application bundle; it remains
recorded in the generated CycloneDX SBOM.

## Browser OCR runtime and assets

| Component                | Version | License                           | Disposition                                                                                                                                       |
| ------------------------ | ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tesseract.js`           | 7.0.0   | Apache-2.0                        | Browser OCR controller and worker. The worker is self-hosted and loaded lazily from OpenChat's versioned asset path.                              |
| `tesseract.js-core`      | 7.0.0   | Apache-2.0                        | Emscripten/WebAssembly Tesseract cores. OpenChat redistributes LSTM relaxed-SIMD, SIMD, and non-SIMD variants and selects one at runtime.         |
| `@tesseract.js-data/ara` | 1.0.0   | Apache-2.0 data; npm metadata MIT | Arabic `ara.traineddata.gz` from `naptha/tessdata`; package metadata identifies Balearica as author and Balearica and Jerome Wu as contributors.  |
| `@tesseract.js-data/eng` | 1.0.0   | Apache-2.0 data; npm metadata MIT | English `eng.traineddata.gz` from `naptha/tessdata`; package metadata identifies Balearica as author and Balearica and Jerome Wu as contributors. |
| `ieee754`                | 1.2.1   | BSD-3-Clause                      | Embedded in the minified OCR worker. The complete license is redistributed as `ieee754-BSD-3-Clause.txt`.                                         |

Web builds place this notice and the complete Apache-2.0, MIT, and ieee754 BSD-3-Clause texts under `assets/licenses`.
`worker.min.js.LICENSE.txt` is also redistributed beside the minified worker, preserving its
embedded MIT and BSD-3-Clause attribution notices for Buffer, ieee754, regenerator-runtime, and
zlib.js support code.

## Downloadable models and projectors

OpenChat does not bundle or redistribute the catalog's model weights or vision projector. A user who
chooses a model downloads each file directly from its publisher at an immutable revision, after the UI
shows its license and requires acceptance. The built-in `gemma-4-e2b-it-q4` model and its
`mmproj-F16.gguf` projector are both from
`unsloth/gemma-4-E2B-it-GGUF@0314792d7f1f7e229411f620751375812bb9faf2`, whose repository metadata
declares Apache-2.0 and links to Google's Gemma 4 Apache-2.0 license.

The feature-gated all-WebGPU client also supports the ONNX-community conversion at
`onnx-community/gemma-4-E2B-it-ONNX@9f4bef82ea6e296bc69f8a2f5939f73af81b07a6`.
Its pinned text/image files are downloaded and SHA-256 verified only when the user selects that
model. The voice encoder is a separate optional download requested from the model settings; it is
not part of the text/image installation. Neither the Gemma text/image weights nor the optional
voice encoder is bundled in OpenChat's web or Android package.

The 14 MB TinyLlama GGUF used by CI is MIT-licensed, downloaded only during CI from the immutable
`tensorblock/tinyllama-15M-stories-GGUF@227c5a5ad3c1a830901543cf9959c53572014a68` revision, verified
by SHA-256, and never bundled with OpenChat.

Browser builds redistribute a Tesseract WebAssembly OCR runtime and Arabic/English language data. Android
and iOS clients do not use or package the browser-only worker, core, or language payloads.
