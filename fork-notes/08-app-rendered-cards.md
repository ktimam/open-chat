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
```
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
