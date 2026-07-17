/**
 * GitHub markdown sync (CU-wdqcpzwf2w) — scheduled, admin-configurable pull
 * of markdown files from GitHub repositories into nests.
 *
 * Community-edition connector: everything here rides the NORMAL node service
 * path (createNode/updateNode), so synced docs get real versioning, diffs and
 * governance like any human edit — no engine logic is forked (CLAUDE.md
 * Engine Logic Boundary).
 *
 * Two modes per source:
 *  - "all-markdown" (default): one `git/trees/{ref}?recursive=1` call per
 *    sweep lists every blob; we mirror every `.md` under the optional `path`
 *    prefix into the target nest/folder, preserving the repo's directory
 *    structure (docs/setup.md → nodes/<folder>/docs/setup). The stored root
 *    tree sha + HTTP ETag short-circuit unchanged repos (304 / sha match),
 *    and the per-file blob-sha map means only changed blobs are refetched.
 *  - "single-file": the original README flow — one contents call with
 *    If-None-Match on the stored ETag; 304 skips.
 *
 * Conflict rule (per file): if the node's latest version author is NOT
 * system:github-sync, someone edited it locally since the last sync — we do
 * NOT overwrite. The file is skipped, the source reports "local-edits", and
 * the local content keeps serving. Because the source's etag/head sha only
 * advance on a clean sweep, the conflict is re-surfaced every sweep until
 * resolved (edit the doc back, or delete it to let sync recreate it).
 *
 * Deletions never propagate: a file removed upstream leaves its node in
 * place (reported in the detail line), so sync can never destroy content.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { insertOrReplace } from "../db/sql.js";
import { createNode, updateNode } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";
import { getNest } from "../nests/service.js";
import {
  getLatestVersionMeta,
  hashContent,
} from "../governance/version-service.js";

/** Version-row author for every write this connector makes. The authorship
 *  code excludes `system:%` authors from collaborator chips, and the
 *  conflict rule above keys on this exact string. */
export const GITHUB_SYNC_AUTHOR = "system:github-sync";

export type GithubSyncMode = "all-markdown" | "single-file";

export interface GithubSyncSource {
  /** "owner/name" */
  repo: string;
  /** Branch/ref to sync from. Empty → the repo's default branch (HEAD). */
  branch?: string;
  /** Default "all-markdown". */
  mode?: GithubSyncMode;
  /** all-markdown: optional subdirectory prefix to restrict the mirror to.
   *  single-file: the file to sync (default "README.md"). */
  path?: string;
  /** Target nest. */
  nestId: string;
  /** Folder inside the nest to mirror under. Default "" (nest root). */
  folder?: string;
}

