import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// canUserApproveMany resolves the approve check for many documents in a fixed
// number of queries. It is an access check, so it must give EXACTLY the verdict
// canUserApprove gives for every document — checked here across steward scopes
// (document / tag / nest), owner and super-admin with self-approve off and on,
// own vs teammate submissions, and a document with no pending review.
describe("canUserApproveMany", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let nestId: string;
  let db: any;
  let svc: typeof import("../src/governance/stewardship-service.js");
  const nodes = ["nodes/a", "nodes/b", "nodes/c", "nodes/d", "nodes/e"];
  const users = [
    "owner@acme.com",
    "super@acme.com",
    "docrev@acme.com",
    "DocRev@acme.com",
    "tagrev@acme.com",
    "nestrev@acme.com",
    "editor@acme.com",
    "viewer@acme.com",
    "outsider@acme.com",
  ];

  beforeAll(async () => {
    env = setupTestEnv();
    const app = await createTestApp("key", { superAdmins: ["super@acme.com"] });
    const owner = await registerUser(app, "owner@acme.com", "Owner");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Approve Many" }, owner.apiKey);
    nestId = data.nest.id;
    db = (await import("../src/db/client.js")).getDb();
    svc = await import("../src/governance/stewardship-service.js");

    const steward = (id: string, scope: string, email: string, role: string, node?: string, tag?: string) =>
      db.run(
        `INSERT INTO stewards (id, nest_id, scope, node_pattern, tag_name, user_email, role, assigned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'owner@acme.com')`,
        [id, nestId, scope, node ?? null, tag ?? null, email, role],
      );
    await steward("s1", "document", "docrev@acme.com", "reviewer", "nodes/a");
    await steward("s2", "tag", "tagrev@acme.com", "reviewer", undefined, "#t");
    await steward("s3", "nest", "nestrev@acme.com", "reviewer");
    await steward("s4", "document", "editor@acme.com", "editor", "nodes/a");
    await steward("s5", "nest", "viewer@acme.com", "viewer");
    for (const node of ["nodes/a", "nodes/c"]) {
      await db.run("INSERT INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, '#t')", [nestId, node]);
    }
    const pending = (id: string, node: string, by: string) =>
      db.run(
        `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, priority)
         VALUES (?, ?, ?, 1, ?, 'normal')`,
        [id, nestId, node, by],
      );
    await pending("r1", "nodes/a", "docrev@acme.com");
    await pending("r2", "nodes/b", "owner@acme.com");
    await pending("r3", "nodes/c", "tagrev@acme.com");
    // nodes/d: no pending review — the latest version's author is the actor.
    for (const [version, author] of [[1, "someone@acme.com"], [2, "nestrev@acme.com"]] as const) {
      await db.run(
        `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status)
         VALUES (?, 'nodes/d', ?, 'h', ?, 'published')`,
        [nestId, version, author],
      );
    }
    // nodes/e: no pending review and no versions — no actor at all.
  }, 30000);

  afterAll(() => env.cleanup());

  for (const selfApprove of [0, 1]) {
    it(`matches canUserApprove for every user and document (self-approve ${selfApprove ? "on" : "off"})`, async () => {
      await db.run("UPDATE nests SET allow_self_approve = ? WHERE id = ?", [selfApprove, nestId]);
      const seen = new Set<boolean>();
      for (const user of users) {
        const many = await svc.canUserApproveMany(nestId, nodes, user);
        for (const node of nodes) {
          expect({ user, node, verdict: many.get(node) }).toEqual({
            user,
            node,
            verdict: await svc.canUserApprove(nestId, node, user),
          });
          seen.add(many.get(node)!.allowed);
        }
      }
      // The matrix must exercise both outcomes, or matching proves nothing.
      expect([...seen].sort()).toEqual([false, true]);
    });
  }

  it("runs a fixed number of queries however many documents", async () => {
    let queries = 0;
    const count = <T extends (...a: any[]) => any>(fn: T) =>
      ((...a: any[]) => {
        queries++;
        return fn.apply(db, a);
      }) as T;
    const realGet = db.get;
    const realAll = db.all;
    db.get = count(realGet);
    db.all = count(realAll);
    try {
      queries = 0;
      // Both include a document with no pending review (one extra author query).
      await svc.canUserApproveMany(nestId, ["nodes/a", "nodes/d"], "nestrev@acme.com");
      const forTwo = queries;
      queries = 0;
      await svc.canUserApproveMany(nestId, nodes, "nestrev@acme.com");
      expect(queries).toBe(forTwo);
    } finally {
      db.get = realGet;
      db.all = realAll;
    }
  });

  it("canUserApprove skips the requester query when the caller passes it", async () => {
    const realGet = db.get;
    let requesterQueries = 0;
    db.get = (sql: string, ...rest: any[]) => {
      if (/SELECT requested_by FROM review_requests/.test(sql)) requesterQueries++;
      return realGet.call(db, sql, ...rest);
    };
    try {
      const looked = await svc.canUserApprove(nestId, "nodes/a", "nestrev@acme.com");
      expect(requesterQueries).toBe(1);
      requesterQueries = 0;
      const passed = await svc.canUserApprove(nestId, "nodes/a", "nestrev@acme.com", {
        requestedBy: "docrev@acme.com",
      });
      expect(requesterQueries).toBe(0);
      expect(passed).toEqual(looked);
    } finally {
      db.get = realGet;
    }
  });
});
