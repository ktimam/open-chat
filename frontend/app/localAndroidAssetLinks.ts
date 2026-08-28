import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

export const LOCAL_ANDROID_ASSET_LINKS_PATH = "/.well-known/assetlinks.json";

export type LocalAndroidAssetLinksConfig = {
    packageName: string;
    certificateSha256: string;
};

function normalizeCertificateSha256(value: string): string | undefined {
    const compact = value.trim().replaceAll(":", "").toUpperCase();
    if (!/^[A-F0-9]{64}$/.test(compact)) return undefined;
    return compact.match(/.{2}/g)?.join(":");
}

export function resolveLocalAndroidAssetLinksConfig(
    env: Record<string, string | undefined>,
): LocalAndroidAssetLinksConfig | undefined {
    const rawPackage = env.OC_ANDROID_LINK_PACKAGE?.trim();
    const rawCertificate = env.OC_ANDROID_LINK_CERT_SHA256?.trim();
    if (!rawPackage && !rawCertificate) return undefined;
    if (!rawPackage || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(rawPackage)) {
        throw new Error("OC_ANDROID_LINK_PACKAGE must be a valid Android package name");
    }
    if (!rawCertificate) {
        throw new Error("OC_ANDROID_LINK_CERT_SHA256 is required with OC_ANDROID_LINK_PACKAGE");
    }
    const certificateSha256 = normalizeCertificateSha256(rawCertificate);
    if (certificateSha256 === undefined) {
        throw new Error("OC_ANDROID_LINK_CERT_SHA256 must be one SHA-256 certificate fingerprint");
    }
    return { packageName: rawPackage, certificateSha256 };
}

export function localAndroidAssetLinksDocument(config: LocalAndroidAssetLinksConfig): string {
    return JSON.stringify([
        {
            relation: [
                "delegate_permission/common.get_login_creds",
                "delegate_permission/common.handle_all_urls",
            ],
            target: {
                namespace: "android_app",
                package_name: config.packageName,
                sha256_cert_fingerprints: [config.certificateSha256],
            },
        },
    ]);
}

export function localAndroidAssetLinksPlugin(
    enabled: boolean,
    config: LocalAndroidAssetLinksConfig | undefined,
): Plugin {
    return {
        name: "local-android-asset-links",
        configureServer(server) {
            if (!enabled) return;
            server.middlewares.use(
                LOCAL_ANDROID_ASSET_LINKS_PATH,
                (request: IncomingMessage, response) => {
                    if (request.method !== "GET" && request.method !== "HEAD") {
                        response.statusCode = 405;
                        response.setHeader("Allow", "GET, HEAD");
                        response.end();
                        return;
                    }
                    if (config === undefined) {
                        response.statusCode = 404;
                        response.end();
                        return;
                    }
                    const body = localAndroidAssetLinksDocument(config);
                    response.statusCode = 200;
                    response.setHeader("Content-Type", "application/json; charset=utf-8");
                    response.setHeader("Cache-Control", "no-store");
                    response.setHeader("Content-Length", Buffer.byteLength(body).toString());
                    response.end(request.method === "HEAD" ? undefined : body);
                },
            );
        },
    };
}
