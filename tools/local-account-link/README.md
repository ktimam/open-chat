# Local existing-account sign-in proof

This isolated localhost page tests a new, independent passkey against an **existing**
official OpenChat account. It is not the full unofficial chat client. No new canisters,
model downloads, chat access or app-card APIs are involved.

## Explicit production-account effect

Verifying consumes the official account-linking code. After the returned username
matches the username you entered, a separate consent checkbox and button create a
localhost passkey and link it to your **real production account**. The official
credential is not replaced. Clear/forget buttons do not unlink the new credential;
remove it using official OpenChat account settings when no longer needed.

Never enter the linking code in chat, a URL, terminal or screenshot. Enter it only in
the page. No code, session token or private key is stored. The explicit public-field
allowlist persists credential ID, COSE public key, authenticator metadata and expected
account identifiers in this browser's localStorage. A finalization with an unknown
outcome is not retried: use fresh passkey sign-in to reconcile it.

## Build and run

Use Node 24 and the exact dependencies pinned in package.json. For an existing
dependency installation, set `OC_AUTH_PROBE_NODE_MODULES` to its node_modules path.
Optionally set `OC_AUTH_PROBE_OUTPUT` to a project-owned temporary output directory.
Run `npm test`, `node build.mjs`, then `node server.mjs`.
Visit **http://localhost:5187** (not 127.0.0.1 or a LAN/Tailscale hostname).
The server binds only to the local loopback interface.

1. Generate an account-linking code in official OpenChat account/profile settings.
2. Enter your existing username, optionally your known user ID, and the code here.
3. Verify, review the returned username, then explicitly authorize and link.
4. Click **Test fresh passkey sign-in** and perform a new passkey gesture.
   Choose the existing localhost test key. The picker may show other localhost
   credentials, but this page rejects any ID other than the saved linked key.
5. Confirm the same user ID and OpenChat principal. Reload and repeat fresh sign-in.

The protocol has a six-method allowlist. It cannot call identity creation, account
registration, message posting, app verification or app execution. Delegations request
five-minute lifetimes; private signing keys exist only in memory. No remote scripts,
telemetry, service worker or request logging are used.

Unit/mocked/browser-startup checks do **not** prove a real account link. Interactive
acceptance is required. A localhost passkey also does not establish final-domain or
APK interoperability: those remain separate release gates.

Validated on 2026-09-22: 36 unit/mocked tests passed; the browser bundle built from
18 independently installed, lockfile-pinned packages. Chrome startup and blank-input
rejection passed, with zero external requests and no horizontal overflow at 390px.
No real account link or passkey assertion was exercised by those automated checks.

### Verification feedback update — 2026-09-26

The initial live attempt returned a generic verification error. Its precise cause
was not preserved and must not be inferred from mocked tests. Progress/errors now
appear beside Verify, including allowlisted phase/HTTP/OpenChat error numbers; codes,
raw SDK errors and response bodies are never shown. Verification has a 45-second
abortable deadline and a fetch-level guard against SDK-internal resubmission. Missing
inputs do not erase the code. A failed attempt requires explicit reset and a fresh
official code. The refreshed build passed 45 tests and a network-intercepted Chrome
check of inline validation, HTTP diagnostics, reset and mobile width. Real linking
and fresh-passkey sign-in remain unverified.

### Edge passkey failure isolation — 2026-09-26

The user's Edge tab reports `SIGNIN/passkey-request/NotAllowedError`, before account
lookup; the Edge manager lists the localhost test passkey. A separate explicit
`Test saved passkey locally` button invokes the same saved credential ID with a
random 32-byte challenge synchronously from the click. It makes no application or
OpenChat requests, creates no credential/delegation, and does not change saved
metadata. The provider may use its own network/synchronization and advance the
credential's signature counter. Structural response checks do not verify the
signature or prove account login; diagnostic text explicitly states this. Do not
replace the actual IC challenge based on this test. The updated suite has 55 passing
tests. Real-provider failure cause and fresh-sign-in acceptance remain pending.

The user then encountered the native error during the local saved-ID check too;
the page ended at its own 60-second deadline without an assertion or OpenChat call.
This is not evidence that the user cancelled, nor does it identify the provider's
underlying error. `Choose localhost passkey locally` now offers the same local
check without an ID allow-list. A matching ID shows the saved credential can be
accessed through discovery; a different ID only shows another credential works,
not that the saved one is stale. Neither path replaces metadata. Failure remains
ambiguous, including lack of a discoverable credential. The updated suite passes
58 unit/mocked tests; real Edge picker and fresh account sign-in remain unverified.

The next real Edge picker attempt returned the same saved credential ID with
matching challenge/origin/RP hash and user verification set. The diagnostic did
not verify the signature or call OpenChat. This establishes that the ID is
accessible through discovery, not the precise cause of the earlier provider error.
The pinned SDK hard-codes an ID allow-list in `WebAuthnIdentity.sign()` and has no
GET-options customization. Fresh sign-in therefore uses a small subclass that
omits the allow-list but keeps the SDK public key and exact IC challenge. It checks
the returned ID, challenge, exact origin, RP hash and presence before returning
the unchanged assertion in SDK CBOR format. Clearing cancels the pending request.
OpenChat/IC signature validation, five-minute delegation and account matching are
unchanged. No replacement credential, relinking, global API override or random
challenge substitution is used. Real fresh account sign-in remains unverified.

Validation after the picker sign-in change: 86 tests pass. The added offline
contract uses an ephemeral synthetic P-256 key to verify the actual SDK delegation
challenge, unchanged assertion CBOR and delegated request signature. Rejection and
cancellation cases make zero backend calls. The browser bundle builds successfully.
These results still do not replace the real Edge/account acceptance test.

### Real fresh sign-in passed — 2026-09-26

The user completed fresh sign-in using the existing localhost key via the picker.
The live Edge result confirmed matching of the expected username, OpenChat user
ID and principal through the official backend. No account identifiers or
credential material are retained in this report. This establishes a real first
sign-in, not merely the local assertion diagnostic. The user subsequently
reported the same successful account match after the requested reload/repeat.
Localhost authentication acceptance is passed; no further repetition, new code
or relinking is required for this gate. Final-domain, full-client and APK
authentication remain separate unverified release gates.
