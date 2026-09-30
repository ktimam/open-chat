import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import {
  assetLinks,
  fetchLoopback,
  localReplica,
  prepareProject,
  probeProject,
  projectFiles,
  readProject,
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
