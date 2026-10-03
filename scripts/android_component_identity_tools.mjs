import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const manifestPath = fileURLToPath(
  new URL("./android_component_identity_tools.json", import.meta.url),
);
const central = "https://repo.maven.apache.org/maven2/";
const maxArtifactBytes = 60_000_000;
// Exact publisher asset 598661100: its 56,255,947 bytes and SHA-256 match the
// manifest. The CDN object was observed via a manual, header-only request to
// this exact JetBrains release on 2026-10-03. No repository-wide wildcard.
const compilerMavenUrl = `${central}org/jetbrains/kotlin/kotlin-compiler-embeddable/2.2.0/kotlin-compiler-embeddable-2.2.0.jar`;
const compilerReleaseUrl =
  "https://github.com/JetBrains/kotlin/releases/download/v2.2.0/kotlin-compiler-embeddable-2.2.0.jar";
const compilerCdnUrl =
  "https://release-assets.githubusercontent.com/github-production-release-asset/3432266/e2a79dcf-39b6-4c79-b41f-130a3894fc1a";
const compilerCdnQueryKeys = new Set([
  "sp",
  "sv",
  "sr",
  "spr",
  "se",
  "rscd",
  "rsct",
  "skoid",
  "sktid",
  "skt",
  "ske",
  "sks",
  "skv",
  "sig",
  "jwt",
  "response-content-disposition",
  "response-content-type",
]);

function compilerRedirect(initialUrl, currentUrl, response, hop) {
  if (initialUrl !== compilerMavenUrl) return undefined;
  const location = response.headers.get("location");
  if (hop === 0 && currentUrl === compilerMavenUrl && response.status === 301)
    return location === compilerReleaseUrl ? compilerReleaseUrl : undefined;
  if (
    hop !== 1 ||
    currentUrl !== compilerReleaseUrl ||
    response.status !== 302 ||
    typeof location !== "string" ||
    location.length > 8192 ||
    !location.startsWith(`${compilerCdnUrl}?`) ||
    location.includes("#")
  )
    return undefined;
  try {
    const target = new URL(location);
    if (
      target.href !== location ||
      target.username ||
      target.password ||
      target.port ||
      target.hash ||
      `${target.origin}${target.pathname}` !== compilerCdnUrl
    )
      return undefined;
    const keys = [...target.searchParams.keys()];
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !compilerCdnQueryKeys.has(key)) ||
      !target.searchParams.get("sig") ||
      !target.searchParams.get("jwt")
    )
      return undefined;
    return location; // Signed query stays in memory for this one request only.
  } catch {
    return undefined; // Never attach URL parser errors containing the query.
  }
}
// Exact static literals reviewed in Node 24.18.1's bundled Undici 7.29.0.
// No substring matching or raw message logging; unknown messages stay omitted.
const fetchReasons = new Map([
  ["unexpected redirect", "redirect-rejected"],
  ["URL scheme must be a HTTP(S) scheme", "non-http-scheme"],
  ["unknown scheme", "unknown-scheme"],
  ["redirect count exceeded", "redirect-limit"],
  ["bad port", "blocked-port"],
]);

function responseDiagnostic(response, requestedUrl) {
  if (!response || !Number.isInteger(response.status)) return undefined;
  const httpStatus = response.status;
  if (httpStatus < 100 || httpStatus > 599) return undefined;
  const result = { httpStatus };
  if (![301, 302, 303, 307, 308].includes(httpStatus)) return result;
  // The source request is a fixed public Maven URL with credentials omitted.
  // Report only a bounded HTTPS origin and fixed classifications, never a
  // Location value, path, query, credentials, body, or other response headers.
  // Observing the destination does not authorize requesting it.
  const location = response.headers.get("location");
  result.redirectTarget = "missing";
  if (location === null) return result;
  result.redirectTarget = "unreviewed";
  try {
    const target = new URL(location, requestedUrl);
    const requested = new URL(requestedUrl);
    if (
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      /^[a-z0-9.-]+$/u.test(target.hostname) &&
      target.hostname.length <= 253 &&
      target.origin.length <= 300
    )
      result.redirectOrigin = target.origin;
    result.redirectSameArtifactPath = target.pathname === requested.pathname;
    result.redirectHasQuery = Boolean(target.search);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      return result;
    if (target.href === requested.href) result.redirectTarget = "same-url";
    else if (target.origin === requested.origin)
      result.redirectTarget = "same-origin-different-path";
    else if (
      target.origin === "https://repo1.maven.org" &&
      target.pathname === requested.pathname
    )
      result.redirectTarget = "maven-central-alias-same-path";
  } catch {
    // Malformed locations remain unreviewed; URL parser messages are private.
  }
  return result;
}

