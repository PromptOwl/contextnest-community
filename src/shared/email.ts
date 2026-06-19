/**
 * Canonical email form: trimmed + lowercased.
 *
 * Email is case-insensitive in practice. Storing and matching one canonical
 * form prevents duplicate user rows for the same person in different cases —
 * which broke collaborator access (grant on one row, login on another) and
 * caused login lockouts. See CU-wdqcpztrhf. Apply on every write; match with
 * LOWER(email) on every read so existing mixed-case rows still resolve.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
