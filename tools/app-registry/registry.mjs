#!/usr/bin/env node
// Offline public-artifact preparation only: no network, identity, deployment or processor execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const DFX_VERSION = "0.31.0-beta.1";
export const MAX_DESCRIPTOR_BYTES = 7 * 1024;
const MAX_DIRECTORY = 128 * 1024;
const MAX_ARTIFACT = 1024 * 1024;
const MAX_WASM = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const HIDDEN = /[\p{Cf}\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_JSON_TEXT =
  /[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const PRIVATE_KEYS = new Set([
  "deliveryEncryption",
  "processorContext",
  "recipientLabel",
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DESCRIPTOR_KEYS = [
  "id",
  "name",
  "description",
  "revision",
  "catalog",
  "processor",
  "setupUrl",
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function exact(value, required, optional = []) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  assert.ok(
    required.every((key) => Object.hasOwn(value, key)),
    "Missing required public field",
  );
  assert.ok(
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    ),
    "Unknown or private public-contract field",
  );
}

function text(value, max, empty = false) {
  assert.ok(
    typeof value === "string" &&
      value.length <= max &&
      (empty || value.length > 0) &&
      value.trim() === value &&
      value.isWellFormed() &&
      !HIDDEN.test(value),
    "Invalid public text",
  );
  return value;
}

function identifier(value) {
  text(value, 128);
  assert.match(value, ID, "Invalid public identifier");
  return value;
}

function publicJson(bytes, max) {
  assert.ok(
    bytes.length > 0 && bytes.length <= max,
    "Public JSON exceeds its byte limit",
  );
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(source);
  // Reject shadowed fields too: JSON.parse alone silently accepts duplicate keys.
  const objects = [];
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (/^\s*:/.test(source.slice(match.index + token.length))) {
      const key = JSON.parse(token);
      const keys = objects.at(-1);
      assert.ok(keys && !keys.has(key), "Duplicate JSON field");
      assert.ok(
        !PRIVATE_KEYS.has(key) && !FORBIDDEN_KEYS.has(key),
        "Private or unsafe JSON field",
      );
      keys.add(key);
    }
  }
  let nodes = 0;
  function bounded(value, depth) {
    assert.ok(
      ++nodes <= 20000 && depth <= 32,
      "Public JSON exceeds structural limits",
    );
    if (typeof value === "number")
      assert.ok(Number.isFinite(value), "Invalid JSON number");
    if (typeof value === "string")
      assert.ok(
        value.isWellFormed() && !UNSAFE_JSON_TEXT.test(value),
        "Unsafe JSON text",
      );
    if (value && typeof value === "object")
      for (const child of Object.values(value)) bounded(child, depth + 1);
  }
  bounded(parsed, 0);
  return parsed;
}

export function publicUrl(value, allowLoopback = false, source) {
  assert.equal(
    typeof allowLoopback,
    "boolean",
    "Loopback approval must be explicit",
  );
  text(value, 2048);
  const url = source === undefined ? new URL(value) : new URL(value, source);
  assert.ok(
    !url.username && !url.password && !url.search && !url.hash,
    "Public URLs cannot contain credentials, query or fragment",
  );
  const local = LOOPBACK.has(url.hostname);
  assert.ok(
    (url.protocol === "https:" && (!local || allowLoopback)) ||
      (url.protocol === "http:" && local && allowLoopback && url.port),
    "HTTPS is required; HTTP loopback needs explicit approval and port",
  );
  if (source !== undefined)
    assert.equal(
      url.origin,
      new URL(source).origin,
      "Public package URLs must share the publisher origin",
    );
  return url.href;
}

function artifact(value, source, allowLoopback) {
  exact(value, ["url", "sha256", "byteLength"]);
  assert.match(value.sha256, /^[a-f0-9]{64}$/, "Invalid artifact SHA-256");
  assert.ok(
    Number.isSafeInteger(value.byteLength) &&
      value.byteLength > 0 &&
      value.byteLength <= MAX_ARTIFACT,
    "Invalid artifact byte length",
  );
  return {
    url: publicUrl(value.url, allowLoopback, source),
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}

export function registrationDescriptor(
  directoryBytes,
  sourceUrl,
  appId,
  allowLoopback = false,
) {
  const source = publicUrl(sourceUrl, allowLoopback);
  identifier(appId);
  const directory = publicJson(directoryBytes, MAX_DIRECTORY);
  exact(directory, ["version", "apps"]);
  assert.equal(directory.version, 1, "Only directory version 1 is supported");
  assert.ok(
    Array.isArray(directory.apps) && directory.apps.length <= 16,
    "Invalid directory apps",
  );
  const ids = new Set();
  const descriptors = directory.apps.map((entry) => {
    exact(entry, DESCRIPTOR_KEYS);
    identifier(entry.id);
    identifier(entry.revision);
    text(entry.name, 200);
    text(entry.description, 4096);
    assert.ok(!ids.has(entry.id), "Duplicate app ID");
    ids.add(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      revision: entry.revision,
      catalog: artifact(entry.catalog, source, allowLoopback),
      processor: artifact(entry.processor, source, allowLoopback),
      setupUrl: publicUrl(entry.setupUrl, allowLoopback, source),
      publisherOrigin: new URL(source).origin,
    };
  });
  const selected = descriptors.find((entry) => entry.id === appId);
  assert.ok(selected, "Requested app is not in the supplied public directory");
  const { publisherOrigin, ...publicFields } = selected;
  // The canister replaces publisherOrigin with its authenticated caller binding.
  // Reserve the maximum principal text length; never request or emit a fake owner.
  const largestPublished = {
    ...publicFields,
    publisher: { principal: "a".repeat(63), origin: publisherOrigin },
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(selected)) <= MAX_DESCRIPTOR_BYTES &&
      Buffer.byteLength(JSON.stringify(largestPublished)) <=
        MAX_DESCRIPTOR_BYTES,
    "Descriptor exceeds the canister's 7 KiB bound including publisher identity",
  );
  return selected;
}

function publicInbox(value, allowLoopback) {
  exact(value, ["version", "kind", "host", "canisterId"]);
  assert.equal(value.version, 1);
  assert.equal(value.kind, "ic-canister");
  assert.equal(
    new URL(publicUrl(value.host, allowLoopback)).origin,
    value.host,
    "Inbox host must be an exact canonical HTTPS origin or approved loopback origin",
  );
  text(value.canisterId, 63);
  // Reuse the frontend's already-pinned ICP SDK; never implement a second principal codec.
  const { Principal } = createRequire(
    new URL("../../frontend/package.json", import.meta.url),
  )("@icp-sdk/core/principal");
  const principal = Principal.fromText(value.canisterId);
  assert.equal(
    principal.toText(),
    value.canisterId,
    "Inbox principal must be canonical",
  );
  assert.ok(
    !principal.isAnonymous() && value.canisterId !== "aaaaa-aa",
    "Inbox requires a canister principal",
  );
}

function validateCatalog(bytes, descriptor, allowLoopback) {
  const catalog = publicJson(bytes, MAX_ARTIFACT);
  exact(catalog, ["version", "apps"]);
  assert.equal(catalog.version, 1);
  assert.ok(
    Array.isArray(catalog.apps) && catalog.apps.length === 1,
    "Public catalog must contain exactly one app",
  );
  const app = catalog.apps[0];
  exact(
    app,
    [
      "id",
      "revision",
      "name",
      "description",
      "destination",
      "processor",
      "actions",
    ],
    ["deliveryInbox"],
  );
  if (app.deliveryInbox !== undefined)
    publicInbox(app.deliveryInbox, allowLoopback);
  for (const key of ["id", "revision", "name", "description"])
    assert.equal(
      app[key],
      descriptor[key],
      `Catalog ${key} must match the descriptor`,
    );
  assert.equal(
    new URL(publicUrl(app.destination, allowLoopback)).origin,
    descriptor.publisherOrigin,
    "Catalog destination must share the publisher origin",
  );
  exact(app.processor, ["sha256", "byteLength"]);
  assert.equal(app.processor.sha256, descriptor.processor.sha256);
  assert.equal(app.processor.byteLength, descriptor.processor.byteLength);
  assert.ok(
    Array.isArray(app.actions) &&
      app.actions.length > 0 &&
      app.actions.length <= 32,
    "Invalid public actions",
  );
  const actionIds = new Set();
  for (const action of app.actions) {
    exact(
      action,
      ["definition", "draftSchema", "handoff"],
      ["draftEditor", "draftPresentation", "draftView"],
    );
    exact(
      action.definition,
      ["name", "description", "promptTemplate", "responseSchema", "card"],
      ["rules", "acceptsImage"],
    );
    const definition = action.definition;
    identifier(definition.name);
    assert.ok(!actionIds.has(definition.name), "Duplicate action name");
    actionIds.add(definition.name);
    text(definition.description, 4096, true);
    assert.ok(
      typeof definition.promptTemplate === "string" &&
        definition.promptTemplate.trim().length > 0 &&
        definition.promptTemplate.length <= 16384,
      "Invalid public prompt template",
    );
    for (const schema of [definition.responseSchema, action.draftSchema])
      assert.ok(
        schema && typeof schema === "object" && !Array.isArray(schema),
        "Expected a schema object",
      );
    exact(
      definition.card,
      ["title", "rows", "confirmLabel", "cancelLabel"],
      ["disclosure"],
    );
    text(definition.card.title, 200);
    text(definition.card.confirmLabel, 128);
    text(definition.card.cancelLabel, 128);
    if (definition.card.disclosure !== undefined)
      text(definition.card.disclosure, 4096);
    assert.ok(
      Array.isArray(definition.card.rows) &&
        definition.card.rows.length > 0 &&
        definition.card.rows.length <= 32,
      "Invalid public card rows",
    );
    for (const row of definition.card.rows) {
      exact(row, ["label", "valueKey"]);
      text(row.label, 128);
      assert.match(row.valueKey, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    }
    if (definition.acceptsImage !== undefined)
      assert.equal(typeof definition.acceptsImage, "boolean");
    if (definition.rules !== undefined)
      assert.ok(
        Array.isArray(definition.rules) && definition.rules.length <= 20,
        "Invalid public rules",
      );
    if (action.handoff?.kind === "wrapped-list") {
      exact(action.handoff, ["kind", "field"]);
      assert.match(action.handoff.field, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    } else {
      exact(action.handoff, ["kind"]);
      assert.ok(
        ["single", "list"].includes(action.handoff.kind),
        "Invalid handoff kind",
      );
    }
  }
}

async function readBounded(file, limit) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() && info.size > 0 && info.size <= limit,
      "Invalid or oversized input file",
    );
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    assert.equal(offset, info.size, "Input file changed while reading");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function artifactFile(packageDirectory, url) {
  const root = await realpath(packageDirectory);
  assert.ok(
    (await stat(root)).isDirectory(),
    "Package directory must be a directory",
  );
  const segments = new URL(url).pathname
    .split("/")
    .slice(1)
    .map(decodeURIComponent);
  assert.ok(
    segments.length &&
      segments.every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[\\/<>:"|?*\u0000-\u001f]/.test(part) &&
          !/[. ]$/.test(part),
      ),
    "Unsafe artifact URL path",
  );
  const candidate = await realpath(path.join(root, ...segments));
  const relative = path.relative(root, candidate);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Artifact escapes package directory",
  );
  return candidate;
}

async function writeNewDirectory(directory, files) {
  assert.ok(
    typeof directory === "string" && path.isAbsolute(directory),
    "Output must be an absolute new directory",
  );
  await mkdir(directory); // Parent must exist; an existing deployment is never overwritten.
  for (const [name, bytes] of Object.entries(files))
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
}

export function candidText(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.isWellFormed(), "Candid text must be valid Unicode");
  return `"${[...Buffer.from(value, "utf8")].map((byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("")}"`;
}

export async function prepareRegistration({
  directoryFile,
  sourceUrl,
  packageDirectory,
  appId,
  outputDirectory,
  allowLoopback = false,
}) {
  const directoryBytes = await readBounded(directoryFile, MAX_DIRECTORY);
  const descriptor = registrationDescriptor(
    directoryBytes,
    sourceUrl,
    appId,
    allowLoopback,
  );
  const verified = {};
  for (const name of ["catalog", "processor"]) {
    const expected = descriptor[name];
    const file = await artifactFile(packageDirectory, expected.url);
    const bytes = await readBounded(file, MAX_ARTIFACT);
    assert.equal(
      bytes.length,
      expected.byteLength,
      `${name} byte length mismatch`,
    );
    assert.equal(sha256(bytes), expected.sha256, `${name} SHA-256 mismatch`);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (name === "catalog") validateCatalog(bytes, descriptor, allowLoopback);
    verified[name] = {
      url: expected.url,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  }
  const descriptorJson = JSON.stringify(descriptor);
  const args = `(${candidText(descriptorJson)})\n`;
  const receipt = {
    schema: 1,
    operation: "prepare-registration",
    appId,
    sourceUrl: publicUrl(sourceUrl, allowLoopback),
    publisherOrigin: descriptor.publisherOrigin,
    allowLoopback,
    directory: {
      byteLength: directoryBytes.length,
      sha256: sha256(directoryBytes),
    },
    verified,
    descriptorSha256: sha256(descriptorJson),
    argumentSha256: sha256(args),
    caller:
      "Supplied by the separately configured dfx identity; no principal is embedded or exported.",
    frontendSemanticValidation: false,
    processorExecuted: false,
    registered: false,
    published: false,
    note: "Public artifact preflight only. The real client must validate catalog semantics; the registry supplies the pending commitment for operator review.",
  };
  await writeNewDirectory(outputDirectory, {
    "registration-descriptor.json": `${descriptorJson}\n`,
    "register-app.args.did": args,
    "preparation-receipt.json": json(receipt),
  });
  return receipt;
}

export function localReplica(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === "http:" &&
      LOOPBACK.has(url.hostname) &&
      url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Use only an explicit HTTP loopback replica port",
  );
  return url.origin;
}

export async function prepareLocal({
  wasmFile,
  candidFile,
  replica,
  outputDirectory,
}) {
  const provider = localReplica(replica);
  const wasm = await readBounded(wasmFile, MAX_WASM);
  assert.ok(
    WebAssembly.validate(wasm),
    "Input must be a valid uncompressed built WebAssembly module",
  );
  const candid = await readBounded(candidFile, MAX_ARTIFACT);
  const candidSource = new TextDecoder("utf-8", { fatal: true }).decode(candid);
  assert.ok(
    candidSource.trim().length > 0 &&
      /\bservice\s*(?::|[A-Za-z_])/.test(candidSource),
    "Input must be the reviewed canister Candid service",
  );
  const dfx = {
    dfx: DFX_VERSION,
    canisters: {
      app_registry: {
        type: "custom",
        candid: "app_registry.did",
        wasm: "app_registry.wasm",
      },
    },
    networks: { registry_local: { providers: [provider], type: "persistent" } },
  };
  const receipt = {
    schema: 1,
    operation: "prepare-local",
    localOnly: true,
    replica: provider,
    dfxVersion: DFX_VERSION,
    files: {
      "app_registry.wasm": { byteLength: wasm.length, sha256: sha256(wasm) },
      "app_registry.did": { byteLength: candid.length, sha256: sha256(candid) },
      "dfx.json": {
        byteLength: Buffer.byteLength(json(dfx)),
        sha256: sha256(json(dfx)),
      },
    },
    deployed: false,
    identityExported: false,
    canisterCreated: false,
    note: "Preparation only. A separately approved local deploy must supply the reviewed operator principal and allow_loopback init record. No OpenChat canister is included.",
  };
  await writeNewDirectory(outputDirectory, {
    "app_registry.wasm": wasm,
    "app_registry.did": candid,
    "dfx.json": json(dfx),
    "preparation-receipt.json": json(receipt),
  });
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const allowed =
    command === "prepare-registration"
      ? [
          "directory-file",
          "source-url",
          "package-directory",
          "app-id",
          "output-directory",
          "allow-loopback",
        ]
      : command === "prepare-local"
        ? ["wasm-file", "candid-file", "replica", "output-directory"]
        : [];
  assert.ok(
    allowed.length,
    "Use prepare-registration or prepare-local; this tool never deploys or publishes",
  );
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    assert.ok(
      flag.startsWith("--") && allowed.includes(flag.slice(2)),
      "Unknown option",
    );
    const name = flag
      .slice(2)
      .replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    assert.ok(!Object.hasOwn(options, name), "Duplicate option");
    if (flag === "--allow-loopback") options[name] = true;
    else {
      const value = rest[++index];
      assert.ok(value && !value.startsWith("--"), "Missing option value");
      options[name] = value;
    }
  }
  for (const flag of allowed.filter((item) => item !== "allow-loopback"))
    assert.ok(
      options[
        flag.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
      ],
      `Missing --${flag}`,
    );
  const result =
    command === "prepare-local"
      ? await prepareLocal(options)
      : await prepareRegistration(options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
