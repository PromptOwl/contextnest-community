/**
 * /nests/:nestId/boards — saved Board views (see board-service.ts).
 *
 * Tiering comes from the nest middleware in app.ts: GET is read-tier (anyone
 * who can see the nest sees its shared boards), every write is write-tier.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import {
  createBoard,
  deleteBoard,
  listBoards,
  rankColumn,
  updateBoard,
} from "./board-service.js";
import { permissionLevel } from "../shared/access.js";
import { ValidationError } from "../shared/errors.js";

export const boardRoutes = new Hono<AuthEnv>();

// A JSON body that isn't an object (null, "text", []) is a 400, not a TypeError.
async function jsonObject(c: { req: { json: () => Promise<unknown> } }) {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

boardRoutes.get("/", async (c) => {
  const boards = await listBoards(c.req.param("nestId")!, c.get("userId"));
  // Read tier reaches public/org visitors; like GET /collaborators, member
  // emails are for writers only.
  if (permissionLevel(c.get("nestPermission")) < permissionLevel("write")) {
    for (const b of boards) b.created_by_email = null;
  }
  return c.json({ boards });
});

boardRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const board = await createBoard(c.req.param("nestId")!, c.get("userId"), body);
  return c.json({ board }, 201);
});

boardRoutes.patch("/:boardId", async (c) => {
  const body = await jsonObject(c);
  const board = await updateBoard(
    c.req.param("nestId")!,
    c.req.param("boardId")!,
    c.get("userId"),
    body,
  );
  return c.json({ board });
});

// POST, not PATCH on /:boardId: it changes one column's order, merged
// server-side, so concurrent reorders of different columns don't clobber.
boardRoutes.post("/:boardId/rank", async (c) => {
  const body = await jsonObject(c);
  const board = await rankColumn(
    c.req.param("nestId")!,
    c.req.param("boardId")!,
    c.get("userId"),
    body,
  );
  return c.json({ board });
});

boardRoutes.delete("/:boardId", async (c) => {
  await deleteBoard(
    c.req.param("nestId")!,
    c.req.param("boardId")!,
    c.get("userId"),
    c.get("nestPermission"),
  );
  return c.json({ deleted: true });
});
