import { describe, expect, test } from "vitest";
import {
    buildCardInit,
    clampCardHeight,
    decodeConfirmPayload,
    deriveCardOrigin,
    extractEntriesRow,
    isRecord,
    reverseMapRows,
    visibleRows,
    type CardInitContext,
} from "./cardBridge";
import { OC_ENTRIES_ROW_LABEL } from "openchat-shared";

describe("deriveCardOrigin", () => {
    test("returns the origin for an https url", () => {
        expect(deriveCardOrigin("https://iou.example/openchat/card?x=1")).toBe(
            "https://iou.example",
        );
    });
    test("keeps a non-default port in the origin", () => {
        expect(deriveCardOrigin("http://localhost:5341/openchat/card")).toBe(
            "http://localhost:5341",
        );
    });
    test("returns undefined for an unparseable url", () => {
        expect(deriveCardOrigin("not a url")).toBeUndefined();
    });
    test("returns undefined for a non-http(s) scheme", () => {
        expect(deriveCardOrigin("javascript:alert(1)")).toBeUndefined();
        expect(deriveCardOrigin("data:text/html,<h1>x</h1>")).toBeUndefined();
    });
});

describe("decodeConfirmPayload", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

    test("decodes a JSON object", () => {
        expect(decodeConfirmPayload(enc({ amount: 20, currency: "USD" }))).toEqual({
            amount: 20,
            currency: "USD",
        });
    });
    test("empty / absent bytes -> {}", () => {
        expect(decodeConfirmPayload(undefined)).toEqual({});
        expect(decodeConfirmPayload(new Uint8Array())).toEqual({});
    });
    test("non-JSON bytes -> {}", () => {
        expect(decodeConfirmPayload(new TextEncoder().encode("{not json"))).toEqual({});
    });
    test("a JSON array (non-object top level) -> {}", () => {
        expect(decodeConfirmPayload(enc([1, 2, 3]))).toEqual({});
    });
});

describe("isRecord", () => {
    test("true only for plain objects", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord("x")).toBe(false);
        expect(isRecord(3)).toBe(false);
    });
});

describe("buildCardInit", () => {
    test("wraps data + context in the init envelope", () => {
        const context: CardInitContext = {
            chatKey: "group:abc",
            appId: 7,
            actionId: "iou.add",
            theme: "dark",
            readonly: false,
        };
        expect(buildCardInit({ amount: 5 }, context)).toEqual({
            type: "oc:card:init",
            version: 1,
            data: { amount: 5 },
            context,
        });
    });
});

describe("reverseMapRows", () => {
    // The manifest card template's label -> field-key map (client-side card.rows use `valueKey`).
    const iouMap: Record<string, string> = {
        Amount: "amount",
        Currency: "currency",
        Direction: "direction",
        Note: "note",
    };

    test("joins hydrated {label,value} rows onto field keys", () => {
        const rows = [
            { label: "Amount", value: "350" },
            { label: "Currency", value: "EGP" },
            { label: "Direction", value: "credit" },
            { label: "Note", value: "lunch" },
        ];
        expect(reverseMapRows(rows, iouMap)).toEqual({
            amount: "350",
            currency: "EGP",
            direction: "credit",
            note: "lunch",
        });
    });

    test("unmatched label falls back to a lowercased-label key (nothing dropped)", () => {
        const rows = [
            { label: "Amount", value: "10" },
            { label: "Mystery Field", value: "x" },
        ];
        expect(reverseMapRows(rows, iouMap)).toEqual({
            amount: "10",
            "mystery field": "x",
        });
    });

    test("empty rows -> {}", () => {
        expect(reverseMapRows([], iouMap)).toEqual({});
        expect(reverseMapRows([], {})).toEqual({});
    });

    test("empty map -> every key is the lowercased label", () => {
        expect(reverseMapRows([{ label: "Amount", value: "5" }], {})).toEqual({ amount: "5" });
    });

    test("skips hidden __oc_ rows (the sentinel is never reverse-mapped)", () => {
        const rows = [
            { label: "Amount", value: "10" },
            { label: "__oc_entries__", value: '[{"amount":10},{"amount":20}]' },
        ];
        expect(reverseMapRows(rows, iouMap)).toEqual({ amount: "10" });
    });
});

describe("visibleRows (classic fallback display filter)", () => {
    test("drops hidden __oc_ control rows, keeps human rows in order", () => {
        const rows = [
            { label: "Amount", value: "350" },
            { label: OC_ENTRIES_ROW_LABEL, value: "[{},{}]" }, // the multi-entry sentinel — must NOT render
            { label: "Currency", value: "EGP" },
        ];
        // If this filter regressed, the raw __oc_entries__ JSON blob would render as a visible row.
        expect(visibleRows(rows)).toEqual([
            { label: "Amount", value: "350" },
            { label: "Currency", value: "EGP" },
        ]);
    });

    test("drops any __oc_-prefixed label, not just the entries sentinel", () => {
        expect(visibleRows([{ label: "__oc_future_control__", value: "x" }, { label: "Note", value: "n" }])).toEqual([
            { label: "Note", value: "n" },
        ]);
    });

    test("passes ordinary rows through unchanged, and [] -> []", () => {
        const rows = [{ label: "Amount", value: "1" }];
        expect(visibleRows(rows)).toEqual(rows);
        expect(visibleRows([])).toEqual([]);
    });
});

describe("extractEntriesRow", () => {
    test("returns the parsed array from a __oc_entries__ sentinel row", () => {
        const rows = [
            { label: "Entry 1", value: "20 USD lunch" },
            { label: "Entry 2", value: "30 EUR dinner" },
            {
                label: "__oc_entries__",
                value: '[{"amount":20,"currency":"USD"},{"amount":30,"currency":"EUR"}]',
            },
        ];
        expect(extractEntriesRow(rows)).toEqual([
            { amount: 20, currency: "USD" },
            { amount: 30, currency: "EUR" },
        ]);
    });

    test("returns undefined when no sentinel row is present (single-entry card)", () => {
        expect(
            extractEntriesRow([
                { label: "Amount", value: "10" },
                { label: "Currency", value: "USD" },
            ]),
        ).toBeUndefined();
    });

    test("returns undefined when the sentinel value is not JSON or not an array", () => {
        expect(extractEntriesRow([{ label: "__oc_entries__", value: "{not json" }])).toBeUndefined();
        expect(extractEntriesRow([{ label: "__oc_entries__", value: '{"a":1}' }])).toBeUndefined();
    });
});

describe("clampCardHeight", () => {
    test("clamps within range and rounds up", () => {
        expect(clampCardHeight(300.2, 120, 1200)).toBe(301);
        expect(clampCardHeight(50, 120, 1200)).toBe(120);
        expect(clampCardHeight(5000, 120, 1200)).toBe(1200);
    });
    test("non-finite -> min", () => {
        expect(clampCardHeight(Number.NaN, 120, 1200)).toBe(120);
        expect(clampCardHeight(Number.POSITIVE_INFINITY, 120, 1200)).toBe(120);
    });
});
