# Standalone app registry

This is the unofficial client's independent app directory. It does not modify,
deploy or call any official OpenChat canister. It restores publisher registration
and public discovery separately from the unchanged OpenChat chat backend.

The PR implemented registration inside a modified OpenChat UserIndex. This service
uses independent ICP publisher identities and a separately configured registry
operator instead. It is not OpenChat governance, an official OpenChat endorsement,
or proof that publisher code is safe.

## End-user flow

1. The client reads its configured registry URL in the existing Apps UI.
2. Only published apps appear. Exact package SHA-256 and length are verified.
3. The user chooses Connect and authenticates with the selected app. Public
   discovery contains no user's delivery key, private Types or account setup.
4. The user approves setup and enables the app in a chat. Publication never
   enables an app automatically.
5. Existing local proposals, encrypted delivery and app-side review are unchanged.
   No message, image, draft or private key is sent to this registry.

Compatible additions need no APK update once the client supports v2. The initial
v2-capable APK is required. Model weights/prompts, inference, authentication and
card UI are outside this change.

## Publisher and operator boundary

An authenticated, non-anonymous principal submits a bounded public descriptor.
The canister injects its caller as publisher; submitted JSON cannot choose another
owner. Registration creates an owner-private pending revision, not a listing.

The operator reviews control of the declared publisher origin, the complete public
package, connection destination and both artifact hashes. Publication approves an
exact commitment including registry identity, publisher and proposal revision.
A changed submission cannot reuse an older commitment. Hashes identify bytes, not
their legitimacy. Initial publication uses this explicit operator review, not the
PR's unavailable OpenChat governance/app-canister-vouch mechanism.

An existing published revision remains public while an update awaits review.
Unpublishing removes it from discovery without releasing its ID to another owner.
Registry controllers remain trusted and can change its Wasm. Production controller
policy and publisher review are release decisions, not automatic test results.

The registry does not fetch publisher URLs and is not an outbound proxy. Per-owner
and global caps reject excess registrations without deleting existing records.
These bounds do not themselves prevent Sybil denial of service; public registration
capacity and abuse handling must be reviewed before mainnet release.

## Discovery protocol

Existing v1 publisher directories retain their same-origin restrictions. The new
root `/apps-v2.json` returns:

```json
{ "version": 2, "generation": "1", "page": 0, "apps": [], "next": null }
```

Each app retains id/name/description/revision/catalog/processor/setupUrl and adds
`publisher: { principal, origin }`. All three resource URLs must belong to the
approved publisher origin. The registry source is explicit client configuration;
publisher metadata cannot replace it.

Pages hold up to 16 apps, with at most 16 pages (256 published apps). Next paths are
exactly `/pages/<generation>/<page>.json`, starting at page 1. Generation is a
canonical decimal u64 string. The client validates the entire bounded snapshot
before reconciling installed apps. Duplicate IDs, mixed generations, invalid
pagination, missing pages, oversized content or fetch failures reject the entire
refresh. A partial page cannot revoke apps merely listed on a later page.

HTTP responses are certified. Use a certified HTTPS gateway domain in production,
not a raw/uncertified domain. Header presence alone in a local proxy is not
independent cryptographic certificate verification.

Persisted installation provenance includes registry source and publisher identity
and origin. Changed provenance, destination or private setup cannot silently inherit
an old connection. Existing reconnect/consent rules remain in force.

## Local development boundary

Use an isolated generated project and an explicit existing loopback replica.
Never run `dfx start`, `dfx stop`, `--clean` or a multi-canister deployment from the
OpenChat/IOU project for this test. Do not reset existing state.

Initialization `allow_loopback` is local-test-only and must be false for production.
Clients accept HTTP loopback publishers only from a loopback registry. Production
configuration must not advertise localhost or personal development hostnames.

Generated Wasm, deployment state and test evidence belong in the project-specific
temporary directory, not this checkout. No credentials, private app setup or real
test images belong in registry fixtures. The public passkey-association endpoint
is separate and must not become an app/API proxy.

## Build and operator commands

All paths below are explicit operator inputs. Use the repository-selected Rust
toolchain and already installed dependencies. The helper runs this isolated
crate's tests, locked offline Wasm build and generated-Candid comparison. The Wasm
embeds the reviewed interface as public `candid:service` metadata; its exact bytes
were checked separately during local acceptance.
It never deploys, accesses a private key or changes an existing output directory.

