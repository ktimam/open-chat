# Action inbox lifecycle and operations

The action inbox is a generic, key-addressed store for opaque encrypted action confirmations. It
does not know any application's business logic, but it is fail-closed bound to one immutable
OpenChat app id. LocalUserIndex encrypts one envelope per registered recipient key and sends the app
id, exact manifest revision, and batch through the fixed UserIndex relay. UserIndex re-derives the
currently published destination; the inbox independently rejects a different app id. An inbox
deployment authorizes UserIndex, not individual LocalUserIndex shards, so subnet expansion does not
grow the inbox trust list.

Shared inboxes are intentionally unsupported. Each app has a separate canister and therefore a
separate global action, byte, and idempotency-tombstone quota. This prevents one app from consuming
another app's capacity without adding a second quota/index schema.

## v4 authenticity, identity, and privacy

LocalUserIndex creates the per-recipient ECIES ciphertext but does not sign the public deposit.
UserIndex revalidates the current app route and recipient-key binding, consumes a one-use
GroupIndex authority bound to the exact confirmed card, and only then signs the complete v4 outer
record with its dedicated action-inbox key. The legacy OpenChat key used by other features is not
accepted for this purpose. Direct-chat deposits are currently unsupported and fail closed; the
authority path covers groups and community channels only.

The v4 signature binds the inbox and UserIndex principals, app id and revision, action id, consumer
fingerprint, full card identity, payload hash, acknowledgement-secret hash, ECIES public key and
ciphertext, creation time, signature version, purpose, and signing-key id. The public record carries
only `card_context_hash`, a domain-separated commitment to the consumed chat/card authority. The
encrypted envelope contains dedicated-key HMAC `appSubject`, `chatHandle`, and `messageHandle`
pseudonyms scoped to the exact UserIndex/app/app-canister, plus the app/action/content/lease fields
needed to validate the deposit. Raw OpenChat principals, chat identity, message id, and thread
coordinates are not disclosed to the consumer. A consumer recomputes the commitment after
decrypting and rejects a mismatch.

The durable idempotency primary key is exactly the 32-byte consumer fingerprint plus the full
32-byte card identity. Its fixed-width tombstone value retains the signed `card_context_hash`, not
only the payload hash. This rejects the same card delivered for a different confirmer, payload,
app/revision/action, creation time, or reservation generation while allowing an exact semantic retry
to use fresh ECIES and acknowledgement randomness. There is no u64 projection and no secondary
commitment map. `StoredAction.id` remains an unrelated monotonic pagination identifier.

## Retention and acknowledgement

- ciphertext is stored in a dedicated stable-memory B-tree and retained for 30 days;
- at most 1,000 pending actions can be retained per consumer-key fingerprint;
- at most 100,000 actions can be retained by the app;
- ciphertext is limited to 64 KiB per action, retained action bytes to 4 MiB per consumer-key
  fingerprint, and retained action bytes to 64 MiB globally;
- idempotency tombstone membership and expiry order use dedicated stable-memory B-trees. Tombstones
  are retained for the same 30-day window and capped at 200,000, preventing a delayed depositor
  retry from duplicating an active action or resurrecting an acknowledged action;
- reads return at most 100 actions; deposits accept at most 32 envelopes and validate every envelope
  before any mutation;
- hourly and deposit-time cleanup remove expired records in bounded slices. Post-upgrade migration
  never performs an unbounded cleanup or index rebuild.

Action capacity also fails closed. The inbox atomically preflights the distinct unseen actions in
the whole batch against both consumer-key and app count and byte limits. Exact remaining capacity is
accepted; a one-over batch returns a throttling error and writes no actions or tombstones. It never
deletes a live, unacknowledged action to admit new traffic. Duplicate-only retries remain successful
no-ops and consume no action capacity. Only a valid acknowledgement or retention expiry releases
action capacity. Because each inbox is immutably bound to one app, its app and global limits are the
same quota.

Metrics expose current and remaining action counts and bytes, whether the app count or byte limit is
saturated, and how many consumer keys are at their count or byte limit:

