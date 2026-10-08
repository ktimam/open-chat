import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import {
  assetLinks,
  ASSET_PATH,
  checkedCanisterId,
  createAssociationServer,
  fetchLoopback,
  localReplica,
  main,
  mainnetPlan,
  prepareProject,
  probeProject,
  projectFiles,
  readProject,
  serveProject,
} from "./association.mjs";

const fingerprint = "11".repeat(32);
const otherFingerprint = "aa".repeat(32);
const config = Object.freeze({
  replica: "http://127.0.0.1:8080",
  packageName: "dev.openchatfork.localtest",
  fingerprints: [fingerprint],
});
const expectedFiles = [
  "assets/.ic-assets.json5",
  "assets/.well-known/assetlinks.json",
  "dfx.json",
  "local-test-config.json",
];
const testParent = resolve(
  process.env.OPENCHAT_ASSOCIATION_TEST_TMPDIR ?? tmpdir(),
);
mkdirSync(testParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(testParent, "association-unit-"));
let fixtureIndex = 0;
after(() => {
  const withinParent = relative(testParent, fixtureRoot);
  assert(
    withinParent && !withinParent.startsWith("..") && !isAbsolute(withinParent),
  );
  assert(withinParent.startsWith("association-unit-"));
  rmSync(fixtureRoot, { recursive: true, force: true });
});
async function project() {
  const directory = join(fixtureRoot, `project-${++fixtureIndex}`);
  await prepareProject(directory, config);
  return directory;
}
const body = (directory) =>
  readFileSync(join(directory, "assets/.well-known/assetlinks.json"), "utf8");

test("localReplica accepts explicit-port HTTP loopback endpoints only", () => {
  for (const endpoint of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ])
    assert.doesNotThrow(() => localReplica(endpoint), endpoint);
});

for (const endpoint of [
  undefined,
  null,
  8080,
  "",
  "ic",
  "playground",
  "https://icp-api.io",
  "https://127.0.0.1:8080",
  "http://localhost",
  "http://127.0.0.1",
  "http://0.0.0.0:8080",
  "http://192.168.1.2:8080",
  "http://localhost.example:8080",
  "http://127.0.0.1.example:8080",
  "http://[::]:8080",
  "http://localhost:8080/assets",
  "http://localhost:8080/?network=ic",
  "http://localhost:8080/#ic",
  "http://user:password@localhost:8080",
  "file:///localhost:8080",
  "http://localhost:99999",
])
  test(`localReplica rejects unsafe endpoint ${String(endpoint)}`, () => {
    assert.throws(() => localReplica(endpoint));
  });

test("assetLinks validates, canonicalizes and deduplicates signing fingerprints", () => {
  const colonFingerprint = fingerprint.match(/../g).join(":");
  const result = assetLinks(config.packageName, [
    fingerprint,
    colonFingerprint,
    otherFingerprint,
  ]);
  const text = JSON.stringify(result);
  assert.match(text, /delegate_permission\/common\.get_login_creds/);
  assert.match(text, /dev\.openchatfork\.localtest/);
  assert.match(
    text,
    new RegExp(otherFingerprint.toUpperCase().match(/../g).join(":")),
  );
  assert.equal(text.split(colonFingerprint).length - 1, 1);
});

for (const packageName of [
  undefined,
  null,
  "",
  ".com.example",
  "com..example",
  "com.example.",
  "com/example",
  "com.example\nother",
]) {
  test(`assetLinks rejects invalid package ${String(packageName)}`, () => {
    assert.throws(() => assetLinks(packageName, [fingerprint]));
  });
}
for (const fingerprints of [
  undefined,
  null,
  [],
  [""],
  ["gg".repeat(32)],
  ["11".repeat(31)],
  ["11".repeat(33)],
  ["11:".repeat(32)],
  [fingerprint, "not-a-fingerprint"],
]) {
  test(`assetLinks rejects malformed fingerprint input ${JSON.stringify(fingerprints)}`, () => {
    assert.throws(() => assetLinks(config.packageName, fingerprints));
  });
}

