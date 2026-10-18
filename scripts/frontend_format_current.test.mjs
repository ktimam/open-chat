import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  CURRENT_FORMAT_BASE,
  CURRENT_FORMAT_COMPARISON_BASE,
  CURRENT_FORMAT_MERGED_BASES,
  CURRENT_FORMAT_RECONCILED_BASES,
  CURRENT_FORMAT_EDIT_ALGORITHM,
  createCurrentFormattingReview,
  formattingEditSha256s,
  formatCurrentSource,
  readCurrentFormattingRegistry,
  readHistoricalCurrentFormattingRegistry,
  mergeCurrentFormattingRegistries,
} from "./frontend_format_current.mjs";
import {
  createInheritedFormattingChecker,
  createCurrentInheritedFormattingChecker,
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
  assert.equal(CURRENT_FORMAT_BASE, "65e265f027cc50a1ea333dd94acbb7816992b54c");
  assert.equal(
    CURRENT_FORMAT_COMPARISON_BASE,
    "11ed95078e3ae8ae76bf2bdc094dd57b47459622",
  );
  assert.equal(baseline.upstreamCommit, CURRENT_FORMAT_COMPARISON_BASE);
  assert.equal(
    baseline.backendTree,
    "cb12926c739947d9c9a76cc313704afafb8cfaa6",
  );
  assert.equal(
    baseline.rootCargoManifest,
    "af1c2225f8dca4d68da027bfe96513f5bc8ca8a3",
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("merge-base", "--is-ancestor", CURRENT_FORMAT_COMPARISON_BASE, "HEAD");
  assert.equal(
    git("rev-parse", `${CURRENT_FORMAT_COMPARISON_BASE}:backend`),
    baseline.backendTree,
  );
  assert.equal(
    git("rev-parse", `${CURRENT_FORMAT_COMPARISON_BASE}:Cargo.toml`),
    baseline.rootCargoManifest,
  );
  assert(
    readHistoricalCurrentFormattingRegistry().records.every(
      (record) =>
        record.baseCommit ===
        (CURRENT_FORMAT_MERGED_BASES[record.path] ?? CURRENT_FORMAT_BASE),
    ),
  );
  assert.equal(readHistoricalCurrentFormattingRegistry().records.length, 14);
});

