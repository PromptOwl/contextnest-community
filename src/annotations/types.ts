/**
 * Annotation domain types for hosted-artifact comment threads.
 *
 * Threads live in their own SQLite tables (see migrations) — intentionally
 * outside the versioned/hash-chained node layer. The interactive store is the
 * source of truth; a derived markdown node is projected from it so the existing
 * MCP/context path pulls the feedback into the next iteration.
 */

/**
 * The node kind that carries a rich HTML artifact (slide deck / dashboard /
 * infographic) in its body. Created like any node with `type: "artifact"`; the
 * `/hosted` endpoint only serves nodes of this kind (a sandboxed HTML render),
 * so an ordinary markdown document can't be coerced into the HTML host path.
 */
export const ARTIFACT_NODE_TYPE = "artifact";

/**
 * Resilient text anchor (W3C TextQuote/TextPosition pattern). The quote is the
 * primary locator; before/after disambiguate when the quote repeats; line is a
 * decaying hint. `null` anchor = a whole-artifact comment.
 */
export interface AnnotationAnchor {
  /** 1-based line in the artifact's extracted text. Hint only — may drift. */
  line?: number;
  /** The highlighted text. */
  quote: string;
  /** Up to ~250 chars immediately before the quote. */
  before: string;
  /** Up to ~250 chars immediately after the quote. */
  after: string;
}

export interface AnnotationComment {
  id: string;
  author: string; // email
  body: string;
  createdAt: string;
  /** The agent run that posted it, when one did (migration 060). */
  runId?: string;
  /** A channel message that was deleted (migration 088): the body is "". */
  deleted?: true;
}

export type ThreadStatus = "open" | "resolved";

export interface AnnotationThread {
  id: string;
  nestId: string;
  nodeId: string;
  snapshotVersion: number | null;
  anchor: AnnotationAnchor | null;
  status: ThreadStatus;
  createdBy: string; // email
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  comments: AnnotationComment[];
}

export interface CreateThreadInput {
  anchor?: AnnotationAnchor | null;
  body: string;
  snapshotVersion?: number | null;
}
