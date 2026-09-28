/**
 * People directory — the read the add-a-person controls autocomplete against.
 *
 * Server-wide (not per-nest) because the question is "who could I add here?",
 * and the answer is drawn from every nest and team the caller already reaches.
 * The scoping rule lives in suggestPeopleForUser: you are offered the people
 * you already work with, never the deployment's whole member list.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { suggestPeopleForUser } from "./people-service.js";

export const peopleRoutes = new Hono<AuthEnv>();

// GET /people/suggest?q=&limit=
peopleRoutes.get("/suggest", async (c) => {
  const userId = c.get("userId");
  const q = c.req.query("q") ?? "";
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return c.json({ people: await suggestPeopleForUser(userId, q, limit) });
});
