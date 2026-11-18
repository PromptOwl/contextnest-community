/**
 * POST /nests/:nestId/cards — batch-resolve artifact cards for the caller
 * (PO-1181, agent team stream S3). See artifact-cards.ts for the rules.
 *
 *   { links: string[] }  → { cards: ArtifactCard[] }            (same order)
 *   { texts: string[] }  → { messages: [{ cards: ArtifactCard[] }] } (links extracted per text)
 *
 * A read: the nest middleware (app.ts) admits it at read tier like the other
 * read-query POSTs (search, query, context), including for a document-share
 * grantee and a read-only key; every card is still checked against the
 * caller's own read access, node by node.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { ValidationError } from "../shared/errors.js";
import { MAX_LINKS_PER_REQUEST, resolveCards, resolveMessageCards, type CardViewer } from "./artifact-cards.js";

export const cardRoutes = new Hono<AuthEnv>();

/** Most texts one request may carry (a long comment panel is one call). */
const MAX_TEXTS = 200;
const MAX_TEXT_LENGTH = 20_000;

function stringList(v: unknown, name: string, max: number, maxLen: number): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ValidationError(`${name} must be an array of strings`);
  }
  if (v.length > max) throw new ValidationError(`${name} takes at most ${max} entries`);
  return (v as string[]).map((s) => s.slice(0, maxLen));
}

cardRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object with links or texts");
  }
  const b = body as Record<string, unknown>;
  const userId = c.get("userId") as string;
  const viewer: CardViewer = {
    nestId: c.req.param("nestId") as string,
    userId,
    userEmail: await resolveCallerEmail(userId),
    crossNest: !c.get("nestScope"),
  };
  if (b.links !== undefined) {
    const links = stringList(b.links, "links", MAX_LINKS_PER_REQUEST, 2048);
    return c.json({ cards: await resolveCards(viewer, links) });
  }
  if (b.texts !== undefined) {
    const texts = stringList(b.texts, "texts", MAX_TEXTS, MAX_TEXT_LENGTH);
    const per = await resolveMessageCards(viewer, texts);
    return c.json({ messages: per.map((cards) => ({ cards })) });
  }
  throw new ValidationError("pass links (an array of link strings) or texts (an array of message bodies)");
});
