// PROPOSAL / STUB — interactive confirmable-action card fields.
//
// Today an ActionCardContent is read-only: `rows: {label,value}[]` display + a disclosure checkbox +
// confirm/cancel, and `confirmPayload` is frozen when the card is posted. This file defines the
// declarative vocabulary that would let an app add INPUT controls (a currency dropdown, an editable
// amount, a direction toggle…) to a card WITHOUT any further OpenChat change — the same way apps
// already add display rows purely from their manifest.
//
// It is deliberately NOT wired into ActionCardContent or the renderer yet: it is a compilable design
// surface. See fork-notes/07-interactive-action-card-fields.md for the full design, the wire change,
// the renderer sketch and the phased rollout.
//
// The load-bearing invariant it preserves: OpenChat plumbs field values BY KEY and never interprets
// what a key MEANS. `mergeFieldValues` is the only place OC touches the payload, and it is a pure
// shallow merge; the merged object is then validated against the app's own declared response schema
// (reuse conformToSchema / missingRequired) and encrypted + deposited exactly as a static card is.

/** A choice in a `select` field. */
export interface CardFieldOption {
    value: string;
    label: string;
}

/**
 * A declarative card field.
 *
 * `display` is exactly today's read-only row (label + a value pulled from the extraction by
 * `valueKey`). Every other kind is an INPUT whose current value is written into the confirmPayload
 * under `key` when the user confirms. `default` seeds the control; when the extraction already
 * produced a value for `key`, THAT value pre-fills/pre-selects it — so the model's guess becomes the
 * default and the user simply overrides it.
 */
export type CardField =
    | { kind: "display"; label: string; valueKey: string }
    | {
          kind: "select";
          label: string;
          key: string;
          options: CardFieldOption[];
          default?: string;
          required?: boolean;
      }
    | {
          kind: "text";
          label: string;
          key: string;
          default?: string;
          placeholder?: string;
          maxLength?: number;
          required?: boolean;
      }
    | { kind: "number"; label: string; key: string; default?: number; min?: number; max?: number; required?: boolean }
    | { kind: "toggle"; label: string; key: string; default?: boolean }
    | { kind: "date"; label: string; key: string; default?: string; required?: boolean };

/** The concrete value an input field contributes to the payload. */
export type CardFieldValue = string | number | boolean;

/** An input (non-display) field. */
export type CardInputField = Exclude<CardField, { kind: "display" }>;

/** Just the input fields — display fields carry no user value. */
export function inputFields(fields: CardField[]): CardInputField[] {
    return fields.filter((f): f is CardInputField => f.kind !== "display");
}

function isFieldValue(v: unknown): v is CardFieldValue {
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Seed the initial field values from the extraction: an input field whose `key` is present (and of a
 * scalar type) in `extracted` pre-fills from it; otherwise its declared `default` (if any). Display
 * fields contribute nothing. This is what the renderer initialises its local input state from.
 */
export function defaultFieldValues(
    fields: CardField[],
    extracted: Record<string, unknown>,
): Record<string, CardFieldValue> {
    const out: Record<string, CardFieldValue> = {};
    for (const f of inputFields(fields)) {
        const fromExtraction = extracted[f.key];
        if (isFieldValue(fromExtraction)) {
            out[f.key] = fromExtraction;
        } else if (f.default !== undefined) {
            out[f.key] = f.default;
        }
    }
    return out;
}

/**
 * The ONLY point where OpenChat touches payload semantics: a pure SHALLOW key-merge of the user's
 * field values over the extracted payload. OC plumbs values by key without knowing what any key
 * means. The result is validated against the app's declared response schema and then serialized +
 * encrypted + deposited exactly as today's opaque payload is. An app that declares no input fields
 * yields `{...extractedPayload}` — byte-identical to the current behaviour.
 */
export function mergeFieldValues(
    extractedPayload: Record<string, unknown>,
    fieldValues: Record<string, CardFieldValue>,
): Record<string, unknown> {
    return { ...extractedPayload, ...fieldValues };
}

/** Required input fields still missing a value — the renderer gates the confirm button on this. */
export function unfilledRequiredFields(
    fields: CardField[],
    values: Record<string, CardFieldValue>,
): string[] {
    return inputFields(fields)
        .filter((f) => "required" in f && f.required === true)
        .filter((f) => {
            const v = values[f.key];
            return v === undefined || (typeof v === "string" && v.trim() === "");
        })
        .map((f) => f.key);
}
