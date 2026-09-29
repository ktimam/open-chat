// Current model/private-app native licenses only. No advisory query, install,
// core-package audit, license waiver or release approval.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedSecurityRules } from "./security_owned_rules.mjs";
import { verifyRustFeatureScopeReview } from "./rust_feature_seed_review.mjs";
import { lockIdentities } from "./rust_feature_scope.mjs";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
// The historical PR1 rule remains unchanged. The current lock selects this
// compatible transitive version for the optional native inference profiles.
// This is a reviewed exact identity, not a same-name or latest-version fallback.
const CURRENT_MODEL_IDENTITY_RESOLUTIONS = [
  {
    name: "llama-cpp-sys-2",
    historicalVersion: "0.1.150",
    version: "0.1.154",
    source: REGISTRY,
    checksum:
      "13a9ea2ce0cdc20bcb1870534022e340b391663f8fe09133951e2fe37fbc29cf",
    parent: { name: "llama-cpp-2", version: "0.1.150", source: REGISTRY },
    dependencyName: "llama_cpp_sys_2",
    dependencyKind: null,
    dependencyTarget: null,
  },
];
const key = ({ name, version, source }) =>
  JSON.stringify([name, version, source]);
const normalizedHash = (bytes) =>
  createHash("sha256")
    .update(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(bytes)
        .replaceAll("\r\n", "\n"),
    )
    .digest("hex");
const exactKeys = (value, expected) =>
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    "Unexpected license policy fields",
  );
export const CURRENT_CLIENT_LICENSE_NOTICES = Object.freeze([
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES/Apache-2.0.txt",
  "THIRD_PARTY_LICENSES/MIT.txt",
]);

export function currentClientInputPath(root, name) {
  assert.ok(
    typeof name === "string" &&
      name.length > 0 &&
      !/[\\:\0]/u.test(name) &&
      !isAbsolute(name) &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    "Review input must be a canonical repository-relative path",
  );
  return resolve(root, name);
}

