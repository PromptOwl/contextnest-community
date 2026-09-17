/**
 * The "Categories with no steward" row's empty line. "Every category has a
 * steward" is vacuously true for a nest with no categories at all, and reads
 * as a clean bill of health for coverage that was never evaluated — say what
 * is actually missing instead.
 */
export function categoryCoverageEmpty(tagCount: number, stewardCount: number): string {
  if (tagCount > 0) return "Every category has a steward.";
  return stewardCount > 0
    ? "No categories yet — tag documents to see steward coverage."
    : "No categories or stewards yet — tag documents and assign stewards to see coverage.";
}
