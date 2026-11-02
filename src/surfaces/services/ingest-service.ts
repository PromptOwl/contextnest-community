/**
 * Ingestion (PRD §4.2–§4.4): normalized surface messages → the gate →
 * the encrypted buffer → a window. Event-driven only; the one history read
 * is the explicit-ask fetch queue (fetch-queue.ts).
 *
 * Every drop increments surface_counters with its reason. No text is stored
 * for a dropped message, and nothing here logs message text.
 */
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { ORG_ID } from "../flags.js";
import type { SurfaceMessage } from "../contract.js";
import { gate, meaningfulChars, type AuthorStatus, type DropReason } from "../core/gate.js";
import { getConnector } from "../registry.js";
import { getSettings } from "./settings-service.js";
import { getProfile } from "./identity-service.js";
import { homeTenant, type InstallRow } from "./install-store.js";
import { bufferMessage, openForcedWindow, judgeInBackground, BindingNotCapturing, type BindingLite } from "./window-service.js";
import { recordPurge } from "./purge-audit.js";
import { encryptText } from "./buffer-crypto.js";
import { enqueueFetch } from "./fetch-queue.js";
import type { BindingRow } from "./binding-service.js";

export const ASKS_PER_DAY = 10;
export const FORCED_THREAD_MAX = 20;

export const REFUSE_GUEST = (org: string) => `Nest can't use messages from guests or people outside ${org}.`;
export const REFUSE_OPTED_OUT = "That person has asked Nest not to use their messages.";
export const REFUSE_LIMIT = "You've hit today's limit for 🧠 requests.";
export const OPTOUT_NOTE = "Done: Nest won't use your messages here. Anything of yours it was holding has been deleted.";

const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** Increment a counter (never text). Messages with no binding count on the install. */
export async function count(metric: string, binding: { id: string; nest_id: string } | null, installId: string): Promise<void> {
  const bindingKey = binding ? binding.id : `install:${installId}`;
  try {
    await getDb().run(
      `INSERT INTO surface_counters (org_id, nest_id, binding_id, day, metric, value, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (binding_id, day, metric) DO UPDATE SET value = surface_counters.value + 1`,
      [ORG_ID, binding?.nest_id ?? null, bindingKey, day(), metric, new Date().toISOString()],
    );
  } catch {
    /* counters never fail ingestion */
  }
}