test("projectFiles produces exactly four deterministic isolated project files", () => {
  const files = projectFiles(config);
  assert.deepEqual(Object.keys(files).sort(), expectedFiles);
  assert.deepEqual(projectFiles(config), files);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(typeof content, "string", path);
    assert.doesNotThrow(() => JSON.parse(content), path);
  }
  const dfx = JSON.parse(files["dfx.json"]);
  assert.deepEqual(Object.keys(dfx.canisters), ["android_passkey_association"]);
  assert.deepEqual(Object.keys(dfx.networks), ["association_local"]);
  const [canister] = Object.values(dfx.canisters);
  assert.equal(canister.type, "assets");
  assert.equal(canister.build, undefined);
  assert.equal(canister.dependencies, undefined);
  const providers = Object.values(dfx.networks).flatMap(
    (network) => network.providers ?? [],
  );
  assert.equal(providers.length, 1);
  assert.doesNotThrow(() => localReplica(providers[0]));
  assert.equal(new URL(providers[0]).origin, config.replica);
  assert.deepEqual(
    JSON.parse(files["assets/.well-known/assetlinks.json"]),
    assetLinks(config.packageName, config.fingerprints),
  );
  const assetConfig = JSON.parse(files["assets/.ic-assets.json5"]);
  assert.equal(
    assetConfig.find((entry) => entry.match === "**/*").enable_aliasing,
    false,
  );
  assert.equal(
    assetConfig.find((entry) => entry.match === "**/*").allow_raw_access,
    false,
  );
  assert.equal(
    assetConfig.find((entry) => entry.match === ".well-known").ignore,
    false,
  );
  const exactAsset = assetConfig.find(
    (entry) => entry.match === ".well-known/assetlinks.json",
  );
  assert.equal(exactAsset.ignore, false);
  assert.equal(exactAsset.headers["Content-Type"], "application/json");
  assert.equal(exactAsset.headers["X-Content-Type-Options"], "nosniff");
});

test("projectFiles cannot turn malformed or public-network configuration into output", () => {
  assert.throws(() =>
    projectFiles({ ...config, replica: "https://icp-api.io" }),
  );
  assert.throws(() =>
    projectFiles({ ...config, fingerprints: ["not-sha256"] }),
  );
  assert.throws(() => projectFiles({ ...config, packageName: "../canister" }));
});

test("prepareProject writes only generated files and refuses an existing directory", async () => {
  const directory = await project();
  for (const [path, content] of Object.entries(projectFiles(config))) {
    assert.equal(readFileSync(join(directory, path), "utf8"), content, path);
  }
  await assert.doesNotReject(async () => readProject(directory));
  const sentinel = join(directory, "preserve-existing.txt");
  writeFileSync(sentinel, "must remain unchanged");
  await assert.rejects(async () => prepareProject(directory, config));
  assert.equal(readFileSync(sentinel, "utf8"), "must remain unchanged");
});

test("prepareProject refuses relative output paths", async () => {
  await assert.rejects(async () =>
    prepareProject("relative-association-output", config),
  );
});

for (const path of expectedFiles)
  test(`readProject fails closed if generated ${path} changes`, async () => {
    const directory = await project();
    writeFileSync(
      join(directory, path),
      `${readFileSync(join(directory, path), "utf8")}\n`,
    );
    await assert.rejects(async () => readProject(directory));
  });

test("readProject fails closed if the association asset disappears", async () => {
  const directory = await project();
  rmSync(join(directory, "assets/.well-known/assetlinks.json"));
  await assert.rejects(async () => readProject(directory));
});

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
test("canister IDs require canonical base32, checksum and opaque principal class", () => {
  for (const id of [
    canisterId,
    "ryjl3-tyaaa-aaaaa-aaaba-cai",
    "em77e-bvlzu-aq",
  ])
    assert.equal(checkedCanisterId(id), id);
  for (const id of [
    "aaaaa-aa",
    "2vxsx-fae",
    "srkah-fqaaa-aaaaa-aaaaq-cai",
    "rrkah-fqaaa-aaaaa-aaaaq-caj",
    "rrkahfqaaa-aaaaa-aaaaq-cai",
    "RRKAH-FQAAA-AAAAA-AAA AQ-CAI",
    "00000-00000-cai",
  ])
    assert.throws(() => checkedCanisterId(id));
});
function fakeFetch(directory, mutate = (_path, response) => response) {
  const requests = [];
  return {
    requests,
    fetch: async (input, options) => {
      const url = new URL(String(input));
      requests.push({ url, options });
      const response =
        url.pathname === "/.well-known/assetlinks.json"
          ? new Response(body(directory), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "ic-certificate": "certificate=:AA==:, tree=:AA==:",
              },
            })
          : new Response("not found", { status: 404 });
      return mutate(url.pathname, response);
    },
  };
}

