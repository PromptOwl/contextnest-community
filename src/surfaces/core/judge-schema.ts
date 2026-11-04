/**
 * The judge's terminal output (`submit_window_verdict`) and the deterministic
 * proposal bar (PRD §4.6). The model's output is untrusted: it is validated
 * field by field (any violation → `error_schema`, no proposal), then every
 * item must clear the bar on words, not on the model's self-report.
 */
import { categoryHit, hasDateExpression, leakedShingles, longestVerbatimRun, peopleBodyOk, sensitiveHit } from "./filters.js";

export const VERBATIM_CAP = 15;

/**
 * Is a node of this frontmatter type a plain document a Surfaces edit may
 * target? Anything typed (agent, skill, view, table, task, artifact, …) carries
 * configuration or structure, not prose — refused (security N6).
 */
export function isPlainDocumentType(type: string | null | undefined): boolean {
  return type === undefined || type === null || type === "" || type === "document";
}
/** How the nest root is written as a target folder. */
export const ROOT_FOLDER = "/";

export type ItemKind = "decision" | "fact" | "how_we_work" | "owner_deadline" | "correction" | "agent_suggestion";
const KINDS: ReadonlySet<string> = new Set(["decision", "fact", "how_we_work", "owner_deadline", "correction", "agent_suggestion"]);
const REASONS: ReadonlySet<string> = new Set(["chatter", "question_only", "no_agreement", "already_on_record", "sensitive", "proposed"]);

export interface VerdictItem {
  kind: ItemKind;
  op: "new" | "edit" | "agent";
  target_folder: string;
  target_node_id: string | null;
  title: string;
  summary: string;
  body: string;
  owner: string | null;
  due_date: string | null;
  evidence_message_ids: string[];
  why: string;
  confidence: number;
  sensitive: boolean;
  conflict: { node_id: string; on_record_claim: string; thread_claim: string } | null;
  agent?: { name: string; description: string; read_folders: string[] } | null;
  /** §13: domain tags from the seed's listener.domain_tags (0–3). */
  tags?: string[];
}

export interface Verdict {
  verdict: "no_op" | "propose";
  reason_code: string;
  items: VerdictItem[];
  ask_signature: string | null;
}

export interface JudgeWindowView {
  forced: boolean;
  messages: Array<{ id: string; author_display: string; text: string }>;
  /** Display names of people mentioned in the window. */
  mentions: string[];
}

export interface NestIndex {
  /** Node ids in the bound nest under an allowlisted folder. */
  nodeIds: Set<string>;
  /** The folders this binding's listener may propose into ("/" = the nest
   *  root, or a top-level folder "<name>/"). From the listener config —
   *  never hard-coded here. */
  folders: string[];
  /** §13: the tags an item may carry (the seed's domain_tags); none when unset. */
  domainTags?: string[];
  /** §13: admin-only folders: only agent suggestions may target them. */
  adminFolders?: string[];
}

export const MAX_ITEM_TAGS = 3;

type V = { ok: true; verdict: Verdict } | { ok: false; error: string };
const fail = (error: string): V => ({ ok: false, error });

