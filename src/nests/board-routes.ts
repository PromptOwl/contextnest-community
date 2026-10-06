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

export const boardRoutes = new Hono<AuthEnv>();

boardRoutes.get("/", async (c) => {
  const boards = await listBoards(c.req.param("nestId")!, c.get("userId"));
  return c.json({ boards });
});

boardRoutes.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const board = await createBoard(c.req.param("nestId")!, c.get("userId"), body);
  return c.json({ board }, 201);
});

boardRoutes.patch("/:boardId", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
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
  const body = await c.req.json<Record<string, unknown>>();
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
