import { parseDeclaredTextSequence } from "./aiAction";

// A deliberately narrow, deterministic extractor for apps that opt into the
// `x-openchat-source-grounded-transactions` response-schema extension. It consumes either the
// user's exact text or OCR text. Every emitted amount, currency, date and note is traceable to the
// supplied source; an app may separately declare bounded semantic defaults such as direction.
// Ambiguous documents fail closed so callers can fall back to another extractor or ask the user to
// enter the action manually.

export const SOURCE_GROUNDED_TRANSACTIONS_EXTENSION = "x-openchat-source-grounded-transactions";
export const BROWSER_IMAGE_STRATEGY_EXTENSION = "x-openchat-browser-image-strategy";

// Invocation order is app policy, declared beside the output schema rather than hard-coded for any
// particular app or document language. Version 1 deliberately has one narrow meaning: a browser may
// try the user's selected image model only when the runtime proves an accelerated path is usable,
// then it must fall back to this schema's bounded source-grounded reader.
export type BrowserImageStrategy = Readonly<{
    version: 1;
    primary: "selected_model";
    requireAcceleration: true;
    fallback: "source_grounded";
}>;

export type SourceGroundedTransactionInput = Readonly<{
    source: "text" | "ocr";
    text: string;
    /** Exact chat text attached to an image. It remains separate from OCR amount/date evidence. */
    messageText?: string;
    /**
     * A separately recognized OCR transcript used only for kind/direction evidence. Its numbers,
     * currencies, dates and prose can never replace or augment fields grounded by `text`.
     */
    ocrSemanticText?: string;
    /** Calendar anchor used only to resolve an explicit year-less or relative source date. */
    now?: Date;
}>;

export type SourceGroundedParseResult =
    | { kind: "candidates"; candidates: Record<string, unknown>[] }
    | { kind: "none"; reason: string }
    | { kind: "ambiguous"; reason: string };

type JsonRecord = Record<string, unknown>;

type Declaration = Readonly<{
    amountField: string;
    currencyField: string;
    kindField: string;
    directionField: string;
    dateField: string;
    noteField: string;
    sourceField: string;
    fallbackKind: string;
    maximumItems: number;
    authoritativeAmountLabels: readonly string[];
    dateLabels: readonly string[];
    noteLabels: readonly string[];
    ignoredLineLabels: readonly string[];
    titleLineKeywords: readonly string[];
    relationshipLabelPrefixes: readonly string[];
    properties: JsonRecord;
    allowedKinds: ReadonlySet<string>;
    allowedDirections: ReadonlySet<string>;
    allowedCurrencies: ReadonlySet<string>;
    requireOcrEvidenceFields: ReadonlySet<string>;
    defaultDirection?: string;
    ocrDefaultDirection?: string;
    dateEnabled: boolean;
}>;

type Span = Readonly<{ start: number; end: number }>;
type NumberSpan = Span & Readonly<{ amount: number; raw: string }>;
type CurrencySpan = Span & Readonly<{ value: string }>;
type SpanScan = Readonly<{ spans: readonly Span[]; overflow: boolean }>;
type CurrencyScan = Readonly<{ spans: readonly CurrencySpan[]; overflow: boolean }>;
type DateScan = Readonly<{
    values: readonly string[];
    spans: readonly Span[];
    rangeSpans: readonly Span[];
    invalid: boolean;
}>;
type MappedValue = { kind: "none" } | { kind: "value"; value: string } | { kind: "ambiguous" };

const MAX_SOURCE_CHARS = 16_384;
const MAX_OCR_LINES = 256;
const MAX_OCR_LINE_CHARS = 512;
const MAX_DECLARED_LABELS = 16;
const MAX_LABEL_CHARS = 40;
const MAX_RULES = 64;
const MAX_RULE_MAP_ENTRIES = 64;
const MAX_RULE_KEYWORDS = 64;
const MAX_KEYWORD_CHARS = 80;
const MAX_MAPPED_KEYWORD_VALUE_PAIRS = 512;
const MAX_MAPPED_HITS = 4_096;
const MAX_DIRECT_CURRENCY_SPANS = 256;
const MAX_CANDIDATES = 32;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

// ISO 4217 alphabetic codes. A schema enum, when present, narrows this set further.
const ISO_CURRENCIES = new Set(
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWL".split(
        " ",
    ),
);

const MONTHS = new Map<string, number>([
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["sept", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12],
]);
const MONTH_PATTERN = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");
const STRICT_NUMBER_BODY = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;

function isRecord(value: unknown): value is JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedPhrase(value: string): string {
    return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function readStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_DECLARED_LABELS) return undefined;
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_LABEL_CHARS) {
            return undefined;
        }
        const normalized = normalizedPhrase(entry);
        if (normalized.length === 0 || /[^a-z0-9 -]/u.test(normalized)) return undefined;
        if (!out.includes(normalized)) out.push(normalized);
    }
    return out.length > 0 ? out : undefined;
}

function stringEnum(property: unknown): Set<string> | undefined {
    if (!isRecord(property) || !Array.isArray(property.enum) || property.enum.length === 0) {
        return undefined;
    }
    const values = property.enum.filter((value): value is string => typeof value === "string");
    return values.length === property.enum.length ? new Set(values) : undefined;
}

function declaredParser(schema: object | undefined): Declaration | undefined {
    if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
    const extension = schema[SOURCE_GROUNDED_TRANSACTIONS_EXTENSION];
    if (!isRecord(extension)) return undefined;
    const allowedKeys = new Set([
        "amountField",
        "authoritativeAmountLabels",
        "currencyField",
        "dateField",
        "dateLabels",
        "directionField",
        "fallbackKind",
        "ignoredLineLabels",
        "kindField",
        "maximumItems",
        "noteField",
        "noteLabels",
        "ocrDefaultDirection",
        "requireOcrEvidenceFields",
        "relationshipLabelPrefixes",
        "sourceField",
        "titleLineKeywords",
        "version",
    ]);
    if (Object.keys(extension).some((key) => !allowedKeys.has(key))) return undefined;
    if (extension.version !== 1) return undefined;

    const fieldKeys = [
        "amountField",
        "currencyField",
        "kindField",
        "directionField",
        "dateField",
        "noteField",
        "sourceField",
    ] as const;
    const fields: Record<(typeof fieldKeys)[number], string> = Object.create(null);
    for (const key of fieldKeys) {
        const value = extension[key];
        if (typeof value !== "string" || !FIELD_NAME.test(value)) return undefined;
        fields[key] = value;
    }
    if (new Set(Object.values(fields)).size !== fieldKeys.length) return undefined;
    const rawRequireOcrEvidenceFields = extension.requireOcrEvidenceFields;
    let requireOcrEvidenceFields = new Set<string>();
    if (rawRequireOcrEvidenceFields !== undefined) {
        if (
            !Array.isArray(rawRequireOcrEvidenceFields) ||
            rawRequireOcrEvidenceFields.length === 0 ||
            rawRequireOcrEvidenceFields.length > 2 ||
            rawRequireOcrEvidenceFields.some(
                (field) => field !== fields.kindField && field !== fields.directionField,
            ) ||
            new Set(rawRequireOcrEvidenceFields).size !== rawRequireOcrEvidenceFields.length
        ) {
            return undefined;
        }
        requireOcrEvidenceFields = new Set(rawRequireOcrEvidenceFields as string[]);
    }
    const required = schema.required;
    if (
        !Array.isArray(required) ||
        ![fields.amountField, fields.kindField, fields.directionField].every((field) =>
            required.includes(field),
        )
    ) {
        return undefined;
    }
    const amountProperty = schema.properties[fields.amountField];
    const currencyProperty = schema.properties[fields.currencyField];
    const kindProperty = schema.properties[fields.kindField];
    const directionProperty = schema.properties[fields.directionField];
    const dateProperty = schema.properties[fields.dateField];
    const noteProperty = schema.properties[fields.noteField];
    const sourceProperty = schema.properties[fields.sourceField];
    if (
        !isRecord(amountProperty) ||
        amountProperty.type !== "number" ||
        !isRecord(currencyProperty) ||
        currencyProperty.type !== "string" ||
        !isRecord(kindProperty) ||
        !isRecord(directionProperty) ||
        !isRecord(dateProperty) ||
        dateProperty.type !== "string" ||
        !isRecord(noteProperty) ||
        noteProperty.type !== "string" ||
        !isRecord(sourceProperty) ||
        sourceProperty.type !== "string"
    ) {
        return undefined;
    }
    const allowedKinds = stringEnum(kindProperty);
    const allowedDirections = stringEnum(directionProperty);
    if (allowedKinds === undefined || allowedDirections === undefined) return undefined;
    const fallbackKind = extension.fallbackKind;
    if (typeof fallbackKind !== "string" || !allowedKinds.has(fallbackKind)) return undefined;
    const maximumItems = extension.maximumItems;
    if (
        typeof maximumItems !== "number" ||
        !Number.isInteger(maximumItems) ||
        maximumItems < 1 ||
        maximumItems > MAX_CANDIDATES
    ) {
        return undefined;
    }
    const authoritativeAmountLabels = readStringList(extension.authoritativeAmountLabels);
    const dateLabels = readStringList(extension.dateLabels);
    const noteLabels = readStringList(extension.noteLabels);
    const ignoredLineLabels = readStringList(extension.ignoredLineLabels);
    const titleLineKeywords = readStringList(extension.titleLineKeywords);
    const relationshipLabelPrefixes = readStringList(extension.relationshipLabelPrefixes);
    if (
        authoritativeAmountLabels === undefined ||
        dateLabels === undefined ||
        noteLabels === undefined ||
        ignoredLineLabels === undefined ||
        titleLineKeywords === undefined ||
        relationshipLabelPrefixes === undefined
    ) {
        return undefined;
    }

    let allowedCurrencies = ISO_CURRENCIES;
    const currencyEnum = stringEnum(currencyProperty);
    if (currencyEnum !== undefined) {
        const narrowed = [...currencyEnum].filter((value) => ISO_CURRENCIES.has(value));
        if (narrowed.length !== currencyEnum.size) return undefined;
        allowedCurrencies = new Set(narrowed);
    }
    const defaultDirection = directionProperty.default;
    if (
        defaultDirection !== undefined &&
        (typeof defaultDirection !== "string" || !allowedDirections.has(defaultDirection))
    ) {
        return undefined;
    }
    const ocrDefaultDirection = extension.ocrDefaultDirection;
    if (
        ocrDefaultDirection !== undefined &&
        (typeof ocrDefaultDirection !== "string" || !allowedDirections.has(ocrDefaultDirection))
    ) {
        return undefined;
    }
    return {
        ...fields,
        fallbackKind,
        maximumItems,
        authoritativeAmountLabels,
        dateLabels,
        noteLabels,
        ignoredLineLabels,
        titleLineKeywords,
        relationshipLabelPrefixes,
        properties: schema.properties,
        allowedKinds,
        allowedDirections,
        allowedCurrencies,
        requireOcrEvidenceFields,
        defaultDirection: defaultDirection as string | undefined,
        ocrDefaultDirection: ocrDefaultDirection as string | undefined,
        dateEnabled:
            dateProperty.format === "date" &&
            dateProperty["x-openchat-normalize-date"] === true &&
            dateProperty["x-openchat-date-from-text"] === true,
    };
}

