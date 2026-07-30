# App-rendered confirmable cards (design + build contract)

**STATUS: DONE + live-verified (2026-07-24)** — all 3 phases shipped. IOU renders its own card in an
`<iframe credentialless>` inside the OpenChat chat, prefilled + editable; "Add to IOU" deposits the
EDITED values on-chain via `respond_to_action_card`'s `confirm_payload_override` (bounded 16 KB,
authed confirmer). Live proof: extraction 350/EGP/credit → edited 724699/USD/debt round-trips into
the inbox. Verify: `IOU/scripts/live/{verify-app-card,verify-app-card-edit}.ts`. Caveat: Phase-2's
`generate-typebox-types.sh` full-regen surfaced pre-existing typebox drift (stale AI-app symbols the
committed frontend still imports), so the 3 new typebox fields were hand-added on HEAD instead of a
full regen — reconciling that drift is a separate, out-of-scope AI-app-API migration.

**Principle:** the confirmable-action card's look AND function belong to the **app**, not OpenChat.
OpenChat becomes a generic, card-agnostic host: it embeds the app's card page in the chat bubble and
relays confirm/cancel. Added once, then no OpenChat change per app.

Supersedes the OC-renders approach in `07-interactive-action-card-fields.md` (which kept OpenChat
drawing the card). This note is the build contract.

## Why an iframe (and why one canister change is unavoidable)

- The card is a chat message → it must render inside OpenChat's client. To let the **app** own the
  pixels, OpenChat embeds the app's page in an **iframe** (the existing `surfaces` mechanism already
  embeds app pages via `display: "sheet"`).
- Embedded iframes are **storage-partitioned** by the OpenChat host origin (this is why the existing
  `chat_link` surface opens `external`, not embedded — a partitioned frame sees no IOU session). So
  the card iframe can only **render + collect** edited values; it cannot write to the app's canister
  directly.
- The on-chain deposit (`respond_to_action_card` → `c2c_deposit_action_confirmed`) reads a **frozen**
  `confirm_payload` stored at post time. To deposit the user's **edited** values, the canister must
  accept the app's final payload. → the single required canister change.

## Bridge protocol (postMessage)

