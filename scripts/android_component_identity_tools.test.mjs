import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
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
const compilerReleaseUrl =
  "https://github.com/JetBrains/kotlin/releases/download/v2.2.0/kotlin-compiler-embeddable-2.2.0.jar";
const compilerCdnBase =
  "https://release-assets.githubusercontent.com/github-production-release-asset/3432266/e2a79dcf-39b6-4c79-b41f-130a3894fc1a";
const compilerCdnUrl = `${compilerCdnBase}?sig=SYNTHETIC_PRIVATE_SIGNATURE&jwt=SYNTHETIC_PRIVATE_JWT`;
function redirectResponse(url, location, status, onCancel = () => {}) {
  return response(url, {
    status,
    headers: new Headers({ location }),
    body: new ReadableStream({ cancel: onCancel }),
  });
}

for (const useCdn of [false, true]) {
  test(`only the pinned compiler follows the reviewed publisher chain (CDN: ${useCdn})`, async () => {
    const output = await directory();
    const calls = [];
    const cancelled = [];
    const signals = [];
    const result = await resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: async (url, options) => {
        calls.push(url);
        signals.push(options.signal);
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        assert.deepEqual(Object.keys(options).sort(), [
          "credentials",
          "redirect",
          "signal",
        ]);
        if (url === pinnedUrl)
          return redirectResponse(url, compilerReleaseUrl, 301, () =>
            cancelled.push("maven"),
          );
        if (url === compilerReleaseUrl && useCdn)
          return redirectResponse(url, compilerCdnUrl, 302, () =>
            cancelled.push("github"),
          );
        return response(url);
      },
    });
    assert.deepEqual(calls, [
      pinnedUrl,
      compilerReleaseUrl,
      ...(useCdn ? [compilerCdnUrl] : []),
      ...reviewed.artifacts.slice(1).map(artifactUrl),
    ]);
    assert.deepEqual(cancelled, useCdn ? ["maven", "github"] : ["maven"]);
    assert.equal(signals[0], signals[1]);
    if (useCdn) assert.equal(signals[1], signals[2]);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal((await readdir(output)).length, 9);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE|githubusercontent|sig=/u,
    );
  });
}

for (const [label, stage, location, status] of [
  [
    "wrong repository",
    0,
    compilerReleaseUrl.replace("JetBrains/kotlin", "other/kotlin"),
    301,
  ],
  ["wrong version", 0, compilerReleaseUrl.replaceAll("2.2.0", "2.2.1"), 301],
  ["wrong release path", 0, `${compilerReleaseUrl}/extra`, 301],
  [
    "release credentials",
    0,
    compilerReleaseUrl.replace("https://", "https://secret@"),
    301,
  ],
  [
    "release explicit port",
    0,
    compilerReleaseUrl.replace("github.com/", "github.com:443/"),
    301,
  ],
  ["release query", 0, `${compilerReleaseUrl}?secret=value`, 301],
  ["release fragment", 0, `${compilerReleaseUrl}#secret`, 301],
  ["wrong first status", 0, compilerReleaseUrl, 302],
  ["skipped publisher stage", 0, compilerCdnUrl, 301],
  ["Maven loop", 0, pinnedUrl, 301],
  [
    "wrong CDN host",
    1,
    compilerCdnUrl.replace(
      "release-assets.githubusercontent.com",
      "evil.invalid",
    ),
    302,
  ],
  [
    "wrong CDN repository",
    1,
    compilerCdnUrl.replace("3432266", "3432267"),
    302,
  ],
  ["wrong CDN object", 1, compilerCdnUrl.replace("e2a79dcf", "e2a79dce"), 302],
  ["CDN HTTP", 1, compilerCdnUrl.replace("https:", "http:"), 302],
  [
    "CDN credentials",
    1,
    compilerCdnUrl.replace("https://", "https://secret@"),
    302,
  ],
  ["CDN explicit port", 1, compilerCdnUrl.replace(".com/", ".com:443/"), 302],
  ["CDN fragment", 1, `${compilerCdnUrl}#secret`, 302],
  ["CDN empty fragment", 1, `${compilerCdnUrl}#`, 302],
  ["CDN missing signature", 1, `${compilerCdnBase}?jwt=secret`, 302],
  ["CDN duplicate query", 1, `${compilerCdnUrl}&sig=secret`, 302],
  ["CDN unknown query", 1, `${compilerCdnUrl}&redirect=secret`, 302],
  ["CDN oversized query", 1, `${compilerCdnUrl}&se=${"x".repeat(8192)}`, 302],
  ["wrong second status", 1, compilerCdnUrl, 301],
  ["publisher loop", 1, compilerReleaseUrl, 302],
  ["back to Maven", 1, pinnedUrl, 302],
  ["third redirect", 2, compilerCdnUrl, 302],
  ["CDN back to publisher", 2, compilerReleaseUrl, 301],
]) {
  test(`publisher chain rejects ${label} before an unapproved request`, async () => {
    const output = await directory();
    const calls = [];
    let cancellations = 0;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url) => {
          const at = calls.length;
          calls.push(url);
          if (at === stage)
            return redirectResponse(url, location, status, () => {
              cancellations++;
            });
          assert.ok(at < stage, "must not follow the rejected redirect");
          return redirectResponse(
            url,
            at === 0 ? compilerReleaseUrl : compilerCdnUrl,
            at === 0 ? 301 : 302,
            () => {
              cancellations++;
            },
          );
        },
      }),
      (error) => {
        downloadFailure(/unexpected response/u)(error);
        assert.equal(error.diagnostic.redirectHops, stage);
        assert.doesNotMatch(
          JSON.stringify(error.diagnostic),
          /PRIVATE|secret|sig=|jwt=|e2a79dcf/u,
        );
        return true;
      },
    );
    assert.equal(calls.length, stage + 1);
    assert.equal(cancellations, stage + 1);
    assert.deepEqual(await readdir(output), []);
  });
}

