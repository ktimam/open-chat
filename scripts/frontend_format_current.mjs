import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { diffLinesRaw } from "../frontend/node_modules/@vitest/utils/dist/diff.js";
import {
  createCurrentInheritedFormattingChecker,
  inheritedFormattingDigest as digest,
} from "./frontend_format_inherited.mjs";

export const CURRENT_FORMAT_BASE = "944efe4a7270d42f62dc3bfa5bad853b237d4b69";
export const CURRENT_FORMAT_EDIT_ALGORITHM = "unique-common-line-anchors-v1";

// Same edit identity as the historical review: exact removed/added lines,
// including repeated edits. This does not trim source or ignore whitespace.
export function formattingEditSha256s(source, formatted) {
  const before = source.replaceAll("\r\n", "\n").split("\n");
  const after = formatted.replaceAll("\r\n", "\n").split("\n");
  const counts = (lines) => {
    const result = new Map();
    for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
    return result;
  };
  const beforeCounts = counts(before),
    afterCounts = counts(after);
  // Repeated lines such as `false,` and `);` are ambiguous anchors. Never let
  // the line diff align them with another declaration. Keep exact line bytes
  // and remove only equal prefix/suffix lines from each resulting edit block.
  const encode = (lines, side) =>
    lines.map((line, index) =>
      JSON.stringify(
        beforeCounts.get(line) === 1 && afterCounts.get(line) === 1
          ? ["anchor", line]
          : [side, index, line],
      ),
    );
  const [diffs, truncated] = diffLinesRaw(
    encode(before, "before"),
    encode(after, "after"),
  );
  assert.equal(truncated, false, "Formatting proof must not be truncated");
  const result = [];
  let removed = [],
    added = [];
  const flush = () => {
    while (removed.length && added.length && removed[0] === added[0]) {
      removed.shift();
      added.shift();
    }
    while (removed.length && added.length && removed.at(-1) === added.at(-1)) {
      removed.pop();
      added.pop();
    }
    if (removed.length || added.length) {
      result.push(digest(JSON.stringify([removed, added])));
      removed = [];
      added = [];
    }
  };
  for (const entry of diffs) {
    if (entry[0] === 0) flush();
    else if (entry[0] === -1) removed.push(JSON.parse(entry[1]).at(-1));
    else added.push(JSON.parse(entry[1]).at(-1));
  }
  flush();
  return result;
}

export function formatCurrentSource(
  frontendRoot,
  path,
  source,
  execute = spawnSync,
) {
  assert(path.startsWith("frontend/"), "Reviewed frontend path required");
  const result = execute(
    process.execPath,
    [
      resolve(frontendRoot, "node_modules/prettier/bin/prettier.cjs"),
      "--plugin=prettier-plugin-svelte",
      "--stdin-filepath",
      resolve(frontendRoot, path.slice("frontend/".length)),
      "--end-of-line=lf",
    ],
    {
      cwd: frontendRoot,
      encoding: "utf8",
      input: source.replaceAll("\r\n", "\n"),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const stderr = (result.stderr ?? "").replace(/\u001b\[[0-9;]*m/gu, "");
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    stderr
      .split(/\r?\n/u)
      .filter(Boolean)
      .some((line) => line !== "[warn] svelteBracketNewLine is deprecated.")
  )
    throw new Error(
      `Current formatting proof CLI failed: ${result.error?.message ?? ""}\n${stderr}`,
    );
  return result.stdout;
}

export function createCurrentFormattingReview(registry, formatSource) {
  assert.equal(typeof formatSource, "function");
  assert.equal(
    registry.editAlgorithm,
    CURRENT_FORMAT_EDIT_ALGORITHM,
    "Unreviewed formatting edit algorithm",
  );
  const identityCheck = createCurrentInheritedFormattingChecker(registry);
  for (const record of registry.records)
    assert.equal(
      record.baseCommit,
      CURRENT_FORMAT_BASE,
      "Current review must pin current upstream",
    );
  const records = new Map(
    registry.records.map((record) => [record.path, structuredClone(record)]),
  );
  return (input) => {
    const identity = identityCheck(input);
    if (!identity.accepted) return identity;
    const record = records.get(input.path);
    const actual = {
      baseEditSha256s: formattingEditSha256s(
        input.baseSource,
        formatSource(input.path, input.baseSource),
      ),
      candidateEditSha256s: formattingEditSha256s(
        input.candidateSource,
        formatSource(input.path, input.candidateSource),
      ),
    };
    if (
      JSON.stringify(actual.baseEditSha256s) !==
        JSON.stringify(record.proof.baseEditSha256s) ||
      JSON.stringify(actual.candidateEditSha256s) !==
        JSON.stringify(record.proof.candidateEditSha256s)
    )
      return { accepted: false, reason: "live-formatter-proof-drift" };
    return { ...identity, liveProofVerified: true };
  };
}

export function readCurrentFormattingRegistry() {
  return JSON.parse(
    readFileSync(
      new URL("./frontend_format_current.json", import.meta.url),
      "utf8",
    ),
  );
}
