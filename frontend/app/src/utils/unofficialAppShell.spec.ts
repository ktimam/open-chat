import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type AST } from "svelte/compiler";
import { describe, expect, it } from "vitest";

type Node = AST.Fragment["nodes"][number];
type State = Record<string, unknown>;
const guardedComponents = ["StartupFailure", "Reload", "Router"];
const allowedIdentities = ["anon", "logging_in", "registering", "logged_in", "loading_user"];
const ready: State = {
    $startupErrorStore: undefined,
    $identityStateStore: { kind: "logged_in" },
    $localeLoadFailed: false,
    $locale: "en",
    $isLoading: false,
    $reviewingTranslations: false,
};

function children(node: Node): readonly Node[] {
    if (node.type === "IfBlock")
        return [...node.consequent.nodes, ...(node.alternate?.nodes ?? [])];
    if (node.type === "AwaitBlock")
        return [
            ...(node.pending?.nodes ?? []),
            ...(node.then?.nodes ?? []),
            ...(node.catch?.nodes ?? []),
        ];
    if (node.type === "SnippetBlock") return node.body.nodes;
    if (node.type === "EachBlock") return [...node.body.nodes, ...(node.fallback?.nodes ?? [])];
    return "fragment" in node ? node.fragment.nodes : [];
}

function descendants(nodes: readonly Node[]): Node[] {
    return nodes.flatMap((node) => [node, ...descendants(children(node))]);
}

/** Only interpret the actual shell's side-effect-free render predicates, never its script. */
function evaluate(expression: AST.IfBlock["test"], state: State): unknown {
    switch (expression.type) {
        case "Identifier":
            if (expression.name === "undefined") return undefined;
            if (Object.hasOwn(state, expression.name)) return state[expression.name];
            throw new Error(`Unknown shell state: ${expression.name}`);
        case "Literal":
            return expression.value;
        case "MemberExpression": {
            if (
                expression.computed ||
                expression.property.type !== "Identifier" ||
                expression.object.type === "Super"
            )
                break;
            const value = evaluate(expression.object, state);
            if (
                value &&
                typeof value === "object" &&
                Object.hasOwn(value, expression.property.name)
            )
                return (value as Record<string, unknown>)[expression.property.name];
            throw new Error("Unknown shell state member");
        }
        case "BinaryExpression":
            if (expression.left.type === "PrivateIdentifier") break;
            if (expression.operator === "===")
                return evaluate(expression.left, state) === evaluate(expression.right, state);
            if (expression.operator === "!==")
                return evaluate(expression.left, state) !== evaluate(expression.right, state);
            break;
        case "LogicalExpression":
            if (expression.operator === "||")
                return evaluate(expression.left, state) || evaluate(expression.right, state);
            if (expression.operator === "&&")
                return evaluate(expression.left, state) && evaluate(expression.right, state);
            break;
        case "UnaryExpression":
            if (expression.operator === "!") return !evaluate(expression.argument, state);
    }
    throw new Error(`Unsupported shell predicate: ${expression.type}`);
}

function visible(nodes: readonly Node[], state: State): string[] {
    return nodes.flatMap((node) => {
        if (node.type === "IfBlock") {
            const selected = evaluate(node.test, state) ? node.consequent : node.alternate;
            return visible(selected?.nodes ?? [], state);
        }
        if (node.type === "Component") return [node.name];
        if (node.type === "Text" || node.type === "Comment") return [];
        // A new control-flow construct must be consciously supported, not silently skipped.
        throw new Error(`Unsupported startup template node: ${node.type}`);
    });
}

