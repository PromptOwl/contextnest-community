/**
 * GET /recipes — the recipe catalog a person picks from when they create a
 * nest (PO-1411). Global like /onboarding: it describes seeds the caller may
 * apply (bundled, and seed libraries they can read) and acts on no nest.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { listRecipes } from "./recipe-service.js";

export const recipeRoutes = new Hono<AuthEnv>();

recipeRoutes.get("/", async (c) => {
  // A nest-scoped key works inside one nest and never creates one.
  if (c.get("nestScope")) return c.json({ error: "This key is scoped to one nest and cannot create nests." }, 403);
  return c.json({ recipes: await listRecipes(c.get("userId")) });
});