function isStr(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.trim().length >= min && v.length <= max;
}
function sentences(s: string): number {
  return s.split(/[.!?]+(?:\s|$)/).filter((x) => x.trim()).length;
}
/** "/" for a node at the nest root, else its top-level folder ("<name>/"). */
export const folderOf = (nodeId: string) => {
  const parts = nodeId.replace(/^nodes\//, "").split("/");
  return parts.length > 1 ? `${parts[0]}/` : ROOT_FOLDER;
};

export function validateVerdict(raw: unknown, w: JudgeWindowView, n: NestIndex): V {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const r = raw as Record<string, unknown>;
  if (r.verdict !== "no_op" && r.verdict !== "propose") return fail("verdict");
  if (typeof r.reason_code !== "string" || !REASONS.has(r.reason_code)) return fail("reason_code");
  if (!Array.isArray(r.items) || r.items.length > 3) return fail("items");
  if (r.verdict === "propose" && r.items.length < 1) return fail("items: propose needs ≥ 1");
  if (r.verdict === "no_op" && r.items.length > 0) return fail("items: no_op has none");
  if (w.forced && r.items.length < 1 && r.reason_code !== "sensitive") return fail("items: forced needs ≥ 1");
  let ask: string | null = null;
  if (r.ask_signature !== undefined && r.ask_signature !== null) {
    if (!isStr(r.ask_signature, 1, 60) || r.ask_signature !== r.ask_signature.toLowerCase()) return fail("ask_signature");
    ask = r.ask_signature;
  }
  const ids = new Set(w.messages.map((m) => m.id));
  const items: VerdictItem[] = [];
  for (const it of r.items as unknown[]) {
    if (!it || typeof it !== "object") return fail("item");
    const x = it as Record<string, unknown>;
    if (typeof x.kind !== "string" || !KINDS.has(x.kind)) return fail("kind");
    if (x.op !== "new" && x.op !== "edit" && x.op !== "agent") return fail("op");
    if (x.kind === "correction" && x.op !== "edit") return fail("correction needs op=edit");
    if (x.kind === "agent_suggestion" && x.op !== "agent") return fail("agent_suggestion needs op=agent");
    if (x.op === "agent" && x.kind !== "agent_suggestion") return fail("op=agent only for agent_suggestion");
    if (typeof x.target_folder !== "string") return fail("target_folder");
    if (!n.folders.includes(x.target_folder)) return fail("target_folder");
    if ((n.adminFolders ?? []).includes(x.target_folder) && x.kind !== "agent_suggestion") return fail("target_folder");
    let tags: string[] = [];
    if (x.tags !== undefined && x.tags !== null) {
      const allowed = new Set(n.domainTags ?? []);
      if (!Array.isArray(x.tags) || x.tags.length > MAX_ITEM_TAGS || !x.tags.every((t) => typeof t === "string" && allowed.has(t))) return fail("tags");
      tags = [...new Set(x.tags as string[])];
    }
    let target: string | null = null;
    if (x.op === "edit") {
      if (typeof x.target_node_id !== "string" || !n.nodeIds.has(x.target_node_id) || folderOf(x.target_node_id) !== x.target_folder) {
        return fail("target_node_id");
      }
      target = x.target_node_id;
    } else if (x.target_node_id !== null && x.target_node_id !== undefined) {
      return fail("target_node_id only with op=edit");
    }
    if (!isStr(x.title, 4, 80)) return fail("title");
    if (!isStr(x.summary, 1, 400) || sentences(x.summary) > 3) return fail("summary");
    if (!isStr(x.body, 1, 2000)) return fail("body");
    let owner: string | null = null;
    if (x.owner !== null && x.owner !== undefined) {
      if (!isStr(x.owner, 1, 120)) return fail("owner");
      owner = x.owner;
    }
    let due: string | null = null;
    if (x.due_date !== null && x.due_date !== undefined) {
      if (typeof x.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.due_date) || Number.isNaN(Date.parse(x.due_date))) return fail("due_date");
      due = x.due_date;
    }
    if (!Array.isArray(x.evidence_message_ids) || x.evidence_message_ids.length < 1) return fail("evidence_message_ids");
    for (const e of x.evidence_message_ids) if (typeof e !== "string" || !ids.has(e)) return fail("evidence_message_ids");
    if (typeof x.why !== "string" || x.why.length > 120) return fail("why");
    if (typeof x.confidence !== "number" || !(x.confidence >= 0 && x.confidence <= 1)) return fail("confidence");
    if (typeof x.sensitive !== "boolean") return fail("sensitive");
    let conflict: VerdictItem["conflict"] = null;
    if (x.conflict !== null && x.conflict !== undefined) {
      const c = x.conflict as Record<string, unknown>;
      if (x.op !== "edit" || !c || typeof c !== "object") return fail("conflict only with op=edit");
      if (typeof c.node_id !== "string" || !isStr(c.on_record_claim, 1, 200) || !isStr(c.thread_claim, 1, 200)) return fail("conflict");
      conflict = { node_id: c.node_id, on_record_claim: c.on_record_claim, thread_claim: c.thread_claim };
    }
    let agent: VerdictItem["agent"] = null;
    if (x.kind === "agent_suggestion") {
      const a = x.agent as Record<string, unknown> | null | undefined;
      if (!a || !isStr(a.name, 1, 60) || !isStr(a.description, 1, 400) || !Array.isArray(a.read_folders)) return fail("agent");
      for (const f of a.read_folders) if (typeof f !== "string" || !n.folders.includes(f)) return fail("agent.read_folders");
      agent = { name: a.name, description: a.description, read_folders: a.read_folders as string[] };
    }
    items.push({
      kind: x.kind as ItemKind,
      op: x.op,
      target_folder: x.target_folder,
      target_node_id: target,
      title: x.title.trim(),
      summary: x.summary,
      body: x.body,
      owner,
      due_date: due,
      evidence_message_ids: x.evidence_message_ids as string[],
      why: x.why,
      confidence: x.confidence,
      sensitive: x.sensitive,
      conflict,
      agent,
      tags,
    });
  }
  return { ok: true, verdict: { verdict: r.verdict, reason_code: r.reason_code, items, ask_signature: ask } };
}

