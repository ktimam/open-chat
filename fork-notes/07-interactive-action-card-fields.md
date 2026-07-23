# Interactive confirmable-action card fields (proposal)

**Status:** design + compilable type stub (`openchat-shared/src/domain/chat/actionCardFields.ts`).
Not yet wired into the live card. This note is the plan to make it real.

## Problem

Today an `ActionCardContent` is **read-only**: `rows: {label, value}[]` display, an optional
disclosure checkbox, and confirm/cancel. `confirmPayload` (opaque bytes) is frozen when the card is
posted — the user can only accept or reject exactly what the model extracted. So an app cannot let
the user *pick* a value in the card (e.g. choose the currency, flip the direction, fix the amount)
before it is deposited. Doing so today would require an OpenChat change every time.

## Goal & principle

Make interactive fields a **generic, declarative capability** — added to OpenChat **once** — so that
afterwards any app adds interactive cards purely by declaring fields in its manifest, with **no
further OpenChat change**. This is exactly how display rows already work: an app adds any rows it
likes via its manifest because OpenChat renders `{label,value}` generically.

**The invariant we must not break:** OpenChat plumbs field values *by key* and never interprets what
a key *means*. The only place OC touches the payload is a pure shallow key-merge (`mergeFieldValues`);
currency, amount, direction stay app semantics. This keeps the fork generic and upstream-friendly.

## The vocabulary

See the stub for the exact types. Summary:

| kind | renders | writes to payload |
|---|---|---|
| `display` | today's read-only row (`valueKey`) | — |
| `select` | dropdown of `options` | `key` |
| `text` | single-line input | `key` |
| `number` | numeric input (`min`/`max`) | `key` |
| `toggle` | checkbox | `key` |
| `date` | date picker | `key` |

`default` seeds the control; when the extraction already produced `payload[key]`, that value
pre-selects/pre-fills it — the model's guess is the default, the user overrides. `required` gates
confirm.

## Manifest declaration (app side — the only part apps touch)

The registered action's `card` gains a `fields` list alongside today's `rows`. Apps declare fields;
nothing app-specific enters OpenChat. Example (IOU):

```jsonc
"card": {
  "fields": [
    { "kind": "display", "label": "Amount",   "valueKey": "amount" },
    { "kind": "select",  "label": "Currency", "key": "currency",
      "options": [ {"value":"USD","label":"USD"}, {"value":"EGP","label":"EGP"} ],
      "default": "USD", "required": true },
    { "kind": "select",  "label": "Direction","key": "direction",
      "options": [ {"value":"credit","label":"Owed to you"}, {"value":"debt","label":"You owe"} ] },
    { "kind": "display", "label": "Note", "valueKey": "note" }
  ]
}
```

## Wire change (`openchat-shared`)

`ActionCardContent` gains an **optional** `fields?: CardField[]`. When absent, the card is exactly
today's static card (backward compatible on the wire and in storage). `buildActionCardContent` /
`buildMultiActionCardContent` copy `def.card.fields` onto the content and still set `confirmPayload`
to the extraction — now treated as the *base* payload the fields merge over.

## Renderer (`ActionCardContent.svelte`)

- If `content.fields` is present, render each field by `kind` (`<select>`, `<input>`,
  `<input type="checkbox">`, `<input type="date">`); otherwise render `rows` as today.
- Local state `values = defaultFieldValues(fields, extractedPayload)`; bind each control to it.
- `canConfirm = disclosureAck && unfilledRequiredFields(fields, values).length === 0`.
- On confirm, hand `values` to the response (see below). One shared component → both v1 and v2 get
  it (v2's `ChatMessageContent` already imports this same file).

## Confirm / deposit flow (`openchat-client`)

`respond("confirm")` today deposits the frozen payload. New path when fields exist:

```
final = mergeFieldValues(extractedPayload, values)      // pure shallow key-merge — OC's only touch
validate final against the app's declared response schema (reuse conformToSchema / missingRequired)
serialize(final) → encrypt to recipientPublicKey → deposit into action_inbox        // unchanged
```

`confirmPayload` becomes a JSON object OC can shallow-merge rather than fully opaque bytes; it still
never interprets the *meaning* of a key. Cards with no fields skip the merge and behave identically.

## Validation

Already solved: after the merge, run the existing viability pass (`conformToSchema` +
`missingRequired`) over `final` against the app's `response_schema`. A `select`'s options are just a
subset the schema accepts, so a malformed choice cannot get through — the same gate that today drops
a degenerate extraction covers post-merge input.

## Backward compatibility & phasing

1. **Ship the vocabulary** — types (`actionCardFields.ts`), the optional `fields?` on the wire, the
   renderer branch, and the merge-on-confirm. No app declares fields yet → zero behaviour change
   (every current card omits `fields`).
2. **First adopter** — IOU declares the currency/direction fields in its manifest; nothing else in
   OpenChat changes. The user picks currency in the chat card; it deposits already-chosen and IOU
   imports it without its own EntryForm step.
3. **Thereafter** — any app adds interactive cards from its manifest. A genuinely new *widget* (a
   slider, a multi-select) is the only thing that ever needs OC to touch this again.

## Non-goals / open questions

- **Not** app-supplied styling or CSS — card appearance stays OpenChat's theme (see the readability
  fix pairing card text with `--currentChat-msg-txt`). Apps supply data + field declarations only.
- Dynamic `options` from the extraction (an `optionsKey` referencing a model-produced list) — easy
  extension, deferred until a use case needs it.
- Multi-entry cards (`buildMultiActionCardContent`): per-entry fields would repeat the field set per
  entry; the merge becomes per-element. Straightforward but out of scope for phase 1.
- Cross-field validation beyond the JSON-schema pass (e.g. "amount required only when kind=iou") is
  left to the consumer app on import, as today.