- `inbox_actions`, `inbox_bytes`;
- `inbox_action_count_capacity_remaining`, `inbox_action_byte_capacity_remaining`;
- `inbox_action_count_capacity_saturated`, `inbox_action_byte_capacity_saturated`;
- `inbox_consumer_keys_at_action_count_capacity`,
  `inbox_consumer_keys_at_action_byte_capacity`.

## Bounded stable-index migration and maintenance

Stable-memory segment ids are append-only. Segment 0 remains the upgrade-state segment, segment 1
stores actions, segments 2 and 3 store idempotency tombstone membership and expiry order, segment 4
stores action expiry order, and segment 5 stores per-consumer-key action counts and bytes. An upgrade
must never renumber or reinterpret segments 0 through 3. The secondary indexes were added in new
segments 4 and 5 so an existing deployment can migrate without rewriting an old stable structure in
place.

After deserializing upgrade state, `post_upgrade` only prepares or resumes the serialized
stable-action index phase and cursor; it does not walk the action store or clear a collection. An
upgrade with pending work schedules one migration callback immediately. While work remains, that
callback self-reschedules after one second; every callback advances at most 500 stable actions.
Deposits and acknowledgements may also advance one 500-item step, while the separate hourly timer
remains in place for ordinary expiry pruning. The cursor, counters, and saturation flag are
serialized in segment 0, while completed index entries remain in segments 4 and 5, so a second
upgrade resumes after the last durable action key without double-counting it.

That bounded migration applies only to the earlier stable v4 layout. The exact committed pre-PR2
layout kept actions and replay ids in serialized heap collections, and those records do not contain
enough information to construct an authentic v4 record. After deserializing the legacy state,
`post_upgrade` checks the old `actions` and `seen` collection lengths without another scan and traps
if either is non-empty; it never silently drops them or fabricates v4 fields. Drain that old canister
with its old Wasm, or use an explicitly reviewed
export/replacement procedure. An empty legacy heap store may upgrade, but its reserved app id still
keeps deposits fail closed until the canister is replaced or explicitly migrated.

The maximum maintenance work per call is explicit:

- one migration callback or update step processes at most 500 logical items and performs at most
  3,001 stable-map API operations (the worst case is rebuilding action expiry and per-key
  accounting indexes);
- after migration, one deposit-time or hourly maintenance slice removes at most 1,000 expired
  actions and 1,000 expired tombstones. A live expired action costs at most seven stable-map API
  operations and a tombstone costs at most four, so the maintenance slice performs at most 11,000
  stable-map API operations;
- an acknowledgement does no expiry sweep and deletes at most one exact action; a deposit adds at
  most 32 validated envelopes after its bounded maintenance slice;
- an `actions` update returns at most 100 actions and examines at most 1,000 stable records, including for a
  legacy key that entered migration above the new per-key capacity.

Configuration exposes `max_expired_actions_pruned_per_call`,
`max_expired_tombstones_pruned_per_call`, and `max_migration_items_per_step`. Metrics expose:

- `inbox_index_migration_in_progress` and `inbox_index_migration_phase`;
- `inbox_index_migration_items_processed`, `inbox_index_migration_steps`, and
  `inbox_index_migration_last_step_items`;
- `inbox_index_migration_last_step_saturated`;
- `inbox_index_migration_stable_actions_indexed` and
  `inbox_index_migration_stable_actions_total`.

Traffic fails closed while an index is partial. `actions` returns a typed throttling error. A deposit
or acknowledgement that sees migration active at message entry advances at most one step and then
unconditionally returns its retry response, even if that final step completes migration. The caller
retries in a new message, preventing one ingress message from combining the migration ceiling with
normal pruning, writes, or deletion. No partial read result, capacity decision, or deletion is
authorized from an incomplete index.

Deploy readers that understand the additive `actions.Error` Candid variant and the new configuration
fields before upgrading ActionInbox. Then upgrade ActionInbox, leave its hourly timer or bounded
updates running, and wait until `inbox_index_migration_in_progress` is false and the phase is
`complete`. Do not roll back to a pre-stable-index/pre-stable-action Wasm after the first migration
step: that older code cannot see items already moved out of its heap collections. Preserve a tested
canister snapshot before the transition and use a forward fix if migration must be interrupted.

