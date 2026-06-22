/**
 * Slug derivation for nest names. Pure — DB-bound uniqueness checks
 * (e.g. uniqueNestName) live per-repo because they need a storage handle.
 */

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
