import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  candidText,
  DFX_VERSION,
  MAX_DESCRIPTOR_BYTES,
  localReplica,
  main,
  prepareLocal,
  prepareRegistration,
  publicUrl,
  registrationDescriptor,
} from "./registry.mjs";

const parent = path.resolve(
  process.env.OPENCHAT_REGISTRY_TEST_TMPDIR ??
    path.join(tmpdir(), "OpenChat-app-registry-tests"),
);
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "registry-unit-"));
after(async () => {
  const within = path.relative(parent, root);
  assert.ok(
    within.startsWith("registry-unit-") &&
      !within.startsWith("..") &&
      !path.isAbsolute(within),
  );
  await rm(root, { recursive: true });
});
let index = 0;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const encoded = (value) => Buffer.from(JSON.stringify(value));
const sourceUrl = "https://publisher.example/apps/apps-v1.json";
const processor = Buffer.from(
  'throw new Error("This public processor must never execute during preparation");',
);

async function fixture({
  catalogChange,
  descriptorChange,
  directoryChange,
} = {}) {
  const directory = path.join(root, `fixture-${++index}`);
  const packageDirectory = path.join(directory, "public");
  await mkdir(path.join(packageDirectory, "apps"), { recursive: true });
  const app = {
    id: "sample",
    revision: "public-v1",
    name: 'Public "sample" — العربية',
    description: "Synthetic public test app",
    destination: "https://publisher.example/import",
    processor: { sha256: hash(processor), byteLength: processor.length },
    actions: [
      {
        definition: {
          name: "add",
          description: "Add the reviewed value",
          promptTemplate:
            "Read the selected message.\nReturn only the declared fields.",
          responseSchema: {
            type: "object",
            "x-public-format": { fields: ["value"] },
          },
          card: {
            title: "Review",
            rows: [{ label: "Value", valueKey: "value" }],
            confirmLabel: "Send",
            cancelLabel: "Cancel",
          },
        },
        draftSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        handoff: { kind: "single" },
      },
    ],
  };
  const catalog = { version: 1, apps: [app] };
  catalogChange?.(catalog);
  const catalogBytes = encoded(catalog);
  const descriptor = {
    id: "sample",
    revision: "public-v1",
    name: 'Public "sample" — العربية',
    description: "Synthetic public test app",
    catalog: {
      url: "catalog.json",
      sha256: hash(catalogBytes),
      byteLength: catalogBytes.length,
    },
    processor: {
      url: "processor.js",
      sha256: hash(processor),
      byteLength: processor.length,
    },
    setupUrl: "connect",
  };
  descriptorChange?.(descriptor);
  const publicDirectory = { version: 1, apps: [descriptor] };
  directoryChange?.(publicDirectory);
  const directoryFile = path.join(directory, "apps-v1.json");
  const catalogFile = path.join(packageDirectory, "apps", "catalog.json");
  const processorFile = path.join(packageDirectory, "apps", "processor.js");
  await writeFile(directoryFile, encoded(publicDirectory));
  await writeFile(catalogFile, catalogBytes);
  await writeFile(processorFile, processor);
  return {
    directory,
    publicDirectory,
    catalog,
    descriptor,
    directoryFile,
    catalogFile,
    processorFile,
    options: {
      directoryFile,
      sourceUrl,
      packageDirectory,
      appId: "sample",
      outputDirectory: path.join(directory, "prepared"),
    },
  };
}

function decodeCandidArgument(source) {
  const match = /^\("((?:\\[0-9a-f]{2})*)"\)\n$/.exec(source);
  assert.ok(match, "Exactly one byte-escaped Candid text argument is required");
  const bytes = [...match[1].matchAll(/\\([0-9a-f]{2})/g)].map((entry) =>
    Number.parseInt(entry[1], 16),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(bytes),
  );
}