test("0519 merge adds only four exact upstream identities and retains all older reviews", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (object) =>
    execFileSync("git", ["show", object], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const before = JSON.parse(
    git(
      "08f8cf846fccddaa7f4ea7cdcd064616beee41a7:scripts/frontend_format_current.json",
    ),
  );
  const current = readHistoricalCurrentFormattingRegistry();
  const reconciled = JSON.parse(
    readFileSync(
      new URL("./frontend_format_current_upstream.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(current.records.slice(0, 10), before.records);
  assert.deepEqual(
    Object.keys(CURRENT_FORMAT_MERGED_BASES).sort(),
    [
      "frontend/app/src/components/home/Home.svelte",
      "frontend/app/src/components/home/MessageEntry.spec.harness.svelte",
      "frontend/app/src/components_shared/RichTextEditor.svelte",
      "frontend/openchat-agent/src/services/localUserIndex/localUserIndex.client.ts",
    ].sort(),
  );
  assert.equal(current.records.slice(10).length, 4);
  for (const record of current.records.slice(10)) {
    assert.equal(record.baseCommit, "0519aa39964a34d165173587b4d63e572c89670d");
    assert.equal(CURRENT_FORMAT_MERGED_BASES[record.path], record.baseCommit);
    assert.equal(
      digest(git(`${record.baseCommit}:${record.path}`)),
      record.baseSha256,
    );
    assert.equal(record.candidateSha256, record.baseSha256);
    assert.equal(
      digest(git(`232cd0d9cc3065dbdc26d84c8470d5eba57f666b:${record.path}`)),
      record.baseSha256,
    );
    assert.equal(record.proof.baseEditSha256s.length, 1);
    assert.deepEqual(
      record.proof.candidateEditSha256s,
      record.proof.baseEditSha256s,
    );
    const wrongPath = structuredClone(current);
    wrongPath.records.find((r) => r.path === record.path).path += ".unreviewed";
    assert.throws(
      () =>
        createCurrentFormattingReview(
          mergeCurrentFormattingRegistries(wrongPath, reconciled),
          () => "",
        ),
      /current upstream/,
    );
    const wrongBase = structuredClone(current);
    wrongBase.records.find((r) => r.path === record.path).baseCommit =
      CURRENT_FORMAT_BASE;
    assert.throws(
      () =>
        createCurrentFormattingReview(
          mergeCurrentFormattingRegistries(wrongBase, reconciled),
          () => "",
        ),
      /current upstream/,
    );
  }
});

test("all fourteen historical proofs retain their exact checkpoint bytes and live formatter edits", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const frontend = resolve(root, "frontend");
  const git = (object) =>
    execFileSync("git", ["show", object], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const historical = readHistoricalCurrentFormattingRegistry();
  const checkpoint = "232cd0d9cc3065dbdc26d84c8470d5eba57f666b";
  assert.deepEqual(
    historical,
    JSON.parse(git(`${checkpoint}:scripts/frontend_format_current.json`)),
  );
  assert.equal(historical.records.length, 14);
  const check = createCurrentInheritedFormattingChecker(historical);
  const version = (name) =>
    JSON.parse(
      readFileSync(
        resolve(frontend, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
  for (const record of historical.records) {
    const baseSource = git(`${record.baseCommit}:${record.path}`);
    const candidateSource = git(`${checkpoint}:${record.path}`);
    const input = {
      scope: record.scope,
      path: record.path,
      baseCommit: record.baseCommit,
      baseSource,
      candidateSource,
      formatter: {
        prettierVersion: version("prettier"),
        sveltePluginVersion: version("prettier-plugin-svelte"),
        configSource: readFileSync(resolve(frontend, ".prettierrc"), "utf8"),
      },
    };
    assert.equal(check(input).accepted, true, record.path);
    assert.deepEqual(
      formattingEditSha256s(
        baseSource,
        formatCurrentSource(frontend, record.path, baseSource),
      ),
      record.proof.baseEditSha256s,
    );
    assert.deepEqual(
      formattingEditSha256s(
        candidateSource,
        formatCurrentSource(frontend, record.path, candidateSource),
      ),
      record.proof.candidateEditSha256s,
    );
  }
});

test("reconciled proofs are exact, complete and reject missing, changed or repeated evidence", () => {
  const historical = readHistoricalCurrentFormattingRegistry();
  const reconciled = JSON.parse(
    readFileSync(
      new URL("./frontend_format_current_upstream.json", import.meta.url),
      "utf8",
    ),
  );
  const combined = mergeCurrentFormattingRegistries(historical, reconciled);
  assert.equal(reconciled.records.length, 12);
  assert.equal(combined.records.length, 21);
  assert.deepEqual(
    reconciled.records.map((record) => record.path).sort(),
    Object.keys(CURRENT_FORMAT_RECONCILED_BASES).sort(),
  );
  for (const mutate of [
    (registry) => registry.records.pop(),
    (registry) => registry.records.push(structuredClone(registry.records[0])),
    (registry) => (registry.records[0].path += ".unreviewed"),
    (registry) => (registry.records[0].baseCommit = CURRENT_FORMAT_BASE),
  ]) {
    const changed = structuredClone(reconciled);
    mutate(changed);
    assert.throws(() => mergeCurrentFormattingRegistries(historical, changed));
  }
  const missing = structuredClone(combined);
  delete missing.records.at(-1).proof;
  assert.throws(() => createCurrentFormattingReview(missing, () => ""));
  const repeated = structuredClone(combined);
  const repeatedRecord = repeated.records.find(
    (record) => record.path === reconciled.records[0].path,
  );
  repeatedRecord.proof.candidateEditSha256s.push(
    ...repeatedRecord.proof.baseEditSha256s,
  );
  assert.throws(
    () => createCurrentFormattingReview(repeated, () => ""),
    /not all inherited/,
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const record = reconciled.records[0];
  const input = {
    scope: record.scope,
    path: record.path,
    baseCommit: record.baseCommit,
    baseSource: execFileSync(
      "git",
      ["show", `${record.baseCommit}:${record.path}`],
      { cwd: root, encoding: "utf8" },
    ),
    candidateSource: readFileSync(resolve(root, record.path), "utf8"),
    formatter: {
      ...record.formatter,
      configSource: readFileSync(resolve(root, "frontend/.prettierrc"), "utf8"),
    },
  };
  for (const mutate of [
    (value) => (value.candidateSource += "// changed\n"),
    (value) => (value.baseSource += "// changed\n"),
    (value) => (value.baseCommit = CURRENT_FORMAT_BASE),
    (value) => (value.formatter.prettierVersion = "0.0.0"),
    (value) => (value.formatter.sveltePluginVersion = "0.0.0"),
    (value) => (value.formatter.configSource += " "),
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.equal(
      createCurrentFormattingReview(combined, () => {
        throw Error("identity must reject first");
      })(changed).accepted,
      false,
    );
  }
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
    comparisonBase: CURRENT_FORMAT_COMPARISON_BASE,
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
    currentFormattingCandidates(root, CURRENT_FORMAT_COMPARISON_BASE).paths,
    expected,
  );
});

test("the integrated upstream comparison retains every fork-modified candidate and drops only upstream-identical paths", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  const policy = ownedSecurityRules("pr1").format;
  const owned = (path) =>
    path.startsWith(policy.sourceRoot) &&
    policy.extensions.includes(extname(path).toLowerCase()) &&
    !Object.hasOwn(policy.excludedFiles, path) &&
    !Object.keys(policy.excludedPrefixes).some((prefix) =>
      path.startsWith(prefix),
    );
  const allForkChanges = new Set([
    ...git(
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
      "-z",
      CURRENT_FORMAT_COMPARISON_BASE,
      "--",
    ),
    ...git("ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const actual = currentFormattingCandidates(
    root,
    CURRENT_FORMAT_COMPARISON_BASE,
  ).paths;
  assert.deepEqual(actual, [...allForkChanges].filter(owned).sort());
  assert(actual.includes("frontend/app/src/utils/localAppSetupCode.ts"));
  assert(
    actual.includes("frontend/app/src/utils/transformersWebGpuInference.ts"),
  );
  assert(actual.includes("frontend/app/src/utils/privateAppWorkspace.ts"));
  const previous = currentFormattingCandidates(root, CURRENT_FORMAT_BASE).paths;
  const removed = previous.filter((path) => !actual.includes(path));
  assert(
    removed.length > 0,
    "upstream-only changes must not become fork formatting work",
  );
  assert(
    removed.every((path) => !allForkChanges.has(path)),
    "a fork-modified path was lost",
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
      currentFormattingCandidates(
        root,
        CURRENT_FORMAT_COMPARISON_BASE,
      ).paths.includes(path),
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
    assert.equal(registry.records.length, 21);
    const result = checkCurrentClientFormat({ report: () => {} });
    assert.deepEqual(result.failures, []);
    assert.equal(result.pass, true);
    assert.equal(result.comparisonBase, CURRENT_FORMAT_COMPARISON_BASE);
    assert.equal(result.inheritedBase, CURRENT_FORMAT_BASE);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const frontend = resolve(root, "frontend");
    const candidatePaths = new Set(
      currentFormattingCandidates(root, CURRENT_FORMAT_COMPARISON_BASE).paths,
    );
    // Historical proof regeneration above remains mandatory. Current upstream-only
    // files (including upstream deletions) are not fork formatting candidates.
    const upstreamOnly = [];
    for (const record of registry.records.filter(
      (entry) => !candidatePaths.has(entry.path),
    )) {
      const upstreamEntry = execFileSync(
        "git",
        ["ls-tree", "-z", CURRENT_FORMAT_COMPARISON_BASE, "--", record.path],
        { cwd: root, encoding: "utf8" },
      );
      if (upstreamEntry === "") {
        assert.equal(
          existsSync(resolve(root, record.path)),
          false,
          "upstream-deleted proof path must remain absent",
        );
      } else {
        assert.equal(
          digest(
            execFileSync(
              "git",
              ["show", `${CURRENT_FORMAT_COMPARISON_BASE}:${record.path}`],
              { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
            ),
          ),
          digest(readFileSync(resolve(root, record.path), "utf8")),
        );
      }
      upstreamOnly.push(record.path);
    }
    const fullyFormatted = registry.records
      .filter(
        (record) =>
          candidatePaths.has(record.path) &&
          !result.liveReviewedPaths.includes(record.path),
      )
      .map((record) => {
        const source = readFileSync(
          resolve(root, record.path),
          "utf8",
        ).replaceAll("\r\n", "\n");
        assert.equal(
          formatCurrentSource(frontend, record.path, source),
          source,
          "a missing live proof must be fully formatted, never silently waived",
        );
        assert(
          readHistoricalCurrentFormattingRegistry().records.some(
            (old) => old.path === record.path,
          ),
        );
        return record.path;
      });
    assert.deepEqual(
      [...result.liveReviewedPaths, ...upstreamOnly, ...fullyFormatted].sort(),
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
