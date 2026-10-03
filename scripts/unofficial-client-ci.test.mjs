import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertUnofficialApiRequestAllowed,
  ClientOnlyAppRequestError,
  CUSTOM_APP_REQUEST_KINDS,
} from "../frontend/openchat-shared/src/utils/unofficialApiPolicy.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
const baseline = JSON.parse(read(".github/unofficial-client-baseline.json"));
const expectedKinds = [
  "respondToActionCard",
  "modelCatalog",
  "aiApps",
  "myAiApps",
  "setAiAppEnabled",
  "enabledAiApps",
  "myAiAppKeys",
  "aiAppUserKeys",
  "createAiAppLinkCode",
  "cancelAiAppLinkCode",
  "createAiAppChatLinkToken",
  "cancelAiAppChatLinkToken",
  "createAiAppCardProvenance",
  "createAiAppCardCapability",
  "createAiAppPrivateMatchCapability",
  "createAiAppCardConfirmationGrant",
  "removeMyAiAppKey",
  "publishAiApp",
  "exploreAiApps",
];

test("every unsupported custom service is rejected by the actual client policy before transport", () => {
  assert.deepEqual(CUSTOM_APP_REQUEST_KINDS, expectedKinds);
  let sent = 0;
  for (const kind of expectedKinds) {
    const request = { kind, privateMarker: "SYNTHETIC_NEVER_SENT" };
    assert.throws(
      () => {
        assertUnofficialApiRequestAllowed(request, true);
        sent++;
      },
      (error) =>
        error instanceof ClientOnlyAppRequestError &&
        !error.message.includes(request.privateMarker),
    );
  }
  assert.equal(sent, 0);
});

test("new and edited custom cards are blocked while ordinary messages still reach the transport", () => {
  for (const kind of ["sendMessage", "editMessage"]) {
    const request = (content) =>
      kind === "sendMessage"
        ? { kind, event: { event: { content } } }
        : { kind, msg: { content } };
    let sent = 0;
    const send = (value) => {
      assertUnofficialApiRequestAllowed(value, true);
      sent++;
    };
    assert.throws(
      () => send(request({ kind: "action_card_content" })),
      ClientOnlyAppRequestError,
    );
    assert.equal(sent, 0);
    send(request({ kind: "text_content", text: "synthetic ordinary message" }));
    assert.equal(sent, 1);
  }
});