class ToolDownloadError extends Error {
  constructor(
    artifact,
    url,
    startedAt,
    error,
    deadlineExceeded,
    response,
    hop,
  ) {
    // A downstream fetch error can itself contain the signed request URL.
    // Preserve only our fixed validation messages, not the raw error object.
    const fileName = `${artifact.artifact}-${artifact.version}.jar`;
    const safeMessages = new Set([
      "automatic tool redirect is forbidden",
      "tool response origin/path changed",
      `unexpected response for ${fileName}`,
      "unexpected content length",
      "tool response body missing",
      "tool body exceeds pinned size",
      "tool body truncated",
      "tool SHA-256 mismatch",
      `tool download deadline exceeded: ${fileName}`,
    ]);
    // Node assertions may append an actual/expected diff. Never copy that
    // server-derived suffix; retain only an exact allowlisted first line.
    const firstLine =
      typeof error?.message === "string"
        ? error.message.split("\n", 1)[0]
        : undefined;
    super("Pinned tool download failed", {
      cause:
        hop === 0
          ? error
          : new Error(
              safeMessages.has(firstLine)
                ? firstLine
                : "Pinned publisher request failed",
            ),
    });
    const causes = [];
    const pending = [error];
    const seen = new Set();
    while (pending.length && causes.length < 4) {
      const current = pending.shift();
      if (!current || typeof current !== "object" || seen.has(current))
        continue;
      seen.add(current);
      const entry = {};
      // Never include messages, stacks, headers, environment, or arbitrary values.
      for (const field of ["name", "code"]) {
        const value = current[field];
        if (
          typeof value === "string" &&
          /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
        )
          entry[field] = value;
      }
      const reason = fetchReasons.get(current.message);
      if (reason !== undefined) entry.reason = reason;
      causes.push(entry);
      if (current.cause) pending.push(current.cause);
      if (current instanceof AggregateError)
        pending.push(...current.errors.slice(0, 4));
    }
    this.diagnostic = {
      error: "pinned-tool-download-failed",
      artifact: `${artifact.group}:${artifact.artifact}:${artifact.version}`,
      url,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      deadlineExceeded,
      causes,
      redirectHops: hop,
      // After leaving Maven, report only the status, never fields parsed from
      // a signed CDN URL or downstream Location/error value.
      ...(hop === 0
        ? responseDiagnostic(response, url)
        : Number.isInteger(response?.status) &&
            response.status >= 100 &&
            response.status <= 599
          ? { httpStatus: response.status }
          : {}),
    };
  }
}

export function artifactUrl(artifact) {
  assert.match(artifact.group, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u);
  assert.match(artifact.artifact, /^[a-z][a-z0-9-]*$/u);
  assert.match(artifact.version, /^\d+(?:\.\d+)+$/u);
  return `${central}${artifact.group.replaceAll(".", "/")}/${artifact.artifact}/${artifact.version}/${artifact.artifact}-${artifact.version}.jar`;
}

export function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    manifest.artifacts.length,
    9,
    "expected the reviewed nine-artifact closure",
  );
  const ids = new Set();
  for (const artifact of manifest.artifacts) {
    artifactUrl(artifact);
    assert.ok(!ids.has(artifact.artifact), "duplicate artifact");
    ids.add(artifact.artifact);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(artifact.verifiedSha1, /^[a-f0-9]{40}$/u);
    assert.ok(
      Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0 &&
        artifact.bytes <= maxArtifactBytes,
      "invalid artifact size",
    );
  }
  assert.ok(
    manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) <=
      65_000_000,
    "oversized tool closure",
  );
  assert.deepEqual(Object.keys(manifest.classpaths).sort(), [
    "compiler",
    "junit",
    "runtime",
  ]);
  const used = new Set();
  for (const names of Object.values(manifest.classpaths)) {
    assert.ok(
      Array.isArray(names) &&
        names.length > 0 &&
        new Set(names).size === names.length,
      "invalid classpath",
    );
    for (const name of names) {
      assert.ok(ids.has(name), "unknown classpath artifact");
      used.add(name);
    }
  }
  assert.deepEqual(used, ids, "unused tool artifact");
  return manifest;
}

