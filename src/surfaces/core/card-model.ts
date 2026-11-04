/**
 * Surface-neutral card model (§5.2 core/card-model.ts) — the S1 part: which
 * strings in a card come from the nest, and the rule that they are posted
 * only when the binding's `surface_ok` holds (§4.10 "uses of the flags",
 * AC-GRD-20). Window-derived content (title, summary, folder, nest name,
 * draft link) needs `capture_ok` only.
 */
import type { CardKind, ProposalView } from "../contract.js";

export type { ProposalView } from "../contract.js";

export const CARD_KINDS: readonly CardKind[] = ["single", "merged", "conflict", "agent", "agent_answer"];

/** Kinds whose whole substance is nest-sourced: nothing is left to post when
 *  the nest-sourced part must be withheld. */
const NEST_SOURCED_KINDS: ReadonlySet<CardKind> = new Set<CardKind>(["agent_answer"]);

export interface GuardedView {
  post: boolean;
  view: ProposalView | null;
  /** True when nest-sourced strings were removed. */
  redacted: boolean;
}

export function guardView(view: ProposalView, flags: { capture_ok: boolean; surface_ok: boolean }): GuardedView {
  if (!flags.capture_ok) return { post: false, view: null, redacted: false };
  if (flags.surface_ok) return { post: true, view, redacted: false };
  if (NEST_SOURCED_KINDS.has(view.kind)) return { post: false, view: null, redacted: true };
  const { nest_sourced, ...rest } = view;
  const hadAny = !!nest_sourced && Object.values(nest_sourced).some((v) => typeof v === "string" && v.length > 0);
  return { post: true, view: { ...rest }, redacted: hadAny };
}

// ─── S2b: the interactive card model (§4.12, AC-CRD-02/06/07) ──────────────

export const REJECT_REASONS = ["not_a_decision", "details_wrong", "too_sensitive", "already_on_record", "not_selected", "keep_existing", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REASON_LABELS: Record<RejectReason, string> = {
  not_a_decision: "Not a decision",
  details_wrong: "Details are wrong",
  too_sensitive: "Too sensitive",
  already_on_record: "Already on record",
  not_selected: "Not selected",
  keep_existing: "Kept the existing record",
  other: "Other",
};

/** The reasons a person may pick in the Reject dialog. */
export const PICKABLE_REASONS: RejectReason[] = ["not_a_decision", "details_wrong", "too_sensitive", "already_on_record", "other"];

export type ItemKindName = "decision" | "fact" | "how_we_work" | "owner_deadline" | "correction" | "agent_suggestion";

const KIND_WORD: Record<ItemKindName, string> = {
  decision: "Decision",
  fact: "Fact",
  how_we_work: "Way of working",
  owner_deadline: "Owner and deadline",
  correction: "Correction",
  agent_suggestion: "Agent",
};

export function kindWord(kind: string): string {
  return KIND_WORD[kind as ItemKindName] ?? "Note";
}

/** AC-CRD-02's lead-in by kind; an explicit ask always says so. */
export function leadIn(kind: string, forced: boolean): string {
  if (forced) return "You asked me to remember this:";
  switch (kind) {
    case "decision":
      return "This looks like a decision worth keeping:";
    case "fact":
      return "This looks like a fact worth keeping:";
    case "how_we_work":
      return "This looks like a new way of working:";
    case "owner_deadline":
      return "This looks like an owner and a deadline:";
    case "correction":
      return "This thread may change something on record:";
    case "agent_suggestion":
      return "This channel keeps asking for the same thing. Save an agent for it?";
    default:
      return "This looks worth keeping:";
  }
}

export interface CardItem {
  id: string;
  kind: string;
  op: string;
  title: string;
  summary: string;
  why: string | null;
  folder: string;
  node_id: string | null;
  draft_url: string;
  /** Nest-sourced (conflict): shown only when surface_ok. */
  on_record?: string | null;
  record_title?: string | null;
}

export type CardOutcome =
  | { type: "approved"; by: string; kept: Array<{ path: string; version: number | null }>; notKept: string[]; editedBy?: string | null }
  | { type: "rejected"; by: string; reason: RejectReason | null }
  | { type: "expired"; title: string }
  | { type: "withdrawn"; title: string };

export interface CardModel {
  proposal_id: string;
  kind: "single" | "merged" | "conflict" | "agent";
  forced: boolean;
  nest_name: string;
  items: CardItem[];
  message_count: number;
  /** Display range, e.g. "14:02" and "14:31 UTC". */
  from_label: string | null;
  to_label: string | null;
  /** Slack mention ("<@U123>") of the named reviewer, or null. */
  reviewer: string | null;
  expires_label: string;
  surface_ok: boolean;
  /** DM cards: the disclosure always; the "private nest was created" line on the first only. */
  dm?: { first: boolean } | null;
  note?: string | null;
  compare_url?: string | null;
  outcome?: CardOutcome | null;
  /** R2: show Edit only when the named reviewer may edit every item
   *  (approve-with-edits needs edit rights). Absent = hidden. */
  can_edit?: boolean;
}

/** Round 6 (Misha, 2026-11-01): personal nests are SEALED, so this is now true as built. */
export const PRIVATE_NEST_DISCLOSURE = "Private to you: no one else, including admins, can open it in Nest.";
export const DM_FIRST_LINE = "I made this private nest for you the first time you messaged me. Only you can review what goes into it.";

/** A folder ("ops/") + a node slug → "ops/<slug>"; the root folder ("/") adds nothing. */
export function nodePath(folder: string, nodeId: string): string {
  const slug = nodeId.replace(/^nodes\//, "").split("/").pop() ?? nodeId;
  return `${folder === "/" ? "" : folder}${slug}`;
}

/** The headline text of an outcome (the card's first block after an update). */
export function outcomeHeadline(o: CardOutcome): string {
  switch (o.type) {
    case "approved":
      if (o.notKept.length === 0 && o.kept.length === 1) {
        const k = o.kept[0];
        return `✅ Approved by ${o.by} · ${k.path}${k.version != null ? ` · v${k.version}` : ""}`;
      }
      return `✅ Approved by ${o.by} · kept ${o.kept.length} of ${o.kept.length + o.notKept.length}`;
    case "rejected":
      return `Not saved. Rejected by ${o.by}${o.reason ? ` · "${REASON_LABELS[o.reason]}"` : ""}`;
    case "expired":
      return `⏳ Expired, not saved. Nobody decided on "${o.title}" within 7 days, so the draft was deleted.`;
    case "withdrawn":
      return `Withdrawn. Nest paused in this channel, so this proposal ("${o.title}") was not saved and the draft was deleted.`;
  }
}

export function outcomeContext(o: CardOutcome, nestName: string): string[] {
  switch (o.type) {
    case "approved":
      return [`Live for every AI tool that reads ${nestName}`, `Proposed by Nest${o.editedBy ? ` · edited by ${o.editedBy}` : ""}`];
    case "rejected":
      return ["The draft was deleted · Nest won't propose this again for 7 days"];
    case "expired":
      return ["React 🧠 to the first message if it's still worth keeping"];
    case "withdrawn":
      return ["Your admin has been told why"];
  }
}

export function footerLine(expiresLabel: string): string {
  return `Proposed by Nest · only approved summaries are kept · expires ${expiresLabel}`;
}

/** The fixed card text when !surface_ok lives in S2a's core/card-text.ts (fixedCardText). */
