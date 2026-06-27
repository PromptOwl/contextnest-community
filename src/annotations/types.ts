/**
 * Annotation domain types for hosted-artifact comment threads.
 *
 * Threads live in their own SQLite tables (see migrations) — intentionally
 * outside the versioned/hash-chained node layer. The interactive store is the
 * source of truth; a derived markdown node is projected from it so the existing
 * MCP/context path pulls the feedback into the next iteration.
 */

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
