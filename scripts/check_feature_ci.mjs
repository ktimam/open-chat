import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FEATURE_CI_NODE_VERSION = "24.18.1";
export const NPM_FEATURE_CI_TEST_COMMAND =
  "node --test scripts/npm_feature_scope.test.mjs scripts/npm_feature_seed_review.test.mjs scripts/npm_feature_advisories.test.mjs scripts/npm_feature_advisories.review.test.mjs scripts/npm_feature_runtime.test.mjs scripts/check_feature_ci.test.mjs scripts/security_mode_scope.test.mjs scripts/security_owned_rules.test.mjs";
export const npmFeatureQueryCommand = (scope) => {
  assert(
    ["pr1", "pr2", "current-client"].includes(scope),
    "Explicit npm feature scope required",
  );
  return [
    "set -euo pipefail",
    'npm_root="$(npm root --global)"',
    `node scripts/npm_feature_advisories.mjs --repository-root "$GITHUB_WORKSPACE" --scope ${scope} --arborist-path "$npm_root/npm/node_modules/@npmcli/arborist" --output-directory "$RUNNER_TEMP" --mode query-bulk`,
  ].join("\n");
};
export const npmFeatureSmokeCommand = (scope) =>
  npmFeatureQueryCommand(scope)
    .replace(
      "scripts/npm_feature_advisories.mjs",
      "scripts/npm_feature_runtime_smoke.mjs",
    )
    .replace("--mode query-bulk", "--mode plan");
export const OFFLINE_FEATURE_HELPER_TESTS = Object.freeze([
  "scripts/npm_feature_scope.test.mjs",
  "scripts/npm_feature_seed_review.test.mjs",
  "scripts/npm_feature_advisories.test.mjs",
  "scripts/npm_feature_advisories.review.test.mjs",
  "scripts/npm_feature_runtime.test.mjs",
  "scripts/rust_feature_scope.test.mjs",
  "scripts/rust_feature_seed_review.test.mjs",
  "scripts/rust_feature_advisories.test.mjs",
  "scripts/rust_feature_advisory_results.test.mjs",
  "scripts/rust_feature_advisory_runner.test.mjs",
  "scripts/rust_feature_sbom.test.mjs",
  "scripts/rust_feature_sbom_validate.test.mjs",
  "scripts/rust_feature_collection.test.mjs",
  "scripts/rust_feature_ci.test.mjs",
  "scripts/check_feature_ci.test.mjs",
  "scripts/security_mode_scope.test.mjs",
  "scripts/security_owned_rules.test.mjs",
]);
const root = fileURLToPath(new URL("../", import.meta.url));

// Deliberately supports the repository's literal YAML layout, not arbitrary YAML execution.
function block(text, key, indentation) {
  const matches = [
    ...text.matchAll(new RegExp(`^ {${indentation}}${key}:[ \\t]*$`, "gmu")),
  ];
  assert.equal(matches.length, 1, `Expected one ${key} mapping`);
  const rest = text.slice(matches[0].index + matches[0][0].length);
  const end = rest.search(new RegExp(`^ {0,${indentation}}\\S`, "mu"));
  return end < 0 ? rest : rest.slice(0, end);
}

function jobs(text, allowConditionalJobs = false) {
  const value = block(text, "jobs", 0);
  return new Map(
    [...value.matchAll(/^ {2}([a-z0-9-]+):[ \t]*$/gmu)].map(([, name]) => {
      const body = block(value, name, 2);
      if (!allowConditionalJobs)
        assert.doesNotMatch(
          body,
          /^ {4}(?:if|continue-on-error):/mu,
          `Conditional/ignored feature job ${name}`,
        );
      return [name, body];
    }),
  );
}

function steps(job) {
  return block(job, "steps", 4)
    .split(/^ {6}- /mu)
    .slice(1);
}

function runs(step) {
  return [...step.matchAll(/^(?:run:| {8}run:) ([^\n]*)$/gmu)].map((match) => {
    const first = match[1];
    if (!/^[|>][-+]?$/u.test(first)) return first;
    const tail = step
      .slice(match.index + match[0].length)
      .split("\n")
      .slice(1);
    const lines = [];
    for (const line of tail) {
      if (line.trim() && !/^ {10}/u.test(line)) break;
      if (line.trim() && !line.trimStart().startsWith("#"))
        lines.push(line.slice(10));
    }
    return lines.join(first.startsWith(">") ? " " : "\n");
  });
}

function commands(job) {
  return steps(job).flatMap((step) =>
    runs(step).map((command) => ({ step, command })),
  );
}

function requiredCommand(job, predicate, label, condition) {
  const matches = commands(job).filter(({ command }) => predicate(command));
  assert.equal(matches.length, 1, `Expected one executable ${label}`);
  assert.deepEqual(
    [...matches[0].step.matchAll(/^(?:if:| {8}if:)(?: (.*))?$/gmu)].map(
      (m) => m[1],
    ),
    condition === undefined ? [] : [condition],
    `Exact condition required for ${label}`,
  );
  assert.doesNotMatch(
    matches[0].step,
    /^(?:continue-on-error:| {8}continue-on-error:)/mu,
    `Ignored ${label}`,
  );
  assert.doesNotMatch(
    matches[0].command,
    /\|\|\s*true|;\s*(?:true|exit 0)\b/u,
    `Suppressed failure: ${label}`,
  );
  return matches[0].command;
}

export const RUST_FEATURE_FETCH_COMMAND = [
  "set -euo pipefail",
  "rustup toolchain install 1.95.0 --profile minimal",
  'cargo_path="$(rustup which --toolchain 1.95.0 cargo)"',
  'rustc_path="$(rustup which --toolchain 1.95.0 rustc)"',
  'RUSTC="$rustc_path" "$cargo_path" fetch --locked',
].join("\n");
export const rustFeatureCiCommand = (scope) => {
  assert(
    ["pr1", "pr2", "current-client"].includes(scope),
    "Explicit Rust feature scope required",
  );
  return [
    "set -euo pipefail",
    'cargo_path="$(rustup which --toolchain 1.95.0 cargo)"',
    `config_sha256="$(sha256sum scripts/rust_feature_scope.${scope}.json)"`,
    'config_sha256="${config_sha256%% *}"',
    `node scripts/rust_feature_ci.mjs --repository-root "$GITHUB_WORKSPACE" --scope ${scope} --config-sha256 "$config_sha256" --output-directory "$RUNNER_TEMP" --cargo-executable "$cargo_path" --mode check-scoped`,
  ].join("\n");
};
export const RUST_FEATURE_REPORT_PATHS = Object.freeze([
  "rust-feature-ci-*/summary.json",
  "rust-feature-ci-*/rust-feature-collection-*/summary.json",
  "rust-feature-ci-*/rust-feature-collection-*/collection.json",
  "rust-feature-ci-*/rust-feature-collection-*/*.selected.json",
  "rust-feature-ci-*/rust-feature-collection-*/selected-rust.cdx*.json",
  "rust-feature-ci-*/rust-feature-advisories-*/*",
]);

