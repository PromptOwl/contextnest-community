/**
 * Windows and the buffer (PRD §4.4, §4.5).
 *
 * A gate-surviving message is encrypted into surface_buffer and attached to
 * the open window for its key. A window moves open → closing → judging →
 * judged (or discarded) only by compare-and-set on `status` (+ claim_token),
 * so with several instances exactly one worker judges a window and a
 * re-processed judged window never calls the model again.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { shouldClose, windowKey, WINDOW_MAX_CHARS, WINDOW_MAX_MESSAGES, type CloseReason } from "../core/window.js";
import { effectiveTtlHours } from "../core/settings.js";
import { encryptText, decryptText } from "./buffer-crypto.js";
import { getSettings } from "./settings-service.js";
import { track } from "./work.js";
import { recordPurge } from "./purge-audit.js";

export interface WindowRow {
  id: string;
  binding_id: string;
  nest_id: string;
  thread_key: string;
  forced: number;
  forced_by_surface_user_id: string | null;
  forced_target_id: string | null;
  opened_at: string;
  last_message_at: string;
  closed_at: string | null;
  close_reason: string | null;
  message_count: number;
  char_count: number;
  meaningful_chars: number;
  status: "open" | "awaiting_fetch" | "closing" | "judging" | "judged" | "discarded";
  claim_token: string | null;
  verdict: string | null;
}

export interface BufferedRow {
  id: string;
  window_id: string;
  binding_id: string;
  install_id: string;
  surface_message_id: string;
  thread_key: string;
  author_surface_user_id: string;
  ts: string;
  text_enc: string;
  nonce: string;
  char_count: number;
  meaningful_chars: number;
  expires_at: string;
  created_at: string;
}

export interface BindingLite {
  id: string;
  install_id: string;
  nest_id: string;
}

type Runner = { run: (sql: string, p?: any[]) => Promise<{ changes: number }> };

const iso = (ms: number) => new Date(ms).toISOString();

/** The binding stopped capturing between the gate and the write (round 2, L2). */
export class BindingNotCapturing extends Error {
  constructor() {
    super("binding not capturing");
  }
}

export async function bindingCapturing(bindingId: string, q: { get: (sql: string, p?: any[]) => Promise<unknown> } = getDb()): Promise<boolean> {
  return !!(await q.get("SELECT 1 AS x FROM surface_bindings WHERE id = ? AND status = 'active' AND capture_ok = 1", [bindingId]));
}

export async function getWindow(id: string): Promise<WindowRow | null> {
  return ((await getDb().get("SELECT * FROM surface_windows WHERE id = ?", [id])) as WindowRow | undefined) ?? null;
}

export async function expiresAt(nowMs: number): Promise<string> {
  return iso(nowMs + effectiveTtlHours(await getSettings()) * 3600_000);
}

/** Insert one encrypted buffer row (fresh nonce) into a window. */
export async function insertBufferRow(
  q: Runner,
  w: { id: string; binding_id: string; thread_key: string },
  installId: string,
  m: { id: string; author: string; ts: string; text: string; meaningful: number; expires?: string },
  expires: string,
  nowMs: number,
): Promise<number> {
  // A copy never outlives its source (round 2, L7): the earlier expiry wins.
  if (m.expires && Date.parse(m.expires) < Date.parse(expires)) expires = m.expires;
  const { enc, nonce } = encryptText(m.text);
  const r = await q.run(
    `INSERT INTO surface_buffer (id, window_id, binding_id, install_id, surface_message_id, thread_key, author_surface_user_id, ts, text_enc, nonce,
       char_count, meaningful_chars, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (window_id, surface_message_id) DO NOTHING`,
    [uuid(), w.id, w.binding_id, installId, m.id, w.thread_key, m.author, m.ts, enc, nonce, m.text.length, m.meaningful, expires, iso(nowMs)],
  );
  return r.changes;
}

/**
 * Buffer a gate-surviving message into the open organic window for its key
 * (opening one if none). Returns the window id. Closes the window on size.
 */