Origin-checked both ways (host ⇄ the app's registered surface origin).

Host (OpenChat) → iframe (app):
```
{ type: "oc:card:init", version: 1,
  data: <the extraction object>,            // prefill values
  context: { chatKey, appId, actionId, theme: "light"|"dark", readonly: boolean } }
{ type: "oc:card:busy", version: 1, busy: boolean }   // confirm/cancel round-trip in progress
```
`oc:card:busy` is a generic progress signal so the app can lock its own in-frame buttons and show a
spinner while a confirm/cancel deposits + fans out (the buttons live in the iframe now). It is a bare
boolean — no app or canister data — posted to the card origin whenever the host's `busy` flips, and it
resets on success OR failure. Presentation-only: the host's `confirm`/`cancel` handlers still screen
`!cardActionable || busy`, so a card that ignores the signal is no less safe.
iframe (app) → host:
```
{ type: "oc:card:ready" }                    // mounted; host may (re)send init
{ type: "oc:card:resize", height: number }   // host sizes the bubble iframe to content
{ type: "oc:card:confirm", payload: <final edited object> }   // → host deposits this
{ type: "oc:card:cancel" }
```
Host ignores any message whose `event.origin` is not the app's registered surface origin, and
ignores `confirm`/`cancel` when `readonly` (a card already consumed, or the non-acting member).

## Manifest (app side — no canister change)

Add a surface kind `"card"` whose URL is the app's card renderer, e.g.
`${origin}/openchat/card`. Surfaces already round-trip and unknown kinds are ignored, so this is a
pure app-manifest declaration. The OC renderer looks the app up by the card's `actionId`, finds its
`card` surface, and embeds it; absent → falls back to today's OC-rendered rows (backward compatible).

## OpenChat client (Phase 1 + 3, no canister change)

- `ActionCardContent.svelte`: if the app (by `actionId`) declares a `card` surface, render an
  `<iframe src=cardUrl sandbox="allow-scripts allow-same-origin">` sized by the resize bridge, instead
  of the rows/buttons. Wire the bridge; on `oc:card:confirm` call
  `client.respondToActionCard(..., "confirm", payload)`; on `oc:card:cancel` → `"cancel"`.
- Thread the optional `payload` through `respondToActionCard` → worker `respondToActionCard` → agent →
  group/community/user client → the canister arg.

## OpenChat canister (Phase 2 — the one required change)

`respond_to_action_card` `Args` gains `confirm_payload_override: Option<ByteBuf>`:
- Only used when `response == Confirm` and the caller is the (existing-authed) confirmer.
- **Bounded** (reject > 16 KB) so a member can't deposit an arbitrary blob.
- When present, the deposit uses it in place of the stored `confirm_payload`; else unchanged.
- The app already validated the payload against its own schema client-side; the canister stays
  semantics-blind (it deposits opaque bytes, exactly as today).
- Applies to `group`, `community`, and `user` canisters (candid regen + rebuild/redeploy).

## App (IOU) — the card page (Phase 1)

`/openchat/card`: a self-contained page (works storage-partitioned — it needs NO IOU session; it only
renders + collects). On load: postMessage `oc:card:ready`, receive `oc:card:init`, render IOU's card
UI prefilled from `data`:
- currency: `<select>` (IOU's currency list) · direction: `<select>` (Owed to you / You owe) ·
  amount: number · note: text · plus a demo `multiselect` control (the vocabulary).
- IOU-styled (IOU owns look). Emit `oc:card:resize` on content change. On the "Add to IOU" button →
  `oc:card:confirm` with the edited object (shape = `EntryDraft` that IOU's `parseDraft` already
  accepts). On cancel → `oc:card:cancel`.
- The edited object flows: iframe → OC host → respondToActionCard(payload) → canister deposit →
  fan-out → the user's REAL (non-partitioned) IOU app imports it exactly as today.

## Phasing

1. **App-rendered editable card (client + IOU, no canister change):** IOU card page + OC iframe
   renderer + bridge + IOU manifest `card` surface. The card renders IOU's editable UI in chat. (Edits
   not yet deposited — Phase 2 wires that.)
2. **Deposit the edited payload (the one canister change):** `respond_to_action_card` override +
   candid + rebuild/redeploy (group/community/user).
3. **Thread + live-verify:** payload through client/worker/agent; end-to-end (edit currency/direction
   in the in-chat card → Add to IOU → deposited edited values → IOU imports them).

## Backward compatibility

Cards from apps that declare no `card` surface render exactly as today (OC rows). The canister
override is optional; a confirm with no override behaves identically to today.

## Addenda (2026-07-24) — multi-entry + default-currency, both live-verified

- **Multi-entry through the app card.** A propose yielding several extractions posts ONE card whose
  hidden `__oc_entries__` sentinel row carries the exact validated entry array (rows ARE hydrated on
  read; `confirm_payload` is not). `ActionCardContent.postInit` prefers `extractEntriesRow(rows)` and
  sends `data = { entries: [...] }`; the app draws N editable rows and confirms the WHOLE batch as a
  single envelope via `confirm_payload_override` (a top-level array). "Several entries, ONE message
  consumed." Verify: `IOU/scripts/live/verify-app-card-multi.ts` (edit + currency/direction preserved)
  and `verify-multi-entry.ts` (the IOU BatchConfirmModal import → both land, messageId consumed).
- **Missing currency defers to the IOU default (app-side).** The card iframe is storage-partitioned
  and cannot read `prefs.defaultCurrency`, so it must NOT invent a currency. When the extraction has
  none, IOU's card shows a "Your IOU default" option (`""`) and OMITS currency from the confirm
  payload; the REAL IOU app injects the default at import (`baseWithDefaultCurrency`). A hardcoded USD
  would have silently regressed Issue 3 for non-USD users. The card CANNOT show the literal code — see
  the 2026-07-30 addendum below for the three measurements that rule every channel out. Verify:
  `IOU/scripts/live/verify-default-currency.ts` (deposit carries no `currency` field) and
  `IOU/scripts/live/card-default-currency.ts` (the picker itself defers).
- **Live harnesses confirm INSIDE the iframe.** `journey-fanout.ts` / `verify-multi-entry.ts` match
  this run's card by the unique note in the iframe's inputs (not `.action-card` innerText) and click
  the iframe's button — no OC disclosure checkbox (the app-card bridge confirm is screened by
  `pending && !readonly`; the app owns any disclosure). The CONFIRMER (non-proposer, `readonly=false`
  in a DM) can act from their own iframe; fan-out delivers to both buckets.

