/**
 * Snapshot of the network env vars Node reads ONCE, at process start, taken
 * before config.ts loads `.env`. Node's env-proxy support and
 * NODE_EXTRA_CA_CERTS never see values that only arrive via `.env`, so the
 * startup checks compare this snapshot with the live env to say so.
 *
 * Import this first in the entrypoint; it must not import anything itself.
 */
const KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

export type BootEnvKey = (typeof KEYS)[number];

export const bootEnv: Readonly<Partial<Record<BootEnvKey, string>>> = Object.freeze(
  Object.fromEntries(KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!])),
);

export const bootExecArgv: readonly string[] = Object.freeze([...process.execArgv]);
