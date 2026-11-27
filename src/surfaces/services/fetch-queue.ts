/**
 * The explicit-ask fetch queue (PRD §4.3) — the ONLY history read in
 * Surfaces. A job is one `conversations.history` (latest=ts, inclusive,
 * limit=1) or `conversations.replies` call for an ask's target. One call per
 * method per install at a time (compare-and-set claim), Retry-After honoured,
 * and hosted non-Marketplace installs are held to 1/min per method. Fetched
 * text goes through the gate's G3–G5 and into the forced window's buffer.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { SurfaceRateLimited, type FetchedMessage } from "../contract.js";
import { gate } from "../core/gate.js";
import { getConnector } from "../registry.js";
import { slackErrorCode } from "../adapters/slack/api.js";
import { getBindingRow } from "./binding-service.js";
import { getInstall, installRef, type InstallRow } from "./install-store.js";
import { fillForcedWindow, getWindow, judgeInBackground } from "./window-service.js";
import { track } from "./work.js";

export const MAX_FETCH_ATTEMPTS = 3;
export const HOSTED_MIN_INTERVAL_MS = 60_000;
/** A fetch takes seconds: an older `running` job lost its worker to a restart. */
export const STUCK_FETCH_MS = 5 * 60_000;
const FETCH_FAILED_NOTE = "I couldn't read that message from Slack, so nothing was saved. Try again in a few minutes.";
// Says no reason: it must not reveal a guest or who opted out.
const NOTHING_FETCHED_NOTE = "I couldn't use that message, so nothing was saved.";
const iso = (ms: number) => new Date(ms).toISOString();

