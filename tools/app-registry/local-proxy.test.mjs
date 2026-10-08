import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  allowedPath,
  validateConfiguration,
  createLocalRegistryServer,
} from "./local-proxy.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
test("only exact registry snapshot paths are exposed", () => {
  for (const path of [
    "/apps-v2.json",
    "/pages/0/1.json",
    "/pages/18446744073709551615/15.json",
  ])
    assert.equal(allowedPath(path), true);
  for (const path of [
    "/",
    "/api/v2/status",
    "/apps-v2.json?x=1",
    "/pages/01/1.json",
    "/pages/1/0.json",
    "/pages/1/16.json",
    "/pages/18446744073709551616/1.json",
    "//apps-v2.json",
    "/%61pps-v2.json",
    "https://other.test/apps-v2.json",
  ])
    assert.equal(allowedPath(path), false);
});
test("upstream configuration cannot become an arbitrary proxy", () => {
  assert.equal(
    validateConfiguration("http://127.0.0.1:8080", "aaaaa-aa").host,
    "aaaaa-aa.localhost:8080",
  );
  for (const value of [
    "https://127.0.0.1:8080",
    "http://other.test:8080",
    "http://localhost",
    "http://localhost:8080/api",
    "http://user:secret@localhost:8080",
    "http://localhost:8080?x=1",
  ])
    assert.throws(() => validateConfiguration(value, "aaaaa-aa"));
  for (const value of [
    "../host",
    "foo.test",
    "a\r\nHost: other",
    "x".repeat(64),
  ])
    assert.throws(() => validateConfiguration("http://localhost:8080", value));
});
test("forwards only public GET with fixed canister host, never incoming identity headers", async () => {
  let seen;
  const body = Buffer.from(
    '{"version":2,"generation":"1","page":0,"apps":[],"next":null}',
  );
  const upstream = createServer((req, res) => {
    seen = { url: req.url, headers: req.headers };
    res.writeHead(200, {
      "content-type": "application/json",
      "ic-certificate": "local-fixture",
      "ic-certificateexpression": "fixture",
      "set-cookie": "must-not-forward=1",
    });
    res.end(body);
  });
  const port = await listen(upstream);
  const proxy = createLocalRegistryServer({
    replica: `http://127.0.0.1:${port}`,
    canisterId: "aaaaa-aa",
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/apps-v2.json`, {
      headers: {
        authorization: "test-only-secret",
        cookie: "test-only-cookie",
        "tailscale-user-login": "test-only-identity",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.equal(seen.headers.host, `aaaaa-aa.localhost:${port}`);
    for (const name of ["authorization", "cookie", "tailscale-user-login"])
      assert.equal(seen.headers[name], undefined);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      (await fetch(`http://127.0.0.1:${proxyPort}/api/v2/status`)).status,
      404,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${proxyPort}/apps-v2.json`, {
          method: "POST",
        })
      ).status,
      405,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
test("invalid, redirected, uncertified and oversized upstream responses fail closed", async () => {
  for (const mode of [
    "redirect",
    "certificate",
    "mime",
    "json",
    "oversize",
    "not-found",
  ]) {
    const upstream = createServer((req, res) => {
      const headers = {
        "content-type": mode === "mime" ? "text/html" : "application/json",
        "ic-certificateexpression": "fixture",
      };
      if (mode !== "certificate") headers["ic-certificate"] = "fixture";
      if (mode === "redirect") headers.location = "https://other.test";
      res.writeHead(
        mode === "redirect" ? 302 : mode === "not-found" ? 404 : 200,
        headers,
      );
      res.end(
        mode === "oversize"
          ? "x".repeat(128 * 1024 + 1)
          : mode === "json"
            ? "{}"
            : '{"version":2}',
      );
    });
    const port = await listen(upstream);
    const proxy = createLocalRegistryServer({
      replica: `http://127.0.0.1:${port}`,
      canisterId: "aaaaa-aa",
    });
    const proxyPort = await listen(proxy);
    try {
      assert.equal(
        (await fetch(`http://127.0.0.1:${proxyPort}/apps-v2.json`)).status,
        mode === "not-found" ? 404 : 502,
      );
    } finally {
      await close(proxy);
      await close(upstream);
    }
  }
});
