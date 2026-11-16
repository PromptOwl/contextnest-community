/**
 * GET /nests/:nestId/contributions/mine — the caller's own unpublished
 * contributions in this nest (CU-wdqcq05rz6).
 *
 * An org contributor reads the nest as a visibility-only reader, so the node
 * list and the document view show approved content only — their own draft
 * included. This is where they find it again: every document whose newest
 * version is an unreviewed one THEY wrote, with its text. Read tier (the
 * /nests access gate already required read); the author is in the query's
 * WHERE clause, so nobody else's draft can come back from here.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { listMyContributions } from "../governance/org-contribution.js";

export const contributionRoutes = new Hono<AuthEnv>();

contributionRoutes.get("/mine", async (c) => {
  const nestId = c.req.param("nestId")!;
  const email = await resolveCallerEmail(c.get("userId"));
  return c.json({ contributions: await listMyContributions(nestId, email) });
});
