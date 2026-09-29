import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ownedSecurityRules } from "./security_owned_rules.mjs";
import {
  CURRENT_CLIENT_LICENSE_NOTICES,
  currentClientInputPath,
  parseCurrentClientLicenseArgs,
  validateCurrentClientLicenses,
} from "./check_current_client_licenses.mjs";
import { resolve } from "node:path";

const source = "registry+https://github.com/rust-lang/crates.io-index";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (value) => `${value.source}#${value.name}@${value.version}`;
const modelResolution = () => ({
  name: "llama-cpp-sys-2",
  historicalVersion: "0.1.150",
  version: "0.1.154",
  source,
  checksum: "13a9ea2ce0cdc20bcb1870534022e340b391663f8fe09133951e2fe37fbc29cf",
  parent: { name: "llama-cpp-2", version: "0.1.150", source },
  dependencyName: "llama_cpp_sys_2",
  dependencyKind: null,
  dependencyTarget: null,
});
function fixture() {
  const resolution = modelResolution();
  const app = { name: "synthetic-local-transport", version: "1.0.0", source };
  const packages = [
    ...ownedSecurityRules("pr1").introducedRustPackages.map((value) => ({
      ...value,
      version:
        value.name === resolution.name ? resolution.version : value.version,
      source,
    })),
    { ...app, license: "MIT" },
  ];
  const cargoLock = Buffer.from(
    "# synthetic license fixture\nversion = 4\n\n" +
      packages
        .map((value) =>
          [
            "[[package]]",
            `name = "${value.name}"`,
            `version = "${value.version}"`,
            `source = "${value.source}"`,
            `checksum = "${value.name === resolution.name ? resolution.checksum : "a".repeat(64)}"`,
            "",
          ].join("\n"),
        )
        .join("\n"),
  );
  const config = {
    cargoLockSha256: hash(cargoLock),
    seeds: [{ expected: app }, { expected: resolution.parent }],
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  return {
    config,
    configBytes,
    cargoLock,
    policy: {
      schemaVersion: 1,
      scope: "current-client",
      cargoLockSha256: hash(cargoLock),
      sourceScopeSha256: hash(configBytes),
      modelIdentityResolutions: [resolution],
      packages,
    },
    metadata: {
      packages: packages.map((value) => ({ ...value, id: id(value) })),
      resolve: {
        nodes: [
          {
            id: id(resolution.parent),
            deps: [
              {
                name: resolution.dependencyName,
                pkg: id(resolution),
                dep_kinds: [{ kind: null, target: null }],
              },
            ],
          },
          { id: id(resolution), deps: [] },
        ],
      },
    },
    tauriConfig: {
      bundle: { active: true, resources: [...CURRENT_CLIENT_LICENSE_NOTICES] },
    },
    localTestConfig: {},
    noticeExists: () => true,
  };
}
test("current licenses cover exact app owner roots plus all retained model license requirements", () => {
  const result = validateCurrentClientLicenses(fixture());
  assert.equal(result.pass, true);
  assert.equal(result.reviewedPackageCount, 20);
  assert.equal(result.retainedModelLicenseRequirements, 19);
  assert.equal(result.reviewedModelIdentityResolutions, 1);
  assert.equal(result.wholeRepositoryCoverage, false);
  assert.equal(result.advisoryChecksPerformed, false);
  assert.equal(result.releaseAcceptance, false);
});
test("the current mapping preserves historical obligations rather than rewriting them", () => {
  const historical = ownedSecurityRules("pr1").introducedRustPackages;
  assert.equal(historical.length, 19);
  assert.deepEqual(
    historical.find((value) => value.name === "llama-cpp-sys-2"),
    {
      name: "llama-cpp-sys-2",
      version: "0.1.150",
      license: "MIT OR Apache-2.0",
    },
  );
  const value = fixture();
  for (const previous of historical) {
    const current = value.policy.packages.find(
      (entry) => entry.name === previous.name,
    );
    assert.equal(current.license, previous.license);
    assert.equal(current.source, source);
    assert.equal(
      current.version,
      previous.name === "llama-cpp-sys-2" ? "0.1.154" : previous.version,
    );
  }
  assert.equal(validateCurrentClientLicenses(value).pass, true);
});

test("missing, duplicate, stale and unreviewed identity mappings fail closed", () => {
  for (const mutate of [
    (value) => delete value.policy.modelIdentityResolutions,
    (value) => (value.policy.modelIdentityResolutions = []),
    (value) => value.policy.modelIdentityResolutions.push(modelResolution()),
    (value) => (value.policy.modelIdentityResolutions[0].name = "bindgen"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].historicalVersion = "0.1.149"),
    (value) => (value.policy.modelIdentityResolutions[0].version = "0.1.150"),
    (value) => (value.policy.modelIdentityResolutions[0].version = "0.1.155"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].source =
        "git+https://example.invalid/model"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].checksum = "b".repeat(64)),
    (value) =>
      (value.policy.modelIdentityResolutions[0].parent.version = "0.1.154"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].dependencyName =
        "unreviewed_alias"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].dependencyKind = "build"),
    (value) =>
      (value.policy.modelIdentityResolutions[0].dependencyTarget =
        "cfg(windows)"),
    (value) => (value.policy.modelIdentityResolutions[0].allowMissing = true),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateCurrentClientLicenses(value));
  }
});

