/**
 * Re-running the §4.6 filters on a reviewer's edit (§4.12 "Edit → approve",
 * AC-CMT-08) after the window's text is gone.
 *
 * The buffer is purged once a window is judged, so the verbatim cap and the
 * 8-word leak filter can't compare an edit to the window's text later. At
 * proposal time we keep a WINDOW GUARD instead: keyed hashes (HMAC under a
 * key derived from the server's buffer key, plus a per-proposal salt) of the
 * window's 16-word and 8-word shingles. A 16-word shingle of the edit found
 * in the guard means a verbatim run longer than the 15-word cap; an 8-word
 * shingle of the edit found in another node but NOT in the guard is a leak.
 * The guard is never text, can't be reversed without the server key, and is
 * purged with the item title. Pure apart from the HMAC.
 */
import { createHmac, randomBytes } from "crypto";
import { VERBATIM_CAP } from "../core/judge-schema.js";
import { SHINGLE, peopleBodyOk, sensitiveHit, words } from "../core/filters.js";

export interface WindowGuard {
  salt: string;
  /** (VERBATIM_CAP + 1)-word shingles of the window. */
  v: string[];
  /** 8-word shingles of the window. */
  l: string[];
}

const RUN = VERBATIM_CAP + 1;

function shingleList(ws: string[], n: number): string[] {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return [...out];
}

function mac(key: Buffer, salt: string, s: string): string {
  return createHmac("sha256", key).update(`surfaces-window-guard-v1\u0000${salt}\u0000${s}`).digest("hex").slice(0, 20);
}

export function buildWindowGuard(windowTexts: string[], key: Buffer): WindowGuard {
  const salt = randomBytes(12).toString("hex");
  const v = new Set<string>();
  const l = new Set<string>();
  for (const t of windowTexts) {
    const ws = words(t);
    for (const s of shingleList(ws, RUN)) v.add(mac(key, salt, s));
    for (const s of shingleList(ws, SHINGLE)) l.add(mac(key, salt, s));
  }
  return { salt, v: [...v], l: [...l] };
}

export const GENERIC_EDIT_ERROR = "This edit can't be saved as written. Keep it to what this conversation said, in your own words.";

export interface EditedFields {
  title: string;
  summary: string;
  body: string;
}

export type EditCheck = { ok: true } | { ok: false; field: keyof EditedFields; message: string };

function sentences(s: string): number {
  return s.split(/[.!?]+(?:\s|$)/).filter((x) => x.trim()).length;
}

/**
 * Validate an edit: the same caps as the judge's output (title 4–80, summary
 * ≤ 400 chars and ≤ 3 sentences, body ≤ 2,000), the sensitive lexicon, the
 * people-folder rules, the verbatim cap and the leak filter.
 */
export function checkEdit(
  e: EditedFields,
  ctx: {
    guard: WindowGuard | null;
    key: Buffer | null;
    otherNodeTexts: string[];
    peopleFolder: boolean;
    kind: string;
  },
): EditCheck {
  if (e.title.trim().length < 4 || e.title.length > 80) return { ok: false, field: "title", message: "Keep the title between 4 and 80 characters." };
  if (!e.summary.trim() || e.summary.length > 400 || sentences(e.summary) > 3) {
    return { ok: false, field: "summary", message: "Keep the summary to at most 3 sentences and 400 characters." };
  }
  if (!e.body.trim() || e.body.length > 2000) return { ok: false, field: "body", message: "Keep the draft between 1 and 2,000 characters." };
  for (const f of ["title", "summary", "body"] as const) {
    if (sensitiveHit(e[f])) return { ok: false, field: f, message: "This looks sensitive (pay, health, HR, credentials…). Nest won't keep it." };
  }
  if (ctx.peopleFolder) {
    if ((ctx.kind !== "fact" && ctx.kind !== "owner_deadline") || !peopleBodyOk(e.body)) {
      return { ok: false, field: "body", message: "People notes hold only role, owns, contact and team lines." };
    }
  }
  // Without the guard (or the key) the window can't be compared: fail closed.
  if (!ctx.guard || !ctx.key) return { ok: false, field: "summary", message: "This draft can no longer be edited here. Edit it in the nest instead." };
  const g = ctx.guard;
  const v = new Set(g.v);
  for (const f of ["summary", "body"] as const) {
    for (const s of shingleList(words(e[f]), RUN)) {
      if (v.has(mac(ctx.key, g.salt, s))) {
        return { ok: false, field: f, message: `Write it in your own words: more than ${VERBATIM_CAP} words in a row are copied from the conversation.` };
      }
    }
  }
  const others = new Set<string>();
  for (const t of ctx.otherNodeTexts) for (const s of shingleList(words(t), SHINGLE)) others.add(s);
  const win = new Set(g.l);
  for (const f of ["title", "summary", "body"] as const) {
    for (const s of shingleList(words(e[f]), SHINGLE)) {
      if (others.has(s) && !win.has(mac(ctx.key, g.salt, s))) {
        // Generic on purpose (INFO e): never says whether text exists elsewhere.
        return { ok: false, field: f, message: GENERIC_EDIT_ERROR };
      }
    }
  }
  return { ok: true };
}
