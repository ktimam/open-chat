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

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
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
  for (const value of inherited)
    required.set(key({ ...value, source: REGISTRY }), {
      ...value,
      source: REGISTRY,
    });
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
  for (const expected of inherited) {
    assert.equal(
      reviewed.get(key({ ...expected, source: REGISTRY })).license,
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
