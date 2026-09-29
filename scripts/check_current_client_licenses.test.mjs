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
function fixture() {
  const cargoLock = Buffer.from("# synthetic license fixture\n");
  const app = { name: "synthetic-local-transport", version: "1.0.0", source };
  const config = {
    cargoLockSha256: hash(cargoLock),
    seeds: [{ expected: app }],
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  const packages = [
    ...ownedSecurityRules("pr1").introducedRustPackages.map((value) => ({
      ...value,
      source,
    })),
    { ...app, license: "MIT" },
  ];
  return {
    config,
    configBytes,
    cargoLock,
    policy: {
      schemaVersion: 1,
      scope: "current-client",
      cargoLockSha256: hash(cargoLock),
      sourceScopeSha256: hash(configBytes),
      packages,
    },
    metadata: { packages: structuredClone(packages) },
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
  assert.equal(result.wholeRepositoryCoverage, false);
  assert.equal(result.advisoryChecksPerformed, false);
  assert.equal(result.releaseAcceptance, false);
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
