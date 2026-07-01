/**
 * Glossary definitions — a literal table-based ontology per nest. Stewards
 * and editors define and articulate terms (existing #tags or brand-new
 * vocabulary); external runtimes (quantitative analysis jobs, agents) pull
 * them in real time via GET ?term= — a single indexed lookup, no engine or
 * graph work on the hot path.
 *
 * Access follows the nest middleware defaults: GET is read-tier, POST/DELETE
 * are write-tier (owner, admin, write collaborators — which covers stewards
 * who hold write).
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";

export const definitionRoutes = new Hono<AuthEnv>();

interface DefinitionRow {
  id: string;
  nest_id: string;
  term: string;
  definition: string;
  linked_tag: string | null;
  defined_by: string;
  created_at: string;
  updated_at: string;
}

// GET /nests/:nestId/definitions            → the whole glossary
// GET /nests/:nestId/definitions?term=CAC   → one exact (case-insensitive) hit
definitionRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const db = getDb();
  const term = c.req.query("term")?.trim();
  if (term) {
    const row = (await db.get(
      "SELECT * FROM definitions WHERE nest_id = ? AND term = ? COLLATE NOCASE",
      [nestId, term],
    )) as DefinitionRow | undefined;
    if (!row) throw new NotFoundError(`No definition for "${term}"`);
    return c.json({ definition: row });
  }
  const rows = (await db.all(
    "SELECT * FROM definitions WHERE nest_id = ? ORDER BY term COLLATE NOCASE",
    [nestId],
  )) as DefinitionRow[];
  return c.json({ count: rows.length, definitions: rows });
});

// POST /nests/:nestId/definitions — upsert by term (case-insensitive).
// Re-defining an existing term updates it in place; the table stays the
// single articulation of each term rather than accreting duplicates.
definitionRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{
    term?: string;
    definition?: string;
    linked_tag?: string | null;
  }>();
  const term = body.term?.trim();
  const definition = body.definition?.trim();
  if (!term || !definition) {
    throw new ValidationError("term and definition are required");
  }
  if (term.length > 200) {
    throw new ValidationError("term must be 200 characters or fewer");
  }
  const linkedTag = body.linked_tag?.trim()
    ? `#${body.linked_tag.trim().replace(/^#+/, "").toLowerCase()}`
    : null;

  const db = getDb();
  const definedBy = await resolveCallerEmail(c.get("userId"));
  const now = new Date().toISOString();
  const existing = (await db.get(
    "SELECT id FROM definitions WHERE nest_id = ? AND term = ? COLLATE NOCASE",
    [nestId, term],
  )) as { id: string } | undefined;

  if (existing) {
    await db.run(
      "UPDATE definitions SET term = ?, definition = ?, linked_tag = ?, defined_by = ?, updated_at = ? WHERE id = ?",
      [term, definition, linkedTag, definedBy, now, existing.id],
    );
  } else {
    await db.run(
      `INSERT INTO definitions (id, nest_id, term, definition, linked_tag, defined_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), nestId, term, definition, linkedTag, definedBy, now, now],
    );
  }
  const row = await db.get(
    "SELECT * FROM definitions WHERE nest_id = ? AND term = ? COLLATE NOCASE",
    [nestId, term],
  );
  return c.json({ definition: row }, existing ? 200 : 201);
});

// DELETE /nests/:nestId/definitions/:id
definitionRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM definitions WHERE id = ? AND nest_id = ?",
    [id, nestId],
  );
  if (!row) throw new NotFoundError("Definition not found");
  await db.run("DELETE FROM definitions WHERE id = ?", [id]);
  return c.json({ deleted: true });
});