export function checkRustFeatureCi({ slice, workflows }) {
  assert(["pr1", "pr2"].includes(slice), "Explicit Rust CI slice required");
  // PR1 checks the model-only slice; PR2's security workflow checks its additive
  // app/card slice plus the explicitly rebound local WebGPU composition. Do not
  // pretend PR2 contains PR1's absent config or qualify all inherited profiles.
  const key = slice === "pr1" ? "model" : "security";
  const jobName = slice === "pr1" ? "dependency-policy" : "dependency-security";
  for (const workflowKey of [
    "model",
    ...(slice === "pr2" ? ["security"] : []),
  ]) {
    const text = workflows[workflowKey].replaceAll("\r\n", "\n");
    const inventory = jobs(text);
    const job = inventory.get(
      workflowKey === "model" ? "dependency-policy" : "dependency-security",
    );
    const fetch = requiredCommand(
      job,
      (command) => command.includes("fetch --locked"),
      "explicit locked Rust input preparation",
    );
    assert.equal(fetch, RUST_FEATURE_FETCH_COMMAND);
    const fetchStep = commands(job).find((item) => item.command === fetch).step;
    assert.match(
      fetchStep,
      /^ {8}working-directory: \.[ \t]*$/mu,
      "Rust preparation must use the selected checkout",
    );
    assert.doesNotMatch(
      fetchStep,
      /^(?:shell:| {8}shell:)/mu,
      "Rust preparation shell override",
    );
    assert.doesNotMatch(
      text,
      /cargo install cargo-(?:audit|cyclonedx)/u,
      "Obsolete whole-workspace audit/SBOM tool installation remains",
    );
  }
  const job = jobs(workflows[key].replaceAll("\r\n", "\n")).get(jobName);
  const matched = commands(job).filter(({ command }) =>
    command.includes("scripts/rust_feature_ci.mjs"),
  );
  assert.equal(
    matched.length,
    1,
    "One executable scoped Rust gate is required",
  );
  const command = requiredCommand(
    job,
    (value) => value.includes("scripts/rust_feature_ci.mjs"),
    "scoped Rust CI gate",
  );
  assert.equal(
    command,
    rustFeatureCiCommand(slice),
    "Exact scoped Rust gate required",
  );
  assert.match(
    matched[0].step,
    /^ {8}working-directory: \.[ \t]*$/mu,
    "Rust CI must use the selected checkout",
  );
  assert.doesNotMatch(
    matched[0].step,
    /^(?:shell:| {8}shell:)/mu,
    "Rust CI shell override",
  );
  const sequence = commands(job).map((item) => item.command);
  requiredCommand(
    job,
    (value) => value === `node scripts/check_feature_ci.mjs ${slice}`,
    "full scoped workflow check",
  );
  const license = `node scripts/check_openchat_${slice}_security.mjs licenses`;
  assert(
    sequence.indexOf(RUST_FEATURE_FETCH_COMMAND) < sequence.indexOf(license) &&
      sequence.indexOf(license) < sequence.indexOf(command),
    "Locked input preparation and offline license gate must precede Rust CI",
  );
  const uploads = steps(job).filter((step) =>
    step.includes(`name: openchat-${slice}-scoped-rust-report`),
  );
  assert.equal(uploads.length, 1, "Scoped Rust evidence upload required");
  const upload = uploads[0];
  assert.match(upload, /^ {8}if: always\(\)$/mu);
  assert.match(
    upload,
    /^ {8}uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02(?: #.*)?$/mu,
  );
  assert.match(upload, /^ {10}if-no-files-found: error$/mu);
  assert.match(
    upload,
    /^ {10}path: \|$/mu,
    "Executable Rust report path required",
  );
  assert.doesNotMatch(
    upload,
    /^(?:continue-on-error:| {8}continue-on-error:)/mu,
    "Rust report upload failure cannot be ignored",
  );
  const paths = [
    ...upload.matchAll(/^ {12}\$\{\{ runner\.temp \}\}\/([^\n]+)$/gmu),
  ].map((match) => match[1]);
  assert.deepEqual(
    paths,
    [...RUST_FEATURE_REPORT_PATHS],
    "Upload selected evidence only; omit raw workspace metadata",
  );
  return {
    pass: true,
    slice,
    advisoryAcceptance: false,
    releaseAcceptance: false,
  };
}

/** Npm-only structural contract; Rust/SBOM and release acceptance are separate. */
export function checkNpmFeatureCi({
  slice,
  workflows,
  runtime = process.versions.node,
  ci = false,
}) {
  assert(["pr1", "pr2"].includes(slice), "Explicit npm CI slice required");
  if (ci) assert.equal(runtime, FEATURE_CI_NODE_VERSION, "CI Node runtime pin");
  const selections = [
    ["model", "dependency-policy", "pr1"],
    ...(slice === "pr2" ? [["security", "dependency-security", "pr2"]] : []),
  ];
  for (const [key, jobName, scope] of selections) {
    const text = workflows[key].replaceAll("\r\n", "\n");
    const job = jobs(text).get(jobName);
    assert(job, "Missing scoped dependency job: " + jobName);
    for (const [source, indentation] of [
      [text, 0],
      [job, 4],
    ]) {
      if (new RegExp(`^ {${indentation}}defaults:`, "mu").test(source)) {
        assert.doesNotMatch(
          block(source, "defaults", indentation),
          /\bshell:|\bworking-directory:/u,
          "Inherited npm gate execution override",
        );
      }
    }
    const node = steps(job).filter((step) =>
      /^(?:uses:| {8}uses:) actions\/setup-node@/mu.test(step),
    );
    assert.equal(node.length, 1, "One pinned Node setup required");
    assert.doesNotMatch(
      node[0],
      /^(?:if:|continue-on-error:| {8}(?:if|continue-on-error):)/mu,
      "Node setup must execute",
    );
    assert.match(
      node[0],
      new RegExp(
        `^ {10}node-version: "${FEATURE_CI_NODE_VERSION.replaceAll(".", "\\.")}"$`,
        "mu",
      ),
      "Pinned Node version required",
    );
    const required = [
      ["npm ci --no-audit", "frontend"],
      [NPM_FEATURE_CI_TEST_COMMAND, "."],
      [`node scripts/check_feature_ci.mjs npm-${scope}`, "."],
      [npmFeatureSmokeCommand(scope), "."],
      [npmFeatureQueryCommand(scope), "."],
      [`node scripts/check_openchat_${scope}_security.mjs licenses`, "."],
    ];
    for (const [expected, directory] of required) {
      requiredCommand(
        job,
        (command) => command === expected,
        "scoped npm/license command " + expected,
      );
      const step = steps(job).find((candidate) =>
        runs(candidate).includes(expected),
      );
      assert.deepEqual(
        [...step.matchAll(/^ {8}working-directory: (.+)$/gmu)].map(
          (match) => match[1],
        ),
        [directory],
        "Explicit gate working directory required",
      );
      assert.doesNotMatch(
        step,
        /^(?:shell:| {8}shell:)/mu,
        "No gate shell override",
      );
      if (
        [npmFeatureQueryCommand(scope), npmFeatureSmokeCommand(scope)].includes(
          expected,
        )
      )
        assert.match(
          step,
          /^ {8}run: \|$/mu,
          "Scoped collector requires literal Bash block",
        );
      else
        assert.match(
          step,
          /^ {8}run: [^|>\n][^\n]*$/mu,
          "Gate requires literal single-line command",
        );
    }
    const execution = commands(job).map((item) => item.command);
    assert(
      execution.indexOf("npm ci --no-audit") <
        execution.indexOf(npmFeatureSmokeCommand(scope)) &&
        execution.indexOf(npmFeatureSmokeCommand(scope)) <
          execution.indexOf(npmFeatureQueryCommand(scope)),
      "Real offline runtime smoke must run after installation and before any advisory query",
    );
    assert.doesNotMatch(
      job,
      /\bnpm\s+audit\b|check_openchat_pr[12]_security\.mjs ci npm/u,
      "Broad npm audit remains",
    );
    const uploads = steps(job).filter((step) =>
      step.includes(`name: openchat-${scope}-scoped-npm-report`),
    );
    assert.equal(uploads.length, 1, "One scoped npm report upload required");
    assert.match(
      uploads[0],
      /^(?:uses:| {8}uses:) actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02(?: # v4)?$/mu,
    );
    assert.match(
      uploads[0],
      /^ {8}if: always\(\)$/mu,
      "Retain failure diagnostics",
    );
    assert.doesNotMatch(uploads[0], /\bcontinue-on-error:/u);
    assert.match(
      uploads[0],
      /^ {10}path: \$\{\{ runner\.temp \}\}\/npm-feature-advisories-\*$/mu,
      "Only scoped reports may be uploaded",
    );
    assert.match(uploads[0], /^ {10}if-no-files-found: error$/mu);
    if (key === "security") {
      requireRoutes(
        text,
        {
          pull_request: ["master", "codex/pr1-local-models"],
          push: [
            "codex/pr2-app-chat-interfaces",
            "codex/pr2-clean-integration",
          ],
        },
        true,
      );
    } else {
      assert(
        text.includes('"scripts/npm_feature*"'),
        "Npm ownership/runner route missing",
      );
      assert(
        text.includes('"scripts/rust_feature*"'),
        "Rust scope/runner route missing",
      );
      assert(
        text.includes('"scripts/vendor/cyclonedx-1.6/**"'),
        "Pinned Rust SBOM schema route missing",
      );
      assert(
        text.includes('"scripts/check_feature_ci*"'),
        "Npm workflow contract route missing",
      );
      assert(text.includes('"frontend/.npmrc"'), "Install-mode route missing");
    }
  }
  return {
    pass: true,
    slice,
    mode: "partial-npm-feature-ci-contract",
    runtimeChecked: ci,
    advisoryAcceptance: false,
    rustSbomAcceptance: false,
  };
}

function checkNodeAndInstalls(
  text,
  expectedNodeJobs,
  expectedInstallJobs,
  allowConditionalJobs = false,
) {
  const inventory = jobs(text, allowConditionalJobs);
  const nodeJobs = [];
  const installJobs = [];
  for (const [name, job] of inventory) {
    for (const step of steps(job)) {
      if (/^(?:uses:| {8}uses:) actions\/setup-node@/mu.test(step)) {
        assert.doesNotMatch(
          step,
          /^(?:if:| {8}if:)/mu,
          `Conditional Node setup: ${name}`,
        );
        assert.deepEqual(
          [
            ...step.matchAll(/^ {10}node-version: ["']([^"']+)["'][ \t]*$/gmu),
          ].map((match) => match[1]),
          [FEATURE_CI_NODE_VERSION],
          `Node setup: ${name}`,
        );
        nodeJobs.push(name);
      }
      for (const command of runs(step)) {
        assert.doesNotMatch(
          command,
          /\bnpm\s+audit\b|\bcargo\s+audit\b|check_openchat_pr[12]_security\.mjs[^\n]*(?:\bnpm\b|\brust\b|\bsbom\b)/u,
          `Legacy whole-lockfile command remains: ${name}`,
        );
        if (!/\bnpm\s+(?:ci|install|i)\b/u.test(command)) continue;
        assert.equal(
          command,
          "npm ci --no-audit",
          `Audit-free exact install: ${name}`,
        );
        assert.doesNotMatch(
          step,
          /^(?:if:|continue-on-error:| {8}(?:if|continue-on-error):)/mu,
          `Conditional/ignored install: ${name}`,
        );
        installJobs.push(name);
      }
    }
  }
  assert.deepEqual(
    nodeJobs.sort(),
    [...expectedNodeJobs].sort(),
    "Node setup job coverage",
  );
  assert.deepEqual(
    installJobs.sort(),
    [...expectedInstallJobs].sort(),
    "Exact install job coverage",
  );
  assert.equal(
    [...text.matchAll(/^ +node-version:/gmu)].length,
    nodeJobs.length,
    "Unowned Node pin",
  );
  return inventory;
}

function requireRoutes(text, required, unfiltered = false) {
  const events = block(text, "on", 0);
  assert.match(
    events,
    /^ {2}workflow_dispatch:[ \t]*$/mu,
    "Manual rerun route missing",
  );
  for (const [event, requiredBranches] of Object.entries(required)) {
    const route = block(events, event, 2);
    if (unfiltered) {
      assert.deepEqual(
        [...route.matchAll(/^ {4}([a-z_-]+):/gmu)].map((match) => match[1]),
        ["branches"],
        `Feature route must not be path/type filtered: ${event}`,
      );
    }
    const inline = /^ {4}branches: \[([^\]]+)\][ \t]*$/mu.exec(route);
    const body = inline ? undefined : block(route, "branches", 4).trim();
    const flow = body?.startsWith("[")
      ? /^\[([\s\S]*)\]$/u.exec(body)
      : undefined;
    assert(
      !body?.startsWith("[") || flow,
      "Unsupported multiline branch selector",
    );
    const values =
      inline || flow
        ? (inline ?? flow)[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : block(route, "branches", 4)
            .split("\n")
            .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
            .map((line) => {
              const match = /^ {6}- ([a-z0-9/_-]+)[ \t]*$/u.exec(line);
              assert(match, "Unsupported branch selector");
              return match[1];
            });
    for (const branch of values)
      assert.match(branch, /^[a-z0-9/_-]+$/u, "Unsupported branch selector");
    for (const branch of requiredBranches)
      assert(values.includes(branch), `Missing ${event} route: ${branch}`);
  }
}

/** Validate the real offline test step independently of unresolved advisory workflow gates. */
export function checkOfflineFeatureHelpers(
  frontendText,
  { topology = "historical" } = {},
) {
  assert(
    ["historical", "current-client"].includes(topology),
    "Unknown frontend topology",
  );
  frontendText = frontendText.replaceAll("\r\n", "\n");
  const current = topology === "current-client";
  const inventory = jobs(frontendText, current);
  const frontend = inventory.get(current ? "build" : "install-and-test");
  assert(frontend, "Missing frontend job");
  if (current) {
    assert.deepEqual(
      [...frontend.matchAll(/^ {4}if: (.+)$/gmu)].map((m) => m[1]),
      ["needs.changes.outputs.frontend == 'true'"],
      "Exact current helper job condition",
    );
    assert.doesNotMatch(
      frontend,
      /^ {4}continue-on-error:/mu,
      "Helper job failure cannot be ignored",
    );
  }
  for (const [text, indentation] of [
    [frontendText, 0],
    ...(current
      ? [...inventory.values()].map((job) => [job, 4])
      : [[frontend, 4]]),
  ]) {
    if (new RegExp("^ {" + indentation + "}defaults:", "mu").test(text)) {
      const defaults = block(text, "defaults", indentation);
      assert.doesNotMatch(
        defaults,
        /\bshell:/u,
        "Do not override inherited helper test failure handling",
      );
    }
  }
  const expected = "node --test " + OFFLINE_FEATURE_HELPER_TESTS.join(" ");
  requiredCommand(
    frontend,
    (value) => value === expected,
    "offline feature helper tests",
  );
  const step = steps(frontend).find((value) => runs(value).includes(expected));
  // Do not reconstruct shell commands from YAML scalars: folding can turn a
  // comment plus a command into one comment that successfully executes nothing.
  assert.deepEqual(
    [...step.matchAll(/^ {8}run: ([^\n]+)$/gmu)].map((match) => match[1]),
    [expected],
    "Offline helper tests require one literal single-line run field",
  );
  assert.deepEqual(
    [...step.matchAll(/^ {8}working-directory: (.+)$/gmu)].map(
      (match) => match[1],
    ),
    ["."],
    "Offline helper tests must run from repository root",
  );
  assert.doesNotMatch(
    step,
    /^(?:shell:| {8}shell:)/mu,
    "Do not override helper test failure handling",
  );
  return [...OFFLINE_FEATURE_HELPER_TESTS];
}

export const CURRENT_CLIENT_RESULTS_COMMAND = [
  'if [ "$CHANGES_RESULT" != "success" ]; then',
  '  echo "The change detection job did not succeed ($CHANGES_RESULT)"',
  "  exit 1",
  "fi",
  'if [ "$FRONTEND_CHANGED" != "true" ]; then',
  '  echo "No frontend changes"',
  "  exit 0",
  "fi",
  "for result in $ALL_RESULTS; do",
  '  if [ "$result" != "success" ]; then',
  '    echo "Not every job succeeded: $ALL_RESULTS"',
  "    exit 1",
  "  fi",
  "done",
  'echo "All jobs passed"',
].join("\n");

export const CURRENT_CLIENT_LOCAL_WEB_COMMAND = [
  'unofficial_output="$(mktemp -d "${RUNNER_TEMP:?}/openchat-unofficial-web.XXXXXX")"',
  'node scripts/build-unofficial-local-web.mjs --output "$unofficial_output" --port 5194 --layout v2',
  'node --input-type=module -e \'import { loadLocalWebBuild } from "./scripts/preview-unofficial-local-web.mjs"; loadLocalWebBuild(process.argv[1]);\' "$unofficial_output"',
  'node scripts/verify_webgpu_distribution.mjs "$unofficial_output"',
].join("\n");

/** Current fork topology only. Historical advisory/source scopes are not accepted here. */
export function checkCurrentClientCi({
  frontendText,
  frontendPackage,
  buildCiSource,
  dfxVersion,
  rollupSource,
  runtime = process.versions.node,
  ci = false,
}) {
  if (ci) assert.equal(runtime, FEATURE_CI_NODE_VERSION, "CI Node runtime pin");
  const text = frontendText.replaceAll("\r\n", "\n");
  const inventory = checkNodeAndInstalls(
    text,
    ["checks", "build"],
    ["checks", "build"],
    true,
  );
  assert.deepEqual(
    [...inventory.keys()].sort(),
    ["build", "changes", "checks", "install-and-test"],
    "Current split frontend jobs",
  );
  requireRoutes(
    text,
    { pull_request: ["main"], push: ["main"], merge_group: ["main"] },
    true,
  );
  assert.doesNotMatch(
    text,
    /^defaults:/mu,
    "No workflow-wide execution override",
  );
  assert.doesNotMatch(
    inventory.get("changes"),
    /^ {4}(?:if|continue-on-error):/mu,
    "Change detection must run",
  );
  for (const path of ["Cargo.lock", "rust-toolchain.toml", "dfx.json"]) {
    assert(
      inventory
        .get("changes")
        .split("\n")
        .includes(`              - "${path}"`),
      "Current build-input change route missing: " + path,
    );
  }
  for (const name of ["checks", "build"]) {
    const job = inventory.get(name);
    assert.match(
      job,
      /^ {4}needs: changes$/mu,
      "Split job needs change detection",
    );
    assert.deepEqual(
      [...job.matchAll(/^ {4}if: (.+)$/gmu)].map((m) => m[1]),
      ["needs.changes.outputs.frontend == 'true'"],
      "Exact frontend change condition",
    );
    assert.doesNotMatch(
      job,
      /^ {4}continue-on-error:/mu,
      "Split job failure cannot be ignored",
    );
    assert.match(
      block(job, "defaults", 4),
      /^ {8}working-directory: frontend$/mu,
      "Frontend job directory",
    );
    assert.doesNotMatch(job, /\bshell:/u, "No current-client shell override");
  }
  const scripts = frontendPackage.scripts;
  assert.equal(
    scripts["check:ci"],
    "npm run lint:check && node ./build-ci.mjs typecheck typecheck:agent test",
    "All check:ci contracts must execute",
  );
  assert.equal(
    scripts["lint:check"],
    "eslint .",
    "CI lint must be non-mutating",
  );
  assert.equal(
    scripts.typecheck,
    "svelte-check --tsconfig ./app/tsconfig.json --threshold error",
  );
  assert.equal(
    scripts["typecheck:agent"],
    "tsc --noEmit -p openchat-agent/tsconfig.json",
  );
  assert.equal(scripts.test, "vitest --run");
  assert.equal(scripts["build:prod"], "cd app && sh ./build_prod.sh");
  for (const fragment of [
    'spawn("npm", ["run", script]',
    "code: 1",
    "code: code ?? 1",
    "results.filter((r) => r.code !== 0)",
    "if (failed.length > 0)",
    "process.exitCode = 1",
  ])
    assert(
      buildCiSource.includes(fragment),
      "Missing concurrent failure propagation: " + fragment,
    );
  assert.doesNotMatch(
    buildCiSource,
    /process\.exitCode\s*=\s*0|process\.exit\(0\)/u,
    "Runner cannot override failures",
  );
  const checks = inventory.get("checks"),
    build = inventory.get("build");
  const requireFrontendCommand = (job, expected, label) => {
    requiredCommand(job, (value) => value === expected, label);
    const step = commands(job).find((item) => item.command === expected).step;
    assert.doesNotMatch(
      step,
      /^(?:working-directory:| {8}working-directory:)/mu,
      "Frontend gate must inherit its verified job directory",
    );
  };
  requireFrontendCommand(
    checks,
    "npm run check:ci",
    "split lint/typecheck/test gate",
  );
  requireFrontendCommand(
    build,
    "npm run build:prod",
    "default production build",
  );
  requiredCommand(
    build,
    (value) => value === "node scripts/check_feature_ci.mjs current-client",
    "current-client topology gate",
  );
  checkOfflineFeatureHelpers(text, { topology: "current-client" });
  const candidate =
    "npm run build:prod\nnode ../scripts/verify_webgpu_distribution.mjs app/build";
  requireFrontendCommand(
    build,
    candidate,
    "qualified WebGPU candidate build and byte verification",
  );
  const candidateStep = commands(build).find(
    (item) => item.command === candidate,
  ).step;
  assert.match(
    candidateStep,
    /^ {8}run: \|$/mu,
    "Candidate must use literal command lines",
  );
  assert.match(
    candidateStep,
    /^ {10}OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true"$/mu,
  );
  assert.match(
    candidateStep,
    /^ {10}OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: immutable-hub-v1$/mu,
  );
  requiredCommand(
    build,
    (value) => value === CURRENT_CLIENT_LOCAL_WEB_COMMAND,
    "optimized unofficial local web build and artifact verification",
  );
  const localWebStep = commands(build).find(
    (item) => item.command === CURRENT_CLIENT_LOCAL_WEB_COMMAND,
  ).step;
  assert.match(localWebStep, /^ {8}run: \|$/mu);
  assert.deepEqual(
    [...localWebStep.matchAll(/^ {8}working-directory: (.+)$/gmu)].map(
      (match) => match[1],
    ),
    ["."],
    "Optimized local web build must run from the repository root",
  );
  assert.doesNotMatch(
    localWebStep,
    /^(?:env:|shell:| {8}(?:env|shell):)/mu,
    "No local web profile or shell override",
  );
  const dfx = steps(build).filter((step) =>
    /uses: dfinity\/setup-dfx@/u.test(step),
  );
  assert.equal(dfx.length, 1, "One pinned dfx prerequisite");
  assert.match(
    dfx[0],
    /^ {8}uses: dfinity\/setup-dfx@e50c04f104ee4285ec010f10609483cf41e4d365$/mu,
  );
  assert.match(
    dfx[0],
    new RegExp(
      `^ {10}dfx-version: "${dfxVersion.replaceAll(".", "\\.")}"$`,
      "mu",
    ),
  );
  assert.doesNotMatch(
    dfx[0],
    /\bif:|\bcontinue-on-error:/u,
    "dfx setup must execute",
  );
  requireFrontendCommand(build, "dfx --version", "dfx availability check");
  const sequence = steps(build);
  const stepIndex = (command) =>
    sequence.findIndex((step) => runs(step).includes(command));
  assert(
    stepIndex("npm ci --no-audit") < stepIndex("dfx --version") &&
      sequence.indexOf(dfx[0]) < stepIndex("dfx --version") &&
      stepIndex("dfx --version") < stepIndex("npm run build:prod") &&
      stepIndex("npm run build:prod") < stepIndex(candidate) &&
      stepIndex(candidate) < stepIndex(CURRENT_CLIENT_LOCAL_WEB_COMMAND),
    "Install/dfx/default/candidate/optimized local web build order",
  );
  assert(
    stepIndex("node scripts/check_feature_ci.mjs current-client") <
      stepIndex("npm run build:prod"),
    "Offline topology check must precede builds",
  );
  for (const fragment of [
    "publicKeyBuildPlugin({",
    "expectedDfxVersion: dfxBuildVersion",
    "canister: process.env.OC_USER_INDEX_CANISTER",
    "queryPublicKey: queryOfficialUserIndexPublicKey",
  ]) {
    assert(
      rollupSource.includes(fragment),
      "Production public-key build prerequisite missing: " + fragment,
    );
  }
  const gate = inventory.get("install-and-test");
  assert.match(
    gate,
    /^ {4}needs: \[changes, checks, build\]$/mu,
    "Required gate must cover all current jobs",
  );
  assert.deepEqual(
    [...gate.matchAll(/^ {4}if: (.+)$/gmu)].map((m) => m[1]),
    ["always()"],
  );
  assert.doesNotMatch(gate, /^ {4}continue-on-error:/mu);
  assert.match(
    gate,
    /^ {6}CHANGES_RESULT: \$\{\{ needs\.changes\.result \}\}$/mu,
  );
  assert.match(
    gate,
    /^ {6}FRONTEND_CHANGED: \$\{\{ needs\.changes\.outputs\.frontend \}\}$/mu,
  );
  assert.match(
    gate,
    /^ {6}ALL_RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}$/mu,
  );
  assert.equal(
    commands(gate).length,
    1,
    "Only the required result gate may decide status",
  );
  requiredCommand(
    gate,
    (value) => value === CURRENT_CLIENT_RESULTS_COMMAND,
    "failure-propagating final status gate",
  );
  return {
    pass: true,
    mode: "current-client",
    runtimeChecked: ci,
    nodeVersion: FEATURE_CI_NODE_VERSION,
    securityScopeAcceptance: false,
    securityScope: "current-client",
    separateSecurityWiringMode: "current-client-security",
    securityEvidenceNotChecked: [
      "dependency-collection",
      "scoped-advisory-gates",
      "hosted-workflow",
    ],
    advisoryAcceptance: false,
    buildExecuted: false,
    releaseAcceptance: false,
  };
}

export function readCurrentClientInputs(repositoryRoot) {
  const read = (name) => readFileSync(resolve(repositoryRoot, name), "utf8");
  return {
    frontendText: read(".github/workflows/frontend.yaml"),
    frontendPackage: JSON.parse(read("frontend/package.json")),
    buildCiSource: read("frontend/build-ci.mjs"),
    dfxVersion: JSON.parse(read("dfx.json")).dfx,
    rollupSource: read("frontend/app/rollup.config.mjs"),
  };
}

/** Offline CI structure/coverage contract only; no baseline, dependency graph, advisory or build execution. */
export function checkFeatureCi({
  slice,
  workflows,
  runtime = process.versions.node,
  ci = false,
}) {
  assert(
    ["pr1", "pr2"].includes(slice),
    "Select explicit pr1 or pr2 feature scope",
  );
  if (ci)
    assert.equal(
      runtime,
      FEATURE_CI_NODE_VERSION,
      "CI runtime differs from supported exact pin",
    );
  const expectedKeys =
    slice === "pr1"
      ? ["frontend", "model"]
      : ["frontend", "integration", "model", "security"];
  assert.deepEqual(
    Object.keys(workflows).sort(),
    expectedKeys,
    "Missing/extra feature workflows",
  );
  const normalized = Object.fromEntries(
    Object.entries(workflows).map(([key, text]) => {
      assert.equal(typeof text, "string");
      assert(
        text.length > 0 && text.length < 100_000,
        "Missing/oversized workflow",
      );
      return [key, text.replaceAll("\r\n", "\n")];
    }),
  );
  checkNpmFeatureCi({ slice, workflows: normalized, runtime, ci });
  checkRustFeatureCi({ slice, workflows: normalized });
  const modelJobs = checkNodeAndInstalls(
    normalized.model,
    ["dependency-policy", "android-component-contracts", "frontend-contracts"],
    ["dependency-policy", "frontend-contracts"],
  );
  for (const name of [
    "dependency-policy",
    "android-component-contracts",
    "native-hermetic",
    "frontend-contracts",
    "real-text-inference",
  ])
    assert(modelJobs.has(name), `Missing model feature job: ${name}`);
  requireRoutes(normalized.model, {
    pull_request: ["master"],
    push: ["codex/pr1-local-models"],
  });
  const modelTests = requiredCommand(
    modelJobs.get("frontend-contracts"),
    (value) => value.startsWith("npm test -- "),
    "model frontend contracts",
  );
  for (const selection of [
    "app/src/utils/model",
    "app/src/utils/transformersWebGpu",
    "app/src/utils/webGpuModelCatalog",
    "app/src/utils/gemma4WebGpu",
    "app/src/utils/localAudioInput",
    "app/src/utils/onDeviceInference",
    "app/src/utils/nativeInferenceRuntimeBridge",
    "app/src/stores/onDeviceModels",
    "app/src/components_shared/WebInferenceRuntimeSettings",
    "app/src/components_shared/WebGpuModelCatalog",
  ])
    assert(
      modelTests.split(/\s+/u).includes(selection),
      `Missing model test family: ${selection}`,
    );
  requiredCommand(
    modelJobs.get("android-component-contracts"),
    (value) => value.includes("component-identity-tests/run.ps1"),
    "Android component contracts",
  );
  requiredCommand(
    modelJobs.get("native-hermetic"),
    (value) => value === "cargo test --locked -p tauri-plugin-oc --lib",
    "native model library contracts",
  );
  const real = requiredCommand(
    modelJobs.get("real-text-inference"),
    (value) => value.includes("inference::tests::text_inference_smoke"),
    "real text inference fixture",
  );
  assert.match(
    real,
    /^cargo test --locked -p tauri-plugin-oc --features inference /u,
  );
  assert.match(real, /--ignored --exact --nocapture$/u);

  const frontendJobs = checkNodeAndInstalls(
    normalized.frontend,
    ["install-and-test"],
    ["install-and-test"],
  );
  requireRoutes(
    normalized.frontend,
    {
      pull_request:
        slice === "pr1" ? ["master"] : ["master", "codex/pr1-local-models"],
      push:
        slice === "pr1"
          ? ["codex/pr1-local-models"]
          : [
              "codex/pr1-local-models",
              "codex/pr2-app-chat-interfaces",
              "codex/pr2-clean-integration",
            ],
    },
    true,
  );
  const frontend = frontendJobs.get("install-and-test");
  checkOfflineFeatureHelpers(normalized.frontend);
  requiredCommand(
    frontend,
    (value) => value === "npm run build:ci",
    "frontend build contracts",
  );
  const helperTests = requiredCommand(
    frontend,
    (value) =>
      value.startsWith("node --test ") &&
      value.includes("scripts/model_ci_coverage.test.mjs"),
    "model coverage regressions",
  );
  assert(
    helperTests.includes("scripts/security_mode_scope.test.mjs"),
    "Legacy safety guard tests missing",
  );

  if (slice === "pr2") {
    checkNodeAndInstalls(
      normalized.security,
      ["dependency-security"],
      ["dependency-security"],
    );
    requireRoutes(normalized.security, {
      pull_request: ["master", "codex/pr1-local-models"],
      push: ["codex/pr2-app-chat-interfaces", "codex/pr2-clean-integration"],
    });
    const integrationJobs = checkNodeAndInstalls(
      normalized.integration,
      ["app-model-integration"],
      [],
    );
    requireRoutes(
      normalized.integration,
      {
        pull_request: ["codex/pr1-local-models"],
        push: ["codex/pr2-app-chat-interfaces", "codex/pr2-clean-integration"],
      },
      true,
    );
    const integration = integrationJobs.get("app-model-integration");
    requiredCommand(
      integration,
      (value) => value === "node --test scripts/app_model_integration.test.mjs",
      "scoped integration selector tests",
    );
    requiredCommand(
      integration,
      (value) =>
        value.startsWith(
          "cargo test --locked --package integration_tests --no-run --message-format=json ",
        ),
      "locked integration fixture link",
    );
    requiredCommand(
      integration,
      (value) =>
        value ===
        'node scripts/app_model_integration.mjs run "$RUNNER_TEMP/openchat-app-model-integration"',
      "scoped app/model integration execution",
    );
  }
  return {
    pass: true,
    slice,
    mode: "offline-feature-ci-contract",
    nodeVersion: FEATURE_CI_NODE_VERSION,
    runtimeChecked: ci,
    advisoryAcceptance: false,
    buildExecuted: false,
  };
}

export const CURRENT_CLIENT_SECURITY_TEST_COMMAND =
  "node --test " +
  [
    ...OFFLINE_FEATURE_HELPER_TESTS,
    "scripts/check_feature_ci.current-client.test.mjs",
    "scripts/check_current_client_licenses.test.mjs",
    "scripts/frontend_format_current.test.mjs",
  ].join(" ");

export const CURRENT_CLIENT_LICENSE_COMMAND = [
  "set -euo pipefail",
  'cargo_path="$(rustup which --toolchain 1.95.0 cargo)"',
  'node scripts/check_current_client_licenses.mjs --scope current-client --cargo-executable "$cargo_path"',
].join("\n");

export const CURRENT_CLIENT_FORMAT_BASE_EXPRESSION =
  "98a178bef2d67efb6b85a5772a6164fe7134074c";

const CURRENT_LOCAL_APP_LIFECYCLE_JOB = [
  "    name: Android private-app lease tests and real service SDK compilation",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 15",
  "    steps:",
  "      - name: Check out source",
  "        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
  "      - name: Set up Node",
  "        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
  "        with:",
  '          node-version: "24.18.1"',
  "      - name: Check lifecycle runner coverage offline",
  "        run: node --test scripts/android_component_identity_tools.test.mjs scripts/model_ci_coverage.test.mjs",
  "      - name: Set up Java",
  "        uses: actions/setup-java@v4",
  "        with:",
  "          distribution: temurin",
  '          java-version: "21"',
  "      - name: Set up Android SDK",
  "        uses: android-actions/setup-android@v3",
  "        with:",
  "          packages: platform-tools",
  "      - name: Install the Android API used by the service",
  '        run: sdkmanager "platforms;android-36"',
  "      - name: Run lease policy tests and compile the actual service with real AndroidX",
  "        shell: pwsh",
  "        run: |",
  "          $ErrorActionPreference = 'Stop'",
  '          $toolsJson = & node scripts/android_component_identity_tools.mjs --output-directory "$env:RUNNER_TEMP/openchat-lifecycle-tools"',
  "          if ($LASTEXITCODE -ne 0) { throw 'Pinned lifecycle test tool resolution failed.' }",
  "          $tools = $toolsJson | ConvertFrom-Json",
  "          & ./frontend/tauri-plugin-oc/android/local-app-lifecycle-tests/run.ps1 `",
  "            -JavaHome $env:JAVA_HOME `",
  "            -KotlinCompilerClasspath $tools.compilerClasspath `",
  "            -KotlinRuntimeClasspath $tools.runtimeClasspath `",
  "            -JUnitClasspath $tools.junitClasspath `",
  '            -AndroidJar "$env:ANDROID_HOME/platforms/android-36/android.jar" `',
  "            -DownloadAndroidXCore `",
  '            -OutputDirectory "$env:RUNNER_TEMP/openchat-lifecycle-classes"',
  "          if ($LASTEXITCODE -ne 0) { throw 'Private-app lifecycle contracts failed.' }",
  "        # Actual policy tests and service compilation; only generated R is a fixture.",
  "        # This is not Android runtime, notification, background-freeze or APK evidence.",
].join("\n");

/** Offline wiring only: this does not collect dependencies, query advisories, or accept a release. */
export function checkCurrentClientSecurityCi({
  securityText,
  historicalModelText,
  runtime = process.versions.node,
  ci = false,
}) {
  if (ci) assert.equal(runtime, FEATURE_CI_NODE_VERSION, "CI Node runtime pin");
  assert.equal(typeof securityText, "string");
  assert(securityText.length > 0 && securityText.length < 100_000);
  const text = securityText.replaceAll("\r\n", "\n");
  const legacy = historicalModelText.replaceAll("\r\n", "\n");
  requireRoutes(
    text,
    { pull_request: ["main"], push: ["main"], merge_group: ["main"] },
    true,
  );
  const events = block(text, "on", 0);
  assert.deepEqual(
    [...events.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]),
    ["pull_request", "push", "merge_group", "workflow_dispatch"],
    "Only explicit main and manual security routes are supported",
  );
  for (const event of ["pull_request", "push", "merge_group"])
    assert.equal(block(events, event, 2).trim(), "branches: [main]");
  assert.equal(block(text, "permissions", 0).trim(), "contents: read");
  assert.doesNotMatch(
    text,
    /^(?:defaults|env):/mu,
    "No workflow execution overrides",
  );
  const inventory = checkNodeAndInstalls(
    text,
    [
      "dependency-security",
      "android-component-contracts",
      "android-local-app-lifecycle",
      "frontend-contracts",
    ],
    ["dependency-security", "frontend-contracts"],
  );
  const preservedJobs = [
    "android-component-contracts",
    "native-hermetic",
    "frontend-contracts",
    "real-text-inference",
  ];
  assert.deepEqual(
    [...inventory.keys()].sort(),
    [
      "dependency-security",
      "android-local-app-lifecycle",
      ...preservedJobs,
    ].sort(),
    "Current security workflow must retain every reviewed model job",
  );
  assert.equal(
    inventory.get("android-local-app-lifecycle").trim(),
    CURRENT_LOCAL_APP_LIFECYCLE_JOB.trim(),
    "Require the exact reviewed native private-app lifecycle job",
  );
  const historicalJobs = jobs(legacy);
  for (const name of preservedJobs) {
    let expectedJob = historicalJobs.get(name);
    if (name === "native-hermetic") {
      // Preserve historical jobs on their branches. The current workflow alone
      // must not let a later successful PowerShell command mask a failed one.
      const windowsSteps = steps(expectedJob).filter((step) =>
        /^ {8}if: runner\.os == 'Windows'$/mu.test(step),
      );
      assert.equal(windowsSteps.length, 1);
      assert.deepEqual(runs(windowsSteps[0]), [
        "cargo check --locked -p open-chat --features inference\n" +
          "cargo check --locked -p open-chat --features inference,store",
      ]);
      const guardedStep = windowsSteps[0].replace(
        /^ {10}cargo check --locked -p open-chat --features inference(?:,store)?$/gmu,
        (command) =>
          command +
          "\n          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      );
      expectedJob = expectedJob.replace(windowsSteps[0], guardedStep);
      const defaultTestStep =
        "      - name: Run downloader, store and boundary unit tests\n" +
        "        run: cargo test --locked -p tauri-plugin-oc --lib\n";
      assert.equal(expectedJob.split(defaultTestStep).length, 2);
      expectedJob = expectedJob.replace(
        defaultTestStep,
        defaultTestStep +
          "      - name: Run approved local app listener and retention lifecycle tests\n" +
          "        run: cargo test --locked -p tauri-plugin-oc --lib --features local-app-handoff\n",
      );
    }
    assert.equal(
      inventory.get(name).trim(),
      expectedJob?.trim(),
      "Preserve reviewed model job with only explicit failure strengthening: " +
        name,
    );
  }
  const job = inventory.get("dependency-security");
  assert.match(job, /^ {4}runs-on: ubuntu-24\.04$/mu);
  assert.doesNotMatch(job, /^ {4}(?:defaults|env|permissions):/mu);
  const checkout = steps(job).filter((step) =>
    /uses: actions\/checkout@/u.test(step),
  );
  assert.equal(checkout.length, 1);
  assert.match(
    checkout[0],
    /^ {8}uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262(?: # v4)?$/mu,
  );
  assert.match(checkout[0], /^ {10}fetch-depth: 0$/mu);
  assert.doesNotMatch(
    checkout[0],
    /\bif:|\bcontinue-on-error:|^ {10}(?:ref|repository|path):/mu,
  );
  const node = steps(job).filter((step) =>
    /uses: actions\/setup-node@/u.test(step),
  );
  assert.equal(node.length, 1);
  assert.match(
    node[0],
    /^ {8}uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020(?: # v4)?$/mu,
  );
  assert.doesNotMatch(node[0], /\bif:|\bcontinue-on-error:/u);
  const required = [
    ["npm ci --no-audit", "frontend", false],
    ["node --test scripts/security_dependency_hash.test.mjs", undefined, false],
    [
      "node scripts/check_current_client_format.mjs --scope current-client",
      ".",
      false,
    ],
    [CURRENT_CLIENT_SECURITY_TEST_COMMAND, ".", false],
    ["node scripts/check_feature_ci.mjs current-client-security", ".", false],
    [npmFeatureSmokeCommand("current-client"), ".", true, "scope_validated"],
    [npmFeatureQueryCommand("current-client"), ".", true],
    [RUST_FEATURE_FETCH_COMMAND, ".", true, "rust_inputs", "scope_validated"],
    [CURRENT_CLIENT_LICENSE_COMMAND, ".", true, "rust_licenses", "rust_inputs"],
    [
      rustFeatureCiCommand("current-client"),
      ".",
      true,
      undefined,
      "rust_licenses",
    ],
  ];
  assert.deepEqual(
    commands(job).map(({ command }) => command),
    required.map(([command]) => command),
    "Exact source/test/runtime/query/fetch/license/Rust order; no extra execution",
  );
  for (const [
    expected,
    directory,
    literalBlock,
    id,
    prerequisite,
  ] of required) {
    requiredCommand(
      job,
      (command) => command === expected,
      "current-client security command",
      prerequisite === undefined
        ? undefined
        : "${{ !cancelled() && steps." +
            prerequisite +
            ".outcome == 'success' }}",
    );
    const step = commands(job).find(({ command }) => command === expected).step;
    assert.deepEqual(
      [...step.matchAll(/^ {8}id: (.+)$/gmu)].map((m) => m[1]),
      id === undefined ? [] : [id],
      "Exact prerequisite identity; no aliases or duplicates",
    );
    assert.deepEqual(
      [...step.matchAll(/^ {8}working-directory: (.+)$/gmu)].map(
        (match) => match[1],
      ),
      directory ? [directory] : [],
      "Exact current-client command directory",
    );
    assert.doesNotMatch(
      step,
      /^(?:shell:| {8}shell:)/mu,
      "No security shell override",
    );
    if (expected === "npm ci --no-audit")
      assert.equal(
        block(step, "env", 8).trim(),
        'ONNXRUNTIME_NODE_INSTALL: "skip"',
      );
    else if (
      expected ===
      "node scripts/check_current_client_format.mjs --scope current-client"
    )
      assert.equal(
        block(step, "env", 8).trim(),
        "PR_BASE_SHA: " + CURRENT_CLIENT_FORMAT_BASE_EXPRESSION,
      );
    else
      assert.doesNotMatch(
        step,
        /^(?:env:| {8}env:)/mu,
        "No security command environment override",
      );
    assert.match(
      step,
      literalBlock ? /^ {8}run: \|$/mu : /^ {8}run: [^|>\n][^\n]*$/mu,
      "No folded/commented command substitution",
    );
  }
  for (const [kind, expectedPaths] of [
    ["npm", ["npm-feature-advisories-*"]],
    ["rust", [...RUST_FEATURE_REPORT_PATHS]],
  ]) {
    const uploads = steps(job).filter((step) =>
      step.includes(`name: openchat-current-client-scoped-${kind}-report`),
    );
    assert.equal(
      uploads.length,
      1,
      "Current scoped report upload required: " + kind,
    );
    const upload = uploads[0];
    assert.match(
      upload,
      /^ {8}uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02(?: # v4)?$/mu,
    );
    assert.match(upload, /^ {8}if: always\(\)$/mu);
    assert.match(upload, /^ {10}if-no-files-found: error$/mu);
    assert.doesNotMatch(upload, /\bcontinue-on-error:|\benv:|\bshell:/u);
    const paths =
      kind === "npm"
        ? [
            ...upload.matchAll(
              /^ {10}path: \$\{\{ runner\.temp \}\}\/([^\n]+)$/gmu,
            ),
          ].map((match) => match[1])
        : [
            ...upload.matchAll(/^ {12}\$\{\{ runner\.temp \}\}\/([^\n]+)$/gmu),
          ].map((match) => match[1]);
    if (kind === "rust") assert.match(upload, /^ {10}path: \|$/mu);
    assert.deepEqual(
      paths,
      expectedPaths,
      "Upload selected evidence, never raw workspace metadata",
    );
  }
  assert.equal(
    steps(job).length,
    required.length + 4,
    "Only reviewed checkout/setup/commands/uploads are permitted",
  );
  return {
    pass: true,
    mode: "current-client-security",
    scope: "current-client",
    runtimeChecked: ci,
    nodeVersion: FEATURE_CI_NODE_VERSION,
    preservedModelJobs: preservedJobs,
    modelJobStrengthenings: [
      "native-hermetic-windows-per-command-exit-checks",
      "native-hermetic-local-app-handoff-feature-tests",
    ],
    addedFeatureJobs: ["android-local-app-lifecycle"],
    advisoryQueriesExecuted: false,
    advisoryAcceptance: false,
    dependencyCollectionExecuted: false,
    buildExecuted: false,
    releaseAcceptance: false,
  };
}

export function readCurrentClientSecurityInputs(repositoryRoot) {
  return {
    securityText: readFileSync(
      resolve(
        repositoryRoot,
        ".github/workflows/unofficial_client_security.yaml",
      ),
      "utf8",
    ),
    historicalModelText: readFileSync(
      resolve(
        repositoryRoot,
        ".github/workflows/on_device_model_security.yaml",
      ),
      "utf8",
    ),
  };
}

export function readFeatureWorkflows(repositoryRoot, slice) {
  assert(
    ["pr1", "pr2"].includes(slice),
    "Select explicit pr1 or pr2 feature scope",
  );
  const files = {
    model: "on_device_model_security.yaml",
    frontend: "frontend.yaml",
    ...(slice === "pr2"
      ? {
          security: "openchat_pr2_security.yaml",
          integration: "app_model_integration.yaml",
        }
      : {}),
  };
  return Object.fromEntries(
    Object.entries(files).map(([key, file]) => [
      key,
      readFileSync(resolve(repositoryRoot, ".github/workflows", file), "utf8"),
    ]),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/check_feature_ci.mjs current-client|current-client-security|pr1|pr2|npm-pr1|npm-pr2",
  );
  if (process.argv[2] === "current-client") {
    console.log(
      JSON.stringify(
        checkCurrentClientCi({
          ...readCurrentClientInputs(root),
          ci: process.env.CI === "true",
        }),
      ),
    );
  } else if (process.argv[2] === "current-client-security") {
    console.log(
      JSON.stringify(
        checkCurrentClientSecurityCi({
          ...readCurrentClientSecurityInputs(root),
          ci: process.env.CI === "true",
        }),
      ),
    );
  } else {
    const npmOnly = process.argv[2].startsWith("npm-");
    const slice = npmOnly ? process.argv[2].slice(4) : process.argv[2];
    console.log(
      JSON.stringify(
        (npmOnly ? checkNpmFeatureCi : checkFeatureCi)({
          slice,
          workflows: readFeatureWorkflows(root, slice),
          ci: process.env.CI === "true",
        }),
      ),
    );
  }
}