async function bindingFor(installId: string, conversation: string): Promise<BindingRow | null> {
  return ((await getDb().get("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [installId, conversation])) as BindingRow | undefined) ?? null;
}

/** G4: a fetched profile; anything unreadable is `unknown` (dropped). */
export async function authorStatus(install: InstallRow, userId: string | null): Promise<AuthorStatus> {
  if (!userId) return "unknown";
  const p = await getProfile(install.id, userId).catch(() => null);
  if (!p) return "unknown";
  if (p.is_bot) return "bot";
  if (p.deleted || p.is_restricted || p.is_ultra_restricted || p.is_stranger) return "guest_or_external";
  if (!p.home_team_id || p.home_team_id !== homeTenant(install)) return "guest_or_external";
  return "member";
}

async function optedOut(installId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  return !!(await getDb().get("SELECT 1 AS x FROM surface_optouts WHERE install_id = ? AND surface_user_id = ?", [installId, userId]));
}

/** DM capture is an S2b setting (default OFF, §12 R2): until it lands, DMs are not captured. */
function captureBinding(b: BindingRow | null): BindingRow | null {
  return b && b.conversation_kind === "dm" ? null : b;
}

const lite = (b: BindingRow): BindingLite => ({ id: b.id, install_id: b.install_id, nest_id: b.nest_id });

export async function ingest(install: InstallRow, msgs: SurfaceMessage[], opts: { duplicate?: boolean } = {}): Promise<void> {
  for (const m of msgs) {
    switch (m.kind) {
      case "message":
        await ingestMessage(install, m, !!opts.duplicate);
        break;
      case "edit":
        await ingestEdit(install, m);
        break;
      case "delete":
        await ingestDelete(install, m);
        break;
      case "optout":
        await ingestOptout(install, m);
        break;
      case "explicit_ask":
        await ingestAsk(install, m);
        break;
    }
  }
}

async function ingestMessage(install: InstallRow, m: SurfaceMessage, duplicate: boolean): Promise<void> {
  const binding = captureBinding(await bindingFor(install.id, m.conversation));
  const settings = await getSettings();
  const base = {
    duplicate,
    binding: binding ? { status: binding.status, capture_ok: !!binding.capture_ok, conversation_kind: binding.conversation_kind } : null,
    message: { subtype: m.subtype ?? null, bot_id: m.bot_id ?? null, author_id: m.author.id || null, text: m.text },
    ourBotUserId: install.bot_user_id,
    optedOut: false,
    minMeaningfulChars: settings.min_meaningful_chars,
  };
  // G1–G3 first, so a bot or an unbound channel never costs a profile fetch.
  const pre = gate({ ...base, author: "member" });
  if (!pre.keep && (pre.reason === "duplicate" || pre.reason === "not_enabled" || pre.reason === "paused" || pre.reason === "bot_or_system")) {
    await count(`drop_${pre.reason}`, binding, install.id);
    return;
  }
  const r = gate({ ...base, author: await authorStatus(install, m.author.id), optedOut: await optedOut(install.id, m.author.id) });
  if (!r.keep) {
    await count(`drop_${r.reason}`, binding, install.id);
    return;
  }
  try {
    await bufferMessage(lite(binding!), { id: m.id ?? m.ts, author: m.author.id, ts: m.ts, thread: m.thread, text: r.text, meaningful: r.meaningful });
    await count("buffered", binding, install.id);
  } catch (err) {
    // Paused under us (round 2, L2), no buffer key, or the DB refused: fail
    // closed — nothing kept.
    await count(err instanceof BindingNotCapturing ? "drop_paused" : "drop_buffer_error", binding, install.id);
  }
}

/** message_changed: replace the buffered text; delete it if it now fails G6. */
async function ingestEdit(install: InstallRow, m: SurfaceMessage): Promise<void> {
  const binding = await bindingFor(install.id, m.conversation);
  if (!binding) return;
  const id = m.id ?? m.ts;
  const rows = (await getDb().all("SELECT id FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, id])) as Array<{ id: string }>;
  if (!rows.length) return;
  const settings = await getSettings();
  const mc = meaningfulChars(m.text);
  if (mc < settings.min_meaningful_chars) {
    const n = (await getDb().run("DELETE FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, id])).changes;
    await recordPurge("edit", n, { bindingId: binding.id });
    return;
  }
  const text = m.text.slice(0, 4000);
  for (const r of rows) {
    const { enc, nonce } = encryptText(text);
    await getDb().run("UPDATE surface_buffer SET text_enc = ?, nonce = ?, char_count = ?, meaningful_chars = ? WHERE id = ?", [enc, nonce, text.length, mc, r.id]);
  }
}

async function ingestDelete(install: InstallRow, m: SurfaceMessage): Promise<void> {
  const binding = await bindingFor(install.id, m.conversation);
  if (!binding) return;
  const n = (await getDb().run("DELETE FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, m.id ?? m.ts])).changes;
  await recordPurge("delete", n, { bindingId: binding.id });
}

/** `@Nest skip me`: record the opt-out and delete every row of theirs in the install. */
async function ingestOptout(install: InstallRow, m: SurfaceMessage): Promise<void> {
  if (!m.author.id) return;
  await getDb().run("INSERT INTO surface_optouts (install_id, surface_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (install_id, surface_user_id) DO NOTHING", [
    install.id,
    m.author.id,
    new Date().toISOString(),
  ]);
  const n = (await getDb().run("DELETE FROM surface_buffer WHERE install_id = ? AND author_surface_user_id = ?", [install.id, m.author.id])).changes;
  await recordPurge("optout", n, { installId: install.id });
  const binding = await bindingFor(install.id, m.conversation);
  if (binding) await note(install, binding, m.author.id, OPTOUT_NOTE, m.thread);
}

async function note(install: InstallRow, b: BindingRow, user: string, text: string, thread: string | null = null): Promise<void> {
  const c = getConnector(install.surface);
  if (!c?.sendNote) return;
  try {
    await c.sendNote({ id: b.id, install_id: b.install_id, conversation_id: b.conversation_id, nest_id: b.nest_id }, user, text, thread);
  } catch {
    /* best effort */
  }
}

async function orgName(): Promise<string> {
  return config.SURFACES_ORG_NAME;
}

/** One more ask today for this requester, atomically; false when at the limit. */
async function takeAsk(installId: string, user: string): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO surface_ask_counts (install_id, surface_user_id, day, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (install_id, surface_user_id, day) DO UPDATE SET n = surface_ask_counts.n + 1 WHERE surface_ask_counts.n < ?`,
    [installId, user, day(), ASKS_PER_DAY],
  );
  return r.changes > 0;
}

/**
 * Explicit asks (🧠, `@Nest remember this`): G0–G5 on the requester and on
 * the target's author, the daily limit, one ephemeral status note, then a
 * forced window — from the buffer, or via the rate-aware fetch queue.
 */
async function ingestAsk(install: InstallRow, m: SurfaceMessage): Promise<void> {
  const binding = captureBinding(await bindingFor(install.id, m.conversation));
  if (!binding || binding.status !== "active" || !binding.capture_ok) {
    await count(binding ? "drop_paused" : "drop_not_enabled", binding, install.id);
    return;
  }
  const requester = m.author.id;
  if (!requester || requester === install.bot_user_id) return;
  if ((await authorStatus(install, requester)) !== "member" || (await optedOut(install.id, requester))) {
    await count("drop_ask_requester", binding, install.id);
    return;
  }
  const target = m.target;
  if (!target) return;
  const replyThread = target.thread ?? target.id;
  if (target.author) {
    const st = await authorStatus(install, target.author);
    if (st !== "member") {
      await note(install, binding, requester, REFUSE_GUEST(await orgName()), replyThread);
      return;
    }
    if (await optedOut(install.id, target.author)) {
      await note(install, binding, requester, REFUSE_OPTED_OUT, replyThread);
      return;
    }
  }
  if (!(await takeAsk(install.id, requester))) {
    await note(install, binding, requester, REFUSE_LIMIT, replyThread);
    return;
  }
  const authorName = target.author ? ((await getProfile(install.id, target.author).catch(() => null))?.display_name ?? "a teammate") : "this thread";
  await note(install, binding, requester, `🧠 Drafting from ${target.author ? `${authorName}'s` : "this thread's"} message. It'll appear in this thread.`, replyThread);

  const db = getDb();
  type Row = { surface_message_id: string; thread_key: string; author_surface_user_id: string; ts: string; text_enc: string; nonce: string; meaningful_chars: number; expires_at: string };
  const { decryptText } = await import("./buffer-crypto.js");
  // A forced copy keeps the source row's expiry (round 2, L7).
  const toMsg = (r: Row) => ({ id: r.surface_message_id, author: r.author_surface_user_id, ts: r.ts, text: decryptText(r.text_enc, r.nonce), meaningful: r.meaningful_chars, expires: r.expires_at });
  const dedupe = (rows: Row[]) => [...new Map(rows.map((r) => [r.surface_message_id, r])).values()];
  let messages: Array<ReturnType<typeof toMsg>> = [];
  let threadKey = "channel";
  if (m.ask_via === "mention") {
    threadKey = target.thread ?? target.id;
    const root = dedupe((await db.all("SELECT * FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, threadKey])) as Row[]);
    const replies = dedupe((await db.all("SELECT * FROM surface_buffer WHERE binding_id = ? AND thread_key = ? ORDER BY ts", [binding.id, threadKey])) as Row[]).filter(
      (r) => r.surface_message_id !== threadKey,
    );
    messages = [...root.slice(0, 1), ...replies.slice(-FORCED_THREAD_MAX)].map(toMsg);
  } else {
    const hit = dedupe((await db.all("SELECT * FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, target.id])) as Row[])[0];
    if (hit) {
      threadKey = hit.thread_key;
      if (threadKey !== "channel") {
        const root = dedupe((await db.all("SELECT * FROM surface_buffer WHERE binding_id = ? AND surface_message_id = ?", [binding.id, threadKey])) as Row[]);
        const before = dedupe((await db.all("SELECT * FROM surface_buffer WHERE binding_id = ? AND thread_key = ? AND ts < ? ORDER BY ts", [binding.id, threadKey, hit.ts])) as Row[]);
        messages = [...root.slice(0, 1), ...before.slice(-FORCED_THREAD_MAX), hit].map(toMsg);
      } else {
        messages = [toMsg(hit)];
      }
    }
  }
  try {
    await openAsk(install, binding, m, requester, target, threadKey, messages);
  } catch (err) {
    if (err instanceof BindingNotCapturing) await count("drop_paused", binding, install.id);
    else throw err;
  }
}

async function openAsk(
  install: InstallRow,
  binding: BindingRow,
  m: SurfaceMessage,
  requester: string,
  target: NonNullable<SurfaceMessage["target"]>,
  threadKey: string,
  messages: Array<{ id: string; author: string; ts: string; text: string; meaningful: number; expires?: string }>,
): Promise<void> {
  if (!messages.length) {
    // Not in the buffer (older than the TTL, before install, or gated out): fetch it.
    const wid = await openForcedWindow(lite(binding), { threadKey, requestedBy: requester, targetId: target.id, messages: [], awaitingFetch: true });
    const thread = m.ask_via === "mention" ? threadKey : null;
    await enqueueFetch({
      installId: install.id,
      method: thread ? "conversations.replies" : "conversations.history",
      params: thread
        ? { channel: binding.conversation_id, ts: thread, limit: String(FORCED_THREAD_MAX + 1) }
        : { channel: binding.conversation_id, latest: target.id, inclusive: "true", limit: "1" },
      windowId: wid,
      requestedBy: requester,
    });
    return;
  }
  const wid = await openForcedWindow(lite(binding), { threadKey, requestedBy: requester, targetId: target.id, messages });
  await judgeInBackground(wid);
}
