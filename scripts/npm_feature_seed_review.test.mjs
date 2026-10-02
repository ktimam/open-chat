import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// Exact LF identities independently read from committed 240007855 before the
// October upstream merge and app-owned card controls. Historical aggregates use
// only these eight replacements; all other inputs remain live and the current
// gate separately fingerprints every current byte.
const beforeOctoberRefresh = new Map([
  [
    "frontend/app/src/components_shared/PrivateAppCardPreview.svelte",
    "abbe38c8167627ad3b941062e2b8e13c755483107a38111eb3966715ec9f668d",
  ],
  [
    "frontend/app/src/components_shared/PrivateAppDraftFields.svelte",
    "0d5d28b9a835db821753b665947fbcc8a0e4f54cb369215b1dd38eb956674d5e",
  ],
  [
    "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte",
    "d84eee1a4c5c022e61ed7a02d6ac1a942d6febb1766e8f6660fd8f131b02af86",
  ],
  [
    "frontend/app/src/utils/localAppDraftPresentation.ts",
    "d29d8ba48c6b1d850b30f18a16a33915a9ce58045343fe1ab7df82d3959d5d36",
  ],
  [
    "frontend/openchat-agent/src/utils/chatsDb.ts",
    "b21c79583f218c23db163d486e50dc333cb28b357bb8eb610a1aac536f9b386f",
  ],
  [
    "frontend/openchat-client/src/openchat.ts",
    "fe42fb5926d7abc0b8af005d7a2ec0c36f9c8d76df21bf767a79f0201c639e7f",
  ],
  [
    "frontend/openchat-shared/src/domain/worker.ts",
    "e680e4d277e18f71a1be45660287e5eac0563bb3c59e278df5354b08ba476bf7",
  ],
  [
    "frontend/openchat-worker/src/worker.ts",
    "b7f05d722ed8d3bb5c18153597d755342b9f0bc5a75c2e7f197e2b03428844d7",
  ],
]);
// Independently read from the full 151-file Git 5a36a3c checkpoint. These six
// hashes reconstruct its prior bytes only; the current gate still binds every
// live input. The two proposal entry points were not in any historical aggregate.
const mixedProposalFiles = [
  "frontend/app/src/components/home/ChatMessage.svelte",
  "frontend/app/src/components_mobile/home/ChatMessage.svelte",
];
// Source navigation reaches only these four existing mixed helpers and one new
// dedicated helper. They were absent from the preceding 153-file checkpoint.
const sourceNavigationAdditions = [
  "frontend/app/src/utils/localAppSourceNavigation.ts",
  "frontend/app/src/utils/navigation.ts",
  "frontend/openchat-shared/src/utils/chat.ts",
  "frontend/openchat-shared/src/utils/routes.ts",
  "frontend/openchat-shared/src/utils/string.ts",
];
// Independently read from all 153 Git blobs at 494500398 (runtime 94cb746).
// Only these five old files change; unchanged inputs still come from live source.
const beforeSourceNavigation = new Map([
  [
    "frontend/app/src/utils/localAppDraftPersistence.ts",
    "ade5a9ee7f4bb3b248b7f0afaccc63cf67edcbdff152d00af37a635e20096da0",
  ],
  [
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "ba62a0d28a45b3c23bebd185cc276bf173406945f54cfd66fe67e63e411486c4",
  ],
  [
    "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte",
    "32524ff53ef0adada23529b74b8c14e337f8c878c70ff904e4188307910a1c35",
  ],
  [
    "frontend/app/src/components/home/ChatMessage.svelte",
    "069a83446ab9dda68da2cb46982d983aefd00c0caf8feec5b6bdb6855d09e89d",
  ],
  [
    "frontend/app/src/components_mobile/home/ChatMessage.svelte",
    "06736fcd0fca212211bab6dda9ab2c6490dd9a7646bcf838510ffb7cc0f6038b",
  ],
]);
const beforeCardCollection = new Map([
  [
    "frontend/app/src/components_shared/PrivateAppDraftFields.svelte",
    "81c4afd2dff50a7d69e7d8c78b01fd58a7f63c86e061bb2ff58d016141444ee2",
  ],
  [
    "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte",
    "230cc611fe4a9d6560c150a64cddfcef067f5aed79c0421480396a02beec3ed9",
  ],
  [
    "frontend/app/src/utils/localAppDraftPersistence.ts",
    "5ad14adf943a7f1fd73342cd2c7b322f82264d65fd858ed1dc9cf12b9ffc1237",
  ],
  [
    "frontend/app/src/utils/localAppDraftPresentation.ts",
    "dcd42a9891da2be24566cfbab308d80f3a8683ddf07639a127353f94c417b0e2",
  ],
  [
    "frontend/app/src/utils/localAppDrafts.ts",
    "6fe69445a1d327a66fa7ad6a45b930e007d5b8274bb992936d2928a97997b54b",
  ],
  [
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "821780fbc338896830d1dbae1292e13a91b332e2704c816b53800096b9ea6b9d",
  ],
]);

// The current main Apps flow replaces the technical workspace page, reaches the
// normal desktop/mobile discovery and My Apps entry points, and adds one narrow
// current-user startup completion seam. These paths were absent from the prior
// 158-file source-navigation checkpoint.
const priorPrivateAppsWorkspace =
  "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte";
