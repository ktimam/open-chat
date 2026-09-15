export type DevHmrConfig = {
    protocol: "ws" | "wss";
    port: number;
    clientPort: number;
    host?: string;
};

/**
 * Keep direct HTTP development on the Vite listener while routing HMR through the same HTTPS
 * hostname as mobile QC. The reverse proxy terminates TLS on 443 and forwards the WebSocket to
 * Vite's ordinary listener, so the browser must use WSS even though Vite itself remains HTTP.
 */
export function resolveDevHmrConfig(
    port: number,
    externalHttpsHost: string | undefined,
): DevHmrConfig {
    return externalHttpsHost
        ? {
              protocol: "wss",
              host: externalHttpsHost,
              port,
              clientPort: 443,
          }
        : {
              protocol: "ws",
              port,
              clientPort: port,
          };
}