function isWordCharacter(char: string | undefined): boolean {
    return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function keywordSpans(text: string, keyword: string): Span[] {
    if (keyword.length === 0 || keyword.length > MAX_KEYWORD_CHARS) return [];
    const haystack = text.toLocaleLowerCase("en-US");
    const needle = keyword.toLocaleLowerCase("en-US");
    const wordStart = isWordCharacter(needle[0]);
    const wordEnd = isWordCharacter(needle.at(-1));
    const spans: Span[] = [];
    let from = 0;
    while (from <= haystack.length - needle.length && spans.length < MAX_RULE_KEYWORDS) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        const end = start + needle.length;
        if (
            (!wordStart || !isWordCharacter(haystack[start - 1])) &&
            (!wordEnd || !isWordCharacter(haystack[end]))
        ) {
            spans.push({ start, end });
        }
        from = start + Math.max(needle.length, 1);
    }
    return spans;
}

function keywordRules(rules: readonly unknown[], field: string): JsonRecord[] {
    const out: JsonRecord[] = [];
    for (const raw of rules.slice(0, MAX_RULES)) {
        if (
            isRecord(raw) &&
            raw.kind === "keyword_map" &&
            raw.field === field &&
            Array.isArray(raw.map)
        ) {
            out.push(raw);
        }
    }
    return out;
}

function mappedValue(
    rules: readonly unknown[],
    field: string,
    texts: readonly string[],
): MappedValue {
    const hits: { value: string; textIndex: number; span: Span }[] = [];
    const seenKeywordValuePairs = new Set<string>();
    const seenHits = new Set<string>();
    for (const rule of keywordRules(rules, field)) {
        for (const rawEntry of (rule.map as unknown[]).slice(0, MAX_RULE_MAP_ENTRIES)) {
            if (!isRecord(rawEntry) || typeof rawEntry.value !== "string") continue;
            if (!Array.isArray(rawEntry.keywords)) continue;
            for (const keyword of rawEntry.keywords.slice(0, MAX_RULE_KEYWORDS)) {
                if (typeof keyword !== "string" || keyword.length > MAX_KEYWORD_CHARS) continue;
                const pairKey = JSON.stringify([
                    rawEntry.value,
                    keyword.toLocaleLowerCase("en-US"),
                ]);
                if (seenKeywordValuePairs.has(pairKey)) continue;
                if (seenKeywordValuePairs.size >= MAX_MAPPED_KEYWORD_VALUE_PAIRS) {
                    return { kind: "ambiguous" };
                }
                seenKeywordValuePairs.add(pairKey);
                for (let textIndex = 0; textIndex < texts.length; textIndex++) {
                    for (const span of keywordSpans(texts[textIndex], keyword)) {
                        const hitKey = JSON.stringify([
                            rawEntry.value,
                            textIndex,
                            span.start,
                            span.end,
                        ]);
                        if (seenHits.has(hitKey)) continue;
                        if (hits.length >= MAX_MAPPED_HITS) return { kind: "ambiguous" };
                        seenHits.add(hitKey);
                        hits.push({ value: rawEntry.value, textIndex, span });
                    }
                }
            }
        }
    }
    // A longer declared relationship phrase owns a nested generic keyword (`owe me` beats bare
    // `owe`). Sort once and sweep the two strongest differently-valued covering spans; this keeps
    // overlap resolution O(H log H), rather than comparing every hit with every other hit.
    hits.sort(
        (left, right) =>
            left.textIndex - right.textIndex ||
            left.span.start - right.span.start ||
            right.span.end - left.span.end,
    );
    type Cover = { value: string; start: number; end: number };
    const stronger = (left: Cover, right: Cover): boolean =>
        left.end > right.end || (left.end === right.end && left.start < right.start);
    let textIndex = -1;
    let first: Cover | undefined;
    let second: Cover | undefined;
    const values = new Set<string>();
    for (const hit of hits) {
        if (hit.textIndex !== textIndex) {
            textIndex = hit.textIndex;
            first = undefined;
            second = undefined;
        }
        const cover = first?.value !== hit.value ? first : second;
        if (
            cover === undefined ||
            !(
                cover.end > hit.span.end ||
                (cover.end === hit.span.end && cover.start < hit.span.start)
            )
        ) {
            values.add(hit.value);
        }

        const candidate: Cover = { value: hit.value, ...hit.span };
        if (first?.value === candidate.value) {
            if (stronger(candidate, first)) first = candidate;
        } else if (second?.value === candidate.value) {
            if (stronger(candidate, second)) second = candidate;
            if (second !== undefined && first !== undefined && stronger(second, first)) {
                [first, second] = [second, first];
            }
        } else if (first === undefined || stronger(candidate, first)) {
            second = first;
            first = candidate;
        } else if (second === undefined || stronger(candidate, second)) {
            second = candidate;
        }
    }
    if (values.size === 0) return { kind: "none" };
    if (values.size !== 1) return { kind: "ambiguous" };
    return { kind: "value", value: [...values][0] };
}

function unsupportedCurrencyInSource(
    text: string,
    declaration: Declaration,
    rules: readonly unknown[],
): boolean {
    const seenKeywordValuePairs = new Set<string>();
    for (const match of text.matchAll(/\b[A-Za-z]{3}\b/gu)) {
        if (match.index === undefined) continue;
        // Uppercase tokens are explicit codes. A lowercase code is accepted only immediately beside
        // a numeric amount (`7777 gbp`), which preserves natural input without turning ordinary
        // words such as "all", "try" and "top" into currencies.
        if (
            match[0] !== match[0].toUpperCase() &&
            !currencyCodeTouchesNumber(text, match.index, match.index + match[0].length)
        ) {
            continue;
        }
        const value = match[0].toUpperCase();
        if (ISO_CURRENCIES.has(value) && !declaration.allowedCurrencies.has(value)) return true;
    }
    for (const rule of keywordRules(rules, declaration.currencyField)) {
        for (const rawEntry of (rule.map as unknown[]).slice(0, MAX_RULE_MAP_ENTRIES)) {
            if (
                !isRecord(rawEntry) ||
                typeof rawEntry.value !== "string" ||
                declaration.allowedCurrencies.has(rawEntry.value.toUpperCase()) ||
                !Array.isArray(rawEntry.keywords)
            ) {
                continue;
            }
            for (const keyword of rawEntry.keywords.slice(0, MAX_RULE_KEYWORDS)) {
                if (typeof keyword !== "string" || keyword.length > MAX_KEYWORD_CHARS) continue;
                const pairKey = JSON.stringify([
                    rawEntry.value.toUpperCase(),
                    keyword.toLocaleLowerCase("en-US"),
                ]);
                if (seenKeywordValuePairs.has(pairKey)) continue;
                if (seenKeywordValuePairs.size >= MAX_MAPPED_KEYWORD_VALUE_PAIRS) return true;
                seenKeywordValuePairs.add(pairKey);
                if (keywordSpans(text, keyword).length > 0) return true;
            }
        }
    }
    return false;
}

function currencyCodeTouchesNumber(text: string, start: number, end: number): boolean {
    const left = text.slice(0, start);
    const right = text.slice(end);
    const continuationIsStructured = (value: string): boolean => {
        const rest = value.trimStart();
        if (rest.length === 0 || /^[,;.!?:)]/u.test(rest)) return true;
        if (/^(?:for|on|towards?|about|due|by|and|but)\b/iu.test(rest)) return true;
        if (/^(?:today|tomorrow|yesterday)\b/iu.test(rest)) return true;
        if (/^\d{4}-\d{2}-\d{2}\b/u.test(rest)) return true;
        return new RegExp(`^(?:${MONTH_PATTERN})\\b`, "iu").test(rest);
    };
    // Lower/mixed-case three-letter prose is accepted as a currency only as part of a complete,
    // structurally delimited money expression. This keeps `7777 gbp`, `20 usd for lunch`, and
    // `usd 20 for lunch`, without turning ordinary ISO-shaped words (`all`, `try`, `top`) into
    // currencies merely because they happen to follow a number.
    const before = new RegExp(
        String.raw`(?:^|[^\p{L}\p{N}_.,])(${STRICT_NUMBER_BODY})\s*$`,
        "u",
    ).exec(left);
    if (before !== null && continuationIsStructured(right)) return true;
    const after = new RegExp(
        String.raw`^\s*(${STRICT_NUMBER_BODY})(?=$|[^\p{L}\p{N}_.,])`,
        "u",
    ).exec(right);
    return after !== null && continuationIsStructured(right.slice(after[0].length));
}

function shortOcrCurrencyAliasTouchesNumber(text: string, start: number, end: number): boolean {
    const left = text.slice(0, start);
    const right = text.slice(end);
    const immediatelyBefore = new RegExp(
        String.raw`(?:^|[^\p{L}\p{N}_.,])${STRICT_NUMBER_BODY}[ \t]{0,2}$`,
        "u",
    ).test(left);
    const immediatelyAfter = new RegExp(
        String.raw`^[ \t]{0,2}${STRICT_NUMBER_BODY}(?=$|[^\p{L}\p{N}_.,])`,
        "u",
    ).test(right);
    return immediatelyBefore || immediatelyAfter;
}