const mainAppsFlowAdditions = [
  "frontend/app/src/components/home/communities/explore/AiAppCard.svelte",
  "frontend/app/src/components/home/communities/explore/Explore.svelte",
  "frontend/app/src/components/home/nav/MainMenu.svelte",
  "frontend/app/src/components/home/profile/MyApps.svelte",
  "frontend/app/src/components_mobile/home/communities/explore/AiAppCard.svelte",
  "frontend/app/src/components_mobile/home/communities/explore/AiAppSheet.svelte",
  "frontend/app/src/components_mobile/home/communities/explore/Explore.svelte",
  "frontend/app/src/components_mobile/home/user_profile/AppSettings.svelte",
  "frontend/app/src/components_mobile/home/user_profile/MyApps.svelte",
  "frontend/app/src/components_shared/LocalAppCards.svelte",
  "frontend/app/src/components_shared/LocalAppDirectory.svelte",
  "frontend/app/src/utils/localAppDirectoryPresentation.ts",
  "frontend/app/src/utils/mainAppsNavigation.ts",
  "frontend/openchat-agent/src/services/userIndex/userIndex.client.ts",
];
// Exact LF identities independently read from committed 7a95466f, whose live
// 158-file aggregate is a52d271a. The deleted workspace blob is retained only in
// this historical reconstruction; every current byte has a separate live gate.
const beforeMainAppsFlow = new Map([
  [
    "frontend/app/src/components/App.svelte",
    "121439b91a99aaa3c3876424c698bb407cd81b903f65816722e495b6728642cd",
  ],
  [
    "frontend/app/src/components/home/AiAppModal.svelte",
    "ab165ae966fd9cf959d407af14c06aa06a337a5e00340d79ceaa92c1d68142de",
  ],
  [
    "frontend/app/src/components/home/ChatMessage.svelte",
    "b44b1c6b359b781fe5798143892abeb1b9d8aadb7c300c77ec9850b5f61f6c07",
  ],
  [
    "frontend/app/src/components_mobile/App.svelte",
    "402b98544fd1bd53a7815afe15eef662c04063c0855582dbc5c9cdfe325c808a",
  ],
  [
    "frontend/app/src/components_mobile/home/ChatMessage.svelte",
    "2a71e63c4f76214be072cf20fe744b3e662b4e69de5f5f7b406aff9799a301a1",
  ],
  [
    "frontend/app/src/components_shared/LocalAppsChatSettings.svelte",
    "af76fcddf761a0ee77289ca45ff59fd95039b60d9a333d4536e99c8e0b416b7b",
  ],
  [
    priorPrivateAppsWorkspace,
    "1fb60e2497a511162dbbda47796c7d9f094edf85f7c35e718daa0026b2721b6a",
  ],
  [
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "23c7eaff69860b42a658a8815edb1d683954c1907317818ccbb7c28a1bda230e",
  ],
  [
    "frontend/openchat-agent/src/utils/indexedDb.ts",
    "35f75653aa02ddd0d97c4608ffc65352977983abb787bfd82ad9d9c39cdac443",
  ],
  [
    "frontend/openchat-client/src/openchat.ts",
    "55adc1e7aba58313c1e4b01410cdbff4b2aa43f0873fe006afc08398d26e105d",
  ],
]);
// Independently reconstructed all 171 Git blobs at committed 33888e4f.
// Only these three existing mixed inputs change in the incoming 5ca61b merge.
// Historical aggregates substitute their exact old hashes; the live gate still
// binds every merged byte and the reversal test below checks each transformation.
const beforeReplicaPortMerge = new Map([
  [
    "frontend/app/rollup.config.mjs",
    "1ba665d8ddf6cf382b388cb178bc595e6cb18f99f7a5e9d18ca0292586bf8f74",
  ],
  [
    "frontend/app/vite.config.ts",
    "92eb81a62aad23c938d118b991da244d1a5194d1daeb5be885c5a78639329cec",
  ],
  [
    "frontend/openchat-client/src/openchat.ts",
    "bd83d161f48f8930dba4c3f252495050fb101184d638cbeac0e85e146f104b28",
  ],
]);
// Independently verified from all 171 committed 064eda1885 Git blobs. These
// replacements preserve prior aggregates without accepting them as current bytes.
const beforeSavedCardUiFix = new Map([
  [
    "frontend/app/src/components_shared/LocalAppCards.svelte",
    "474ecb8bb82300593bae0b5b5d9444f14d40e9ebe1a1630ad0ffea5a72d9d6ae",
  ],
  [
    "frontend/app/src/components_shared/LocalAppsChatSettings.svelte",
    "4986e2570b8953ec4736347749f720295ae1731bf311d252fb641eb888cf6ad9",
  ],
  [
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "41660e6c1437f3081891be63858011c451b50ac3102a5167d75f8bc00a8f134a",
  ],
]);
function beforeSavedCardUiFixFingerprint(fingerprint) {
  return {
    ...fingerprint,
    sha256: createHash("sha256")
      .update(
        JSON.stringify(
          fingerprint.files.map((file) => [
            file,
            beforeSavedCardUiFix.get(file) ?? sourceHash(file),
          ]),
        ),
      )
      .digest("hex"),
  };
}
function beforeReplicaPortMergeFingerprint(fingerprint) {
  return {
    ...fingerprint,
    sha256: createHash("sha256")
      .update(
        JSON.stringify(
          fingerprint.files.map((file) => [
            file,
            beforeReplicaPortMerge.get(file) ??
              beforeSavedCardUiFix.get(file) ??
              sourceHash(file),
          ]),
        ),
      )
      .digest("hex"),
  };
}
function sourceHash(file) {
  return createHash("sha256")
    .update(readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}
function beforeMainAppsFlowFingerprint(fingerprint) {
  for (const path of mainAppsFlowAdditions)
    assert(fingerprint.files.includes(path), path);
  assert(!fingerprint.files.includes(priorPrivateAppsWorkspace));
  for (const path of beforeMainAppsFlow.keys())
    if (path !== priorPrivateAppsWorkspace)
      assert(fingerprint.files.includes(path), path);
  const files = [
    ...fingerprint.files.filter(
      (file) => !mainAppsFlowAdditions.includes(file),
    ),
    priorPrivateAppsWorkspace,
  ].sort();
  assert.equal(files.length, 158);
  return {
    ...fingerprint,
    files,
    sha256: createHash("sha256")
      .update(
        JSON.stringify(
          files.map((file) => [
            file,
            beforeMainAppsFlow.get(file) ??
              beforeReplicaPortMerge.get(file) ??
              sourceHash(file),
          ]),
        ),
      )
      .digest("hex"),
  };
}
function priorFingerprint(fingerprint, hashes, replacements = new Map()) {
  const sourceNavigationFingerprint =
    beforeMainAppsFlowFingerprint(fingerprint);
  for (const path of [...mixedProposalFiles, ...sourceNavigationAdditions])
    assert(sourceNavigationFingerprint.files.includes(path));
  for (const path of hashes.keys())
    assert(sourceNavigationFingerprint.files.includes(path));
  const files = sourceNavigationFingerprint.files.filter(
    (file) =>
      !mixedProposalFiles.includes(file) &&
      !sourceNavigationAdditions.includes(file),
  );
  assert.equal(files.length, 151);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return {
    ...fingerprint,
    files,
    sha256: hash(
      JSON.stringify(
        files.map((file) => [
          file,
          replacements.has(file)
            ? hash(replacements.get(file))
            : (hashes.get(file) ??
              beforeMainAppsFlow.get(file) ??
              beforeReplicaPortMerge.get(file) ??
              sourceHash(file)),
        ]),
      ),
    ),
  };
}
function octoberPriorFingerprint(fingerprint, replacements = new Map()) {
  const sourceNavigationFingerprint =
    beforeMainAppsFlowFingerprint(fingerprint);
  for (const path of beforeOctoberRefresh.keys())
    assert(sourceNavigationFingerprint.files.includes(path));
  return priorFingerprint(
    fingerprint,
    new Map([...beforeCardCollection, ...beforeOctoberRefresh]),
    replacements,
  );
}

// Historical aggregate proofs retain the exact committed 07aa47ba inputs. Only
// these independently read pre-extension identities, three new paths and the
// separately reviewed immutable-asset routing pair differ. Every other input
// remains live, and the separate current gate binds all current sources.
function septemberCheckpointEntries(fingerprint) {
  const sourceNavigationFingerprint =
    beforeMainAppsFlowFingerprint(fingerprint);
  const laterFiles = new Set([
    ...mixedProposalFiles,
    ...sourceNavigationAdditions,
    "frontend/app/src/utils/localAppDraftPersistence.ts",
    "frontend/app/src/utils/localAppDraftPresentation.ts",
    "frontend/app/src/utils/localAppEncryption.ts",
  ]);
  const beforeExtension = new Map([
    [
      "frontend/app/transformersWebGpuFeatureFlag.mjs",
      "41aafc4115aba2469e2d3b5f5ae212b4ee19651379b80644abc05b1d8fefb6c7",
    ],
    [
      "frontend/app/src/utils/transformersWebGpuInference.ts",
      "119af14a570ab4e37df34ab3272a43be47c6276f298955caf5d729deb2930b43",
    ],
    [
      "frontend/app/src/components_shared/PrivateAppDraftFields.svelte",
      "d92d1c009e31feac6171e3c77be9d6f9a991da16324740f3ad8b1841e198607f",
    ],
    [
      "frontend/app/src/components_shared/PrivateAppsWorkspace.svelte",
      "16a576ec2a9c8a08fa77bda70f4cfc26f8a58879898a365430254a0e31540a55",
    ],
    [
      "frontend/app/src/localAppHandoffRelay.ts",
      "5f758f1c026edca61965638be1e1a3006d68ebfc629b1179ae86bda47fef3efd",
    ],
    [
      "frontend/app/src/localNativeAppHandoff.ts",
      "2237706250985d601c0de73c98f18df3d227dd51c7170e3898a8a05403707352",
    ],
    [
      "frontend/app/src/utils/localAppCatalog.ts",
      "809df079e4f417435c87f3c8637b3ed024711cbae3e15cdac538dbbebc2c9449",
    ],
    [
      "frontend/app/src/utils/localAppDirectory.ts",
      "ce390c32cfd8e8019e9461168f92cd2d450fb4c5a3e47f8ea17e84fe24851376",
    ],
    [
      "frontend/app/src/utils/localAppDrafts.ts",
      "e53ca77a4fee7e49469efa67a9014386c5de0616b170b17e217d5bc7bdaeecd3",
    ],
    [
      "frontend/app/src/utils/localAppHandoff.ts",
      "5836223d6781760d71b1f2ef3854cb62902f9b81e2910c2b864ad75be728120c",
    ],
    [
      "frontend/app/src/utils/localAppRelayDelivery.ts",
      "d9eee3cc0b99f33c46dc3cf1ba239c4efe6bed2c295bf5eca6b381f34428bc8c",
    ],
    [
      "frontend/app/src/utils/nativeAppDelivery.ts",
      "a2a00ac40e7aab976d8c4360b3851c4f782d6481f29f381a1f3b72a2cba17d95",
    ],
    [
      "frontend/app/src/utils/privateAppWorkspace.ts",
      "9de2384df69c5e3d9597bbd47b7290e9d0a07cd6a44256860037d6969c13ec05",
    ],
    [
      "frontend/openchat-client/src/openchat.ts",
      "02ad6bbcf479dcbbe3953dde40d4de4b82b33f12f8432e3fa3d49beb54831225",
    ],
    [
      "frontend/openchat-shared/src/domain/worker.ts",
      "1ea0366173425e6d75e51a51959794c98a1b9289164d25167f44b5bc16f52bba",
    ],
    [
      "frontend/openchat-worker/src/worker.ts",
      "ca4e3b081c74a4b421d4f3598d3ea9631f36438d8aa803534f8bb3e5e112db42",
    ],
  ]);
  for (const path of [...laterFiles, ...beforeExtension.keys()])
    assert(sourceNavigationFingerprint.files.includes(path), path);
  const entries = sourceNavigationFingerprint.files
    .filter((path) => !laterFiles.has(path))
    .map((path) => [
      path,
      beforeExtension.get(path) ??
        beforeOctoberRefresh.get(path) ??
        beforeMainAppsFlow.get(path) ??
        beforeReplicaPortMerge.get(path) ??
        sourceHash(path),
    ]);
  assert.equal(entries.length, 148);
  assert.equal(
    createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    "f987610e19dd0790765bbe2209b109c7a987d10d09f082a0400e702efca5c67d",
  );
  return entries;
}

// Reverse only the reviewed cache-verifier responsiveness helpers. The exact
// pre-change file hash and aggregate below keep the earlier routing proof live.
function beforeCachedHashResponsiveness(source) {
  const prior = source
    .replace(
      /^async function yieldCachedHashTask\(\): Promise<void> \{[\s\S]*?^\}\n\n/mu,
      "",
    )
    .replace(
      /^    let readerCancelled = false;\n[\s\S]*?^    signal\?\.addEventListener\("abort", onAbort, \{ once: true \}\);\n/mu,
      "",
    )
    .replaceAll(
      "cancelReader(abortReason(signal));",
      "await reader.cancel(abortReason(signal));",
    )
    .replace(
      "                cancelReader();",
      "                await reader.cancel();",
    )
    .replace(
      "            // cancel() resolves a pending read with done=true; cancellation is not a short or\n" +
        "            // corrupt cache body and must never enter the caller's cache-eviction branch.\n" +
        "            if (signal?.aborted) throw abortReason(signal);\n",
      "",
    )
    .replace(
      "await yieldCachedHashTask();",
      "await new Promise<void>((resolve) => setTimeout(resolve, 0));",
    )
    .replace(
      "    } finally {\n" +
        '        signal?.removeEventListener("abort", onAbort);\n' +
        "        reader.releaseLock();\n",
      "",
    );
  assert.notEqual(prior, source);
  assert.equal(
    createHash("sha256").update(prior).digest("hex"),
    "e80115d3981346feb720c1732158663b330d57d144f669467278394a5698cd57",
  );
  return prior;
}

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
    "frontend/app/src/utils/localAppDraftChoices.ts",
    "frontend/app/src/utils/localAppHandoff.ts",
    "frontend/app/src/utils/localAppRelayDelivery.ts",
    "frontend/app/src/utils/localAppCardPreview.ts",
    "frontend/app/src/utils/privateAppWorkspace.ts",
    "frontend/app/src/utils/nativeAppDelivery.ts",
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
  assert(
    fingerprint.files.includes(
      "frontend/app/src/components_shared/LocalAppCards.svelte",
    ),
  );
  assert(
    !owned.includes("frontend/app/src/components_shared/LocalAppCards.svelte"),
  );
  for (const file of [
    "frontend/app/src/components/home/ChatMessage.svelte",
    "frontend/openchat-client/src/openchat.ts",
    "frontend/openchat-client/src/utils/browserPasskey.ts",
    "frontend/openchat-client/src/utils/browserAccountLink.ts",
    "frontend/openchat-worker/src/worker.ts",
    "frontend/openchat-service-worker/src/service_worker.ts",
    "frontend/app/src/components_shared/LocalAppCards.card.spec.ts",
    "frontend/app/src/components_shared/PrivateAppsNavigation.spec.shell.svelte",
    "frontend/app/src/utils/localAppDrafts.md",
  ])
    assert(
      !owned.includes(file),
      `mixed core, reached helpers, tests or docs must not become dedicated source: ${file}`,
    );
});