function requireTransportGuards(client, worker) {
  assert.match(
    client,
    /assertUnofficialApiRequestAllowed\(req, this\.#clientOnlyApps\);/u,
  );
  const clientStart = client.indexOf("#sendRequestInternal<");
  assert.ok(clientStart >= 0);
  const body = client.slice(clientStart);
  assert.ok(
    body.indexOf(
      "assertUnofficialApiRequestAllowed(req, this.#clientOnlyApps)",
    ) < body.indexOf("worker.postMessage("),
  );
  assert.match(
    worker,
    /assertUnofficialApiRequestAllowed\(payload, config\.clientOnlyApps\);/u,
  );
  const guard = worker.indexOf(
    "assertUnofficialApiRequestAllowed(payload, config.clientOnlyApps)",
  );
  const dispatch = worker.indexOf("getAction(payload, agent, config)");
  assert.ok(
    guard >= 0 && dispatch > guard,
    "worker must check policy before agent dispatch",
  );
}

test("both real client and worker retain policy-before-dispatch ordering", () => {
  const client = read("frontend/openchat-client/src/workerAgent.ts");
  const worker = read("frontend/openchat-worker/src/worker.ts");
  requireTransportGuards(client, worker);
  for (const [a, b] of [
    [
      client.replace(
        "assertUnofficialApiRequestAllowed(req, this.#clientOnlyApps);",
        "",
      ),
      worker,
    ],
    [
      client,
      worker.replace(
        "assertUnofficialApiRequestAllowed(payload, config.clientOnlyApps);",
        "",
      ),
    ],
  ])
    assert.throws(() => requireTransportGuards(a, b));
});

function requireBackendIdentity(value) {
  assert.equal(
    value.backendTree,
    baseline.backendTree,
    "backend differs from reviewed official upstream",
  );
  assert.equal(
    value.rootCargoManifest,
    baseline.rootCargoManifest,
    "root Cargo manifest differs from reviewed official upstream",
  );
  assert.deepEqual(
    value.deploymentScripts,
    baseline.upstreamDeploymentScripts,
    "upstream base deployment script changed",
  );
  assert.deepEqual(
    value.historicalWrappers,
    baseline.historicalDeploymentWrappers,
    "historical deployment wrapper changed; this is not deployment acceptance",
  );
  assert.equal(
    value.dirty,
    "",
    "tracked backend/manifest changes are not an unchanged-backend candidate",
  );
  assert.equal(
    value.untracked,
    "",
    "untracked backend files need explicit review",
  );
}

function requireSameSourceView(sourceRoot, repositoryRoot) {
  assert.ok(
    path.isAbsolute(repositoryRoot),
    "explicit repository root must be absolute",
  );
  assert.equal(
    realpathSync(path.join(sourceRoot, "backend")),
    realpathSync(path.join(repositoryRoot, "backend")),
    "Git must inspect the actual backend source view, not another clean checkout",
  );
  for (const filename of [
    "Cargo.toml",
    ...Object.keys(baseline.upstreamDeploymentScripts),
    ...Object.keys(baseline.historicalDeploymentWrappers),
  ]) {
    assert.deepEqual(
      readFileSync(path.join(sourceRoot, filename)),
      readFileSync(path.join(repositoryRoot, filename)),
      `Git/source-view mismatch: ${filename}`,
    );
  }
}

test("backend, manifest and base deployment script match reviewed upstream; historical wrappers stay explicitly frozen", () => {
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.profile, "unofficial-client-official-backend");
  assert.match(baseline.upstreamCommit, /^[a-f0-9]{40}$/u);
  // Only isolated staging harnesses set this. The checked source view must still
  // be the exact repository under test; normal hosted CI checks itself.
  const repositoryRoot = process.env.OC_UNOFFICIAL_CI_REPOSITORY_ROOT ?? root;
  requireSameSourceView(root, repositoryRoot);
  const git = (...args) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  const identities = (entries) =>
    Object.fromEntries(
      Object.keys(entries).map((filename) => [
        filename,
        git("rev-parse", `HEAD:${filename}`),
      ]),
    );
  const guardedPaths = [
    "backend",
    "Cargo.toml",
    ...Object.keys(baseline.upstreamDeploymentScripts),
    ...Object.keys(baseline.historicalDeploymentWrappers),
  ];
  assert.equal(
    git("rev-parse", `${baseline.upstreamCommit}:backend`),
    baseline.backendTree,
    "reviewed backend tree must belong to the pinned official upstream commit",
  );
  assert.equal(
    git("rev-parse", `${baseline.upstreamCommit}:Cargo.toml`),
    baseline.rootCargoManifest,
    "reviewed workspace manifest must belong to the pinned upstream commit",
  );
  requireBackendIdentity({
    backendTree: git("rev-parse", "HEAD:backend"),
    rootCargoManifest: git("rev-parse", "HEAD:Cargo.toml"),
    deploymentScripts: identities(baseline.upstreamDeploymentScripts),
    historicalWrappers: identities(baseline.historicalDeploymentWrappers),
    dirty: git("diff", "--name-only", "HEAD", "--", ...guardedPaths),
    untracked: git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "backend",
    ),
  });
});

test("backend identity guard rejects a changed tree, manifest, deployment script, tracked edit or new source", () => {
  const valid = {
    backendTree: baseline.backendTree,
    rootCargoManifest: baseline.rootCargoManifest,
    deploymentScripts: baseline.upstreamDeploymentScripts,
    historicalWrappers: baseline.historicalDeploymentWrappers,
    dirty: "",
    untracked: "",
  };
  requireBackendIdentity(valid);
  for (const change of [
    { backendTree: "0".repeat(40) },
    { rootCargoManifest: "0".repeat(40) },
    { deploymentScripts: {} },
    { historicalWrappers: {} },
    { dirty: "backend/example.rs" },
    { untracked: "backend/new-api.rs" },
  ])
    assert.throws(() => requireBackendIdentity({ ...valid, ...change }));
});

