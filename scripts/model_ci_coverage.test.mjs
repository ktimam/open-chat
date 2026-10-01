import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/on_device_model_security.yaml");

// This contract checks the small, literal native manifest/lock shapes used here.
// It does not run Cargo or claim that a native compile or inference has passed.
function nativeAbiTable(text, name) {
  text = text.replaceAll("\r\n", "\n");
  const headers = [...text.matchAll(/^\[([^\]\n]+)\][ \t]*\r?$/gmu)];
  const matches = headers.filter((entry) => entry[1] === name);
  assert.equal(matches.length, 1, `expected one ${name} table`);
  const start = matches[0].index + matches[0][0].length;
  const next = headers.find((entry) => entry.index > start)?.index;
  return text
    .slice(start, next)
    .replace(/^[ \t]*#[^\n]*$/gmu, "")
    .trim();
}

function nativeAbiFeatures(manifest) {
  const result = new Map();
  for (const line of nativeAbiTable(manifest, "features").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-z0-9-]+)\s*=\s*(\[[^\]\r\n]*\])$/u.exec(line);
    assert.ok(match, `unsupported feature declaration: ${line}`);
    assert.ok(!result.has(match[1]), `duplicate feature: ${match[1]}`);
    const values = JSON.parse(match[2]);
    assert.ok(values.every((value) => typeof value === "string"));
    result.set(match[1], values);
  }
  return result;
}

function assertNativeAbiPair({ plugin, app, lock }) {
  const declarations = {
    "llama-cpp-2":
      'llama-cpp-2 = { version = "=0.1.150", optional = true, features = ["mtmd"] }',
    "llama-cpp-sys-2":
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true, default-features = false }',
  };
  const dependency = (manifest, name, expected) => {
    const pattern = new RegExp(`^${name}\\s*=.*$`, "gmu");
    const declarations = [...manifest.matchAll(pattern)];
    assert.equal(declarations.length, 1, `expected one ${name} dependency`);
    assert.equal(
      declarations[0][0].replace(/\s/gu, ""),
      expected.replace(/\s/gu, ""),
      `${name} exact optional dependency configuration`,
    );
    assert.match(nativeAbiTable(manifest, "dependencies"), pattern);
  };
  for (const [name, declaration] of Object.entries(declarations)) {
    dependency(plugin, name, declaration);
    assert.doesNotMatch(app, new RegExp(`^${name}\\s*=`, "mu"));
  }
  dependency(
    app,
    "tauri-plugin-oc",
    'tauri-plugin-oc = { path = "../tauri-plugin-oc" }',
  );

  const pluginFeatures = nativeAbiFeatures(plugin);
  assert.deepEqual(pluginFeatures.get("inference"), [
    "dep:llama-cpp-2",
    "dep:llama-cpp-sys-2",
    "dep:minijinja",
    "dep:minijinja-contrib",
  ]);
  for (const [name, values] of pluginFeatures) {
    if (name === "inference") continue;
    for (const value of values)
      assert.doesNotMatch(
        value,
        /^(?:inference$|(?:dep:)?llama-cpp(?:-sys)?-2(?:$|[?/]))/u,
        `native dependencies may only activate through inference, not ${name}`,
      );
  }
  const appFeatures = nativeAbiFeatures(app);
  assert.deepEqual(appFeatures.get("inference"), ["tauri-plugin-oc/inference"]);
  assert.deepEqual(appFeatures.get("transformers-webgpu-android"), []);
  for (const [name, values] of appFeatures) {
    if (name === "inference") continue;
    for (const value of values)
      assert.doesNotMatch(
        value,
        /^(?:inference$|tauri-plugin-oc\??\/(?:inference|llama-cpp(?:-sys)?-2)$)/u,
        `native inference must stay opt-in, not enabled by ${name}`,
      );
  }

  const packageBlock = (name) => {
    const matches = lock
      .replaceAll("\r\n", "\n")
      .split(/^\[\[package\]\]$/mu)
      .slice(1)
      .filter((block) => block.includes(`\nname = "${name}"\n`));
    assert.equal(matches.length, 1, `expected one locked ${name} package`);
    return matches[0];
  };
  const scalar = (block, name) => {
    const matches = [...block.matchAll(new RegExp(`^${name} = (.*)$`, "gmu"))];
    assert.equal(matches.length, 1, `expected one lock ${name}`);
    return JSON.parse(matches[0][1]);
  };
  for (const [name, checksum] of [
    [
      "llama-cpp-2",
      "e82ec86fd73aaa7d8f4898cc4693410c217431506ba3237ea5c856127f49d84d",
    ],
    [
      "llama-cpp-sys-2",
      "f67dab3ed2b68e4fc4a42471eac73e128ed2ee97bd10de66ddcc609dd5d838a0",
    ],
  ]) {
    const block = packageBlock(name);
    assert.equal(scalar(block, "version"), "0.1.150", name);
    assert.equal(scalar(block, "checksum"), checksum, name);
    assert.equal(
      scalar(block, "source"),
      "registry+https://github.com/rust-lang/crates.io-index",
      name,
    );
  }
  const nativeEdges = (name) => {
    const matches = [
      ...packageBlock(name).matchAll(/^dependencies = \[([^\]]*)\]$/gmu),
    ];
    assert.equal(matches.length, 1, `${name} locked dependencies`);
    const dependencies = JSON.parse(`[${matches[0][1].replace(/,\s*$/u, "")}]`);
    return dependencies.filter((value) =>
      /^llama-cpp(?:-sys)?-2(?: |$)/u.test(value),
    );
  };
  assert.deepEqual(nativeEdges("llama-cpp-2"), ["llama-cpp-sys-2"]);
  assert.deepEqual(nativeEdges("tauri-plugin-oc"), [
    "llama-cpp-2",
    "llama-cpp-sys-2",
  ]);
}

function nativeAbiFixture() {
  return {
    plugin: read("frontend/tauri-plugin-oc/Cargo.toml"),
    app: read("frontend/src-tauri/Cargo.toml"),
    lock: read("Cargo.lock"),
  };
}

test("native inference retains the exact optional wrapper/sys ABI pair without activating default or WebGPU builds", () => {
  assertNativeAbiPair(nativeAbiFixture());
  const notices = read("frontend/src-tauri/THIRD_PARTY_NOTICES.md");
  assert.match(
    notices,
    /`llama-cpp-2` 0\.1\.150 with\s+`llama-cpp-sys-2` 0\.1\.150/u,
  );
  assert.ok(
    notices.includes(
      "f67dab3ed2b68e4fc4a42471eac73e128ed2ee97bd10de66ddcc609dd5d838a0",
    ),
  );
  assert.doesNotMatch(notices, /llama-cpp-sys-2[^\r\n]*0\.1\.154/u);
});

