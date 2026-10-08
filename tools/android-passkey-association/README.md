# Android passkey association: local hosting and future IC preparation

This isolated project serves **one public Digital Asset Links JSON file**. It has
no authentication UI, browser bridge, credentials, chats, models, or OpenChat backend
code. Package name, signing-certificate SHA-256 fingerprints, output directory and
local replica address are explicit inputs. Only public certificate fingerprints,
never signing keys, belong in this file. No personal hostname is a source default.

Use the repository's already installed `dfx` asset-canister implementation. No new
SDK or compiler is required. The explicit modes are `local` and `mainnet-plan`.
**Neither mode deploys anything, runs dfx or changes the APK.** Both refuse existing
output paths. Local operations accept only an explicit HTTP loopback replica port;
mainnet preparation has no replica endpoint and cannot be probed or served by the
local commands. The original local-only command and schema-1 project remain readable.

## Local deployment

From this directory, using Node.js:

```sh
node association.mjs prepare --mode local /absolute/project-temp/passkey-association http://127.0.0.1:8080 dev.example.localtest PUBLIC_CERTIFICATE_SHA256
```

Use the actual APK package and **public** certificate fingerprint, never a signing
key. The output directory's parent must already exist. Keep generated files in the
project-specific temporary directory, not the source checkout. Supply additional
reviewed public fingerprints as additional arguments when both signers are intended.
An existing matching deployment can be reused: probe it instead of redeploying it.

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

## Tailscale HTTPS to the existing local asset canister

Use a separately configured HTTPS endpoint whose hostname you control. Run the
bounded adapter on an explicit free loopback port, replacing `PROXY_PORT`:

```sh
node association.mjs serve /absolute/project-temp/passkey-association CANISTER_ID PROXY_PORT
```

The TLS proxy must preserve the exact `/.well-known/assetlinks.json` path and route
it to this adapter, **not the replica port**. The adapter binds only `127.0.0.1` and
forwards only GET/HEAD of that exact path to the configured canister. It fixes the
upstream Host to `CANISTER_ID.localhost:REPLICA_PORT`; incoming Host, cookies,
authorization and Tailscale identity headers are never forwarded. Queries, other
paths and other methods cannot reach the replica. There is no API, auth callback,
SPA fallback, file browser or chat/data forwarding.

Every successful response must match the reviewed package and signer bytes, JSON
MIME, status 200, no redirect and a certification header. A mismatch, timeout or
upstream error returns an empty 502, never an upstream page or stale success.
Responses are bounded to 64 KiB, with eight concurrent upstream requests and
15-second request deadlines. This checks a certification header's presence, not
its cryptographic validity. The local replica and TLS operator remain trusted.

Configure only the association endpoint in Tailscale; inspect existing Serve/Funnel
routes first and preserve unrelated routes. Do not expose the replica, dfx project,
OpenChat, IOU or their ports. This helper never invokes Tailscale, opens a public
route or changes firewall policy. Public Funnel exposure requires its own approval.

Supply the chosen hostname explicitly to the APK build, without `https://`, path or
port: `--rp-id HOSTNAME_FROM_TAILSCALE`. No personal hostname is committed.
This changes configuration only; the original OpenChat restore/linking UI and native
Credential Manager remain in use. It does not add a browser authentication bridge.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) is private to
the tailnet; Funnel is a separate public exposure choice. Phone access through Serve
does not prove Google's verifier can retrieve the file. Keep Google Password Manager
acceptance pending until its public association lookup and actual native provider
flow pass. Do not silently enable Funnel to work around that boundary.

## Future mainnet preparation only

Prepare a separate new project with the actual intended package and public signer(s):

```sh
node association.mjs prepare --mode mainnet-plan /absolute/project-temp/passkey-association-ic dev.example.client PUBLIC_CERTIFICATE_SHA256
```

This writes the static asset-canister definition, DAL JSON, non-raw asset policy and
`mainnet-plan-config.json`. It executes no commands, allocates no canister, spends
no cycles, contacts no network and does not reserve a hostname. There are no deploy
hooks or default mainnet endpoint overrides. Local `probe` and `serve` reject this
mode before opening a connection. Existing local projects cannot be silently
reinterpreted as mainnet plans.

Only after a separate deployment/funding approval, use the installed dfx from that
new project to deploy **only** `android_passkey_association` with `--network ic`.
Never run that deployment from the OpenChat or IOU project. Obtain the actual mainnet
canister ID, retain its controller/upgrade records, then describe the intended RP:

```sh
node association.mjs mainnet-plan /absolute/project-temp/passkey-association-ic MAINNET_CANISTER_ID icp.net
```

The last argument must explicitly be `icp.net` or the supported certified `icp0.io`
gateway. The plan returns `https://CANISTER_ID.GATEWAY/.well-known/assetlinks.json`
and its hostname as the RP. It rejects raw hosts and does not contact that network
or claim the canister exists. Use the certified HTTPS hostname, not
`CANISTER_ID.raw.GATEWAY`, a local ID or an API gateway. See
[ICP response certification](https://docs.internetcomputer.org/guides/frontends/certification/).
Keep the selected mainnet canister and hostname stable; switching between even two
valid gateways changes the RP scope.

## Qualification and RP changes

Local success is **not Google Password Manager acceptance**. Google requires a
publicly reachable HTTPS RP hostname serving this file. A local canister ID is
not a mainnet reservation and must not be put into a release APK as its RP.
This tool neither changes the APK RP nor deploys to mainnet. The association canister
hosts public metadata only; no OpenChat backend change or deployment is needed.

After separately approved public deployment, verify the real HTTPS response,
Google's association lookup, actual APK package/signing certificate, passkey
creation, existing-account linking, fresh sign-in and remembered-session restore.
Keep the selected public RP hostname/canister stable. Changing the RP changes the
passkey scope. Moving from a Tailscale hostname to the final IC hostname requires
a new passkey through the original account-linking-code flow for the same account;
it does not migrate old passkeys or make an `oc.app` credential usable under a new RP.
Do not delete the old credential before confirming the new credential works.
Test and release APK certificates must be reviewed separately before publishing
either in a public association.

References: [Android prerequisites](https://developer.android.com/identity/credential-manager/prerequisites),
[ICP asset canister](https://docs.internetcomputer.org/guides/frontends/asset-canister/).
