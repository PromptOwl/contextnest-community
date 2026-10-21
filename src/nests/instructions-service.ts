/**
 * Nest instructions — the vault's CONTEXT.md, which every agent reads first
 * (MCP `context_init`) — with a history (CU-wdqcq05mty).
 *
 * The engine keeps CONTEXT.md as one file it overwrites in place: written at
 * init and by `ctx push`, never regenerated. So the history lives here, in
 * instructions_revisions: every write records the full text it wrote, numbered
 * per nest (`seq`). A save names the revision it was based on; a stale base is
 * a 409, not a silent overwrite.
 *
 * Before the first recorded write the file already holds something (the init
 * template, or an earlier push), so the first write records that as revision 1
 * ("before history") — a restore can always get back to what agents were
 * reading before anyone edited here.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { isUniqueViolation } from "../governance/stewardship-service.js";

const STALE_MESSAGE =
  "The instructions changed since you opened them. Reload to see the latest, then make your edit again.";

export type InstructionsSource = "initial" | "ui" | "api" | "push" | "mcp" | "restore";

/** Large enough for any real instructions file; small enough that a runaway
 *  agent can't park megabytes in the one file every session loads. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

export interface InstructionsRevision {
  seq: number;
  authorEmail: string | null;
  note: string | null;
  source: InstructionsSource;
  createdAt: string;
}

interface RevisionRow {
  seq: number;
  content: string;
  author_email: string | null;
  note: string | null;
  source: InstructionsSource;
  created_at: string;
}

function toRevision(r: RevisionRow): InstructionsRevision {
  return {
    seq: r.seq,
    authorEmail: r.author_email,
    note: r.note,
    source: r.source,
    createdAt: r.created_at,
  };
}

async function readFile(nestId: string): Promise<string> {
  const { storage } = await engineCache.get(nestId);
  return (await storage.readContextMd()) ?? "";
}

/** The instructions agents are served now, and the revision that wrote them
 *  (null when nothing has been recorded yet). */
export async function getInstructions(
  nestId: string,
): Promise<{ content: string; revision: InstructionsRevision | null }> {
  const content = await readFile(nestId);
  const row = (await getDb().get(
    `SELECT seq, content, author_email, note, source, created_at
       FROM instructions_revisions WHERE nest_id = ? ORDER BY seq DESC LIMIT 1`,
    [nestId],
  )) as RevisionRow | undefined;
  return { content, revision: row ? toRevision(row) : null };
}

export function validateInstructions(content: unknown): string {
  if (typeof content !== "string" || content.trim() === "") {
    throw new ValidationError("content is required — agents need instructions to read");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    throw new ValidationError(
      `Instructions are limited to ${MAX_INSTRUCTIONS_BYTES / 1024} KB`,
    );
  }
  return content;
}

/**
 * Write CONTEXT.md and record the revision. `baseSeq` is the revision the
 * caller edited (0 when the page showed none); omit it to skip the check —
 * pushes and confirmed held pushes have no base, they replace the file the
 * way they always have.
 */
export async function writeInstructions(
  nestId: string,
  content: string,
  opts: {
    authorEmail: string | null;
    note?: string | null;
    source: Exclude<InstructionsSource, "initial">;
    baseSeq?: number;
  },
): Promise<InstructionsRevision> {
  const before = await readFile(nestId);
  const { storage } = await engineCache.get(nestId);

  const selectRevision = `SELECT seq, content, author_email, note, source, created_at
         FROM instructions_revisions WHERE nest_id = ? AND seq = ?`;

  const recorded = await getDb().transaction(async (tx) => {
    const latest = (await tx.get(
      "SELECT MAX(seq) AS seq FROM instructions_revisions WHERE nest_id = ?",
      [nestId],
    )) as { seq: number | null } | undefined;
    let seq = latest?.seq ?? 0;
    if (opts.baseSeq !== undefined && opts.baseSeq !== seq) {
      throw new ConflictError(STALE_MESSAGE);
    }
    // Same text as now (e.g. a push that re-sends CONTEXT.md): no new revision.
    if (seq > 0 && before === content) {
      return (await tx.get(selectRevision, [nestId, seq])) as RevisionRow;
    }
    const insert = async (
      text: string,
      author: string | null,
      note: string | null,
      source: InstructionsSource,
    ) => {
      seq += 1;
      await tx.run(
        `INSERT INTO instructions_revisions
           (id, nest_id, seq, content, author_email, note, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, seq, text, author, note, source],
      );
    };
    if (seq === 0 && before.trim() !== "" && before !== content) {
      await insert(before, null, "Before history was kept", "initial");
    }
    await insert(content, opts.authorEmail, opts.note?.trim() || null, opts.source);
    // The file is written inside the transaction, so a failed write leaves no
    // revision claiming text agents were never served. Same direct write the
    // push path has always done — the engine has no op for CONTEXT.md.
    await storage.writeContextMd(content);
    return (await tx.get(selectRevision, [nestId, seq])) as RevisionRow;
  }).catch((err) => {
    // Two writers raced to the same seq (Postgres READ COMMITTED): a stale save, not a 500.
    if (isUniqueViolation(err)) throw new ConflictError(STALE_MESSAGE);
    throw err;
  });

  // Keeps graph-mode reads (seeded from context.yaml) aware of the change.
  await storage.regenerateIndex();
  return toRevision(recorded);
}

/** Newest first, without bodies. */
export async function listInstructionsRevisions(
  nestId: string,
): Promise<InstructionsRevision[]> {
  const rows = (await getDb().all(
    `SELECT seq, author_email, note, source, created_at
       FROM instructions_revisions WHERE nest_id = ? ORDER BY seq DESC`,
    [nestId],
  )) as RevisionRow[];
  return rows.map(toRevision);
}

/** One revision's text, plus the text before it so a caller can diff. */
export async function getInstructionsRevision(
  nestId: string,
  seq: number,
): Promise<{
  revision: InstructionsRevision;
  content: string;
  previousContent: string | null;
}> {
  const rows = (await getDb().all(
    `SELECT seq, content, author_email, note, source, created_at
       FROM instructions_revisions WHERE nest_id = ? AND seq IN (?, ?)
      ORDER BY seq DESC`,
    [nestId, seq, seq - 1],
  )) as RevisionRow[];
  const row = rows.find((r) => r.seq === seq);
  if (!row) throw new NotFoundError(`Revision ${seq} not found`);
  const prev = rows.find((r) => r.seq === seq - 1);
  return {
    revision: toRevision(row),
    content: row.content,
    previousContent: prev ? prev.content : null,
  };
}

/** Put an earlier revision's text back. Recorded as a new revision. */
export async function restoreInstructionsRevision(
  nestId: string,
  seq: number,
  opts: { authorEmail: string | null; baseSeq?: number },
): Promise<InstructionsRevision> {
  const { content } = await getInstructionsRevision(nestId, seq);
  return writeInstructions(nestId, content, {
    authorEmail: opts.authorEmail,
    note: `From revision ${seq}`,
    source: "restore",
    baseSeq: opts.baseSeq,
  });
}
