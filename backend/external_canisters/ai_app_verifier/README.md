# AI app publication verifier V2

`c2c_verify_ai_app_v2` is the generic publication trust contract for every external app. UserIndex
accepts a publication only when the canister named by the manifest returns `vouched = true` and
echoes its independently configured `VerificationBindingV2` exactly.

The 32-byte manifest commitment is:

`SHA-256("openchat.ai-app-manifest.v2\0" || canonical_manifest_bytes_v2)`

Do not hash raw Candid bytes. Candid values are semantically canonical after decoding, but different
implementations may emit different valid type-table orderings for the same value. The V2 canonical
bytes are language-neutral and defined in
`api/src/updates/c2c_verify_ai_app_v2.rs::manifest_commitment_bytes_v2`:

- prefix ASCII `OC-MANIFEST` followed by byte `0x02`;
- commitment and nested manifest fields in the fixed order declared by that function;
- unsigned 32-bit byte lengths/vector counts and u32/u64 values in big-endian order;
- strings as UTF-8 and principals as raw principal bytes, each prefixed by its byte length;
- options as `0x00` or `0x01 || value`, booleans as `0x00`/`0x01`, and explicitly documented
  zero-based enum tags;
- vector order is significant.

The cross-language fixture in the Rust test hashes to
`93f82f31d31c7cea66bd8d6e434b77442c035d7386f52fad4019250625db71b9`. App implementations must
reproduce that vector before publication tooling is considered compatible.

It binds the UserIndex canister, owner, canonical app name, immutable app id, exact draft revision,
original manifest name, app/inbox canisters, surfaces, actions, endpoints, schemas, rules and app or
per-user delivery-key policy. Manifest vector order is significant.

## Rollout and app migration

1. Create/reserve the app canister id.
2. Register the complete manifest pointing at that canister. Keep the returned app id and revision.
3. Build the V2 commitment from the returned canonicalized manifest and configure the app canister
   with the resulting exact binding.
4. Implement `c2c_verify_ai_app_v2` so it compares the challenge to that stored binding and returns
   the stored binding; do not blindly reflect caller input.
5. Request publication. Any false response, mismatch, decode/call failure, or V1-only implementation
   returns `NotVerified`.

On the first UserIndex upgrade carrying V2, legacy V1-approved apps are unpublished once and given a
fresh draft revision/TTL. Their owners must upgrade/configure the app canister and republish using the
steps above. The old `c2c_verify_ai_app` interface may remain for compatibility, but UserIndex never
uses it as publication authority.
