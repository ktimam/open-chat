import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  CURRENT_FORMAT_BASE,
  CURRENT_FORMAT_EDIT_ALGORITHM,
  createCurrentFormattingReview,
  formattingEditSha256s,
  formatCurrentSource,
  readCurrentFormattingRegistry,
} from "./frontend_format_current.mjs";
import {
  createInheritedFormattingChecker,
  inheritedFormattingDigest as digest,
} from "./frontend_format_inherited.mjs";
import { candidateFormattingPaths } from "./frontend_format_check.mjs";
import { ownedSecurityRules } from "./security_owned_rules.mjs";
import {
  checkCurrentClientFormat,
  currentFormattingCandidates,
  parseCurrentFormatArgs,
} from "./check_current_client_format.mjs";

function fixture() {
  const baseSource = "const inherited = 1;   \n";
  const candidateSource = baseSource + "const added = true;\n";
  const configSource = '{ "tabWidth": 4 }\n';
  const format = (_path, source) => source.replaceAll(";   \n", ";\n");
  const record = {
    scope: "current-client",
    path: "frontend/app/fixture.ts",
    baseCommit: CURRENT_FORMAT_BASE,
    baseSha256: digest(baseSource),
    candidateSha256: digest(candidateSource),
    justification:
      "Exact upstream trailing whitespace; added code is formatted.",
    formatter: {
      prettierVersion: "3.8.4",
      sveltePluginVersion: "3.5.2",
      configSha256: digest(configSource),
    },
    proof: {
      baseEditSha256s: formattingEditSha256s(
        baseSource,
        format("", baseSource),
      ),
      candidateEditSha256s: formattingEditSha256s(
        candidateSource,
        format("", candidateSource),
      ),
    },
  };
  return {
    registry: {
      schemaVersion: 1,
      normalization: "CRLF-to-LF-only",
      editAlgorithm: CURRENT_FORMAT_EDIT_ALGORITHM,
      records: [record],
    },
    input: {
      scope: record.scope,
      path: record.path,
      baseCommit: CURRENT_FORMAT_BASE,
      baseSource,
      candidateSource,
      formatter: { ...record.formatter, configSource },
    },
    format,
  };
}

test("current formatting follows the reviewed merged upstream without new exemptions", () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL("../.github/unofficial-client-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(CURRENT_FORMAT_BASE, "319fb436857f35f61e12a9d47bebf6ddb0a72307");
  assert.equal(baseline.upstreamCommit, CURRENT_FORMAT_BASE);
  assert.equal(
    baseline.backendTree,
    "74b32ad8a9f39a5dc60e56461db767f85026039c",
  );
  assert.equal(
    baseline.rootCargoManifest,
    "51db681d6f959e7362a213bfa27b03e9a3595ea6",
  );
  assert(
    readCurrentFormattingRegistry().records.every(
      (record) => record.baseCommit === CURRENT_FORMAT_BASE,
    ),
  );
  assert.equal(readCurrentFormattingRegistry().records.length, 10);
});

test("current review regenerates exact edit proof after all identity checks", () => {
  const { registry, input, format } = fixture();
  const seen = [];
  const check = createCurrentFormattingReview(registry, (path, source) => {
    seen.push([path, source]);
    return format(path, source);
  });
  const result = check(input);
  assert.equal(result.accepted, true);
  assert.equal(result.liveProofVerified, true);
  assert.equal(result.reviewId, "current-client:frontend/app/fixture.ts");
  assert.deepEqual(seen, [
    [input.path, input.baseSource],
    [input.path, input.candidateSource],
  ]);
  assert.throws(
    () => createInheritedFormattingChecker(registry),
    /scope\/path/,
  );
});

for (const [label, mutate] of [
  ["path", (input) => (input.path = "frontend/app/other.ts")],
  ["scope", (input) => (input.scope = "pr2")],
  ["base", (input) => (input.baseCommit = "d".repeat(40))],
  ["base content", (input) => (input.baseSource += "// drift\n")],
  ["candidate content", (input) => (input.candidateSource += "// drift\n")],
  ["formatter version", (input) => (input.formatter.prettierVersion = "3.0.0")],
  [
    "plugin version",
    (input) => (input.formatter.sveltePluginVersion = "3.0.0"),
  ],
  ["config", (input) => (input.formatter.configSource += " ")],
])
  test("current review rejects " + label + " drift before formatting", () => {
    const { registry, input } = fixture();
    mutate(input);
    const check = createCurrentFormattingReview(registry, () => {
      throw Error("Must reject identity first");
    });
    assert.equal(check(input).accepted, false);
  });

test("old baselines, unknown algorithms and forged or duplicate edit proofs fail closed", () => {
  const { registry, input, format } = fixture();
  const old = structuredClone(registry);
  old.records[0].baseCommit = "d".repeat(40);
  assert.throws(
    () => createCurrentFormattingReview(old, format),
    /current upstream/,
  );
  const algorithm = structuredClone(registry);
  algorithm.editAlgorithm = "ignore-whitespace";
  assert.throws(
    () => createCurrentFormattingReview(algorithm, format),
    /edit algorithm/,
  );
  const fake = structuredClone(registry);
  fake.records[0].proof.baseEditSha256s = ["a".repeat(64)];
  fake.records[0].proof.candidateEditSha256s = ["a".repeat(64)];
  assert.equal(
    createCurrentFormattingReview(fake, format)(input).reason,
    "live-formatter-proof-drift",
  );
  const duplicate = structuredClone(registry);
  duplicate.records[0].proof.candidateEditSha256s.push(
    duplicate.records[0].proof.candidateEditSha256s[0],
  );
  assert.throws(
    () => createCurrentFormattingReview(duplicate, format),
    /not all inherited/,
  );
});

