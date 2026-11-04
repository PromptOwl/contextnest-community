/**
 * Windows (PRD §4.5): the key a message joins, when a window closes, and the
 * segmenter the eval uses over raw streams (§8.1 — the same rules, so the
 * eval measures the windows production would judge).
 */
export const WINDOW_MAX_MESSAGES = 40;
export const WINDOW_MAX_CHARS = 12_000;

export type CloseReason = "quiet" | "size" | "age" | "explicit" | "email" | "discarded" | "expired_unjudged";

export interface WindowTiming {
  opened_at: number;
  last_message_at: number;
  message_count: number;
  char_count: number;
}

export interface WindowSettings {
  quiet_minutes: number;
  window_max_age_hours: number;
}

/** A threaded reply keys on its thread; a top-level message on the channel
 *  burst. (A Slack thread root carries thread_ts === ts.) */
export function windowKey(m: { ts: string; thread_ts?: string | null }): string {
  return m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : "channel";
}

function sizeFull(w: Pick<WindowTiming, "message_count" | "char_count">): boolean {
  return w.message_count >= WINDOW_MAX_MESSAGES || w.char_count >= WINDOW_MAX_CHARS;
}

/** W1 quiet, W2 size, W3 age — the first that fires wins. */
export function shouldClose(w: WindowTiming, now: number, s: WindowSettings): "quiet" | "size" | "age" | null {
  if (now - w.last_message_at >= s.quiet_minutes * 60_000) return "quiet";
  if (sizeFull(w)) return "size";
  if (now - w.opened_at >= s.window_max_age_hours * 3600_000) return "age";
  return null;
}

export interface StreamMessage {
  id: string;
  ts: string;
  thread_ts?: string | null;
  /** Epoch ms the message arrived. */
  at: number;
  author: string;
  text: string;
}

export interface SegmentedWindow {
  key: string;
  messages: StreamMessage[];
  opened_at: number;
  closed_at: number;
  close_reason: "quiet" | "size" | "age";
}

/** When a window with no further messages closes on its own (quiet or age). */
function timedClose(w: { opened_at: number; last: number }, s: WindowSettings): { at: number; reason: "quiet" | "age" } {
  const quiet = w.last + s.quiet_minutes * 60_000;
  const age = w.opened_at + s.window_max_age_hours * 3600_000;
  return quiet <= age ? { at: quiet, reason: "quiet" } : { at: age, reason: "age" };
}

/**
 * Replay a raw stream through the production rules: messages in arrival
 * order, a window per key, closed by quiet / age as time passes and by size
 * on arrival. Returns the windows in the order they opened.
 */
export function segment(stream: StreamMessage[], s: WindowSettings): SegmentedWindow[] {
  const sorted = [...stream].sort((a, b) => a.at - b.at);
  const open = new Map<string, { key: string; messages: StreamMessage[]; opened_at: number; last: number; chars: number }>();
  const out: SegmentedWindow[] = [];
  const close = (key: string, at: number, reason: SegmentedWindow["close_reason"]) => {
    const w = open.get(key)!;
    open.delete(key);
    out.push({ key, messages: w.messages, opened_at: w.opened_at, closed_at: at, close_reason: reason });
  };
  for (const m of sorted) {
    for (const [key, w] of [...open]) {
      const t = timedClose(w, s);
      if (t.at <= m.at) close(key, t.at, t.reason);
    }
    const key = windowKey(m);
    let w = open.get(key);
    if (!w) {
      w = { key, messages: [], opened_at: m.at, last: m.at, chars: 0 };
      open.set(key, w);
    }
    w.messages.push(m);
    w.last = m.at;
    w.chars += m.text.length;
    if (sizeFull({ message_count: w.messages.length, char_count: w.chars })) close(key, m.at, "size");
  }
  for (const [key, w] of [...open]) {
    const t = timedClose(w, s);
    close(key, t.at, t.reason);
  }
  return out.sort((a, b) => a.opened_at - b.opened_at);
}
