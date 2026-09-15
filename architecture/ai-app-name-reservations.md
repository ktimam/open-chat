# AI app name reservations

AI app names are a generic OpenChat namespace. Registration creates a private development draft; it does not prove ownership of a public name. Exclusive ownership begins only when the app canister vouches for the exact name/owner/revision and SNS governance publishes that revision.

## Canonical names

New names are 1–64 ASCII letters or digits with spaces, hyphens, underscores, and dots only between alphanumeric characters. Collision checks ignore ASCII case and those separators. For example, `Acme App`, `acme-app`, `acme_app`, and `acme.app` share one key. Rejecting non-ASCII names prevents Unicode homoglyphs from creating visually indistinguishable namespace claims without relying on a mutable Unicode-confusables table.

## Bounded drafts

- An owner may hold at most five unpublished drafts.
- The registry contains at most 10,000 total apps.
- An unpublished draft expires 30 days after its last registration/update. Expired drafts are immediately hidden and cannot be published; the next registration lazily removes them before quota checks.
- Published apps are exempt from draft expiry and per-owner draft quota because publication already requires canister verification and governance.
- Two owners may reserve the same unverified canonical name. Update calls are serialized, and only the first exact revision that completes publication can own the key. Later contenders fail closed.

These controls are derived from the existing serialized `apps` map. There are no auxiliary counters or indexes to migrate or reconcile across upgrades. A MessagePack round-trip test verifies that quota and expiration behavior survive stable-state restore.

## Recovery

An owner can delete its own app by canonical name. SNS governance can call `remove_ai_app(app_id)` when an owner is lost or an app is abandoned. Both operations release the registry slot and verified name; cleanup of external per-user keys and outstanding link-code state belongs to those stores' lifecycle.

## Test coverage

Rust model tests cover canonical case/separator collisions, Unicode confusables, per-owner and global quotas, exact-TTL expiry, publication after expiry, duplicate unverified contenders, serialized single-winner publication, deletion, governance removal, id overflow, and stable serialization. PocketIC integration tests cover the public registration quota/confusable checks, lazy expiry, and governance recovery endpoint.