export function validateCurrentClientLicenses({
  config,
  configBytes,
  cargoLock,
  policy,
  metadata,
  tauriConfig,
  localTestConfig,
  noticeExists,
}) {
  exactKeys(policy, [
    "schemaVersion",
    "scope",
    "cargoLockSha256",
    "sourceScopeSha256",
    "modelIdentityResolutions",
    "packages",
  ]);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.scope, "current-client");
  assert.deepEqual(
    JSON.parse(Buffer.from(configBytes).toString("utf8")),
    config,
  );
  assert.equal(
    policy.sourceScopeSha256,
    normalizedHash(configBytes),
    "Stale current license source inventory",
  );
  assert.equal(
    policy.cargoLockSha256,
    normalizedHash(cargoLock),
    "Stale current license lock",
  );
  assert.equal(
    config.cargoLockSha256,
    policy.cargoLockSha256,
    "License and source review locks differ",
  );
  assert.ok(
    Array.isArray(config.seeds) && config.seeds.length > 0,
    "Missing reviewed source roots",
  );
  const required = new Map();
  for (const seed of config.seeds) {
    const value = seed.expected;
    assert.ok(
      value &&
        typeof value.name === "string" &&
        typeof value.version === "string" &&
        typeof value.source === "string" &&
        /^(registry|git)\+/u.test(value.source),
      "Unreviewed external root identity",
    );
    required.set(key(value), value);
  }
  const inherited = ownedSecurityRules("pr1").introducedRustPackages;
  assert.deepEqual(
    policy.modelIdentityResolutions,
    CURRENT_MODEL_IDENTITY_RESOLUTIONS,
    "Unreviewed current model identity resolution",
  );
  const inheritedCurrent = inherited.map((value) => {
    const resolution = policy.modelIdentityResolutions.find(
      (candidate) =>
        candidate.name === value.name &&
        candidate.historicalVersion === value.version,
    );
    return {
      ...value,
      version: resolution?.version ?? value.version,
      source: REGISTRY,
    };
  });
  for (const value of inheritedCurrent) required.set(key(value), value);
  assert.ok(Array.isArray(policy.packages) && policy.packages.length > 0);
  const reviewed = new Map();
  for (const value of policy.packages) {
    exactKeys(value, ["name", "version", "source", "license"]);
    assert.ok(
      typeof value.license === "string" &&
        value.license.trim() &&
        !/UNKNOWN|NOASSERTION/iu.test(value.license),
      "An explicit reviewed SPDX license is required",
    );
    assert.ok(!reviewed.has(key(value)), "Duplicate reviewed license identity");
    reviewed.set(key(value), value);
  }
  assert.deepEqual(
    [...reviewed.keys()].sort(),
    [...required.keys()].sort(),
    "License policy must cover exactly current owner roots plus retained model license requirements",
  );
  for (const expected of inheritedCurrent) {
    assert.equal(
      reviewed.get(key(expected)).license,
      expected.license,
      "Inherited model license requirement cannot be waived",
    );
  }
  assert.ok(
    Array.isArray(metadata.packages),
    "Missing actual Cargo metadata packages",
  );
  for (const expected of reviewed.values()) {
    const matches = metadata.packages.filter(
      (value) => key(value) === key(expected),
    );
    assert.equal(
      matches.length,
      1,
      "Expected exactly one actual package: " + key(expected),
    );
    assert.equal(
      matches[0].license,
      expected.license,
      "License changed: " + key(expected),
    );
  }
  const locked = lockIdentities(cargoLock);
  for (const resolution of policy.modelIdentityResolutions) {
    const historical = inherited.filter(
      (value) =>
        value.name === resolution.name &&
        value.version === resolution.historicalVersion,
    );
    assert.equal(historical.length, 1, "Missing historical model obligation");
    assert.equal(
      locked.get(key(resolution))?.checksum,
      resolution.checksum,
      "Current model resolution must match the exact locked archive",
    );
    assert.ok(
      config.seeds.some(
        (seed) => key(seed.expected) === key(resolution.parent),
      ),
      "Current model resolution parent must remain a reviewed owner root",
    );
    const parent = metadata.packages.find(
      (value) => key(value) === key(resolution.parent),
    );
    const child = metadata.packages.find(
      (value) => key(value) === key(resolution),
    );
    assert.equal(typeof parent?.id, "string", "Missing actual parent identity");
    assert.equal(typeof child?.id, "string", "Missing actual child identity");
    assert.ok(
      Array.isArray(metadata.resolve?.nodes),
      "Missing actual Cargo graph",
    );
    const nodes = metadata.resolve.nodes.filter(
      (value) => value.id === parent.id,
    );
    assert.equal(nodes.length, 1, "Missing or ambiguous model parent node");
    const childNodes = metadata.resolve.nodes.filter(
      (value) => value.id === child.id,
    );
    assert.equal(childNodes.length, 1, "Missing or ambiguous model child node");
    assert.ok(Array.isArray(nodes[0].deps), "Missing model dependency edges");
    const edges = nodes[0].deps.filter(
      (value) => value.name === resolution.dependencyName,
    );
    assert.equal(edges.length, 1, "Missing or ambiguous reviewed model edge");
    assert.equal(
      edges[0].pkg,
      child.id,
      "Model edge resolves to another identity",
    );
    assert.ok(Array.isArray(edges[0].dep_kinds), "Missing model edge kinds");
    assert.equal(
      edges[0].dep_kinds.filter(
        (value) =>
          value.kind === resolution.dependencyKind &&
          value.target === resolution.dependencyTarget,
      ).length,
      1,
      "Missing or ambiguous reviewed model edge kind/target",
    );
  }
  assert.ok(
    localTestConfig &&
      typeof localTestConfig === "object" &&
      !Array.isArray(localTestConfig),
    "Missing actual local-test configuration",
  );
  const overlayBundle = localTestConfig.bundle;
  assert.ok(
    !Object.hasOwn(localTestConfig, "bundle") ||
      (overlayBundle &&
        typeof overlayBundle === "object" &&
        !Array.isArray(overlayBundle)),
    "Local-test bundle cannot be removed",
  );
  const bundles = [
    tauriConfig.bundle,
    { ...tauriConfig.bundle, ...overlayBundle },
  ];
  for (const name of CURRENT_CLIENT_LICENSE_NOTICES) {
    for (const bundle of bundles) {
      assert.equal(bundle?.active, true, "Notice packaging must remain active");
      assert.ok(
        Array.isArray(bundle.resources) && bundle.resources.includes(name),
        "Missing bundled notice: " + name,
      );
    }
    assert.equal(noticeExists(name), true, "Missing notice file: " + name);
  }
  return {
    pass: true,
    scope: "current-client",
    reviewedPackageCount: reviewed.size,
    retainedModelLicenseRequirements: inherited.length,
    reviewedModelIdentityResolutions: policy.modelIdentityResolutions.length,
    wholeRepositoryCoverage: false,
    advisoryChecksPerformed: false,
    releaseAcceptance: false,
  };
}