const inboxEndpoint = {
  version: 1,
  kind: "ic-canister",
  host: "https://gateway.example",
  canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
};
test("preparation accepts a public inbox endpoint without changing the registry descriptor", async () => {
  const sample = await fixture({
    catalogChange: (value) => {
      value.apps[0].deliveryInbox = inboxEndpoint;
    },
  });
  const result = await prepareRegistration(sample.options);
  const descriptor = JSON.parse(
    await readFile(
      path.join(sample.options.outputDirectory, "registration-descriptor.json"),
      "utf8",
    ),
  );
  assert.equal(Object.hasOwn(descriptor, "deliveryInbox"), false);
  assert.equal(result.processorExecuted, false);
  assert.equal(result.registered, false);
  assert.equal(result.published, false);
});
for (const [name, endpoint] of [
  ["version", { ...inboxEndpoint, version: 2 }],
  ["kind", { ...inboxEndpoint, kind: "http" }],
  ["trailing slash", { ...inboxEndpoint, host: "https://gateway.example/" }],
  ["path", { ...inboxEndpoint, host: "https://gateway.example/api" }],
  ["query", { ...inboxEndpoint, host: "https://gateway.example?x=1" }],
  ["fragment", { ...inboxEndpoint, host: "https://gateway.example#x" }],
  [
    "credentials",
    { ...inboxEndpoint, host: "https://user:secret@gateway.example" },
  ],
  ["insecure", { ...inboxEndpoint, host: "http://gateway.example" }],
  ["unapproved loopback", { ...inboxEndpoint, host: "http://localhost:8080" }],
  [
    "unapproved TLS loopback",
    { ...inboxEndpoint, host: "https://localhost:8080" },
  ],
  ["malformed principal", { ...inboxEndpoint, canisterId: "not-a-principal" }],
  [
    "noncanonical principal",
    { ...inboxEndpoint, canisterId: "RRKAH-FQAAA-AAAAA-AAAAQ-CAI" },
  ],
  ["anonymous", { ...inboxEndpoint, canisterId: "2vxsx-fae" }],
  ["management", { ...inboxEndpoint, canisterId: "aaaaa-aa" }],
  ["write capability", { ...inboxEndpoint, writeCapability: "A".repeat(43) }],
  ["inbox ID", { ...inboxEndpoint, inboxId: "a".repeat(64) }],
  ["private expiry", { ...inboxEndpoint, expiresAtMs: 123456789 }],
  [
    "private grant",
    {
      ...inboxEndpoint,
      inboxId: "a".repeat(64),
      writeCapability: "A".repeat(43),
      expiresAtMs: 123456789,
    },
  ],
])
  test(`preparation rejects ${name} in a public inbox endpoint`, async () => {
    const sample = await fixture({
      catalogChange: (value) => {
        value.apps[0].deliveryInbox = endpoint;
      },
    });
    await assert.rejects(prepareRegistration(sample.options));
    await assert.rejects(stat(sample.options.outputDirectory), {
      code: "ENOENT",
    });
  });
test("a local inbox endpoint needs the existing explicit loopback preparation option", async () => {
  const sample = await fixture({
    catalogChange: (value) => {
      value.apps[0].deliveryInbox = {
        ...inboxEndpoint,
        host: "http://127.0.0.1:8080",
      };
    },
  });
  const result = await prepareRegistration({
    ...sample.options,
    allowLoopback: true,
  });
  assert.equal(result.allowLoopback, true);
  assert.equal(result.published, false);
});

test("registration resolves same-publisher URLs and verifies exact public bytes without executing the processor", async () => {
  const sample = await fixture();
  const result = await prepareRegistration(sample.options);
  assert.equal(result.publisherOrigin, "https://publisher.example");
  assert.equal(
    result.verified.catalog.url,
    "https://publisher.example/apps/catalog.json",
  );
  assert.equal(result.verified.processor.sha256, hash(processor));
  assert.equal(result.processorExecuted, false);
  assert.equal(result.registered, false);
  assert.equal(result.published, false);
  assert.equal(result.frontendSemanticValidation, false);
  const descriptorText = (
    await readFile(
      path.join(sample.options.outputDirectory, "registration-descriptor.json"),
      "utf8",
    )
  ).trimEnd();
  const args = await readFile(
    path.join(sample.options.outputDirectory, "register-app.args.did"),
    "utf8",
  );
  assert.equal(decodeCandidArgument(args), descriptorText);
  assert.equal(result.descriptorSha256, hash(descriptorText));
  assert.equal(result.argumentSha256, hash(args));
  const descriptor = JSON.parse(descriptorText);
  assert.deepEqual(
    Object.keys(descriptor).sort(),
    [
      "id",
      "name",
      "description",
      "revision",
      "catalog",
      "processor",
      "setupUrl",
      "publisherOrigin",
    ].sort(),
  );
  assert.equal(descriptor.setupUrl, "https://publisher.example/apps/connect");
  assert.equal(descriptor.publisher, undefined);
  assert.equal(descriptor.owner, undefined);
});

