import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundleArchiveCommand,
  createBundleArchive,
} from "../frontend/app/rollup-plugin-android-bundle.mjs";

test("archive commands keep paths as literal arguments on both platforms", () => {
  const source = path.resolve("checkout with spaces & symbols", "bundle");
  const target = path.resolve("checkout with spaces & symbols", "app.zip");
  const unix = bundleArchiveCommand(source, target, "linux");
  assert.deepEqual(unix, {
    command: "zip",
    args: ["-q", "-r", target, "."],
    cwd: source,
  });
  const windows = bundleArchiveCommand(source, target, "win32");
  assert.equal(path.basename(windows.command), "tar.exe");
  assert.deepEqual(windows.args, [
    "-a",
    "-c",
    "--options",
    "zip:hdrcharset=UTF-8",
    "-f",
    target,
    "-C",
    source,
    ".",
  ]);
  assert.equal(windows.cwd, source);
});

test("real OTA ZIP preserves nested assets, dotfiles and literal filenames", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "openchat-bundle-test-"));
  try {
    const source = path.join(fixture, "checkout with spaces & symbols");
    const output = path.join(fixture, "unpacked");
    const archive = path.join(fixture, "candidate.zip");
    mkdirSync(path.join(source, ".well-known"), { recursive: true });
    mkdirSync(path.join(source, "assets"));
    mkdirSync(output);
    const files = {
      "index.html":
        '<head><script>window.OC_CONFIG={OC_APP_STORE:"true"}</script></head>',
      ".ic-assets.json5": "[]",
      ".well-known/assetlinks.json": "[]",
      "assets/space & unicode-é-日本語-العربية.js":
        "export const literal = true;",
    };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(source, name), content);
    }
    await createBundleArchive(source, archive);
    const zipBytes = readFileSync(archive);
    assert.equal(zipBytes.readUInt32LE(0), 0x04034b50, "must be ZIP, not tar");
    if (process.platform === "win32") {
      // Same-tool extraction can hide a producer/consumer charset mismatch.
      // Android's zip 2.4.2 reader uses bit 11, not Info-ZIP Unicode extra fields.
      const end = zipBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert.notEqual(end, -1, "ZIP end-of-central-directory record");
      let offset = zipBytes.readUInt32LE(end + 16);
      const count = zipBytes.readUInt16LE(end + 10);
      const names = [];
      for (let entry = 0; entry < count; entry++) {
        assert.equal(zipBytes.readUInt32LE(offset), 0x02014b50);
        const flags = zipBytes.readUInt16LE(offset + 8);
        const nameLength = zipBytes.readUInt16LE(offset + 28);
        const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength);
        if ([...name].some((byte) => byte >= 0x80)) {
          assert.equal(
            flags & 0x800,
            0x800,
            "non-ASCII names must declare UTF-8",
          );
        }
        names.push(name.toString("utf8").replace(/^\.\//, ""));
        offset +=
          46 +
          nameLength +
          zipBytes.readUInt16LE(offset + 30) +
          zipBytes.readUInt16LE(offset + 32);
      }
      for (const name of Object.keys(files))
        assert.ok(names.includes(name), name);
      const { command } = bundleArchiveCommand(source, archive);
      execFileSync(command, ["-x", "-f", archive, "-C", output]);
    } else {
      execFileSync("unzip", ["-q", archive, "-d", output]);
    }
    for (const [name, content] of Object.entries(files)) {
      assert.equal(
        readFileSync(path.join(output, name), "utf8"),
        content,
        name,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("missing archive source rejects instead of reporting success", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "openchat-bundle-error-"));
  try {
    await assert.rejects(
      createBundleArchive(
        path.join(fixture, "missing"),
        path.join(fixture, "app.zip"),
      ),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