export function parseCurrentClientLicenseArgs(argv) {
  assert.equal(
    argv.length,
    4,
    "Explicit scope and Cargo executable are required",
  );
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(
      ["--scope", "--cargo-executable"].includes(argv[index]) &&
        !values.has(argv[index]),
    );
    values.set(argv[index], argv[index + 1]);
  }
  assert.equal(values.get("--scope"), "current-client");
  assert.ok(
    isAbsolute(values.get("--cargo-executable") ?? ""),
    "Cargo executable must be absolute",
  );
  return {
    scope: "current-client",
    cargoExecutable: values.get("--cargo-executable"),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { cargoExecutable } = parseCurrentClientLicenseArgs(
    process.argv.slice(2),
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bound = new Map();
  const realRoot = realpathSync(root);
  const read = (name) => {
    const path = realpathSync(currentClientInputPath(root, name));
    const inside = relative(realRoot, path);
    assert.ok(
      inside && !isAbsolute(inside) && !inside.split(/[\\/]/u).includes(".."),
      "Review input resolves outside the repository",
    );
    const bytes = readFileSync(path);
    bound.set(name, bytes);
    return bytes;
  };
  const configBytes = read("scripts/rust_feature_scope.current-client.json");
  const config = JSON.parse(configBytes);
  const review = JSON.parse(
    read("scripts/rust_feature_review.current-client.json"),
  );
  const cargoLock = read("Cargo.lock");
  const policy = JSON.parse(
    read("scripts/rust_feature_licenses.current-client.json"),
  );
  const sourceBytes = Object.fromEntries(
    Object.keys(config.sourceFiles).map((name) => [name, read(name)]),
  );
  verifyRustFeatureScopeReview({
    config,
    configBytes,
    review,
    sourceBytes,
    cargoLock,
  });
  const tauriConfig = JSON.parse(read("frontend/src-tauri/tauri.conf.json"));
  const localTestConfig = JSON.parse(
    read("frontend/src-tauri/tauri.localtest.conf.json"),
  );
  const notices = new Set();
  for (const name of CURRENT_CLIENT_LICENSE_NOTICES) {
    assert.ok(
      read("frontend/src-tauri/" + name).length > 0,
      "Empty notice file",
    );
    notices.add(name);
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  const cargo = realpathSync(cargoExecutable);
  const rustc = realpathSync(
    resolve(dirname(cargoExecutable), "rustc" + suffix),
  );
  // Require actual installed binaries rather than the shared rustup proxy.
  assert.notEqual(
    createHash("sha256").update(readFileSync(cargo)).digest("hex"),
    createHash("sha256").update(readFileSync(rustc)).digest("hex"),
    "Use direct toolchain binaries",
  );
  const features = [
    ...new Set(config.profiles.flatMap((profile) => profile.features)),
  ].sort();
  const result = spawnSync(
    cargo,
    [
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      ...(features.length ? ["--features", features.join(",")] : []),
    ],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CARGO_NET_OFFLINE: "true",
        RUSTC: rustc,
        RUSTC_WRAPPER: "",
        RUSTC_WORKSPACE_WRAPPER: "",
      },
    },
  );
  assert.ok(
    !result.error && result.status === 0 && !result.signal,
    "Locked offline Cargo metadata failed; no fallback or download: " +
      (result.stderr ?? "").slice(0, 2000),
  );
  for (const [name, before] of bound)
    assert.deepEqual(
      readFileSync(resolve(root, name)),
      before,
      "Review input changed: " + name,
    );
  const report = validateCurrentClientLicenses({
    config,
    configBytes,
    cargoLock,
    policy,
    metadata: JSON.parse(result.stdout),
    tauriConfig,
    localTestConfig,
    noticeExists: (name) => notices.has(name),
  });
  console.log(JSON.stringify(report));
}
