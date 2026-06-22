/**
 * Document lifecycle state machine — pure predicates.
 *
 * The full DocumentLifecycleStatus enum is intentionally not exported from
 * the package yet (community has 5 states, TheOwl has 4 — see drift ADR).
 * This file ships the transition rules as a generic predicate so each repo
 * can call it with its own enum value.
 *
 * Rules (community-canonical):
 *   draft           → pending_review | published
 *   pending_review  → approved | rejected | draft (cancel)
 *   approved        → published
 *   published       → draft (new edit cycle)
 *   rejected        → draft
 */

const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["pending_review", "published"]),
  pending_review: new Set(["approved", "rejected", "draft"]),
  approved: new Set(["published"]),
  published: new Set(["draft"]),
  rejected: new Set(["draft"]),
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}