## Security review (2026-07-24) — verdict + residual hardening

Adversarial review of the whole iframe addition (5 dimensions × find→refute→verify, 19 agents).
**Verdict: ship-safe — no medium-or-higher survived; all 9 confirmed findings are low/info** (four
originally-"medium" findings collapsed to low under the governance publish-gate, IOU's strict
`messageId` dedup, the visible-values + per-member second-review gates, and site-isolation). A formal
deeper review is not a blocker. Done as a fast-follow: the IOU card listener now pins
`event.source === window.parent` (rejects a co-resident sibling frame forging `oc:card:init`/`busy`)
and caps parsed `entries` at `MAX_CARD_ENTRIES` — closing the init-injection, busy-spoof and
entries-DoS findings at once.

Residual low/info hardening (tracked, not shipping blockers):
- **Framing carve-out.** ✅ DONE (2026-07-24, IOU repo). Goal: OpenChat-only framing — close the dev
  "any origin can frame" hole and stop prod blocking OpenChat, without opening framing to the world.
  Not implementable as a literal per-*path* rule: IOU is a single-page app, so `/openchat/card` (and
  the `display:"sheet"` "home" surface at `/`) are client-side routes served from the SAME physical
  asset, `index.html`; the IC asset canister matches `.ic-assets.json5` globs against asset KEYS, not
  request paths, so a `/openchat/card` match hits nothing. Implemented instead as a per-*asset*
  carve-out on `index.html`:
  - `public/.ic-assets.json5`: `**/*` stays `frame-ancestors 'none'` + `X-Frame-Options: DENY`; a new
    `index.html` entry (placed after `**/*`, so it wins) sets `frame-ancestors https://oc.app` and
    drops XFO to `""` (XFO can't express an allowlist and a lingering DENY would veto frame-ancestors).
    Other real OpenChat origins (test.oc.app, a fork's custom domain, local `:5003`/`:5001` for a
    locally-deployed asset canister) go in that one allowlist. Full header set is re-declared on the
    entry so nosniff/Referrer/Permissions survive regardless of the canister's match-merge rule.
  - `vite.config.ts`: a `configureServer` middleware mirrors the posture on the dev server (which
    previously sent NO framing headers) — HTML-document responses get the OpenChat dev-origin
    allowlist (`http://localhost:5003`/`:5001` + 127.0.0.1), everything else gets `frame-ancestors
    'none'`; no XFO. Verified live: `/openchat/card` + `/` → allowlist, `/favicon.svg` → 'none'.
  Residual (unchanged, low): relaxing `index.html` lets OpenChat frame ALL SPA routes, not just the
  card — but a cross-origin embed is storage-partitioned (framed app sees no IOU session → signed-out
  shell), and the card is session-free by design, so impact stays low. A truly path-scoped rule would
  require promoting `/openchat/card` to its own physical HTML entry point (multi-page Vite build) —
  deferred as disproportionate for a low-sev item, and it would leave the "home" sheet surface
  unframeable. Separately, prod canister serving of deep SPA routes (`/openchat/card`) still depends on
  an index.html fallback being configured — out of scope here, but needed before the card renders from
  a real IC deployment.
- **Deposit-before-commit TOCTOU. — FIXED (2026-07-24).** The Pending check is `&self` and the flip
  happens after the c2c `.await`, so concurrent confirms with *distinct* in-bounds overrides all pass the
  peek and deposit. It was already neutralized end-to-end by IOU's `messageId` dedup (`collapseByMessageId`
  / `import_message_id` / `importedMessageIds`) — residual was attacker-self-funded griefing — but the
  inbox idempotency key was `sha256(payload‖message_id)`, i.e. derived from the MUTABLE payload, so N
  distinct-payload confirms produced N distinct ids → N stored envelopes for the one card, and a future
  naive consumer without strict `messageId` dedup could regress. Restored a true "at most one deposit per
  card" guarantee at the inbox layer: `c2c_deposit_action_confirmed` now keys idempotency on the STABLE
  card identity — `sha256(chat_key(chat) ‖ 0x00 ‖ message_id)` — instead of the payload, so a user retry,
  the platform's automatic c2c retry, AND a concurrent distinct-payload confirm all dedupe to one entry
  per recipient fingerprint bucket. Regression guards: the pocket-ic `two_phase_confirm_idempotency_tests::
  concurrent_distinct_payload_confirms_deposit_once` SUBMITs two confirms of one card with distinct
  `confirm_payload_override`s before awaiting either (so both pass the `&self` peek and both deposit) and
  asserts a single stored action — verified to FAIL (2 actions) against the old payload-keyed build; plus
  unit tests on the extracted `card_idempotency_id` helper (`same_card_yields_same_id` etc.) that lock the
  key to card identity alone. The alternative (a per-card single-flight leaving Pending before the await)
  was not needed once the dedup layer enforces the guarantee.