test("main Apps flow, retained local cards and startup completion have an exact current checkpoint", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const previous = beforeMainAppsFlowFingerprint(actual);
  assert.equal(
    previous.sha256,
    "a52d271ac945ba6ebd5971f10ca94d256db981fac53979542cbed8377025e4d9",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  assert.equal(featureOwnedFiles(root, config.scopeId).length, 123);
  assert.equal(actual.files.length, 171);
  assert.equal(config.seeds.length, 26);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  assert.equal(
    beforeReplicaPortMergeFingerprint(actual).sha256,
    "83d70d96f0b74618f59ef52327f2d3bf104a2895231e686f9557cb9e068a5b14",
  );

  const owned = featureOwnedFiles(root, config.scopeId);
  for (const file of mainAppsFlowAdditions) {
    assert(actual.files.includes(file), file);
    assert.equal(
      owned.includes(file),
      file === "frontend/app/src/utils/localAppDirectoryPresentation.ts",
      `Only the selector-matched presentation helper is a dedicated owner: ${file}`,
    );
  }
  assert(!existsSync(resolve(root, priorPrivateAppsWorkspace)));
  assert(!actual.files.includes(priorPrivateAppsWorkspace));
  for (const file of [
    "frontend/app/src/components_shared/LocalAppCards.card.spec.ts",
    "frontend/app/src/components_shared/LocalAppDirectory.spec.ts",
    "frontend/app/src/utils/localAppDirectoryPresentation.spec.ts",
    "frontend/app/src/utils/mainAppsNavigation.spec.ts",
    "frontend/openchat-agent/src/utils/indexedDb.spec.ts",
  ])
    assert(!actual.files.includes(file), file);

  const mainAppsNavigation = readFileSync(
    resolve(root, "frontend/app/src/utils/mainAppsNavigation.ts"),
    "utf8",
  );
  assert(
    mainAppsNavigation.indexOf("privateAppWorkspace.invalidateReview();") <
      mainAppsNavigation.indexOf("privateAppWorkspace.close();") &&
      mainAppsNavigation.indexOf("privateAppWorkspace.close();") <
        mainAppsNavigation.indexOf("navigate(MAIN_APPS_ROUTE);"),
  );
  assert.doesNotMatch(
    mainAppsNavigation,
    /clearCards|discardCard|forget|disconnectApp/u,
  );
  const directory = readFileSync(
    resolve(
      root,
      "frontend/app/src/components_shared/LocalAppDirectory.svelte",
    ),
    "utf8",
  );
  assert(directory.includes("Saved cards ({workspaceView.cards.length})"));
  assert(directory.includes("workspace.open();"));
  const userIndex = readFileSync(
    resolve(
      root,
      "frontend/openchat-agent/src/services/userIndex/userIndex.client.ts",
    ),
    "utf8",
  );
  assert.match(
    userIndex,
    /if \(isOffline && cachedUser === undefined\) \{\s*throw new Error\("Current user is unavailable offline without a cached profile"\);\s*\}/u,
  );
});

test("current encryption, recovery and enum-label owners use existing selectors without package or historical scope expansion", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const owned = featureOwnedFiles(root, config.scopeId);
  const fingerprint = seedSourceFingerprint(root, config);
  const additions = [
    "localAppDraftPersistence",
    "localAppDraftPresentation",
    "localAppEncryption",
  ];
  for (const name of additions) {
    const file = `frontend/app/src/utils/${name}.ts`;
    assert(owned.includes(file));
    assert(fingerprint.files.includes(file));
    assert(
      featureDependencySpecifiers(
        readFileSync(resolve(root, file), "utf8"),
      ).every((specifier) => specifier.startsWith("./")),
    );
    for (const historical of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
      assert(!featureOwnedFiles(root, historical).includes(file));
  }
  for (const suffix of [".testFixtures.ts", ".spec.ts"])
    assert(
      !fingerprint.files.includes(
        `frontend/app/src/utils/localAppEncryption${suffix}`,
      ),
    );
  assert.equal(owned.length, 123);
  assert.equal(fingerprint.files.length, 171);
  assert.equal(config.seeds.length, 26);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  assert.equal(
    fingerprint.sha256,
    "86b7835254837140bd452b4a0f722cbfd207d1ad15d5f6c7b9b66757e0e11dbc",
  );
  assertReviewedSourceFingerprint(fingerprint, config.sourceReview);
});

test("saved-card opt-in and recovery feedback preserve exact prior source identity and existing scope", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  assert.equal(actual.files.length, 171);
  assert.equal(featureOwnedFiles(root, config.scopeId).length, 123);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  assert.equal(config.seeds.length, 26);
  const expected = new Map([
    [
      "frontend/app/src/components_shared/LocalAppCards.svelte",
      "2b0fd86f1e0c6930c34d5ea7ad39ee2aba3d320ef44c0f1fb79944e827ae2606",
    ],
    [
      "frontend/app/src/components_shared/LocalAppsChatSettings.svelte",
      "d2c0834e74682803303b97607dff109027367aadc6d1e1dc28c20b762c1f4e1d",
    ],
    [
      "frontend/app/src/utils/privateAppWorkspace.ts",
      "98b3be56091a624a6e2af76dfb9922290459db7d992d0f9171603ac4079b78eb",
    ],
  ]);
  assert.deepEqual([...expected.keys()], [...beforeSavedCardUiFix.keys()]);
  for (const [file, digest] of expected) {
    assert(actual.files.includes(file), file);
    assert.equal(sourceHash(file), digest, file);
    assert.notEqual(digest, beforeSavedCardUiFix.get(file), file);
  }
  const prior = beforeSavedCardUiFixFingerprint(actual);
  assert.equal(
    prior.sha256,
    "7e72d8ee0dbb5bd42a8ee8546f4c21a6f992a8c10c4f83a7d5959198144774cd",
  );
  assert.equal(
    actual.sha256,
    "86b7835254837140bd452b4a0f722cbfd207d1ad15d5f6c7b9b66757e0e11dbc",
  );
  assertReviewedSourceFingerprint(prior, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  for (const file of [
    "frontend/app/src/components_shared/LocalAppCards.card.spec.ts",
    "frontend/app/src/components_shared/PrivateAppsNavigation.spec.ts",
    "frontend/app/src/utils/privateAppWorkspace.spec.ts",
    "frontend/app/src/utils/privateAppWorkspace.discovery.spec.ts",
  ])
    assert(!actual.files.includes(file), file);
});