The capacity-scale PocketIC regression fills 100 fingerprints with 1,000 actions each, verifies an
exact-limit upgrade and a one-over rejection, acknowledges one exact action, and verifies capacity
recovery. It is ignored in the default suite because it performs 3,200 ingress updates; run it
explicitly with:

```bash
cargo test -p integration_tests \
  exact_global_action_capacity_survives_upgrade_and_recovers_after_one_exact_action_is_acknowledged \
  --release -- --ignored --nocapture
```

## Encoded request and response budgets

The canonical MessagePack encoding of a complete `c2c_notify_actions` request is limited to 1 MiB.
This measurement includes the app id, map field names, vector framing, and every envelope field, not
just ciphertext. LocalUserIndex checks its complete UserIndex relay request and UserIndex checks both
its inbound request and the final ActionInbox request before either outbound deposit await.
ActionInbox validates the same budget after bounded count/field validation and before any inbox or
tombstone mutation. Exactly 1 MiB is accepted; one byte over is rejected as `InvalidRequest` with no
partial storage.

An `actions` page is limited to 512 KiB using the canonical MessagePack encoding of the complete
success response. The 100-action count limit still applies, and the page stops before the first
action that would cross the byte budget. A single maximum-size action, including maximum integer and
record overhead, always fits. Consumers resume with the last returned action id as `since_id`; the
first action left out by the byte limit is then returned without a skip or duplicate. The Candid
update returns the same bounded selection of actions under consensus.

Configuration exposes `max_deposit_batch_encoded_bytes` and
`max_query_response_encoded_bytes`. Metrics expose those limits plus the saturating
`inbox_deposit_batches_rejected_oversize` counter; they never include request payloads.

Tombstone saturation fails closed. Before writing anything from a c2c deposit call, the inbox counts
the batch's distinct unseen fingerprint/idempotency pairs. Exact remaining capacity is accepted; if
the batch needs more, the whole batch returns a throttling error and writes no actions or tombstones.
Retries whose pairs already have tombstones remain successful no-ops even while full. Non-expired
tombstones are never evicted to admit unrelated traffic.

Expired tombstones are reclaimed oldest-first, at most 1,000 entries per deposit call or hourly timer
tick. If more expired entries are queued than one work budget can reclaim, a saturated batch may
remain rejected while successive calls/timer ticks make bounded progress. Configuration exposes the
capacity and prune budget; metrics expose current, remaining, and saturated tombstone state.

The stable tombstone membership key is 64 bytes (`fingerprint32 || card_identity32`), its value is
`received_at_u64_be || card_context_hash32`, and the expiry key is 72 bytes
(`received_at_u64_be || fingerprint32 || card_identity32`). This full-width layout supersedes
unshipped experimental u64-projection and payload-only-commitment layouts. Do not install this Wasm
over a canister whose segments 2 or 3 were written by either prototype; such a deployment requires an
explicitly reviewed export/reinstall plan rather than in-place reinterpretation.

Envelope v4 carries a fresh random 32-byte acknowledgement secret for each recipient, encoded as
base64url in the encrypted `acknowledgementSecret` field. The raw secret exists only inside that
recipient's ECIES plaintext. The deposit carries, and stable storage retains, only:

```
SHA256(
"openchat-action-inbox-ack-secret-v1" ||
u8(canister_principal_length) || canister_principal_bytes ||
consumer_key_fingerprint_32_bytes || acknowledgement_secret_32_bytes
)
```

`acknowledge_actions` requires the raw secret for the exact live action named by `through_id`,
compares the computed hash in constant time, and deletes only that exact action. `through_id` is a
legacy Candid field label retained to preserve its field hash; it no longer means "delete through
this cursor." Binding the stored hash to the inbox canister and fingerprint prevents
cross-deployment and cross-bucket reuse; storing it at the action's stable key binds it to the exact
action. A replay after the action is gone or a request for an absent action remains a cheap successful
no-op.

The endpoint intentionally does not offer cursor/range deletion. `actions` is a replicated update,
so returned membership, ids, ordering, and pagination boundaries come from consensus rather than an
uncertified replica. A decrypted secret still authorizes deletion of only that exact action. This
limits damage from consumer-side pagination, persistence, or crash-recovery bugs and leaves every
other action pending until it is separately decrypted and acknowledged (or expires).