test("other artifacts cannot use the compiler's publisher exception", async () => {
  const output = await directory();
  const calls = [];
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? response(url)
          : redirectResponse(url, compilerReleaseUrl, 301);
      },
    }),
    (error) => {
      assert.match(error.cause.message, /unexpected response/u);
      assert.equal(error.diagnostic.redirectHops, 0);
      assert.equal(error.diagnostic.url, artifactUrl(reviewed.artifacts[1]));
      return true;
    },
  );
  assert.deepEqual(calls, reviewed.artifacts.slice(0, 2).map(artifactUrl));
  assert.deepEqual(await readdir(output), [
    "kotlin-compiler-embeddable-2.2.0.jar",
  ]);
});

for (const [label, change, expected] of [
  ["changed URL", { url: `${compilerCdnUrl}&se=secret` }, /origin\/path/u],
  ["auto-followed response", { redirected: true }, /redirect/u],
  ["non-200 response", { status: 403 }, /unexpected response/u],
  [
    "declared size",
    { headers: new Headers({ "content-length": "99999" }) },
    /content length/u,
  ],
  ["missing body", { body: null }, /body missing/u],
  ...[
    ["oversized", new Uint8Array(payload.length + 1), /exceeds pinned size/u],
    ["truncated", new Uint8Array(payload.length - 1), /truncated/u],
    ["hash mismatch", new Uint8Array(payload.length), /SHA-256 mismatch/u],
  ].map(([label, bytes, expected]) => [
    label,
    {
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    },
    expected,
  ]),
]) {
  test(`publisher CDN final response still rejects ${label}`, async () => {
    const output = await directory();
    let calls = 0;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        fetchImpl: async (url) => {
          calls++;
          if (calls === 1)
            return redirectResponse(url, compilerReleaseUrl, 301);
          if (calls === 2) return redirectResponse(url, compilerCdnUrl, 302);
          assert.equal(calls, 3);
          return response(url, change);
        },
      }),
      (error) => {
        downloadFailure(expected)(error);
        assert.equal(error.diagnostic.redirectHops, 2);
        assert.doesNotMatch(
          JSON.stringify(error.diagnostic),
          /PRIVATE|secret|sig=|jwt=|e2a79dcf/u,
        );
        if (label === "changed URL")
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE|secret/u);
        return true;
      },
    );
    assert.equal(calls, 3);
    assert.ok((await readdir(output)).every((name) => name.endsWith(".part")));
  });
}

test("publisher requests share one deadline, including stalled redirect cancellation", async () => {
  for (const stall of ["publisher", "cdn", "cancellation"]) {
    const output = await directory();
    let calls = 0;
    let signal;
    await assert.rejects(
      resolveTools({
        directory: output,
        manifest: fixtures(),
        timeoutMs: 30,
        fetchImpl: async (url, options) => {
          calls++;
          signal = options.signal;
          if (
            (stall === "publisher" && calls === 2) ||
            (stall === "cdn" && calls === 3)
          )
            return new Promise(() => {});
          return redirectResponse(
            url,
            calls === 1 ? compilerReleaseUrl : compilerCdnUrl,
            calls === 1 ? 301 : 302,
            stall === "cancellation" ? () => new Promise(() => {}) : () => {},
          );
        },
      }),
      downloadFailure(/deadline/u, true),
    );
    assert.equal(calls, stall === "publisher" ? 2 : stall === "cdn" ? 3 : 1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await readdir(output), []);
  }
});

