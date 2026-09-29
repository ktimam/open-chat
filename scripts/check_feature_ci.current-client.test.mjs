import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkCurrentClientSecurityCi,
  readCurrentClientSecurityInputs,
  FEATURE_CI_NODE_VERSION,
  CURRENT_CLIENT_LICENSE_COMMAND,
  CURRENT_CLIENT_FORMAT_BASE_EXPRESSION,
  CURRENT_CLIENT_SECURITY_TEST_COMMAND,
  OFFLINE_FEATURE_HELPER_TESTS,
  npmFeatureQueryCommand,
  npmFeatureSmokeCommand,
  rustFeatureCiCommand,
} from "./check_feature_ci.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const actual = readCurrentClientSecurityInputs(root);
const original = actual.securityText.replaceAll("\r\n", "\n");
const check = (securityText = original, extra = {}) =>
  checkCurrentClientSecurityCi({ ...actual, securityText, ...extra });

test("current main workflow preserves complete model jobs and remains structural only", () => {
  const result = check();
  assert.equal(result.pass, true);
  assert.equal(result.scope, "current-client");
  assert.deepEqual(result.preservedModelJobs, [
    "android-component-contracts",
    "native-hermetic",
    "frontend-contracts",
    "real-text-inference",
  ]);
  assert.deepEqual(result.modelJobStrengthenings, [
    "native-hermetic-windows-per-command-exit-checks",
  ]);
  for (const key of [
    "advisoryQueriesExecuted",
    "advisoryAcceptance",
    "dependencyCollectionExecuted",
    "buildExecuted",
    "releaseAcceptance",
  ])
    assert.equal(result[key], false, key);
  assert.equal(result.runtimeChecked, false);
  assert.equal(
    check(undefined, { ci: true, runtime: FEATURE_CI_NODE_VERSION })
      .runtimeChecked,
    true,
  );
  assert.throws(
    () => check(undefined, { ci: true, runtime: "24.14.1" }),
    /runtime pin/,
  );
});

test("current-client collectors remain explicit, scoped and ordered behind offline validation", () => {
  for (const command of [
    npmFeatureSmokeCommand("current-client"),
    npmFeatureQueryCommand("current-client"),
    rustFeatureCiCommand("current-client"),
  ])
    assert.match(command, /--scope current-client /);
  assert.match(
    rustFeatureCiCommand("current-client"),
    /rust_feature_scope\.current-client\.json/,
  );
  assert.match(
    CURRENT_CLIENT_LICENSE_COMMAND,
    /--scope current-client --cargo-executable "\$cargo_path"$/,
  );
  for (const path of OFFLINE_FEATURE_HELPER_TESTS)
    assert(CURRENT_CLIENT_SECURITY_TEST_COMMAND.includes(path));
  assert(
    CURRENT_CLIENT_SECURITY_TEST_COMMAND.includes(
      "scripts/check_feature_ci.current-client.test.mjs",
    ),
  );
  assert(
    CURRENT_CLIENT_SECURITY_TEST_COMMAND.includes(
      "scripts/check_current_client_licenses.test.mjs",
    ),
  );
  assert(
    CURRENT_CLIENT_SECURITY_TEST_COMMAND.includes(
      "scripts/frontend_format_current.test.mjs",
    ),
  );
  assert.match(
    CURRENT_CLIENT_FORMAT_BASE_EXPRESSION,
    /github\.event\.before != '0{40}' && github\.event\.before/,
  );
  assert.match(
    CURRENT_CLIENT_FORMAT_BASE_EXPRESSION,
    /'5f00758312735f2ddac9928e3aa60349964bf73a' \}\}$/,
  );
  for (const scope of [undefined, "", "main", "current", "pr3"])
    for (const factory of [npmFeatureQueryCommand, rustFeatureCiCommand])
      assert.throws(() => factory(scope));
});

