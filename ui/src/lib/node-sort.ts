/**
 * Document-list sort helpers — pure, framework-free so they're unit-testable in
 * the node test env (see test/node-sort.test.ts). NestView owns the state and
 * the React wiring; this module owns the "recent activity" recency rule.
 */

/**
 * Recency key for the "Recent activity" sort: the later of a node's last edit
 * (`updated_at`) and its last comment (`lastAt`). ISO-8601 timestamps compare
 * lexicographically, so the greater string is the more recent one; a missing
 * side is treated as oldest. Sort a list DESCENDING by this key for newest-first.
 */
export function activityTimestamp(
  updatedAt: string | null | undefined,
  commentLastAt: string | null | undefined,
): string {
  const edited = updatedAt || "";
  const commented = commentLastAt || "";
  return edited > commented ? edited : commented;
}
