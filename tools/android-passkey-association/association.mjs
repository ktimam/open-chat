#!/usr/bin/env node
// Static DAL hosting only. Never deploys or performs a passkey ceremony.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANISTER = "android_passkey_association";
export const ASSET_PATH = "/.well-known/assetlinks.json";
const MAX_ASSET_BYTES = 65536;

function deploymentMode(value = "local") {
  assert.ok(
    ["local", "mainnet-plan"].includes(value),
    "Unknown deployment mode",
  );
  return value;
}

export function checkedCanisterId(value) {
  assert.equal(typeof value, "string", "Invalid canister ID");
  assert.ok(value.length <= 63, "Invalid canister ID");
  assert.match(
    value,
    /^(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}$/,
    "Invalid canister ID",
  );
  // IC textual principals are grouped base32(CRC32(payload) || payload).
  // Validate offline without importing the frontend or contacting a replica.
  const encoded = value.replaceAll("-", "");
  const bytes = [];
  let pending = 0;
  let bits = 0;
  for (const character of encoded) {
    pending =
      (pending << 5) | "abcdefghijklmnopqrstuvwxyz234567".indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((pending >>> bits) & 255);
      pending &= (1 << bits) - 1;
    }
  }
  assert.ok(
    bytes.length >= 5 && bytes.length <= 33 && pending === 0,
    "Invalid canister ID",
  );
  assert.equal(
    encoded.length,
    Math.ceil((bytes.length * 8) / 5),
    "Invalid canister ID",
  );
  assert.equal(bytes.at(-1), 1, "Expected an opaque canister principal");
  let checksum = 0xffffffff;
  for (const byte of bytes.slice(4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++)
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  assert.equal(
    Buffer.from(bytes).readUInt32BE(0),
    (checksum ^ 0xffffffff) >>> 0,
    "Invalid canister ID checksum",
  );
  return value;
}

export function localReplica(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an explicit loopback HTTP replica port; public networks are forbidden",
    );
  return url.origin;
}

export function assetLinks(packageName, fingerprints) {
  if (
    typeof packageName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
  )
    throw new Error("Invalid Android package name");
  if (!Array.isArray(fingerprints) || !fingerprints.length)
    throw new Error(
      "At least one public signing-certificate SHA-256 fingerprint is required",
    );
  const normalized = fingerprints.map((value) => {
    if (
      typeof value !== "string" ||
      !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(value)
    )
      throw new Error("Invalid SHA-256 certificate fingerprint");
    return value.replaceAll(":", "").toUpperCase().match(/../g).join(":");
  });
  return [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: [...new Set(normalized)],
      },
    },
  ];
}

export function projectFiles({
  mode = "local",
  replica,
  packageName,
  fingerprints,
}) {
  deploymentMode(mode);
  if (mode === "mainnet-plan")
    assert.equal(
      replica,
      undefined,
      "Mainnet preparation must not accept a replica",
    );
  const provider = mode === "local" ? localReplica(replica) : undefined;
  const statement = assetLinks(packageName, fingerprints);
  const files = {
    "dfx.json": {
      version: 1,
      canisters: { [CANISTER]: { type: "assets", source: ["assets"] } },
      ...(mode === "local"
        ? {
            networks: {
              association_local: { providers: [provider], type: "persistent" },
            },
          }
        : {}),
    },
    "assets/.ic-assets.json5": [
      {
        match: "**/*",
        security_policy: "standard",
        enable_aliasing: false,
        allow_raw_access: false,
      },
      { match: ".well-known", ignore: false },
      {
        match: ".well-known/assetlinks.json",
        ignore: false,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ],
    "assets/.well-known/assetlinks.json": statement,
    [mode === "local" ? "local-test-config.json" : "mainnet-plan-config.json"]:
      mode === "local"
        ? {
            schema: 1,
            localOnly: true,
            replica: provider,
            packageName,
            fingerprints: statement[0].target.sha256_cert_fingerprints,
          }
        : {
            schema: 2,
            mode: "mainnet-plan",
            preparationOnly: true,
            packageName,
            fingerprints: statement[0].target.sha256_cert_fingerprints,
          },
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, value]) => [
      name,
      `${JSON.stringify(value, null, 2)}\n`,
    ]),
  );
}

