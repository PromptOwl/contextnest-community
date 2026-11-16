/**
 * Is a newer release on npm? Checked at startup and every 12h (UPDATE_CHECK,
 * on by default), kept in memory, and shown to the server admin with the
 * command that updates THIS install. The server never updates itself.
 */
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { SERVICE_VERSION } from "../shared/version.js";

export const REGISTRY_URL = "https://registry.npmjs.org/@promptowl/contextnest-community/latest";
const INTERVAL_MS = 12 * 60 * 60_000;

let latest: string | null = null;
let checkedAt: string | null = null;

/** Numeric x.y.z comparison; a pre-release or odd tag never counts as newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** One registry read. Failure keeps the last answer: an offline server just shows no update. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const { version } = (await res.json()) as { version?: string };
    if (typeof version === "string") {
      latest = version;
      checkedAt = new Date().toISOString();
    }
  } catch {
    // offline, proxy-blocked or air-gapped: nothing to report
  }
}

export function startUpdateCheck(): void {
  if (!config.UPDATE_CHECK) return;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), INTERVAL_MS).unref();
}

/** Containers update by pulling a new image; everything else runs from npm. */
function installKind(): "container" | "npm" {
  return existsSync("/.dockerenv") || !!process.env.KUBERNETES_SERVICE_HOST ? "container" : "npm";
}

export function updateStatus() {
  const install = installKind();
  const target = latest ?? "latest";
  return {
    enabled: config.UPDATE_CHECK,
    current: SERVICE_VERSION,
    latest,
    update_available: !!latest && isNewer(latest, SERVICE_VERSION),
    checked_at: checkedAt,
    install,
    command:
      install === "container"
        ? `docker pull ghcr.io/promptowl/contextnest-community:${target}`
        : `npx @promptowl/contextnest-community@${target}`,
  };
}
