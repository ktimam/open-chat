# Local-only APK authentication boundary

This prototype installs as `dev.openchatfork.localtest`, labelled **OpenChat Fork · Local Test**.
Its Java/JNI namespace is retained internally; its Android application ID, storage sandbox,
launcher entry and FileProvider are separate from the official client. It does not update,
uninstall or borrow the official APK's login state/model caches. It has no official app links,
Firebase initialization/registration or OTA updates. Its original RP association declaration
does not establish Digital Asset Links authorization for the fork's package/certificate.

Build (after reviewed dependencies are available):

```text
node scripts/build-unofficial-local-apk.mjs --target aarch64
```

For an emulator use `--target x86_64`. This command builds only, never installs or signs in.
Missing Cargo dependencies fail offline rather than downloading. The fixed generated
`frontend/app/build` is replaced; installed APKs and device/model caches are not touched.
The compiled feature set retains the existing WebGPU image/text, optional audio and local OCR
paths; runtime/device acceptance must still be exercised on the actual artifact.

## Original native restore flow

Both layouts use OpenChat's original onboarding components. On Android, the passkey
action calls the original native Credential Manager implementation. An account-linking
code follows the original sequence: verify code, create a provider-managed passkey,
finalise account linking, and sign in to that account through the official identity service.
There is no separate username/browser-login page or browser identity adoption.

The build selects `transformers-webgpu-android,local-test-app-handoff`, not
`local-test-browser-auth`. The latter is no longer an application feature; the plugin's
legacy implementation remains unselected source coverage only. Browser-auth capability
and HTML/JS assets are excluded. App setup/delivery listeners remain separate features;
they do not carry OpenChat login credentials.

Saved sessions use the original AuthClient/IdentityStorage lifecycle and 30-day delegation
policy. Former custom browser-session records are not adopted, converted or extended.
A fresh sign-in after an older test build may be necessary, but no passkey, account or
app data is deleted by this source change. Browser and native RP namespaces differ;
a `localhost` passkey created by the former test page is not automatically an `oc.app`
passkey. Do not recreate or relink credentials merely because a session is absent.

## Provider qualification and non-goals

The profile currently preserves the original `oc.app` RP identifier. The separate package
and local signer are not the official application's identity. Google Password Manager
compatibility is required, but must be demonstrated on the actual build, independently
of a KeePassDX emulator test. Source parity alone does not establish provider authorization.

Android's documented association requirements are not proof of the cause of a particular
regression. A prior successful fresh code restore and new Google-managed passkey must not
be relabelled as cached-session reuse. Compare the actual APK's package, signer, compiled
RP and provider result before attributing a failure to association.

The historical PR2 source at `0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf` already uses
the code-verification, native passkey-creation and account-link completion sequence.
Its artifact records name the installed package `com.oc.app`, unlike this separate
test package. That PR's RP was configurable through `OC_ANDROID_RP_ID` or the bundled
`android-rp-id`; its `oc.app` default is not proof of the successful APK's compiled RP.
The exact old binary's RP and signing fingerprint have not been recovered. The user's
confirmed fresh Google Password Manager registration stands; no domain-association
failure diagnosis can be inferred from these incomplete historical artifact records.

The isolated local asset canister in `tools/android-passkey-association` verifies the
association document's hosting/response contract. It does not prove public HTTPS
reachability or Google acceptance. No public deployment, official product identity,
push-delivery support or hardware-keystore protection for session storage is claimed.

Authentication still uses the unchanged official backend. Delegation target restrictions
are not method-level permissions or protection against compromise of an authorized app
process. Private-app payload consent remains a separate boundary.

## Verification

`node --test scripts/build-unofficial-local-apk.test.mjs` checks the native-auth profile,
feature selection and exclusion of browser-login assets. `originalOnboard.spec.ts`,
`androidWebAuthnOnboard.spec.ts` and `nativeSignInLifecycle.spec.ts` mount original UI or
handlers and exercise sign-in/linking lifecycle. `signInAcceptance.spec.ts` invokes real
OpenChat methods and IdentityStorage with synthetic provider, IndexedDB I/O and worker
transport; worker tests exercise original identity lookup/linking boundaries.

These checks are not credential-provider or real storage-persistence acceptance. Inspect
the built APK's package, signer, RP, assets and resolved native features, then separately
verify account identity after native restore and after closing/reopening the installed APK.
Retain old build receipts as historical evidence; do not apply their runtime results to a
new artifact. A successful build or emulator KeePassDX login does not qualify Google
Password Manager on a physical phone.