test("native ABI guard rejects loosened pins, changed lock tuples and missing direct owner edges", () => {
  const fixture = nativeAbiFixture();
  const cases = [
    [
      "plugin",
      'llama-cpp-2 = { version = "=0.1.150"',
      'llama-cpp-2 = { version = "0.1.150"',
    ],
    [
      "plugin",
      'llama-cpp-sys-2 = { version = "=0.1.150"',
      'llama-cpp-sys-2 = { version = "0.1.150"',
    ],
    [
      "plugin",
      'llama-cpp-sys-2 = { version = "=0.1.150"',
      'llama-cpp-sys-2 = { version = "=0.1.154"',
    ],
    [
      "plugin",
      'llama-cpp-2 = { version = "=0.1.150"',
      'llama-cpp-2 = { version = "=0.1.154"',
    ],
    [
      "plugin",
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true',
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = false',
    ],
    [
      "plugin",
      'llama-cpp-2 = { version = "=0.1.150", optional = true',
      'llama-cpp-2 = { version = "=0.1.150", optional = false',
    ],
    [
      "plugin",
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true, default-features = false }',
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true }',
    ],
    [
      "plugin",
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true, default-features = false }',
      'llama-cpp-sys-2 = { version = "=0.1.150", optional = true, default-features = true }',
    ],
    ...["llama-cpp-2", "llama-cpp-sys-2"].map((name) => [
      "lock",
      `name = "${name}"\nversion = "0.1.150"`,
      `name = "${name}"\nversion = "0.1.154"`,
    ]),
    [
      "lock",
      'checksum = "f67dab3ed2b68e4fc4a42471eac73e128ed2ee97bd10de66ddcc609dd5d838a0"',
      `checksum = "${"0".repeat(64)}"`,
    ],
    ["lock", ' "llama-cpp-sys-2",', ' "llama-cpp-sys-2 0.1.154",'],
  ];
  for (const [index, [key, before, after]] of cases.entries()) {
    const original = fixture[key].replaceAll("\r\n", "\n");
    const changed = original.replace(before, after);
    assert.notEqual(changed, original, `mutation ${index} must execute`);
    assert.throws(
      () => assertNativeAbiPair({ ...fixture, [key]: changed }),
      `mutation ${index}`,
    );
  }
  for (const owner of ["llama-cpp-2", "tauri-plugin-oc"]) {
    const lock = fixture.lock.replaceAll("\r\n", "\n");
    const start = lock.indexOf(`\nname = "${owner}"\n`);
    const edge = lock.indexOf(' "llama-cpp-sys-2",\n', start);
    assert.ok(start >= 0 && edge > start);
    const changed =
      lock.slice(0, edge) + lock.slice(edge + ' "llama-cpp-sys-2",\n'.length);
    assert.throws(
      () => assertNativeAbiPair({ ...fixture, lock: changed }),
      owner,
    );
  }
  assert.throws(() =>
    assertNativeAbiPair({
      ...fixture,
      lock:
        fixture.lock +
        '\n[[package]]\nname = "llama-cpp-sys-2"\nversion = "0.1.154"\n',
    }),
  );
});

test("native ABI guard rejects missing inference activation and default/WebGPU activation", () => {
  const fixture = nativeAbiFixture();
  const cases = [
    ["plugin", '"dep:llama-cpp-sys-2", ', ""],
    ["plugin", '"dep:llama-cpp-2", ', ""],
    ["plugin", "[features]", '[features]\ndefault = ["inference"]'],
    ["plugin", "[features]", '[features]\ndefault = ["dep:llama-cpp-sys-2"]'],
    ["plugin", "store = []", 'store = ["llama-cpp-sys-2/mtmd"]'],
    ["app", "[features]", '[features]\ndefault = ["inference"]'],
    ["app", 'inference = ["tauri-plugin-oc/inference"]', "inference = []"],
    [
      "app",
      "transformers-webgpu-android = []",
      'transformers-webgpu-android = ["inference"]',
    ],
    [
      "app",
      "transformers-webgpu-android = []",
      'transformers-webgpu-android = ["tauri-plugin-oc/inference"]',
    ],
    [
      "app",
      'store = ["tauri-plugin-oc/store"]',
      'store = ["tauri-plugin-oc/inference"]',
    ],
    [
      "app",
      'tauri-plugin-oc = { path = "../tauri-plugin-oc" }',
      'tauri-plugin-oc = { path = "../tauri-plugin-oc", features = ["inference"] }',
    ],
  ];
  for (const [index, [key, before, after]] of cases.entries()) {
    const changed = fixture[key].replace(before, after);
    assert.notEqual(changed, fixture[key], `mutation ${index} must execute`);
    assert.throws(
      () => assertNativeAbiPair({ ...fixture, [key]: changed }),
      `mutation ${index}`,
    );
  }
});

// These are the three reviewed jobs that actually execute Node. Do not derive
// the expected count from the workflow: that would also accept dropped jobs.
function assertModelNodeSetup(text, policy) {
  assert.equal(policy.ciRuntime.setupNodeOccurrences, 3);
  assert.equal(policy.ciRuntime.nodeVersion, "24.18.1");
  const jobs = mappingBlock(text, "jobs", 0);
  const observed = [];
  for (const [, name] of jobs.matchAll(/^ {2}([a-z0-9-]+):[ \t]*\r?$/gmu)) {
    const steps = mappingBlock(mappingBlock(jobs, name, 2), "steps", 4);
    const setup = steps
      .split(/^ {6}- /mu)
      .slice(1)
      .filter((step) =>
        /^(?:uses:| {8}uses:) actions\/setup-node@/mu.test(step),
      );
    for (const step of setup) {
      const withBlock = mappingBlock(step, "with", 8);
      const versions = [
        ...withBlock.matchAll(/^ {10}node-version: "([^"]+)"[ \t]*\r?$/gmu),
      ];
      assert.deepEqual(
        versions.map((match) => match[1]),
        [policy.ciRuntime.nodeVersion],
        name,
      );
      observed.push(name);
    }
  }
  assert.deepEqual(observed.sort(), [
    "android-component-contracts",
    "dependency-policy",
    "frontend-contracts",
  ]);
  assert.equal(
    [...text.matchAll(/node-version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/gu)]
      .length,
    policy.ciRuntime.setupNodeOccurrences,
    "policy scanner and actual setup steps must count the same pins",
  );
}

test("model security baseline covers exactly the three reviewed Node jobs", () => {
  assertModelNodeSetup(
    workflow,
    JSON.parse(read(".github/security/openchat-pr1-security-baseline.json")),
  );
});

test("Node setup coverage rejects missing, extra, relocated and wrongly pinned steps", () => {
  const policy = JSON.parse(
    read(".github/security/openchat-pr1-security-baseline.json"),
  );
  policy.ciRuntime.setupNodeOccurrences = 3; // Positive control is independent of the stale baseline.
  assertModelNodeSetup(workflow, policy);
  const version = '          node-version: "24.18.1"';
  const extraStep = [
    "      - uses: actions/setup-node@v4",
    "        with:",
    version,
    "",
  ].join("\n");
  const mutants = [
    workflow.replace(
      "uses: actions/setup-node@",
      "uses: actions/not-setup-node@",
    ),
    workflow.replace(/    steps:\r?\n/u, "    steps:\n" + extraStep),
    workflow + "\n  unexpected-node-job:\n    steps:\n" + extraStep,
    workflow.replace(
      "  android-component-contracts:",
      "  unexpected-component-job:",
    ),
    workflow.replace(version, '          node-version: "24.14.1"'),
    workflow.replace(version, ""),
    workflow.replace(version, version + "\n" + version),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, workflow, "mutation must alter workflow " + index);
    assert.throws(
      () => assertModelNodeSetup(mutant, policy),
      "mutation " + index,
    );
  }
  for (const count of [2, 4]) {
    assert.throws(() =>
      assertModelNodeSetup(workflow, {
        ...policy,
        ciRuntime: { ...policy.ciRuntime, setupNodeOccurrences: count },
      }),
    );
  }
});

