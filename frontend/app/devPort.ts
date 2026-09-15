const DEFAULT_DEV_PORT = 5001;
const MAX_TCP_PORT = 65_535;

export function resolveDevPort(configuredPort: string | undefined): number {
    const value = configuredPort ?? String(DEFAULT_DEV_PORT);
    if (!/^[1-9]\d*$/.test(value)) {
        throw new Error("OC_DEV_PORT must be a valid TCP port");
    }

    const port = Number(value);
    if (!Number.isSafeInteger(port) || port > MAX_TCP_PORT) {
        throw new Error("OC_DEV_PORT must be a valid TCP port");
    }
    return port;
}
