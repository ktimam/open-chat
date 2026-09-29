import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertReviewedFeatureImports,
  assertReviewedSourceFingerprint,
  featureDependencySpecifiers,
  featureOwnedFiles,
  featureScopeVariants,
  reviewFeatureSeeds,
  seedSourceFingerprint,
  sourceReviewFingerprintFromBytes,
} from "./npm_feature_seed_review.mjs";

test("source review accepts CRLF/LF equivalence but rejects real content or source-set changes", () => {
  const path = "frontend/app/src/model.ts";
  const lf = Buffer.from('import model from "model";\nconst label = "مبلغ";\n');
  const crlf = Buffer.from(lf.toString("utf8").replaceAll("\n", "\r\n"));
  const fingerprint = sourceReviewFingerprintFromBytes([[path, lf]]);
  const review = {
    textIdentity: "utf8-lf",
    snapshots: [{ sha256: fingerprint.sha256 }],
  };
  assert.deepEqual(
    sourceReviewFingerprintFromBytes([[path, crlf]]),
    fingerprint,
  );
  assertReviewedSourceFingerprint(fingerprint, review);
  for (const entries of [
    [
      [
        path,
        Buffer.from(
          lf.toString("utf8").replace("const label =", "const changed ="),
        ),
      ],
    ],
    [[path, Buffer.concat([lf, Buffer.from(" ")])]],
    [[path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf])]],
    [[path, Buffer.from(lf.toString("utf8").replaceAll("\n", "\r"))]],
    [
      [path, lf],
      ["frontend/app/src/added.ts", Buffer.from("export {};\n")],
    ],
  ]) {
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(
          sourceReviewFingerprintFromBytes(entries),
          review,
        ),
      /source set changed/u,
    );
  }
});

test("source fingerprint rejects malformed UTF-8, duplicate paths and ambiguous normalization labels", () => {
  const path = "frontend/app/src/model.ts";
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from([0xc3]),
    Buffer.from([0xc0, 0xaf]),
  ])
    assert.throws(
      () => sourceReviewFingerprintFromBytes([[path, bytes]]),
      /encoded data/u,
    );
  assert.throws(
    () => sourceReviewFingerprintFromBytes([[path, "source"]]),
    /UTF-8 bytes/u,
  );
  assert.throws(
    () =>
      sourceReviewFingerprintFromBytes([
        [path, Buffer.from("a")],
        [path, Buffer.from("b")],
      ]),
    /duplicate/u,
  );
  const fingerprint = sourceReviewFingerprintFromBytes([
    [path, Buffer.from("a")],
  ]);
  for (const textIdentity of [undefined, "raw-bytes", "utf8-nfc"])
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(fingerprint, {
          textIdentity,
          snapshots: [{ sha256: fingerprint.sha256 }],
        }),
      /unsupported source fingerprint/u,
    );
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("current-client is an explicit composition, never a historical-scope fallback", () => {
  assert.deepEqual(featureScopeVariants("current-client"), ["current-client"]);
  assert.deepEqual(featureScopeVariants("pr1"), ["pr1"]);
  assert.deepEqual(featureScopeVariants("pr2"), ["pr1", "pr2"]);
  for (const scope of [
    undefined,
    "",
    "main",
    "whole-core",
    "current-client-npm",
  ])
    assert.throws(
      () => featureScopeVariants(scope),
      /explicit reviewed feature scope/u,
    );
});

test("historical PR inventories retain their original identities and reviewed snapshots", () => {
  for (const [variant, scopeId, roots, snapshot] of [
    [
      "pr1",
      "pr1-model-npm",
      18,
      "b03408dc47dbc46d8eceb4789b695206c6abe4f372a3385ee36fa017558290cf",
    ],
    [
      "pr2",
      "pr2-app-card-ocr-npm",
      17,
      "d89aed77c20b53f54e5b6e3c0663027cd7a5bfdf004b91d4f92dc9b68a0a3522",
    ],
  ]) {
    const config = JSON.parse(
      readFileSync(
        resolve(root, `scripts/npm_feature_scope.${variant}.json`),
        "utf8",
      ),
    );
    assert.equal(config.scopeId, scopeId);
    assert.equal(config.seeds.length, roots);
    assert(
      config.sourceReview.snapshots.some((entry) => entry.sha256 === snapshot),
    );
  }
});