function shell(layout: "desktop" | "mobile") {
    const folder = layout === "desktop" ? "components" : "components_mobile";
    const file = resolve(process.cwd(), `app/src/${folder}/App.svelte`);
    const root = parse(readFileSync(file, "utf8"), { filename: file, modern: true });
    const boundaries = root.fragment.nodes.filter((node) => node.type === "SvelteBoundary");
    expect(boundaries).toHaveLength(1);
    const candidates = boundaries[0].fragment.nodes.filter(
        (node): node is AST.IfBlock =>
            node.type === "IfBlock" &&
            descendants([node]).some(
                (child) => child.type === "Component" && child.name === "StartupFailure",
            ),
    );
    expect(candidates).toHaveLength(1);
    const guard = candidates[0];
    // Check the entire real template: an unguarded duplicate Router/Reload cannot escape
    // this focused evaluation while a dead copy of the correct guard makes tests pass.
    const components = descendants(root.fragment.nodes).filter(
        (node): node is AST.Component =>
            node.type === "Component" && guardedComponents.includes(node.name),
    );
    expect(components.map((node) => node.name)).toEqual(guardedComponents);
    expect(components.every((node) => descendants([guard]).includes(node))).toBe(true);
    for (const [name, source] of [
        ["StartupFailure", "@shared_components/StartupFailure.svelte"],
        ["Reload", "@shared_components/Reload.svelte"],
        ["Router", "./Router.svelte"],
    ]) {
        expect(
            root.instance?.content.body.some(
                (node) =>
                    node.type === "ImportDeclaration" &&
                    node.source.value === source &&
                    node.specifiers.some(
                        (specifier) =>
                            specifier.type === "ImportDefaultSpecifier" &&
                            specifier.local.name === name,
                    ),
            ),
        ).toBe(true);
    }
    return {
        guard,
        render: (overrides: State = {}) => visible([guard], { ...ready, ...overrides }),
    };
}

describe.each(["desktop", "mobile"] as const)("%s unofficial startup shell", (layout) => {
    const actual = shell(layout);

    it.each([...allowedIdentities, "initial", "unknown"])(
        "gives worker failure priority for identity %s",
        (kind) => {
            for (const message of ["Background worker failed", ""]) {
                expect(
                    actual.render({
                        $startupErrorStore: message,
                        $identityStateStore: { kind },
                        $localeLoadFailed: true,
                        $locale: undefined,
                        $isLoading: true,
                        $reviewingTranslations: true,
                    }),
                ).toEqual(["StartupFailure"]);
            }
        },
    );

    it.each(allowedIdentities)(
        "keeps locale recovery and Router behind allowed identity %s",
        (kind) => {
            const identity = { $identityStateStore: { kind } };
            expect(actual.render(identity)).toEqual(["Router"]);
            for (const locale of [undefined, "en"])
                for (const loading of [false, true]) {
                    expect(
                        actual.render({
                            ...identity,
                            $localeLoadFailed: true,
                            $locale: locale,
                            $isLoading: loading,
                            $reviewingTranslations: true,
                        }),
                    ).toEqual(["Reload"]);
                    if (!locale || loading)
                        expect(
                            actual.render({ ...identity, $locale: locale, $isLoading: loading }),
                        ).toEqual([]);
                }
        },
    );

    it.each(["initial", "unknown"])(
        "does not bypass identity %s for locale recovery or translation review",
        (kind) => {
            for (const failed of [false, true])
                for (const reviewing of [false, true]) {
                    expect(
                        actual.render({
                            $identityStateStore: { kind },
                            $localeLoadFailed: failed,
                            $reviewingTranslations: reviewing,
                        }),
                    ).toEqual([]);
                }
        },
    );

    it("preserves the desktop-only translation-review readiness exception", () => {
        for (const kind of allowedIdentities) {
            for (const [locale, loading] of [
                [undefined, false],
                [undefined, true],
                ["en", true],
            ]) {
                expect(
                    actual.render({
                        $identityStateStore: { kind },
                        $locale: locale,
                        $isLoading: loading,
                        $reviewingTranslations: true,
                    }),
                ).toEqual(layout === "desktop" ? ["Router"] : []);
            }
        }
    });

    it("really follows predicate changes rather than recognizing component names", () => {
        const altered = structuredClone(actual.guard);
        altered.test = { type: "Literal", value: false };
        expect(visible([altered], { ...ready, $startupErrorStore: "failure" })).toEqual(["Router"]);
        expect(actual.render({ $startupErrorStore: "failure" })).toEqual(["StartupFailure"]);
        altered.test = { type: "Identifier", name: "$unsupportedState" };
        expect(() => visible([altered], ready)).toThrow("Unknown shell state");
    });
});
