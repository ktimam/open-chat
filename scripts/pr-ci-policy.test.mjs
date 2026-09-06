import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");
const workflows = [
  "frontend.yaml",
  "backend.yaml",
  "on_device_model_security.yaml",
  "openchat_pr2_security.yaml",
];

// Bound the match to a single top-level event instead of accepting branch names from job text.
function eventBlock(text, event) {
  const start = text.indexOf(`\n  ${event}:`);
  assert.notEqual(start, -1, `missing ${event} event`);
  const remaining = text.slice(start + 1);
  return remaining.split(/\n(?=  [a-z_]+:|[a-z_]+:)/u)[0];
}

for (const filename of workflows) {
  test(`${filename}: validates the stacked app PR and integration pushes`, () => {
    const text = read(`../.github/workflows/${filename}`);
    assert.match(eventBlock(text, "pull_request"), /\bmaster\b/u);
    assert.match(eventBlock(text, "pull_request"), /codex\/pr1-local-models/u);
    assert.match(eventBlock(text, "push"), /codex\/pr2-clean-integration/u);
    assert.match(eventBlock(text, "push"), /codex\/pr2-app-chat-interfaces/u);
    assert.match(text, /\n  workflow_dispatch:/u);
    assert.doesNotMatch(text, /pull_request_target/u);
    assert.match(text, /permissions:\s*\n  contents: read/u);
  });
}

test("backend CI preserves the lock and reports independent lint failures without waiving them", () => {
  const workflow = read("../.github/workflows/backend.yaml");
  assert.match(
    workflow,
    /command: clippy\s+args: --locked --keep-going --tests -- -D warnings/u,
  );
  assert.match(
    workflow,
    /command: test\s+args: --locked --workspace --exclude integration_tests/u,
  );
  assert.doesNotMatch(workflow, /continue-on-error:\s*true|\|\|\s*true/u);
});

test("frontend CI uses the reviewed runtime and never rewrites dependency or source inputs", () => {
  const workflow = read("../.github/workflows/frontend.yaml");
  const policy = JSON.parse(
    read("../.github/security/openchat-pr2-security-baseline.json"),
  );
  const packageJson = JSON.parse(read("../frontend/package.json"));
  assert.match(
    workflow,
    new RegExp(
      `node-version: "${policy.ciRuntime.nodeVersion.replaceAll(".", "\\.")}"`,
      "u",
    ),
  );
  assert.match(workflow, /run: npm ci/u);
  assert.doesNotMatch(workflow, /run: npm (?:install|update|audit fix)\b/u);
  assert.match(workflow, /node --test scripts\/pr-ci-policy\.test\.mjs/u);
  assert.match(workflow, /scripts\/release_preflight\.test\.mjs/u);
  assert.match(workflow, /scripts\/android_bundle\.test\.mjs/u);
  assert.match(workflow, /scripts\/frontend_format_check\.test\.mjs/u);
  assert.match(workflow, /scripts\/android_dev\.test\.mjs/u);
  assert.match(workflow, /scripts\/verify_webgpu_distribution\.test\.mjs/u);
  assert.match(workflow, /scripts\/model_asset_notices\.test\.mjs/u);
  assert.match(workflow, /command -v zip\b/u);
  assert.match(workflow, /command -v unzip\b/u);
  assert.match(workflow, /node scripts\/cdp_axios_compatibility\.mjs/u);
  assert.match(workflow, /node scripts\/decoder_compatibility\.mjs/u);
  assert.match(workflow, /node scripts\/onnx_adm_zip_compatibility\.mjs/u);
  assert.match(
    workflow,
    /node scripts\/transformers_sharp_compatibility\.mjs/u,
  );
  assert.equal(packageJson.scripts["lint:check"], "eslint .");
  assert.match(packageJson.scripts["build:ci"], /npm run lint:check(?: &&|$)/u);
  assert.doesNotMatch(
    packageJson.scripts["build:ci"],
    /npm run lint(?: &&|$)|--fix/u,
  );
});

test("event extraction cannot satisfy branch coverage from an unrelated job", () => {
  const text =
    "on:\n  pull_request:\n    branches: [master]\n  push:\n    branches: [different]\njobs:\n  example:\n    name: codex/pr1-local-models codex/pr2-clean-integration\n";
  assert.doesNotMatch(eventBlock(text, "pull_request"), /codex\//u);
  assert.doesNotMatch(eventBlock(text, "push"), /codex\//u);
});

test("CI builds a separate production WebGPU candidate and checks its emitted bytes", () => {
  const workflow = read("../.github/workflows/frontend.yaml");
  const defaultBuild = workflow.indexOf("run: npm run build:ci");
  const candidate = workflow.indexOf(
    "- name: Build and verify the opt-in production WebGPU candidate",
  );
  assert.ok(defaultBuild > 0 && candidate > defaultBuild);
  const block = workflow.slice(candidate).split(/\n      - name:/u)[0];
  assert.match(
    block,
    /npm run build:prod\s+node \.\.\/scripts\/verify_webgpu_distribution\.mjs app\/build/u,
  );
  assert.match(block, /OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true"/u);
  assert.match(
    block,
    /OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: immutable-hub-v1/u,
  );
  assert.doesNotMatch(block, /continue-on-error|\|\|\s*true/u);
  assert.doesNotMatch(
    workflow.slice(defaultBuild, candidate),
    /OC_TRANSFORMERS_WEBGPU_(?:IMAGE_SPIKE|ASSET_DELIVERY):/u,
  );
});

test("the production CI bundle has the exact dfx prerequisite without skipping public-key verification", () => {
  const workflow = read("../.github/workflows/frontend.yaml");
  const dfxVersion = JSON.parse(read("../dfx.json")).dfx;
  assert.match(workflow, /uses: dfinity\/setup-dfx@[a-f0-9]{40}\b/u);
  assert.ok(workflow.includes(`dfx-version: "${dfxVersion}"`));
  const setup = workflow.indexOf("uses: dfinity/setup-dfx@");
  const verify = workflow.indexOf("run: dfx --version");
  const build = workflow.indexOf("run: npm run build:ci");
  assert.ok(setup > 0 && verify > setup && build > verify);
  assert.doesNotMatch(workflow, /SKIP_PUBLIC_KEY|continue-on-error:\s*true/u);
  const rollup = read("../frontend/app/rollup.config.mjs");
  assert.match(rollup, /publicKeyBuildPlugin\(\{/u);
});