test("current private-app, field-review and browser/native relay families are fingerprinted", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const owned = featureOwnedFiles(root, config.scopeId);
  const fingerprint = seedSourceFingerprint(root, config);
  assert.equal(new Set(owned).size, owned.length);
  assert.equal(config.sourceReview.inherits, undefined);
  for (const file of [
    "frontend/app/localAppRelayBuild.mjs",
    "frontend/app/localAppRelayHeaders.mjs",
    "frontend/app/localNativeAppHandoffBuild.mjs",
    "frontend/app/local-native-app-handoff.html",
    "frontend/app/public/local-app-handoff.html",
    "frontend/app/src/localAppHandoffRelay.ts",
    "frontend/app/src/localNativeAppHandoff.ts",
    "frontend/app/src/utils/isolatedAppProcessor.ts",
    "frontend/app/src/utils/localAppCatalog.ts",
    "frontend/app/src/utils/localAppSetupStore.ts",
    "frontend/app/src/utils/localAppChatConfiguration.ts",
    "frontend/app/src/utils/localAppChatState.ts",
    "frontend/app/src/utils/localAppDrafts.ts",
    "frontend/app/src/utils/localAppDraftFields.ts",
    "frontend/app/src/utils/localAppHandoff.ts",
    "frontend/app/src/utils/localAppRelayDelivery.ts",
    "frontend/app/src/utils/localAppCardPreview.ts",
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "frontend/app/src/utils/nativeAppDelivery.ts",
    "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte",
    "frontend/app/src/components_shared/PrivateAppDraftFields.svelte",
    "frontend/app/src/components_shared/PrivateAppCardPreview.svelte",
    "frontend/app/src/components_shared/LocalAppsChatSettings.svelte",
    "frontend/openchat-service-worker/src/local_app_relay.ts",
    "frontend/tauri-plugin-oc/guest-js/commands/localAppHandoff.ts",
    "frontend/tauri-plugin-oc/guest-js/commands/onDeviceModels.ts",
  ]) {
    assert(owned.includes(file), file);
    assert(fingerprint.files.includes(file), file);
  }
  for (const file of [
    "frontend/app/src/components/home/ChatMessage.svelte",
    "frontend/openchat-client/src/openchat.ts",
    "frontend/app/src/localBrowserAuth.ts",
    "frontend/app/localBrowserAuthBuild.mjs",
    "frontend/openchat-service-worker/src/service_worker.ts",
    "frontend/app/src/components_shared/PrivateAppsWorkspace.card.spec.ts",
    "frontend/app/src/components_shared/PrivateAppsNavigation.spec.shell.svelte",
    "frontend/app/src/utils/localAppDrafts.md",
  ])
    assert(
      !owned.includes(file),
      `mixed core, unrelated auth, tests or docs must not become dedicated source: ${file}`,
    );
});

test("current setup persistence is a dedicated builtin-API consumer with an exact mixed-client scope anchor", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const storePath = "frontend/app/src/utils/localAppSetupStore.ts";
  const clientPath = "frontend/openchat-client/src/openchat.ts";
  const owned = featureOwnedFiles(root, config.scopeId);
  const fingerprint = seedSourceFingerprint(root, config);
  assert.equal(owned.length, 99);
  assert.equal(fingerprint.files.length, 117);
  assert.equal(config.seeds.length, 25);
  assert.equal(
    config.seeds.reduce((count, seed) => count + seed.evidence.length, 0),
    65,
  );
  assert(owned.includes(storePath));
  assert(
    !owned.includes(clientPath),
    "Do not scan unrelated mixed core imports",
  );
  assert(fingerprint.files.includes(clientPath));
  for (const historical of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
    assert(!featureOwnedFiles(root, historical).includes(storePath));
  const anchors = config.seeds
    .flatMap((seed) => seed.evidence)
    .filter((item) => item.file === clientPath);
  assert.equal(anchors.length, 1);
  assert.equal(
    anchors[0].contains,
    "return JSON.stringify([this.config.icUrl, this.config.userIndexCanister]);",
  );
  const client = readFileSync(resolve(root, clientPath), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  assert(
    client.includes(
      "    privateAppStorageBackend(): string | undefined {\n" +
        "        if (!this.clientOnlyApps() || !this.config.icUrl || !this.config.userIndexCanister)\n" +
        "            return undefined;\n" +
        "        return JSON.stringify([this.config.icUrl, this.config.userIndexCanister]);\n" +
        "    }",
    ),
  );
  const source = readFileSync(resolve(root, storePath), "utf8");
  assert.deepEqual(featureDependencySpecifiers(source), [
    "./localAppCatalog",
    "./isolatedAppProcessor",
  ]);
  assert.match(source, /globalThis\.indexedDB/u);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|runIsolatedAppProcessor)\s*\(/u,
  );
});

