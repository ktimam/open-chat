// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { compileFunction, runInNewContext } from "node:vm";
import replace from "@rollup/plugin-replace";
import { rollup } from "rollup";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { transformersWebGpuFeatureEnabled } from "../../transformersWebGpuFeatureFlag.mjs";

const app = path.resolve(import.meta.dirname, "../..");
const source = fs.readFileSync(path.join(app, "src/utils/transformersWebGpuInference.ts"), "utf8");
const config = fs.readFileSync(path.join(app, "rollup.config.mjs"), "utf8");
const extras = fs.readFileSync(path.join(app, "rollup.extras.mjs"), "utf8");
const featureSource = fs.readFileSync(path.join(app, "transformersWebGpuFeatureFlag.mjs"), "utf8");
const inputs = [
    "OC_BUILD_ENV",
    "OC_DFX_NETWORK",
    "OC_UNOFFICIAL_CLIENT",
    "OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE",
    "OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY",
];

function parsed(text: string) {
    return ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
}

function realFunction(text: string, name: string) {
    const node = parsed(text).statements.find(
        (item): item is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(item) && item.name?.text === name,
    );
    if (!node) throw new Error(`Actual function ${name} was not found`);
    return node.getText().replace(/^export\s+/, "");
}

// Read the real production replacement properties without executing build plugins or IO.
const optionsKeys = new Set([
    "preventAssignment",
    "import.meta.env",
    ...inputs.map((key) => `import.meta.env.${key}`),
]);
let replacementProperties: ts.ObjectLiteralElementLike[] | undefined;
function findReplace(node: ts.Node) {
    if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "replace" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
    ) {
        replacementProperties = [...node.arguments[0].properties];
    }
    ts.forEachChild(node, findReplace);
}
findReplace(parsed(config));
if (!replacementProperties) throw new Error("Production replace plugin was not found");
const selectedProperties = replacementProperties.filter(
    (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) &&
        optionsKeys.has(property.name.text),
);
const replacementFactory = compileFunction(
    `${realFunction(extras, "maybeStringify")}
    const transformersWebGpuSpikeEnabled = transformersWebGpuFeatureEnabled(environment);
    const explicitTransformersWebGpuFlag = JSON.stringify(transformersWebGpuSpikeEnabled ? "true" : "false");
    const process = { env: environment };
    return ({ ${selectedProperties.map((property) => property.getText()).join(",\n")} });`,
    ["environment", "transformersWebGpuFeatureEnabled"],
) as (
    environment: Record<string, string>,
    gate: typeof transformersWebGpuFeatureEnabled,
) => Parameters<typeof replace>[0];

async function optimized(environment: Record<string, string>) {
    const options = replacementFactory(environment, transformersWebGpuFeatureEnabled);
    for (const key of optionsKeys) expect(options).toHaveProperty(key);
    const code = `import { transformersWebGpuFeatureEnabled } from "feature";
        ${realFunction(source, "transformersWebGpuBuildEnvironment")}
        export const environment = transformersWebGpuBuildEnvironment();
        export const enabled = transformersWebGpuFeatureEnabled(environment);`;
    const bundle = await rollup({
        input: "entry",
        plugins: [
            {
                name: "actual-admission-source",
                // Use ordinary JS IDs: plugin-replace intentionally ignores null-byte virtual IDs.
                resolveId(id) {
                    return id === "entry" || id === "feature" ? `/admission-${id}.js` : null;
                },
                load(id) {
                    return id === "/admission-entry.js"
                        ? code
                        : id === "/admission-feature.js"
                          ? featureSource
                          : null;
                },
            },
            replace(options),
        ],
    });
    try {
        const result = await bundle.generate({ format: "cjs", exports: "named" });
        const built = result.output[0];
        if (built.type !== "chunk") throw new Error("Expected generated admission code");
        expect(built.code).not.toContain("import.meta.env");
        const output = { exports: {} as { environment: Record<string, string>; enabled: boolean } };
        runInNewContext(built.code, output);
        return output.exports;
    } finally {
        await bundle.close();
    }
}

const local = {
    OC_BUILD_ENV: "development",
    OC_DFX_NETWORK: "ic",
    OC_UNOFFICIAL_CLIENT: "true",
    OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true",
    OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "immutable-hub-v1",
};

describe("optimized Rollup WebGPU admission", () => {
    it.each(["web", "android"])(
        "preserves immutable delivery for the local %s profile",
        async (appType) => {
            const result = await optimized({ ...local, OC_APP_TYPE: appType });
            expect(result.environment.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY).toBe(
                "immutable-hub-v1",
            );
            expect(result.enabled).toBe(true);
        },
    );
    it("preserves the explicitly qualified official production gate", async () => {
        const result = await optimized({
            ...local,
            OC_BUILD_ENV: "production",
            OC_UNOFFICIAL_CLIENT: "false",
        });
        expect(result.enabled).toBe(true);
    });
    it.each([
        { OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "false" },
        { OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "" },
        { OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "unverified" },
        { OC_UNOFFICIAL_CLIENT: "false" },
        { OC_DFX_NETWORK: "other" },
        { OC_BUILD_ENV: "production", OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "" },
    ])("retains fail-closed profile rules for %j", async (override) => {
        expect((await optimized({ ...local, ...override })).enabled).toBe(false);
    });
});