test("an explicit source-view override cannot silently skip a missing or unrelated Git/source root", () => {
  assert.throws(() => requireSameSourceView(root, "."));
  assert.throws(() =>
    requireSameSourceView(root, path.join(root, "not-a-repository")),
  );
  assert.throws(() => requireSameSourceView(path.join(root, "scripts"), root));
});

const requiredVitestIncludes = [
  "app/src/**/*.{test,spec}.ts",
  "app/localAppRelayBuild.spec.ts",
  "openchat-service-worker/src/local_app_relay.spec.ts",
  "openchat-worker/src/existingAccountPolicy.spec.ts",
  "openchat-shared/src/**/*.{test,spec}.ts",
  "openchat-client/src/**/*.{test,spec}.ts",
  "openchat-agent/src/**/*.{test,spec}.ts",
];
function requirePrivateBoundaryDiscovery(config) {
  const block = config.match(/include: \[([^\]]*)\]/u)?.[1];
  assert.ok(block, "the actual full Vitest include list is required");
  const includes = [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  for (const value of requiredVitestIncludes)
    assert.ok(includes.includes(value), `missing ${value}`);
  const excludes = config.match(/exclude: \[([^\]]*)\]/u)?.[1];
  assert.ok(excludes);
  assert.deepEqual(
    [...excludes.matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
    ["**/node_modules/**", "**/lib/**"],
  );
}

test("full frontend tests keep executable private-draft, transport and account boundaries", () => {
  const config = read("frontend/vitest.config.ts");
  requirePrivateBoundaryDiscovery(config);
  for (const entry of requiredVitestIncludes)
    assert.throws(() =>
      requirePrivateBoundaryDiscovery(config.replace(`"${entry}",`, "")),
    );
  for (const path of [
    "frontend/app/src/utils/localAppDrafts.spec.ts",
    "frontend/app/src/utils/localAppHandoff.spec.ts",
    "frontend/app/src/utils/localAppRelayDelivery.spec.ts",
    "frontend/app/src/utils/nativeAppDelivery.spec.ts",
    "frontend/app/src/utils/privateAppWorkspace.spec.ts",
    "frontend/app/src/utils/isolatedAppProcessor.spec.ts",
    "frontend/openchat-shared/src/utils/unofficialApiPolicy.spec.ts",
    "frontend/openchat-worker/src/existingAccountPolicy.spec.ts",
    "frontend/openchat-client/src/workerAgent.spec.ts",
  ])
    assert.ok(
      existsSync(new URL(`../${path}`, import.meta.url)),
      `missing executable boundary suite ${path}`,
    );
});

test("legacy custom-backend contracts are explicitly superseded, not counted as passed security scans", () => {
  assert.equal(
    baseline.securityScopeAcceptance,
    "unresolved-current-composition",
  );
  assert.deepEqual(baseline.retiredHostedContracts, [
    "scripts/pr-ci-policy.test.mjs",
    "scripts/app_model_integration.test.mjs",
    "scripts/message_content_candid_contract.test.mjs",
    "scripts/upgrade_canister.test.mjs",
  ]);
  const workflow = read(".github/workflows/frontend.yaml");
  const policy = workflow
    .split("- name: Check PR and release policy regressions")[1]
    ?.split(/\n {6}- /u)[0];
  assert.ok(policy);
  assert.match(
    policy,
    /run: node --test scripts\/unofficial-client-ci\.test\.mjs /u,
  );
  for (const retired of baseline.retiredHostedContracts) {
    assert.equal(policy.includes(retired), false);
    assert.ok(
      read("docs/unofficial-ci-migration.md").includes(retired),
      `missing replacement explanation for ${retired}`,
    );
  }
});