test("Candid byte escaping round-trips quotes, backslashes, control escapes and Unicode without injection", () => {
  for (const value of [
    '{"name":"العربية 🧾"}',
    '"); (principal "aaaaa-aa")',
    'quote" slash\\ newline\n\r\t',
    "",
  ]) {
    assert.equal(decodeCandidArgument(`(${candidText(value)})\n`), value);
  }
  assert.throws(() => candidText("\ud800"));
});

test("HTTPS is canonicalized; local HTTP requires explicit loopback opt-in and port", () => {
  assert.equal(
    publicUrl("https://PUBLISHER.example:443/apps-v1.json"),
    "https://publisher.example/apps-v1.json",
  );
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])
    assert.equal(publicUrl(`${origin}/apps.json`, true), `${origin}/apps.json`);
  for (const url of [
    "http://publisher.example/apps.json",
    "http://localhost:3000/apps.json",
    "https://localhost/apps.json",
    "https://u:p@publisher.example/apps.json",
    "https://publisher.example/apps.json?token=x",
    "https://publisher.example/apps.json#x",
    "file:///tmp/apps.json",
  ])
    assert.throws(() => publicUrl(url));
  for (const url of [
    "http://0.0.0.0:3000/apps.json",
    "http://192.168.1.2:3000/apps.json",
    "http://localhost/apps.json",
    "http://localhost.example:3000/apps.json",
  ])
    assert.throws(() => publicUrl(url, true));
  assert.throws(() => publicUrl("https://publisher.example", "true"));
});

test("loopback registration requires opt-in and remains explicitly marked local", async () => {
  const sample = await fixture({
    catalogChange: (catalog) => {
      catalog.apps[0].destination = "http://localhost:3000/import";
    },
  });
  const options = {
    ...sample.options,
    sourceUrl: "http://localhost:3000/apps/apps-v1.json",
  };
  await assert.rejects(() => prepareRegistration(options));
  const result = await prepareRegistration({ ...options, allowLoopback: true });
  assert.equal(result.allowLoopback, true);
  assert.equal(result.publisherOrigin, "http://localhost:3000");
});

for (const field of ["catalog", "processor", "setupUrl"])
  test(`cross-publisher ${field} URL is rejected`, async () => {
    const sample = await fixture({
      descriptorChange: (descriptor) => {
        if (field === "setupUrl")
          descriptor.setupUrl = "https://other.example/connect";
        else descriptor[field].url = "https://other.example/artifact";
      },
    });
    await assert.rejects(
      () => prepareRegistration(sample.options),
      /publisher origin/,
    );
  });

for (const change of [
  (value) => {
    value.privateAccount = "secret";
  },
  (value) => {
    value.version = 2;
  },
  (value) => {
    value.apps.push(value.apps[0]);
  },
  (value) => {
    value.apps = Array(17).fill(value.apps[0]);
  },
  (value) => {
    value.apps[0].publisher = "aaaaa-aa";
  },
  (value) => {
    value.apps[0].publisherOrigin = "https://publisher.example";
  },
  (value) => {
    value.apps[0].name = "hidden\u200bname";
  },
  (value) => {
    value.apps[0].catalog.token = "private";
  },
  (value) => {
    value.apps[0].catalog.byteLength = 0;
  },
  (value) => {
    value.apps[0].processor.byteLength = 1024 * 1024 + 1;
  },
  (value) => {
    value.apps[0].processor.sha256 = "A".repeat(64);
  },
])
  test(`invalid directory contract rejects before writing output (${change.toString().slice(0, 75)})`, async () => {
    const sample = await fixture({ directoryChange: change });
    await assert.rejects(() => prepareRegistration(sample.options));
    await assert.rejects(() => stat(sample.options.outputDirectory), {
      code: "ENOENT",
    });
  });

for (const key of ["id", "name", "description", "revision"])
  test(`catalog ${key} mismatch is rejected despite valid artifact hashes`, async () => {
    const sample = await fixture({
      catalogChange: (catalog) => {
        catalog.apps[0][key] = "different";
      },
    });
    await assert.rejects(
      () => prepareRegistration(sample.options),
      /match the descriptor/,
    );
  });

