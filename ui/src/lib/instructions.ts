/**
 * Pure rules for the nest Instructions tab (CU-wdqcq05mty): the vault's
 * CONTEXT.md, which every agent reads first. Framework-free so they stay
 * unit-testable without a DOM.
 */

export type InstructionsSource = "initial" | "ui" | "api" | "push" | "mcp" | "restore";

export interface InstructionsRevision {
  seq: number;
  authorEmail: string | null;
  note: string | null;
  source: InstructionsSource;
  createdAt: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** CONTEXT.md opens with a frontmatter block (its title). The page edits the
 *  body; the block rides along untouched. */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(FRONTMATTER);
  if (!m) return { frontmatter: "", body: raw };
  return { frontmatter: m[0], body: raw.slice(m[0].length).replace(/^\r?\n/, "") };
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body;
  const fm = frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
  return `${fm}\n${body}`;
}

const SOURCE_LABELS: Record<InstructionsSource, string> = {
  initial: "Before history was kept",
  ui: "Edited here",
  api: "API",
  push: "ctx push",
  mcp: "Agent (MCP)",
  restore: "Restored",
};

export function sourceLabel(source: InstructionsSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** The save's base: the revision on screen, or 0 when none is recorded yet. */
export function baseRevisionOf(revision: InstructionsRevision | null | undefined): number {
  return revision?.seq ?? 0;
}

/** True when the error is the server's "someone saved since you opened it". */
export function isStaleSaveError(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 409;
}