function currencySpans(
    text: string,
    declaration: Declaration,
    rules: readonly unknown[],
    options: { allowShortOcrAliases?: boolean } = {},
): CurrencyScan {
    const spans: CurrencySpan[] = [];
    const seenHits = new Set<string>();
    const seenKeywordValuePairs = new Set<string>();
    let directSpans = 0;
    const add = (span: CurrencySpan): boolean => {
        const key = JSON.stringify([span.value, span.start, span.end]);
        if (seenHits.has(key)) return true;
        if (spans.length >= MAX_MAPPED_HITS) return false;
        seenHits.add(key);
        spans.push(span);
        return true;
    };
    for (const match of text.matchAll(/\b[A-Za-z]{3}\b/gu)) {
        if (match.index === undefined) continue;
        if (
            match[0] !== match[0].toUpperCase() &&
            !currencyCodeTouchesNumber(text, match.index, match.index + match[0].length)
        ) {
            continue;
        }
        const value = match[0].toUpperCase();
        if (declaration.allowedCurrencies.has(value)) {
            if (directSpans >= MAX_DIRECT_CURRENCY_SPANS) {
                return { spans: [], overflow: true };
            }
            directSpans++;
            if (!add({ start: match.index, end: match.index + match[0].length, value })) {
                return { spans: [], overflow: true };
            }
        }
    }
    for (const rule of keywordRules(rules, declaration.currencyField)) {
        for (const rawEntry of (rule.map as unknown[]).slice(0, MAX_RULE_MAP_ENTRIES)) {
            if (!isRecord(rawEntry) || typeof rawEntry.value !== "string") continue;
            const value = rawEntry.value.toUpperCase();
            if (!declaration.allowedCurrencies.has(value) || !Array.isArray(rawEntry.keywords)) {
                continue;
            }
            for (const keyword of rawEntry.keywords.slice(0, MAX_RULE_KEYWORDS)) {
                if (typeof keyword !== "string" || keyword.length > MAX_KEYWORD_CHARS) continue;
                // A declared one/two-letter alias, or a three-letter ASCII token that is not itself
                // an ISO code, is OCR repair evidence rather than ordinary text vocabulary. Accept
                // it only on the OCR path, as an exact whole token immediately touching one number.
                // The rule entry still owns the sole target currency; this never globally guesses a
                // nearby code or rewrites an arbitrary three-letter token.
                const boundedOcrAlias =
                    /^[A-Za-z]{1,2}$/u.test(keyword) ||
                (/^[A-Za-z]{3}$/u.test(keyword) && !ISO_CURRENCIES.has(keyword.toUpperCase()));
                if (boundedOcrAlias && options.allowShortOcrAliases !== true) continue;
                const pairKey = JSON.stringify([value, keyword.toLocaleLowerCase("en-US")]);
                if (seenKeywordValuePairs.has(pairKey)) continue;
                if (seenKeywordValuePairs.size >= MAX_MAPPED_KEYWORD_VALUE_PAIRS) {
                    return { spans: [], overflow: true };
                }
                seenKeywordValuePairs.add(pairKey);
                for (const span of keywordSpans(text, keyword)) {
                    if (
                        boundedOcrAlias &&
                        !shortOcrCurrencyAliasTouchesNumber(text, span.start, span.end)
                    ) {
                        continue;
                    }
                    if (!add({ ...span, value })) return { spans: [], overflow: true };
                }
            }
        }
    }
    spans.sort(
        (left, right) =>
            left.start - right.start ||
            right.end - left.end ||
            left.value.localeCompare(right.value),
    );
    // A specific declared token owns a nested generic one (`E£` -> EGP beats `£` -> GBP).
    type Cover = CurrencySpan;
    const stronger = (left: Cover, right: Cover): boolean =>
        left.end > right.end || (left.end === right.end && left.start < right.start);
    let first: Cover | undefined;
    let second: Cover | undefined;
    const filtered: CurrencySpan[] = [];
    for (const span of spans) {
        const cover = first?.value !== span.value ? first : second;
        const nested =
            cover !== undefined &&
            cover.start <= span.start &&
            cover.end >= span.end &&
            cover.end - cover.start > span.end - span.start;
        if (!nested) filtered.push(span);

        if (first?.value === span.value) {
            if (stronger(span, first)) first = span;
        } else if (second?.value === span.value) {
            if (stronger(span, second)) second = span;
            if (first !== undefined && second !== undefined && stronger(second, first)) {
                [first, second] = [second, first];
            }
        } else if (first === undefined || stronger(span, first)) {
            second = first;
            first = span;
        } else if (second === undefined || stronger(span, second)) {
            second = span;
        }
    }
    return { spans: filtered, overflow: false };
}

function overlaps(span: Span, excluded: readonly Span[]): boolean {
    return excluded.some((other) => span.start < other.end && span.end > other.start);
}

function strictNumberSpans(text: string, excluded: readonly Span[]): NumberSpan[] {
    const spans: NumberSpan[] = [];
    const pattern =
        /(^|[^\p{L}\p{N}_])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?![\p{L}\p{N}_]|[.,]\d)/gu;
    for (const match of text.matchAll(pattern)) {
        if (match.index === undefined) continue;
        const boundary = match[1] ?? "";
        if (boundary === "-" || boundary === "−") continue;
        const raw = match[2];
        const start = match.index + boundary.length;
        const span = { start, end: start + raw.length };
        if (overlaps(span, excluded)) continue;
        const amount = Number(raw.replaceAll(",", ""));
        if (Number.isFinite(amount) && amount > 0) spans.push({ ...span, amount, raw });
    }
    return spans;
}

function validDate(year: number, month: number, day: number): string | undefined {
    if (!Number.isInteger(year) || year < 1900 || year > 2200) return undefined;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return undefined;
    }
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function scanDates(text: string, now?: Date): DateScan {
    const found: { value: string; span: Span }[] = [];
    const claimed: Span[] = [];
    const rangeSpans: Span[] = [];
    let invalid = false;
    const add = (
        match: RegExpMatchArray,
        year: number,
        month: number,
        day: number,
        isRange = false,
    ): void => {
        if (match.index === undefined) return;
        const span = { start: match.index, end: match.index + match[0].length };
        if (overlaps(span, claimed)) return;
        claimed.push(span);
        if (isRange) rangeSpans.push(span);
        const value = validDate(year, month, day);
        if (value === undefined) invalid = true;
        else found.push({ value, span });
    };

    for (const match of text.matchAll(/\b(19\d{2}|20\d{2}|21\d{2}|2200)-(\d{2})-(\d{2})\b/gu)) {
        add(match, Number(match[1]), Number(match[2]), Number(match[3]));
    }
    const range = new RegExp(
        `\\b(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(19\\d{2}|20\\d{2}|21\\d{2}|2200))?\\b`,
        "giu",
    );
    for (const match of text.matchAll(range)) {
        const year = match[4] === undefined ? now?.getUTCFullYear() : Number(match[4]);
        if (year === undefined) {
            invalid = true;
            if (match.index !== undefined) {
                const span = { start: match.index, end: match.index + match[0].length };
                claimed.push(span);
                rangeSpans.push(span);
            }
            continue;
        }
        add(
            match,
            year,
            MONTHS.get(match[3].toLocaleLowerCase("en-US")) ?? 0,
            Number(match[1]),
            true,
        );
    }
    const dayMonth = new RegExp(
        `\\b(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(19\\d{2}|20\\d{2}|21\\d{2}|2200))?\\b`,
        "giu",
    );
    for (const match of text.matchAll(dayMonth)) {
        const year = match[3] === undefined ? now?.getUTCFullYear() : Number(match[3]);
        if (year === undefined) {
            invalid = true;
            if (match.index !== undefined) {
                claimed.push({ start: match.index, end: match.index + match[0].length });
            }
            continue;
        }
        add(match, year, MONTHS.get(match[2].toLocaleLowerCase("en-US")) ?? 0, Number(match[1]));
    }
    const monthDay = new RegExp(
        `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,)?(?:\\s+(19\\d{2}|20\\d{2}|21\\d{2}|2200))?\\b`,
        "giu",
    );
    for (const match of text.matchAll(monthDay)) {
        const year = match[3] === undefined ? now?.getUTCFullYear() : Number(match[3]);
        if (year === undefined) {
            invalid = true;
            if (match.index !== undefined) {
                claimed.push({ start: match.index, end: match.index + match[0].length });
            }
            continue;
        }
        add(match, year, MONTHS.get(match[1].toLocaleLowerCase("en-US")) ?? 0, Number(match[2]));
    }
    if (now !== undefined && Number.isFinite(now.getTime())) {
        const relativeOffsets = new Map([
            ["yesterday", -1],
            ["today", 0],
            ["tomorrow", 1],
        ]);
        for (const [word, offset] of relativeOffsets) {
            for (const span of keywordSpans(text, word)) {
                if (overlaps(span, claimed)) continue;
                const date = new Date(
                    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
                );
                date.setUTCDate(date.getUTCDate() + offset);
                found.push({ value: date.toISOString().slice(0, 10), span });
                claimed.push(span);
            }
        }
    }
    return {
        values: [...new Set(found.map(({ value }) => value))],
        spans: [...claimed],
        rangeSpans,
        invalid,
    };
}

function capturedNumberSpans(text: string, pattern: RegExp): Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(pattern)) {
        if (match.index === undefined || match[1] === undefined) continue;
        const relative = match[0].lastIndexOf(match[1]);
        if (relative < 0) continue;
        const start = match.index + relative;
        spans.push({ start, end: start + match[1].length });
    }
    return spans;
}