export async function bufferMessage(
  binding: BindingLite,
  m: { id: string; author: string; ts: string; thread: string | null; text: string; meaningful: number },
  nowMs = Date.now(),
): Promise<string> {
  const db = getDb();
  const key = windowKey({ ts: m.ts, thread_ts: m.thread });
  const expires = await expiresAt(nowMs);
  // Encrypt before touching the window: no key → nothing is stored at all.
  encryptText("");
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await bindingCapturing(binding.id))) throw new BindingNotCapturing();
    let w = (await db.get("SELECT * FROM surface_windows WHERE binding_id = ? AND thread_key = ? AND status = 'open' AND forced = 0", [binding.id, key])) as
      | WindowRow
      | undefined;
    if (!w) {
      const id = uuid();
      try {
        await db.run(
          `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, forced, opened_at, last_message_at, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'open', ?, ?)`,
          [id, binding.id, binding.nest_id, key, iso(nowMs), iso(nowMs), iso(nowMs), iso(nowMs)],
        );
      } catch {
        continue; // another message opened it first (one open window per key)
      }
      w = (await getWindow(id))!;
    }
    const wid = w.id;
    const attached = await db.transaction(async (tx) => {
      // Compare-and-set on the window AND the binding (round 2, L2): a pause
      // landing between the gate and here leaves nothing buffered.
      const r = await tx.run(
        `UPDATE surface_windows SET message_count = message_count + 1, char_count = char_count + ?, meaningful_chars = meaningful_chars + ?,
           last_message_at = ?, updated_at = ? WHERE id = ? AND status = 'open'
           AND EXISTS (SELECT 1 FROM surface_bindings b WHERE b.id = ? AND b.status = 'active' AND b.capture_ok = 1)`,
        [m.text.length, m.meaningful, iso(nowMs), iso(nowMs), wid, binding.id],
      );
      if (r.changes === 0) {
        if (!(await bindingCapturing(binding.id, tx))) throw new BindingNotCapturing();
        return false;
      }
      await insertBufferRow(tx, { id: wid, binding_id: binding.id, thread_key: key }, binding.install_id, m, expires, nowMs);
      return true;
    });
    if (!attached) continue; // closed under us: open a new one
    const after = (await getWindow(wid))!;
    if (after.message_count >= WINDOW_MAX_MESSAGES || after.char_count >= WINDOW_MAX_CHARS) {
      if (await claimClose(wid, "size", nowMs)) await judgeInBackground(wid);
    }
    return wid;
  }
  throw new Error("could not attach the message to a window");
}

/** open → closing (compare-and-set). */
export async function claimClose(windowId: string, reason: CloseReason, nowMs = Date.now()): Promise<boolean> {
  const r = await getDb().run(
    "UPDATE surface_windows SET status = 'closing', close_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    [reason, iso(nowMs), iso(nowMs), windowId],
  );
  return r.changes > 0;
}

/** Judge in the background (lazy import: the judge imports this module). */
export async function judgeInBackground(windowId: string): Promise<void> {
  const { judgeWindow } = await import("./judge-service.js");
  track(judgeWindow(windowId), "judge");
}

export async function decryptWindow(windowId: string): Promise<Array<BufferedRow & { text: string }>> {
  const rows = (await getDb().all("SELECT * FROM surface_buffer WHERE window_id = ? ORDER BY ts", [windowId])) as BufferedRow[];
  const out: Array<BufferedRow & { text: string }> = [];
  for (const r of rows) {
    try {
      out.push({ ...r, text: decryptText(r.text_enc, r.nonce) });
    } catch {
      // An unopenable row (a rotated key) is left out; the sweeper removes it.
    }
  }
  return out;
}

/**
 * The 1-minute scheduler tick: close every open organic window whose
 * quiet / size / age condition has fired, then judge every window waiting
 * in `closing`. Returns the ids this worker judged.
 */
export async function windowTick(nowMs: number = Date.now()): Promise<string[]> {
  const db = getDb();
  const s = await getSettings();
  const open = (await db.all("SELECT * FROM surface_windows WHERE status = 'open' AND forced = 0")) as WindowRow[];
  for (const w of open) {
    const reason = shouldClose(
      { opened_at: Date.parse(w.opened_at), last_message_at: Date.parse(w.last_message_at), message_count: w.message_count, char_count: w.char_count },
      nowMs,
      s,
    );
    if (reason) await claimClose(w.id, reason, nowMs);
  }
  const closing = (await db.all("SELECT id FROM surface_windows WHERE status = 'closing' ORDER BY closed_at")) as Array<{ id: string }>;
  const { judgeWindow } = await import("./judge-service.js");
  const judged: string[] = [];
  for (const { id } of closing) {
    if (await judgeWindow(id, nowMs)) judged.push(id);
  }
  return judged;
}