// Parse only the workflow's simple block mappings, rejecting missing/ambiguous
// blocks. Event coverage must come from on.pull_request, never push or job text.
function mappingBlock(text, key, indentation) {
  const matches = [
    ...text.matchAll(
      new RegExp(`^${" ".repeat(indentation)}${key}:[ \\t]*\\r?$`, "gmu"),
    ),
  ];
  assert.equal(matches.length, 1, `expected one ${key} mapping`);
  const rest = text.slice(matches[0].index + matches[0][0].length);
  const end = rest.search(new RegExp(`^ {0,${indentation}}\\S`, "mu"));
  return end === -1 ? rest : rest.slice(0, end);
}

// This deliberately supports only the existing literal frontend job shape.
// A comment, filtered event, conditional step or ignored exit is not coverage.
function assertAndroidDevFrontendGate(text) {
  text = text.replaceAll("\r\n", "\n");
  const events = mappingBlock(text, "on", 0);
  for (const [event, branch] of [
    ["pull_request", "master"],
    ["pull_request", "main"],
    ["push", "main"],
  ]) {
    const trigger = mappingBlock(events, event, 2);
    assert.deepEqual(
      [...trigger.matchAll(/^ {4}([a-z_-]+):/gmu)].map((match) => match[1]),
      ["branches"],
      event + " must not filter changed paths or event types",
    );
    const branches = mappingBlock(trigger, "branches", 4)
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => {
        const match = /^ {6}- ([a-z0-9/_-]+)[ \t]*$/u.exec(line);
        assert.ok(match, "unsupported branch selector: " + line);
        return match[1];
      });
    assert.ok(branches.includes(branch), event + " must cover " + branch);
  }
  const job = mappingBlock(mappingBlock(text, "jobs", 0), "build", 2);
  assert.match(job, /^ {4}needs: changes$/mu);
  assert.match(job, /^ {4}if: needs\.changes\.outputs\.frontend == 'true'$/mu);
  assert.doesNotMatch(job, /^ {4}continue-on-error:/mu);
  const defaults = mappingBlock(mappingBlock(job, "defaults", 4), "run", 6);
  assert.match(defaults, /^ {8}working-directory: frontend[ \t]*\r?$/mu);
  assert.doesNotMatch(defaults, /^ {8}shell:/mu);
  const steps = mappingBlock(job, "steps", 4)
    .split(/^ {6}- /mu)
    .slice(1);
  const select = (name) => {
    const selected = steps.filter((step) => name.test(step));
    assert.equal(selected.length, 1, "expected exactly one matching step");
    const step = selected[0];
    assert.doesNotMatch(step, /^ {8}(?:if|continue-on-error|shell):/mu);
    return step;
  };
  const install = select(/^name: Install dependencies[ \t]*\r?$/mu);
  const policy = select(
    /^name: Check (?:model and packaging|PR and release) policy regressions[ \t]*\r?$/mu,
  );
  const run = (step) => {
    const commands = [...step.matchAll(/^ {8}run: ([^\r\n]+)$/gmu)];
    assert.equal(commands.length, 1, "expected one executable run command");
    return commands[0][1];
  };
  assert.equal(run(install), "npm ci --no-audit");
  assert.doesNotMatch(install, /^ {8}working-directory:/mu);
  assert.ok(
    steps.indexOf(install) < steps.indexOf(policy),
    "install before tests",
  );
  assert.deepEqual(
    [...policy.matchAll(/^ {8}working-directory: ([^\r\n]+)$/gmu)].map(
      (match) => match[1],
    ),
    ["."],
    "helper tests must run from the repository root",
  );
  const command = run(policy);
  assert.match(
    command,
    /^node --test(?: scripts\/[a-z0-9_./-]+\.test\.mjs)+$/u,
  );
  const files = command.split(" ").slice(2);
  for (const required of [
    "scripts/android_dev.test.mjs",
    "scripts/model_ci_coverage.test.mjs",
  ]) {
    assert.equal(files.filter((file) => file === required).length, 1, required);
  }
  return { install, policy, job };
}

test("frontend CI executes Android launcher regressions after installation on unfiltered PR and published-branch events", () => {
  assertAndroidDevFrontendGate(read(".github/workflows/frontend.yaml"));
});

test("Android launcher CI coverage rejects missing, commented, misplaced and non-enforcing steps", () => {
  const current = read(".github/workflows/frontend.yaml").replaceAll(
    "\r\n",
    "\n",
  );
  // Seed the positive fixture even before a missing shipped selection is fixed.
  const positive = current.includes(" scripts/android_dev.test.mjs")
    ? current
    : current.replace(
        "run: node --test ",
        "run: node --test scripts/android_dev.test.mjs ",
      );
  const { install, policy, job } = assertAndroidDevFrontendGate(positive);
  const mutants = [
    positive.replace(" scripts/android_dev.test.mjs", ""),
    positive.replace(
      policy,
      policy.replace("run: node --test ", "# run: node --test "),
    ),
    positive.replace(
      policy,
      policy.replace("working-directory: .", "working-directory: frontend"),
    ),
    positive.replace(
      policy,
      policy.replace("        working-directory: .\n", ""),
    ),
    positive
      .replace(install, "__INSTALL__")
      .replace(policy, install)
      .replace("__INSTALL__", policy),
    positive.replace(policy, policy + "        continue-on-error: true\n"),
    positive.replace(policy, policy + "        if: false\n"),
    positive.replace(
      policy,
      policy.replace(/(run: node --test[^\n]+)/u, "$1 || true"),
    ),
    positive.replace(policy, policy + "        shell: bash {0}\n"),
    positive.replace(
      job,
      job.replace("    runs-on:", "    continue-on-error: true\n    runs-on:"),
    ),
    positive.replace(
      job,
      job.replace("if: needs.changes.outputs.frontend == 'true'", "if: false"),
    ),
    positive.replace(
      "  pull_request:\n",
      '  pull_request:\n    paths: ["frontend/**"]\n',
    ),
    positive.replace(
      "  push:\n",
      '  push:\n    paths-ignore: ["scripts/**"]\n',
    ),
    positive.replace("      - master\n", "      - other-branch\n"),
    positive.replaceAll("      - main\n", ""),
    positive.replace(
      install,
      install.replace(
        "        run: npm ci --no-audit",
        "        # run: npm ci --no-audit",
      ),
    ),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, positive, "mutation must alter workflow " + index);
    assert.throws(
      () => assertAndroidDevFrontendGate(mutant),
      "mutation " + index,
    );
  }
});

// Inspect actual executable run fields, not comments or step names. These
// workflows intentionally use literal npm ci commands: reject alternate install
// syntax or appended flags rather than guessing their shell precedence.
function assertAuditFreeInstalls(text, expectedJobs) {
  const jobs = mappingBlock(text.replaceAll("\r\n", "\n"), "jobs", 0);
  const observed = [];
  for (const [, jobName] of jobs.matchAll(/^ {2}([a-z0-9-]+):[ \t]*$/gmu)) {
    const steps = mappingBlock(mappingBlock(jobs, jobName, 2), "steps", 4);
    for (const step of steps.split(/^ {6}- /mu).slice(1)) {
      const commands = [...step.matchAll(/^(?:run:| {8}run:) ([^\n]*)$/gmu)];
      for (const command of commands) {
        const tail = step.slice(command.index + command[0].length);
        const continuation = tail
          .split("\n")
          .slice(1)
          .filter((line) => /^ {10}\S/u.test(line));
        const executable = [command[1], ...continuation]
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        if (!/\bnpm\s+(?:ci|install|i)\b/u.test(executable)) continue;
        assert.equal(executable, "npm ci --no-audit", jobName);
        observed.push(jobName);
      }
    }
  }
  assert.deepEqual(observed.sort(), [...expectedJobs].sort());
}