test("resolved package version, source, license and locked archive remain exact", () => {
  for (const mutate of [
    (value) =>
      value.metadata.packages.splice(
        value.metadata.packages.findIndex(
          (item) => item.name === "llama-cpp-sys-2",
        ),
        1,
      ),
    (value) =>
      (value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).version = "0.1.150"),
    (value) =>
      (value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).version = "0.1.155"),
    (value) =>
      (value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).source = null),
    (value) =>
      (value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).source = "git+https://example.invalid/model"),
    (value) =>
      (value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).license = "MIT"),
    (value) => {
      value.policy.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).license = "MIT";
      value.metadata.packages.find(
        (item) => item.name === "llama-cpp-sys-2",
      ).license = "MIT";
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateCurrentClientLicenses(value));
  }
  const changed = fixture();
  changed.cargoLock = Buffer.from(
    changed.cargoLock
      .toString()
      .replace(modelResolution().checksum, "b".repeat(64)),
  );
  changed.config.cargoLockSha256 = hash(changed.cargoLock);
  changed.configBytes = Buffer.from(JSON.stringify(changed.config));
  changed.policy.cargoLockSha256 = hash(changed.cargoLock);
  changed.policy.sourceScopeSha256 = hash(changed.configBytes);
  assert.throws(
    () => validateCurrentClientLicenses(changed),
    /exact locked archive/,
  );
});