The replicated update performs no PEM parsing or P-256 verification. A bad live-action request costs
one exact stable lookup, one bounded SHA-256 input, and one fixed-size comparison. It creates no
per-caller or per-fingerprint failure state, so Sybil callers cannot multiply an expensive replicated
operation and invalid traffic cannot lock out a later valid secret holder. No separate read-minted
token is needed: the per-action secret already provides a narrow bearer capability for the exact
replicated record returned to the consumer.

The PocketIC Sybil regression sends 16 invalid live-action updates from distinct principals, caps the
measured canister spend at 10 billion cycles per rejected call, and then proves that the valid secret
still acknowledges the action. This intentionally generous ceiling catches a regression back to
replicated asymmetric verification while allowing replica accounting differences.

The old `consumer_public_key_pem` and `signature` request fields remain in Candid for wire
compatibility but are ignored. Omission of `acknowledgement_secret` fails closed for a live action,
and a secret of any length other than 32 bytes is rejected before hashing. Legacy stable actions
deserialize with an empty hash and stay readable, but cannot be acknowledged; they expire under the
normal retention policy. The wire record retains `through_id`, and a Candid compatibility test proves
that the previous request record (which omitted `acknowledgement_secret`) still decodes in the new
Wasm.

Reads are intentionally key-addressed public replicated updates. The payload remains confidential
under ECIES, but anyone who learns an exact selector can observe that queue's metadata such as
action ids, timestamps, sizes, and counts. The selector is therefore issued as private routing
material even though it is not sufficient to decrypt or acknowledge an action.

UserIndex computes the 32-byte selector with its dedicated stable AI-app HMAC key over a
domain-separated preimage containing the exact UserIndex, app id, app canister, inbox canister, and
canonical uncompressed P-256 point. It is not a SHA-256 digest of public coordinates. Another app
that knows the PEM and every public route coordinate still cannot derive or poll this queue.
Per-user selectors are returned only to the exact registered app canister during an authenticated
link-code claim. App-level selectors are returned only by the app-canister-authenticated selector
endpoint for the exact current app revision and action. Trusted OpenChat relay hops carry the opaque
selector; LocalUserIndex never re-derives it from the PEM.

The wire and stable field remains named 'consumer_key_fingerprint' for compatibility, but new code
must treat it as an opaque HMAC selector. It must not log it, publish it in app registry responses,
store it in browser localStorage, or derive it from public inputs. The encrypted acknowledgement
secret is additionally required for destructive acknowledgement.

## Consumer encryption-key rotation

1. Keep the old private key and its exact privately issued UserIndex/app/inbox selector.
2. Register the new public key for the user/app pair. Confirmations after that point route only to the
   new selector.
3. Drain and decrypt the old selector, then acknowledge each processed action id with that
   action's decoded raw secret.
4. Discard the old key only after the acknowledgement response reports `remaining = 0`.

The new and old queues are independent; acknowledging the old selector cannot touch the new one.
The canister does not maintain app-specific key history or re-encrypt queued actions: the consumer is
responsible for retaining the old private key until its old queue is drained or expires.

## Platform action-signing key rotation

UserIndex persists at most three dedicated action-signing keys in `Staged`, `Active`, or
`VerifyOnly` state. Rotation is deliberately operator controlled:

1. submit the governance proposal that stages a new key;
2. distribute and independently pin its key id in each external consumer while it remains staged;
3. submit a separate governance proposal naming that exact key id to activate it;
4. retain the old public key as `VerifyOnly` for 30 days, while immediately removing its private DER
   from the live serialized keyring.

Consumers accept only independently pinned key ids. The public `action_signing_keys` query is useful
for discovery and health checks but is not a trust root. For a `VerifyOnly` key they also require the
deposit's signed `created_at` to be no later than `verify_until`. No timer or upgrade activates a
staged key automatically. The discovery query stops advertising a `VerifyOnly` key at the exact
`verify_until` cutoff even if the hourly storage-cleanup timer has not run yet.

