import type { LocalAppAction } from "./localAppCatalog";
import { localAppDraftRowSchema } from "./localAppDraftFields";
import {
    snapshotLocalDraftJson,
    snapshotLocalDraftSchema,
    type LocalDraftSchema,
} from "./localAppDrafts";

type Spacing = "none" | "small" | "medium";

/** Paint tokens only: a renderer maps these roles, never arbitrary CSS properties or URLs. */
export interface LocalAppViewPalette {
    readonly background?: string;
    readonly surface?: string;
    readonly field?: string;
    readonly text?: string;
    readonly muted?: string;
    readonly border?: string;
    readonly accent?: string;
}

const HOST_PALETTES: Readonly<Record<"light" | "dark", Readonly<Required<LocalAppViewPalette>>>> =
    Object.freeze({
        light: Object.freeze({
            background: "#ffffff",
            surface: "#ffffff",
            field: "#ffffff",
            text: "#111111",
            muted: "#4b5563",
            border: "#6b7280",
            accent: "#1d4ed8",
        }),
        dark: Object.freeze({
            background: "#121212",
            surface: "#1c1c1c",
            field: "#161616",
            text: "#f5f5f5",
            muted: "#c4c4c4",
            border: "#737373",
            accent: "#93c5fd",
        }),
    });

function luminance(hex: string): number {
    const channels = [1, 3, 5].map((offset) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/**
 * Resolve a validated inert palette to complete, opaque host-owned paint values. Canonical
 * controls use text and muted (labels), never accent. Both must retain >=4.5:1 contrast on
 * every possible view background, including nested card surfaces. Missing roles cannot
 * inherit unknown app/page paint. A failed combination falls back as a whole, not just the
 * offending role. This guards readability only; it never substitutes for complete host review.
 */
export function resolveLocalAppViewPalette(
    palette: LocalAppViewPalette | undefined,
    mode: "light" | "dark",
): Readonly<Required<LocalAppViewPalette>> {
    const fallback = HOST_PALETTES[mode];
    const resolved = { ...fallback, ...palette };
    if (
        Object.values(resolved).some(
            (color) => typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color),
        )
    )
        return fallback;
    const backgrounds = [resolved.background, resolved.surface, resolved.field].map(luminance);
    for (const foreground of [resolved.text, resolved.muted]) {
        const light = luminance(foreground);
        if (
            backgrounds.some(
                (background) =>
                    (Math.max(light, background) + 0.05) / (Math.min(light, background) + 0.05) <
                    4.5,
            )
        )
            return fallback;
    }
    return Object.freeze(resolved);
}

export type LocalAppViewNode =
    | {
          readonly kind: "group" | "row";
          readonly children: readonly LocalAppViewNode[];
          readonly gap?: Spacing;
          readonly padding?: Spacing;
          readonly surface?: "plain" | "card";
          readonly radius?: "none" | "small" | "medium";
      }
    | {
          readonly kind: "field";
          readonly field: string;
          readonly minWidth?: number;
          readonly fullWidth?: boolean;
          readonly control?: "single-line" | "multiline";
      }
    | {
          readonly kind: "text";
          readonly text: string;
          readonly tone?: "normal" | "muted" | "accent";
          readonly size?: "small" | "normal" | "heading";
      };

/**
 * Versioned inert app-owned presentation, not an executable app capability.
 * Distribution must separately bind the exact view to the verified app definition.
 * The opt-in host renderer does not authorize loading or executing app view code.
 * One tree describes ONE canonical row; the host owns row count, order and edit/read-only mode.
 * A field contains only a reference. Values, labels, validity, choices and disabled state come
 * from the host's canonical draft/action, using the existing field/choice edit callbacks. A view
 * cannot supply replacement values, defaults, approval, destination or send instructions.
 *
 * Rendering must keep app text inert (textContent, never HTML), map finite paint/layout
 * tokens itself, retain >=44px controls and preserve pending invalid edits. Palette validation
 * is not a contrast/accessibility guarantee: app paint/text may mislead or be unreadable. Neither
 * app pixels nor field coverage can replace host-owned review of EVERY outgoing value/destination.
 * No app code is authorized to run in a DOM window by this contract.
 */
export interface LocalAppViewV1 {
    readonly version: 1;
    readonly nodes: readonly LocalAppViewNode[];
    readonly theme?: {
        readonly light?: LocalAppViewPalette;
        readonly dark?: LocalAppViewPalette;
    };
}

export interface ValidatedLocalAppView {
    readonly view: LocalAppViewV1;
    readonly referencedFields: readonly string[];
    /** Schema coverage only, including optional/complex fields; never a payload projection. */
    readonly unrepresentedRowFields: readonly string[];
    readonly unrepresentedEnvelopeFields: readonly string[];
    /** Always true, even when every declared field appears in the app view. */
    readonly requiresCompleteHostReview: true;
}

const MAX_DEPTH = 6;
const MAX_NODES = 128;
const MAX_CHILDREN = 32;
const MAX_TEXT = 512;
const MAX_TOTAL_TEXT = 4096;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029\ud800-\udfff]/u;
const PALETTE_KEYS = ["background", "surface", "field", "text", "muted", "border", "accent"];

function invalid(): never {
    // Never echo app text, schema fields or private draft data into logs/errors.
    throw new Error("Invalid local app view");
}

