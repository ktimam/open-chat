// Local development adapter only. Production clients use the certified canister URL.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

const LIMIT = 128 * 1024;
export function allowedPath(value) {
  if (value === "/apps-v2.json") return true;
  const match = /^\/pages\/(0|[1-9][0-9]{0,19})\/([1-9]|1[0-5])\.json$/.exec(
    value,
  );
  return !!match && BigInt(match[1]) <= 18446744073709551615n;
}
export function validateConfiguration(replica, canisterId) {
  const url = new URL(replica);
  assert.equal(url.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(
    url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password,
  );
  assert.match(canisterId, /^[a-z0-9]+(?:-[a-z0-9]+)+$/);
  assert.ok(canisterId.length <= 63);
  return {
    hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: url.port,
    host: `${canisterId}.localhost:${url.port}`,
  };
}
export function createLocalRegistryServer({ replica, canisterId }) {
  const upstream = validateConfiguration(replica, canisterId);
  let active = 0;
  return createServer(
    { maxHeaderSize: 16384, requestTimeout: 20000, headersTimeout: 10000 },
    (incoming, outgoing) => {
      const end = (status, body = Buffer.alloc(0), headers = {}) => {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        outgoing.writeHead(status, {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
          "content-length": body.length,
          ...headers,
        });
        outgoing.end(body);
      };
      if (incoming.method !== "GET") {
        end(405);
        return;
      }
      if (!allowedPath(incoming.url ?? "")) {
        end(404);
        return;
      }
      if (active >= 8) {
        end(503);
        return;
      }
      active++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let complete = false;
      const finish = () => {
        if (!complete) {
          complete = true;
          active--;
          clearTimeout(timeout);
        }
      };
      outgoing.on("close", () => controller.abort());
      const req = request(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: incoming.url,
          method: "GET",
          headers: { Host: upstream.host, Accept: "application/json" },
          maxHeaderSize: 16384,
          signal: controller.signal,
        },
        async (response) => {
          try {
            if (
              response.statusCode !== 200 ||
              response.headers.location ||
              !/^application\/json(?:\s*;|$)/i.test(
                response.headers["content-type"] ?? "",
              ) ||
              typeof response.headers["ic-certificate"] !== "string" ||
              typeof response.headers["ic-certificateexpression"] !== "string"
            ) {
              response.destroy();
              end(response.statusCode === 404 ? 404 : 502);
              return;
            }
            const parts = [];
            let size = 0;
            for await (const part of response) {
              size += part.length;
              if (size > LIMIT) throw new Error("Registry page too large");
              parts.push(part);
            }
            const body = Buffer.concat(parts);
            const json = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(body),
            );
            assert.equal(json.version, 2);
            end(200, body, {
              "content-type": response.headers["content-type"],
              "ic-certificate": response.headers["ic-certificate"],
              "ic-certificateexpression":
                response.headers["ic-certificateexpression"],
            });
          } catch {
            response.destroy();
            end(502);
          } finally {
            finish();
          }
        },
      );
      req.on("error", () => {
        end(502);
        finish();
      });
      req.end();
    },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [replica, canisterId, portText, ...rest] = process.argv.slice(2);
  assert.equal(rest.length, 0);
  assert.match(portText ?? "", /^[1-9][0-9]{0,4}$/);
  const port = Number(portText);
  assert.ok(port >= 1024 && port <= 65535);
  const server = createLocalRegistryServer({ replica, canisterId });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      JSON.stringify({
        localOnly: true,
        directory: `http://localhost:${port}/apps-v2.json`,
        canisterId,
        certificateCryptographicallyVerifiedByProxy: false,
      }),
    ),
  );
}
