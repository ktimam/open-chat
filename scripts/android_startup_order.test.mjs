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
  assert.equal(source.match(/WebView\.setWebContentsDebuggingEnabled\(/gu)?.length, 1);
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
  const provider = onCreate.indexOf("WebView.setWebContentsDebuggingEnabled(true)");
  assert.ok(neutralize >= 0 && neutralize < provider);
});