test("automatic frontend installs explicitly disable implicit npm audits", () => {
  assertAuditFreeInstalls(read(".github/workflows/frontend.yaml"), [
    "checks",
    "build",
  ]);
  assertAuditFreeInstalls(workflow, [
    "dependency-policy",
    "frontend-contracts",
  ]);
  assertAuditFreeInstalls(
    read(".github/workflows/openchat_pr2_security.yaml"),
    ["dependency-security"],
  );
});

function assertOptionalNodeDownloadsSkipped(text, expectedJobs, indent = 2) {
  const jobs = mappingBlock(text.replaceAll("\r\n", "\n"), "jobs", 0);
  const observed = [];
  const jobPattern = new RegExp(`^ {${indent}}([a-z0-9-]+):[ \\t]*$`, "gmu");
  const stepPattern = new RegExp(`^ {${3 * indent}}- `, "mu");
  const runPattern = new RegExp(
    `^(?:run:| {${3 * indent + 2}}run:) ([^\\n]*)$`,
    "gmu",
  );
  const continuationPattern = new RegExp(`^ {${4 * indent + 2},}\\S`, "u");
  for (const [, jobName] of jobs.matchAll(jobPattern)) {
    const steps = mappingBlock(
      mappingBlock(jobs, jobName, indent),
      "steps",
      2 * indent,
    );
    for (const step of steps.split(stepPattern).slice(1)) {
      for (const command of step.matchAll(runPattern)) {
        const continuation = step
          .slice(command.index + command[0].length)
          .split("\n")
          .slice(1)
          .filter((line) => continuationPattern.test(line));
        const executable = [command[1], ...continuation]
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        if (!/\bnpm\s+(?:ci|install|i)\b/u.test(executable)) continue;
        assert.equal(executable, "npm ci --no-audit", jobName);
        const env = mappingBlock(step, "env", 3 * indent + 2);
        assert.equal(env.trim(), 'ONNXRUNTIME_NODE_INSTALL: "skip"', jobName);
        observed.push(jobName);
      }
    }
  }
  assert.deepEqual(observed.sort(), [...expectedJobs].sort());
}

test("feature installs skip unused ONNX Node GPU downloads without disabling lifecycle scripts", () => {
  assertOptionalNodeDownloadsSkipped(read(".github/workflows/frontend.yaml"), [
    "checks",
    "build",
  ]);
  assertOptionalNodeDownloadsSkipped(workflow, [
    "dependency-policy",
    "frontend-contracts",
  ]);
  assertOptionalNodeDownloadsSkipped(
    read(".github/workflows/android_release.yaml"),
    ["build-android"],
  );
  assertOptionalNodeDownloadsSkipped(
    read(".github/workflows/openchat_pr2_security.yaml"),
    ["dependency-security"],
  );
});

test("optional Node download setting rejects absent, wrong, commented, duplicated and misplaced configuration", () => {
  const fixture = [
    "jobs:",
    "  install:",
    "    steps:",
    "      - name: Install",
    "        env:",
    '          ONNXRUNTIME_NODE_INSTALL: "skip"',
    "        run: npm ci --no-audit",
    "",
  ].join("\n");
  assertOptionalNodeDownloadsSkipped(fixture, ["install"]);
  const setting = '          ONNXRUNTIME_NODE_INSTALL: "skip"';
  const mutants = [
    fixture.replace("        env:\n" + setting + "\n", ""),
    fixture.replace('"skip"', '"true"'),
    fixture.replace(setting, '          # ONNXRUNTIME_NODE_INSTALL: "skip"'),
    fixture.replace(setting, setting + "\n" + setting),
    fixture.replace("        env:", "        # env:"),
    fixture.replace(
      "        run: npm ci --no-audit",
      "      - name: Other\n        run: npm ci --no-audit",
    ),
    fixture.replace("npm ci --no-audit", "npm ci --no-audit --ignore-scripts"),
    ...[
      "npm ci",
      "npm install --no-audit",
      "npm ci --no-audit --ignore-scripts",
    ].map((command) => fixture + "      - run: " + command + "\n"),
    fixture + "      - run: |\n          npm ci\n",
    fixture +
      "      - run: |\n          if true; then\n            npm ci\n          fi\n",
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, fixture, "mutation must alter workflow " + index);
    assert.throws(
      () => assertOptionalNodeDownloadsSkipped(mutant, ["install"]),
      "mutation " + index,
    );
  }
});

test("implicit-audit coverage rejects missing, overridden, commented and alternate installs", () => {
  const fixture = [
    "jobs:",
    "  install:",
    "    steps:",
    "      - name: Install",
    "        run: npm ci --no-audit",
    "",
  ].join("\n");
  assertAuditFreeInstalls(fixture, ["install"]);
  const mutants = [
    fixture.replace(" --no-audit", ""),
    fixture.replace("--no-audit", "--audit=false --audit=true"),
    fixture.replace("--no-audit", "--no-audit --audit"),
    fixture.replace("npm ci", "npm install"),
    fixture.replace("npm ci", "npm i"),
    fixture.replace("        run:", "        # run:"),
    fixture.replace(
      "npm ci --no-audit",
      "|\n          npm ci\n          # --no-audit",
    ),
    fixture.replace(
      "npm ci --no-audit",
      "|\n          npm ci --no-audit\n          npm ci",
    ),
    fixture + "      - run: npm ci\n",
    fixture + "      - run: npm ci --no-audit\n",
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, fixture, "mutation must alter workflow " + index);
    assert.throws(
      () => assertAuditFreeInstalls(mutant, ["install"]),
      "mutation " + index,
    );
  }
});

function pullRequestPaths(text) {
  const events = mappingBlock(text, "on", 0);
  const pullRequest = mappingBlock(events, "pull_request", 2);
  const paths = mappingBlock(pullRequest, "paths", 4);
  return paths
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^ {6}- ("[^"]+")$/u.exec(line);
      assert.ok(match, `unsupported PR path entry: ${line}`);
      return JSON.parse(match[1]);
    });
}

// The workflow deliberately uses only positive literal paths, * and **. Keep
// this matcher limited to that syntax instead of silently guessing other globs.
function pathPattern(pattern) {
  assert.match(pattern, /^[a-zA-Z0-9_./*-]+$/u);
  let expression = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.slice(i, i + 3) === "**/") {
      expression += "(?:.*/)?";
      i += 2;
    } else if (pattern.slice(i, i + 2) === "**") {
      expression += ".*";
      i += 1;
    } else if (pattern[i] === "*") {
      expression += "[^/]*";
    } else {
      expression += pattern[i] === "." ? "\\." : pattern[i];
    }
  }
  return new RegExp(`^${expression}$`, "u");
}

function modelTestFilters(text) {
  const jobs = mappingBlock(text, "jobs", 0);
  const job = mappingBlock(jobs, "frontend-contracts", 2);
  const command = /\n {8}run: >-\r?\n((?: {10}[^\r\n]+\r?\n?)+)/u.exec(job);
  assert.ok(command, "missing folded model test command");
  const words = command[1].trim().split(/\s+/u);
  assert.deepEqual(words.splice(0, 3), ["npm", "test", "--"]);
  assert.ok(words.length, "model test command has no path filters");
  return words;
}

function sourceFiles(path) {
  return readdirSync(join(root, "frontend", path), {
    withFileTypes: true,
  }).flatMap((entry) => {
    if (
      ["node_modules", "build", ".git", "model-overrides"].includes(entry.name)
    ) {
      return [];
    }
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(child) : [child];
  });
}

