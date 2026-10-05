import assert from "node:assert/strict";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedSecurityRules } from "./security_owned_rules.mjs";
import {
  candidateFormattingPaths,
  checkFrontendFormatting,
} from "./frontend_format_check.mjs";
import {
  CURRENT_FORMAT_BASE,
  CURRENT_FORMAT_MERGED_BASES,
  createCurrentFormattingReview,
  formatCurrentSource,
  readCurrentFormattingRegistry,
} from "./frontend_format_current.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function currentFormattingCandidates(
  repositoryRoot,
  comparisonBase,
  ci = false,
) {
  const policy = ownedSecurityRules("pr1").format;
  const changed = candidateFormattingPaths({
    root: repositoryRoot,
    comparisonBase,
    ci,
  }).filter((path) => path.startsWith(policy.sourceRoot));
  const excluded = (path) =>
    Object.hasOwn(policy.excludedFiles, path) ||
    Object.keys(policy.excludedPrefixes).some((prefix) =>
      path.startsWith(prefix),
    );
  return {
    paths: changed.filter(
      (path) =>
        !excluded(path) &&
        policy.extensions.includes(extname(path).toLowerCase()),
    ),
    excludedCount: changed.filter(excluded).length,
  };
}

export function checkCurrentClientFormat({
  repositoryRoot = root,
  comparisonBase = CURRENT_FORMAT_BASE,
  ci = process.env.CI === "true",
  report = console.log,
  registry = readCurrentFormattingRegistry(),
} = {}) {
  const { paths, excludedCount } = currentFormattingCandidates(
    repositoryRoot,
    comparisonBase,
    ci,
  );
  const frontend = resolve(repositoryRoot, "frontend");
  const reviewed = [];
  const classify = createCurrentFormattingReview(registry, (path, source) =>
    formatCurrentSource(frontend, path, source),
  );
  const groups = new Map();
  for (const path of paths) {
    const base = CURRENT_FORMAT_MERGED_BASES[path] ?? CURRENT_FORMAT_BASE;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(path);
  }
  const failures = [...groups].flatMap(([inheritedBase, group]) =>
    checkFrontendFormatting(
      frontend,
      group.map((path) =>
        relative(frontend, resolve(repositoryRoot, path)).replaceAll("\\", "/"),
      ),
      undefined,
      {
        inheritedBase,
        currentInheritedReview: (input) => {
          const result = classify(input);
          if (result.accepted) reviewed.push(input.path);
          return result;
        },
        report,
      },
    ),
  );
  return {
    pass: failures.length === 0,
    scope: "current-client",
    comparisonBase,
    inheritedBase: CURRENT_FORMAT_BASE,
    checkedFiles: paths.length,
    excludedFiles: excludedCount,
    liveReviewedPaths: reviewed,
    failures,
    advisoryChecksPerformed: false,
    releaseAcceptance: false,
  };
}

export function parseCurrentFormatArgs(args) {
  assert.deepEqual(
    args,
    ["--scope", "current-client"],
    "Usage: node scripts/check_current_client_format.mjs --scope current-client",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    parseCurrentFormatArgs(process.argv.slice(2));
    const result = checkCurrentClientFormat({
      comparisonBase: process.env.PR_BASE_SHA || CURRENT_FORMAT_BASE,
    });
    console.log(JSON.stringify(result));
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