async function freshDirectory(directory) {
  assert.ok(isAbsolute(directory), "output directory must be absolute");
  const target = resolve(directory);
  assert.ok(
    !target.includes(delimiter),
    "output directory contains classpath separator",
  );
  // No cache searching or redirected writes through existing symlink/junction ancestors.
  for (let ancestor = dirname(target); ; ancestor = dirname(ancestor)) {
    const stat = await lstat(ancestor);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "output ancestry must be real directories",
    );
    assert.equal(
      await realpath(ancestor),
      ancestor,
      "output ancestry is redirected",
    );
    if (dirname(ancestor) === ancestor) break;
  }
  await mkdir(target); // Existing output is an error, including a dangling symlink.
  return target;
}

async function downloadArtifact(artifact, output, fetchImpl, timeoutMs) {
  const url = artifactUrl(artifact);
  const startedAt = performance.now();
  const fileName = `${artifact.artifact}-${artifact.version}.jar`;
  const part = join(output, `${fileName}.part`);
  const controller = new AbortController();
  let reader;
  let file;
  let timer;
  let deadlineExceeded = false;
  let response;
  let currentUrl = url;
  let hop = 0;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
      reject(new Error(`tool download deadline exceeded: ${fileName}`));
    }, timeoutMs);
  });
  const bounded = (operation) => Promise.race([operation, deadline]);
  try {
    while (true) {
      response = undefined;
      response = await bounded(
        fetchImpl(currentUrl, {
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        }),
      );
      assert.equal(
        response.redirected,
        false,
        "automatic tool redirect is forbidden",
      );
      // Boolean assertion avoids retaining a signed URL in AssertionError.
      assert.ok(
        response.url === currentUrl,
        "tool response origin/path changed",
      );
      const next = compilerRedirect(url, currentUrl, response, hop);
      if (next === undefined) break;
      // Cancel redirect bodies without reading them; a stalled cancellation
      // cannot outlive the same total download deadline or start the next hop.
      if (response.body) await bounded(response.body.cancel());
      currentUrl = next;
      hop++;
    }
    assert.equal(response.status, 200, `unexpected response for ${fileName}`);
    const length = response.headers.get("content-length");
    if (length !== null)
      assert.equal(length, String(artifact.bytes), "unexpected content length");
    assert.ok(response.body, "tool response body missing");
    reader = response.body.getReader();
    file = await open(part, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= artifact.bytes, "tool body exceeds pinned size");
      hash.update(value);
      await file.writeFile(value);
    }
    assert.equal(bytes, artifact.bytes, "tool body truncated");
    assert.equal(hash.digest("hex"), artifact.sha256, "tool SHA-256 mismatch");
    await file.close();
    file = undefined;
    await rename(part, join(output, fileName));
    return join(output, fileName);
  } catch (error) {
    throw new ToolDownloadError(
      artifact,
      url,
      startedAt,
      error,
      deadlineExceeded,
      response,
      hop,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not itself hang after a server/body deadline.
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
    if (file) await file.close();
  }
}

// Fetch injection is for offline fixture tests only; the CLI has no endpoint,
// mirror, credential, manifest or timeout override. Failed output is never reused.
export async function resolveTools({
  directory,
  manifest,
  fetchImpl = fetch,
  timeoutMs = 60_000,
}) {
  validateManifest(manifest);
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
  );
  const output = await freshDirectory(directory);
  const paths = new Map();
  for (const artifact of manifest.artifacts) {
    paths.set(
      artifact.artifact,
      await downloadArtifact(artifact, output, fetchImpl, timeoutMs),
    );
  }
  return Object.fromEntries(
    Object.entries(manifest.classpaths).map(([name, artifacts]) => [
      `${name}Classpath`,
      artifacts.map((id) => paths.get(id)).join(delimiter),
    ]),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(
      process.argv.length,
      4,
      "usage: node android_component_identity_tools.mjs --output-directory ABSOLUTE_FRESH_DIRECTORY",
    );
    assert.equal(process.argv[2], "--output-directory");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = await resolveTools({ directory: process.argv[3], manifest });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(
      error instanceof ToolDownloadError
        ? JSON.stringify(error.diagnostic)
        : error.message,
    );
    process.exitCode = 1;
  }
}