- **Card not bound to its producing app. — MOSTLY DONE (2026-07-24, see fast-follow below).** Owner was
  resolved by non-namespaced action `name` + `owners.find(enabled) ?? owners[0]`, and `validate_surface`
  accepted any http(s) URL — so a second app declaring the same action `name` could resolve the card to
  ITS surface. Never exploitable today (SNS publish-gate + `c2c_verify_ai_app` vouch; lowest-id wins for
  established apps; 1:1 direct chats safe), but the resolution was authority-blind. Now: the card carries
  its owning `appId` (hydrated on receive) and the surface resolves by that exact id; embedded (sheet)
  surfaces must be https; a re-registration that changes surfaces re-runs the vouch. **Residual:** the
  card-surface origin is only https-tightened, not bound to the app's *vouched* web origin — full binding
  needs `c2c_verify_ai_app` to attest an allowed origin (cross-repo: IOU's card surface is its FRONTEND
  origin, a different canister from the `app_canister_id` the vouch targets, so a strict host==canister
  check would be wrong). Optional: namespace action names to the owner.
- **No third-party-embed provenance chrome** + ~~`deriveCardOrigin` accepts same-origin-as-host and
  `http:`~~. **`deriveCardOrigin` hardened (2026-07-24):** rejects `parsed.origin ===
  window.location.origin` and requires https (loopback http exempt for dev). Still to do: a host-drawn
  "external content from <origin>" badge OUTSIDE the frame. Note an app-origin allow-list does NOT help a
  malicious own-app.
- **No inbound throttle** on the host bridge (`oc:card:resize`/`ready` spam → frame-capped host reflow,
  info). Coalesce resize in a rAF; once-guard `ready`.
- **Outbound `targetOrigin "*"`** (host + IOU): pin to the concrete peer origin once known.

### Fast-follow shipped (2026-07-24) — bind the card to its producing app

Closes the "wrong app renders the card" structural phishing gap. Code-complete + unit-tested; the wire
change needs a **candid regen + rebuild/redeploy of the group / community / user + user_index canisters**
to take effect (same phasing as the Phase-2 override). Compiles clean (`cargo check` on `types`,
`chat_events`, `user_index_canister_impl`, `integration_tests`); all touched TS + Rust unit suites green.