/**
 * Discard a binding's unjudged windows and purge its rows (W6: pause or
 * removal). A window mid-judgement is discarded too: its judge then loses
 * the final compare-and-set and withdraws whatever it created.
 */
export async function discardBindingWindows(bindingId: string, nowMs = Date.now()): Promise<number> {
  return getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE surface_windows SET status = 'discarded', close_reason = 'discarded', verdict = 'discarded', closed_at = COALESCE(closed_at, ?), updated_at = ?
        WHERE binding_id = ? AND status IN ('open', 'awaiting_fetch', 'closing', 'judging')`,
      [iso(nowMs), iso(nowMs), bindingId],
    );
    const n = (await tx.run("DELETE FROM surface_buffer WHERE binding_id = ?", [bindingId])).changes;
    await recordPurge("pause", n, { bindingId }, tx);
    return n;
  });
}

/** Open a forced (explicit-ask) window and copy the given messages into it. */
export async function openForcedWindow(
  binding: BindingLite,
  input: {
    threadKey: string;
    requestedBy: string;
    targetId: string;
    messages: Array<{ id: string; author: string; ts: string; text: string; meaningful: number; expires?: string }>;
    awaitingFetch?: boolean;
  },
  nowMs = Date.now(),
): Promise<string> {
  const id = uuid();
  const expires = await expiresAt(nowMs);
  await getDb().transaction(async (tx) => {
    // Opened only while the binding is capturing (round 2, L2). In an
    // INSERT … SELECT, Postgres types bare parameters as text: the integer
    // columns are cast explicitly (round 3, N2).
    const ins = await tx.run(
      `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, forced, forced_by_surface_user_id, forced_target_id, opened_at, last_message_at,
         closed_at, close_reason, message_count, char_count, meaningful_chars, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'explicit', CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM surface_bindings b WHERE b.id = ? AND b.status = 'active' AND b.capture_ok = 1)`,
      [
        id,
        binding.id,
        binding.nest_id,
        input.threadKey,
        input.requestedBy,
        input.targetId,
        iso(nowMs),
        iso(nowMs),
        iso(nowMs),
        input.messages.length,
        input.messages.reduce((s, m) => s + m.text.length, 0),
        input.messages.reduce((s, m) => s + m.meaningful, 0),
        input.awaitingFetch ? "awaiting_fetch" : "closing",
        iso(nowMs),
        iso(nowMs),
        binding.id,
      ],
    );
    if (ins.changes === 0) throw new BindingNotCapturing();
    for (const m of input.messages) await insertBufferRow(tx, { id, binding_id: binding.id, thread_key: input.threadKey }, binding.install_id, m, expires, nowMs);
  });
  return id;
}

/** Fetched messages arrive for a forced window: copy them in and move it to closing. */
export async function fillForcedWindow(
  windowId: string,
  binding: BindingLite,
  messages: Array<{ id: string; author: string; ts: string; text: string; meaningful: number }>,
  nowMs = Date.now(),
): Promise<boolean> {
  const w = await getWindow(windowId);
  if (!w || w.status !== "awaiting_fetch") return false;
  const expires = await expiresAt(nowMs);
  return getDb().transaction(async (tx) => {
    const r = await tx.run(
      `UPDATE surface_windows SET status = 'closing', message_count = message_count + ?, char_count = char_count + ?, meaningful_chars = meaningful_chars + ?,
         updated_at = ? WHERE id = ? AND status = 'awaiting_fetch'
         AND EXISTS (SELECT 1 FROM surface_bindings b WHERE b.id = ? AND b.status = 'active' AND b.capture_ok = 1)`,
      [messages.length, messages.reduce((s, m) => s + m.text.length, 0), messages.reduce((s, m) => s + m.meaningful, 0), iso(nowMs), windowId, binding.id],
    );
    if (r.changes === 0) return false;
    for (const m of messages) await insertBufferRow(tx, { id: windowId, binding_id: binding.id, thread_key: w.thread_key }, binding.install_id, m, expires, nowMs);
    return true;
  });
}