for (const change of [
  (catalog) => {
    catalog.version = 2;
  },
  (catalog) => {
    catalog.apps.push(catalog.apps[0]);
  },
  (catalog) => {
    catalog.privateSetup = true;
  },
  (catalog) => {
    catalog.apps[0].deliveryEncryption = { privateRecipient: "do not publish" };
  },
  (catalog) => {
    catalog.apps[0].recipientLabel = "private destination";
  },
  (catalog) => {
    catalog.apps[0].unknown = "not public";
  },
  (catalog) => {
    catalog.apps[0].actions[0].processorContext = { privateLabels: [] };
  },
  (catalog) => {
    catalog.apps[0].actions[0].unknown = {};
  },
  (catalog) => {
    catalog.apps[0].actions[0].definition.unknown = {};
  },
  (catalog) => {
    catalog.apps[0].actions[0].definition.card.unknown = {};
  },
  (catalog) => {
    catalog.apps[0].actions[0].handoff.kind = "remote-script";
  },
  (catalog) => {
    catalog.apps[0].processor.sha256 = "0".repeat(64);
  },
  (catalog) => {
    catalog.apps[0].processor.byteLength++;
  },
  (catalog) => {
    catalog.apps[0].destination = "javascript:alert(1)";
  },
  (catalog) => {
    catalog.apps[0].actions.push(catalog.apps[0].actions[0]);
  },
])
  test(`non-public or mismatched catalog rejects (${change.toString().slice(0, 75)})`, async () => {
    const sample = await fixture({ catalogChange: change });
    await assert.rejects(() => prepareRegistration(sample.options));
  });

test("private and duplicate keys cannot be hidden by JSON escapes or shadowing", async () => {
  const sample = await fixture();
  const ordinary = encoded(sample.publicDirectory).toString();
  for (const source of [
    ordinary.replace('"version":1', '"version":1,"version":1'),
    ordinary.replace('"version":1', '"processor\\u0043ontext":{},"version":1'),
    ordinary.replace(
      '"version":1',
      '"deliveryEncryption":{},"deliveryEncryption":null,"version":1',
    ),
    ordinary.replace('"version":1', '"__proto__":{},"version":1'),
  ])
    assert.throws(() =>
      registrationDescriptor(Buffer.from(source), sourceUrl, "sample"),
    );
});

test("opaque public schema remains bounded JSON rather than executing or claiming frontend semantic validation", async () => {
  const sample = await fixture({
    catalogChange: (catalog) => {
      catalog.apps[0].actions[0].draftView = {
        version: 1,
        appDefinedData: ["not executed"],
      };
    },
  });
  const result = await prepareRegistration(sample.options);
  assert.equal(result.frontendSemanticValidation, false);
});

test("catalog destination cannot cross the approved publisher origin even with matching hashes", async () => {
  const sample = await fixture({
    catalogChange: (catalog) => {
      catalog.apps[0].destination = "https://other.example/import";
    },
  });
  await assert.rejects(
    () => prepareRegistration(sample.options),
    /destination must share the publisher origin/,
  );
  await assert.rejects(() => stat(sample.options.outputDirectory), {
    code: "ENOENT",
  });
});

test("the 7 KiB canonical descriptor budget includes the maximum injected publisher identity", async () => {
  const sample = await fixture({
    descriptorChange: (descriptor) => {
      descriptor.name = "n".repeat(200);
      descriptor.description = "d".repeat(4096);
      descriptor.revision = "r".repeat(128);
      descriptor.processor.url = `/apps/${"p".repeat(500)}.js`;
    },
  });
  const base = registrationDescriptor(
    encoded(sample.publicDirectory),
    sourceUrl,
    "sample",
  );
  const { publisherOrigin, ...publicFields } = base;
  const publishedSize = Buffer.byteLength(
    JSON.stringify({
      ...publicFields,
      publisher: { principal: "a".repeat(63), origin: publisherOrigin },
    }),
  );
  const padding = MAX_DESCRIPTOR_BYTES - publishedSize;
  assert.ok(padding > 0 && base.catalog.url.length + padding <= 2048);
  sample.publicDirectory.apps[0].catalog.url += "x".repeat(padding);
  const atLimit = registrationDescriptor(
    encoded(sample.publicDirectory),
    sourceUrl,
    "sample",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(atLimit)) < MAX_DESCRIPTOR_BYTES);
  sample.publicDirectory.apps[0].catalog.url += "x";
  assert.throws(
    () =>
      registrationDescriptor(
        encoded(sample.publicDirectory),
        sourceUrl,
        "sample",
      ),
    /7 KiB.*publisher identity/,
  );
});