export async function prepareProject(output, config) {
  if (!path.isAbsolute(output))
    throw new Error("Output must be an absolute, new project directory");
  const files = projectFiles(config);
  // Never replace an existing checkout, deployment, or its canister-ID records.
  await mkdir(output);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
  }
  return {
    project: output,
    canister: CANISTER,
    localOnly: deploymentMode(config.mode) === "local",
    deploymentMode: deploymentMode(config.mode),
    deploymentPerformed: false,
    googlePasswordManagerVerified: false,
  };
}

export async function readProject(project) {
  let config;
  try {
    config = JSON.parse(
      await readFile(path.join(project, "local-test-config.json"), "utf8"),
    );
    assert.equal(config.schema, 1);
    assert.equal(config.localOnly, true);
    assert.equal(config.mode, undefined);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = JSON.parse(
      await readFile(path.join(project, "mainnet-plan-config.json"), "utf8"),
    );
    assert.equal(config.schema, 2);
    assert.equal(config.mode, "mainnet-plan");
    assert.equal(config.preparationOnly, true);
  }
  for (const [name, expected] of Object.entries(projectFiles(config)))
    assert.equal(
      await readFile(path.join(project, name), "utf8"),
      expected,
      `Unexpected project configuration: ${name}`,
    );
  return config;
}

export async function mainnetPlan(project, canisterId, gateway) {
  const config = await readProject(project);
  assert.equal(
    config.mode,
    "mainnet-plan",
    "Requires explicit mainnet-plan preparation",
  );
  checkedCanisterId(canisterId);
  assert.ok(
    ["icp.net", "icp0.io"].includes(gateway),
    "Use an explicit certified IC gateway, never raw",
  );
  const rpId = `${canisterId}.${gateway}`;
  return {
    mode: "mainnet-plan",
    deploymentPerformed: false,
    networkVerified: false,
    canisterId,
    rpId,
    assetUrl: `https://${rpId}${ASSET_PATH}`,
    googlePasswordManagerVerified: false,
    warning:
      "Keep the chosen certified hostname stable. Changing RP requires re-linking; existing passkeys are not migrated. A local canister ID does not reserve a mainnet ID.",
  };
}

// Native Node DNS does not necessarily special-case *.localhost like browsers do.
// Connect only to the validated loopback gateway, preserving the real canister Host.
export function fetchLoopback(value, options, address = "127.0.0.1") {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.match(url.hostname, /^[a-z0-9-]+\.localhost$/);
  assert.ok(
    url.port && !url.username && !url.password && !url.search && !url.hash,
  );
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(address));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address === "[::1]" ? "::1" : address,
        port: url.port,
        path: url.pathname + url.search,
        method: "GET",
        headers: { Host: url.host, Accept: "application/json" },
        signal: options.signal,
      },
      async (response) => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > MAX_ASSET_BYTES)
              throw new Error("Unexpectedly large association response");
            chunks.push(chunk);
          }
          const headers = Object.fromEntries(
            Object.entries(response.headers)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : value,
              ]),
          );
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers,
            }),
          );
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function localSource(config, canisterId, fetchImpl) {
  assert.equal(
    config.localOnly,
    true,
    "This operation is local-only; mainnet plans are never contacted",
  );
  checkedCanisterId(canisterId);
  const replica = new URL(config.replica);
  const read =
    fetchImpl ??
    ((url, options) => fetchLoopback(url, options, replica.hostname));
  const origin = `http://${canisterId}.localhost:${replica.port}`;
  return { origin, read };
}

async function validateAsset(response, expected, config) {
  assert.equal(
    response.status,
    200,
    "DAL must return HTTP 200 without redirects",
  );
  assert.equal(
    response.redirected,
    false,
    "DAL response must not have followed a redirect",
  );
  assert.equal(response.headers.get("location"), null, "DAL must not redirect");
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json(?:\s*;|$)/i,
  );
  assert.ok(
    response.headers.get("ic-certificate"),
    "Expected a certified asset-canister response",
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_ASSET_BYTES)
      throw new Error("Unexpectedly large association response");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  assert.equal(
    body,
    expected,
    "Served asset differs from reviewed public metadata",
  );
  assert.deepEqual(
    JSON.parse(body),
    assetLinks(config.packageName, config.fingerprints),
  );
  return body;
}

