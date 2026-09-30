# Android passkey association: local hosting proof

This isolated project serves **one public Digital Asset Links JSON file**. It has
no authentication UI, browser bridge, credentials, chats, models, or OpenChat backend
code. Package name, signing-certificate SHA-256 fingerprints, output directory and
local replica address are explicit inputs. There are no personal hostnames or keys
in the source.

Use the repository's already installed `dfx` asset-canister implementation. No new
SDK or compiler is required. The generator accepts only HTTP loopback providers;
it cannot generate a mainnet deployment profile. It refuses existing output paths.

## Local deployment

From this directory, using Node.js:

```sh
node association.mjs prepare /absolute/project-temp/passkey-association http://127.0.0.1:8080 dev.example.localtest PUBLIC_CERTIFICATE_SHA256
```

Use the actual APK package and **public** certificate fingerprint, never a signing
key. The output directory's parent must already exist. Keep generated files in the
project-specific temporary directory, not the source checkout.

In a shell with the existing local `dfx` installation, change to that generated
directory and deploy only the named canister:

```sh
dfx deploy android_passkey_association --network association_local --no-wallet
dfx canister id android_passkey_association --network association_local
```

For a recovered multi-subnet replica, pass its verified local allocation-routing
ID with `--provisional-create-canister-effective-canister-id`. Do not guess the ID.

Do **not** run these commands from the OpenChat or IOU root project. Do not run
`dfx start`, `dfx stop`, `--clean`, or reset the existing replica. Do not change its
topology. The existing local gateway must already be running.

Then test the actual served canister, substituting the returned local ID:

```sh
node association.mjs probe /absolute/project-temp/passkey-association CANISTER_ID
```

The probe requires exact JSON bytes, HTTP 200, `application/json`, no redirect,
a certification header, and 404 for unrelated paths. It does not independently
verify the certificate signature. Unit tests run with
`node --test association.test.mjs`.

## What this does not prove

Local success is **not Google Password Manager acceptance**. Google requires a
publicly reachable HTTPS RP hostname serving this file. A local canister ID is
not a mainnet reservation and must not be put into a release APK as its RP.
This tool neither changes the APK RP nor deploys to mainnet.

After separately approved public deployment, verify the real HTTPS response,
Google's association lookup, actual APK package/signing certificate, passkey
creation, existing-account linking, fresh sign-in and remembered-session restore.
Keep the selected public RP hostname/canister stable. Changing the RP changes the
passkey scope; existing `oc.app` credentials are not automatically transferable.
Test and release APK certificates must be reviewed separately before publishing
either in a public association.

References: [Android prerequisites](https://developer.android.com/identity/credential-manager/prerequisites),
[ICP asset canister](https://docs.internetcomputer.org/guides/frontends/asset-canister/).