The dedicated DER allocation and the per-call signing clone are zeroized on drop. After a successful
UserIndex restore, a timer job overwrites the whole allocated upgrade-memory segment—including stale
trailing bytes—in callbacks capped at 256 KiB. The segment retains the existing raw MessagePack
format, so a later ordinary rollback remains compatible: `pre_upgrade` writes a fresh snapshot
before installing the rollback Wasm. If another upgrade interrupts the scrub, timers are discarded
by the platform and the next successful `post_upgrade` restarts from offset zero across the full
allocated segment.

This is a best-effort overwrite of memory addressable by the canister, not a physical-media erasure
guarantee. A `Vec` can have allocator history outside its current allocation, ICP snapshots capture
both heap and stable memory, and canister code cannot erase controller-created snapshots/backups or
prove erasure of replica storage history. Before claiming cryptographic erasure, validate the timer
job on ICP and require an explicit controller snapshot/backup deletion and rollback policy.

## v4 rollout compatibility

The v4 deposit is an intentionally coordinated contract change: it replaces the u64 identity
projection, adds the authority commitment and complete outer signature, and moves signing from
LocalUserIndex to UserIndex. Use this rolling order:

1. deploy UserIndex with the dedicated keyring and v4 relay; its initial key is staged, not active;
2. configure consumer pin allowlists from an independently authenticated key-id source;
3. explicitly activate that exact staged key through governance and verify the health query;
4. deploy the v4 ActionInbox interface and stable schema;
5. deploy GroupIndex authority support, then chat canisters and LocalUserIndex shards that produce
   unsigned v4 deposits for UserIndex to authorize and sign.

Keep the feature switches disabled until every hop is upgraded and the consumer pins are installed.
Mixed v3/v4 delivery is unsupported: v4 validation rejects incomplete or version-mismatched records
before any tombstone or action write, so cards remain Pending and can retry after rollout completes.

The scoped-selector/context-v2 change is also incompatible with unshipped experimental v4 queues.
Drain those queues with the old consumer before upgrading, or explicitly discard/reinstall them under
a reviewed reset policy. ActionInbox cannot translate raw-key SHA-256 selectors or raw-context
ciphertexts because it has neither the consumer public key nor UserIndex's dedicated HMAC secret.
Do not run old and new LocalUserIndex/UserIndex producers against one inbox. Short-lived capabilities
and confirmation grants that carry a legacy unscoped fingerprint fail closed and may simply expire.

The acknowledgement request retains its legacy Candid field labels, but a live v4 action can be
deleted only with its exact decrypted 32-byte acknowledgement secret.

## Deployment validation

The binding-safe creation order is:

1. allocate (but do not install) the ActionInbox canister id;
2. register the app manifest with that inbox principal and record the returned app id;
3. install ActionInbox with that exact app id and the expected UserIndex relay;
4. publish the app. Publication queries the inbox and fails unless both bindings match.

An upgrade from the earlier experimental, unbound state deserializes with reserved app id 0 and
rejects every deposit. There is deliberately no runtime endpoint that can rewrite this trust
binding. Such a canister must be replaced or migrated under an explicitly reviewed operator plan
before traffic is enabled; it cannot silently become authoritative for an app.

Run the read-only validator after every production install or upgrade:

```bash
bash scripts/validate-action-inbox-wiring.sh ic \
  <action-inbox-canister-id> <user-index-canister-id> <local-user-index-canister-id> <app-id>
```

It fails unless the inbox is bound to the expected app id, points to and authorizes only the expected
UserIndex relay, LocalUserIndex routes to that inbox, and UserIndex exposes an active dedicated v4
action-signing key. It never writes canister state. That key query is a health check only; the
consumer's independently pinned key-id allowlist remains authoritative.

Automatic creation/install/upgrade wiring is intentionally not claimed here. The required topology
change must be explicitly approved before it touches the core installer: add ActionInbox to
`CanisterType`/`CanisterIds`, create and controller-bind it in deploy scripts, upload/install it beside
the four core canisters, pass its id through UserIndex and LocalUserIndex init, and add it to
cycles-dispenser top-ups. Until that approved work lands, operators must install/configure it
explicitly and the validator will fail closed on any omitted step.