function exact(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    )
        invalid();
}

function token(value: Record<string, unknown>, key: string, allowed: readonly string[]): void {
    if (Object.hasOwn(value, key) && !allowed.includes(value[key] as string)) invalid();
}

/** Strict own-data snapshots are taken before property access; app getters are never invoked. */
export function validateLocalAppView(
    value: unknown,
    schema: LocalDraftSchema,
    handoff: LocalAppAction["handoff"],
): ValidatedLocalAppView {
    const copied = snapshotLocalDraftJson(value);
    const pinnedSchema = snapshotLocalDraftSchema(schema);
    const mapping = snapshotLocalDraftJson(handoff);
    exact(mapping, ["kind"], ["field"]);
    if (mapping.kind === "wrapped-list") {
        exact(mapping, ["kind", "field"]);
        if (typeof mapping.field !== "string" || FIELD.exec(mapping.field)?.[0] !== mapping.field)
            invalid();
    } else {
        exact(mapping, ["kind"]);
        if (mapping.kind !== "single" && mapping.kind !== "list") invalid();
    }
    const safeMapping = mapping as LocalAppAction["handoff"];
    const row = localAppDraftRowSchema(pinnedSchema, safeMapping);
    exact(copied, ["version", "nodes"], ["theme"]);
    if (copied.version !== 1) invalid();
    if (Object.hasOwn(copied, "theme")) {
        exact(copied.theme, [], ["light", "dark"]);
        if (Object.keys(copied.theme).length === 0) invalid();
        for (const palette of Object.values(copied.theme)) {
            exact(palette, [], PALETTE_KEYS);
            if (Object.keys(palette).length === 0) invalid();
            for (const color of Object.values(palette)) {
                if (
                    typeof color !== "string" ||
                    color.length !== 7 ||
                    !/^#[0-9a-fA-F]{6}$/.test(color)
                )
                    invalid();
            }
        }
    }
    const referenced = new Set<string>();
    let nodes = 0;
    let textLength = 0;
    function visitChildren(children: unknown, depth: number): void {
        if (
            depth > MAX_DEPTH ||
            !Array.isArray(children) ||
            children.length < 1 ||
            children.length > MAX_CHILDREN
        )
            invalid();
        for (const node of children) {
            if (++nodes > MAX_NODES) invalid();
            exact(
                node,
                ["kind"],
                [
                    "children",
                    "gap",
                    "padding",
                    "surface",
                    "radius",
                    "field",
                    "minWidth",
                    "fullWidth",
                    "control",
                    "text",
                    "tone",
                    "size",
                ],
            );
            switch (node.kind) {
                case "group":
                case "row":
                    exact(node, ["kind", "children"], ["gap", "padding", "surface", "radius"]);
                    token(node, "gap", ["none", "small", "medium"]);
                    token(node, "padding", ["none", "small", "medium"]);
                    token(node, "surface", ["plain", "card"]);
                    token(node, "radius", ["none", "small", "medium"]);
                    visitChildren(node.children, depth + 1);
                    break;
                case "field": {
                    exact(node, ["kind", "field"], ["minWidth", "fullWidth", "control"]);
                    if (
                        typeof node.field !== "string" ||
                        FIELD.exec(node.field)?.[0] !== node.field ||
                        !Object.hasOwn(row.properties, node.field) ||
                        referenced.has(node.field)
                    )
                        invalid();
                    const property = row.properties[node.field];
                    if (property.type === "object" || property.type === "array") invalid();
                    if (
                        Object.hasOwn(node, "minWidth") &&
                        (!Number.isSafeInteger(node.minWidth) ||
                            (node.minWidth as number) < 80 ||
                            (node.minWidth as number) > 320)
                    )
                        invalid();
                    if (Object.hasOwn(node, "fullWidth") && typeof node.fullWidth !== "boolean")
                        invalid();
                    token(node, "control", ["single-line", "multiline"]);
                    if (
                        Object.hasOwn(node, "control") &&
                        (property.type !== "string" || property.enum !== undefined)
                    )
                        invalid();
                    referenced.add(node.field);
                    break;
                }
                case "text":
                    exact(node, ["kind", "text"], ["tone", "size"]);
                    if (
                        typeof node.text !== "string" ||
                        !node.text.trim() ||
                        node.text.length > MAX_TEXT ||
                        UNSAFE_TEXT.test(node.text)
                    )
                        invalid();
                    textLength += node.text.length;
                    if (textLength > MAX_TOTAL_TEXT) invalid();
                    token(node, "tone", ["normal", "muted", "accent"]);
                    token(node, "size", ["small", "normal", "heading"]);
                    break;
                default:
                    invalid();
            }
        }
    }
    visitChildren(copied.nodes, 1);
    const unrepresentedEnvelopeFields =
        safeMapping.kind === "wrapped-list" && pinnedSchema.type === "object"
            ? Object.keys(pinnedSchema.properties).filter((key) => key !== safeMapping.field)
            : [];
    return Object.freeze({
        view: copied as unknown as LocalAppViewV1,
        referencedFields: Object.freeze([...referenced]),
        unrepresentedRowFields: Object.freeze(
            Object.keys(row.properties).filter((key) => !referenced.has(key)),
        ),
        unrepresentedEnvelopeFields: Object.freeze(unrepresentedEnvelopeFields),
        requiresCompleteHostReview: true,
    });
}
