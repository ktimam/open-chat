import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  artifactUrl,
  manifestPath,
  resolveTools,
  validateManifest,
} from "./android_component_identity_tools.mjs";

const reviewed = JSON.parse(await readFile(manifestPath, "utf8"));
const payload = new TextEncoder().encode("synthetic jar fixture");
const fixtures = () => ({
  ...structuredClone(reviewed),
  artifacts: reviewed.artifacts.map((artifact) => ({
    ...artifact,
    bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
  })),
});
const directory = async () =>
  join(await mkdtemp(join(tmpdir(), "android-tools-offline-")), "fresh");
function response(url, options = {}) {
  return {
    status: 200,
    redirected: false,
    url,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    }),
    ...options,
  };
}

function downloadFailure(expected, deadlineExceeded = false) {
  return (error) => {
    assert.match(error.cause.message, expected);
    assert.equal(error.diagnostic.error, "pinned-tool-download-failed");
    assert.equal(
      error.diagnostic.artifact,
      "org.jetbrains.kotlin:kotlin-compiler-embeddable:2.2.0",
    );
    assert.equal(error.diagnostic.url, artifactUrl(reviewed.artifacts[0]));
    assert.ok(Number.isSafeInteger(error.diagnostic.elapsedMs));
    assert.ok(error.diagnostic.elapsedMs >= 0);
    assert.equal(error.diagnostic.deadlineExceeded, deadlineExceeded);
    return true;
  };
}

test("manifest preserves the locally compiled nine-artifact versions and exact classpaths", () => {
  validateManifest(reviewed);
  assert.deepEqual(
    reviewed.artifacts.map(
      ({ group, artifact, version }) => `${group}:${artifact}:${version}`,
    ),
    [
      "org.jetbrains.kotlin:kotlin-compiler-embeddable:2.2.0",
      "org.jetbrains.kotlin:kotlin-stdlib:2.2.0",
      "org.jetbrains.kotlin:kotlin-script-runtime:2.2.0",
      "org.jetbrains.kotlin:kotlin-daemon-embeddable:2.2.0",
      "org.jetbrains.kotlin:kotlin-reflect:1.6.10",
      "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.8.0",
      "org.jetbrains:annotations:13.0",
      "junit:junit:4.13.2",
      "org.hamcrest:hamcrest-core:1.3",
    ],
  );
  assert.deepEqual(
    reviewed.classpaths.compiler,
    reviewed.artifacts.slice(0, 7).map(({ artifact }) => artifact),
  );
  assert.deepEqual(reviewed.classpaths.runtime, [
    "kotlin-stdlib",
    "annotations",
  ]);
  assert.deepEqual(reviewed.classpaths.junit, ["junit", "hamcrest-core"]);
  assert.match(reviewed.verification, /official Maven Central .jar.sha1/u);
});

test("offline synthetic bodies produce only the pinned classpaths after all nine verified downloads", async () => {
  const output = await directory();
  const calls = [];
  const result = await resolveTools({
    directory: output,
    manifest: fixtures(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.deepEqual(Object.keys(options).sort(), [
        "credentials",
        "redirect",
        "signal",
      ]);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      return response(url);
    },
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    reviewed.artifacts.map(artifactUrl),
  );
  assert.ok(calls.every(({ options }) => options.signal.aborted));
  for (const [kind, names] of Object.entries(reviewed.classpaths)) {
    assert.deepEqual(
      result[`${kind}Classpath`].split(delimiter),
      names.map((name) => {
        const artifact = reviewed.artifacts.find(
          (entry) => entry.artifact === name,
        );
        return join(output, `${name}-${artifact.version}.jar`);
      }),
    );
  }
  assert.equal((await readdir(output)).length, 9);
  for (const path of result.junitClasspath.split(delimiter))
    assert.deepEqual(await readFile(path), Buffer.from(payload));
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: () => {
        throw new Error("must not fetch");
      },
    }),
    /EEXIST/u,
  );
});

for (const [label, field, value] of [
  ["path traversal", "group", "org../escape"],
  ["URL injection", "artifact", "https://other.invalid/jar"],
  ["query injection", "version", "2.2.0?token=x"],
  ["snapshot version", "version", "2.2.0-SNAPSHOT"],
  ["encoded path", "group", "org%2fescape"],
]) {
  test(`manifest rejects ${label} before writing or fetching`, async () => {
    const manifest = fixtures();
    manifest.artifacts[0][field] = value;
    const output = await directory();
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest,
        fetchImpl: () => {
          throw new Error("must not fetch");
        },
      }),
      { name: "AssertionError" },
    );
    await assert.rejects(readdir(output), /ENOENT/u);
  });
}

