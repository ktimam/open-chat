#!/usr/bin/env node
// Local-only static DAL hosting proof. This does not perform a passkey ceremony.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANISTER = "android_passkey_association";
export const ASSET_PATH = "/.well-known/assetlinks.json";

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

export function projectFiles({ replica, packageName, fingerprints }) {
  const provider = localReplica(replica);
  const statement = assetLinks(packageName, fingerprints);
  const files = {
    "dfx.json": {
      version: 1,
      canisters: { [CANISTER]: { type: "assets", source: ["assets"] } },
      networks: {
        association_local: { providers: [provider], type: "persistent" },
      },
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
    "local-test-config.json": {
      schema: 1,
      localOnly: true,
      replica: provider,
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
    localOnly: true,
    googlePasswordManagerVerified: false,
  };
}

export async function readProject(project) {
  const config = JSON.parse(
    await readFile(path.join(project, "local-test-config.json"), "utf8"),
  );
  assert.equal(config.schema, 1);
  assert.equal(config.localOnly, true);
  for (const [name, expected] of Object.entries(projectFiles(config)))
    assert.equal(
      await readFile(path.join(project, name), "utf8"),
      expected,
      `Unexpected project configuration: ${name}`,
    );
  return config;
}

// Native Node DNS does not necessarily special-case *.localhost like browsers do.
// Connect only to the validated loopback gateway, preserving the real canister Host.
export function fetchLoopback(value, options, address = "127.0.0.1") {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.match(url.hostname, /^[a-z0-9-]+\.localhost$/);
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
            if (size > 65536)
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

export async function probeProject(project, canisterId, fetchImpl) {
  const config = await readProject(project);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-cai$/.test(canisterId))
    throw new Error("Invalid canister ID");
  const replica = new URL(config.replica);
  const read =
    fetchImpl ??
    ((url, options) => fetchLoopback(url, options, replica.hostname));
  const origin = `http://${canisterId}.localhost:${replica.port}`;
  const url = `${origin}${ASSET_PATH}`;
  const response = await read(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
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
  const body = await response.text();
  assert.equal(
    body,
    await readFile(path.join(project, "assets", ASSET_PATH.slice(1)), "utf8"),
    "Served asset differs from reviewed public metadata",
  );
  assert.deepEqual(
    JSON.parse(body),
    assetLinks(config.packageName, config.fingerprints),
  );
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

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "prepare" && rest.length >= 4) {
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
  } else {
    throw new Error(
      "Usage: association.mjs prepare <new-absolute-output> <http-loopback-replica> <package> <sha256>... | probe <project> <canister-id>",
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