test("refreshing only a source hash cannot exempt unformatted fork content", () => {
  const { registry, input, format } = fixture();
  input.candidateSource += "const fork = false;   \n";
  registry.records[0].candidateSha256 = digest(input.candidateSource);
  assert.equal(
    createCurrentFormattingReview(registry, format)(input).reason,
    "live-formatter-proof-drift",
  );
});

test("repeated identical closing lines cannot split an inherited declaration differently", () => {
  const declaration = [
    "export const accounts = new Store(",
    "    keys.accounts,",
    "    false,",
    ");",
  ].join("\n");
  const formatted = "export const accounts = new Store(keys.accounts, false);";
  const prefix =
    "export const verification = new Store(\n    keys.verification,\n    false,\n);\n";
  const base = prefix + declaration + "\nexport const next = true;\n";
  const candidate = "export const fork = true;\n" + base;
  const exact = digest(JSON.stringify([declaration.split("\n"), [formatted]]));
  assert.deepEqual(
    formattingEditSha256s(base, base.replace(declaration, formatted)),
    [exact],
  );
  assert.deepEqual(
    formattingEditSha256s(candidate, candidate.replace(declaration, formatted)),
    [exact],
  );
  assert.notDeepEqual(
    formattingEditSha256s(
      candidate,
      candidate
        .replace(declaration, formatted)
        .replace("fork = true", "fork = false"),
    ),
    [exact],
  );
  assert.deepEqual(
    formattingEditSha256s(
      base.replaceAll("\n", "\r\n"),
      base.replace(declaration, formatted),
    ),
    [exact],
  );
  assert.notDeepEqual(formattingEditSha256s("a\rb\n", "a\nb\n"), []);
});

test("current proof CLI is bounded, read-only and rejects subprocess failures", () => {
  let call;
  const execute = (...args) => {
    call = args;
    return {
      status: 0,
      stdout: "const a = 1;\n",
      stderr: "[warn] svelteBracketNewLine is deprecated.\n",
    };
  };
  assert.equal(
    formatCurrentSource(
      "frontend",
      "frontend/app/a.ts",
      "const a = 1;\r\n",
      execute,
    ),
    "const a = 1;\n",
  );
  assert.equal(call[0], process.execPath);
  assert(call[1].includes("--stdin-filepath"));
  assert(call[1].includes("--end-of-line=lf"));
  assert(!call[1].includes("--write"));
  assert.equal(call[2].shell, undefined);
  assert.equal(call[2].input, "const a = 1;\n");
  for (const result of [
    { status: 1 },
    { status: 2 },
    { status: null },
    { status: 0, signal: "SIGTERM" },
    { status: 0, error: new Error("spawn") },
    { status: 0, stdout: "x", stderr: "unknown warning" },
  ])
    assert.throws(
      () =>
        formatCurrentSource("frontend", "frontend/app/a.ts", "x", () => result),
      /proof CLI failed/,
    );
});

test("entry point requires explicit current scope and rejects write or bypass flags", () => {
  parseCurrentFormatArgs(["--scope", "current-client"]);
  for (const args of [
    [],
    ["format"],
    ["--scope", "pr1"],
    ["--scope", "current-client", "--write"],
    ["--scope", "current-client", "--skip-proof"],
  ])
    assert.throws(() => parseCurrentFormatArgs(args), /Usage/);
});

test("candidate filtering retains exactly the existing owned frontend rules", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const policy = ownedSecurityRules("pr1").format;
  const changed = candidateFormattingPaths({
    root,
    comparisonBase: CURRENT_FORMAT_BASE,
  });
  const expected = changed.filter(
    (path) =>
      path.startsWith(policy.sourceRoot) &&
      policy.extensions.includes(extname(path).toLowerCase()) &&
      !Object.hasOwn(policy.excludedFiles, path) &&
      !Object.keys(policy.excludedPrefixes).some((prefix) =>
        path.startsWith(prefix),
      ),
  );
  assert.deepEqual(
    currentFormattingCandidates(root, CURRENT_FORMAT_BASE).paths,
    expected,
  );
});

test("restored desktop onboarding and main Apps menu are normally formatted without inherited exemptions", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const registry = readCurrentFormattingRegistry();
  for (const path of [
    "frontend/app/src/components/onboard/OnboardModal.svelte",
    "frontend/app/src/components/home/nav/MainMenu.svelte",
  ]) {
    assert.equal(
      registry.records.some((record) => record.path === path),
      false,
    );
    assert(
      currentFormattingCandidates(root, CURRENT_FORMAT_BASE).paths.includes(
        path,
      ),
    );
    const source = readFileSync(resolve(root, path), "utf8");
    assert.equal(
      formatCurrentSource(resolve(root, "frontend"), path, source),
      source.replaceAll("\r\n", "\n"),
    );
  }
});

test(
  "live Git and installed CLI regenerate every remaining mismatch, including prior historical records",
  { timeout: 120000 },
  () => {
    const registry = readCurrentFormattingRegistry();
    assert.equal(registry.records.length, 10);
    const result = checkCurrentClientFormat({ report: () => {} });
    assert.deepEqual(result.failures, []);
    assert.equal(result.pass, true);
    assert.deepEqual(
      [...result.liveReviewedPaths].sort(),
      registry.records.map((record) => record.path).sort(),
    );
    assert(
      result.liveReviewedPaths.includes("frontend/app/src/stores/settings.ts"),
    );
    assert.equal(result.advisoryChecksPerformed, false);
    assert.equal(result.releaseAcceptance, false);
    const historical = JSON.parse(
      readFileSync(
        new URL("./frontend_format_inherited.json", import.meta.url),
        "utf8",
      ),
    );
    assert(
      historical.records.every((record) =>
        ["pr1", "pr2"].includes(record.scope),
      ),
    );
  },
);