test("incoming replica-port support preserves exact main Apps source history and fork proxy policy", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const fingerprint = seedSourceFingerprint(root, config);
  const read = (file) =>
    readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
  const reversals = [
    [
      "frontend/app/rollup.config.mjs",
      (text) =>
        text.replace(
          '            "import.meta.env.OC_REPLICA_PORT": maybeStringify(process.env.OC_REPLICA_PORT),\n',
          "",
        ),
    ],
    [
      "frontend/app/vite.config.ts",
      (text) =>
        text.replace(
          "                      target: process.env.OC_REPLICA_PORT\n                          ? `http://127.0.0.1:${process.env.OC_REPLICA_PORT}`\n                          : `http://${dfxJson.networks.local.bind}`,",
          "                      target: `http://${dfxJson.networks.local.bind}`,",
        ),
    ],
    [
      "frontend/openchat-client/src/openchat.ts",
      (text) =>
        text.replace(
          '${this.config.userIndexCanister}.raw.localhost:${import.meta.env.OC_REPLICA_PORT ?? "8080"}/metrics',
          "${this.config.userIndexCanister}.raw.localhost:8080/metrics",
        ),
    ],
  ];
  for (const [file, reverse] of reversals) {
    assert(fingerprint.files.includes(file));
    const current = read(file);
    const previous = reverse(current);
    assert.notEqual(previous, current, file);
    assert.equal(
      createHash("sha256").update(previous).digest("hex"),
      beforeReplicaPortMerge.get(file),
      file,
    );
    assert.deepEqual(
      featureDependencySpecifiers(current),
      featureDependencySpecifiers(previous),
    );
  }
  const previous = beforeReplicaPortMergeFingerprint(fingerprint);
  assert.equal(
    previous.sha256,
    "83d70d96f0b74618f59ef52327f2d3bf104a2895231e686f9557cb9e068a5b14",
  );
  assert.equal(
    beforeSavedCardUiFixFingerprint(fingerprint).sha256,
    "7e72d8ee0dbb5bd42a8ee8546f4c21a6f992a8c10c4f83a7d5959198144774cd",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(fingerprint, config.sourceReview);
  const vite = read("frontend/app/vite.config.ts");
  for (const required of [
    '"/hf-model"',
    "changeOrigin: true",
    'removeHeader("x-forwarded-host")',
    'removeHeader("x-forwarded-port")',
    'removeHeader("forwarded")',
    "envDir: unofficialLocalClient ? false : undefined",
  ])
    assert(vite.includes(required), required);
});

