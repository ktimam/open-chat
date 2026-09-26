# Local-only APK authentication boundary

This prototype installs as `dev.openchatfork.localtest`, labelled **OpenChat Fork · Local Test**.
Its Java/JNI namespace is retained internally; its Android application ID, storage sandbox,
launcher entry and FileProvider are separate from the official client. It does not update,
uninstall or borrow the official APK's login state/model caches. It has no official app links,
Digital Asset Links, Firebase initialization/registration or OTA updates.

Build (after reviewed dependencies are available):

```text
node scripts/build-unofficial-local-apk.mjs --target aarch64
```

For an emulator use `--target x86_64`. This command builds only, never installs or signs in.
Missing Cargo dependencies fail offline rather than downloading. The fixed generated
`frontend/app/build` is replaced; installed APKs and device/model caches are not touched.
The compiled feature set retains the existing WebGPU image/text, optional audio and local OCR
paths; runtime/device acceptance must still be exercised on the actual artifact.

## Explicit browser handoff

1. The APK asks for the existing username and consent to five-minute access. A fresh session
   private key remains in the APK. The native listener binds loopback before the URL is shown.
2. An external browser opens `http://localhost:<ephemeral-port>/sign-in`. Its path and query
   contain no credentials, secrets, linking code, username or delegation. The exact first-party
   signer HTML and JS are bundled in the APK, not downloaded at runtime.
3. Browser passkey user verification signs one AUTH-root delegation to the APK's exact public
   key, expiring at the displayed time and targeted only to the official identity canister.
   Linking, if needed, is a separate explicit flow; no automatic new account creation.
4. The browser submits the candidate once. Native reception is **not sign-in**. The APK must
   validate the actual signed WebAuthn CBOR challenge/origin/RP/UP+UV/signature and obtain
   fresh authenticated proof of the exact expected official account.
5. The native completion command must succeed before auth is installed or persisted. Pending
   attempts expire after two minutes. Cancellation/expiry during account proof must discard
   that result. The honest client requests and checks OC delegation expiry no later than the
   original five-minute consent deadline; a cached longer-lived session is not accepted.

Passkeys at `oc.app`, a private host, or another device are not automatically localhost passkeys.
No Android Credential Manager fallback impersonates any of those origins. Browser localhost
credentials previously explicitly linked on this device can be discovered across local ports.

## Transport limits and non-goals

- Only the bundled main WebView at exact origin `http://tauri.localhost`, without URL userinfo,
  can invoke native bridge commands. The capability is not included in ordinary builds.
- Native HTTP binds `127.0.0.1`, requires exact Host, same-origin POST and JSON, has no CORS,
  serves only fixed routes, and caps requests/concurrency/time. Candidate delivery is one-use.
- Native bounds: credential ID <=1,024 bytes; root DER <=4,096 bytes; CBOR signature <=16 KiB;
  whole candidate <=64 KiB. The cryptographic helper may impose stricter independent bounds.
- **Canister targets are not method-level privileges.** The intended client keeps both chains
  within five minutes. A compromised native process/session-key holder could ask the identity
  canister for a longer delegation while the AUTH delegation is valid; this client cannot
  cryptographically prevent that using an unchanged official backend. Do not advertise a
  five-minute hard security boundary against a compromised APK or device.
- This bridge is authentication transport, not private-app delivery. A WebView and external
  browser do not share BroadcastChannel storage; native app handoff needs its own reviewed
  transport and cannot be claimed working from the browser relay tests.
- No public distribution/domain, push-delivery support or official product identity is claimed.

## Verification

`node --test scripts/build-unofficial-local-apk.test.mjs` exercises pure configuration/build
contracts. Rust transport/state tests cover route/Host/Origin restrictions, exact window origin,
replay, simultaneous attempts, expiry and cancellation with synthetic data. These checks do not
replace a full Tauri/Gradle compile, APK manifest inspection, emulator or physical-device tests.
