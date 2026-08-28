const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Validate and normalize the optional hostname forwarded by the local HTTPS development proxy. */
export function resolveDevAllowedHost(value) {
    if (value === undefined || value === "") return undefined;
    if (value !== value.trim() || value.length > 253) {
        throw new Error("OC_DEV_ALLOWED_HOST must be a hostname without spaces");
    }
    const labels = value.split(".");
    if (labels.some((label) => !DNS_LABEL.test(label))) {
        throw new Error("OC_DEV_ALLOWED_HOST must be a hostname without a scheme, port, or path");
    }
    return value.toLowerCase();
}

/** Never expose the development proxy hostname outside a local development build. */
export function resolveLocalDevAllowedHost(buildEnvironment, dfxNetwork, value) {
    return buildEnvironment === "development" && dfxNetwork === "local"
        ? resolveDevAllowedHost(value)
        : undefined;
}
