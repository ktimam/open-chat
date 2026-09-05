import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
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

test("frontend CI uses the reviewed runtime and never rewrites dependency or source inputs", () => {
    const workflow = read("../.github/workflows/frontend.yaml");
    const policy = JSON.parse(read("../.github/security/openchat-pr2-security-baseline.json"));
    const packageJson = JSON.parse(read("../frontend/package.json"));
    assert.match(
        workflow,
        new RegExp(`node-version: "${policy.ciRuntime.nodeVersion.replaceAll(".", "\\.")}"`, "u"),
    );
    assert.match(workflow, /run: npm ci/u);
    assert.doesNotMatch(workflow, /run: npm (?:install|update|audit fix)\b/u);
    assert.match(workflow, /node --test scripts\/pr-ci-policy\.test\.mjs/u);
    assert.equal(packageJson.scripts["lint:check"], "eslint .");
    assert.match(packageJson.scripts["build:ci"], /npm run lint:check(?: &&|$)/u);
    assert.doesNotMatch(packageJson.scripts["build:ci"], /npm run lint(?: &&|$)|--fix/u);
});

test("event extraction cannot satisfy branch coverage from an unrelated job", () => {
    const text =
        "on:\n  pull_request:\n    branches: [master]\n  push:\n    branches: [different]\njobs:\n  example:\n    name: codex/pr1-local-models codex/pr2-clean-integration\n";
    assert.doesNotMatch(eventBlock(text, "pull_request"), /codex\//u);
    assert.doesNotMatch(eventBlock(text, "push"), /codex\//u);
});