function identifierNumberSpans(text: string): Span[] {
    const labelled =
        /\b(?:invoice|order|reference|ref|receipt|account|phone|telephone|mobile|call|version)\s*(?:id|number|no\.?|#|:)?\s*#?\s*(\d{2,})\b/giu;
    const typedIdentifier =
        /\b(?:reservation|booking|transaction|confirmation)\s+(?:id|number|no\.?)\s*#?\s*(\d{2,})\b/giu;
    const genericId = /\bid\s*(?:number|no\.?|#|:)?\s*#?\s*(\d{2,})\b/giu;
    return [
        ...capturedNumberSpans(text, labelled),
        ...capturedNumberSpans(text, typedIdentifier),
        ...capturedNumberSpans(text, genericId),
    ];
}

function quantityNumberSpans(text: string): Span[] {
    return capturedNumberSpans(
        text,
        /\b((?:\d{1,3}(?:,\d{3})+|\d+))\s+(?:items?|tickets?|people|persons?|units?|pieces?|nights?|days?|hours?|rooms?|guests?|seats?|meals?|months?|years?|copies)\b/giu,
    );
}

function isExchangeRateText(text: string): boolean {
    if (/\b(?:exchange|fx)\s+rates?\b/iu.test(text)) return true;
    if (!/(?:=|\bper\b|\b(?:buy|buys|equal|equals|convert|converts|worth)\b)/iu.test(text)) {
        return false;
    }
    const currencies = [...text.matchAll(/\b[A-Za-z]{3}\b/gu)].filter((match) =>
        ISO_CURRENCIES.has(match[0].toUpperCase()),
    );
    return currencies.length >= 2 && [...text.matchAll(/\d+/gu)].length >= 2;
}

function compoundNumericSpans(text: string, dates: DateScan): Span[] {
    const spans: Span[] = [];
    const pattern = new RegExp(
        String.raw`(?:^|[^\p{L}\p{N}_.,])(${STRICT_NUMBER_BODY}(?:\s*(?:[/:\-–—]|\bto\b)\s*${STRICT_NUMBER_BODY})+)(?![\p{L}\p{N}_]|[.,]\d)`,
        "giu",
    );
    for (const match of text.matchAll(pattern)) {
        if (match.index === undefined || match[1] === undefined) continue;
        const relative = match[0].lastIndexOf(match[1]);
        if (relative < 0) continue;
        const span = {
            start: match.index + relative,
            end: match.index + relative + match[1].length,
        };
        // A declared textual/ISO date range owns its digits; arbitrary numeric compounds do not.
        if (!overlaps(span, dates.spans)) spans.push(span);
    }
    return spans;
}

function otherNumericExclusions(text: string, dates: DateScan): Span[] {
    const spans = [...dates.spans];
    for (const regex of [
        /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?\b/giu,
        /\b\d+(?:\.\d+)?\s*%/gu,
    ]) {
        for (const match of text.matchAll(regex)) {
            if (match.index !== undefined)
                spans.push({ start: match.index, end: match.index + match[0].length });
        }
    }
    spans.push(
        ...identifierNumberSpans(text),
        ...quantityNumberSpans(text),
        ...compoundNumericSpans(text, dates),
    );
    if (isExchangeRateText(text)) {
        for (const match of text.matchAll(/\d+/gu)) {
            if (match.index !== undefined) {
                spans.push({ start: match.index, end: match.index + match[0].length });
            }
        }
    }
    return spans;
}

function hasMalformedNumericGroup(text: string, excluded: readonly Span[]): boolean {
    const visited = new Set<number>();
    for (const match of text.matchAll(/\d/gu)) {
        if (match.index === undefined || visited.has(match.index)) continue;
        let start = match.index;
        let end = start + 1;
        while (start > 0 && /[\d., \t]/u.test(text[start - 1])) start--;
        while (end < text.length && /[\d., \t]/u.test(text[end])) end++;
        for (let index = start; index < end; index++) visited.add(index);
        const digitSpans: Span[] = [];
        for (const digit of text.slice(start, end).matchAll(/\d+/gu)) {
            if (digit.index !== undefined) {
                digitSpans.push({
                    start: start + digit.index,
                    end: start + digit.index + digit[0].length,
                });
            }
        }
        const activeDigitSpans = digitSpans.filter((span) => !overlaps(span, excluded));
        if (activeDigitSpans.length === 0) continue;
        const firstActive = activeDigitSpans[0];
        const lastActive = activeDigitSpans.at(-1) ?? firstActive;
        const effectiveStart = digitSpans.some(
            (span) => span.end <= firstActive.start && overlaps(span, excluded),
        )
            ? firstActive.start
            : start;
        const effectiveEnd = digitSpans.some(
            (span) => span.start >= lastActive.end && overlaps(span, excluded),
        )
            ? lastActive.end
            : end;
        // A final comma/full stop is ordinary clause punctuation, not part of the number. Leading
        // punctuation remains significant, so `.50` cannot be silently reinterpreted as `50`.
        const raw = text.slice(effectiveStart, effectiveEnd).trim().replace(/[.,]$/u, "");
        if (!new RegExp(`^${STRICT_NUMBER_BODY}$`, "u").test(raw)) return true;
    }
    return false;
}

function hasUncertainNumericExpression(text: string, dates: DateScan): boolean {
    const numbers: Span[] = [];
    for (const match of text.matchAll(/\d+(?:[.,]\d+)*/gu)) {
        if (match.index === undefined) continue;
        const span = { start: match.index, end: match.index + match[0].length };
        if (overlaps(span, dates.spans)) continue;
        if (numbers.length >= MAX_MAPPED_HITS) return true;
        numbers.push(span);
    }
    for (let index = 0; index < numbers.length; index++) {
        const number = numbers[index];
        const bounded = text.slice(Math.max(0, number.start - 64), number.start);
        const boundary = Math.max(
            bounded.lastIndexOf("."),
            bounded.lastIndexOf(";"),
            bounded.lastIndexOf("!"),
            bounded.lastIndexOf("?"),
            bounded.lastIndexOf("\n"),
        );
        const prefix = bounded.slice(boundary + 1);
        if (/\bnot\b[^\d.;!?\n]{0,40}$/iu.test(prefix)) return true;
        if (
            /\b(?:up\s+to|at\s+(?:most|least)|more\s+than|less\s+than|under|over|around|approximately|approx\.?|about|roughly|circa|nearly|almost|minimum|maximum)\b[^\d.;!?\n]{0,32}$/iu.test(
                prefix,
            )
        ) {
            return true;
        }
        const suffix = text.slice(number.end, Math.min(text.length, number.end + 32));
        if (/^\s*(?:\+|-?ish\b|or\s+so\b)/iu.test(suffix)) return true;

        const next = numbers[index + 1];
        if (next === undefined) continue;
        const gap = text.slice(number.end, next.start);
        if (/[.;!?\n]/u.test(gap)) continue;
        if (/\bor\b|\band\s+not\b|\bnot\b/iu.test(gap)) return true;
        if (/\band\b/iu.test(gap) && /\b(?:between|either)\b[^\d.;!?\n]{0,32}$/iu.test(prefix)) {
            return true;
        }
    }
    return false;
}

function hasSignedOrAccountingMoney(text: string): boolean {
    const currency = String.raw`(?:\b[A-Za-z]{3}\b|E£|[$€£¥₹])`;
    const money = String.raw`(?:${currency}\s*${STRICT_NUMBER_BODY}|${STRICT_NUMBER_BODY}\s*${currency})`;
    const signedOrCurrencyAccounting = new RegExp(
        String.raw`(?:[-−]\s*${money}|${currency}\s*[-−]\s*${STRICT_NUMBER_BODY}|\(\s*${money}\s*\))`,
        "giu",
    );
    const bareAccounting = new RegExp(String.raw`\(\s*${STRICT_NUMBER_BODY}\s*\)`, "gu");
    return signedOrCurrencyAccounting.test(text) || bareAccounting.test(text);
}

function propertyAccepts(property: unknown, value: unknown): boolean {
    if (!isRecord(property)) return false;
    if (property.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        if (typeof property.minimum === "number" && value < property.minimum) return false;
        if (typeof property.maximum === "number" && value > property.maximum) return false;
        if (typeof property.exclusiveMinimum === "number" && value <= property.exclusiveMinimum) {
            return false;
        }
        return true;
    }
    if (property.type !== "string" || typeof value !== "string" || value.includes("\0"))
        return false;
    if (typeof property.minLength === "number" && [...value].length < property.minLength)
        return false;
    if (typeof property.maxLength === "number" && [...value].length > property.maxLength)
        return false;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return false;
    return true;
}

function closestCurrency(
    amount: NumberSpan,
    currencies: readonly CurrencySpan[],
): string | undefined | "ambiguous" {
    if (currencies.length === 0) return undefined;
    let distance = Number.POSITIVE_INFINITY;
    const values = new Set<string>();
    for (const currency of currencies) {
        const nextDistance =
            currency.end <= amount.start
                ? amount.start - currency.end
                : currency.start >= amount.end
                  ? currency.start - amount.end
                  : 0;
        if (nextDistance < distance) {
            distance = nextDistance;
            values.clear();
            values.add(currency.value);
        } else if (nextDistance === distance) {
            values.add(currency.value);
        }
    }
    return values.size === 1 ? [...values][0] : "ambiguous";
}

function spanDistance(left: Span, right: Span): number {
    if (left.end <= right.start) return right.start - left.end;
    if (left.start >= right.end) return left.start - right.end;
    return 0;
}

function currenciesOwnedByAmount(
    amount: NumberSpan,
    amounts: readonly NumberSpan[],
    currencies: readonly CurrencySpan[],
): CurrencySpan[] {
    return currencies.filter((currency) => {
        const distance = spanDistance(amount, currency);
        return amounts.every((other) => distance <= spanDistance(other, currency));
    });
}

function mappedOrFallback(
    local: MappedValue,
    global: MappedValue,
    fallback: string | undefined,
    allowed: ReadonlySet<string>,
): string | undefined | "ambiguous" {
    const resolved = local.kind === "none" ? global : local;
    if (resolved.kind === "ambiguous") return "ambiguous";
    const value = resolved.kind === "value" ? resolved.value : fallback;
    return value !== undefined && allowed.has(value) ? value : undefined;
}

function mergeMappedEvidence(left: MappedValue, right: MappedValue): MappedValue {
    if (left.kind === "ambiguous" || right.kind === "ambiguous") return { kind: "ambiguous" };
    if (left.kind === "none") return right;
    if (right.kind === "none") return left;
    return left.value === right.value ? left : { kind: "ambiguous" };
}

function removeLiteralSpans(text: string, spans: readonly Span[]): string {
    // `split("")` intentionally indexes UTF-16 code units, matching RegExp/String offsets. Joining
    // untouched surrogate pairs preserves source Unicode exactly.
    const chars = text.split("");
    for (const span of spans) {
        for (let index = span.start; index < span.end; index++) chars[index] = " ";
    }
    return chars.join("");
}

function trimNote(value: string): string {
    return value
        .replace(/^[\s,;:|.!?/-]+|[\s,;:|.!?/-]+$/gu, "")
        .replace(/^(?:also\s+)?(?:for|on|towards?|about)\s+/iu, "")
        .replace(/\s+(?:and|but)$/iu, "")
        .trim();
}

function ruleKeywordSpans(
    text: string,
    rules: readonly unknown[],
    fields: readonly string[],
): SpanScan {
    const spans: Span[] = [];
    const seenKeywords = new Set<string>();
    const seenHits = new Set<string>();
    for (const field of fields) {
        for (const rule of keywordRules(rules, field)) {
            for (const entry of (rule.map as unknown[]).slice(0, MAX_RULE_MAP_ENTRIES)) {
                if (!isRecord(entry) || !Array.isArray(entry.keywords)) continue;
                for (const keyword of entry.keywords.slice(0, MAX_RULE_KEYWORDS)) {
                    if (typeof keyword !== "string" || keyword.length > MAX_KEYWORD_CHARS) continue;
                    const keywordKey = keyword.toLocaleLowerCase("en-US");
                    if (seenKeywords.has(keywordKey)) continue;
                    if (seenKeywords.size >= MAX_MAPPED_KEYWORD_VALUE_PAIRS) {
                        return { spans: [], overflow: true };
                    }
                    seenKeywords.add(keywordKey);
                    for (const span of keywordSpans(text, keyword)) {
                        const hitKey = `${span.start}:${span.end}`;
                        if (seenHits.has(hitKey)) continue;
                        if (spans.length >= MAX_MAPPED_HITS) {
                            return { spans: [], overflow: true };
                        }
                        seenHits.add(hitKey);
                        spans.push(span);
                    }
                }
            }
        }
    }
    spans.sort((left, right) => left.start - right.start || right.end - left.end);
    return { spans, overflow: false };
}

function hasNegatedRuleCue(
    text: string,
    rules: readonly unknown[],
    fields: readonly string[],
): boolean {
    const negatedPrefix = new RegExp(
        String.raw`(?:\b(?:not|never)\s+|\bno(?:\s+longer)?\s+|\b(?:do|does|did|have|has|had|is|are|was|were|will|would|can|could|should|must)(?:n't|n’t)\s+)(?:[\p{L}\p{N}_'’-]+\s+){0,2}$`,
        "iu",
    );
    for (const span of ruleKeywordSpans(text, rules, fields).spans) {
        const prefix = text.slice(Math.max(0, span.start - 64), span.start);
        if (negatedPrefix.test(prefix)) return true;
    }
    return false;
}

function guardedNegatedRuleCue(
    text: string,
    rules: readonly unknown[],
    fields: readonly string[],
): boolean | "overflow" {
    const scan = ruleKeywordSpans(text, rules, fields);
    if (scan.overflow) return "overflow";
    for (const span of scan.spans) {
        const bounded = text.slice(Math.max(0, span.start - 64), span.start);
        const boundary = Math.max(
            bounded.lastIndexOf("."),
            bounded.lastIndexOf(";"),
            bounded.lastIndexOf("!"),
            bounded.lastIndexOf("?"),
            bounded.lastIndexOf("\n"),
        );
        const prefix = bounded.slice(boundary + 1);
        if (/\b(?:not|never)\b|\bno(?:\s+longer)?\b|\b[\p{L}]+(?:n't|n’t)\b/iu.test(prefix)) {
            return true;
        }
    }
    return hasNegatedRuleCue(text, rules, fields);
}

function hasUnsupportedSettlementViewpoint(text: string): boolean {
    return (
        /\byou(?:\s+(?:have|has|had|just|already|recently|now)){0,4}\s+(?:paid|sent|transferred|settled)\b/iu.test(
            text,
        ) ||
        /\b(?:paid|sent|transferred|settled)(?:\s+[^.;!?\n]{0,32})?\s+(?:me|us)\b/iu.test(text) ||
        /\b(?:i|we)(?:\s+(?:have|has|had|just|already|recently)){0,4}\s+received\b/iu.test(text) ||
        /\b(?:payment\s+)?received\b[^.;!?\n]{0,48}\bfrom\b/iu.test(text) ||
        /\b(?:paid|sent|transferred|settled)\s+by\s+(?:you|them|him|her|[\p{L}][\p{L}'’-]*)\b/iu.test(
            text,
        )
    );
}

function bareAmountIsMonetary(segment: string, amount: NumberSpan): boolean {
    const suffix = segment.slice(amount.end).trimStart();
    if (
        suffix.length === 0 ||
        /^[,;.!?)]/u.test(suffix) ||
        /^(?:for|on|towards?|about|due|by)\b/iu.test(suffix)
    ) {
        return true;
    }
    return false;
}

function extractTypedNote(
    segment: string,
    amount: NumberSpan,
    previousAmountEnd: number,
    nextAmountStart: number,
    dates: DateScan,
    currencies: readonly CurrencySpan[],
    rules: readonly unknown[],
    declaration: Declaration,
): string | undefined {
    // A range is both the normalized date source and meaningful reservation duration. Keep its
    // exact source words in the editable note while still excluding ordinary one-day dates.
    const removableDates = dates.spans.filter(
        (span) =>
            !dates.rangeSpans.some((range) => range.start === span.start && range.end === span.end),
    );
    const removable = [
        ...removableDates,
        ...currencies,
        ...ruleKeywordSpans(segment, rules, [declaration.kindField, declaration.directionField])
            .spans,
    ];
    const cleaned = removeLiteralSpans(segment, removable);
    const after = trimNote(cleaned.slice(amount.end, nextAmountStart));
    if (/\p{L}/u.test(after)) return after;
    let before = cleaned.slice(previousAmountEnd, amount.start);
    const colon = before.lastIndexOf(":");
    if (colon >= 0) before = before.slice(colon + 1);
    before = trimNote(before);
    return /\p{L}/u.test(before) ? before : undefined;
}

function splitTypedSegments(text: string): string[] {
    const primary = text
        .split(/(?:[;\n]+|(?<=[.!?])\s+)/gu)
        .map((part) => part.trim())
        .filter(Boolean);
    const out: string[] = [];
    for (const part of primary) {
        const pieces = [part];
        for (let index = 0; index < pieces.length && pieces.length <= MAX_CANDIDATES; index++) {
            const piece = pieces[index];
            const match = [...piece.matchAll(/\s+(?:but|and)\s+/giu)].find((candidate) => {
                if (candidate.index === undefined) return false;
                const left = piece.slice(0, candidate.index);
                const right = piece.slice(candidate.index + candidate[0].length);
                return /\d/u.test(left) && /\d/u.test(right);
            });
            if (match?.index === undefined) continue;
            const left = piece.slice(0, match.index).trim();
            const right = piece.slice(match.index + match[0].length).trim();
            pieces.splice(index, 1, left, right);
            index--;
        }
        out.push(...pieces.map((piece) => piece.trim()).filter(Boolean));
    }
    return out;
}

function parseTyped(
    declaration: Declaration,
    responseSchema: object | undefined,
    rules: readonly unknown[],
    input: SourceGroundedTransactionInput,
): SourceGroundedParseResult {
    if (!propertyAccepts(declaration.properties[declaration.sourceField], input.text)) {
        return { kind: "ambiguous", reason: "exact_source_does_not_fit_schema" };
    }
    if (unsupportedCurrencyInSource(input.text, declaration, rules)) {
        return { kind: "none", reason: "currency_outside_schema" };
    }
    const negated = guardedNegatedRuleCue(input.text, rules, [
        declaration.kindField,
        declaration.directionField,
    ]);
    if (negated === "overflow") {
        return { kind: "ambiguous", reason: "semantic_evidence_outside_bounds" };
    }
    if (negated) {
        return { kind: "ambiguous", reason: "negated_transaction_semantics" };
    }
    const sourceDates = declaration.dateEnabled
        ? scanDates(input.text, input.now)
        : { values: [], spans: [], rangeSpans: [], invalid: false };
    if (sourceDates.invalid || sourceDates.values.length > 1) {
        return { kind: "ambiguous", reason: "invalid_or_conflicting_source_date" };
    }
    if (hasSignedOrAccountingMoney(input.text)) {
        return { kind: "ambiguous", reason: "signed_or_accounting_amount" };
    }
    if (hasUncertainNumericExpression(input.text, sourceDates)) {
        return { kind: "ambiguous", reason: "uncertain_numeric_expression" };
    }
    const globalKind = mappedValue(rules, declaration.kindField, [input.text]);
    const globalDirection = mappedValue(rules, declaration.directionField, [input.text]);
    const sourceSequence = parseDeclaredTextSequence(responseSchema, input.text);
    if (sourceSequence.kind === "overflow") {
        return { kind: "ambiguous", reason: "too_many_transactions" };
    }
    if (sourceSequence.kind === "candidates") {
        if (sourceSequence.candidates.length > declaration.maximumItems) {
            return { kind: "ambiguous", reason: "too_many_transactions" };
        }
        const kind = mappedOrFallback(
            globalKind,
            { kind: "none" },
            declaration.fallbackKind,
            declaration.allowedKinds,
        );
        const direction = mappedOrFallback(
            globalDirection,
            { kind: "none" },
            declaration.defaultDirection,
            declaration.allowedDirections,
        );
        if (kind === "ambiguous" || direction === "ambiguous") {
            return { kind: "ambiguous", reason: "conflicting_transaction_semantics" };
        }
        if (kind === undefined || direction === undefined) {
            return { kind: "none", reason: "missing_transaction_semantics" };
        }
        const candidates: Record<string, unknown>[] = [];
        for (const sourceCandidate of sourceSequence.candidates) {
            const amount = sourceCandidate[declaration.amountField];
            const note = sourceCandidate[declaration.noteField];
            if (
                typeof amount !== "number" ||
                typeof note !== "string" ||
                !propertyAccepts(declaration.properties[declaration.amountField], amount) ||
                !propertyAccepts(declaration.properties[declaration.noteField], note)
            ) {
                return { kind: "ambiguous", reason: "text_sequence_fields_do_not_match" };
            }
            candidates.push({
                [declaration.amountField]: amount,
                [declaration.noteField]: note,
                [declaration.kindField]: kind,
                [declaration.directionField]: direction,
                [declaration.sourceField]: input.text,
            });
        }
        return { kind: "candidates", candidates };
    }
    const candidates: Record<string, unknown>[] = [];
    let sawNumeric = false;

    for (const segment of splitTypedSegments(input.text)) {
        const dates = declaration.dateEnabled
            ? scanDates(segment, input.now)
            : { values: [], spans: [], rangeSpans: [], invalid: false };
        if (dates.invalid || dates.values.length > 1) {
            return { kind: "ambiguous", reason: "invalid_or_conflicting_source_date" };
        }
        const exclusions = otherNumericExclusions(segment, dates);
        if (hasMalformedNumericGroup(segment, exclusions)) {
            return { kind: "ambiguous", reason: "malformed_numeric_token" };
        }
        const numbers = strictNumberSpans(segment, exclusions);
        if (numbers.length === 0) continue;
        sawNumeric = true;
        const currencyScan = currencySpans(segment, declaration, rules);
        if (currencyScan.overflow) {
            return { kind: "ambiguous", reason: "currency_evidence_outside_bounds" };
        }
        const currencies = currencyScan.spans;
        if (numbers.length === 1 && new Set(currencies.map(({ value }) => value)).size > 1) {
            return { kind: "ambiguous", reason: "amount_has_ambiguous_currency" };
        }
        const localKind = mappedValue(rules, declaration.kindField, [segment]);
        const localDirection = mappedValue(rules, declaration.directionField, [segment]);
        if (
            localKind.kind === "value" &&
            localDirection.kind === "none" &&
            hasUnsupportedSettlementViewpoint(segment)
        ) {
            return { kind: "ambiguous", reason: "unsupported_settlement_direction" };
        }
        const kind = mappedOrFallback(
            localKind,
            globalKind,
            declaration.fallbackKind,
            declaration.allowedKinds,
        );
        const direction = mappedOrFallback(
            localDirection,
            globalDirection,
            declaration.defaultDirection,
            declaration.allowedDirections,
        );
        if (kind === "ambiguous" || direction === "ambiguous") {
            return { kind: "ambiguous", reason: "conflicting_transaction_semantics" };
        }
        if (kind === undefined || direction === undefined) continue;

        const hasTransactionCue = localKind.kind !== "none" || localDirection.kind !== "none";
        const grounded: { amount: NumberSpan; currency?: string }[] = [];
        for (const amount of numbers) {
            const currency = closestCurrency(
                amount,
                currenciesOwnedByAmount(amount, numbers, currencies),
            );
            if (currency === "ambiguous") {
                return { kind: "ambiguous", reason: "amount_has_ambiguous_currency" };
            }
            // A bare number is accepted only when it is the sole non-date number in a clause with
            // explicit transaction language. This rejects quantities, IDs and times as money.
            if (
                currency === undefined &&
                !(
                    numbers.length === 1 &&
                    hasTransactionCue &&
                    bareAmountIsMonetary(segment, amount)
                )
            ) {
                continue;
            }
            grounded.push({ amount, ...(currency === undefined ? {} : { currency }) });
        }
        for (let index = 0; index < grounded.length; index++) {
            const { amount, currency } = grounded[index];
            if (!propertyAccepts(declaration.properties[declaration.amountField], amount.amount)) {
                return { kind: "ambiguous", reason: "amount_outside_schema" };
            }
            if (
                currency !== undefined &&
                !propertyAccepts(declaration.properties[declaration.currencyField], currency)
            ) {
                return { kind: "ambiguous", reason: "currency_outside_schema" };
            }
            const note = extractTypedNote(
                segment,
                amount,
                grounded[index - 1]?.amount.end ?? 0,
                grounded[index + 1]?.amount.start ?? segment.length,
                dates,
                currencies,
                rules,
                declaration,
            );
            if (
                note !== undefined &&
                !propertyAccepts(declaration.properties[declaration.noteField], note)
            ) {
                return { kind: "ambiguous", reason: "note_outside_schema" };
            }
            const candidate: Record<string, unknown> = {
                [declaration.amountField]: amount.amount,
                [declaration.kindField]: kind,
                [declaration.directionField]: direction,
                [declaration.sourceField]: input.text,
            };
            if (currency !== undefined) candidate[declaration.currencyField] = currency;
            if (dates.values[0] !== undefined) candidate[declaration.dateField] = dates.values[0];
            if (note !== undefined) candidate[declaration.noteField] = note;
            candidates.push(candidate);
            if (candidates.length > declaration.maximumItems) {
                return { kind: "ambiguous", reason: "too_many_transactions" };
            }
        }
    }
    if (candidates.length === 0) {
        return { kind: "none", reason: sawNumeric ? "no_grounded_monetary_amount" : "no_amount" };
    }
    return { kind: "candidates", candidates };
}

function startsWithLabel(
    line: string,
    labels: readonly string[],
): { label: string; rest: string } | undefined {
    const normalized = normalizedPhrase(line);
    for (const label of [...labels].sort((a, b) => b.length - a.length)) {
        if (normalized === label) return { label, rest: "" };
        if (normalized.startsWith(`${label}:`) || normalized.startsWith(`${label} `)) {
            let cursor = 0;
            let matched = true;
            for (const word of label.split(" ")) {
                while (/\s/u.test(line[cursor] ?? "")) cursor++;
                if (line.slice(cursor, cursor + word.length).toLocaleLowerCase("en-US") !== word) {
                    matched = false;
                    break;
                }
                cursor += word.length;
            }
            if (!matched) continue;
            const rest = line.slice(cursor).replace(/^\s*:?\s*/u, "");
            return { label, rest };
        }
    }
    return undefined;
}

function relationshipEvidence(line: string, declaration: Declaration): string | undefined {
    const colon = line.indexOf(":");
    if (colon < 0) return line;
    const prefix = normalizedPhrase(line.slice(0, colon));
    for (const expected of declaration.relationshipLabelPrefixes) {
        const missing = expected.length - prefix.length;
        if (prefix === expected || (missing >= 1 && missing <= 2 && expected.endsWith(prefix))) {
            return line.slice(colon + 1).trim();
        }
    }
    return undefined;
}

function trailingNegatedRuleCue(
    text: string,
    rules: readonly unknown[],
    fields: readonly string[],
): boolean | "overflow" {
    const scan = ruleKeywordSpans(text, rules, fields);
    if (scan.overflow) return "overflow";
    for (const span of scan.spans) {
        const bounded = text.slice(span.end, Math.min(text.length, span.end + 64));
        const stops = [".", ",", ";", "!", "?", "\n"]
            .map((token) => bounded.indexOf(token))
            .filter((index) => index >= 0);
        const suffix = bounded.slice(0, stops.length === 0 ? undefined : Math.min(...stops));
        if (/\b(?:not|never|nothing|nobody|none|no(?:\s+one|\s+longer)?)\b/iu.test(suffix)) {
            return true;
        }
    }
    return false;
}

function hasUntrustedOcrSemanticCue(
    lines: readonly string[],
    declaration: Declaration,
    rules: readonly unknown[],
): boolean {
    const untrustedSemanticTexts: string[] = [];
    for (const line of lines) {
        if (!line.includes(":") || relationshipEvidence(line, declaration) !== undefined) {
            continue;
        }
        // A declared note is descriptive source, not kind/direction evidence. It is read through
        // the note policy below and must not turn e.g. `NOTE: Paid parking` into a hidden override.
        if (startsWithLabel(line, declaration.noteLabels) !== undefined) continue;
        // Configured structural labels may themselves contain a semantic keyword (`AMOUNT DUE`).
        // Scan only their remainder. Every other non-relationship colon line is untrusted in full,
        // including its prefix, so `I OWE YOU: 350 EGP` cannot be inverted by an OCR fallback.
        const structural =
            startsWithLabel(line, declaration.authoritativeAmountLabels) ??
            startsWithLabel(line, declaration.dateLabels) ??
            startsWithLabel(line, declaration.ignoredLineLabels);
        const evidence = structural?.rest ?? line;
        if (evidence.length > 0) untrustedSemanticTexts.push(evidence);
    }
    return (
        untrustedSemanticTexts.length > 0 &&
        [declaration.kindField, declaration.directionField].some(
            (field) => mappedValue(rules, field, untrustedSemanticTexts).kind !== "none",
        )
    );
}

function parseOcrMoneyLine(
    line: string,
    declaration: Declaration,
    rules: readonly unknown[],
    options: { allowIdentifierShapedAmount?: boolean } = {},
): { amount: number; currency?: string } | "invalid" | undefined {
    const dates = scanDates(line);
    if (hasSignedOrAccountingMoney(line) || hasUncertainNumericExpression(line, dates)) {
        return "invalid";
    }
    const exclusions = otherNumericExclusions(line, dates);
    if (hasMalformedNumericGroup(line, exclusions)) return "invalid";
    const numbers = strictNumberSpans(line, exclusions);
    if (numbers.length === 0) return undefined;
    if (numbers.length !== 1) return "invalid";
    const amount = numbers[0];
    // A long, unpunctuated integer on an unlabelled OCR line is identifier-shaped (references,
    // account numbers, phone numbers), even if adjacent script noise happens to be a valid ISO code.
    // A declared authoritative label retains the full schema-permitted amount range below.
    if (
        options.allowIdentifierShapedAmount !== true &&
        /^\d{10,}$/u.test(line.slice(amount.start, amount.end))
    ) {
        return undefined;
    }
    if (!propertyAccepts(declaration.properties[declaration.amountField], amount.amount))
        return "invalid";
    const localCurrencies = currencySpans(line, declaration, rules, {
        allowShortOcrAliases: true,
    });
    if (localCurrencies.overflow) return "invalid";
    const currency = closestCurrency(amount, localCurrencies.spans);
    if (currency === "ambiguous") return "invalid";
    if (
        currency !== undefined &&
        !propertyAccepts(declaration.properties[declaration.currencyField], currency)
    ) {
        return "invalid";
    }
    return { amount: amount.amount, ...(currency === undefined ? {} : { currency }) };
}

function parseAuthoritativeOcrMoney(
    lines: readonly string[],
    labelIndex: number,
    declaration: Declaration,
    rules: readonly unknown[],
): { index: number; money: { amount: number; currency?: string } } | "invalid" | undefined {
    const labelled = startsWithLabel(lines[labelIndex], declaration.authoritativeAmountLabels);
    if (labelled === undefined) return undefined;
    if (labelled.rest.length > 0) {
        const parsed = parseOcrMoneyLine(lines[labelIndex], declaration, rules, {
            allowIdentifierShapedAmount: true,
        });
        return parsed === undefined || parsed === "invalid"
            ? "invalid"
            : { index: labelIndex, money: parsed };
    }

    // Mobile OCR commonly emits a large amount and its pale label on adjacent rows. Bind an
    // app-declared empty label only when exactly one immediate neighbour is a valid money line.
    const adjacent: { index: number; money: { amount: number; currency?: string } }[] = [];
    for (const index of [labelIndex - 1, labelIndex + 1]) {
        if (index < 0 || index >= lines.length) continue;
        const parsed = parseOcrMoneyLine(lines[index], declaration, rules, {
            allowIdentifierShapedAmount: true,
        });
        if (parsed !== undefined && parsed !== "invalid") adjacent.push({ index, money: parsed });
    }
    return adjacent.length === 1 ? adjacent[0] : "invalid";
}

function sameMoney(
    left: { amount: number; currency?: string },
    right: { amount: number; currency?: string },
): boolean {
    return left.amount === right.amount && left.currency === right.currency;
}

function noteFromOcr(
    lines: readonly string[],
    authorityIndex: number,
    money: { amount: number; currency?: string },
    declaration: Declaration,
    rules: readonly unknown[],
    allowUnlabelledFallback: boolean,
): string | undefined | "ambiguous" {
    const isConfiguredTitle = (line: string): boolean => {
        const normalized = normalizedPhrase(line);
        return declaration.titleLineKeywords.some(
            (keyword) => keywordSpans(normalized, keyword).length > 0,
        );
    };
    const cleanCandidate = (
        line: string,
        allowDeclaredNoteKindCue = false,
    ): string | undefined | "ambiguous" => {
        if (!/\p{L}/u.test(line)) return undefined;
        if (startsWithLabel(line, declaration.authoritativeAmountLabels) !== undefined)
            return undefined;
        if (startsWithLabel(line, declaration.dateLabels) !== undefined) return undefined;
        if (startsWithLabel(line, declaration.noteLabels) !== undefined) return undefined;
        if (startsWithLabel(line, declaration.ignoredLineLabels) !== undefined) return undefined;
        if (isConfiguredTitle(line)) return undefined;
        const relation = relationshipEvidence(line, declaration);
        if (
            relation !== undefined &&
            (mappedValue(rules, declaration.directionField, [relation]).kind !== "none" ||
                (!allowDeclaredNoteKindCue &&
                    mappedValue(rules, declaration.kindField, [relation]).kind !== "none"))
        ) {
            return undefined;
        }
        const dates = scanDates(line);
        if (dates.values.length > 0 || dates.invalid) return undefined;
        const parsedMoney = parseOcrMoneyLine(line, declaration, rules);
        if (parsedMoney !== undefined) return undefined;
        const note = trimNote(line);
        return propertyAccepts(declaration.properties[declaration.noteField], note)
            ? note
            : "ambiguous";
    };

    const labelledNotes: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const labelled = startsWithLabel(lines[index], declaration.noteLabels);
        if (labelled === undefined) continue;
        if (labelled.rest.length === 0) {
            // A payment word can legitimately describe the note (`Paid parking`). The app-declared
            // Note row makes that descriptive rather than kind evidence. Still reject an exact
            // relationship cue here because it may be a separate structural row.
            const next = cleanCandidate(lines[index + 1] ?? "", true);
            if (next === "ambiguous") return "ambiguous";
            if (next !== undefined) labelledNotes.push(next);
            continue;
        }
        const note = trimNote(labelled.rest);
        if (!/\p{L}/u.test(note)) return "ambiguous";
        if (!propertyAccepts(declaration.properties[declaration.noteField], note)) {
            return "ambiguous";
        }
        labelledNotes.push(note);
    }
    if (labelledNotes.length > 0) {
        const unique = [...new Set(labelledNotes)];
        return unique.length === 1 ? unique[0] : "ambiguous";
    }

    // When money itself has no declared structural label, a nearby OCR line has no trustworthy
    // field relationship and may be a party, bank, or damaged heading. Keep explicit Note/
    // Description/Memo rows above, but otherwise omit the optional note instead of mislabelling it.
    if (!allowUnlabelledFallback) return undefined;

    for (let index = authorityIndex - 1; index >= 0; index--) {
        const line = lines[index];
        if (startsWithLabel(line, declaration.ignoredLineLabels) !== undefined) continue;
        if (startsWithLabel(line, declaration.authoritativeAmountLabels) !== undefined) continue;
        if (startsWithLabel(line, declaration.noteLabels) !== undefined) continue;
        const parsed = parseOcrMoneyLine(line, declaration, rules);
        if (
            parsed !== undefined &&
            parsed !== "invalid" &&
            parsed.amount === money.amount &&
            (parsed.currency === undefined || parsed.currency === money.currency)
        ) {
            const dates = scanDates(line);
            const number = strictNumberSpans(line, otherNumericExclusions(line, dates))[0];
            const currencies = currencySpans(line, declaration, rules, {
                allowShortOcrAliases: true,
            });
            if (currencies.overflow) return "ambiguous";
            const note = trimNote(removeLiteralSpans(line, [number, ...currencies.spans]));
            if (/\p{L}/u.test(note)) return note;
        }
    }
    for (let index = authorityIndex - 1; index >= 0; index--) {
        const line = lines[index];
        if (!/\p{L}/u.test(line)) continue;
        if (startsWithLabel(line, declaration.ignoredLineLabels) !== undefined) continue;
        if (startsWithLabel(line, declaration.authoritativeAmountLabels) !== undefined) continue;
        if (startsWithLabel(line, declaration.dateLabels) !== undefined) continue;
        if (startsWithLabel(line, declaration.noteLabels) !== undefined) continue;
        if (isConfiguredTitle(line)) continue;
        const relation = relationshipEvidence(line, declaration);
        if (
            relation !== undefined &&
            (mappedValue(rules, declaration.directionField, [relation]).kind !== "none" ||
                mappedValue(rules, declaration.kindField, [relation]).kind !== "none")
        ) {
            // A visible completion/status line is semantic evidence, not a transaction note. This
            // is rule-driven rather than language-specific: an app-declared Arabic success phrase
            // is excluded in exactly the same way as an English one, and no absent note is made up.
            continue;
        }
        const dates = scanDates(line);
        if (dates.values.length > 0 || dates.invalid) continue;
        if (strictNumberSpans(line, otherNumericExclusions(line, dates)).length > 0) continue;
        const note = trimNote(line);
        if (propertyAccepts(declaration.properties[declaration.noteField], note)) return note;
        return "ambiguous";
    }
    return undefined;
}

function parseOcr(
    declaration: Declaration,
    rules: readonly unknown[],
    input: SourceGroundedTransactionInput,
): SourceGroundedParseResult {
    const messageText = input.messageText?.trim() || undefined;
    if (
        messageText !== undefined &&
        !propertyAccepts(declaration.properties[declaration.noteField], messageText)
    ) {
        return { kind: "ambiguous", reason: "note_outside_schema" };
    }
    const ocrLines = (text: string): string[] =>
        text
            .replaceAll("\r\n", "\n")
            .replaceAll("\r", "\n")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    const lines = ocrLines(input.text);
    const semanticLines =
        input.ocrSemanticText === undefined ? [] : ocrLines(input.ocrSemanticText);
    if (
        lines.length === 0 ||
        lines.length > MAX_OCR_LINES ||
        lines.some((line) => [...line].length > MAX_OCR_LINE_CHARS) ||
        semanticLines.length > MAX_OCR_LINES ||
        semanticLines.some((line) => [...line].length > MAX_OCR_LINE_CHARS)
    ) {
        return { kind: "ambiguous", reason: "ocr_text_outside_bounds" };
    }
    if (unsupportedCurrencyInSource(input.text, declaration, rules)) {
        return { kind: "ambiguous", reason: "currency_outside_schema" };
    }
    const ocrSemanticSources = [
        input.text,
        ...(input.ocrSemanticText === undefined ? [] : [input.ocrSemanticText]),
    ];
    for (const semanticSource of ocrSemanticSources) {
        const negated = guardedNegatedRuleCue(semanticSource, rules, [
            declaration.kindField,
            declaration.directionField,
        ]);
        if (negated === "overflow") {
            return { kind: "ambiguous", reason: "semantic_evidence_outside_bounds" };
        }
        if (negated) {
            return { kind: "ambiguous", reason: "negated_transaction_semantics" };
        }
    }
    if (messageText !== undefined) {
        const messageNegated = guardedNegatedRuleCue(messageText, rules, [
            declaration.kindField,
            declaration.directionField,
        ]);
        if (messageNegated === "overflow") {
            return { kind: "ambiguous", reason: "semantic_evidence_outside_bounds" };
        }
        if (messageNegated) {
            return { kind: "ambiguous", reason: "negated_transaction_semantics" };
        }
    }
    for (const semanticSource of ocrSemanticSources) {
        const trailingNegatedSemantic = trailingNegatedRuleCue(semanticSource, rules, [
            declaration.kindField,
            declaration.directionField,
        ]);
        if (trailingNegatedSemantic === "overflow") {
            return { kind: "ambiguous", reason: "semantic_evidence_outside_bounds" };
        }
        if (trailingNegatedSemantic) {
            return { kind: "ambiguous", reason: "negated_transaction_semantics" };
        }
    }
    const sourceDates = scanDates(input.text, input.now);
    if (hasSignedOrAccountingMoney(input.text)) {
        return { kind: "ambiguous", reason: "signed_or_accounting_amount" };
    }
    if (hasUncertainNumericExpression(input.text, sourceDates)) {
        return { kind: "ambiguous", reason: "uncertain_numeric_expression" };
    }
    if (hasUntrustedOcrSemanticCue([...lines, ...semanticLines], declaration, rules)) {
        return { kind: "ambiguous", reason: "untrusted_ocr_semantic_cue" };
    }
    const relationshipTextsFrom = (sourceLines: readonly string[]): string[] => {
        const declaredNoteLineIndexes = new Set<number>();
        for (let index = 0; index < sourceLines.length; index++) {
            const labelled = startsWithLabel(sourceLines[index], declaration.noteLabels);
            if (labelled === undefined) continue;
            declaredNoteLineIndexes.add(index);
            if (labelled.rest.length === 0 && index + 1 < sourceLines.length) {
                declaredNoteLineIndexes.add(index + 1);
            }
        }
        return sourceLines
            .filter((_line, index) => !declaredNoteLineIndexes.has(index))
            .map((line) => relationshipEvidence(line, declaration))
            .filter((line): line is string => line !== undefined);
    };
    const relationshipTexts = [
        ...relationshipTextsFrom(lines),
        ...relationshipTextsFrom(semanticLines),
    ];
    const ocrKindMapped = mappedValue(rules, declaration.kindField, relationshipTexts);
    const ocrDirectionMapped = mappedValue(rules, declaration.directionField, relationshipTexts);
    const messageKindMapped =
        messageText === undefined
            ? ({ kind: "none" } as const)
            : mappedValue(rules, declaration.kindField, [messageText]);
    const messageDirectionMapped =
        messageText === undefined
            ? ({ kind: "none" } as const)
            : mappedValue(rules, declaration.directionField, [messageText]);
    if (ocrKindMapped.kind === "ambiguous" || ocrDirectionMapped.kind === "ambiguous") {
        return { kind: "ambiguous", reason: "conflicting_ocr_relationship" };
    }
    if (messageKindMapped.kind === "ambiguous" || messageDirectionMapped.kind === "ambiguous") {
        return { kind: "ambiguous", reason: "conflicting_ocr_and_message_semantics" };
    }
    const kindMapped = mergeMappedEvidence(ocrKindMapped, messageKindMapped);
    const directionMapped = mergeMappedEvidence(ocrDirectionMapped, messageDirectionMapped);
    if (
        messageText !== undefined &&
        (kindMapped.kind === "ambiguous" || directionMapped.kind === "ambiguous")
    ) {
        return { kind: "ambiguous", reason: "conflicting_ocr_and_message_semantics" };
    }
    const kind = mappedOrFallback(
        kindMapped,
        { kind: "none" },
        declaration.requireOcrEvidenceFields.has(declaration.kindField)
            ? undefined
            : declaration.fallbackKind,
        declaration.allowedKinds,
    );
    const direction = mappedOrFallback(
        directionMapped,
        { kind: "none" },
        // Unlike the ordinary property default used by typed input, an OCR fallback must be an
        // explicit parser-extension policy. Apps that omit it retain fail-closed image behavior.
        declaration.requireOcrEvidenceFields.has(declaration.directionField)
            ? undefined
            : declaration.ocrDefaultDirection,
        declaration.allowedDirections,
    );
    if (kind === "ambiguous" || direction === "ambiguous") {
        return { kind: "ambiguous", reason: "conflicting_ocr_relationship" };
    }
    if (direction === undefined) {
        return { kind: "ambiguous", reason: "missing_ocr_direction" };
    }
    if (kind === undefined) {
        return { kind: "none", reason: "missing_transaction_semantics" };
    }

    const authoritative: { index: number; money: { amount: number; currency?: string } }[] = [];
    for (let index = 0; index < lines.length; index++) {
        const parsed = parseAuthoritativeOcrMoney(lines, index, declaration, rules);
        if (parsed === undefined) continue;
        if (parsed === "invalid") {
            return { kind: "ambiguous", reason: "invalid_authoritative_amount" };
        }
        authoritative.push(parsed);
    }
    let chosen: { index: number; money: { amount: number; currency?: string } } | undefined;
    if (authoritative.length > 0) {
        if (authoritative.some((entry) => !sameMoney(entry.money, authoritative[0].money))) {
            return { kind: "ambiguous", reason: "conflicting_authoritative_amounts" };
        }
        chosen = authoritative[0];
    } else {
        const monetaryLines: { index: number; money: { amount: number; currency?: string } }[] = [];
        for (let index = 0; index < lines.length; index++) {
            const parsed = parseOcrMoneyLine(lines[index], declaration, rules);
            if (parsed !== undefined && parsed !== "invalid" && parsed.currency !== undefined) {
                monetaryLines.push({ index, money: parsed });
            }
        }
        if (monetaryLines.length !== 1) {
            return {
                kind: monetaryLines.length === 0 ? "none" : "ambiguous",
                reason:
                    monetaryLines.length === 0
                        ? "no_grounded_monetary_amount"
                        : "multiple_unlabelled_amounts",
            };
        }
        chosen = monetaryLines[0];
    }

    let date: string | undefined;
    if (declaration.dateEnabled) {
        const labelledDates: string[] = [];
        for (const line of lines) {
            const labelled = startsWithLabel(line, declaration.dateLabels);
            if (labelled === undefined) continue;
            const scan = scanDates(labelled.rest, input.now);
            if (scan.invalid || scan.values.length !== 1) {
                return { kind: "ambiguous", reason: "invalid_labelled_date" };
            }
            labelledDates.push(scan.values[0]);
        }
        const values = labelledDates.length
            ? [...new Set(labelledDates)]
            : [...new Set(lines.flatMap((line) => scanDates(line, input.now).values))];
        if (values.length > 1) return { kind: "ambiguous", reason: "conflicting_source_dates" };
        date = values[0];
    }

    const note =
        messageText ??
        noteFromOcr(
            lines,
            chosen.index,
            chosen.money,
            declaration,
            rules,
            authoritative.length > 0,
        );
    if (note === "ambiguous") return { kind: "ambiguous", reason: "note_outside_schema" };
    const candidate: Record<string, unknown> = {
        [declaration.amountField]: chosen.money.amount,
        [declaration.kindField]: kind,
        [declaration.directionField]: direction,
    };
    if (chosen.money.currency !== undefined) {
        candidate[declaration.currencyField] = chosen.money.currency;
    }
    if (date !== undefined) candidate[declaration.dateField] = date;
    if (note !== undefined) candidate[declaration.noteField] = note;
    return { kind: "candidates", candidates: [candidate] };
}

/**
 * Parse typed or OCR text under an app-declared schema policy. Invalid/missing opt-ins return
 * `none`; uncertainty about a present transaction returns `ambiguous`. The function performs no
 * I/O and is suitable for a Web Worker or the ordinary OpenChat action pipeline.
 */
export function parseSourceGroundedTransactions(
    responseSchema: object | undefined,
    rules: readonly unknown[],
    input: SourceGroundedTransactionInput,
): SourceGroundedParseResult {
    const declaration = declaredParser(responseSchema);
    if (declaration === undefined) return { kind: "none", reason: "schema_not_opted_in" };
    if (
        typeof input.text !== "string" ||
        input.text.trim().length === 0 ||
        input.text.length > MAX_SOURCE_CHARS ||
        input.text.includes("\0")
    ) {
        return { kind: "none", reason: "source_text_outside_bounds" };
    }
    if (
        input.messageText !== undefined &&
        (typeof input.messageText !== "string" ||
            input.messageText.length > MAX_SOURCE_CHARS ||
            input.messageText.includes("\0"))
    ) {
        return { kind: "ambiguous", reason: "message_text_outside_bounds" };
    }
    if (
        input.ocrSemanticText !== undefined &&
        (input.source !== "ocr" ||
            typeof input.ocrSemanticText !== "string" ||
            input.ocrSemanticText.length > MAX_SOURCE_CHARS ||
            input.ocrSemanticText.includes("\0"))
    ) {
        return { kind: "ambiguous", reason: "ocr_semantic_text_outside_bounds" };
    }
    if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
        return { kind: "ambiguous", reason: "invalid_calendar_anchor" };
    }
    return input.source === "ocr"
        ? parseOcr(declaration, rules, input)
        : parseTyped(declaration, responseSchema, rules, input);
}

/** True only when the response schema contains a complete, bounded and internally valid opt-in. */
export function supportsSourceGroundedTransactions(responseSchema: object | undefined): boolean {
    return declaredParser(responseSchema) !== undefined;
}

/**
 * Read the exact, bounded browser image invocation policy declared by an app. Unknown versions,
 * modes, extra keys, or a missing/invalid source-grounded fallback fail closed. The returned value
 * is host-owned rather than a reference to the untrusted manifest object.
 */
export function browserImageStrategy(
    responseSchema: object | undefined,
): BrowserImageStrategy | undefined {
    if (!isRecord(responseSchema) || declaredParser(responseSchema) === undefined) return undefined;
    const raw = responseSchema[BROWSER_IMAGE_STRATEGY_EXTENSION];
    if (!isRecord(raw)) return undefined;
    const allowedKeys = new Set(["version", "primary", "requireAcceleration", "fallback"]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return undefined;
    if (
        raw.version !== 1 ||
        raw.primary !== "selected_model" ||
        raw.requireAcceleration !== true ||
        raw.fallback !== "source_grounded"
    ) {
        return undefined;
    }
    return {
        version: 1,
        primary: "selected_model",
        requireAcceleration: true,
        fallback: "source_grounded",
    };
}