test("cache hashing responsiveness preserves exact prior source identity and integrity boundaries", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const file = "frontend/app/src/utils/transformersWebGpuInference.ts";
  const source = readFileSync(resolve(root, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "e797afe96025f79b8b0b9ebfc64aeee86aa1a9fa14a83d394d32dbe23b0693a2",
  );
  const prior = beforeCachedHashResponsiveness(source);
  assert.deepEqual(
    featureDependencySpecifiers(source),
    featureDependencySpecifiers(prior),
  );
  const previous = octoberPriorFingerprint(actual, new Map([[file, prior]]));
  assert.equal(
    previous.sha256,
    "95eb35428d98c8af8b7d7a81af121ccae5275d3aa09b2f8a0adc2a9e0abb0e62",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  assert.equal(actual.files.length, 171);
  assert.equal(featureOwnedFiles(root, config.scopeId).length, 123);
  assert.equal(config.seeds.length, 26);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  for (const unchanged of [
    "const CACHED_HASH_UPDATE_MAX_BYTES = 64 * 1024;",
    "const CACHED_HASH_TASK_MAX_BYTES = 4 * 1024 * 1024;",
    "const CACHED_HASH_TASK_BUDGET_MS = 8;",
    "return received === expectedBytes && digestHex(digest.digest()) === expectedSha256;",
  ]) {
    assert(source.includes(unchanged));
    assert(prior.includes(unchanged));
  }
});

test("unofficial immutable-asset routing preserves the exact prior source aggregate and feature roots", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const flag = "frontend/app/transformersWebGpuFeatureFlag.mjs";
  const inference = "frontend/app/src/utils/transformersWebGpuInference.ts";
  const text = (file) =>
    readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
  const prior = new Map([
    [
      flag,
      text(flag).replace(
        /\/\*\* Static unofficial previews use the immutable sources without becoming production builds\. \*\/\nexport function transformersWebGpuImmutableAssetsEnabled\(environment\) \{[\s\S]*?\n\}\n\n/u,
        "",
      ),
    ],
    [
      inference,
      beforeCachedHashResponsiveness(text(inference))
        .replaceAll(
          "transformersWebGpuImmutableAssetsEnabled",
          "transformersWebGpuProductionAssetsEnabled",
        )
        .replaceAll("immutableAssets", "productionAssets")
        .replace(
          " * Production web and the explicit unofficial static profile use the same sources, with those\n * graphs served by the web bundle. Only local-network development relies on the Vite model proxy.",
          " * The production web contract uses the same sources, with those graphs served by the web bundle.",
        ),
    ],
  ]);
  for (const [file, expected] of [
    [flag, "41aafc4115aba2469e2d3b5f5ae212b4ee19651379b80644abc05b1d8fefb6c7"],
    [
      inference,
      "119af14a570ab4e37df34ab3272a43be47c6276f298955caf5d729deb2930b43",
    ],
  ]) {
    assert.notEqual(prior.get(file), text(file));
    assert.equal(
      createHash("sha256").update(prior.get(file)).digest("hex"),
      expected,
    );
  }
  const previous = octoberPriorFingerprint(actual, prior);
  assert.equal(
    previous.sha256,
    "84f4494dc4a493fa56ac72f31a10c9a0055ab06ae493e4e073b2e4c30d590e08",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  assert.equal(actual.files.length, 171);
  assert.equal(config.seeds.length, 26);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  assert(
    !actual.files.includes("frontend/app/transformersWebGpuFeatureFlag.d.mts"),
  );
});

test("October merge and card controls retain the exact previous aggregate and fail closed on new imports or drift", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const previous = octoberPriorFingerprint(actual);
  assert.equal(
    previous.sha256,
    "68f06f6f5cf986b836f570e42102cf68125e425b08469a41a0073997c6c2cd42",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  const owned = featureOwnedFiles(root, config.scopeId);
  const names = new Set(
    config.seeds.map(
      (seed) => seed.name ?? seed.location.replace(/^node_modules\//u, ""),
    ),
  );
  const entries = actual.files.map((file) => [
    file,
    readFileSync(resolve(root, file)),
  ]);
  for (const file of beforeOctoberRefresh.keys()) {
    if (file === priorPrivateAppsWorkspace) {
      assert(!existsSync(resolve(root, file)));
      assert(
        actual.files.includes(
          "frontend/app/src/components_shared/LocalAppCards.svelte",
        ),
      );
      continue;
    }
    // Mixed upstream sources keep their anchored-only ownership; the four
    // dedicated presentation consumers remain subject to full import checks.
    const dedicated = file.startsWith("frontend/app/");
    assert.equal(owned.includes(file), dedicated);
    if (dedicated) {
      const source = readFileSync(resolve(root, file), "utf8");
      assertReviewedFeatureImports(source, names);
      assert.throws(
        () =>
          assertReviewedFeatureImports(
            `${source}\nimport "unreviewed-card-control";\n`,
            names,
          ),
        /no reviewed root/u,
      );
    }
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(
          sourceReviewFingerprintFromBytes(
            entries.map(([path, bytes]) => [
              path,
              path === file
                ? Buffer.concat([bytes, Buffer.from("\n// drift\n")])
                : bytes,
            ]),
          ),
          config.sourceReview,
        ),
      /source set changed/u,
    );
  }
  const presentation = readFileSync(
    resolve(root, "frontend/app/src/utils/localAppDraftPresentation.ts"),
    "utf8",
  );
  assert.deepEqual(featureDependencySpecifiers(presentation), [
    "./localAppCatalog",
    "./localAppDraftFields",
    "./localAppDrafts",
  ]);
  assert.doesNotMatch(
    presentation,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|indexedDB|localStorage|sessionStorage)\s*\(/u,
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
  assert.equal(owned.length, 123);
  assert.equal(fingerprint.files.length, 171);
  assert.equal(config.seeds.length, 26);
  assert.equal(
    config.seeds.reduce((count, seed) => count + seed.evidence.length, 0),
    108,
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
  assert.deepEqual(
    anchors.map((anchor) => anchor.contains).sort(),
    [
      "const webAuthnIdentity = new AndroidWebAuthnPasskeyIdentity((credentialId) =>",
      "return JSON.stringify([this.config.icUrl, this.config.userIndexCanister]);",
    ].sort(),
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
    "./localAppDirectory",
  ]);
  assert.match(source, /globalThis\.indexedDB/u);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|runIsolatedAppProcessor)\s*\(/u,
  );
});

test("card collection and bounded controls preserve the exact 5a36 source checkpoint without accepting current drift", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const previous = priorFingerprint(actual, beforeCardCollection);
  assert.equal(previous.files.length, 151);
  assert.equal(
    previous.sha256,
    "166cb8127e259451ac0041463ca814a941322ed5cf11894a990cbe0df7fe264d",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
  const owned = featureOwnedFiles(root, config.scopeId);
  const names = new Set(
    config.seeds.map(
      (seed) => seed.name ?? seed.location.replace(/^node_modules\//u, ""),
    ),
  );
  const entries = actual.files.map((file) => [
    file,
    readFileSync(resolve(root, file)),
  ]);
  for (const file of beforeCardCollection.keys()) {
    if (file === priorPrivateAppsWorkspace) {
      assert(!existsSync(resolve(root, file)));
      assert(
        actual.files.includes(
          "frontend/app/src/components_shared/LocalAppCards.svelte",
        ),
      );
      continue;
    }
    assert(owned.includes(file));
    const source = readFileSync(resolve(root, file), "utf8");
    assertReviewedFeatureImports(source, names);
    assert.throws(
      () =>
        assertReviewedFeatureImports(
          `${source}\nimport "unreviewed-private-card-package";\n`,
          names,
        ),
      /no reviewed root/u,
    );
    for (const changed of [
      entries.filter(([path]) => path !== file),
      entries.map(([path, bytes]) => [
        path,
        path === file
          ? Buffer.concat([bytes, Buffer.from("\n// unreviewed behavior\n")])
          : bytes,
      ]),
    ]) {
      assert.throws(
        () =>
          assertReviewedSourceFingerprint(
            sourceReviewFingerprintFromBytes(changed),
            config.sourceReview,
          ),
        /source set changed/u,
      );
    }
  }
});

for (const file of mixedProposalFiles) {
  test(`proposal source entry point is anchored but never a dedicated core import owner: ${file}`, () => {
    const config = JSON.parse(
      readFileSync(
        resolve(root, "scripts/npm_feature_scope.current-client.json"),
        "utf8",
      ),
    );
    const owned = featureOwnedFiles(root, config.scopeId);
    const actual = seedSourceFingerprint(root, config);
    assert(!owned.includes(file));
    assert(actual.files.includes(file));
    const svelte = config.seeds.find((seed) => seed.name === "svelte");
    assert.deepEqual(
      svelte.evidence.filter((entry) => entry.file === file),
      [{ file, contains: "messageId: capturedMessageId.toString()," }],
    );
    const source = readFileSync(resolve(root, file), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    assert.equal(
      source.split("messageId: capturedMessageId.toString(),").length,
      2,
    );
    assert(
      source.includes(
        "return proposePrivateAppMessage(client, capturedContent, {\n" +
          "                    stillCurrent,\n" +
          "                    onPhase,\n" +
          "                    sourceTimestamp: Number(timestamp),\n" +
          "                    source: {\n" +
          "                        chatKey: capturedChatKey,\n" +
          "                        chatKind: capturedChatKind,\n" +
          "                        messageId: capturedMessageId.toString(),\n" +
          "                        messageIndex: capturedMessageIndex,\n" +
          "                        ...(capturedContext.threadRootMessageIndex === undefined\n" +
          "                            ? {}\n" +
          "                            : {\n" +
          "                                  threadRootMessageIndex: capturedContext.threadRootMessageIndex,\n" +
          "                              }),\n" +
          "                    },\n" +
          "                });",
      ),
    );
    assert(source.includes("privateAppWorkspace.selectForProposal("));
    for (const captured of [
      "const capturedChatKey = chatIdentifierToString(chatId);",
      "const capturedChatKind = chatId.kind;",
      "const capturedMessageIndex = msg.messageIndex;",
      "chatId.kind === capturedChatKind &&",
      "msg.messageIndex === capturedMessageIndex &&",
    ])
      assert(source.includes(captured));
    const missing = structuredClone(config);
    missing.seeds.find((seed) => seed.name === "svelte").evidence =
      svelte.evidence.filter((entry) => entry.file !== file);
    assert.throws(
      () => reviewFeatureSeeds(root, missing),
      /source set changed/u,
    );
    const wrong = structuredClone(config);
    wrong.seeds
      .find((seed) => seed.name === "svelte")
      .evidence.find((entry) => entry.file === file).contains =
      "messageId: unreviewedMessageId.toString(),";
    assert.throws(
      () => reviewFeatureSeeds(root, wrong),
      /source ownership anchor changed/u,
    );
    const entries = actual.files.map((path) => [
      path,
      readFileSync(resolve(root, path)),
    ]);
    for (const changed of [
      entries.filter(([path]) => path !== file),
      entries.map(([path, bytes]) => [
        path,
        path === file
          ? Buffer.from(
              source.replace(
                "messageId: capturedMessageId.toString(),",
                "messageId: 'wrong-source',",
              ),
            )
          : bytes,
      ]),
      entries.map(([path, bytes]) => [
        path,
        path === file
          ? Buffer.concat([
              bytes,
              Buffer.from("\n// unreviewed mixed-file change\n"),
            ])
          : bytes,
      ]),
    ]) {
      assert.throws(
        () =>
          assertReviewedSourceFingerprint(
            sourceReviewFingerprintFromBytes(changed),
            config.sourceReview,
          ),
        /source set changed/u,
      );
    }
  });
}

test("source navigation preserves the exact committed 153-file checkpoint", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const actual = seedSourceFingerprint(root, config);
  const sourceNavigation = beforeMainAppsFlowFingerprint(actual);
  assert.equal(
    sourceNavigation.sha256,
    "a52d271ac945ba6ebd5971f10ca94d256db981fac53979542cbed8377025e4d9",
  );
  const files = sourceNavigation.files.filter(
    (file) => !sourceNavigationAdditions.includes(file),
  );
  assert.equal(files.length, 153);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const previous = {
    ...sourceNavigation,
    files,
    sha256: hash(
      JSON.stringify(
        files.map((file) => [
          file,
          beforeSourceNavigation.get(file) ??
            beforeMainAppsFlow.get(file) ??
            beforeReplicaPortMerge.get(file) ??
            sourceHash(file),
        ]),
      ),
    ),
  };
  assert.equal(
    previous.sha256,
    "8cc7a0ec5387cc68d875eb71e10f54e60efdf07c4ac020cbf9e23650954554a9",
  );
  assertReviewedSourceFingerprint(previous, config.sourceReview);
  assertReviewedSourceFingerprint(actual, config.sourceReview);
});

test("source navigation uses the real host codec and only the precisely reached router edge", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const owned = featureOwnedFiles(root, config.scopeId);
  const actual = seedSourceFingerprint(root, config);
  const helper = sourceNavigationAdditions[0];
  assert(owned.includes(helper));
  assert(!actual.files.includes(helper.replace(/\.ts$/u, ".spec.ts")));
  for (const file of sourceNavigationAdditions.slice(1)) {
    assert(actual.files.includes(file));
    assert(
      !owned.includes(file),
      "Reached mixed helpers must not become core import owners",
    );
  }
  for (const historical of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
    assert(!featureOwnedFiles(root, historical).includes(helper));
  const source = readFileSync(resolve(root, helper), "utf8");
  assert.deepEqual(featureDependencySpecifiers(source), [
    "@shared/domain",
    "@shared/utils/chat",
    "@shared/utils/routes",
    "@shared/utils/string",
    "./localAppDraftPersistence",
  ]);
  assert.doesNotMatch(
    source,
    /@shared\/utils\/map|chatIdentifierFromKey|chatIdentifierToKey/u,
  );
  assert(source.includes("chatIdentifierToString(chatId) !== source.chatKey"));
  assert(source.includes('source.chatKind === "direct_chat"'));
  assert(source.includes('source.chatKind === "group_chat"'));
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|indexedDB|localStorage|sessionStorage)\s*\(/u,
  );
  const ui = readFileSync(
    resolve(root, "frontend/app/src/components_shared/LocalAppCards.svelte"),
    "utf8",
  );
  assert(ui.includes('import { navigate } from "@utils/navigation";'));
  assert(ui.includes("navigate(route);"));
  const expected = new Map([
    [
      "svelte",
      [
        {
          file: "frontend/openchat-shared/src/utils/chat.ts",
          contains:
            "export function chatIdentifierToString(chatId: ChatIdentifier): string {",
        },
        {
          file: "frontend/openchat-shared/src/utils/routes.ts",
          contains: "export function routeForMessage(",
        },
        {
          file: "frontend/openchat-shared/src/utils/routes.ts",
          contains: "export function routeForMessageContext(",
        },
      ],
    ],
    [
      "@icp-sdk/core",
      [
        {
          file: "frontend/openchat-shared/src/utils/string.ts",
          contains: "Principal.fromText(text);",
        },
      ],
    ],
    [
      "page",
      [
        {
          file: "frontend/app/src/utils/navigation.ts",
          contains: 'import page from "page";',
        },
        {
          file: "frontend/app/src/utils/navigation.ts",
          contains:
            'export function navigate(to: string, intent: NavigationIntent = "in-app") {',
        },
        { file: "frontend/app/src/utils/navigation.ts", contains: "page(to);" },
        {
          file: "frontend/app/src/utils/navigation.ts",
          contains: "page.replace(to);",
        },
      ],
    ],
  ]);
  for (const [name, anchors] of expected) {
    const seed = config.seeds.find((entry) => entry.name === name);
    assert(seed);
    assert.deepEqual(
      seed.evidence.filter((entry) =>
        sourceNavigationAdditions.includes(entry.file),
      ),
      anchors,
    );
    for (const anchor of anchors) {
      const wrong = structuredClone(config);
      wrong.seeds
        .find((entry) => entry.name === name)
        .evidence.find(
          (entry) =>
            entry.file === anchor.file && entry.contains === anchor.contains,
        ).contains = "unreviewed navigation ownership";
      assert.throws(
        () => reviewFeatureSeeds(root, wrong),
        /source ownership anchor changed/u,
      );
    }
  }
  const manifest = JSON.parse(
    readFileSync(resolve(root, "frontend/package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(resolve(root, "frontend/package-lock.json"), "utf8"),
  );
  assert.equal(manifest.dependencies.page, "^1.3.7");
  assert.equal(lock.packages["node_modules/page"].version, "1.11.6");
  const missing = structuredClone(config);
  missing.seeds = missing.seeds.filter((seed) => seed.name !== "page");
  assert.throws(
    () => reviewFeatureSeeds(root, missing),
    /reviewed feature root set changed/u,
  );
});

for (const file of sourceNavigationAdditions) {
  test(`source navigation rejects removed or changed scoped input: ${file}`, () => {
    const config = JSON.parse(
      readFileSync(
        resolve(root, "scripts/npm_feature_scope.current-client.json"),
        "utf8",
      ),
    );
    const actual = seedSourceFingerprint(root, config);
    const entries = actual.files.map((path) => [
      path,
      readFileSync(resolve(root, path)),
    ]);
    for (const changed of [
      entries.filter(([path]) => path !== file),
      entries.map(([path, bytes]) => [
        path,
        path === file
          ? Buffer.concat([
              bytes,
              Buffer.from("\n// unreviewed navigation change\n"),
            ])
          : bytes,
      ]),
    ])
      assert.throws(
        () =>
          assertReviewedSourceFingerprint(
            sourceReviewFingerprintFromBytes(changed),
            config.sourceReview,
          ),
        /source set changed/u,
      );
  });
}

test("current app discovery and setup include every production owner but no test fixture or historical scope expansion", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const owned = featureOwnedFiles(root, config.scopeId);
  const fingerprint = seedSourceFingerprint(root, config);
  const additions = new Map([
    [
      "frontend/app/src/utils/localAppDirectory.ts",
      ["./localAppCatalog", "./isolatedAppProcessor"],
    ],
    [
      "frontend/app/src/utils/localAppSetupConnection.ts",
      [
        "@tauri-apps/api/core",
        "./localAppDirectory",
        "./localAppHandoff",
        "./localAppSetupPopup",
        "tauri-plugin-oc-api/commands/localAppSetup",
        "tauri-plugin-oc-api/commands/openUrl",
      ],
    ],
    ["frontend/app/src/utils/localAppSetupPopup.ts", ["./localAppHandoff"]],
    ["frontend/app/local-native-app-setup.html", []],
    ["frontend/app/public/local-app-setup.html", []],
    ["frontend/app/src/localAppSetupRelay.ts", ["./utils/localAppSetupPopup"]],
    [
      "frontend/app/localNativeAppSetupBuild.mjs",
      ["node:fs/promises", "node:url", "esbuild"],
    ],
    ["frontend/app/src/localNativeAppSetup.ts", ["./utils/localAppSetupPopup"]],
    [
      "frontend/tauri-plugin-oc/guest-js/commands/localAppSetup.ts",
      ["@tauri-apps/api/core"],
    ],
  ]);
  const roots = new Set(
    config.seeds.map(
      (seed) => seed.name ?? seed.location.replace(/^node_modules\//u, ""),
    ),
  );
  for (const [file, imports] of additions) {
    assert(owned.includes(file), `Missing production owner: ${file}`);
    assert(
      fingerprint.files.includes(file),
      `Missing source identity: ${file}`,
    );
    const source = readFileSync(resolve(root, file), "utf8");
    assert.deepEqual(featureDependencySpecifiers(source), imports, file);
    assertReviewedFeatureImports(source, roots);
    assert.throws(
      () =>
        assertReviewedFeatureImports(
          `${source}\nimport "unreviewed-setup-package";\n`,
          roots,
        ),
      /no reviewed root: unreviewed-setup-package/u,
    );
    for (const scope of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
      assert(
        !featureOwnedFiles(root, scope).includes(file),
        `Historical scope expanded: ${scope}: ${file}`,
      );
  }
  const fixture = "frontend/app/src/utils/localAppDirectory.testFixtures.ts";
  assert(!owned.includes(fixture));
  assert(!fingerprint.files.includes(fixture));
});

test("retained legacy native sign-in helpers have exact reviewed imports and fail closed on source drift", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const owned = featureOwnedFiles(root, config.scopeId);
  const fingerprint = seedSourceFingerprint(root, config);
  const additions = new Map([
    [
      "frontend/app/localBrowserAuthBuild.mjs",
      ["node:fs/promises", "node:url", "esbuild"],
    ],
    ["frontend/app/local-browser-auth.html", []],
    [
      "frontend/app/src/localBrowserAuth.ts",
      [
        "@icp-sdk/core/identity",
        "@icp-sdk/core/agent",
        "@agent/services/identityAgent",
        "@agent/services/nativeBrowserAccountSession",
        "@client/utils/browserAccountLink",
        "@client/utils/nativeBrowserAuth",
        "@client/utils/nativeBrowserSigner",
      ],
    ],
    [
      "frontend/openchat-client/src/utils/nativeBrowserAuth.ts",
      [
        "@icp-sdk/core/agent",
        "@icp-sdk/core/identity",
        "@icp-sdk/core/principal",
        "@shared/utils/nativeBrowserSession",
      ],
    ],
    [
      "frontend/openchat-client/src/utils/nativeBrowserSigner.ts",
      [
        "@icp-sdk/core/agent",
        "@icp-sdk/core/identity",
        "@icp-sdk/core/principal",
        "./browserPasskey",
        "./nativeBrowserAuth",
      ],
    ],
    [
      "frontend/openchat-client/src/utils/nativeBrowserSignInFlow.ts",
      ["@icp-sdk/core/identity", "./nativeBrowserAuth"],
    ],
    [
      "frontend/openchat-client/src/utils/nativeBrowserSessionStorage.ts",
      [
        "idb",
        "@icp-sdk/core/identity",
        "@icp-sdk/core/principal",
        "@shared/utils/nativeBrowserSession",
      ],
    ],
    [
      "frontend/openchat-agent/src/services/nativeBrowserAccountSession.ts",
      [
        "@icp-sdk/core/agent",
        "@icp-sdk/core/identity",
        "@icp-sdk/core/principal",
        "@shared/utils/nativeBrowserSession",
        "@shared",
        "../typebox",
        "./identity/identity.client",
        "./canisterAgent/msgpack",
        "./userIndex/mappers",
      ],
    ],
    [
      "frontend/openchat-shared/src/utils/nativeBrowserSession.ts",
      [
        "@icp-sdk/core/identity",
        "@icp-sdk/core/principal",
        "../domain/identity",
      ],
    ],
    [
      "frontend/tauri-plugin-oc/guest-js/commands/localBrowserAuth.ts",
      ["@tauri-apps/api/core"],
    ],
  ]);
  const roots = new Set(
    config.seeds.map(
      (seed) => seed.name ?? seed.location.replace(/^node_modules\//u, ""),
    ),
  );
  const entries = fingerprint.files.map((file) => [
    file,
    readFileSync(resolve(root, file)),
  ]);
  for (const [file, imports] of additions) {
    assert(owned.includes(file), `Missing approved auth owner: ${file}`);
    assert(
      fingerprint.files.includes(file),
      `Missing source identity: ${file}`,
    );
    const source = readFileSync(resolve(root, file), "utf8");
    assert.deepEqual(featureDependencySpecifiers(source), imports, file);
    assertReviewedFeatureImports(source, roots);
    assert.throws(
      () =>
        assertReviewedFeatureImports(
          `${source}\nimport "unreviewed-native-auth-package";\n`,
          roots,
        ),
      /no reviewed root: unreviewed-native-auth-package/u,
    );
    for (const historical of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
      assert(
        !featureOwnedFiles(root, historical).includes(file),
        `Historical scope expanded: ${file}`,
      );
    for (const changed of [
      entries.filter(([entry]) => entry !== file),
      entries.map(([entry, bytes]) => [
        entry,
        entry === file
          ? Buffer.concat([bytes, Buffer.from("\n// changed auth behavior\n")])
          : bytes,
      ]),
    ])
      assert.throws(
        () =>
          assertReviewedSourceFingerprint(
            sourceReviewFingerprintFromBytes(changed),
            config.sourceReview,
          ),
        /feature source set changed/u,
      );
  }
  for (const file of [
    "frontend/openchat-client/src/openchat.ts",
    "frontend/openchat-worker/src/worker.ts",
    "frontend/openchat-client/src/utils/browserPasskey.ts",
    "frontend/openchat-client/src/utils/browserAccountLink.ts",
    "frontend/openchat-agent/src/services/identityAgent.ts",
    "frontend/openchat-agent/src/utils/singleSubmissionFetch.ts",
  ]) {
    assert(
      !owned.includes(file),
      `Mixed/reached source must not expand direct-import scope: ${file}`,
    );
    assert(
      fingerprint.files.includes(file),
      `Missing exact reached-source identity: ${file}`,
    );
    assert(
      config.seeds.some((seed) =>
        seed.evidence.some((item) => item.file === file),
      ),
      file,
    );
  }
});

test("current auth uses original upstream paths without activating retained browser-session helpers", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const fingerprint = seedSourceFingerprint(root, config);
  const read = (file) =>
    readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
  const client = read("frontend/openchat-client/src/openchat.ts");
  assert.match(
    client,
    /this\.#authIdentityStorage = IdentityStorage\.createForAuthIdentity\(\)/u,
  );
  assert.match(client, /this\.#authClient = AuthClient\.create\(/u);
  assert.match(client, /this\.#authIdentityStorage\.getKeyAndChain\(\)/u);
  assert.match(client, /new AndroidWebAuthnPasskeyIdentity\(/u);
  assert.doesNotMatch(
    client,
    /nativeBrowser|nativeSession|localBrowserAuth|existingAccountOnly/u,
  );
  const worker = read("frontend/openchat-worker/src/worker.ts");
  assert.match(worker, /ocIdentityStorage\.get\(authPrincipalString\)/u);
  assert.match(worker, /identityAgent\.getOpenChatIdentity\(sessionKey\)/u);
  assert.match(
    worker,
    /assertUnofficialApiRequestAllowed\(payload, config\.clientOnlyApps\)/u,
  );
  assert.doesNotMatch(
    worker,
    /nativeBrowserSession|validateNativeBrowserSession|authRequestGeneration|singleSubmission/u,
  );
  const protocol = read("frontend/openchat-shared/src/domain/worker.ts");
  assert.match(
    protocol,
    /export type SetAuthIdentity = \{\s*kind: "setAuthIdentity";\s*identity: JsonnableIdentityKeyAndChain \| undefined;\s*isIIPrincipal: boolean;\s*\};/u,
  );
  for (const file of [
    "frontend/app/src/components/onboard/OnboardModal.svelte",
    "frontend/app/src/components_mobile/onboard/OnboardModal.svelte",
  ]) {
    assert(fingerprint.files.includes(file), file);
    assert.doesNotMatch(
      read(file),
      /ExistingAccountSignIn|existingAccountOnly|nativeBrowser|nativeSession/u,
    );
  }
  const removed =
    "frontend/app/src/components_shared/ExistingAccountSignIn.svelte";
  assert(
    !existsSync(resolve(root, removed)),
    "The replacement auth screen must remain removed",
  );
  assert(!fingerprint.files.includes(removed));
  for (const file of [
    "frontend/app/src/components/App.svelte",
    "frontend/app/src/components_mobile/App.svelte",
  ]) {
    assert.match(
      read(file),
      /clientOnlyApps: import\.meta\.env\.OC_UNOFFICIAL_CLIENT === "true"/u,
    );
    assert.doesNotMatch(read(file), /existingAccountOnly/u);
  }
  for (const file of [
    "frontend/app/src/utils/nativeAppDelivery.ts",
    "frontend/app/src/components_shared/LocalAppCards.svelte",
  ]) {
    assert.match(read(file), /clientOnlyApps/u);
    assert.doesNotMatch(read(file), /existingAccountOnly/u);
  }
  assert.doesNotMatch(
    read("frontend/app/rollup.config.mjs"),
    /localBrowserAuthBuildPlugin/u,
  );
  const builder = read("scripts/build-unofficial-local-apk.mjs");
  assert.doesNotMatch(builder, /local-test-browser-auth/u);
  assert.match(
    builder,
    /"transformers-webgpu-android,local-test-app-handoff"/u,
  );
  assert.match(
    builder,
    /existsSync\(path\.join\(output, "local-browser-auth\.html"\)\)/u,
  );
  assert.match(builder, /browser authentication assets must be absent/u);
  assert(
    config.sourceReview.snapshots.some(
      (s) =>
        s.sha256 ===
        "bf0884970516515d0cd38b6a405e858c2db331bcbf633b6371320e91275153c9",
    ),
    "Preserve the prior browser-auth review as historical evidence",
  );
});

test("current mobile error translation is an exact presentation-only source checkpoint", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const fingerprint = seedSourceFingerprint(root, config);
  const file = "frontend/app/src/components_mobile/onboard/OnboardModal.svelte";
  assert(fingerprint.files.includes(file));
  const source = readFileSync(resolve(root, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  assert.equal(
    hash(source),
    "251df92cfea239711f19508c72e08c50c0a5424c9285c7762ba9bf262ffae6e8",
  );
  const prior = source
    .replace(
      '    import { nativeAuthErrorKey } from "@src/utils/nativeAuthErrorKey";\n',
      "",
    )
    .replace("i18nKey(nativeAuthErrorKey(error))", "i18nKey(error)");
  assert.equal(
    hash(prior),
    "1c93d07d7b15826a5c0af8a593a86cffc092ff3dd1eb39911cb4a37114fb7785",
  );
  // The mobile file is unchanged by the later upstream merge. Preserve its exact
  // two-line proof and both historical aggregates by using only these eight
  // pre-merge UTF-8/LF identities, independently read from committed 77346e24c.
  // The later extension helper preserves the separately committed September inputs.
  const beforeUpstreamMerge = new Map([
    [
      "frontend/app/rollup.config.mjs",
      "4d9e53801963c6fd2b4c140541f69fd5533384666f3db2a22d427e6a5d049f70",
    ],
    [
      "frontend/app/rollup.extras.mjs",
      "af79b09b85c1bf33abc5f728ac12a7065373bd6004a8329b8d9a261a3c18838f",
    ],
    [
      "frontend/app/src/i18n/i18n.ts",
      "652babbd5f519e9235b52a3bdae96f7990cce8299356e11455c556d0c1531d63",
    ],
    [
      "frontend/app/vite.config.ts",
      "a6bfc68fcb43b1eccd1c90f773dc444a5518570214f97cb88f1576d268389903",
    ],
    [
      "frontend/openchat-agent/src/utils/chatsDb.ts",
      "e24ddc9bf370175d8fba07e1eea520edff6074addeb399d35e6e306560c184ff",
    ],
    [
      "frontend/openchat-client/src/openchat.ts",
      "84c874b06aa6c80707b9090e55e935c071796be443badbc05f074798281ff3d2",
    ],
    [
      "frontend/openchat-shared/src/domain/worker.ts",
      "df4bdec82f39446c92ff6f32616cc99337c7fe2c4499f40a1dc7763cc1652f94",
    ],
    [
      "frontend/openchat-worker/src/worker.ts",
      "5cb2c5b0b9e2100e6701dcaf7672ceca8c2c2ed87d82c04cfb6ae6eb5469f1ff",
    ],
  ]);
  for (const entry of beforeUpstreamMerge.keys())
    assert(fingerprint.files.includes(entry), entry);
  const checkpointFingerprint = (mobileSource) => ({
    ...fingerprint,
    sha256: hash(
      JSON.stringify(
        septemberCheckpointEntries(fingerprint).map(
          ([entry, checkpointHash]) => [
            entry,
            entry === file
              ? hash(mobileSource)
              : (beforeUpstreamMerge.get(entry) ?? checkpointHash),
          ],
        ),
      ),
    ),
  });
  const previousFingerprint = checkpointFingerprint(prior);
  const translatedFingerprint = checkpointFingerprint(source);
  assert.equal(
    previousFingerprint.sha256,
    "425a64c8f66fb23956590bc0a698e865bbf1e606d3144b2e8411ad3dc2f1898c",
  );
  assert.equal(
    translatedFingerprint.sha256,
    "09b7e91e437cfbfb58c6029fbd51066967ffd27899a3406206dee87514e16341",
  );
  assertReviewedSourceFingerprint(previousFingerprint, config.sourceReview);
  assertReviewedSourceFingerprint(translatedFingerprint, config.sourceReview);
  assertReviewedSourceFingerprint(fingerprint, config.sourceReview);
});

test("current upstream merge preserves scoped startup, model and private-app boundaries", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const read = (file) =>
    readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const fingerprint = seedSourceFingerprint(root, config);
  assert.equal(fingerprint.files.length, 171);
  assert.equal(featureOwnedFiles(root, config.scopeId).length, 123);
  assert.equal(config.seeds.length, 26);
  assert.equal(config.seeds.flatMap((seed) => seed.evidence).length, 108);
  // Preserve the committed merge identity after the separately reviewed Windows
  // path-only repair and the independently bound later-extension identities.
  const mergeFingerprint = {
    ...fingerprint,
    sha256: hash(
      JSON.stringify(
        septemberCheckpointEntries(fingerprint).map(
          ([file, checkpointHash]) => [
            file,
            file === "frontend/app/rollup.extras.mjs"
              ? "ed9641516ca65a821c6b4a5f4bcae1e51449be786d1ddbed04fdc2b2d7e32203"
              : checkpointHash,
          ],
        ),
      ),
    ),
  };
  assert.equal(
    mergeFingerprint.sha256,
    "3e5e911fe406ba81cee7320c706bc1482ffdc02b977f684b5cc55185e0fcdb33",
  );
  assertReviewedSourceFingerprint(mergeFingerprint, config.sourceReview);
  assertReviewedSourceFingerprint(fingerprint, config.sourceReview);
  const rollup = read("frontend/app/rollup.config.mjs");
  assert.match(rollup, /prestartWorker: !development \|\| isNativeApp/u);
  assert.match(
    rollup,
    /generateCspForScripts\(\s*\[startupScript, \.\.\.inlineScripts\],\s*development,\s*process\.env\.OC_UNOFFICIAL_CLIENT === "true",\s*\)/u,
  );
  const extras = read("frontend/app/rollup.extras.mjs");
  assert.match(extras, /prestartWorker = true/u);
  assert.match(extras, /prestartWorker\s*\? `try/u);
  assert.match(extras, /window\.OC_PRESTARTED_WORKER = new Worker/u);
  // These two separately reviewed merge seams are not new dependency owners.
  const main = read("frontend/app/src/main.ts");
  assert.equal(
    hash(main),
    "ee353591455581bda225592981fbc9ec9f0f56641c50fe9b070d6f84f0327696",
  );
  assert(
    main.indexOf("await prepareServiceWorkerBeforeApplicationStart()") <
      main.indexOf(
        "if (usesWebInferenceRuntime()) void ensureWebModelRestored();",
      ),
  );
  assert.match(main, /const recovery = mount\(StartupFailure,/u);
  assert.match(main, /clearStartupBackground\(\);\s*return recovery/u);
  assert.match(main, /clearStartupBackground\(\);\s*return mounted/u);
  const worker = read("frontend/openchat-client/src/workerAgent.ts");
  assert.equal(
    hash(worker),
    "e6542c4c3900ac708aa7d3df2a9f2f038e41b40cda3e6682d6da71d50274e5a6",
  );
  assert.match(worker, /try \{\s*worker =\s*takePrestartedWorker\(\) \?\?/u);
  assert.match(worker, /window\.OC_PRESTARTED_WORKER = undefined/u);
  assert.match(
    worker,
    /assertUnofficialApiRequestAllowed\(req, this\.#clientOnlyApps\)/u,
  );
  assert.match(worker, /WORKER_STARTUP_REQUEST_TIMEOUT_MS = 30_000/u);
  assert.match(worker, /this\.#onFatalError\?\.\(error\)/u);
  assert.match(
    worker,
    /console\.debug\("WORKER_CLIENT: response", data\.requestKind, data\.correlationId\)/u,
  );
});

test("Windows startup module-ID repair preserves the exact committed merge checkpoint", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const fingerprint = seedSourceFingerprint(root, config);
  const file = "frontend/app/rollup.extras.mjs";
  const source = readFileSync(resolve(root, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  assert.equal(
    hash(source),
    "22bf93228b94a0cf4666eade3ca004278dc351fdfddc8937a69a86a11c3d5658",
  );
  const prior = source
    .replace(
      '        const app = chunks.find((c) =>\n            c.moduleIds.some((id) => id.replaceAll("\\\\", "/").endsWith(root)),\n        );',
      "        const app = chunks.find((c) => c.moduleIds.some((id) => id.endsWith(root)));",
    )
    .replace(
      '                // Rollup preserves native separators for JSON modules on Windows,\n                // while other plugins may already return slash-normalized IDs.\n                const locale = id.replaceAll("\\\\", "/").match',
      "                const locale = id.match",
    );
  assert.equal(
    hash(prior),
    "ed9641516ca65a821c6b4a5f4bcae1e51449be786d1ddbed04fdc2b2d7e32203",
  );
  const checkpointEntries = septemberCheckpointEntries(fingerprint);
  const restored = {
    ...fingerprint,
    files: checkpointEntries.map(([entry]) => entry),
    sha256: hash(
      JSON.stringify(
        checkpointEntries.map(([entry, checkpointHash]) => [
          entry,
          entry === file ? hash(prior) : checkpointHash,
        ]),
      ),
    ),
  };
  assert.equal(
    restored.sha256,
    "3e5e911fe406ba81cee7320c706bc1482ffdc02b977f684b5cc55185e0fcdb33",
  );
  assert.equal(
    hash(JSON.stringify(checkpointEntries)),
    "f987610e19dd0790765bbe2209b109c7a987d10d09f082a0400e702efca5c67d",
  );
  assertReviewedSourceFingerprint(restored, config.sourceReview);
  assertReviewedSourceFingerprint(fingerprint, config.sourceReview);
});

test("current named-choice module is app-owned and cannot disappear or add an unreviewed import", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "scripts/npm_feature_scope.current-client.json"),
      "utf8",
    ),
  );
  const file = "frontend/app/src/utils/localAppDraftChoices.ts";
  const source = readFileSync(resolve(root, file), "utf8");
  const owned = featureOwnedFiles(root, config.scopeId);
  const actual = seedSourceFingerprint(root, config);
  assert(owned.includes(file));
  assert(actual.files.includes(file));
  for (const historical of ["pr1-model-npm", "pr2-app-card-ocr-npm"])
    assert(!featureOwnedFiles(root, historical).includes(file));
  assert.deepEqual(featureDependencySpecifiers(source), [
    "./localAppCatalog",
    "./localAppDrafts",
    "./localAppDraftFields",
  ]);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|indexedDB|localStorage|sessionStorage)\b/u,
  );
  const names = new Set(
    config.seeds.map(
      (seed) => seed.name ?? seed.location.replace(/^node_modules\//u, ""),
    ),
  );
  assertReviewedFeatureImports(source, names);
  assert.throws(
    () =>
      assertReviewedFeatureImports(
        `${source}\nimport "unreviewed-choice-package";\n`,
        names,
      ),
    /no reviewed root: unreviewed-choice-package/u,
  );
  const entries = actual.files.map((entry) => [
    entry,
    readFileSync(resolve(root, entry)),
  ]);
  for (const changed of [
    entries.filter(([entry]) => entry !== file),
    entries.map(([entry, bytes]) => [
      entry,
      entry === file
        ? Buffer.concat([bytes, Buffer.from("\n// changed choice behavior\n")])
        : bytes,
    ]),
  ])
    assert.throws(
      () =>
        assertReviewedSourceFingerprint(
          sourceReviewFingerprintFromBytes(changed),
          config.sourceReview,
        ),
      /source set changed/u,
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
    [
      "catalog",
      "appId",
      "actionId",
      "processor",
      "processors",
      "installations",
      "disabledAppIds",
      "enabledChats",
    ],
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
    "#select",
    "importProcessor",
    "replaceEnabledChats",
  ])
    assert.match(method(name), /#saveSetup\(/u, name);
  assert.match(
    method("select"),
    /return this\.#select\(appId, actionId, false\)/u,
  );
  assert.match(
    method("selectForProposal"),
    /return this\.#select\(appId, actionId, true\)/u,
  );
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
    /exact\(\s*value,\s*\["catalog", "enabledChats"\],\s*\["appId", "actionId", "processor", "processors", "installations", "disabledAppIds"\],?\s*\)/u,
  );
  assert.match(store, /exact\(row, \["appId", "artifact"\]\)/u);
  assert.match(
    store,
    /exact\(row\.artifact, \["source", "sha256", "byteLength"\]\)/u,
  );
  assert.match(store, /artifact\.sha256 !== owner\.processor\.sha256/u);
  assert.match(store, /artifact\.byteLength !== owner\.processor\.byteLength/u);
  assert.match(store, /verifyImportedLocalProcessor\(row\.artifact\)/u);
  assert.match(
    store,
    /exact\(entry, \["appId", "sourceUrl", "descriptor", "publicCatalogJson"\]\)/u,
  );
  assert.match(store, /validateLocalAppInstallation\(/u);
  for (const field of ["processors", "installations", "disabledAppIds"])
    assert.match(store, new RegExp(`value\\.${field}\\.length > 16`, "u"));
  assert.match(
    store,
    /new Set\(value\.disabledAppIds\)\.size !== value\.disabledAppIds\.length/u,
  );
  assert.match(
    store,
    /appIds\.some\(\(id\) => disabledAppIds\?\.includes\(id\)\)/u,
  );
  assert.doesNotMatch(
    store,
    /\b(?:fetch|WebSocket|XMLHttpRequest|Worker|runIsolatedAppProcessor)\s*\(/u,
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
    assert.equal(result.roots, 26);
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
