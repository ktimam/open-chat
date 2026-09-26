# Optimized local-only web test

This profile builds the existing fork UI against official OpenChat services. It does not
deploy canisters, register accounts, enable custom OpenChat app APIs, publish files, or
impersonate the official website. Public branding, hosting and native APK identity remain
separate decisions. Private app proposals stay in memory until an explicit reviewed handoff.

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