const mutations = [
  [
    "missing main PR route",
    (s) => s.replace("branches: [main]", "branches: [master]"),
  ],
  [
    "missing merge queue route",
    (s) => s.replace("  merge_group:\n    branches: [main]\n", ""),
  ],
  [
    "path-filtered security route",
    (s) =>
      s.replace(
        "  pull_request:\n",
        "  pull_request:\n    paths: [frontend/**]\n",
      ),
  ],
  [
    "extra branch route",
    (s) => s.replace("branches: [main]", "branches: [main, master]"),
  ],
  ["missing manual rerun", (s) => s.replace("  workflow_dispatch:\n", "")],
  [
    "extra workflow event",
    (s) =>
      s.replace("  workflow_dispatch:", "  release:\n  workflow_dispatch:"),
  ],
  ["write permissions", (s) => s.replace("contents: read", "contents: write")],
  [
    "workflow shell override",
    (s) =>
      s.replace("jobs:\n", "defaults:\n  run:\n    shell: bash {0}\n\njobs:\n"),
  ],
  [
    "workflow environment override",
    (s) =>
      s.replace(
        "jobs:\n",
        "env:\n  NODE_OPTIONS: --import=unreviewed.mjs\n\njobs:\n",
      ),
  ],
  [
    "conditional dependency job",
    (s) =>
      s.replace(
        "  dependency-security:\n",
        "  dependency-security:\n    if: false\n",
      ),
  ],
  [
    "ignored dependency job",
    (s) =>
      s.replace(
        "  dependency-security:\n",
        "  dependency-security:\n    continue-on-error: true\n",
      ),
  ],
  [
    "dependency shell defaults",
    (s) =>
      s.replace(
        "  dependency-security:\n",
        "  dependency-security:\n    defaults:\n      run:\n        shell: bash {0}\n",
      ),
  ],
  [
    "dependency environment override",
    (s) =>
      s.replace(
        "  dependency-security:\n",
        "  dependency-security:\n    env:\n      NODE_OPTIONS: --import=unreviewed.mjs\n",
      ),
  ],
  [
    "different checkout",
    (s) => s.replace("fetch-depth: 0", "fetch-depth: 0\n          ref: other"),
  ],
  [
    "unpinned checkout action",
    (s) =>
      s.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@main",
      ),
  ],
  [
    "unpinned node action",
    (s) =>
      s.replace(
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "actions/setup-node@main",
      ),
  ],
  [
    "wrong Node runtime",
    (s) => s.replace('node-version: "24.18.1"', 'node-version: "22.0.0"'),
  ],
  ["implicit broad npm audit", (s) => s.replace("npm ci --no-audit", "npm ci")],
  [
    "different npm install",
    (s) => s.replace("npm ci --no-audit", "npm install --no-audit"),
  ],
  [
    "removed runtime smoke",
    (s) => s.replace("--mode plan", "--mode query-bulk"),
  ],
  [
    "historical npm scope",
    (s) => s.replace("--scope current-client", "--scope pr2"),
  ],
  ["plan-only npm gate", (s) => s.replace("--mode query-bulk", "--mode plan")],
  [
    "ignored npm failure",
    (s) => s.replace("--mode query-bulk", "--mode query-bulk || true"),
  ],
  [
    "folded scoped command",
    (s) =>
      s.replace(
        "        run: |\n          set -euo pipefail",
        "        run: >-\n          set -euo pipefail",
      ),
  ],
  [
    "missing strict shell errors",
    (s) => s.replace("set -euo pipefail", "set -u"),
  ],
  [
    "changed license scope",
    (s) =>
      s.replace(
        "scripts/check_current_client_licenses.mjs --scope current-client",
        "scripts/check_current_client_licenses.mjs --scope pr1",
      ),
  ],
  [
    "legacy license command",
    (s) =>
      s.replace(
        'node scripts/check_current_client_licenses.mjs --scope current-client --cargo-executable "$cargo_path"',
        "node scripts/check_openchat_pr2_security.mjs licenses",
      ),
  ],
  [
    "missing pinned Cargo executable",
    (s) => s.replace(' --cargo-executable "$cargo_path"', ""),
  ],
  ["unlocked Rust input fetch", (s) => s.replace("fetch --locked", "fetch")],
  [
    "unpinned Rust toolchain",
    (s) =>
      s.replace(
        "rustup toolchain install 1.95.0",
        "rustup toolchain install stable",
      ),
  ],
  [
    "historical Rust config",
    (s) =>
      s.replace(
        "rust_feature_scope.current-client.json",
        "rust_feature_scope.pr2.json",
      ),
  ],
  [
    "unbound Rust configuration",
    (s) => s.replace(' --config-sha256 "$config_sha256"', ""),
  ],
  [
    "collection-only Rust replacement",
    (s) => s.replace("--mode check-scoped", "--mode collect-offline"),
  ],
  [
    "suppressed Rust failure",
    (s) => s.replace("--mode check-scoped", "--mode check-scoped || true"),
  ],
  [
    "missing wiring check",
    (s) =>
      s.replace(
        "node scripts/check_feature_ci.mjs current-client-security",
        "true",
      ),
  ],
  [
    "removed formatting check",
    (s) =>
      s.replace(
        "node scripts/check_current_client_format.mjs --scope current-client",
        "true",
      ),
  ],
  [
    "historical formatting command in current workflow",
    (s) =>
      s.replace(
        "node scripts/check_current_client_format.mjs --scope current-client",
        "node scripts/check_openchat_pr1_security.mjs format",
      ),
  ],
  [
    "missing current live-format regression",
    (s) => s.replace(" scripts/frontend_format_current.test.mjs", ""),
  ],
  [
    "legacy formatting fallback",
    (s) =>
      s.replace(
        "5f00758312735f2ddac9928e3aa60349964bf73a",
        "df9d9ed52db00e87fbb7309280a325902c9bb2cc",
      ),
  ],
  [
    "zero first-push comparison",
    (s) =>
      s.replace(
        "(github.event.before != '0000000000000000000000000000000000000000' && github.event.before)",
        "github.event.before",
      ),
  ],
  [
    "missing dependency digest contracts",
    (s) =>
      s.replace(
        "node --test scripts/security_dependency_hash.test.mjs",
        "true",
      ),
  ],
  [
    "missing license contracts",
    (s) => s.replace(" scripts/check_current_client_licenses.test.mjs", ""),
  ],
  [
    "missing scoped offline regression",
    (s) => s.replace(" scripts/rust_feature_advisories.test.mjs", ""),
  ],
  [
    "raw Rust metadata upload",
    (s) => s.replace("selected-rust.cdx*.json", "*.metadata.json"),
  ],
  [
    "missing npm upload on failure",
    (s) =>
      s.replace(
        "      - name: Upload scoped model and app npm evidence, including failed checks\n        if: always()",
        "      - name: Upload scoped model and app npm evidence, including failed checks",
      ),
  ],
  [
    "ignored Rust upload failure",
    (s) =>
      s.replace(
        "name: openchat-current-client-scoped-rust-report",
        "name: openchat-current-client-scoped-rust-report\n        continue-on-error: true",
      ),
  ],
  [
    "missing report must fail",
    (s) => s.replace("if-no-files-found: error", "if-no-files-found: ignore"),
  ],
  [
    "missing model frontend family",
    (s) => s.replace("          app/src/utils/localAudioInput\n", ""),
  ],
  [
    "missing native job",
    (s) => s.replace("  native-hermetic:", "  missing-native:"),
  ],
  [
    "changed component contract runner",
    (s) =>
      s.replace(
        "component-identity-tests/run.ps1",
        "component-identity-tests/skipped.ps1",
      ),
  ],
  [
    "unlocked native contracts",
    (s) =>
      s.replace(
        "cargo test --locked -p tauri-plugin-oc --lib",
        "cargo test -p tauri-plugin-oc --lib",
      ),
  ],
  ...["inference", "inference,store"].map((features) => [
    "missing Windows failure guard for " + features,
    (s) =>
      s.replace(
        `          cargo check --locked -p open-chat --features ${features}\n` +
          "          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n",
        `          cargo check --locked -p open-chat --features ${features}\n`,
      ),
  ]),
  [
    "suppressed Windows native failure",
    (s) => s.replace("{ exit $LASTEXITCODE }", "{ exit 0 }"),
  ],
  [
    "skipped real inference selection",
    (s) => s.replace("--ignored --exact --nocapture", "--exact --nocapture"),
  ],
  [
    "unverified inference fixture",
    (s) => s.replace("sha256sum --check --strict", "true"),
  ],
  [
    "conditional native model job",
    (s) =>
      s.replace("  native-hermetic:\n", "  native-hermetic:\n    if: false\n"),
  ],
];