// Discover current and future tests by model-owned naming families, not a frozen
// list of today's filenames. App-authored action/OCR suites remain in full CI.
const modelFamily =
  /\/(?:customModels|onDeviceModels|model|onDeviceInference|nativeInferenceRuntimeBridge|webInference|webGpuModelCatalog|transformersWebGpu|gemma4WebGpu|WebInferenceRuntimeSettings|WebGpuModelCatalog|localAi|localAudioInput|configuredLocalBlobUrl|localImageInput|imageDimensions|inferenceImage|publicBlob|publicKeyBuild|rollup-plugin-wasm-url|bootstrapSecurity)[^/]*\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const candidateFiles = [
  ...sourceFiles("app"),
  ...sourceFiles("openchat-agent/src/services/storageBucket"),
];
const inventory = candidateFiles.filter((path) => modelFamily.test(path));
const filters = modelTestFilters(workflow);
const patterns = pullRequestPaths(workflow).map(pathPattern);
const triggers = (path) => patterns.some((pattern) => pattern.test(path));

test("the model CI selects every discovered local-model frontend test", () => {
  assert.ok(inventory.length, "model test inventory is empty");
  assert.ok(
    inventory.includes("app/src/utils/nativeInferenceRuntimeBridge.spec.ts"),
  );
  const missed = inventory.filter(
    (path) => !filters.some((filter) => path.includes(filter)),
  );
  assert.deepEqual(missed, [], `unselected model tests:\n${missed.join("\n")}`);
});

for (const family of [
  "app/src/utils/webGpuModelCatalog",
  "app/src/components_shared/WebGpuModelCatalogSettings",
]) {
  test(`catalog suite cannot disappear from model CI: ${family}`, () => {
    const suite = `${family}.spec.ts`;
    assert(inventory.includes(suite), "catalog suite missing from discovery");
    const removed = filters.filter((filter) => !suite.includes(filter));
    const missed = inventory.filter(
      (path) => !removed.some((filter) => path.includes(filter)),
    );
    assert(
      missed.includes(suite),
      "missing catalog selection must be detected",
    );
  });
}

test("model selectors are literal Vitest path prefixes that include future sibling tests", () => {
  for (const filter of filters) {
    assert.match(
      filter,
      /^(?:app|openchat-agent\/src\/services\/storageBucket)\/[a-zA-Z0-9_./-]+$/u,
    );
    assert.doesNotMatch(filter, /\.(?:spec|test)\./u);
    assert.ok(
      candidateFiles.some((path) => path.includes(filter)),
      `unused filter: ${filter}`,
    );
  }
  for (const path of inventory) {
    const sibling = path.replace(
      /\.(?:spec|test)\./u,
      ".future-regression.spec.",
    );
    assert.ok(
      filters.some((filter) => sibling.includes(filter)),
      sibling,
    );
  }
});

test("Vitest includes and excludes admit every discovered model suite", () => {
  const config = read("frontend/vitest.config.ts");
  const configuredPatterns = (field) => {
    const blocks = [
      ...config.matchAll(new RegExp(`^ +${field}: \\[([^\\]]*)\\]`, "gmu")),
    ];
    assert.equal(blocks.length, 1, `expected one literal Vitest ${field} list`);
    const list = blocks[0][1];
    assert.equal(list.replace(/"[^"]*"/gu, "").replace(/[,\s]/gu, ""), "");
    return [...list.matchAll(/"([^"]+)"/gu)].flatMap((match) => {
      // This is the only brace expansion used by the repository test config.
      // Any future glob syntax must be supported explicitly, not silently ignored.
      const pattern = match[1];
      return pattern.includes("{test,spec}")
        ? ["test", "spec"].map((kind) =>
            pathPattern(pattern.replace("{test,spec}", kind)),
          )
        : [pathPattern(pattern)];
    });
  };
  const includes = configuredPatterns("include");
  const excludes = configuredPatterns("exclude");
  for (const path of inventory) {
    assert.ok(
      includes.some((pattern) => pattern.test(path)),
      `Vitest does not discover ${path}`,
    );
    assert.ok(
      !excludes.some((pattern) => pattern.test(path)),
      `Vitest excludes ${path}`,
    );
  }
});

test("every discovered model test triggers the model pull-request workflow", () => {
  const missed = inventory.filter((path) => !triggers(`frontend/${path}`));
  assert.deepEqual(
    missed,
    [],
    `model tests missing PR coverage:\n${missed.join("\n")}`,
  );
});

test("model runtime, workers, helpers, UI, build, notices and policy inputs trigger on pull requests", () => {
  for (const path of [
    "frontend/app/src/utils/webInference.ts",
    "frontend/app/src/utils/nativeInferenceRuntimeBridge.spec.ts",
    "frontend/app/src/utils/imageDimensions.ts",
    "frontend/app/src/utils/inferenceImage.ts",
    "frontend/app/.ic-assets.json5",
    "frontend/vite-env.d.ts",
    "frontend/global.d.ts",
    "frontend/app/src/components/home/MessageEntry.svelte",
    "frontend/app/src/components_mobile/home/MessageEntry.svelte",
    "frontend/app/src/utils/localAudioInput.ts",
    "frontend/app/src/utils/configuredLocalBlobUrl.ts",
    "frontend/openchat-agent/src/services/storageBucket/publicBlob.ts",
    "frontend/openchat-agent/src/services/storageBucket/storageBucket.client.ts",
    "frontend/openchat-client/src/openchat.ts",
    "frontend/openchat-worker/src/worker.ts",
    "frontend/openchat-shared/src/domain/worker.ts",
    "frontend/openchat-agent/src/services/openchatAgent.ts",
    "frontend/app/src/utils/transformersWebGpuInference.ts",
    "frontend/app/src/utils/transformersWebGpuArtifactTransform.ts",
    "frontend/app/src/utils/transformersWebGpuAudio.ts",
    "frontend/app/src/utils/transformersWebGpuDeviceRetirement.ts",
    "frontend/app/src/utils/gemma4WebGpuEmbedding.ts",
    "frontend/app/src/workers/transformersWebGpuInference.worker.ts",
    "frontend/app/src/stores/onDeviceModels.ts",
    "frontend/app/src/stores/transformersWebGpuSettings.ts",
    "frontend/app/src/components/home/profile/ModelManager.svelte",
    "frontend/app/src/components_mobile/home/user_profile/ModelManager.svelte",
    "frontend/app/src/components_shared/WebInferenceRuntimeSettings.svelte",
    "frontend/app/src/components_shared/WebGpuModelCatalogSettings.svelte",
    "frontend/app/src/utils/webGpuModelCatalog.ts",
    "frontend/app/src/stores/webGpuModelCatalog.ts",
    "frontend/app/public/model-catalog.json",
    "frontend/openchat-shared/src/domain/onDeviceModel.ts",
    "frontend/openchat-agent/src/services/registry/modelCatalog.ts",
    "frontend/app/transformersWebGpuFeatureFlag.mjs",
    "frontend/app/transformersWebGpuDecoderGraph.mjs",
    "frontend/app/transformersWebGpuMropeGraph.mjs",
    "frontend/app/transformersWebGpuDeepStackGraph.mjs",
    "frontend/app/transformersWebGpuSequentialSessions.mjs",
    "frontend/app/transformersWebGpuQwenGenerationGraph.mjs",
    "frontend/app/transformersWebGpuQwenGenerationRuntime.mjs",
    "frontend/app/transformersWebGpuQwenVisionGraph.mjs",
    "frontend/app/transformersWebGpuQwenVisionGeometry.mjs",
    "frontend/app/transformersWebGpuQwenVisionSession.mjs",
    "frontend/app/transformersWebGpuOrtSessionConfig.mjs",
    "frontend/app/src/utils/fixtures/qwenVisionGeometry.native.json",
    "frontend/app/build-workers.mjs",
    "frontend/app/rollup.config.mjs",
    "frontend/app/rollup.extras.mjs",
    "frontend/app/rollup-plugin-wasm-url.mjs",
    "frontend/app/modelAssetNotices.mjs",
    ".gitattributes",
    "frontend/app/model-asset-notices/sources.json",
    "frontend/app/model-asset-notices/MODEL_MODIFICATIONS.md",
    "frontend/vitest.config.ts",
    "frontend/app/vitest.config.ts",
    "frontend/tauri-plugin-oc/src/model_manager.rs",
    "scripts/check_openchat_pr1_security.mjs",
    "scripts/security_dependency_hash.mjs",
    "scripts/security_dependency_hash.test.mjs",
    "scripts/security_owned_rules.mjs",
    "scripts/security_owned_rules.test.mjs",
    "scripts/sbom_lock_identity.mjs",
    "scripts/sbom_lock_identity.test.mjs",
    "scripts/frontend_format_check.mjs",
    "scripts/frontend_format_check.test.mjs",
    "scripts/frontend_format_inherited.mjs",
    "scripts/frontend_format_inherited.json",
    "scripts/frontend_format_inherited.test.mjs",
    "frontend/app/publicKeyBuild.mjs",
    "frontend/app/src/publicKeyBuild.spec.ts",
    "scripts/model_ci_coverage.test.mjs",
    "scripts/model_asset_notices.test.mjs",
    "scripts/verify_webgpu_distribution.mjs",
    "scripts/android_dev.mjs",
    "scripts/android_bundle.test.mjs",
    "scripts/android_build_prerequisites.test.mjs",
    "dfx.json",
    ".github/workflows/android_release.yaml",
    ".github/security/openchat-pr1-security-baseline.json",
    ".github/security/openchat-pr2-security-baseline.json",
    ".github/workflows/frontend.yaml",
  ]) {
    assert.ok(existsSync(join(root, path)), `stale coverage fixture: ${path}`);
    assert.ok(triggers(path), `model PR workflow is not triggered by ${path}`);
  }
  for (const path of [
    "docs/unrelated-guide.md",
    "backend/canisters/user/impl/src/lib.rs",
    "frontend/app/src/utils/navigation.ts",
  ]) {
    assert.ok(
      !triggers(path),
      `model paths became unnecessarily broad: ${path}`,
    );
  }
});

