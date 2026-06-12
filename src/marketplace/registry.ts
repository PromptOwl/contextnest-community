/**
 * Central-registry client — lets THIS server browse and install packs from
 * another community server (typically the PromptOwl-hosted marketplace).
 * One codebase: the registry is just a community server with packs
 * published on it; these are plain HTTP calls to its public marketplace
 * surface, timeout-bounded and best-effort (a dead registry never breaks
 * the local marketplace).
 */
import type { PackMeta } from "./routes.js";

const REGISTRY_TIMEOUT_MS = 4000;

export interface RegistryPack {
  id: string;
  name: string;
  slug: string;
  summary: string;
  version: string;
  price_credits_install: number;
  price_credits_per_call: number;
  doc_count: number;
  published_at: string;
}

export interface RegistryFiles {
  pack: { id: string; name: string } & PackMeta;
  files: Array<{ path: string; content: string }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Approved packs listed on the registry; [] on any failure. */
export async function fetchRegistryPacks(
  registryUrl: string,
): Promise<RegistryPack[]> {
  try {
    const data = await fetchJson<{ packs: RegistryPack[] }>(
      `${registryUrl}/marketplace/packs`,
    );
    return Array.isArray(data.packs) ? data.packs : [];
  } catch {
    return [];
  }
}

/** A pack's importable files from the registry; null on any failure. */
export async function fetchRegistryPackFiles(
  registryUrl: string,
  packId: string,
): Promise<RegistryFiles | null> {
  try {
    const data = await fetchJson<RegistryFiles>(
      `${registryUrl}/marketplace/packs/${encodeURIComponent(packId)}/files`,
    );
    if (!Array.isArray(data.files) || !data.pack?.id) return null;
    // Defensive caps mirroring the import endpoint's expectations.
    if (data.files.length > 500) return null;
    for (const f of data.files) {
      if (
        typeof f.path !== "string" ||
        typeof f.content !== "string" ||
        f.path.includes("..") ||
        f.content.length > 512 * 1024
      ) {
        return null;
      }
    }
    return data;
  } catch {
    return null;
  }
}
