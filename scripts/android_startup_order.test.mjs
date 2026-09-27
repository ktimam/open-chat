import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Static source-order regression only: this does not prove Android startup timing or reliability.
const source = readFileSync(
  new URL(
    "../frontend/src-tauri/gen/android/app/src/main/java/com/oclabs/openchat/MainActivity.kt",
    import.meta.url,
  ),
  "utf8",
);
const onCreate = source.match(
  /override fun onCreate\(savedInstanceState: Bundle\?\) \{([\s\S]*?)\n    \}/u,
)?.[1];

test("keeps the existing WebView debugging setting exactly once", () => {
  assert.equal(
    source.match(/WebView\.setWebContentsDebuggingEnabled\(/gu)?.length,
    1,
  );
  assert.match(source, /WebView\.setWebContentsDebuggingEnabled\(true\)/u);
});

test("initializes the provider before super starts Wry's timed version lookup", () => {
  assert.ok(onCreate, "MainActivity.onCreate must remain present");
  assert.match(
    onCreate,
    /WebView\.setWebContentsDebuggingEnabled\(true\)\s+super\.onCreate\(savedInstanceState\)/u,
  );
});

test("keeps VIEW-intent neutralization ahead of provider and Rust initialization", () => {
  assert.ok(onCreate, "MainActivity.onCreate must remain present");
  const neutralize = onCreate.indexOf("setIntent(neutralized(intent))");
  const provider = onCreate.indexOf(
    "WebView.setWebContentsDebuggingEnabled(true)",
  );
  assert.ok(neutralize >= 0 && neutralize < provider);
});

const workflow = readFileSync(
  new URL("../.github/workflows/frontend.yaml", import.meta.url),
  "utf8",
);

test("frontend build runs the offline startup and local APK tests before general policy checks", () => {
  const build = workflow.match(
    /^  build:\r?\n([\s\S]*?)(?=^  install-and-test:)/mu,
  )?.[1];
  assert.ok(build, "frontend build job must remain present");
  const command =
    "node --test scripts/android_startup_order.test.mjs scripts/build-unofficial-local-apk.test.mjs";
  assert.match(
    build,
    /      - name: Check offline local APK startup and build contracts\r?\n        working-directory: \.\r?\n        run: node --test scripts\/android_startup_order\.test\.mjs scripts\/build-unofficial-local-apk\.test\.mjs\r?\n/u,
  );
  assert.ok(
    build.indexOf(command) <
      build.indexOf("- name: Check PR and release policy regressions"),
  );
});

test("standalone startup and local APK test changes trigger frontend CI", () => {
  const filter = workflow.match(
    /          filters: \|\r?\n            frontend:\r?\n((?:              - "[^"\r\n]+"\r?\n)+)/u,
  )?.[1];
  assert.ok(filter, "frontend change filter must remain present");
  const paths = [...filter.matchAll(/              - "([^"\r\n]+)"/gu)].map(
    (match) => match[1],
  );
  assert.ok(paths.includes("scripts/android_startup_order.test.mjs"));
  assert.ok(paths.includes("scripts/build-unofficial-local-apk.test.mjs"));
});