1. **`appId` on the card, hydrated on receive.** `ActionCardContent(Initial)` +
   `ActionCardContentInternal` carry `app_id: Option<AiAppId>` — set at propose/post time (where
   `recipient_public_key` is baked) and, UNLIKE the send-only routing fields, HYDRATED back to clients.
   Threaded through `buildActionCardContent`/`buildMultiActionCardContent` → `runAiAction` /
   `buildManualCard` / `runDefinition` (from the resolved candidate's `app.id`), chatMappersV2 both ways,
   and the hand-maintained typebox schemas. Legacy cards (no `appId`) still resolve by name.
2. **Resolve the surface by that exact `appId`.** `cardSurfaceForAction` binds to the one app whose
   `id === appId` (still verifying it declares `actionId`, else render OC rows — never silently re-bind);
   the Svelte card passes `content.appId`. Name-based resolution stays only as the legacy fallback.
3. **Registration https-tightening (partial item 3).** `validate_surface` requires embedded (display
   `"sheet"`) surfaces to be https (loopback http exempt), mirroring `deriveCardOrigin`.
4. **Re-vouch on surface change.** `AiAppRegistry::register` un-publishes (resets `published = false`)
   when an upsert changes the manifest's `surfaces` or `app_canister_id`, forcing `publish_ai_app` to
   re-run the vouch; an unchanged re-sync stays published.

Tests: `frontend/app/src/utils/{cardBridge,aiAppSurfaces}.test.ts`,
`frontend/openchat-shared/src/domain/aiAction.test.ts` (builder `appId`); Rust unit tests in
`ai_app_registry.rs` (un-publish on surface/canister change) + `register_ai_app.rs` (sheet-surface scheme
gate). The 6 integration-test `ActionCardContentInitial` literals gained `app_id: None`.

## Why the card cannot SHOW the user's default currency (2026-07-30) — investigated, reverted

The card shows **"Your IOU default"** rather than the literal code (e.g. `EGP`) when a message states no
currency. That is not a shortcut — it is the only correct option, and this records why so it is not
"fixed" again. The rejected fix (an anonymous `chat_key -> ISO code` map on the IOU canister, read by the
card page) was built, deployed locally, live-verified working, and then **reverted**. Three independent
findings, all measured on the live setup, kill it:

1. **A direct-chat key names only the COUNTERPARTY, so it is not a per-viewer key.** Live proof from two
   profiles' stored links: child → `direct:wrjd4-…` → sheet `c819f76d…`, mother → `direct:wrjd4-…` →
   sheet `da0f6b42…`. Byte-identical keys (`wrjd4-…` is father), different sheets — every user chatting
   with the same person shares one map entry, so their writes clobber each other. The existing
   `chat_sheet_links` map is safe only because it *is* caller-keyed (`caller\0chat_key`); an anonymous
   reader cannot supply a caller, which is the whole problem.
2. **It answers the wrong question.** The map returned the linked sheet's founding
   `enabled_currencies[0]` — a per-SHEET fact. `c819f76d…` is USD because *father* created it, so the
   child's card showed **USD** and then CONFIRMED `currency: "USD"`, making the import store USD for a
   user whose default is EGP. That is exactly the bug the deferral exists to prevent, reintroduced.
3. **The frame cannot cache anything either.** Measured by injecting both frame types into the live OC
   page: with `credentialless` (what we use) `localStorage` writes succeed but read back `null` after a
   top-level reload — the storage is an ephemeral nonce partition. Without `credentialless` the frame
   **does not load at all** (OC is COEP:credentialless and IOU's page sends no `Cross-Origin-Resource-
   Policy`). So "remember what the user picked" needs BOTH an OC attribute change and a CORP header.

**Conclusion:** a PER-VIEWER code is impossible without OpenChat passing a viewer identity in
`oc:card:init`. A SHARED one is not: IOU added `Config.card_currency`, a deployment-wide code the frame
reads through the ANONYMOUS `get_config` query and pre-selects for everyone (zero OpenChat changes).
Both members of a card see it and — since a non-empty currency travels in the confirm payload — both
import it; that sharing is the deliberate trade-off that makes it possible at all, and it is only a
pre-selection anyone can change before confirming. A currency the MESSAGE stated still wins, and unset
restores the per-user deferral. Verified live on two members (both showed EGP) plus the clear path:
`IOU/scripts/live/verify-card-app-currency.ts`.

The per-user default remains what IOU itself uses everywhere (entry form, imports when no card currency
is set); it now lives on the canister as `UserRecord.default_currency` so it follows the user across
devices.

Guard: `IOU/scripts/live/card-default-currency.ts` drives `/openchat/card` with an injected init using a
chat key that IS linked to a sheet, and asserts the card still defers (invented and absent currencies)
while honouring a currency the message DID state. `IOU/src/lib.rs` documents MemoryId 21 as burned.