test("reviewed persistence writes setup-only fields at explicit mutations, never proposal or delivery state", () => {
  const workspace = readFileSync(
    resolve(root, "frontend/app/src/utils/privateAppWorkspace.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const store = readFileSync(
    resolve(root, "frontend/app/src/utils/localAppSetupStore.ts"),
    "utf8",
  );
  const method = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = workspace.match(
      new RegExp(`\\n    (?:async )?${escaped}\\([\\s\\S]*?\\n    \\}`, "u"),
    );
    assert(match, `Missing reviewed workspace method ${name}`);
    return match[0];
  };
  const save = method("#saveSetup");
  const snapshot = save.match(
    /const snapshot: LocalAppSetupSnapshot = \{([\s\S]*?)\n        \};/u,
  );
  assert(snapshot, "Only an explicit setup snapshot can reach storage");
  assert.deepEqual(
    [...snapshot[1].matchAll(/^ {12}(\w+)(?::|,)/gmu)].map((match) => match[1]),
    ["catalog", "appId", "actionId", "processor", "enabledChats"],
  );
  assert.doesNotMatch(
    save,
    /#state\.(?:draft|editorJson|recipient|message)|approval|idempotency|payload/u,
  );
  assert.match(save, /storage\.write\(scope, snapshot\)/u);
  for (const name of [
    "#set",
    "propose",
    "edit",
    "review",
    "#send",
    "confirm",
    "retryUncertain",
    "reopenDelivered",
    "discard",
  ])
    assert.doesNotMatch(
      method(name),
      /#saveSetup\(|setupStorage\.(?:write|remove)\(/u,
      name,
    );
  for (const name of [
    "importCatalog",
    "chooseApp",
    "select",
    "importProcessor",
    "replaceEnabledChats",
  ])
    assert.match(method(name), /#saveSetup\(/u, name);
  assert.match(method("#setupScope"), /this\.#account && this\.#backend/u);
  assert.match(method("setAccount"), /backend === this\.#backend/u);
  assert.match(
    method("#restoreSetup"),
    /await validateLocalAppSetupSnapshot\(stored\)/u,
  );
  assert.match(method("#restoreSetup"), /epoch !== this\.#setupEpoch/u);
  assert.doesNotMatch(
    method("#restoreSetup"),
    /deps\.(?:extract|runProcessor|deliver)|#saveSetup\(/u,
  );
  assert.match(
    store,
    /exact\(value, \["catalog", "enabledChats"\], \["appId", "actionId", "processor"\]\)/u,
  );
  assert.match(store, /storedOwner\.account !== owner\.account/u);
  assert.match(store, /storedOwner\.backend !== owner\.backend/u);
});

test("native handoff bundler owns the reviewed locked esbuild location, not an invented manifest edge", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const seed = config.seeds.find(
    (entry) => entry.location === "node_modules/esbuild",
  );
  assert.equal(seed.kind, "location");
  assert.equal(seed.from, undefined);
  assert(
    seed.evidence.some(
      (entry) =>
        entry.file === "frontend/app/localNativeAppHandoffBuild.mjs" &&
        entry.contains.includes('from "esbuild"'),
    ),
  );
  for (const location of [
    "node_modules/other",
    "app/node_modules/esbuild",
    "",
  ]) {
    const changed = structuredClone(config);
    changed.seeds.find(
      (entry) => entry.location === "node_modules/esbuild",
    ).location = location;
    assert.throws(() => reviewFeatureSeeds(root, changed), /root set changed/u);
  }
});

test("all literal direct import forms reject unreviewed dependency roots", () => {
  const names = new Set(["svelte", "@tauri-apps/api"]);
  for (const text of [
    'import value from "unreviewed";',
    'export { value } from "unreviewed/subpath";',
    'import "unreviewed/polyfill";',
    'const value = import("unreviewed/subpath");',
    'const value = require("unreviewed/subpath");',
  ]) {
    assert.equal(featureDependencySpecifiers(text).length, 1);
    assert.throws(
      () => assertReviewedFeatureImports(text, names),
      /no reviewed root: unreviewed/u,
    );
  }
  assert.doesNotThrow(() =>
    assertReviewedFeatureImports(
      [
        'import { writable } from "svelte/store";',
        'import { invoke } from "@tauri-apps/api/core";',
        'import "./local-module";',
        'import fs from "node:fs";',
        'import { local } from "@utils/localAppDrafts";',
      ].join("\n"),
      names,
    ),
  );
});
test("all dedicated model build and runtime helpers participate in ownership discovery", () => {
  const expected = readdirSync(resolve(root, "frontend/app"))
    .filter(
      (name) =>
        /^transformersWebGpu.*\.mjs$/.test(name) &&
        !/\.(?:test|spec)\./.test(name),
    )
    .map((name) => `frontend/app/${name}`)
    .sort();
  assert(
    expected.length >= 11,
    "the qualified model helper set must not disappear",
  );
  const owned = featureOwnedFiles(root, "pr1-model-npm");
  assert.deepEqual(
    owned.filter((file) => file.startsWith("frontend/app/transformersWebGpu")),
    expected,
  );
  assert.equal(
    new Set(owned).size,
    owned.length,
    "dedicated helpers must not be counted twice",
  );
  assert(
    !featureOwnedFiles(root, "pr2-app-card-ocr-npm").some((file) =>
      expected.includes(file),
    ),
  );
});

test("the configurable catalog belongs only to the model feature source inventory", () => {
  const owned = featureOwnedFiles(root, "pr1-model-npm");
  const appOwned = featureOwnedFiles(root, "pr2-app-card-ocr-npm");
  const config = JSON.parse(
    readFileSync(resolve(root, "scripts/npm_feature_scope.pr1.json"), "utf8"),
  );
  const fingerprint = seedSourceFingerprint(root, config);
  for (const file of [
    "frontend/app/src/utils/webGpuModelCatalog.ts",
    "frontend/app/src/stores/webGpuModelCatalog.ts",
    "frontend/app/src/components_shared/WebGpuModelCatalogSettings.svelte",
  ]) {
    assert(owned.includes(file), file);
    assert(fingerprint.files.includes(file), file);
    assert(!appOwned.includes(file), file);
  }
});

for (const helper of [
  "OrtSessionConfig",
  "QwenGenerationGraph",
  "QwenGenerationRuntime",
  "QwenVisionGeometry",
  "QwenVisionGraph",
  "QwenVisionSession",
  "FeatureFlag",
]) {
  test(`model helper ${helper} cannot change outside the source-review fingerprint`, () => {
    const file = `frontend/app/transformersWebGpu${helper}.mjs`;
    const config = JSON.parse(
      readFileSync(resolve(root, "scripts/npm_feature_scope.pr1.json"), "utf8"),
    );
    const actual = seedSourceFingerprint(root, config);
    assert(featureOwnedFiles(root, config.scopeId).includes(file));
    assert(actual.files.includes(file));
    const changed = sourceReviewFingerprintFromBytes(
      actual.files.map((entry) => [
        entry,
        Buffer.concat([
          readFileSync(resolve(root, entry)),
          entry === file
            ? Buffer.from("// real helper change\n")
            : Buffer.alloc(0),
        ]),
      ]),
    );
    assert.notEqual(changed.sha256, actual.sha256);
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(changed, {
          textIdentity: actual.textIdentity,
          snapshots: [{ sha256: actual.sha256 }],
        }),
      /source set changed/u,
    );
  });
}

test("dedicated session transform participates in model ownership and source fingerprint", () => {
  const file = "frontend/app/transformersWebGpuSequentialSessions.mjs";
  const config = JSON.parse(
    readFileSync(resolve(root, "scripts/npm_feature_scope.pr1.json"), "utf8"),
  );
  assert(featureOwnedFiles(root, config.scopeId).includes(file));
  const actual = seedSourceFingerprint(root, config);
  assert(actual.files.includes(file));
  const changed = sourceReviewFingerprintFromBytes(
    actual.files.map((entry) => [
      entry,
      Buffer.concat([
        readFileSync(resolve(root, entry)),
        entry === file
          ? Buffer.from("// session transform changed\n")
          : Buffer.alloc(0),
      ]),
    ]),
  );
  assert.notEqual(changed.sha256, actual.sha256);
  assert.throws(
    () =>
      assertReviewedSourceFingerprint(changed, {
        textIdentity: actual.textIdentity,
        snapshots: [{ sha256: actual.sha256 }],
      }),
    /source set changed/u,
  );
});

// The current composition has its own mandatory source gate. Historical PR
// selectors remain exercised above; their snapshots are not current approvals.
const scopes = ["current-client"];
for (const scope of scopes) {
  const config = JSON.parse(
    readFileSync(
      resolve(root, `scripts/npm_feature_scope.${scope}.json`),
      "utf8",
    ),
  );
  test(`${scope}: reviewed feature roots match source ownership and owning declarations`, () => {
    const result = reviewFeatureSeeds(root, config);
    assert.equal(result.roots, 25);
    assert.equal(result.advisoryAcceptance, false);
    assert.equal(result.sourceTextIdentity, "utf8-lf");
    for (const seed of config.seeds) {
      assert(seed.purpose.length <= 512);
      assert.match(seed.purpose, /^[A-Za-z0-9][A-Za-z0-9 .,:;()+-]*$/u);
    }
  });
  test(`${scope}: exact current source fingerprints match both Linux LF and Windows CRLF bytes`, () => {
    const actual = seedSourceFingerprint(root, config);
    const entries = actual.files.map((file) => [
      file,
      readFileSync(resolve(root, file)),
    ]);
    const lf = entries.map(([file, bytes]) => [
      file,
      Buffer.from(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(bytes)
          .replaceAll("\r\n", "\n"),
      ),
    ]);
    const crlf = lf.map(([file, bytes]) => [
      file,
      Buffer.from(bytes.toString("utf8").replaceAll("\n", "\r\n")),
    ]);
    assert.deepEqual(sourceReviewFingerprintFromBytes(lf), actual);
    assert.deepEqual(sourceReviewFingerprintFromBytes(crlf), actual);
    assertReviewedSourceFingerprint(actual, config.sourceReview);
    const changed = entries.map(([file, bytes]) => [file, Buffer.from(bytes)]);
    changed[0][1] = Buffer.concat([
      changed[0][1],
      Buffer.from("// real content change\n"),
    ]);
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(
          sourceReviewFingerprintFromBytes(changed),
          config.sourceReview,
        ),
      /source set changed/u,
    );
  });
  for (const seed of config.seeds) {
    test(`${scope}: cannot silently remove root ${seed.name ?? seed.location}`, () => {
      const changed = structuredClone(config);
      changed.seeds = changed.seeds.filter(
        (value) => JSON.stringify(value) !== JSON.stringify(seed),
      );
      assert.throws(
        () => reviewFeatureSeeds(root, changed),
        /root set changed/,
      );
    });
  }
  for (const [name, mutate, error] of [
    [
      "missing source text identity",
      (c) => delete c.sourceReview.textIdentity,
      /unsupported source fingerprint/,
    ],
    [
      "legacy raw source text identity",
      (c) => (c.sourceReview.textIdentity = "raw-bytes"),
      /unsupported source fingerprint/,
    ],
    [
      "unreviewed root",
      (c) => c.seeds.push({ kind: "edge", from: "", name: "borc" }),
      /root set changed/,
    ],
    [
      "missing ownership",
      (c) => delete c.seeds[0].evidence,
      /ownership evidence/,
    ],
    [
      "stale ownership anchor",
      (c) => (c.seeds[0].evidence[0].contains = "not-a-real-feature-import"),
      /anchor changed/,
    ],
    [
      "escaped ownership path",
      (c) => (c.seeds[0].evidence[0].file = "frontend/../../private"),
      /unsafe provenance/,
    ],
    [
      "changed source fingerprint",
      (c) => (c.sourceReview.snapshots = []),
      /source set changed/,
    ],
    [
      "false inventory approval",
      (c) => (c.status = "approved"),
      /inventory status/,
    ],
  ]) {
    test(`${scope}: rejects ${name}`, () => {
      const changed = structuredClone(config);
      mutate(changed);
      assert.throws(() => reviewFeatureSeeds(root, changed), error);
    });
  }
}