test("coverage extraction cannot use patterns from push or job text", () => {
  const text =
    'on:\n  pull_request:\n    paths:\n      - "unrelated/**"\n  push:\n    paths:\n      - "frontend/**"\njobs:\n  example:\n    paths:\n      - "frontend/**"\n';
  assert.deepEqual(pullRequestPaths(text), ["unrelated/**"]);
  assert.ok(
    !pullRequestPaths(text)
      .map(pathPattern)
      .some((pattern) =>
        pattern.test("frontend/app/src/utils/webInference.ts"),
      ),
  );
});

test("the limited PR glob matcher preserves path-segment and globstar boundaries", () => {
  assert.ok(
    pathPattern("frontend/**/package.json").test("frontend/package.json"),
  );
  assert.ok(
    pathPattern("frontend/**/package.json").test("frontend/app/package.json"),
  );
  assert.ok(
    pathPattern("frontend/app/src/components*/**/ModelManager.svelte").test(
      "frontend/app/src/components_mobile/home/user_profile/ModelManager.svelte",
    ),
  );
  assert.ok(
    !pathPattern("frontend/app/src/utils/model*").test(
      "frontend/app/src/utils/models/unrelated.ts",
    ),
  );
  assert.throws(() => pathPattern("!frontend/**"));
});

test("normal frontend CI runs this coverage regression as a policy test", () => {
  const frontend = read(".github/workflows/frontend.yaml");
  const policyStep = frontend
    .split("- name: Check PR and release policy regressions")[1]
    ?.split(/\n {6}- /u)[0];
  assert.ok(policyStep, "missing frontend policy test step");
  assert.match(
    policyStep,
    /run: node --test [^\r\n]*\bscripts\/model_ci_coverage\.test\.mjs(?:\s|$)/u,
  );
});

function requireUnofficialLocalBuild(frontend) {
  const build = mappingBlock(mappingBlock(frontend, "jobs", 0), "build", 2);
  const step = build
    .split(
      "- name: Build and verify the optimized unofficial local web client",
    )[1]
    ?.split(/\n {6}- /u)[0];
  assert.ok(step, "missing actual unofficial profile build");
  assert.doesNotMatch(step, /\bif:|\bcontinue-on-error:|\bshell:|\benv:/u);
  assert.match(step, /^ {8}working-directory: \.$/mu);
  assert.match(step, /^ {8}run: \|$/mu);
  const lines = step
    .split("run: |\n")[1]
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  assert.deepEqual(lines, [
    'unofficial_output="$(mktemp -d "${RUNNER_TEMP:?}/openchat-unofficial-web.XXXXXX")"',
    'node scripts/build-unofficial-local-web.mjs --output "$unofficial_output" --port 5194 --layout v2',
    `node --input-type=module -e 'import { loadLocalWebBuild } from "./scripts/preview-unofficial-local-web.mjs"; loadLocalWebBuild(process.argv[1]);' "$unofficial_output"`,
    'node scripts/verify_webgpu_distribution.mjs "$unofficial_output"',
  ]);
  assert.ok(
    build.indexOf("Build and verify the opt-in production WebGPU candidate") <
      build.indexOf(
        "Build and verify the optimized unofficial local web client",
      ),
  );
  const changes = mappingBlock(mappingBlock(frontend, "jobs", 0), "changes", 2);
  for (const filename of ["Cargo.lock", "rust-toolchain.toml", "dfx.json"])
    assert.ok(
      changes.includes(`- "${filename}"`),
      `missing ${filename} policy trigger`,
    );
}

test("frontend CI builds the actual optimized unofficial profile and verifies its artifact without deploy", () => {
  const frontend = read(".github/workflows/frontend.yaml");
  requireUnofficialLocalBuild(frontend);
  for (const [from, to] of [
    ["--layout v2", "--layout v1"],
    ["--port 5194", "--port 8080"],
    [
      'mktemp -d "${RUNNER_TEMP:?}/openchat-unofficial-web.XXXXXX"',
      "mktemp -d",
    ],
    ["loadLocalWebBuild(process.argv[1]);", "void process.argv[1];"],
    [
      'node scripts/verify_webgpu_distribution.mjs "$unofficial_output"',
      "true",
    ],
    ...["Cargo.lock", "rust-toolchain.toml", "dfx.json"].map((name) => [
      `- "${name}"`,
      "# missing trigger",
    ]),
  ])
    assert.throws(() =>
      requireUnofficialLocalBuild(frontend.replace(from, to)),
    );
});

test("legacy workspace commands and fixed filenames cannot replace prefix discovery", () => {
  const legacy =
    "jobs:\n  frontend-contracts:\n    steps:\n      - name: Run model tests\n        run: >-\n          npm --workspace app test --\n          src/utils/modelCatalog.spec.ts\n";
  assert.throws(() => modelTestFilters(legacy));
  assert.doesNotMatch(workflow, /npm --workspace app/u);
});