test("probeProject accepts only exact certified-header JSON and checks excluded paths", async () => {
  const directory = await project();
  const transport = fakeFetch(directory);
  const result = await probeProject(directory, canisterId, transport.fetch);
  assert.equal(result.localOnly, true);
  assert.equal(result.publicHttpsVerified, false);
  assert.equal(result.googlePasswordManagerVerified, false);
  assert.equal(result.exactPublicMetadata, true);
  assert.equal(result.certificationHeaderPresent, true);
  assert.equal(result.unrelatedPathsReturn404, true);
  assert.equal(result.assetBytes, Buffer.byteLength(body(directory)));
  assert.deepEqual(
    transport.requests.map(({ url }) => url.pathname).sort(),
    [
      "/",
      "/.well-known/assetlinks.json",
      "/.well-known/not-present.json",
      "/dfx.json",
      "/local-test-config.json",
    ].sort(),
  );
  for (const { url, options } of transport.requests) {
    assert.equal(url.protocol, "http:");
    assert.equal(url.port, "8080");
    assert(
      ["manual", "error"].includes(options?.redirect),
      "Probe must not follow redirects",
    );
  }
});

for (const [label, change] of [
  [
    "wrong status",
    () =>
      new Response("{}", {
        status: 201,
        headers: {
          "content-type": "application/json",
          "ic-certificate": "present",
        },
      }),
  ],
  [
    "redirect status",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid/assetlinks.json" },
      }),
  ],
  [
    "missing certificate header",
    (response) => {
      response.headers.delete("ic-certificate");
      return response;
    },
  ],
  [
    "wrong MIME",
    (response) => {
      response.headers.set("content-type", "text/html");
      return response;
    },
  ],
  [
    "missing MIME",
    (response) => {
      response.headers.delete("content-type");
      return response;
    },
  ],
  [
    "same JSON with different exact body",
    async (response) =>
      new Response(`${await response.text()} `, {
        status: 200,
        headers: response.headers,
      }),
  ],
  [
    "different association",
    (response) =>
      new Response("[]", { status: 200, headers: response.headers }),
  ],
  [
    "already followed redirect",
    (response) => {
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  ],
])
  test(`probeProject rejects association response with ${label}`, async () => {
    const directory = await project();
    const transport = fakeFetch(directory, (path, response) =>
      path === "/.well-known/assetlinks.json" ? change(response) : response,
    );
    await assert.rejects(() =>
      probeProject(directory, canisterId, transport.fetch),
    );
  });

for (const exposedPath of [
  "/",
  "/.well-known/not-present.json",
  "/local-test-config.json",
  "/dfx.json",
]) {
  test(`probeProject rejects unexpected successful response from ${exposedPath}`, async () => {
    const directory = await project();
    const transport = fakeFetch(directory, (path, response) =>
      path === exposedPath
        ? new Response("exposed", { status: 200 })
        : response,
    );
    await assert.rejects(() =>
      probeProject(directory, canisterId, transport.fetch),
    );
  });
}

test("probeProject rejects malformed canister IDs before invoking fetch", async () => {
  const directory = await project();
  for (const id of ["", "../../outside", "https://example.invalid", "a b"]) {
    let requests = 0;
    await assert.rejects(() =>
      probeProject(directory, id, async () => {
        requests++;
        throw new Error("unexpected request");
      }),
    );
    assert.equal(requests, 0);
  }
});

