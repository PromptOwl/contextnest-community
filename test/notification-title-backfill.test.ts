import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// notify-service used to compose inbox messages from the node id, so historic
// rows read like "<nestId>/nodes/content/blog" instead of the document title.
// The write path is fixed; these rows are stored text, so a one-shot backfill
// rewrites them. Covers the plain id, the nest-prefixed id a caller was seen
// passing, two ids in one message, and an id whose document is long gone.
describe("backfill: notification titles", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let user: { apiKey: string; email: string };
  let nestId: string;
  let db: any;
  let backfill: (db: any) => Promise<void>;

  const insert = async (id: string, message: string) => {
    await db.run(
      `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
       VALUES (?, ?, ?, 'review_requested', 'x', ?, ?)`,
      [id, nestId, user.email, message, new Date().toISOString()],
    );
  };
  const messageOf = async (id: string): Promise<string> =>
    ((await db.get("SELECT message FROM notifications WHERE id = ?", [id])) as {
      message: string;
    }).message;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    user = await registerUser(app, "owner@acme.com", "Owner");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Backfill Vault" },
      user.apiKey,
    );
    nestId = nestData.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rate Limits", content: "# limits", folder: "api" },
      user.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Poster Agent", content: "# agent" },
      user.apiKey,
    );

    // Post-resetModules instances — the top-level graph is stale after
    // createTestApp, so grab the ones the running app actually uses.
    ({ getDb: db } = await import("../src/db/client.js"));
    db = db();
    ({ backfillNotificationTitles: backfill } = await import(
      "../src/db/backfill.js"
    ));
  }, 30000);

  afterAll(() => env.cleanup());

  it("rewrites stored ids to titles, once", async () => {
    await insert("n1", `"nodes/api/rate-limits" was approved by bob@acme.com`);
    // The composite id shape seen in the wild — nest uuid glued to the path.
    await insert(
      "n2",
      `"${nestId}/nodes/api/rate-limits" has a new version awaiting review (submitted by bob@acme.com)`,
    );
    await insert(
      "n3",
      `Agent "nodes/poster-agent" produced output on "nodes/api/rate-limits" — awaiting review`,
    );
    // Document deleted since: no title to resolve, must still not leak a path.
    await insert("n4", `"nodes/gone/old-doc" was rejected by bob@acme.com`);
    // Already clean — must be left exactly as-is.
    await insert("n5", `"Rate Limits (in api)" was approved by bob@acme.com`);

    await backfill(db);

    // Title + folder, matching what the write path composes today.
    expect(await messageOf("n1")).toBe(
      `"Rate Limits (in api)" was approved by bob@acme.com`,
    );
    expect(await messageOf("n2")).toBe(
      `"Rate Limits (in api)" has a new version awaiting review (submitted by bob@acme.com)`,
    );
    expect(await messageOf("n3")).toBe(
      `Agent "Poster Agent" produced output on "Rate Limits (in api)" — awaiting review`,
    );
    // Falls back to the slug, never the full path.
    expect(await messageOf("n4")).toBe(
      `"old-doc (in gone)" was rejected by bob@acme.com`,
    );
    expect(await messageOf("n5")).toBe(
      `"Rate Limits (in api)" was approved by bob@acme.com`,
    );

    // No message anywhere still carries a storage path.
    const all = (await db.all("SELECT message FROM notifications")) as Array<{
      message: string;
    }>;
    expect(all.every((r) => !r.message.includes("nodes/"))).toBe(true);

    // Gated: a second run is a no-op, so a row written after the backfill
    // (already correct) is never double-rewritten.
    await insert("n6", `"nodes/api/rate-limits" was approved by late@acme.com`);
    await backfill(db);
    expect(await messageOf("n6")).toBe(
      `"nodes/api/rate-limits" was approved by late@acme.com`,
    );
  });
});