test("descriptor budget counts UTF-8 bytes rather than only characters", async () => {
  const sample = await fixture({
    descriptorChange: (descriptor) => {
      descriptor.description = "ع".repeat(4000);
    },
  });
  assert.throws(
    () =>
      registrationDescriptor(
        encoded(sample.publicDirectory),
        sourceUrl,
        "sample",
      ),
    /7 KiB/,
  );
});

test("oversized and deeply nested public data fail closed", async () => {
  const sample = await fixture({
    catalogChange: (catalog) => {
      let child = catalog.apps[0].actions[0].definition.responseSchema;
      for (let count = 0; count < 35; count++) child = child.nested = {};
    },
  });
  await assert.rejects(
    () => prepareRegistration(sample.options),
    /structural limits/,
  );
  const normal = await fixture();
  await writeFile(normal.directoryFile, Buffer.alloc(128 * 1024 + 1, 32));
  await assert.rejects(() => prepareRegistration(normal.options), /oversized/);
});

for (const kind of ["catalog", "processor"])
  test(`${kind} missing/changed bytes or declared hashes fail without output`, async () => {
    const sample = await fixture();
    const file = kind === "catalog" ? sample.catalogFile : sample.processorFile;
    const bytes = await readFile(file);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    await writeFile(file, changed);
    await assert.rejects(
      () => prepareRegistration(sample.options),
      /SHA-256 mismatch/,
    );
    await writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
    await assert.rejects(
      () => prepareRegistration(sample.options),
      /byte length mismatch/,
    );
    await rm(file);
    await assert.rejects(() => prepareRegistration(sample.options), {
      code: "ENOENT",
    });
    await assert.rejects(() => stat(sample.options.outputDirectory), {
      code: "ENOENT",
    });
  });

for (const artifactPath of [
  "/apps/%2Fcatalog.json",
  "/apps/%5Ccatalog.json",
  "/apps/catalog.json%00",
  "/apps/file:stream",
  "/apps/catalog.json.",
])
  test(`unsafe artifact pathname is refused: ${artifactPath}`, async () => {
    const sample = await fixture({
      descriptorChange: (descriptor) => {
        descriptor.catalog.url = artifactPath;
      },
    });
    await assert.rejects(
      () => prepareRegistration(sample.options),
      /Unsafe artifact URL path/,
    );
  });

