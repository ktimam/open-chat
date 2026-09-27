import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { createUnofficialLocalEnvironment, parseUnofficialLocalPort, UNOFFICIAL_LOCAL_CANISTERS } from "./unofficialLocalProfile.mjs";
import { parseUnofficialLocalArgs, unofficialLocalLaunchPlan } from "../scripts/start-unofficial-local.mjs";
import { transformersWebGpuFeatureEnabled, transformersWebGpuProductionAssetsEnabled } from "./app/transformersWebGpuFeatureFlag.mjs";

const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: `public-${name.replaceAll("_", "-")}-cai`, local: "wrong-local-cai" }]));

test("pins all configured OpenChat canisters to checked-in .ic regardless of inherited overrides", () => {
    const inherited = { PATH: "system-path", OC_IDENTITY_CANISTER: "wrong-cai", oc_user_index_canister: "wrong-case-cai", OC_DFX_NETWORK: "local", OC_WEBAUTHN_ORIGIN: "oc.app", OC_IC_URL: "http://attacker", OC_II_DERIVATION_ORIGIN: "https://oc.app", OC_UNKNOWN_FLAG: "old", VITE_SECRET: "old", NODE_OPTIONS: "--require arbitrary.cjs" };
    const env = createUnofficialLocalEnvironment(canisters, { inherited });
    for (const [key, name] of Object.entries(UNOFFICIAL_LOCAL_CANISTERS)) assert.equal(env[key], canisters[name].ic);
    assert.equal(env.PATH, "system-path"); assert.equal(env.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(env.OC_DFX_NETWORK, "ic"); assert.equal(env.OC_IC_URL, "https://icp-api.io");
    assert.equal(env.OC_WEBAUTHN_ORIGIN, "localhost"); assert.equal(env.OC_BASE_ORIGIN, "http://localhost:5190");
    assert.equal(env.OC_II_DERIVATION_ORIGIN, env.OC_BASE_ORIGIN);
    assert.equal(env.OC_OTA_UPDATES, "none"); assert.equal(env.OC_APP_TYPE, "web");
    assert.equal(env.OC_ACCOUNT_LINKING_CODES_ENABLED, "true"); assert.equal(env.OC_MOBILE_LAYOUT, "v2");
    assert.equal(env.OC_ONESEC_FORWARDER_CANISTER, ""); assert.equal(env.OC_ONESEC_MINTER_CANISTER, "");
    assert.equal(env.NODE_OPTIONS, ""); assert.equal(env.oc_user_index_canister, undefined);
    assert.equal(env.VITE_SECRET, undefined); assert.equal(env.OC_UNKNOWN_FLAG, undefined);
    assert.equal(inherited.OC_IDENTITY_CANISTER, "wrong-cai"); assert.equal(Object.isFrozen(env), true);
});

test("fails closed for missing/malformed production canisters rather than reusing local values", () => {
    for (const value of [undefined, {}, { ic: "" }, { ic: "http://attacker" }, { local: "other-cai" }]) {
        assert.throws(() => createUnofficialLocalEnvironment({ ...canisters, identity: value }));
    }
});

test("drops inherited secrets and disables telemetry/custom-backend flags", () => {
    const inherited = { OC_ROLLBAR_ACCESS_TOKEN: "secret", OC_USERGEEK_APIKEY: "secret", OC_NCA_REPORTER_URL: "https://attacker", OC_LOCAL_AI_APP_CUSTOM: "true" };
    const env = createUnofficialLocalEnvironment(canisters, { inherited });
    for (const key of ["OC_ROLLBAR_ACCESS_TOKEN", "OC_USERGEEK_APIKEY", "OC_METERED_APIKEY", "OC_KLIPY_APIKEY", "OC_ALCHEMY_API_KEY", "OC_WALLET_CONNECT_PROJECT_ID", "OC_VAPID_PUBLIC_KEY", "OC_NCA_REPORTER_URL", "OC_LOCAL_AI_APP_CARDS_ENABLED", "OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED", "OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED", "OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED"]) assert.equal(env[key], "");
    assert.equal(env.OC_LOCAL_AI_APP_CUSTOM, undefined);
    for (const key of ["OC_NFID_URL", "OC_VIDEO_BRIDGE_URL", "OC_PREVIEW_PROXY_URL", "OC_TRANSLATE_PROXY_URL", "OC_DEV_ALLOWED_HOST"]) assert.equal(env[key], "");
    assert.equal(JSON.stringify(env).includes("secret"), false);
});

test("accepts only explicit bounded ports and known layouts", () => {
    assert.equal(parseUnofficialLocalPort(), 5190);
    for (const value of [1024, "5191", 65535]) assert.equal(parseUnofficialLocalPort(value), Number(value));
    for (const value of [0, 80, 65536, NaN, Infinity, "0", "5190 --host 0.0.0.0", "05190", "5190.0", " 5190", null]) assert.throws(() => parseUnofficialLocalPort(value));
    assert.throws(() => createUnofficialLocalEnvironment(canisters, { layout: "other" }));
});

test("strict CLI supports v1/v2 without a public host or shell escape", () => {
    assert.deepEqual(parseUnofficialLocalArgs([]), { port: 5190, layout: "v2", help: false });
    assert.deepEqual(parseUnofficialLocalArgs(["--layout", "v1", "--port", "5192"]), { port: 5192, layout: "v1", help: false });
    for (const args of [["--host", "0.0.0.0"], ["--port"], ["--layout"], ["--layout", "v3"], ["--port", "5190", "--port", "5191"], ["--port=5190"]]) assert.throws(() => parseUnofficialLocalArgs(args));
    const plan = unofficialLocalLaunchPlan(process.cwd(), canisters, { port: 5192, layout: "v1" });
    assert.equal(plan.command, process.execPath); assert.equal(plan.options.shell, false);
    assert.equal(plan.options.windowsHide, true); assert.equal(plan.options.stdio, "inherit");
    assert.deepEqual(plan.args.slice(1), ["--host", "127.0.0.1", "--port", "5192", "--strictPort"]);
    assert.equal(plan.url, "http://localhost:5192"); assert.equal(plan.options.env.OC_MOBILE_LAYOUT, "v1");
});

test("only explicit unofficial development/ic plus immutable distribution enables local GPU", () => {
    const env = createUnofficialLocalEnvironment(canisters);
    assert.equal(transformersWebGpuFeatureEnabled(env), true);
    assert.equal(transformersWebGpuProductionAssetsEnabled(env), false);
    for (const change of [{ OC_UNOFFICIAL_CLIENT: undefined }, { OC_UNOFFICIAL_CLIENT: "TRUE" }, { OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: undefined }, { OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "hf-proxy" }, { OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "false" }, { OC_BUILD_ENV: "test" }]) assert.equal(transformersWebGpuFeatureEnabled({ ...env, ...change }), false);
    assert.equal(transformersWebGpuFeatureEnabled({ OC_BUILD_ENV: "development", OC_DFX_NETWORK: "ic", OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true" }), false);
    assert.equal(transformersWebGpuFeatureEnabled({ ...env, OC_BUILD_ENV: "production", OC_UNOFFICIAL_CLIENT: undefined }), true);
});