```powershell
./build.ps1 -OutputDirectory <new-build-directory> -TargetDirectory <external-target-cache>
node registry.mjs prepare-local --wasm-file <build>/app_registry.wasm --candid-file <build>/app_registry.did --replica http://127.0.0.1:8080 --output-directory <new-local-project>
```

The staged project contains only `app_registry`. With the existing replica already
running, use the installed dfx version recorded in its receipt (0.31.0-beta.1 in
the checked local setup). From that generated project:

```sh
dfx canister create app_registry --network registry_local --no-wallet
dfx build app_registry --network registry_local
dfx canister install app_registry --network registry_local --mode install --wasm app_registry.wasm --argument-file init.args.did
```

Prepare `init.args.did` with the explicitly selected operator's public principal:

```candid
(record { operator = principal "<operator-principal>"; allow_loopback = true })
```

The local-only mode above is not a mainnet recipe. On a recovered multi-subnet
replica, creation may need `--provisional-create-canister-effective-canister-id`
with an existing, verified allocation-routing ID. Do not guess it or reset the
replica. `dfx build` sets up artifacts needed for later Candid compatibility checks;
do not bypass those checks if the build directory is missing. For upgrades, use
`--mode upgrade`, preserve the existing canister ID, and verify state afterward.

Prepare an app's public registration from its existing published files:

```sh
node registry.mjs prepare-registration --directory-file <apps-v1.json> --source-url <publisher-directory-url> --package-directory <publisher-web-root> --app-id <app-id> --output-directory <new-registration-directory>
```

Local HTTP publishers additionally require explicit `--allow-loopback`. The tool
checks public-contract fields, exact hashes/lengths and publisher/destination origin
without executing processors. It emits `registration-descriptor.json`, safely
escaped `register-app.args.did`, and a preparation receipt. It does not replace the
client's complete semantic validation or the operator's publication review.

Using the publisher's own configured dfx identity, submit the generated arguments:

```sh
dfx canister call app_registry register_app --network registry_local --argument-file <registration>/register-app.args.did
dfx canister call app_registry get_my_apps '(null)' --network registry_local
```

The response supplies the caller-bound owner and exact commitment. Only after
review, the separately configured operator calls `publish_app(owner, app_id,
commitment)`. Do not automatically chain registration into publication. Pending
updates remain private while the previous approved revision stays available.
`get_my_apps` returns bounded pages; pass its `next` ID to retrieve the next page.
`unpublish_app(app_id, expected_revision)` is available to the owner or operator;
it invalidates earlier publication commitments, so an old retry cannot undo
revocation. Re-publication requires review of the new commitment.

For local client testing only, the adapter fixes the upstream canister Host and
exposes only directory paths, not the replica API:

```sh
node local-proxy.mjs http://127.0.0.1:8080 <local-registry-canister-id> <free-loopback-port>
```

Supply `--app-directory http://localhost:<port>/apps-v2.json` to the supported
client build/start command. The adapter does not validate subnet certificate
signatures; it is a local transport helper, not production hosting. For release,
configure the mainnet registry's certified HTTPS `/apps-v2.json` URL and real
publisher origins. This local canister does not reserve a mainnet ID.

## Verification status (2026-10-07)

- 165 focused client unit tests, 67 operator-tool tests, 4 adapter tests and
  26 isolated Rust tests passed; formatting/scoped lint passed.
- The new local canister was installed and IOU's exact previously served public
  package was registered/published without rebuilding its processor or prompts.
- Live checks rejected anonymous submission/private reads, stale approvals and
  publication replay after revocation. A real Wasm upgrade preserved published
  content, publisher ownership and revoked commitments.
- An opt-in integration test used the real client parser and network downloads to
  verify the published catalog/processor without invoking the processor. Run
  `localAppDirectory.registry.integration.spec.ts` with explicit loopback URL,
  expected app ID and publisher environment variables described in that test.
- No existing OpenChat/IOU canister was upgraded, no replica was restarted/reset,
  and no mainnet deployment was performed. The local proxy saw certificate headers;
  it did not independently verify their signatures.

Strict TypeScript found no diagnostics in edited client files; the wider dependency
closure has pre-existing/unreviewed diagnostics, so this is not a whole-frontend
typecheck pass. Existing unrelated release gates are not waived by these tests.

The installed phone APK has not been upgraded or verified against registry v2.
Phone-reachable publisher/auth configuration, the initial v2 APK, mainnet deployment,
production controller/publication policy and registration-abuse handling remain
separate release work. Unit/live parser success does not prove native Connect or
encrypted delivery. The normal Apps/Connect UI itself has not been redesigned.