test("artifact symlink/junction outside the package directory is refused", async () => {
  const sample = await fixture({
    descriptorChange: (descriptor) => {
      descriptor.catalog.url = "/escape/catalog.json";
    },
  });
  const outside = path.join(sample.directory, "outside");
  await mkdir(outside);
  await writeFile(
    path.join(outside, "catalog.json"),
    await readFile(sample.catalogFile),
  );
  await symlink(
    outside,
    path.join(sample.options.packageDirectory, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    () => prepareRegistration(sample.options),
    /escapes package directory/,
  );
});

test("preparation never overwrites an existing output directory or accepts relative output", async () => {
  const sample = await fixture();
  await mkdir(sample.options.outputDirectory);
  const sentinel = path.join(sample.options.outputDirectory, "keep.txt");
  await writeFile(sentinel, "preserve this existing project");
  await assert.rejects(() => prepareRegistration(sample.options), {
    code: "EEXIST",
  });
  assert.equal(
    await readFile(sentinel, "utf8"),
    "preserve this existing project",
  );
  await assert.rejects(
    () =>
      prepareRegistration({
        ...sample.options,
        outputDirectory: "relative-directory",
      }),
    /absolute new directory/,
  );
});

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const candid = Buffer.from(
  "service : (record { operator : principal; allow_loopback : bool }) -> { register_app : (text) -> (text) };\n",
);
async function localFixture() {
  const directory = path.join(root, `local-${++index}`);
  await mkdir(directory);
  const wasmFile = path.join(directory, "built.wasm");
  const candidFile = path.join(directory, "reviewed.did");
  await writeFile(wasmFile, wasm);
  await writeFile(candidFile, candid);
  return {
    wasmFile,
    candidFile,
    replica: "http://127.0.0.1:8080",
    outputDirectory: path.join(directory, "prepared"),
  };
}

test("prepare-local copies exact reviewed inputs and creates only the isolated loopback canister config", async () => {
  const options = await localFixture();
  const result = await prepareLocal(options);
  assert.equal(result.localOnly, true);
  assert.equal(result.deployed, false);
  assert.equal(result.identityExported, false);
  assert.equal(result.canisterCreated, false);
  assert.equal(result.dfxVersion, "0.31.0-beta.1");
  assert.equal(DFX_VERSION, result.dfxVersion);
  const dfx = JSON.parse(
    await readFile(path.join(options.outputDirectory, "dfx.json"), "utf8"),
  );
  assert.deepEqual(dfx, {
    dfx: DFX_VERSION,
    canisters: {
      app_registry: {
        type: "custom",
        candid: "app_registry.did",
        wasm: "app_registry.wasm",
      },
    },
    networks: {
      registry_local: { providers: [options.replica], type: "persistent" },
    },
  });
  for (const [file, identity] of Object.entries(result.files)) {
    const bytes = await readFile(path.join(options.outputDirectory, file));
    assert.equal(bytes.length, identity.byteLength);
    assert.equal(hash(bytes), identity.sha256);
  }
  assert.deepEqual(
    await readFile(path.join(options.outputDirectory, "app_registry.wasm")),
    wasm,
  );
  assert.deepEqual(
    await readFile(path.join(options.outputDirectory, "app_registry.did")),
    candid,
  );
  await assert.rejects(() => prepareLocal(options), { code: "EEXIST" });
});

for (const replica of [
  "ic",
  "https://icp-api.io",
  "http://example.invalid:8080",
  "http://0.0.0.0:8080",
  "http://192.168.1.2:8080",
  "https://localhost:8080",
  "http://localhost",
  "http://user:secret@localhost:8080",
  "http://localhost:8080/api",
  "http://localhost:8080/?ic",
  "http://localhost:8080/#ic",
])
  test(`local replica guard refuses ${replica}`, () =>
    assert.throws(() => localReplica(replica)));

test("local preparation rejects invalid WASM and missing or malformed Candid", async () => {
  const options = await localFixture();
  await writeFile(options.wasmFile, "not wasm");
  await assert.rejects(() => prepareLocal(options), /WebAssembly/);
  await writeFile(options.wasmFile, wasm);
  await writeFile(options.candidFile, "not a candid service");
  await assert.rejects(() => prepareLocal(options), /Candid service/);
  await rm(options.candidFile);
  await assert.rejects(() => prepareLocal(options), { code: "ENOENT" });
  await assert.rejects(() => stat(options.outputDirectory), { code: "ENOENT" });
});

test("CLI refuses deployment, publication, identity fields, duplicate options and missing values", async () => {
  for (const args of [
    [],
    ["deploy"],
    ["publish"],
    ["prepare-registration", "--publisher", "aaaaa-aa"],
    ["prepare-local", "--network", "ic"],
    ["prepare-local", "--replica"],
    [
      "prepare-local",
      "--replica",
      "http://localhost:8080",
      "--replica",
      "http://localhost:8080",
    ],
    ["prepare-registration", "--allow-loopback", "false"],
  ])
    await assert.rejects(() => main(args));
});

test("CLI prepares both artifacts without exporting any identity or invoking a network/deployment runner", async () => {
  const sample = await fixture();
  const local = await localFixture();
  const captured = [];
  const previous = console.log;
  console.log = (value) => captured.push(JSON.parse(value));
  try {
    await main([
      "prepare-registration",
      "--directory-file",
      sample.options.directoryFile,
      "--source-url",
      sourceUrl,
      "--package-directory",
      sample.options.packageDirectory,
      "--app-id",
      "sample",
      "--output-directory",
      sample.options.outputDirectory,
    ]);
    await main([
      "prepare-local",
      "--wasm-file",
      local.wasmFile,
      "--candid-file",
      local.candidFile,
      "--replica",
      local.replica,
      "--output-directory",
      local.outputDirectory,
    ]);
  } finally {
    console.log = previous;
  }
  assert.equal(captured.length, 2);
  assert.equal(captured[0].registered, false);
  assert.equal(captured[1].deployed, false);
  const source = await readFile(
    new URL("./registry.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["']node:(?:http|https|net|tls|dns|child_process)["']/,
  );
  assert.doesNotMatch(source, /\b(?:fetch|execFile|spawn|eval)\s*\(/);
});
