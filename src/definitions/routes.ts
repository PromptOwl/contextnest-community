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
      "SELECT * FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)",
      [nestId, term],
    )) as DefinitionRow | undefined;
    if (!row) throw new NotFoundError(`No definition for "${term}"`);
    return c.json({ definition: row });
  }
  const rows = (await db.all(
    "SELECT * FROM definitions WHERE nest_id = ? ORDER BY LOWER(term)",
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
    term?: unknown;
    definition?: unknown;
    linked_tag?: unknown;
  }>();
  // Runtime shape checks — the json<>() cast is compile-time only, and a
  // numeric term would otherwise TypeError into a generic 500.
  if (body.term !== undefined && typeof body.term !== "string")
    throw new ValidationError("term must be a string");
  if (body.definition !== undefined && typeof body.definition !== "string")
    throw new ValidationError("definition must be a string");
  if (
    body.linked_tag !== undefined &&
    body.linked_tag !== null &&
    typeof body.linked_tag !== "string"
  )
    throw new ValidationError("linked_tag must be a string or null");
  const term = (body.term as string | undefined)?.trim();
  const definition = (body.definition as string | undefined)?.trim();
  if (!term || !definition) {
    throw new ValidationError("term and definition are required");
  }
  if (term.length > 200) {
    throw new ValidationError("term must be 200 characters or fewer");
  }
  // linked_tag semantics: omitted = leave unchanged on update; explicit
  // null/"" = clear; string = set (normalized to #lowercase).
  const linkedTagProvided = "linked_tag" in body;
  const linkedTag = (body.linked_tag as string | null | undefined)?.trim()
    ? `#${(body.linked_tag as string).trim().replace(/^#+/, "").toLowerCase()}`
    : null;

  const db = getDb();
  const definedBy = await resolveCallerEmail(c.get("userId"));
  const now = new Date().toISOString();
  // Transaction closes the select-then-branch race: two concurrent defines
  // of the same new term serialize instead of the loser 409ing on the
  // unique index.
  await db.transaction(async (tx) => {
    const existing = (await tx.get(
      "SELECT id FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)",
      [nestId, term],
    )) as { id: string } | undefined;

    if (existing) {
      if (linkedTagProvided) {
        await tx.run(
          "UPDATE definitions SET term = ?, definition = ?, linked_tag = ?, defined_by = ?, updated_at = ? WHERE id = ?",
          [term, definition, linkedTag, definedBy, now, existing.id],
        );
      } else {
        await tx.run(
          "UPDATE definitions SET term = ?, definition = ?, defined_by = ?, updated_at = ? WHERE id = ?",
          [term, definition, definedBy, now, existing.id],
        );
      }
    } else {
      await tx.run(
        `INSERT INTO definitions (id, nest_id, term, definition, linked_tag, defined_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, term, definition, linkedTag, definedBy, now, now],
      );
    }
  });
  const row = (await db.get(
    "SELECT * FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)",
    [nestId, term],
  )) as DefinitionRow;
  const created = row.created_at === now;
  return c.json({ definition: row }, created ? 201 : 200);
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