test("native CI compiles both app feature sets on both supported runner platforms", () => {
  const jobs = mappingBlock(workflow, "jobs", 0);
  const native = mappingBlock(jobs, "native-hermetic", 2);
  assert.match(native, /os: \[ubuntu-24\.04, windows-2022\]/u);
  assert.equal(
    [
      ...native.matchAll(
        /^ +cargo check --locked -p open-chat --features inference\r?$/gmu,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...native.matchAll(
        /^ +cargo check --locked -p open-chat --features inference,store\r?$/gmu,
      ),
    ].length,
    2,
  );
  assert.doesNotMatch(native, /cargo check (?:--locked )?-p tauri-plugin-oc/u);
  assert.match(native, /cargo test --locked -p tauri-plugin-oc --lib/u);
});

test("all six native source-compiling CI commands enforce the committed Cargo lockfile", () => {
  const commands = [
    ...workflow.matchAll(/^ +(?:run: )?(cargo (?:test|check) [^\r\n]+)\r?$/gmu),
  ].map((match) => match[1]);
  assert.equal(
    commands.length,
    6,
    "review every added or removed native Cargo invocation",
  );
  assert.deepEqual(commands, [
    "cargo test --locked -p tauri-plugin-oc --lib",
    "cargo check --locked -p open-chat --features inference",
    "cargo check --locked -p open-chat --features inference,store",
    "cargo check --locked -p open-chat --features inference",
    "cargo check --locked -p open-chat --features inference,store",
    "cargo test --locked -p tauri-plugin-oc --features inference",
  ]);
  const jobs = mappingBlock(workflow, "jobs", 0);
  const fixture = mappingBlock(jobs, "real-text-inference", 2);
  const native = mappingBlock(jobs, "native-hermetic", 2);
  assert.equal(
    [...(native + fixture).matchAll(/\bcargo\b/gu)].length,
    commands.length,
    "review native Cargo calls outside the supported command-line shape",
  );
  assert.match(
    fixture,
    /cargo test --locked -p tauri-plugin-oc --features inference/u,
  );
  assert.match(
    fixture,
    /inference::tests::text_inference_smoke --\s+--ignored --exact --nocapture/u,
  );
  // This fixture downloads an immutable model; it compiles the repository, not
  // a temporary Cargo project whose lockfile intentionally needs generating.
  assert.doesNotMatch(fixture, /cargo (?:generate-lockfile|update)\b/u);
});

test("the frontend build runs a read-only lint check", () => {
  const manifest = JSON.parse(read("frontend/package.json"));
  assert.equal(manifest.scripts["lint:check"], "eslint .");
  assert.match(
    manifest.scripts["check:ci"],
    /(?:^|&&)\s*npm run lint:check(?:\s*&&|$)/u,
  );
  assert.doesNotMatch(manifest.scripts["build:ci"], /\bnpm run lint(?:\s|$)/u);
  assert.doesNotMatch(manifest.scripts["check:ci"], /\bnpm run lint(?:\s|$)/u);
  assert.equal(
    manifest.scripts["build:ci"],
    "npm run check:ci && npm run build:prod",
  );
  assert.doesNotMatch(manifest.scripts["lint:check"], /--fix/u);
  assert.match(
    read(".github/workflows/frontend.yaml"),
    /run: npm run check:ci/u,
  );
});

test("frontend policy invokes the exact current-client and retained release regressions", () => {
  const step = read(".github/workflows/frontend.yaml")
    .split("- name: Check PR and release policy regressions")[1]
    ?.split(/\n {6}- /u)[0];
  assert.ok(step);
  const command = /run: node --test ([^\r\n]+)/u.exec(step);
  assert.ok(command);
  const files = command[1].trim().split(/\s+/u);
  assert.deepEqual(files, [
    "scripts/unofficial-client-ci.test.mjs",
    "scripts/validate_action_inbox_wiring.test.mjs",
    "scripts/android_release_policy.test.mjs",
    "scripts/android_release_checks.test.mjs",
    "scripts/release_preflight.test.mjs",
    "scripts/android_bundle.test.mjs",
    "scripts/android_build_prerequisites.test.mjs",
    "scripts/frontend_format_check.test.mjs",
    "scripts/frontend_format_inherited.test.mjs",
    "scripts/android_dev.test.mjs",
    "scripts/verify_webgpu_distribution.test.mjs",
    "scripts/model_asset_notices.test.mjs",
    "scripts/sbom_lock_identity.test.mjs",
    "scripts/model_ci_coverage.test.mjs",
    "scripts/security_mode_scope.test.mjs",
  ]);
  for (const path of files) assert.ok(existsSync(join(root, path)), path);
});

test("historical dependency hash proofs run in the full-history security checkout", () => {
  const jobs = mappingBlock(workflow, "jobs", 0);
  const policy = mappingBlock(jobs, "dependency-policy", 2);
  assert.match(policy, /fetch-depth: 0/u);
  assert.match(
    policy,
    /run: node --test scripts\/security_dependency_hash\.test\.mjs/u,
  );
  assert.doesNotMatch(
    mappingBlock(jobs, "frontend-contracts", 2),
    /security_dependency_hash\.test\.mjs/u,
  );
  assert.doesNotMatch(
    read(".github/workflows/frontend.yaml"),
    /security_dependency_hash\.test\.mjs/u,
  );
});

const compatibilityScripts = [
  "scripts/cdp_axios_compatibility.mjs",
  "scripts/decoder_compatibility.mjs",
  "scripts/onnx_adm_zip_compatibility.mjs",
  "scripts/transformers_sharp_compatibility.mjs",
];

test("CI separately builds and verifies the opt-in WebGPU production candidate", () => {
  const frontend = read(".github/workflows/frontend.yaml");
  const name =
    "- name: Build and verify the opt-in production WebGPU candidate";
  const candidate = frontend.split(name)[1]?.split(/\n {6}- /u)[0];
  assert.ok(candidate, "missing real production WebGPU packaging gate");
  assert.match(candidate, /npm run build:prod/u);
  assert.match(
    candidate,
    /node \.\.\/scripts\/verify_webgpu_distribution\.mjs app\/build/u,
  );
  assert.match(candidate, /OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true"/u);
  assert.match(
    candidate,
    /OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: immutable-hub-v1/u,
  );
  assert.doesNotMatch(
    candidate,
    /continue-on-error|\|\|\s*true|npm (?:install|update)|deploy/u,
  );
  const standard = frontend
    .split("- name: Build frontend")[1]
    ?.split(/\n {6}- /u)[0];
  assert.ok(standard);
  assert.match(standard, /npm run build:prod/u);
  assert.doesNotMatch(standard, /OC_TRANSFORMERS_WEBGPU_/u);
  assert.ok(
    frontend.indexOf("run: npm run build:prod") < frontend.indexOf(name),
  );
});

test("frontend checks cover fork main with read-only repository permissions", () => {
  const frontend = read(".github/workflows/frontend.yaml");
  const events = mappingBlock(frontend, "on", 0);
  const push = mappingBlock(events, "push", 2);
  for (const branch of ["main"]) {
    assert.match(push, new RegExp(`^ +- ${branch}\\r?$`, "mu"));
  }
  assert.match(
    mappingBlock(frontend, "permissions", 0),
    /^ +contents: read\r?$/mu,
  );
  assert.doesNotMatch(frontend, /contents: write/u);
});

test("frontend CI runs every scoped dependency contract against the frozen install", () => {
  const frontend = read(".github/workflows/frontend.yaml");
  const jobs = mappingBlock(frontend, "jobs", 0);
  const job = mappingBlock(jobs, "build", 2);
  const stepName = "- name: Verify narrowly scoped dependency compatibility";
  const step = job.split(stepName)[1]?.split(/\n {6}- /u)[0];
  assert.ok(step, "missing installed-parent compatibility step");
  assert.match(step, /working-directory: \./u);
  const commands = [
    ...step.matchAll(/^ +node (scripts\/[^\s]+\.mjs)\r?$/gmu),
  ].map((match) => match[1]);
  assert.deepEqual(commands, compatibilityScripts);
  const install = job.indexOf("run: npm ci");
  const compatibility = job.indexOf(stepName);
  const build = job.indexOf("run: npm run build:prod");
  assert.ok(install > 0 && compatibility > install && build > compatibility);
  assert.doesNotMatch(step, /continue-on-error|\|\|\s*true|--ignore-scripts/u);
  assert.doesNotMatch(job, /run: npm (?:install|update|audit fix)\b/u);
  assert.match(job, /node-version: "24\.18\.1"/u);
});

test("every scoped dependency contract exists and triggers the model PR workflow", () => {
  for (const path of compatibilityScripts) {
    assert.ok(
      existsSync(join(root, path)),
      `missing compatibility script: ${path}`,
    );
    assert.ok(
      triggers(path),
      `compatibility script does not trigger CI: ${path}`,
    );
  }
});

test("Node image and installer fixes stay scoped to their reviewed model parents", () => {
  const manifest = JSON.parse(read("frontend/package.json"));
  const lock = JSON.parse(read("frontend/package-lock.json"));
  const overrides = manifest.overrides;
  assert.equal(manifest.dependencies["@huggingface/transformers"], "4.2.0");
  for (const [parent, dependency, version] of [
    ["@huggingface/transformers@4.2.0", "sharp", "0.35.4"],
    ["onnxruntime-node@1.24.3", "adm-zip", "0.6.1"],
  ]) {
    assert.deepEqual(overrides[parent], { [dependency]: version });
    assert.equal(Object.hasOwn(overrides, dependency), false);
    assert.equal(
      Object.hasOwn(overrides, parent.slice(0, parent.lastIndexOf("@"))),
      false,
    );
  }
  assert.equal(lock.packages["node_modules/adm-zip"].version, "0.6.1");
  assert.equal(
    lock.packages["node_modules/onnxruntime-node"].version,
    "1.24.3",
  );
  assert.equal(
    lock.packages["node_modules/onnxruntime-node"].dependencies["adm-zip"],
    "^0.5.16",
    "The explicit parent-scoped override, not an invented parent range, selects the patch",
  );
  assert.equal(
    lock.packages["node_modules/@huggingface/transformers"].version,
    "4.2.0",
  );
});

function assertCurrentAndroidSdkPackages(text) {
  const job = mappingBlock(
    mappingBlock(text, "jobs", 0),
    "android-component-contracts",
    2,
  );
  const steps = mappingBlock(job, "steps", 4);
  const setup = steps
    .split(/(?=^      - )/mu)
    .filter((step) =>
      /^        uses: android-actions\/setup-android@v3\r?$/mu.test(step),
    );
  assert.equal(setup.length, 1, "review the component SDK setup action");
  const inputs = mappingBlock(setup[0], "with", 8);
  assert.match(inputs, /^          packages: platform-tools\r?$/mu);
  assert.equal((inputs.match(/^          packages:/gmu) ?? []).length, 1);
}

test("component SDK setup explicitly excludes the deprecated tools package", () => {
  assertCurrentAndroidSdkPackages(workflow);
  // setup-android v3 defaults to "tools platform-tools" when packages is
  // omitted. The action itself bootstraps cmdline-tools before this input.
  for (const replacement of [
    "",
    "          packages: tools platform-tools",
    "          packages: ''",
  ]) {
    const mutant = workflow.replace(
      "          packages: platform-tools",
      replacement,
    );
    assert.notEqual(mutant, workflow);
    assert.throws(() => assertCurrentAndroidSdkPackages(mutant));
  }
});

test("Android component identity compiles actual sources against host fixtures and SDK 36 in PR CI", () => {
  const job = mappingBlock(
    mappingBlock(workflow, "jobs", 0),
    "android-component-contracts",
    2,
  );
  assert.match(job, /runs-on: ubuntu-24\.04/u);
  assert.match(job, /timeout-minutes: 15/u);
  assert.match(job, /java-version: "21"/u);
  assert.match(job, /node-version: "24\.18\.1"/u);
  assert.match(job, /sdkmanager "platforms;android-36"/u);
  assert.match(job, /shell: pwsh/u);
  assert.match(
    job,
    /run: node --test scripts\/android_component_identity_tools\.test\.mjs scripts\/model_ci_coverage\.test\.mjs/u,
  );
  assert.match(
    job,
    /node scripts\/android_component_identity_tools\.mjs --output-directory "\$env:RUNNER_TEMP\/openchat-component-tools"/u,
  );
  assert.match(
    job,
    /& \.\/frontend\/tauri-plugin-oc\/android\/component-identity-tests\/run\.ps1/u,
  );
  for (const argument of [
    "-JavaHome $env:JAVA_HOME",
    "-KotlinCompilerClasspath $tools.compilerClasspath",
    "-KotlinRuntimeClasspath $tools.runtimeClasspath",
    "-JUnitClasspath $tools.junitClasspath",
    '-AndroidJar "$env:ANDROID_HOME/platforms/android-36/android.jar"',
    '-OutputDirectory "$env:RUNNER_TEMP/openchat-component-classes"',
  ])
    assert.ok(
      job.includes(argument),
      `missing actual runner input: ${argument}`,
    );
  assert.equal(
    [...job.matchAll(/if \(\$LASTEXITCODE -ne 0\) \{ throw /gu)].length,
    2,
  );
  assert.match(job, /\$ErrorActionPreference = 'Stop'/u);
  assert.doesNotMatch(
    job,
    /continue-on-error|\|\|\s*true|needs:|secrets\.|tauri android|gradlew|npm ci/u,
  );
  const runner = read(
    "frontend/tauri-plugin-oc/android/component-identity-tests/run.ps1",
  );
  assert.match(runner, /src\/main\/java\/IntentsManager\.kt/u);
  assert.match(runner, /com\/oclabs\/openchat\/MyApplication\.kt/u);
  assert.match(
    runner,
    /org\.junit\.runner\.JUnitCore fixtures\.ComponentIdentityTest/u,
  );
  assert.match(
    runner,
    /-classpath "\$KotlinRuntimeClasspath\$separator\$AndroidJar"/u,
  );
  assert.match(runner, /fixtures\.AndroidConstantCheck/u);
  assert.match(runner, /if \(Test-Path -LiteralPath \$output\) \{ throw/u);
  for (const path of [
    "scripts/android_component_identity_tools.json",
    "scripts/android_component_identity_tools.mjs",
    "scripts/android_component_identity_tools.test.mjs",
    "frontend/tauri-plugin-oc/android/component-identity-tests/run.ps1",
    "frontend/tauri-plugin-oc/android/component-identity-tests/src/fixtures/ComponentIdentityTest.kt",
    "frontend/tauri-plugin-oc/android/component-identity-tests/src/fixtures/AndroidConstantCheck.kt",
    "frontend/tauri-plugin-oc/android/src/main/java/IntentsManager.kt",
    "frontend/src-tauri/gen/android/app/src/main/java/com/oclabs/openchat/MyApplication.kt",
  ]) {
    assert.ok(existsSync(join(root, path)), path);
    assert.ok(triggers(path), `component CI not triggered by ${path}`);
  }
});