test("elapsed time at the publisher hop cannot reset the original deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const output = await directory();
  let calls = 0;
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      timeoutMs: 30,
      fetchImpl: async (url, options) => {
        calls++;
        if (calls <= 2) t.mock.timers.tick(20);
        if (options.signal.aborted) return new Promise(() => {});
        return calls === 1
          ? redirectResponse(url, compilerReleaseUrl, 301)
          : response(url);
      },
    }),
    downloadFailure(/deadline/u, true),
  );
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(output), []);
});

test("downstream error objects do not retain signed fetch causes", async () => {
  const output = await directory();
  let calls = 0;
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: async (url) => {
        calls++;
        if (calls === 1) return redirectResponse(url, compilerReleaseUrl, 301);
        if (calls === 2) return redirectResponse(url, compilerCdnUrl, 302);
        throw new TypeError(`private fetch ${url}`, {
          cause: new Error(`private cause ${url}`),
        });
      },
    }),
    (error) => {
      assert.equal(error.cause.message, "Pinned publisher request failed");
      assert.doesNotMatch(
        inspect(error, { depth: 10 }),
        /PRIVATE|private|sig=|jwt=|e2a79dcf|githubusercontent/u,
      );
      return true;
    },
  );
  assert.equal(calls, 3);
});

for (const failure of ["transport", "URL mismatch", "third redirect"]) {
  test(`actual CLI never prints the signed CDN query on ${failure}`, async () => {
    const output = await directory();
    const script = fileURLToPath(
      new URL("./android_component_identity_tools.mjs", import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      let calls = 0;
      globalThis.fetch = async (url) => {
        calls++;
        const make = (status, location) => ({status, url, redirected:false, headers:new Headers(location ? {location} : {}), body:null});
        if (calls === 1) return make(301, ${JSON.stringify(compilerReleaseUrl)});
        if (calls === 2) return make(302, ${JSON.stringify(compilerCdnUrl)});
        if (${JSON.stringify(failure)} === "transport") throw new TypeError("private request " + url);
        if (${JSON.stringify(failure)} === "URL mismatch") return {...make(200), url:url + "&se=private-value"};
        return make(302, url + "&se=private-value");
      };
      process.argv = [process.execPath, ${JSON.stringify(script)}, "--output-directory", ${JSON.stringify(output)}];
      await import(${JSON.stringify(new URL("./android_component_identity_tools.mjs", import.meta.url).href)});
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    const diagnostic = JSON.parse(child.stderr);
    assert.equal(diagnostic.url, pinnedUrl);
    assert.equal(diagnostic.redirectHops, 2);
    assert.equal(diagnostic.redirectOrigin, undefined);
    assert.doesNotMatch(
      child.stderr,
      /PRIVATE|private|sig=|jwt=|e2a79dcf|githubusercontent/u,
    );
    assert.deepEqual(await readdir(output), []);
  });
}

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
  ["other host", "https://unreviewed.invalid/private-secret", "unreviewed"],
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
  test(`redirect diagnostics classify ${label} without following or logging private URL components`, async () => {
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
          /secret|elsewhere/u,
        );
        if (label === "other host")
          assert.equal(
            error.diagnostic.redirectOrigin,
            "https://unreviewed.invalid",
          );
        if (["credentials", "HTTP", "invalid URL", "missing"].includes(label))
          assert.equal(error.diagnostic.redirectOrigin, undefined);
        if (label === "query") {
          assert.equal(
            error.diagnostic.redirectOrigin,
            "https://repo.maven.apache.org",
          );
          assert.equal(error.diagnostic.redirectHasQuery, true);
          assert.equal(error.diagnostic.redirectSameArtifactPath, true);
        }
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(output), []);
  });
}

test("redirect origins are bounded and cannot echo an oversized hostname", async () => {
  const output = await directory();
  await assert.rejects(
    resolveTools({
      directory: output,
      manifest: fixtures(),
      fetchImpl: async (url) =>
        response(url, {
          status: 301,
          headers: new Headers({
            location: `https://${"a".repeat(254)}.invalid/private-secret?secret=value`,
          }),
        }),
    }),
    (error) => {
      downloadFailure(/unexpected response/u)(error);
      assert.equal(error.diagnostic.redirectOrigin, undefined);
      assert.equal(error.diagnostic.redirectTarget, "unreviewed");
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /secret|a{254}/u);
      return true;
    },
  );
  assert.deepEqual(await readdir(output), []);
});

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