test("manifest rejects duplicate, missing, oversized and unpinned tools", () => {
  for (const mutate of [
    (manifest) => {
      manifest.artifacts.pop();
    },
    (manifest) => {
      manifest.artifacts[1] = manifest.artifacts[0];
    },
    (manifest) => {
      manifest.artifacts[0].bytes = 60_000_001;
    },
    (manifest) => {
      manifest.artifacts[0].sha256 = "unverified";
    },
    (manifest) => {
      manifest.classpaths.runtime.push("unlisted");
    },
  ]) {
    const manifest = fixtures();
    mutate(manifest);
    assert.throws(() => validateManifest(manifest));
  }
});

for (const [label, replacement, expected] of [
  ["redirect", { redirected: true }, /redirect/u],
  ["other origin", { url: "https://other.invalid/tool.jar" }, /origin\/path/u],
  [
    "different path",
    { url: `${artifactUrl(reviewed.artifacts[0])}?mirror=1` },
    /origin\/path/u,
  ],
  ["HTTP failure", { status: 404 }, /unexpected response/u],
  [
    "wrong declared size",
    { headers: new Headers({ "content-length": "99999" }) },
    /content length/u,
  ],
  ["bodyless response", { body: null }, /body missing/u],
]) {
  test(`download fails closed on ${label}, aborts and makes no next request`, async () => {
    let calls = 0;
    let signal;
    const output = await directory();
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url, options) => {
          calls += 1;
          signal = options.signal;
          return response(url, replacement);
        },
      }),
      downloadFailure(expected),
    );
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await readdir(output), []);
  });
}

const pinnedUrl = artifactUrl(reviewed.artifacts[0]);
for (const [label, location, classification] of [
  ["missing", undefined, "missing"],
  ["same URL", pinnedUrl, "same-url"],
  ["relative same URL", new URL(pinnedUrl).pathname, "same-url"],
  [
    "same origin",
    "https://repo.maven.apache.org/elsewhere",
    "same-origin-different-path",
  ],
  [
    "known alias",
    pinnedUrl.replace("repo.maven.apache.org", "repo1.maven.org"),
    "maven-central-alias-same-path",
  ],
  ["alias other path", "https://repo1.maven.org/secret", "unreviewed"],
  ["other host", "https://secret.invalid/private", "unreviewed"],
  [
    "credentials",
    pinnedUrl.replace("https://", "https://secret:secret@"),
    "unreviewed",
  ],
  ["query", `${pinnedUrl}?secret=value`, "unreviewed"],
  ["fragment", `${pinnedUrl}#secret`, "unreviewed"],
  ["HTTP", pinnedUrl.replace("https:", "http:"), "unreviewed"],
  ["nonstandard port", pinnedUrl.replace(".org/", ".org:8443/"), "unreviewed"],
  ["invalid URL", "https://[secret", "unreviewed"],
]) {
  test(`redirect diagnostics classify ${label} without following or logging the destination`, async () => {
    const output = await directory();
    let calls = 0;
    let cancelled = false;
    let signal;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url, options) => {
          calls++;
          signal = options.signal;
          assert.equal(options.redirect, "manual");
          return response(url, {
            status: 302,
            headers: new Headers(location === undefined ? {} : { location }),
            body: new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          });
        },
      }),
      (error) => {
        downloadFailure(/unexpected response/u)(error);
        assert.equal(error.diagnostic.httpStatus, 302);
        assert.equal(error.diagnostic.redirectTarget, classification);
        assert.doesNotMatch(
          JSON.stringify(error.diagnostic),
          /secret|elsewhere|8443/u,
        );
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(output), []);
  });
}

for (const status of [301, 303, 307, 308, 304, 401, 403, 429, 500]) {
  test(`HTTP ${status} is rejected without creating a file or making another request`, async () => {
    const output = await directory();
    let calls = 0;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url) => {
          calls++;
          return response(url, {
            status,
            headers: new Headers({ location: pinnedUrl }),
          });
        },
      }),
      (error) => {
        downloadFailure(/unexpected response/u)(error);
        assert.equal(error.diagnostic.httpStatus, status);
        assert.equal(
          error.diagnostic.redirectTarget,
          [301, 303, 307, 308].includes(status) ? "same-url" : undefined,
        );
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(output), []);
  });
}

for (const [label, body, expected] of [
  ["oversized", new Uint8Array(payload.length + 1), /exceeds pinned size/u],
  ["truncated", new Uint8Array(payload.length - 1), /truncated/u],
  ["corrupt", new Uint8Array(payload.length), /SHA-256 mismatch/u],
]) {
  test(`streamed ${label} body is never promoted to a JAR`, async () => {
    const output = await directory();
    let calls = 0;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url) => {
          calls += 1;
          return response(url, {
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(body);
                controller.close();
              },
            }),
          });
        },
      }),
      downloadFailure(expected),
    );
    assert.equal(calls, 1);
    assert.ok((await readdir(output)).every((name) => name.endsWith(".part")));
  });
}

