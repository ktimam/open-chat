import type { LocalAppAction } from "./localAppCatalog";
import {
    formatLocalDraftJson,
    snapshotLocalDraftPayload,
    type LocalDraftJson,
} from "./localAppDrafts";

export interface LocalAppCardPreviewRow {
    label: string;
    key: string;
    value: string;
    declared: boolean;
}

export interface LocalAppCardPreview {
    items: LocalAppCardPreviewRow[][];
    envelope: LocalAppCardPreviewRow[];
}

function object(
    value: LocalDraftJson | undefined,
): value is { readonly [key: string]: LocalDraftJson } {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A display projection only. Never mutate, normalize or construct the delivered payload here. */
export function localAppCardPreview(
    action: LocalAppAction,
    editorJson: string,
): LocalAppCardPreview | undefined {
    try {
        if (new TextEncoder().encode(editorJson).byteLength > 64 * 1024) return undefined;
        const payload = snapshotLocalDraftPayload(JSON.parse(editorJson), action.draftSchema);
        const mapping = action.handoff;
        const records =
            mapping.kind === "single"
                ? [payload]
                : mapping.kind === "list"
                  ? payload
                  : object(payload) && Object.hasOwn(payload, mapping.field)
                    ? payload[mapping.field]
                    : undefined;
        if (
            !Array.isArray(records) ||
            records.length < 1 ||
            records.length > 32 ||
            !records.every(object)
        )
            return undefined;
        const declaredKeys = new Set(action.definition.card.rows.map((row) => row.valueKey));
        const extraRow = ([key, value]: [string, LocalDraftJson]): LocalAppCardPreviewRow => {
            // Schema property names need not follow the declarative row identifier grammar.
            // Show hidden controls in those names too, without changing any payload keys.
            const displayKey = formatLocalDraftJson(key).slice(1, -1);
            return {
                label: displayKey,
                key: displayKey,
                value: formatLocalDraftJson(value),
                declared: false,
            };
        };
        return {
            items: records.map((record) => [
                ...action.definition.card.rows.map((row) => ({
                    label: row.label,
                    key: row.valueKey,
                    value: Object.hasOwn(record, row.valueKey)
                        ? formatLocalDraftJson(record[row.valueKey])
                        : "Not supplied",
                    declared: true,
                })),
                ...Object.entries(record)
                    .filter(([key]) => !declaredKeys.has(key))
                    .map(extraRow),
            ]),
            envelope:
                mapping.kind === "wrapped-list" && object(payload)
                    ? Object.entries(payload)
                          .filter(([key]) => key !== mapping.field)
                          .map(extraRow)
                    : [],
        };
    } catch {
        // Never show the previous valid payload after an invalid edit, or echo parser/private errors.
        return undefined;
    }
}