test("a metadata package list without the exact selected native dependency edge cannot pass", () => {
  for (const mutate of [
    (value) => delete value.metadata.resolve,
    (value) => value.metadata.resolve.nodes.shift(),
    (value) => value.metadata.resolve.nodes.pop(),
    (value) =>
      value.metadata.resolve.nodes.push(
        structuredClone(value.metadata.resolve.nodes[0]),
      ),
    (value) =>
      value.metadata.resolve.nodes.push(
        structuredClone(value.metadata.resolve.nodes[1]),
      ),
    (value) => (value.metadata.resolve.nodes[0].deps = []),
    (value) =>
      value.metadata.resolve.nodes[0].deps.push(
        structuredClone(value.metadata.resolve.nodes[0].deps[0]),
      ),
    (value) => (value.metadata.resolve.nodes[0].deps[0].name = "wrong_alias"),
    (value) =>
      (value.metadata.resolve.nodes[0].deps[0].pkg = "another-package-id"),
    (value) => (value.metadata.resolve.nodes[0].deps[0].dep_kinds = []),
    (value) =>
      (value.metadata.resolve.nodes[0].deps[0].dep_kinds[0].kind = "build"),
    (value) =>
      (value.metadata.resolve.nodes[0].deps[0].dep_kinds[0].target =
        "cfg(windows)"),
    (value) =>
      value.metadata.resolve.nodes[0].deps[0].dep_kinds.push({
        kind: null,
        target: null,
      }),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateCurrentClientLicenses(value));
  }
  const unowned = fixture();
  unowned.config.seeds.pop();
  unowned.configBytes = Buffer.from(JSON.stringify(unowned.config));
  unowned.policy.sourceScopeSha256 = hash(unowned.configBytes);
  assert.throws(
    () => validateCurrentClientLicenses(unowned),
    /reviewed owner root/,
  );

  // Cargo includes the same native dependency for an additional macOS target;
  // retaining it must not replace the required unconditional normal edge.
  const additionalTarget = fixture();
  additionalTarget.metadata.resolve.nodes[0].deps[0].dep_kinds.push({
    kind: null,
    target:
      'cfg(all(target_os = "macos", any(target_arch = "aarch64", target_arch = "arm64")))',
  });
  assert.equal(validateCurrentClientLicenses(additionalTarget).pass, true);
});
test("license checks reject missing, additional, duplicate, unknown, changed and wrong-source packages", () => {
  for (const mutate of [
    (value) => value.policy.packages.pop(),
    (value) =>
      value.policy.packages.push({
        name: "unrelated-core",
        version: "1",
        source,
        license: "MIT",
      }),
    (value) => value.policy.packages.push({ ...value.policy.packages[0] }),
    (value) => (value.policy.packages.at(-1).license = "NOASSERTION"),
    (value) => (value.policy.packages.at(-1).license = ""),
    (value) => (value.policy.packages[0].license = "MIT"),
    (value) => (value.policy.allowMissing = true),
    (value) => value.metadata.packages.pop(),
    (value) => value.metadata.packages.push({ ...value.metadata.packages[0] }),
    (value) => (value.metadata.packages.at(-1).license = "GPL-3.0"),
    (value) =>
      (value.metadata.packages.at(-1).source =
        "git+https://example.invalid/changed"),
    (value) =>
      value.config.seeds.push({
        expected: { name: "new-owner", version: "1", source },
      }),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateCurrentClientLicenses(value));
  }
});
test("reviewed source, lock, scope and notice drift fail closed", () => {
  for (const mutate of [
    (value) => (value.configBytes = Buffer.from("{}")),
    (value) => (value.policy.sourceScopeSha256 = "a".repeat(64)),
    (value) => (value.cargoLock = Buffer.from("changed")),
    (value) => (value.policy.cargoLockSha256 = "b".repeat(64)),
    (value) => (value.policy.scope = "pr2"),
    (value) => (value.policy.schemaVersion = 2),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateCurrentClientLicenses(value));
  }
  for (const name of CURRENT_CLIENT_LICENSE_NOTICES) {
    const missingFile = fixture();
    missingFile.noticeExists = (candidate) => candidate !== name;
    assert.throws(() => validateCurrentClientLicenses(missingFile));
    const omitted = fixture();
    omitted.tauriConfig.bundle.resources =
      omitted.tauriConfig.bundle.resources.filter((value) => value !== name);
    assert.throws(() => validateCurrentClientLicenses(omitted));
  }
});
test("an explicit current scope and absolute installed Cargo executable are required", () => {
  const cargo =
    process.platform === "win32"
      ? "C:/toolchain/bin/cargo.exe"
      : "/toolchain/bin/cargo";
  assert.deepEqual(
    parseCurrentClientLicenseArgs([
      "--scope",
      "current-client",
      "--cargo-executable",
      cargo,
    ]),
    { scope: "current-client", cargoExecutable: cargo },
  );
  for (const argv of [
    [],
    ["--scope", "current-client"],
    ["--scope", "pr2", "--cargo-executable", cargo],
    ["--scope", "current-client", "--cargo-executable", "cargo"],
    ["--scope", "current-client", "--scope", "current-client"],
    [
      "--scope",
      "current-client",
      "--cargo-executable",
      cargo,
      "--allow-missing",
      "true",
    ],
  ])
    assert.throws(() => parseCurrentClientLicenseArgs(argv));
});

test("the actual local-test overlay cannot drop notices or disable packaging", () => {
  for (const overlay of [
    undefined,
    null,
    [],
    { bundle: null },
    { bundle: [] },
    { bundle: { active: false } },
    { bundle: { resources: null } },
    { bundle: { resources: [] } },
    { bundle: { resources: CURRENT_CLIENT_LICENSE_NOTICES.slice(1) } },
  ]) {
    const value = fixture();
    value.localTestConfig = overlay;
    assert.throws(() => validateCurrentClientLicenses(value));
  }
  const value = fixture();
  value.localTestConfig = {
    bundle: { resources: [...CURRENT_CLIENT_LICENSE_NOTICES] },
  };
  assert.equal(validateCurrentClientLicenses(value).pass, true);
});

test("review input paths cannot escape the checkout or use noncanonical separators", () => {
  const root = resolve("synthetic-repository");
  assert.equal(
    currentClientInputPath(root, "scripts/scope.json"),
    resolve(root, "scripts/scope.json"),
  );
  for (const name of [
    "",
    "/outside",
    "../outside",
    "a/../outside",
    "./inside",
    "a//b",
    "a\\b",
    "C:/outside",
    "a\0b",
    null,
  ]) {
    assert.throws(() => currentClientInputPath(root, name));
  }
});