export interface SourceRunResult {
  repo: string;
  nestId: string;
  status: "synced" | "unchanged" | "local-edits" | "error";
  detail: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Validate + normalize one raw sources entry (from the admin PATCH or env).
 * Returns { error } with a human message, or the normalized source.
 * Nest EXISTENCE is checked by the caller (needs the DB; app.ts does it on
 * save, the sweep re-checks at run time in case the nest was deleted since).
 */
export function normalizeGithubSyncSource(
  raw: unknown,
  index: number,
): { error: string } | { source: GithubSyncSource } {
  const at = `source ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { error: `${at}: each source must be an object` };
  const o = raw as Record<string, unknown>;
  const repo = typeof o.repo === "string" ? o.repo.trim() : "";
  if (!REPO_RE.test(repo))
    return { error: `${at}: repo must look like "owner/name"` };
  const nestId = typeof o.nestId === "string" ? o.nestId.trim() : "";
  if (!nestId) return { error: `${at}: nestId is required` };
  const mode = o.mode === undefined || o.mode === "" ? "all-markdown" : o.mode;
  if (mode !== "all-markdown" && mode !== "single-file")
    return { error: `${at}: mode must be "all-markdown" or "single-file"` };
  for (const k of ["branch", "path", "folder"] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string")
      return { error: `${at}: ${k} must be a string` };
  }
  const path = ((o.path as string) || "").trim().replace(/^\/+|\/+$/g, "");
  if (path.includes("..")) return { error: `${at}: path must not contain ".."` };
  const source: GithubSyncSource = {
    repo,
    nestId,
    mode,
    branch: ((o.branch as string) || "").trim(),
    path: mode === "single-file" && !path ? "README.md" : path,
    folder: ((o.folder as string) || "").trim().replace(/^\/+|\/+$/g, ""),
  };
  return { source };
}

/** Configured sources from env/persisted settings. Lenient: entries that
 *  fail shape validation are dropped (with a warn) rather than killing the
 *  whole sweep — the admin PATCH path is the strict gate. */
export function getGithubSyncSources(): GithubSyncSource[] {
  const raw = (process.env.GITHUB_SYNC_SOURCES || "").trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[github-sync] GITHUB_SYNC_SOURCES is not valid JSON — ignoring");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GithubSyncSource[] = [];
  parsed.forEach((entry, i) => {
    const r = normalizeGithubSyncSource(entry, i);
    if ("error" in r) console.warn(`[github-sync] dropping invalid ${r.error}`);
    else out.push(r.source);
  });
  return out;
}

/** Stable identity for a source's state row. */
export function sourceKey(s: GithubSyncSource): string {
  return [
    s.repo,
    s.branch || "",
    s.mode || "all-markdown",
    s.path || "",
    s.nestId,
    s.folder || "",
  ].join("|");
}

// ─── State rows ──────────────────────────────────────────────────────────

interface SyncState {
  etag: string | null;
  head_sha: string | null;
  files_json: string | null;
  last_status: string | null;
  last_detail: string | null;
  last_run_at: string | null;
}

async function loadState(key: string): Promise<SyncState | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT etag, head_sha, files_json, last_status, last_detail, last_run_at FROM github_sync_state WHERE source_key = ?",
    [key],
  )) as SyncState | undefined;
  return row ?? null;
}

async function saveState(
  key: string,
  patch: {
    etag?: string | null;
    headSha?: string | null;
    files?: Record<string, string> | null;
    status: string;
    detail: string;
  },
): Promise<void> {
  const db = getDb();
  const prev = await loadState(key);
  const etag = patch.etag !== undefined ? patch.etag : (prev?.etag ?? null);
  const headSha =
    patch.headSha !== undefined ? patch.headSha : (prev?.head_sha ?? null);
  const filesJson =
    patch.files !== undefined
      ? patch.files === null
        ? null
        : JSON.stringify(patch.files)
      : (prev?.files_json ?? null);
  const now = new Date().toISOString();
  await db.run(
    insertOrReplace(
      db,
      `INSERT INTO github_sync_state (source_key, etag, head_sha, files_json, last_status, last_detail, last_run_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["source_key"],
      `etag = excluded.etag, head_sha = excluded.head_sha, files_json = excluded.files_json,
       last_status = excluded.last_status, last_detail = excluded.last_detail,
       last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
    ),
    [key, etag, headSha, filesJson, patch.status, patch.detail, now, now],
  );
}

function parseFiles(state: SyncState | null): Record<string, string> {
  if (!state?.files_json) return {};
  try {
    const v = JSON.parse(state.files_json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ─── GitHub fetch helpers ────────────────────────────────────────────────

function ghHeaders(token: string, etag?: string | null, accept?: string) {
  const headers: Record<string, string> = {
    Accept: accept || "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "contextnest-community-github-sync",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

const encodePath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");

/** Raw file content via the contents API. Throws on non-2xx. */
async function fetchRawFile(
  source: GithubSyncSource,
  filePath: string,
  token: string,
): Promise<string> {
  const ref = source.branch
    ? `?ref=${encodeURIComponent(source.branch)}`
    : "";
  const url = `https://api.github.com/repos/${source.repo}/contents/${encodePath(filePath)}${ref}`;
  const res = await fetch(url, {
    headers: ghHeaders(token, undefined, "application/vnd.github.raw+json"),
  });
  if (!res.ok)
    throw new Error(`GitHub returned HTTP ${res.status} for ${source.repo}:${filePath}`);
  return res.text();
}

// ─── Path → node mapping ─────────────────────────────────────────────────

/** Same slug rules as nodes/service.ts — lowercased, non-alphanumeric runs
 *  collapse to "-", so traversal characters can never survive into an id. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** nodes/<folder…>/<repo dirs…>/<file stem>, every segment slugified. */
export function nodeIdForFile(folder: string | undefined, filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  const name = parts.pop() || "file";
  const stem = name.replace(/\.md$/i, "");
  const segs = [
    ...(folder || "").split("/").map(slugify).filter(Boolean),
    ...parts.map(slugify).filter(Boolean),
    slugify(stem) || "file",
  ];
  return `nodes/${segs.join("/")}`;
}

/** Title from the first `# ` heading, else the filename stem. */
function titleFor(content: string, filePath: string): string {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  if (m && m[1].trim()) return m[1].trim();
  const name = filePath.split("/").pop() || filePath;
  return name.replace(/\.md$/i, "");
}

// ─── Per-file upsert (shared by both modes) ──────────────────────────────

type FileOutcome = "synced" | "unchanged" | "local-edits";

/**
 * Write one file's content into its node via the normal service path.
 * Applies the conflict rule: last version authored by anyone other than the
 * connector → "local-edits", content untouched.
 */
async function upsertFileNode(
  source: GithubSyncSource,
  filePath: string,
  content: string,
  shortSha: string,
): Promise<FileOutcome> {
  const nodeId = nodeIdForFile(source.folder, filePath);
  const latest = await getLatestVersionMeta(source.nestId, nodeId);
  if (latest && latest.author !== GITHUB_SYNC_AUTHOR) return "local-edits";
  if (latest) {
    if (latest.contentHash === hashContent(content)) return "unchanged";
    // The stored hash is of the PUBLISHED body, which the engine may have
    // whitespace-normalized relative to the raw upstream bytes — so when the
    // hash misses, compare the live body too (modulo trailing whitespace)
    // before minting a version. Keeps a lost/pruned blob-sha map (e.g. a
    // reconfigured source) from churning a no-op version per file.
    try {
      const { storage } = await engineCache.get(source.nestId);
      const current = await storage.readDocument(nodeId);
      if ((current.body || "").trimEnd() === content.trimEnd())
        return "unchanged";
    } catch {
      // Node row exists but the doc is unreadable — fall through to rewrite.
    }
  }
  const changeNote = `Synced from github.com/${source.repo}@${shortSha}`;
  if (latest) {
    await updateNode(
      source.nestId,
      nodeId,
      { content, title: titleFor(content, filePath), changeNote },
      GITHUB_SYNC_AUTHOR,
    );
  } else {
    await createNode(
      source.nestId,
      { id: nodeId, title: titleFor(content, filePath), content, changeNote },
      GITHUB_SYNC_AUTHOR,
    );
  }
  return "synced";
}

// ─── Sweep ───────────────────────────────────────────────────────────────

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

function summarize(parts: Array<[number, string]>): string {
  const bits = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return bits.length ? bits.join(", ") : "no markdown files matched";
}

async function syncAllMarkdown(
  source: GithubSyncSource,
  token: string,
  key: string,
  state: SyncState | null,
): Promise<SourceRunResult> {
  const base = { repo: source.repo, nestId: source.nestId };
  const ref = encodeURIComponent(source.branch || "HEAD");
  const url = `https://api.github.com/repos/${source.repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, {
    headers: ghHeaders(token, state?.etag, "application/vnd.github+json"),
  });
  if (res.status === 304) {
    const detail = "upstream unchanged (304)";
    await saveState(key, { status: "unchanged", detail });
    return { ...base, status: "unchanged", detail };
  }
  if (!res.ok) {
    const detail = `GitHub returned HTTP ${res.status} listing the ${source.branch || "default"} branch tree`;
    await saveState(key, { status: "error", detail });
    return { ...base, status: "error", detail };
  }
  const etag = res.headers.get("etag");
  const body = (await res.json()) as {
    sha?: string;
    truncated?: boolean;
    tree?: TreeEntry[];
  };
  const headSha = String(body.sha || "");
  // Head-sha short-circuit — covers proxies that strip ETags. Only valid
  // when the sha was stored by a CLEAN sweep (local-edits/error sweeps
  // deliberately don't advance it, so conflicts keep re-surfacing).
  if (headSha && state?.head_sha === headSha) {
    const detail = "upstream unchanged (head sha match)";
    await saveState(key, { status: "unchanged", detail });
    return { ...base, status: "unchanged", detail };
  }
  const shortSha = headSha.slice(0, 7) || "unknown";

  const prefix = source.path || "";
  let files = (body.tree || []).filter(
    (e) =>
      e.type === "blob" &&
      /\.md$/i.test(e.path) &&
      (!prefix || e.path === prefix || e.path.startsWith(`${prefix}/`)),
  );
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const cap = config.GITHUB_SYNC_MAX_FILES;
  const truncated = !!body.truncated || files.length > cap;
  files = files.slice(0, cap);

  // Slugification is lossy (getting_started.md, getting-started.md and
  // Setup.MD all map to the same node id), so distinct repo files can
  // collide on one id. Resolve deterministically: the FIRST path in sorted
  // order owns the id; later paths are skipped and called out in the detail
  // line — never clobbered, and never renamed with invented suffixes (which
  // would churn ids across sweeps).
  const idOwner = new Map<string, string>(); // node id → owning repo path
  const collisions: string[] = [];
  const syncFiles: TreeEntry[] = [];
  for (const f of files) {
    const id = nodeIdForFile(source.folder, f.path);
    const owner = idOwner.get(id);
    if (owner !== undefined) {
      collisions.push(`id collision: ${f.path} skipped (conflicts with ${owner})`);
    } else {
      idOwner.set(id, f.path);
      syncFiles.push(f);
    }
  }

  const oldFiles = parseFiles(state);
  const newFiles: Record<string, string> = {};
  let synced = 0;
  let unchanged = 0;
  let localEdits = 0;
  let failed = 0;

  for (const f of syncFiles) {
    try {
      // Blob unchanged since a clean sweep → skip without fetching. (A
      // local edit on an upstream-unchanged file is normal local evolution,
      // not a conflict — there's nothing new to overwrite it with.)
      if (oldFiles[f.path] === f.sha) {
        unchanged++;
        newFiles[f.path] = f.sha;
        continue;
      }
      const content = await fetchRawFile(source, f.path, token);
      const outcome = await upsertFileNode(source, f.path, content, shortSha);
      if (outcome === "local-edits") {
        localEdits++;
        // Don't advance this file's sha — retried (and re-flagged) each sweep.
        if (oldFiles[f.path]) newFiles[f.path] = oldFiles[f.path];
      } else {
        if (outcome === "synced") synced++;
        else unchanged++;
        newFiles[f.path] = f.sha;
      }
    } catch (err) {
      failed++;
      console.error(`[github-sync] ${source.repo}:${f.path} failed:`, err);
    }
  }

  // Files that vanished upstream — reported, never deleted.
  const removed = truncated
    ? 0
    : Object.keys(oldFiles).filter((p) => !files.some((f) => f.path === p))
        .length;

  const detailParts: Array<[number, string]> = [
    [synced, "synced"],
    [unchanged, "unchanged"],
    [localEdits, localEdits === 1 ? "local edit kept" : "local edits kept"],
    [failed, "failed"],
  ];
  let detail = summarize(detailParts);
  if (removed > 0)
    detail += `; removed upstream (kept here): ${removed} file${removed === 1 ? "" : "s"}`;
  if (truncated) detail += `; truncated to ${cap} files`;
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 5);
    detail += `; ${shown.join("; ")}`;
    if (collisions.length > shown.length)
      detail += `; and ${collisions.length - shown.length} more collision(s)`;
  }

  const status: SourceRunResult["status"] =
    failed > 0 && synced === 0
      ? "error"
      : localEdits > 0
        ? "local-edits"
        : synced > 0
          ? "synced"
          : "unchanged";

  // Advance the change detectors only on a CLEAN sweep, so conflicted /
  // failed / collided files are retried instead of being 304'd away next
  // sweep — and so the collision warning keeps re-surfacing in the run
  // results instead of decaying into "unchanged (304)".
  const clean = localEdits === 0 && failed === 0 && collisions.length === 0;
  await saveState(key, {
    status,
    detail,
    files: newFiles,
    ...(clean ? { etag: etag ?? null, headSha: headSha || null } : {}),
  });
  return { ...base, status, detail };
}

async function syncSingleFile(
  source: GithubSyncSource,
  token: string,
  key: string,
  state: SyncState | null,
): Promise<SourceRunResult> {
  const base = { repo: source.repo, nestId: source.nestId };
  const filePath = source.path || "README.md";
  const ref = source.branch ? `?ref=${encodeURIComponent(source.branch)}` : "";
  const url = `https://api.github.com/repos/${source.repo}/contents/${encodePath(filePath)}${ref}`;
  const res = await fetch(url, { headers: ghHeaders(token, state?.etag) });
  if (res.status === 304) {
    const detail = "upstream unchanged (304)";
    await saveState(key, { status: "unchanged", detail });
    return { ...base, status: "unchanged", detail };
  }
  if (!res.ok) {
    const detail = `GitHub returned HTTP ${res.status} for ${filePath}`;
    await saveState(key, { status: "error", detail });
    return { ...base, status: "error", detail };
  }
  const etag = res.headers.get("etag");
  const content = await res.text();
  // The contents-API ETag wraps the blob sha — best available "version" id.
  const shortSha =
    (etag || "").replace(/^W\//, "").replace(/"/g, "").slice(0, 7) ||
    hashContent(content).slice(0, 7);
  const outcome = await upsertFileNode(source, filePath, content, shortSha);
  const detail =
    outcome === "synced"
      ? `synced ${filePath}@${shortSha}`
      : outcome === "unchanged"
        ? "content identical — no new version"
        : `local edits on ${nodeIdForFile(source.folder, filePath)} — not overwritten`;
  await saveState(key, {
    status: outcome,
    detail,
    files: { [filePath]: shortSha },
    // Same clean-sweep rule: a conflict must keep re-surfacing, so the etag
    // only advances when the upstream content actually landed (or matched).
    ...(outcome !== "local-edits" ? { etag: etag ?? null } : {}),
  });
  return { ...base, status: outcome, detail };
}

async function syncSource(
  source: GithubSyncSource,
  token: string,
): Promise<SourceRunResult> {
  const key = sourceKey(source);
  try {
    const nest = await getNest(source.nestId);
    if (!nest) {
      const detail = `target nest ${source.nestId} no longer exists`;
      await saveState(key, { status: "error", detail });
      return { repo: source.repo, nestId: source.nestId, status: "error", detail };
    }
    const state = await loadState(key);
    return source.mode === "single-file"
      ? await syncSingleFile(source, token, key, state)
      : await syncAllMarkdown(source, token, key, state);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[github-sync] sweep failed for ${source.repo}:`, err);
    try {
      await saveState(key, { status: "error", detail });
    } catch {}
    return { repo: source.repo, nestId: source.nestId, status: "error", detail };
  }
}

// Serialize sweeps: a manual "Sync now" during a scheduled sweep joins the
// in-flight run instead of racing it over the same nodes/state rows.
let inflight: Promise<SourceRunResult[]> | null = null;

/** Drop state rows whose source_key no longer matches any configured source
 *  (source removed, or a key field like branch/path/nest edited) — otherwise
 *  they accumulate forever as invisible orphans. */
async function pruneOrphanedState(liveKeys: string[]): Promise<void> {
  const db = getDb();
  if (liveKeys.length === 0) {
    await db.run("DELETE FROM github_sync_state", []);
    return;
  }
  const placeholders = liveKeys.map(() => "?").join(", ");
  await db.run(
    `DELETE FROM github_sync_state WHERE source_key NOT IN (${placeholders})`,
    liveKeys,
  );
}

/** Run one full sweep over every configured source. */
export function runGithubSync(): Promise<SourceRunResult[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    const sources = getGithubSyncSources();
    try {
      await pruneOrphanedState(sources.map(sourceKey));
    } catch (err) {
      console.error("[github-sync] state prune failed:", err);
    }
    const token = config.GITHUB_SYNC_TOKEN;
    const results: SourceRunResult[] = [];
    for (const source of sources) results.push(await syncSource(source, token));
    return results;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Last-run status per configured source, for GET /admin/github-sync/run
 *  and the Settings UI's per-source status line. */
export async function getGithubSyncStatus(): Promise<
  Array<
    GithubSyncSource & {
      lastStatus: string | null;
      lastDetail: string | null;
      lastRunAt: string | null;
    }
  >
> {
  const sources = getGithubSyncSources();
  const out = [];
  for (const s of sources) {
    const state = await loadState(sourceKey(s));
    out.push({
      ...s,
      lastStatus: state?.last_status ?? null,
      lastDetail: state?.last_detail ?? null,
      lastRunAt: state?.last_run_at ?? null,
    });
  }
  return out;
}

// ─── Scheduler (drift-scanner pattern: 0 disables, unref'd timer) ────────

let timer: NodeJS.Timeout | null = null;

export function startGithubSyncScanner(intervalMs: number): void {
  if (timer || intervalMs <= 0) return;
  timer = setInterval(() => {
    runGithubSync().catch((err) =>
      console.error("[github-sync] scheduled sweep failed:", err),
    );
  }, intervalMs);
  timer.unref?.();
}

export function stopGithubSyncScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Applied by the admin settings PATCH so an interval change (including
 *  enable/disable) takes effect live, without a server restart. */
export function restartGithubSyncScanner(intervalMs: number): void {
  stopGithubSyncScanner();
  startGithubSyncScanner(intervalMs);
}