export async function enqueueFetch(input: { installId: string; method: string; params: Record<string, string>; windowId: string; requestedBy: string }): Promise<string> {
  const id = uuid();
  const now = iso(Date.now());
  await getDb().run(
    `INSERT INTO surface_fetch_queue (id, install_id, method, params, window_id, requested_by, status, not_before, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
    [id, input.installId, input.method, JSON.stringify(input.params), input.windowId, input.requestedBy, now, now, now],
  );
  track(runFetchQueue(Date.now()), "fetch");
  return id;
}

interface Job {
  id: string;
  install_id: string;
  method: string;
  params: string;
  window_id: string | null;
  attempts: number;
  not_before: string;
}

/** Run every due job (at most one per install+method concurrently). Returns jobs completed. */
export async function runFetchQueue(nowMs: number = Date.now()): Promise<number> {
  const db = getDb();
  // Left running by a restart: one attempt gone. Until then it blocks its method.
  const stuck = (await db.all("SELECT * FROM surface_fetch_queue WHERE status = 'running' AND updated_at <= ?", [iso(Date.now() - STUCK_FETCH_MS)])) as Job[];
  for (const job of stuck) await retryOrFail(job, nowMs, 0).catch((err) => console.error(`[surfaces] stuck fetch not recovered: ${err instanceof Error ? err.name : "error"}`));
  const due = (await db.all("SELECT * FROM surface_fetch_queue WHERE status = 'queued' AND not_before <= ? ORDER BY created_at", [iso(nowMs)])) as Job[];
  let done = 0;
  for (const job of due) {
    const running = await db.get("SELECT 1 AS x FROM surface_fetch_queue WHERE install_id = ? AND method = ? AND status = 'running'", [job.install_id, job.method]);
    if (running) continue;
    const install = await getInstall(job.install_id);
    if (!install || install.status !== "active") {
      await db.run("UPDATE surface_fetch_queue SET status = 'failed', updated_at = ? WHERE id = ?", [iso(nowMs), job.id]);
      continue;
    }
    if (install.mode === "hosted") {
      const last = (await db.get("SELECT MAX(updated_at) AS at FROM surface_fetch_queue WHERE install_id = ? AND method = ? AND status = 'done'", [
        job.install_id,
        job.method,
      ])) as { at: string | null };
      if (last?.at && nowMs - Date.parse(last.at) < HOSTED_MIN_INTERVAL_MS) continue;
    }
    const claim = await db.run("UPDATE surface_fetch_queue SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'", [iso(Date.now()), job.id]);
    if (claim.changes === 0) continue;
    try {
      const connector = getConnector(install.surface);
      if (!connector?.fetchMessages) throw new Error("no fetch");
      const params = JSON.parse(job.params) as Record<string, string>;
      const msgs = await connector.fetchMessages(installRef(install), job.method, params);
      // Delivered first: a restart in between fetches again, and deliver fills a window once.
      if (job.window_id) await deliver(install, job.window_id, msgs, params);
      await db.run("UPDATE surface_fetch_queue SET status = 'done', attempts = attempts + 1, updated_at = ? WHERE id = ?", [iso(nowMs), job.id]);
      done++;
    } catch (err) {
      console.warn(`[surfaces] fetch failed: method=${job.method} code=${slackErrorCode(err)} install=${job.install_id}`);
      if (err instanceof SurfaceRateLimited) {
        await db.run("UPDATE surface_fetch_queue SET status = 'queued', not_before = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [
          iso(nowMs + err.retryAfterSec * 1000),
          iso(nowMs),
          job.id,
        ]);
        continue;
      }
      await retryOrFail(job, nowMs, 30_000);
    }
  }
  return done;
}

/** One attempt gone: queued again, or failed for good and its window dropped. */
async function retryOrFail(job: Job, nowMs: number, delayMs: number): Promise<void> {
  const failed = job.attempts + 1 >= MAX_FETCH_ATTEMPTS;
  const r = await getDb().run("UPDATE surface_fetch_queue SET status = ?, not_before = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'running'", [
    failed ? "failed" : "queued",
    iso(nowMs + delayMs),
    iso(nowMs),
    job.id,
  ]);
  if (r.changes && failed && job.window_id) await dropWindow(job.window_id, "fetch_failed", FETCH_FAILED_NOTE);
}

/** Drop the waiting window and tell the person who asked, once. */
async function dropWindow(windowId: string, verdict: "fetch_failed" | "nothing_fetched", text: string): Promise<void> {
  const r = await getDb().run("UPDATE surface_windows SET status = 'discarded', close_reason = 'discarded', verdict = ? WHERE id = ? AND status = 'awaiting_fetch'", [verdict, windowId]);
  if (r.changes === 0) return;
  const w = await getWindow(windowId);
  const binding = w ? await getBindingRow(w.binding_id) : null;
  if (!w || !binding) return;
  const { noteRequester } = await import("./judge-service.js");
  await noteRequester(binding, w, text);
}

async function deliver(install: InstallRow, windowId: string, msgs: FetchedMessage[], params: Record<string, string>): Promise<void> {
  const w = await getWindow(windowId);
  if (!w) return;
  const binding = (await getDb().get("SELECT * FROM surface_bindings WHERE id = ?", [w.binding_id])) as
    | { id: string; install_id: string; nest_id: string; status: string; capture_ok: number }
    | undefined;
  if (!binding) return;
  const { authorStatus } = await import("./ingest-service.js");
  const kept: Array<{ id: string; author: string; ts: string; text: string; meaningful: number }> = [];
  const wanted = params.latest ? msgs.filter((m) => m.ts === params.latest) : msgs.slice(-21);
  for (const m of wanted) {
    const opted = !!(await getDb().get("SELECT 1 AS x FROM surface_optouts WHERE install_id = ? AND surface_user_id = ?", [install.id, m.author ?? ""]));
    const r = gate({
      duplicate: false,
      binding: { status: binding.status, capture_ok: !!binding.capture_ok },
      message: { subtype: m.subtype, bot_id: m.bot_id, author_id: m.author, text: m.text },
      ourBotUserId: install.bot_user_id,
      author: await authorStatus(install, m.author),
      optedOut: opted,
      minMeaningfulChars: 1,
      explicitAsk: true,
    });
    if (r.keep) kept.push({ id: m.id, author: m.author!, ts: m.ts, text: r.text, meaningful: r.meaningful });
  }
  if (!kept.length) {
    await dropWindow(windowId, "nothing_fetched", NOTHING_FETCHED_NOTE);
    return;
  }
  if (await fillForcedWindow(windowId, binding, kept)) await judgeInBackground(windowId);
}