for (const phase of ["headers", "body"]) {
  test(`deadline covers stalled ${phase}, including a fetch mock that ignores abort`, async () => {
    let signal;
    let cancelled = false;
    let calls = 0;
    const output = await directory();
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        timeoutMs: 20,
        fetchImpl: async (url, options) => {
          calls += 1;
          signal = options.signal;
          if (phase === "headers") return new Promise(() => {});
          return response(url, {
            body: new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          });
        },
      }),
      downloadFailure(/deadline/u, true),
    );
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.ok((await readdir(output)).every((name) => name.endsWith(".part")));
    if (phase === "body") assert.equal(cancelled, true);
  });
}

test("transport rejection reports bounded causes, aborts and never requests the next tool", async () => {
  const output = await directory();
  const transport = new TypeError("secret outer message");
  const details = Array.from({ length: 8 }, (_, index) =>
    Object.assign(new Error("secret cause message"), {
      code: index === 0 ? "ENOTFOUND" : "ECONNRESET",
      authorization: "secret header",
    }),
  );
  transport.cause = new AggregateError(details, "secret aggregate message");
  details[0].cause = transport; // Cycles cannot make diagnostics unbounded.
  let calls = 0;
  let signal;
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: async (_url, options) => {
        calls += 1;
        signal = options.signal;
        throw transport;
      },
    }),
    (error) => {
      downloadFailure(/secret outer message/u)(error);
      assert.equal(error.cause, transport);
      assert.deepEqual(error.diagnostic.causes, [
        { name: "TypeError" },
        { name: "AggregateError" },
        { name: "Error", code: "ENOTFOUND" },
        { name: "Error", code: "ECONNRESET" },
      ]);
      assert.doesNotMatch(
        JSON.stringify(error.diagnostic),
        /secret|authorization/u,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await readdir(output), []);
});

for (const [message, reason] of [
  ["secret proxy credentials", undefined],
  ["unexpected redirect", "redirect-rejected"],
  ["URL scheme must be a HTTP(S) scheme", "non-http-scheme"],
  ["unknown scheme", "unknown-scheme"],
  ["redirect count exceeded", "redirect-limit"],
  ["bad port", "blocked-port"],
  ["unexpected redirect secret proxy credentials", undefined],
  ["Unexpected redirect", undefined],
]) {
  test(`actual CLI keeps stdout empty and reports only exact safe reason: ${message}`, async () => {
    const output = await directory();
    const script = fileURLToPath(
      new URL("./android_component_identity_tools.mjs", import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `globalThis.fetch = async () => {
      const cause = Object.assign(new Error(${JSON.stringify(message)}), {
        code: ${reason === undefined ? '"ENOTFOUND"' : "undefined"}, name: "Error", headers: { authorization: "secret header" }
      });
      cause.cause = { name: "secret\\nname", code: "X".repeat(65), message: "secret nested message" };
      throw new TypeError("secret outer message", { cause });
    };
    process.argv = [process.execPath, ${JSON.stringify(script)}, "--output-directory", ${JSON.stringify(output)}];
    await import(${JSON.stringify(new URL("./android_component_identity_tools.mjs", import.meta.url).href)});`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    const diagnostic = JSON.parse(child.stderr);
    assert.equal(
      diagnostic.artifact,
      "org.jetbrains.kotlin:kotlin-compiler-embeddable:2.2.0",
    );
    assert.equal(diagnostic.url, artifactUrl(reviewed.artifacts[0]));
    assert.ok(
      Number.isSafeInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0,
    );
    assert.equal(diagnostic.deadlineExceeded, false);
    assert.deepEqual(diagnostic.causes, [
      { name: "TypeError" },
      reason === undefined
        ? { name: "Error", code: "ENOTFOUND" }
        : { name: "Error", reason },
      {},
    ]);
    assert.doesNotMatch(child.stderr, /secret|authorization|headers|X{65}/u);
    assert.equal(child.stderr.includes(message), false);
    assert.deepEqual(await readdir(output), []);
  });
}

test("redirected output ancestors and non-absolute outputs are rejected before fetch", async () => {
  const actual = await mkdtemp(join(tmpdir(), "android-tools-target-"));
  const parent = await mkdtemp(join(tmpdir(), "android-tools-link-"));
  const link = join(parent, "redirected");
  await symlink(
    actual,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const output of [join(link, "fresh"), "relative-output"]) {
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: () => {
          throw new Error("must not fetch");
        },
      }),
      /output/u,
    );
  }
});
