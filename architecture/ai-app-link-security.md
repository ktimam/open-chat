# AI-app link security

> Snapshot release gate: the canister's persisted deterministic CSPRNG seed is not itself a
> sufficient entropy boundary. The [ICP snapshot guide](https://docs.internetcomputer.org/guides/canister-management/snapshots/)
> defines restore as replacement of the Wasm module, heap, stable memory, certified variables, and
> chunk store, while the [upgrade lifecycle](https://docs.internetcomputer.org/concepts/canisters/)
> is the operation that runs `pre_upgrade`/`post_upgrade`. A snapshot restore therefore restores the
> old stream position without a reseed hook. PR2 must obtain fresh management-canister
> `raw_rand` entropy for every security issuance (or validate an epoch held by a non-rollback trust
> anchor) before returning a bearer, ECIES envelope, acknowledgement secret, signing key, or
> randomized signature. A failed entropy request must return no security output. Operational
> rollback also resurrects consumed bearer/replay state, so production snapshots are restore-forbidden
> until an external monotonic epoch invalidates the restored state. The ignored `#51` fixtures cover
> UserIndex link bearers, LocalUserIndex ECIES/ack material, and GroupIndex card-authority bearers.

AI-app per-user delivery keys are paired with a single-use claim token. The user index creates 32
random bytes from its CSPRNG and returns them as exactly 64 lowercase hexadecimal
characters. The stored record binds the token to the OpenChat user, app id, exact published app
revision, and registered app canister. Only that registered canister calls
`c2c_claim_ai_app_link_code`; the deprecated public `claim_ai_app_link_code` method is not an
integration path. A successful claim returns
`{ app_subject, subject_version, app_id, app_revision, app_canister_id, key_version }`. The 32-byte
`app_subject` is a dedicated-key HMAC scoped to the exact UserIndex, app id, and app canister; the
registered app receives no global OpenChat user principal and cannot join that subject with another
app. Tokens expire after 10 minutes and are consumed atomically.

## Resource bounds

- At most 20 outstanding tokens are retained per user and 10,000 globally.
- A user/app pair has one token; creating another replaces it through an index rather than a map scan.
- A sorted expiry index makes replacement and expiry logarithmic. Normal calls remove at most 64
  expired records; per-user capacity recovery examines at most that user's 20 records.
- The pre-index serialized layout is normalized once on first use. Expired and over-limit legacy
  records are discarded deterministically. Existing six-digit tokens are intentionally not accepted
  after rollout; their maximum disruption window is the old 10-minute TTL.

Claim and revoke failure buckets are independent, per calling principal, limited to 10 failures per
hour, and capped at 4,096 tracked callers per endpoint. A publishable app must identify a
non-anonymous app canister, and claim/revoke accept only that exact registered canister caller;
anonymous failures are therefore invalid traffic and use the same bounded endpoint bucket.

## Revocation

The app must retain the exact successful-claim tuple. Revocation submits
`{ app_subject, app_id, key_version, public_key, signature, timestamp }` and requires a raw 64-byte
P-256 signature over a domain-separated preimage containing the user-index canister id, app-scoped
subject, app id, key version, exact public-key PEM, and timestamp. PEM input is capped at 2,000 bytes and
the timestamp has a bounded acceptance window. A reverse public-key index avoids a full key-map
scan. Reuse of one public key is capped at 32 app bindings, but a V3 proof removes only its exact
internally resolved `(user_id, app_id, key_version)` binding. Other users/apps sharing the same
public key remain intact, and the global user id is never returned to the app.
Legacy duplicate bindings are normalized deterministically to the reuse cap.

## Consent epochs and card capabilities

Each user/app tuple keeps a monotonic consent epoch. Link codes capture the epoch at creation; direct
key selection, disconnect/cancel, successful claim, and revoke invalidate the exact pair's pending
code and private-card capabilities. Disconnect advances the epoch even before a key exists, so a
delayed app claim is `CodeNotFound`; re-linking the same PEM creates a new epoch and cannot revive an
old capability. Per-user capabilities bind both the app/inbox-scoped canonical key fingerprint and
binding version. The same PEM therefore produces a different public queue selector for another app,
inbox, UserIndex deployment, or local environment.

Raw capability tokens are stored only as canister/domain-separated SHA-256 digests. Outstanding
capabilities are capped at 32 per user, 1,000 per app, and 10,000 globally; provenance is additionally
capped at 500 outstanding records per app. Successful minting is limited to 30 capabilities per
user/app per minute and 10,000 globally per minute, including tokens immediately redeemed.

Create, claim, and revoke handlers must not use the generic `#[trace]` macro: it records arguments or
results, while these endpoints carry a live bearer token, public key, or proof signature. Static
contract tests guard this rule and pin the Candid/TypeScript success shape, including `app_id`,
`app_revision`, `app_canister_id`, `app_subject`, `subject_version`, and `key_version`.

## Rollout and verification

Deploy the user-index canister and matching generated clients together. During a rolling upgrade,
old six-digit tokens fail closed and users request a new token. Required release checks include the
user-index unit and contract suites, integration-test compilation, a PocketIC create/claim/expiry/
replay run against a freshly rebuilt WASM, and a stable-state upgrade from the pre-index layout.

Unfinished app-card capabilities also have explicit client release brakes. Local testing may set the
following exact lowercase flags:

    OC_LOCAL_AI_APP_CARDS_ENABLED=true
    OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED=true
    OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED=true
    OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED=true

They activate only when OC_BUILD_ENV is development, OC_DFX_NETWORK is local, and the browser
hostname is localhost, 127.0.0.1, or IPv6 loopback. Final confirmation and private context
additionally depend on content attestation. Production and testnet Rollup builds replace every flag
with the literal string false; runtime loopback checks provide a second boundary. These switches are
release brakes, not security authority: backend content attestation and the viewer/card/app-bound
server grants remain mandatory.

This is a pre-release breaking privacy migration. Any queued v4 record produced with a raw-key
SHA-256 selector or a decrypted envelope containing `confirmedBy`, raw chat keys, message ids, or
thread coordinates must be drained with the matching old consumer before upgrade or explicitly
discarded under a reviewed local/deployment reset. ActionInbox cannot remap those records because it
does not hold the consumer PEM or the UserIndex HMAC secret. Legacy per-user capabilities and grants
that stored unscoped fingerprints fail closed and expire under their short TTLs.