for (const [label, mutate] of mutations)
  test("current security wiring rejects " + label, () => {
    const changed = mutate(original);
    assert.notEqual(
      changed,
      original,
      "Negative control must reach the actual workflow",
    );
    assert.throws(() => check(changed));
  });

for (const [label, field] of [
  ["conditional query", "if: false"],
  ["ignored query failure", "continue-on-error: true"],
  ["query shell override", "shell: bash {0}"],
  [
    "query environment override",
    "env:\n          NODE_OPTIONS: --import=unreviewed.mjs",
  ],
])
  test("current security wiring rejects " + label, () => {
    const anchor =
      "      - name: Query advisories only for reviewed model and app-card dependency roots\n";
    const changed = original.replace(
      anchor,
      anchor + "        " + field + "\n",
    );
    assert.notEqual(changed, original);
    assert.throws(() => check(changed));
  });

test("current security rejects license and Rust gate reordering", () => {
  const license = CURRENT_CLIENT_LICENSE_COMMAND.replaceAll(
    "\n",
    "\n          ",
  );
  const rust = rustFeatureCiCommand("current-client").replaceAll(
    "\n",
    "\n          ",
  );
  const changed = original
    .replace(license, "__LICENSE_SWAP__")
    .replace(rust, license)
    .replace("__LICENSE_SWAP__", rust);
  assert.notEqual(changed, original);
  assert.throws(() => check(changed));
});

test("literal CRLF representation preserves current security semantics", () => {
  assert.deepEqual(check(original.replaceAll("\n", "\r\n")), check());
});

test("offline security wiring checker does not import collectors or perform egress", () => {
  const source = readFileSync(
    new URL("./check_feature_ci.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:child_process|node:https|fetch\(/);
  assert.doesNotMatch(
    source,
    /(?:from|import\()\s*["'][^"']*(?:npm_feature_scope|rust_feature_scope)/,
  );
});
