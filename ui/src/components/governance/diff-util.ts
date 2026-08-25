/**
 * Pure unified line-diff (LCS-based), framework-free so it's unit-testable
 * without a DOM. Emits lines prefixed `+ ` / `- ` / `  ` that DiffViewer
 * colorizes. Inputs are our own version bodies (small markdown), so the
 * O(m·n) table is fine.
 */
export function unifiedDiff(oldText: string, newText: string): string {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push("  " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push("- " + a[i]);
      i++;
    } else {
      out.push("+ " + b[j]);
      j++;
    }
  }
  while (i < m) out.push("- " + a[i++]);
  while (j < n) out.push("+ " + b[j++]);
  return out.join("\n");
}