export interface BarContext {
  forced: boolean;
  threshold: number;
  window: JudgeWindowView;
  /** Texts of every nest node other than the target (approved bodies + titles). */
  otherNodeTexts: (targetNodeId: string | null) => string[];
  folderExists: (folder: string) => boolean;
  /** Folders whose drafts hold people facts (role/owns/contact/team only);
   *  from the listener config, default none. */
  peopleFolders?: string[];
  /** §13: the seed's never_propose categories and their synonyms (blocked like the lexicon, never waived). */
  neverPropose?: string[];
  /** The dedup match for this item (service-computed), or null. */
  duplicate: { held_on?: string | null; source: string } | null;
}

export type BarResult = { pass: true; previously_held_on: string | null } | { pass: false; reason: string };

/** The §4.6 bar, rules 1–8, in order. */
export function applyBar(item: VerdictItem, ctx: BarContext): BarResult {
  // 1. confidence (waived when forced)
  if (!ctx.forced && item.confidence < ctx.threshold) return { pass: false, reason: "low_confidence" };
  // 2. sensitive (never waived)
  // Every text field a card or a draft can carry (S7-R2 L5).
  const allText = [
    item.title,
    item.summary,
    item.body,
    item.why,
    item.owner ?? "",
    item.agent?.name ?? "",
    item.agent?.description ?? "",
    item.conflict?.on_record_claim ?? "",
    item.conflict?.thread_claim ?? "",
  ].join("\n");
  if (item.sensitive || sensitiveHit(allText) || categoryHit(allText, ctx.neverPropose ?? [])) return { pass: false, reason: "sensitive" };
  // 3. people-folder rules
  if ((ctx.peopleFolders ?? []).includes(item.target_folder)) {
    if (item.kind !== "fact" && item.kind !== "owner_deadline") return { pass: false, reason: "people_rules" };
    if (!peopleBodyOk(item.body)) return { pass: false, reason: "people_rules" };
  }
  // 4. verbatim cap
  const byId = new Map(ctx.window.messages.map((m) => [m.id, m.text]));
  const sources = ctx.window.messages.map((m) => m.text);
  if (longestVerbatimRun(`${item.summary}\n${item.body}`, sources) > VERBATIM_CAP) return { pass: false, reason: "verbatim" };
  // 5. out-of-target leak (8-word shingles)
  const windowText = sources.join("\n");
  if (leakedShingles(`${item.title}\n${item.summary}\n${item.body}\n${item.why}`, ctx.otherNodeTexts(item.target_node_id), windowText) > 0) {
    return { pass: false, reason: "leak" };
  }
  // 6. owner and due date
  if (item.owner) {
    const o = item.owner.trim().replace(/^@/, "").toLowerCase();
    const people = new Set([...ctx.window.messages.map((m) => m.author_display), ...ctx.window.mentions].map((p) => p.trim().replace(/^@/, "").toLowerCase()));
    if (!people.has(o)) return { pass: false, reason: "owner" };
  }
  if (item.due_date) {
    const ev = item.evidence_message_ids.map((id) => byId.get(id) ?? "");
    if (!ev.some(hasDateExpression)) return { pass: false, reason: "due_date" };
  }
  // 7. dedup (waived when forced; the card then names the earlier "no")
  let heldOn: string | null = null;
  if (ctx.duplicate) {
    if (!ctx.forced) return { pass: false, reason: ctx.duplicate.source === "published" ? "already_on_record" : "duplicate" };
    heldOn = ctx.duplicate.held_on ?? null;
  }
  // 8. target folder exists
  if (!ctx.folderExists(item.target_folder)) return { pass: false, reason: "no_target_folder" };
  return { pass: true, previously_held_on: heldOn };
}