test("probeProject rejects tampered local-only project metadata before invoking fetch", async () => {
  const directory = await project();
  const metadataPath = join(directory, "local-test-config.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.localOnly = false;
  writeFileSync(metadataPath, JSON.stringify(metadata));
  let requests = 0;
  await assert.rejects(() =>
    probeProject(directory, canisterId, async () => {
      requests++;
      throw new Error("unexpected request");
    }),
  );
  assert.equal(requests, 0);
});

test("probeProject never falls back to another network after transport failure", async () => {
  const directory = await project();
  let requests = 0;
  await assert.rejects(() =>
    probeProject(directory, canisterId, async () => {
      requests++;
      throw new Error("synthetic connection failure");
    }),
  );
  assert.equal(requests, 1);
});

for (const url of [
  "https://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:8080/.well-known/assetlinks.json",
  "https://icp-api.io/.well-known/assetlinks.json",
  "http://example.invalid:8080/.well-known/assetlinks.json",
  "http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost.example:8080/.well-known/assetlinks.json",
  "http://127.0.0.1:8080/.well-known/assetlinks.json",
  "http://localhost:8080/.well-known/assetlinks.json",
  "file:///tmp/assetlinks.json",
]) {
  test(`fetchLoopback rejects non-canister-loopback URL before I/O: ${url}`, () => {
    // A synchronous assertion, rather than a rejected request Promise, proves
    // these invalid destinations never reach the asynchronous HTTP transport.
    assert.throws(() => fetchLoopback(url, {}), { code: "ERR_ASSERTION" });
  });
}

for (const address of [
  "example.invalid",
  "icp-api.io",
  "192.168.1.2",
  "0.0.0.0",
]) {
  test(`fetchLoopback rejects non-loopback connection address before I/O: ${address}`, () => {
    assert.throws(
      () =>
        fetchLoopback(
          `http://${canisterId}.localhost:8080/.well-known/assetlinks.json`,
          {},
          address,
        ),
      { code: "ERR_ASSERTION" },
    );
  });
}

for (const redirectedPath of [
  "/",
  "/.well-known/not-present.json",
  "/local-test-config.json",
  "/dfx.json",
]) {
  test(`probeProject rejects a redirect disguised as 404 from ${redirectedPath}`, async () => {
    const directory = await project();
    const transport = fakeFetch(directory, (path, response) => {
      if (path === redirectedPath)
        response.headers.set("location", "https://example.invalid/");
      return response;
    });
    await assert.rejects(() =>
      probeProject(directory, canisterId, transport.fetch),
    );
  });
}

const mainnetConfig = {
  mode: "mainnet-plan",
  packageName: "dev.example.client",
  fingerprints: [fingerprint, otherFingerprint],
};
async function mainnetProject() {
  const directory = join(fixtureRoot, `mainnet-plan-${++fixtureIndex}`);
  const result = await prepareProject(directory, mainnetConfig);
  assert.equal(result.deploymentPerformed, false);
  assert.equal(result.localOnly, false);
  assert.equal(result.googlePasswordManagerVerified, false);
  return directory;
}

test("explicit local mode retains existing schema-1 bytes and local project compatibility", async () => {
  assert.deepEqual(
    projectFiles({ ...config, mode: "local" }),
    projectFiles(config),
  );
  const restored = await readProject(await project());
  assert.equal(restored.schema, 1);
  assert.equal(restored.localOnly, true);
});

test("mainnet preparation contains only static assets, explicit public metadata and no deployment hook", async () => {
  const directory = await mainnetProject();
  const files = projectFiles(mainnetConfig);
  assert.deepEqual(Object.keys(files).sort(), [
    "assets/.ic-assets.json5",
    "assets/.well-known/assetlinks.json",
    "dfx.json",
    "mainnet-plan-config.json",
  ]);
  const dfx = JSON.parse(files["dfx.json"]);
  assert.deepEqual(dfx, {
    version: 1,
    canisters: {
      android_passkey_association: { type: "assets", source: ["assets"] },
    },
  });
  assert.deepEqual(
    files["assets/.ic-assets.json5"],
    projectFiles(config)["assets/.ic-assets.json5"],
  );
  assert.deepEqual(
    JSON.parse(files["assets/.well-known/assetlinks.json"]),
    assetLinks(mainnetConfig.packageName, mainnetConfig.fingerprints),
  );
  assert.equal((await readProject(directory)).preparationOnly, true);
  await assert.rejects(() => prepareProject(directory, mainnetConfig));
  let calls = 0;
  const noNetwork = () => {
    calls++;
    throw new Error("must not contact any network");
  };
  await assert.rejects(
    () => probeProject(directory, canisterId, noNetwork),
    /local-only/,
  );
  await assert.rejects(
    () => createAssociationServer(directory, canisterId, noNetwork),
    /local-only/,
  );
  assert.equal(calls, 0);
});

test("mainnet plan requires separate preparation, explicit certified gateway and stable RP review", async () => {
  const directory = await mainnetProject();
  for (const gateway of ["icp.net", "icp0.io"]) {
    const result = await mainnetPlan(directory, canisterId, gateway);
    assert.equal(result.rpId, `${canisterId}.${gateway}`);
    assert.equal(
      result.assetUrl,
      `https://${canisterId}.${gateway}${ASSET_PATH}`,
    );
    assert.equal(result.deploymentPerformed, false);
    assert.equal(result.networkVerified, false);
    assert.equal(result.googlePasswordManagerVerified, false);
    assert.match(result.warning, /re-linking/);
    assert.match(result.warning, /not migrated/);
  }
  const localDirectory = await project();
  await assert.rejects(() =>
    mainnetPlan(localDirectory, canisterId, "icp.net"),
  );
  for (const gateway of [
    undefined,
    "raw.icp.net",
    "raw.icp0.io",
    "icp.net.evil.invalid",
    "https://icp.net",
    "localhost",
    "example.invalid",
  ])
    await assert.rejects(() => mainnetPlan(directory, canisterId, gateway));
  for (const id of [
    undefined,
    "",
    "../escape",
    `${canisterId}.raw`,
    "x".repeat(64) + "-cai",
  ])
    await assert.rejects(() => mainnetPlan(directory, id, "icp.net"));
});

test("preparation rejects unknown modes, injected mainnet replicas and tampered plan files", async () => {
  for (const mode of ["ic", "mainnet", "playground", "", null])
    assert.throws(() => projectFiles({ ...config, mode }));
  assert.throws(() =>
    projectFiles({ ...mainnetConfig, replica: "https://icp-api.io" }),
  );
  for (const name of Object.keys(projectFiles(mainnetConfig))) {
    const directory = await mainnetProject();
    writeFileSync(
      join(directory, name),
      readFileSync(join(directory, name), "utf8") + "\n",
    );
    await assert.rejects(() => readProject(directory));
  }
  for (const args of [
    ["deploy"],
    ["prepare", "--mode", "ic"],
    ["prepare", "--mode", "mainnet"],
    ["mainnet-plan"],
  ])
    await assert.rejects(() => main(args));
});

for (const port of [
  undefined,
  "",
  "0",
  "65536",
  "-1",
  "8080.0",
  "8080/path",
  "0.0.0.0:8080",
  "1e3",
  8080,
])
  test(`serve rejects invalid explicit listening port ${String(port)} before reading project`, async () => {
    await assert.rejects(
      () => serveProject("missing-project", canisterId, port),
      /explicit local listening port/,
    );
  });

async function withProxy(directory, transport, operation) {
  const server = await createAssociationServer(
    directory,
    canisterId,
    transport.fetch,
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    assert.equal(server.address().address, "127.0.0.1");
    await operation(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function proxyRequest(port, pathname = ASSET_PATH, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          Host: "device.example.ts.net",
          Cookie: "not-forwarded=yes",
          Authorization: "not-forwarded",
          "Tailscale-User-Login": "not-forwarded",
        },
      },
      async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("DAL-only proxy returns exact GET/HEAD metadata and strips unrelated headers", async () => {
  const directory = await project();
  const transport = fakeFetch(directory, (_path, response) => {
    response.headers.set("set-cookie", "must-not-leak=yes");
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set("tailscale-user-login", "must-not-leak");
    response.headers.set("cache-control", "public, max-age=60");
    response.headers.set("ic-certificateexpression", "synthetic-expression");
    return response;
  });
  await withProxy(directory, transport, async (port) => {
    const get = await proxyRequest(port);
    const head = await proxyRequest(port, ASSET_PATH, "HEAD");
    for (const response of [get, head]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(
        response.headers["content-length"],
        String(Buffer.byteLength(body(directory))),
      );
      assert.equal(response.headers["cache-control"], "public, max-age=60");
      assert.ok(response.headers["ic-certificate"]);
      assert.equal(
        response.headers["ic-certificateexpression"],
        "synthetic-expression",
      );
      for (const header of [
        "set-cookie",
        "location",
        "access-control-allow-origin",
        "tailscale-user-login",
      ])
        assert.equal(response.headers[header], undefined);
    }
    assert.equal(get.body, body(directory));
    assert.equal(head.body, "");
  });
  assert.equal(transport.requests.length, 2);
  for (const { url, options } of transport.requests) {
    assert.equal(url.href, `http://${canisterId}.localhost:8080${ASSET_PATH}`);
    assert.equal(options.redirect, "manual");
    assert.deepEqual(Object.keys(options).sort(), ["redirect", "signal"]);
  }
});

test("DAL proxy never forwards nonexact paths, queries, request targets or methods", async () => {
  const directory = await project();
  const transport = fakeFetch(directory);
  await withProxy(directory, transport, async (port) => {
    for (const pathname of [
      "/",
      "/api/v2/status",
      "/dfx.json",
      "/local-test-config.json",
      "/mainnet-plan-config.json",
      `${ASSET_PATH}?x=1`,
      `${ASSET_PATH}/`,
      "/.well-known/%61ssetlinks.json",
      `http://example.invalid${ASSET_PATH}`,
    ]) {
      const result = await proxyRequest(port, pathname);
      assert.equal(result.status, 404, pathname);
      assert.equal(result.body, "");
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const result = await proxyRequest(port, ASSET_PATH, method);
      assert.equal(result.status, 405, method);
      assert.equal(result.headers.allow, "GET, HEAD");
      assert.equal(result.body, "");
    }
  });
  assert.equal(transport.requests.length, 0);
});

for (const failure of [
  "mismatch",
  "redirect",
  "missing-certificate",
  "wrong-mime",
  "oversized",
  "transport-error",
])
  test(`DAL proxy fails closed without response content or fallback: ${failure}`, async () => {
    const directory = await project();
    const transport = fakeFetch(directory, (_path, response) => {
      if (failure === "transport-error")
        throw new Error("upstream private diagnostic must not leak");
      if (failure === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/" },
        });
      if (failure === "missing-certificate")
        response.headers.delete("ic-certificate");
      if (failure === "wrong-mime")
        response.headers.set("content-type", "text/html");
      if (failure === "mismatch" || failure === "oversized")
        return new Response(failure === "mismatch" ? "[]" : "x".repeat(65537), {
          status: 200,
          headers: response.headers,
        });
      return response;
    });
    await withProxy(directory, transport, async (port) => {
      const result = await proxyRequest(port);
      assert.equal(result.status, 502);
      assert.equal(result.body, "");
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers["ic-certificate"], undefined);
      assert.equal(result.headers["cache-control"], "no-store");
    });
    assert.equal(transport.requests.length, 1);
  });

test("DAL proxy revalidates every response instead of caching a formerly valid statement", async () => {
  const directory = await project();
  let calls = 0;
  const transport = fakeFetch(directory, (_path, response) =>
    ++calls === 1
      ? response
      : new Response("[]", { headers: response.headers }),
  );
  await withProxy(directory, transport, async (port) => {
    assert.equal((await proxyRequest(port)).status, 200);
    assert.equal((await proxyRequest(port)).status, 502);
  });
});

test("real loopback transport sends the fixed canister Host and no caller identity", async () => {
  const observed = [];
  const upstream = createServer((req, res) => {
    observed.push({ method: req.method, path: req.url, headers: req.headers });
    res
      .writeHead(200, {
        "content-type": "application/json",
        "ic-certificate": "synthetic-certificate",
      })
      .end("[]");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = upstream.address().port;
    const response = await fetchLoopback(
      `http://${canisterId}.localhost:${port}${ASSET_PATH}`,
      { signal: AbortSignal.timeout(5000), redirect: "manual" },
    );
    assert.equal(await response.text(), "[]");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].method, "GET");
    assert.equal(observed[0].path, ASSET_PATH);
    assert.equal(observed[0].headers.host, `${canisterId}.localhost:${port}`);
    assert.equal(observed[0].headers.accept, "application/json");
    for (const header of ["authorization", "cookie", "tailscale-user-login"])
      assert.equal(observed[0].headers[header], undefined);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("CLI explicit modes prepare offline projects and print a non-deploying mainnet plan", async () => {
  const output = [];
  const previousLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  const localDirectory = join(fixtureRoot, `cli-local-${++fixtureIndex}`);
  const mainnetDirectory = join(fixtureRoot, `cli-mainnet-${++fixtureIndex}`);
  try {
    await main([
      "prepare",
      "--mode",
      "local",
      localDirectory,
      config.replica,
      config.packageName,
      fingerprint,
    ]);
    await main([
      "prepare",
      "--mode",
      "mainnet-plan",
      mainnetDirectory,
      mainnetConfig.packageName,
      fingerprint,
      otherFingerprint,
    ]);
    await main(["mainnet-plan", mainnetDirectory, canisterId, "icp.net"]);
  } finally {
    console.log = previousLog;
  }
  assert.equal(output.length, 3);
  assert.equal(output[0].localOnly, true);
  assert.equal(output[1].deploymentMode, "mainnet-plan");
  assert.equal(output[2].rpId, `${canisterId}.icp.net`);
  for (const result of output) {
    assert.equal(result.deploymentPerformed, false);
    assert.equal(result.googlePasswordManagerVerified, false);
  }
  assert.equal((await readProject(localDirectory)).localOnly, true);
  assert.equal((await readProject(mainnetDirectory)).preparationOnly, true);
});
