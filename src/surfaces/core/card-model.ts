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
