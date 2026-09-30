import { URL } from "node:url";

/** Explicit local prototype configuration. Does not read env files, credentials, or the network. */
export const UNOFFICIAL_LOCAL_DEFAULT_PORT = 5190;
export const UNOFFICIAL_LOCAL_CANISTERS = Object.freeze({
    OC_TRANSLATIONS_CANISTER: "translations",
    OC_USER_INDEX_CANISTER: "user_index",
    OC_GROUP_INDEX_CANISTER: "group_index",
    OC_NOTIFICATIONS_CANISTER: "notifications_index",
    OC_IDENTITY_CANISTER: "identity",
    OC_ONLINE_CANISTER: "online_users",
    OC_DAILY_PUZZLE_CANISTER: "daily_puzzle",
    OC_PROPOSALS_BOT_CANISTER: "proposals_bot",
    OC_AIRDROP_BOT_CANISTER: "airdrop_bot",
    OC_STORAGE_INDEX_CANISTER: "storage_index",
    OC_REGISTRY_CANISTER: "registry",
    OC_MARKET_MAKER_CANISTER: "market_maker",
    OC_SIGN_IN_WITH_EMAIL_CANISTER: "sign_in_with_email",
    OC_SIGN_IN_WITH_ETHEREUM_CANISTER: "sign_in_with_ethereum",
    OC_SIGN_IN_WITH_SOLANA_CANISTER: "sign_in_with_solana",
});

export function parseUnofficialLocalPort(value = UNOFFICIAL_LOCAL_DEFAULT_PORT) {
    if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^[1-9][0-9]{3,4}$/.test(value))
    ) {
        throw new Error("Local port must be an integer between 1024 and 65535");
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("Local port must be an integer between 1024 and 65535");
    }
    return port;
}

/** Operator-selected public directory, never an inherited environment override. */
export function parseAppDirectoryUrl(value = "") {
    if (value === "") return value;
    if (typeof value !== "string" || value.length > 2048 || value.trim() !== value)
        throw new Error("Invalid public app directory URL");
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
    )
        throw new Error("App directory requires HTTPS or explicit loopback HTTP");
    return url.href;
}

/** No inherited OC_* value may retarget this profile, including differently cased Windows keys. */
export function createUnofficialLocalEnvironment(canisters, options = {}) {
    const {
        port: suppliedPort = UNOFFICIAL_LOCAL_DEFAULT_PORT,
        layout = "v2",
        inherited = {},
        appDirectoryUrl = "",
    } = options;
    const port = parseUnofficialLocalPort(suppliedPort);
    if (layout !== "v1" && layout !== "v2") throw new Error("Local layout must be v1 or v2");
    const origin = `http://localhost:${port}`;
    const env = {};
    for (const [key, value] of Object.entries(inherited)) {
        if (!/^(OC_|NODE_OPTIONS$|NODE_ENV$|VITE_)/i.test(key) && typeof value === "string")
            env[key] = value;
    }
    for (const [variable, name] of Object.entries(UNOFFICIAL_LOCAL_CANISTERS)) {
        const id = canisters?.[name]?.ic;
        // Upstream retired AirdropBot. An absent production ID disables it explicitly;
        // neither a local ID nor an inherited environment value may replace it.
        if (name === "airdrop_bot" && (id === undefined || id === "")) {
            env[variable] = "";
            continue;
        }
        if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(id)) {
            throw new Error(`Missing checked-in production canister: ${name}.ic`);
        }
        env[variable] = id;
    }
    return Object.freeze({
        ...env,
        NODE_ENV: "development",
        NODE_OPTIONS: "",
        OC_NODE_ENV: "development",
        OC_DFX_NETWORK: "ic",
        OC_BUILD_ENV: "development",
        OC_UNOFFICIAL_CLIENT: "true",
        OC_APP_DIRECTORY_URL: parseAppDirectoryUrl(appDirectoryUrl),
        OC_DEV_PORT: String(port),
        OC_DEV_ALLOWED_HOST: "",
        OC_MOBILE_LAYOUT: layout,
        OC_APP_TYPE: "web",
        OC_APP_STORE: "",
        OC_OTA_UPDATES: "none",
        OC_ACCOUNT_LINKING_CODES_ENABLED: "true",
        OC_WEBAUTHN_ORIGIN: "localhost",
        OC_II_DERIVATION_ORIGIN: origin,
        OC_BASE_ORIGIN: origin,
        OC_IC_URL: "https://icp-api.io",
        OC_BLOB_URL_PATTERN: "https://{canisterId}.raw.icp0.io/{blobType}",
        OC_CANISTER_URL_PATH: "https://{canisterId}.raw.icp0.io",
        // Internet Identity is the public service; unsupported wallet integrations stay disabled.
        OC_INTERNET_IDENTITY_CANISTER_ID: "rdmx6-jaaaa-aaaaa-aaadq-cai",
        OC_ONESEC_FORWARDER_CANISTER: "",
        OC_ONESEC_MINTER_CANISTER: "",
        OC_INTERNET_IDENTITY_URL: "https://id.ai/?feature_flag_guided_upgrade=true",
        OC_NFID_URL: "",
        OC_VIDEO_BRIDGE_URL: "",
        OC_PREVIEW_PROXY_URL: "",
        OC_TRANSLATE_PROXY_URL: "",
        OC_BITCOIN_MAINNET_ENABLED: "true",
        OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "true",
        OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY: "immutable-hub-v1",
        OC_ROLLBAR_ACCESS_TOKEN: "",
        OC_USERGEEK_APIKEY: "",
        OC_METERED_APIKEY: "",
        OC_KLIPY_APIKEY: "",
        OC_TENOR_APIKEY: "",
        OC_ALCHEMY_API_KEY: "",
        OC_WALLET_CONNECT_PROJECT_ID: "",
        OC_VAPID_PUBLIC_KEY: "",
        OC_NCA_REPORTER_URL: "",
        OC_ANDROID_LINK_PACKAGE: "",
        OC_ANDROID_LINK_CERT_SHA256: "",
        OC_ANDROID_RP_ID: "",
        OC_LOCAL_AI_APP_CARDS_ENABLED: "",
        OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED: "",
        OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED: "",
        OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED: "",
    });
}