export async function probeProject(project, canisterId, fetchImpl) {
  const config = await readProject(project);
  const { origin, read } = localSource(config, canisterId, fetchImpl);
  const url = `${origin}${ASSET_PATH}`;
  const response = await read(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const expected = await readFile(
    path.join(project, "assets", ASSET_PATH.slice(1)),
    "utf8",
  );
  const body = await validateAsset(response, expected, config);
  for (const pathname of [
    "/",
    "/.well-known/not-present.json",
    "/local-test-config.json",
    "/dfx.json",
  ]) {
    const missing = await read(`${origin}${pathname}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    await missing.arrayBuffer();
    assert.equal(missing.redirected, false);
    assert.equal(missing.headers.get("location"), null);
    assert.equal(
      missing.status,
      404,
      `Unexpected content or SPA fallback at ${pathname}`,
    );
  }
  return {
    localOnly: true,
    canisterId,
    url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    assetBytes: Buffer.byteLength(body),
    exactPublicMetadata: true,
    unrelatedPathsReturn404: true,
    certificationHeaderPresent: true,
    publicHttpsVerified: false,
    googlePasswordManagerVerified: false,
  };
}

// Upstream stays the reviewed asset canister, not the caller's Host, path or headers.
// This is a public-metadata-only adapter for an independently configured TLS proxy.
export async function createAssociationServer(project, canisterId, fetchImpl) {
  const config = await readProject(project);
  const { origin, read } = localSource(config, canisterId, fetchImpl);
  const expected = await readFile(
    path.join(project, "assets", ASSET_PATH.slice(1)),
    "utf8",
  );
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.url !== ASSET_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.writeHead(405).end();
      return;
    }
    if (active >= 8) {
      res.writeHead(503).end();
      return;
    }
    active += 1;
    try {
      const response = await read(`${origin}${ASSET_PATH}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      const body = await validateAsset(response, expected, config);
      res.setHeader("Content-Type", response.headers.get("content-type"));
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.removeHeader("Cache-Control");
      // Forward certification metadata, not cookies, identity, CORS or arbitrary headers.
      for (const name of [
        "cache-control",
        "ic-certificate",
        "ic-certificateexpression",
      ])
        if (response.headers.has(name))
          res.setHeader(name, response.headers.get(name));
      res.writeHead(200).end(req.method === "HEAD" ? undefined : body);
    } catch {
      // Never forward an upstream error page, redirect or mismatching statement.
      res.writeHead(502).end();
    } finally {
      active -= 1;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 8;
  return server;
}

export async function serveProject(project, canisterId, port) {
  assert.ok(
    typeof port === "string" &&
      /^[1-9][0-9]{0,4}$/.test(port) &&
      Number(port) <= 65535,
    "Use an explicit local listening port from 1 to 65535",
  );
  const server = await createAssociationServer(project, canisterId);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "prepare" && rest[0] === "--mode") {
    const [, mode, output, ...values] = rest;
    deploymentMode(mode);
    const [replica, packageName, ...fingerprints] =
      mode === "local" ? values : [undefined, ...values];
    console.log(
      JSON.stringify(
        await prepareProject(output, {
          mode,
          replica,
          packageName,
          fingerprints,
        }),
        null,
        2,
      ),
    );
  } else if (command === "prepare" && rest.length >= 4) {
    // Existing local projects/scripts remain compatible. Never infer a public mode.
    const [output, replica, packageName, ...fingerprints] = rest;
    console.log(
      JSON.stringify(
        await prepareProject(output, { replica, packageName, fingerprints }),
        null,
        2,
      ),
    );
  } else if (command === "probe" && rest.length === 2) {
    console.log(JSON.stringify(await probeProject(...rest), null, 2));
  } else if (command === "mainnet-plan" && rest.length === 3) {
    console.log(JSON.stringify(await mainnetPlan(...rest), null, 2));
  } else if (command === "serve" && rest.length === 3) {
    const server = await serveProject(...rest);
    console.log(
      JSON.stringify(
        {
          localOnly: true,
          url: `http://127.0.0.1:${server.address().port}${ASSET_PATH}`,
          publicHttpsVerified: false,
          googlePasswordManagerVerified: false,
        },
        null,
        2,
      ),
    );
  } else {
    throw new Error(
      "Usage: association.mjs prepare --mode local <new-absolute-output> <http-loopback-replica> <package> <sha256>... | prepare --mode mainnet-plan <new-absolute-output> <package> <sha256>... | probe <local-project> <canister-id> | serve <local-project> <canister-id> <loopback-port> | mainnet-plan <prepared-mainnet-project> <mainnet-canister-id> <icp.net|icp0.io>. This tool never deploys.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
