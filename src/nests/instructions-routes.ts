/**
 * /nests/:nestId/instructions — the nest's CONTEXT.md as a page people can
 * read and owners can edit, with history (CU-wdqcq05mty).
 *
 * Who: anyone who can read the nest reads (agents already get the same text
 * from `context_init`). Writes — save and restore — are owner/admin: the
 * access middleware (app.ts) requires the "admin" tier for every non-GET here.
 *
 * Agents: an API-key write on a nest that holds agent writes queues as a
 * pending push carrying only `context_md`, exactly as `ctx push` would; it
 * lands (and is recorded) when a reviewer confirms it.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { standingBlockFor, standingRefs } from "../governance/always-include-service.js";
import { heldWriteResponse, holdWriteIfGated } from "./push-confirmation-service.js";
import {
  getInstructions,
  getInstructionsRevision,
  listInstructionsRevisions,
  restoreInstructionsRevision,
  validateInstructions,
  writeInstructions,
} from "./instructions-service.js";

export const instructionsRoutes = new Hono<AuthEnv>();

/** `baseRevision` from a body: the seq the editor started from (0 = none). */
function baseFrom(body: { baseRevision?: unknown }): number | undefined {
  if (body.baseRevision === undefined || body.baseRevision === null) return undefined;
  const n = Number(body.baseRevision);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError("baseRevision must be a revision number (0 when there is none)");
  }
  return n;
}

function seqParam(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError("revision must be a number");
  return n;
}

instructionsRoutes.get("/instructions", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  // Which always-include documents travel with these instructions to every
  // agent (CU-wdqcq05rn0) — the ones THIS reader can read, without the text.
  const { set } = await standingBlockFor(nestId, {
    userId,
    userEmail: await resolveCallerEmail(userId),
  });
  return c.json({ ...(await getInstructions(nestId)), always_included: standingRefs(set) });
});

instructionsRoutes.put("/instructions", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ content?: unknown; note?: unknown; baseRevision?: unknown }>();
  const content = validateInstructions(body.content);
  const note = typeof body.note === "string" ? body.note : null;
  const baseSeq = baseFrom(body);
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);

  const keyId = c.get("apiKeyId") ?? null;
  if (keyId) {
    const pending = await holdWriteIfGated({
      nestId,
      userId,
      keyId,
      keyLabel: c.get("apiKeyLabel") ?? null,
      userEmail: email,
      payload: { context_md: content },
    });
    if (pending) return c.json(heldWriteResponse(nestId, pending), 202);
  }

  const revision = await writeInstructions(nestId, content, {
    authorEmail: email,
    note,
    source: keyId ? "api" : "ui",
    baseSeq,
  });
  return c.json({ content, revision });
});

instructionsRoutes.get("/instructions/revisions", async (c) => {
  return c.json({ revisions: await listInstructionsRevisions(c.req.param("nestId")!) });
});

instructionsRoutes.get("/instructions/revisions/:seq", async (c) => {
  return c.json(
    await getInstructionsRevision(c.req.param("nestId")!, seqParam(c.req.param("seq"))),
  );
});

instructionsRoutes.post("/instructions/revisions/:seq/restore", async (c) => {
  const nestId = c.req.param("nestId")!;
  const seq = seqParam(c.req.param("seq"));
  const body = await c.req.json<{ baseRevision?: unknown }>().catch(() => ({}));
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);

  // A restore is a write of old text: an agent's is held like any other.
  const keyId = c.get("apiKeyId") ?? null;
  if (keyId) {
    const { content } = await getInstructionsRevision(nestId, seq);
    const pending = await holdWriteIfGated({
      nestId,
      userId,
      keyId,
      keyLabel: c.get("apiKeyLabel") ?? null,
      userEmail: email,
      payload: { context_md: content },
    });
    if (pending) return c.json(heldWriteResponse(nestId, pending), 202);
  }

  const revision = await restoreInstructionsRevision(nestId, seq, {
    authorEmail: email,
    baseSeq: baseFrom(body),
  });
  return c.json({ content: (await getInstructions(nestId)).content, revision });
});
