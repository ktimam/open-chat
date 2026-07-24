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
  none, IOU's card shows a "Default currency" option (`""`) and OMITS currency from the confirm
  payload; the REAL IOU app injects the default at import (`baseWithDefaultCurrency`). A hardcoded USD
  would have silently regressed Issue 3 for non-USD users. Verify:
  `IOU/scripts/live/verify-default-currency.ts` (deposit carries no `currency` field).
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
- **Framing carve-out.** IOU `/openchat/card` framing is all-or-nothing (dev = no XFO; prod
  `.ic-assets.json5` = `frame-ancestors 'none'` for `**/*`, which also blocks OpenChat). Add a
  per-path `frame-ancestors https://<oc-origin>` for `/openchat/card` so it productionizes without
  opening framing to everyone. Impact low (page is session-free/partitioned; confirm does nothing
  privileged).
- **Deposit-before-commit TOCTOU.** The Pending check is `&self` and the flip happens after the c2c
  `.await`, and the inbox idempotency key is `sha256(payload‖message_id)` — so concurrent confirms
  with *distinct* in-bounds overrides all deposit. Neutralized end-to-end by IOU's `messageId` dedup
  (`collapseByMessageId` / `import_message_id` / `importedMessageIds`); residual is attacker-self-funded
  griefing. Fix: key the inbox idempotency on `sha256(chat‖message_id)` (stable card identity) or add a
  per-card single-flight that leaves Pending before the await.
- **Card not bound to its producing app.** Owner resolved by non-namespaced action `name` +
  `owners.find(enabled) ?? owners[0]`; `validate_surface` accepts any http(s) URL. Not exploitable today
  (SNS publish-gate + vouch; lowest-id wins for established apps; 1:1 direct chats safe). Harden: carry an
  owning `appId` on the card and resolve the surface by it; constrain card-surface origin to the app's
  verified domain; re-vouch surfaces on re-registration.
- **No third-party-embed provenance chrome** + `deriveCardOrigin` accepts same-origin-as-host and
  `http:`. Add a host-drawn "external content from <origin>" badge OUTSIDE the frame; reject
  `parsed.origin === location.origin` and require https (localhost-exempt for dev). Note an app-origin
  allow-list does NOT help a malicious own-app.
- **No inbound throttle** on the host bridge (`oc:card:resize`/`ready` spam → frame-capped host reflow,
  info). Coalesce resize in a rAF; once-guard `ready`.
- **Outbound `targetOrigin "*"`** (host + IOU): pin to the concrete peer origin once known.
