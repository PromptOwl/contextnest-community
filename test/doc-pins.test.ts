/**
 * Experimental document pins (CU-wdqcq02crw).
 *
 * Two kinds of pin on a document, both behind EXPERIMENTAL_DOC_PINS:
 *   - editorial (scope "nest"): a steward pins for everyone, in an order they
 *     choose. Owner, nest admin, server admin or a nest-wide reviewer steward.
 *   - personal (scope "user"): my own bookmark, visible only to me. Needs only
 *     read access to the document.
 *
 * Locked here:
 *   1. The switch: off → every pin route 404s; a server admin flips it through
 *      PATCH /admin/settings and the routes answer at once (no restart); a
 *      non-admin PATCH is 403. /health reports experimental.doc_pins.
 *   2. Editorial pins: steward pins + reorders, every member sees the order;
 *      a write collaborator (plain editor) is 403.
 *   3. Personal pins: only the pinner sees them; a read collaborator may pin.
 *   4. Cascade: node delete, user delete, leaving the nest, nest delete.
 *   5. Filtering: a pinned document the caller can't read is left out, and a
 *      row pointing at a missing document is never returned.
 *   6. Unlicensed (real license module) → 503.
 *   7. Regressions: nest_pins (dashboard nest bookmarks) unchanged; the other
 *      admin switches (workflow plane, metacognition) PATCH and report as before.
 *   8. Schema: the scope/user_id CHECK and per-scope uniqueness hold (SQLite;
 *      Postgres too when TEST_DATABASE_URL is set).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
  seedPeople,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

const SUPER = "super@acme.com";

async function db() {
  const { getDb } = await import("../src/db/client.js");
  return getDb();
}

async function pinRows(where = "1 = 1", params: unknown[] = []): Promise<any[]> {
  return (await (await db()).all(`SELECT * FROM node_pins WHERE ${where}`, params as any)) as any[];
}

async function persistedSetting(key: string): Promise<string | null | undefined> {
  const row = (await (await db()).get("SELECT value FROM server_settings WHERE key = ?", [key])) as
    | { value: string | null }
    | undefined;
  return row ? row.value : undefined;
}

describe("document pins", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let superUser: User; // server admin (license owner + superadmin)
  let owner: User; // nest owner, NOT a server admin
  let steward: User; // read collaborator + nest-wide reviewer steward
  let editor: User; // write collaborator, no steward row
  let reader: User; // read collaborator
  let grantee: User; // no collaborator row; document grants only
  let leaver: User; // read collaborator who will leave
  let doomed: User; // read collaborator who will be deleted
  let nestId: string;
  const ids: Record<string, string> = {};

  const pinsUrl = (n = nestId) => `/nests/${n}/pins`;
  const pin = (u: User, nodeId: string, scope: string, n = nestId) =>
    jsonRequest(app, "POST", pinsUrl(n), { node_id: nodeId, scope }, u.apiKey);
  const unpin = (u: User, nodeId: string, scope: string, n = nestId) =>
    jsonRequest(
      app,
      "DELETE",
      `${pinsUrl(n)}?node_id=${encodeURIComponent(nodeId)}&scope=${scope}`,
      undefined,
      u.apiKey,
    );
  const getPins = (u: User, n = nestId) => jsonRequest(app, "GET", pinsUrl(n), undefined, u.apiKey);
  const reorder = (u: User, nodeIds: string[], n = nestId) =>
    jsonRequest(app, "PUT", `${pinsUrl(n)}/order`, { node_ids: nodeIds }, u.apiKey);

  async function createDoc(title: string, n = nestId): Promise<string> {
    const res = await jsonRequest(app, "POST", `/nests/${n}/nodes`, { title, content: `# ${title}` }, owner.apiKey);
    expect(res.status).toBe(201);
    return res.data.node.id as string;
  }

  beforeAll(async () => {
    env = setupTestEnv();
    delete process.env.EXPERIMENTAL_DOC_PINS;
    app = await createTestApp("key", { ownerEmail: SUPER, superAdmins: [SUPER] });
    superUser = await registerUser(app, SUPER, "Super");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    steward = await registerUser(app, "steward@acme.com", "Steward");
    await resetAuthRateLimit();
    editor = await registerUser(app, "editor@acme.com", "Editor");
    reader = await registerUser(app, "reader@acme.com", "Reader");
    grantee = await registerUser(app, "grantee@acme.com", "Grantee");
    await resetAuthRateLimit();
    leaver = await registerUser(app, "leaver@acme.com", "Leaver");
    doomed = await registerUser(app, "doomed@acme.com", "Doomed");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Pins" }, owner.apiKey);
    nestId = data.nest.id;
    for (const [u, permission] of [
      [steward, "read"],
      [editor, "write"],
      [reader, "read"],
      [leaver, "read"],
      [doomed, "read"],
    ] as const) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
      expect(r.status).toBeLessThan(300);
    }
    const st = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: steward.email, role: "reviewer" }] },
      owner.apiKey,
    );
    expect(st.status).toBeLessThan(300);

    for (const t of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) ids[t] = await createDoc(t);
  }, 60000);

  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_PINS;
    return env.cleanup();
  });

  // ─── 1. The switch ────────────────────────────────────────────────────
  describe("the EXPERIMENTAL_DOC_PINS switch", () => {
    it("is off by default: /health and /admin/settings report it off", async () => {
      const health = await jsonRequest(app, "GET", "/health");
      expect(health.data.experimental).toEqual({ doc_pins: false });
      const settings = await jsonRequest(app, "GET", "/admin/settings", undefined, superUser.apiKey);
      expect(settings.data.experimental_doc_pins).toBe(false);
    });

    it("off → every pin route 404s, for every caller", async () => {
      for (const u of [owner, superUser, reader]) {
        expect((await getPins(u)).status).toBe(404);
        expect((await pin(u, ids.Alpha, "user")).status).toBe(404);
        expect((await unpin(u, ids.Alpha, "user")).status).toBe(404);
        expect((await reorder(u, [ids.Alpha])).status).toBe(404);
      }
      expect(await pinRows()).toEqual([]);
    });

    it("a non-admin (even the nest owner) cannot flip it: 403, nothing persisted", async () => {
      for (const u of [owner, steward, editor]) {
        const res = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_doc_pins: true }, u.apiKey);
        expect(res.status).toBe(403);
      }
      expect(await persistedSetting("EXPERIMENTAL_DOC_PINS")).toBeUndefined();
      expect((await getPins(owner)).status).toBe(404);
    });

    it("a server admin turns it on and the routes answer immediately (no restart)", async () => {
      const on = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_doc_pins: true }, superUser.apiKey);
      expect(on.status).toBe(200);
      expect(on.data.settings.experimental_doc_pins).toBe(true);
      expect(await persistedSetting("EXPERIMENTAL_DOC_PINS")).toBe("true");
      expect((await jsonRequest(app, "GET", "/health")).data.experimental).toEqual({ doc_pins: true });

      const res = await getPins(reader);
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ editorial: [], personal: [], can_pin_editorial: false });
    });

    it("turning it off again 404s the routes and clears the row; back on for the rest", async () => {
      const off = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_doc_pins: false }, superUser.apiKey);
      expect(off.data.settings.experimental_doc_pins).toBe(false);
      expect(await persistedSetting("EXPERIMENTAL_DOC_PINS")).toBeNull();
      expect((await getPins(owner)).status).toBe(404);
      const on = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_doc_pins: true }, superUser.apiKey);
      expect(on.status).toBe(200);
    });
  });

  // ─── 2. Editorial pins ────────────────────────────────────────────────
  describe("editorial pins (scope nest)", () => {
    it("a nest-wide reviewer steward pins two documents; repeat is idempotent", async () => {
      const a = await pin(steward, ids.Alpha, "nest");
      expect(a.status).toBe(201);
      expect(a.data.pin).toMatchObject({ node_id: ids.Alpha, scope: "nest" });
      expect((await pin(steward, ids.Bravo, "nest")).status).toBe(201);
      // Pinning again is a no-op, not a constraint error.
      expect((await pin(steward, ids.Alpha, "nest")).status).toBe(201);
      expect(await pinRows("scope = 'nest'")).toHaveLength(2);
    });

    it("everyone sees them in pin order, with titles", async () => {
      for (const u of [owner, steward, editor, reader]) {
        const res = await getPins(u);
        expect(res.status).toBe(200);
        expect(res.data.editorial.map((p: any) => p.node_id)).toEqual([ids.Alpha, ids.Bravo]);
        expect(res.data.editorial[0].title).toBe("Alpha");
      }
      // Who pinned it is an email — curators see it, everyone else doesn't
      // (a grantee or reader can't otherwise list the nest's members).
      expect((await getPins(steward)).data.editorial[0].pinned_by).toBe(steward.email);
      for (const u of [editor, reader]) {
        expect((await getPins(u)).data.editorial.every((p: any) => p.pinned_by === null)).toBe(true);
      }
      expect((await getPins(steward)).data.can_pin_editorial).toBe(true);
      expect((await getPins(owner)).data.can_pin_editorial).toBe(true);
      expect((await getPins(editor)).data.can_pin_editorial).toBe(false);
    });

    it("two concurrent pins of the same document both succeed and leave one row", async () => {
      const [a, b] = await Promise.all([pin(owner, ids.Foxtrot, "nest"), pin(owner, ids.Foxtrot, "nest")]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await pinRows("scope = 'nest' AND node_id = ?", [ids.Foxtrot])).toHaveLength(1);
      expect((await unpin(owner, ids.Foxtrot, "nest")).data.unpinned).toBe(true);
    });

    it("PUT /pins/order reverses them, for every member", async () => {
      const res = await reorder(steward, [ids.Bravo, ids.Alpha]);
      expect(res.status).toBe(200);
      expect(res.data.editorial.map((p: any) => p.node_id)).toEqual([ids.Bravo, ids.Alpha]);
      for (const u of [owner, editor, reader]) {
        expect((await getPins(u)).data.editorial.map((p: any) => p.node_id)).toEqual([ids.Bravo, ids.Alpha]);
      }
    });

    it("a reorder must list every editorial pin exactly once", async () => {
      expect((await reorder(steward, [ids.Bravo])).status).toBe(400);
      expect((await reorder(steward, [ids.Bravo, ids.Bravo])).status).toBe(400);
      expect((await reorder(steward, [ids.Bravo, ids.Alpha, ids.Charlie])).status).toBe(400);
      expect((await jsonRequest(app, "PUT", `${pinsUrl()}/order`, { node_ids: "x" }, steward.apiKey)).status).toBe(400);
    });

    it("a plain editor (write collaborator) and a reader get 403 on every editorial write", async () => {
      for (const u of [editor, reader]) {
        expect((await pin(u, ids.Charlie, "nest")).status).toBe(403);
        expect((await unpin(u, ids.Alpha, "nest")).status).toBe(403);
        expect((await reorder(u, [ids.Alpha, ids.Bravo])).status).toBe(403);
      }
      expect(await pinRows("scope = 'nest'")).toHaveLength(2);
    });

    it("the owner unpins one; idempotent", async () => {
      expect((await pin(owner, ids.Charlie, "nest")).status).toBe(201);
      expect((await getPins(reader)).data.editorial.map((p: any) => p.node_id)).toEqual([
        ids.Bravo,
        ids.Alpha,
        ids.Charlie,
      ]);
      const res = await unpin(owner, ids.Charlie, "nest");
      expect(res.status).toBe(200);
      expect(res.data.unpinned).toBe(true);
      expect((await unpin(owner, ids.Charlie, "nest")).data.unpinned).toBe(false);
      expect((await getPins(reader)).data.editorial.map((p: any) => p.node_id)).toEqual([ids.Bravo, ids.Alpha]);
    });
  });

  // ─── 3. Personal pins ─────────────────────────────────────────────────
  describe("personal pins (scope user)", () => {
    it("an editor's personal pin appears in their list only", async () => {
      expect((await pin(editor, ids.Delta, "user")).status).toBe(201);
      expect((await pin(editor, ids.Delta, "user")).status).toBe(201); // idempotent
      const mine = await getPins(editor);
      expect(mine.data.personal.map((p: any) => p.node_id)).toEqual([ids.Delta]);
      for (const u of [reader, owner, steward]) {
        expect((await getPins(u)).data.personal.map((p: any) => p.node_id)).not.toContain(ids.Delta);
      }
      // A personal pin never shows up as editorial.
      expect(mine.data.editorial.map((p: any) => p.node_id)).not.toContain(ids.Delta);
    });

    it("a read collaborator may pin for themselves (read access is enough)", async () => {
      const res = await pin(reader, ids.Echo, "user");
      expect(res.status).toBe(201);
      expect((await getPins(reader)).data.personal.map((p: any) => p.node_id)).toEqual([ids.Echo]);
    });

    it("two people pinning the same document keep separate rows; unpin removes only mine", async () => {
      expect((await pin(reader, ids.Delta, "user")).status).toBe(201);
      expect(await pinRows("scope = 'user' AND node_id = ?", [ids.Delta])).toHaveLength(2);
      expect((await unpin(reader, ids.Delta, "user")).data.unpinned).toBe(true);
      expect((await getPins(editor)).data.personal.map((p: any) => p.node_id)).toEqual([ids.Delta]);
    });

    it("validates scope and the document", async () => {
      expect((await pin(reader, ids.Alpha, "everyone")).status).toBe(400);
      expect((await jsonRequest(app, "POST", pinsUrl(), { scope: "user" }, reader.apiKey)).status).toBe(400);
      expect((await pin(reader, "nodes/does-not-exist", "user")).status).toBe(404);
      expect((await pin(owner, "nodes/does-not-exist", "nest")).status).toBe(404);
      expect((await jsonRequest(app, "DELETE", `${pinsUrl()}?node_id=${ids.Alpha}&scope=bogus`, undefined, reader.apiKey)).status).toBe(400);
    });

    it("a stranger with no access to the nest gets 404 (no existence oracle)", async () => {
      await resetAuthRateLimit();
      const stranger = await registerUser(app, "stranger@acme.com", "Stranger");
      expect((await getPins(stranger)).status).toBe(404);
      expect((await pin(stranger, ids.Alpha, "user")).status).toBe(404);
    });
  });

  // ─── 5. Filtering ─────────────────────────────────────────────────────
  describe("filtering by read access", () => {
    let grantA: string;

    it("a document-grant caller sees only the pins on documents they can read", async () => {
      const g1 = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/grants`,
        { target_type: "document", target: ids.Alpha, email: grantee.email, role: "read" },
        owner.apiKey,
      );
      expect(g1.status).toBe(201);
      grantA = g1.data.grant.id;
      const g2 = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/grants`,
        { target_type: "document", target: ids.Foxtrot, email: grantee.email, role: "read" },
        owner.apiKey,
      );
      expect(g2.status).toBe(201);

      // Editorial pins are Bravo, Alpha — the grantee reads only Alpha.
      const res = await getPins(grantee);
      expect(res.status).toBe(200);
      expect(res.data.editorial.map((p: any) => p.node_id)).toEqual([ids.Alpha]);

      // A personal pin on a granted doc works; on an ungranted doc it 404s.
      expect((await pin(grantee, ids.Alpha, "user")).status).toBe(201);
      expect((await pin(grantee, ids.Bravo, "user")).status).toBe(404);
      expect((await getPins(grantee)).data.personal.map((p: any) => p.node_id)).toEqual([ids.Alpha]);
    });

    it("losing read access filters the pinned document out of both lists", async () => {
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/grants/${grantA}`, undefined, owner.apiKey);
      expect(del.status).toBeLessThan(300);
      const res = await getPins(grantee);
      expect(res.status).toBe(200);
      expect(res.data.editorial).toEqual([]);
      expect(res.data.personal).toEqual([]);
    });

    it("a row pointing at a missing document is never returned (no dangling ids)", async () => {
      const d = await db();
      await d.run(
        "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position, pinned_by) VALUES (?, ?, ?, 'nest', NULL, 99, ?)",
        ["ghost-pin", nestId, "nodes/ghost", owner.email],
      );
      const res = await getPins(owner);
      const visible = res.data.editorial.map((p: any) => p.node_id);
      expect(visible).not.toContain("nodes/ghost");
      // …and the reorder a client can actually send (only what it sees) still
      // works — a dangling row must not make every reorder a 400.
      const re = await reorder(owner, [...visible].reverse());
      expect(re.status).toBe(200);
      expect(re.data.editorial.map((p: any) => p.node_id)).toEqual([...visible].reverse());
      await reorder(owner, visible);
      await d.run("DELETE FROM node_pins WHERE id = 'ghost-pin'", []);
    });
  });

  // ─── 4. Cascade ───────────────────────────────────────────────────────
  describe("cascade", () => {
    it("moving a pinned document carries its pins to the new id", async () => {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${ids.Delta}/move`, { folder: "moved" }, owner.apiKey);
      expect(res.status).toBe(200);
      const newId = res.data.node?.id ?? res.data.id;
      expect(newId).toBeTruthy();
      expect(newId).not.toBe(ids.Delta);
      expect(await pinRows("node_id = ?", [ids.Delta])).toHaveLength(0);
      expect((await getPins(editor)).data.personal.map((p: any) => p.node_id)).toEqual([newId]);
      ids.Delta = newId;
    });

    it("moving onto an id that holds a stale pin row still succeeds and carries the pin", async () => {
      const src = await createDoc("Mover");
      expect((await pin(owner, src, "nest")).status).toBe(201);
      // A stale row on the destination id (its document vanished outside the
      // app, so no delete hook ran). The repoint must not trip the unique index.
      const dest = "nodes/landing/mover";
      await (await db()).run(
        "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('stale-dest', ?, ?, 'nest', NULL, 77)",
        [nestId, dest],
      );
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${src}/move`, { folder: "landing" }, owner.apiKey);
      expect(res.status).toBe(200);
      const newId = res.data.node?.id ?? res.data.id;
      expect(newId).toBe(dest);
      const rows = await pinRows("node_id = ? AND scope = 'nest'", [dest]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe("stale-dest");
      expect((await getPins(reader)).data.editorial.map((p: any) => p.node_id)).toContain(dest);
      expect((await unpin(owner, dest, "nest")).status).toBe(200);
    });

    it("deleting the node removes every pin row on it", async () => {
      expect((await pin(owner, ids.Echo, "nest")).status).toBe(201);
      // reader holds a personal pin on Echo too.
      expect((await pinRows("node_id = ?", [ids.Echo])).length).toBe(2);
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${ids.Echo}`, undefined, owner.apiKey);
      expect(del.status).toBe(200);
      expect(await pinRows("node_id = ?", [ids.Echo])).toHaveLength(0);
      const res = await getPins(reader);
      expect(res.data.editorial.map((p: any) => p.node_id)).not.toContain(ids.Echo);
      expect(res.data.personal.map((p: any) => p.node_id)).not.toContain(ids.Echo);
    });

    it("leaving the nest removes the leaver's personal pins there", async () => {
      expect((await pin(leaver, ids.Bravo, "user")).status).toBe(201);
      const res = await jsonRequest(app, "POST", `/me/nests/${nestId}/leave`, undefined, leaver.apiKey);
      expect(res.status).toBe(200);
      expect(res.data.left).toBe(true);
      expect(await pinRows("user_id = ?", [leaver.userId])).toHaveLength(0);
      // Editorial pins are the nest's, not the leaver's.
      expect(await pinRows("scope = 'nest'")).not.toHaveLength(0);
    });

    it("a removed collaborator who still reaches the nest (a share grant) keeps their pins — same rule as leaving", async () => {
      await resetAuthRateLimit();
      const stays = await registerUser(app, "stays@acme.com", "Stays");
      expect(
        (await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target: ids.Bravo, email: stays.email, role: "read" }, owner.apiKey)).status,
      ).toBe(201);
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: stays.email, permission: "read" }, owner.apiKey)).status).toBeLessThan(300);
      expect((await pin(stays, ids.Bravo, "user")).status).toBe(201);
      const roster = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, owner.apiKey);
      const row = (roster.data.collaborators ?? roster.data).find((r: any) => (r.email ?? r.user_email) === stays.email);
      expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/collaborators/${row.id}`, undefined, owner.apiKey)).status).toBe(200);
      expect(await pinRows("user_id = ?", [stays.userId])).toHaveLength(1);
      expect((await getPins(stays)).data.personal.map((p: any) => p.node_id)).toEqual([ids.Bravo]);
    });

    it("being removed as a collaborator removes their personal pins there", async () => {
      await resetAuthRateLimit();
      const removed = await registerUser(app, "removed@acme.com", "Removed");
      const add = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: removed.email, permission: "read" }, owner.apiKey);
      expect(add.status).toBeLessThan(300);
      expect((await pin(removed, ids.Bravo, "user")).status).toBe(201);
      const roster = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, owner.apiKey);
      const row = (roster.data.collaborators ?? roster.data).find((r: any) => (r.email ?? r.user_email) === removed.email);
      expect(row?.id).toBeTruthy();
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/collaborators/${row.id}`, undefined, owner.apiKey);
      expect(del.status).toBe(200);
      expect(await pinRows("user_id = ?", [removed.userId])).toHaveLength(0);
    });

    it("deleting the user removes their personal pins; editorial pins they made stay", async () => {
      expect((await pin(doomed, ids.Bravo, "user")).status).toBe(201);
      const before = await pinRows("scope = 'nest'");
      const res = await jsonRequest(app, "DELETE", `/auth/users/${doomed.userId}`, undefined, superUser.apiKey);
      expect(res.status).toBe(200);
      expect(await pinRows("user_id = ?", [doomed.userId])).toHaveLength(0);
      expect(await pinRows("scope = 'nest'")).toHaveLength(before.length);
    });

    it("deleting the steward who made editorial pins leaves the pins in place", async () => {
      // The steward pinned Alpha and Bravo; they belong to the nest.
      const before = (await getPins(reader)).data.editorial.map((p: any) => p.node_id);
      expect(before).toEqual([ids.Bravo, ids.Alpha]);
      const res = await jsonRequest(app, "DELETE", `/auth/users/${steward.userId}`, undefined, superUser.apiKey);
      expect(res.status).toBe(200);
      expect((await getPins(reader)).data.editorial.map((p: any) => p.node_id)).toEqual(before);
    });

    it("deleting the nest removes every pin row in it", async () => {
      const { data } = await jsonRequest(app, "POST", "/nests", { name: "Doomed nest" }, owner.apiKey);
      const otherNest = data.nest.id;
      const doc = await createDoc("Throwaway", otherNest);
      expect((await pin(owner, doc, "nest", otherNest)).status).toBe(201);
      expect((await pin(owner, doc, "user", otherNest)).status).toBe(201);
      expect(await pinRows("nest_id = ?", [otherNest])).toHaveLength(2);
      const del = await jsonRequest(app, "DELETE", `/nests/${otherNest}`, undefined, owner.apiKey);
      expect(del.status).toBeLessThan(300);
      expect(await pinRows("nest_id = ?", [otherNest])).toHaveLength(0);
    });
  });

  // ─── archived nest ────────────────────────────────────────────────────
  it("an archived nest refuses editorial changes but still lists its pins", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Archive me" }, owner.apiKey);
    const n = data.nest.id;
    const doc = await createDoc("Kept", n);
    expect((await pin(owner, doc, "nest", n)).status).toBe(201);
    expect((await jsonRequest(app, "POST", `/nests/${n}/archive`, undefined, owner.apiKey)).status).toBeLessThan(300);
    expect((await unpin(owner, doc, "nest", n)).status).toBe(403);
    // A personal pin is the reader's own bookmark, not nest content — like a
    // dashboard nest pin, it stays allowed on an archived nest (pinned here so
    // the behaviour is a decision, not an accident).
    expect((await pin(owner, doc, "user", n)).status).toBe(201);
    expect((await unpin(owner, doc, "user", n)).data.unpinned).toBe(true);
    const res = await getPins(owner, n);
    expect(res.status).toBe(200);
    expect(res.data.editorial.map((p: any) => p.node_id)).toEqual([doc]);
    expect(res.data.can_pin_editorial).toBe(false);
  });

  // ─── 7. Regressions ───────────────────────────────────────────────────
  describe("regressions", () => {
    it("nest_pins (dashboard nest bookmarks) work unchanged with the switch on", async () => {
      const p = await jsonRequest(app, "POST", `/nests/${nestId}/pin`, undefined, reader.apiKey);
      expect(p.status).toBeLessThan(300);
      let list = await jsonRequest(app, "GET", "/nests", undefined, reader.apiKey);
      expect(list.data.nests.find((n: any) => n.id === nestId).pinned).toBe(true);
      // Owner's view of the same nest is unaffected by the reader's bookmark.
      list = await jsonRequest(app, "GET", "/nests", undefined, owner.apiKey);
      expect(list.data.nests.find((n: any) => n.id === nestId).pinned).toBe(false);
      // And document pins never leak into nest_pins.
      const rows = (await (await db()).all("SELECT * FROM nest_pins", [])) as any[];
      expect(rows).toHaveLength(1);
      const u = await jsonRequest(app, "DELETE", `/nests/${nestId}/pin`, undefined, reader.apiKey);
      expect(u.status).toBeLessThan(300);
      list = await jsonRequest(app, "GET", "/nests", undefined, reader.apiKey);
      expect(list.data.nests.find((n: any) => n.id === nestId).pinned).toBe(false);
    });

    it("nest_pins work unchanged with the switch off", async () => {
      process.env.EXPERIMENTAL_DOC_PINS = "false";
      try {
        const p = await jsonRequest(app, "POST", `/nests/${nestId}/pin`, undefined, reader.apiKey);
        expect(p.status).toBeLessThan(300);
        const list = await jsonRequest(app, "GET", "/nests", undefined, reader.apiKey);
        expect(list.data.nests.find((n: any) => n.id === nestId).pinned).toBe(true);
        await jsonRequest(app, "DELETE", `/nests/${nestId}/pin`, undefined, reader.apiKey);
      } finally {
        process.env.EXPERIMENTAL_DOC_PINS = "true";
      }
    });

    it("a document whose slug is 'pins' is still an ordinary document", async () => {
      const id = await createDoc("Pins");
      const get = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, reader.apiKey);
      expect(get.status).toBe(200);
      // A reader must not be able to delete it through the pins read tier.
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${id}`, undefined, reader.apiKey);
      expect(del.status).toBe(403);
    });

    it("workflow plane + metacognition switches PATCH and report exactly as before, alongside doc pins", async () => {
      const res = await jsonRequest(
        app,
        "PATCH",
        "/admin/settings",
        { workflow_plane_enabled: true, metacognition_enabled: true, experimental_doc_pins: true },
        superUser.apiKey,
      );
      expect(res.status).toBe(200);
      expect(res.data.settings).toMatchObject({
        workflow_plane_enabled: true,
        metacognition_enabled: true,
        experimental_doc_pins: true,
      });
      const health = await jsonRequest(app, "GET", "/health");
      expect(health.data.workflow_plane_enabled).toBe(true);
      expect(health.data.metacognition_enabled).toBe(true);
      expect(health.data.experimental).toEqual({ doc_pins: true });
      expect(await persistedSetting("FEATURE_WORKFLOW_PLANE")).toBe("true");
      expect(await persistedSetting("FEATURE_METACOGNITION")).toBe("true");

      // The metacognition dependency rule is untouched.
      const bad = await jsonRequest(
        app,
        "PATCH",
        "/admin/settings",
        { workflow_plane_enabled: false, metacognition_enabled: true },
        superUser.apiKey,
      );
      expect(bad.status).toBe(400);
      expect(bad.data.fieldErrors).toHaveProperty("metacognition_enabled");

      const off = await jsonRequest(
        app,
        "PATCH",
        "/admin/settings",
        { workflow_plane_enabled: false, metacognition_enabled: false },
        superUser.apiKey,
      );
      expect(off.status).toBe(200);
      expect(off.data.settings.experimental_doc_pins).toBe(true);
      expect((await jsonRequest(app, "GET", "/health")).data.workflow_plane_enabled).toBe(false);
    });

    it("a read-only API key reads pins but can't write them", async () => {
      const k = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-pins", nest_id: nestId, capability: "read" }, owner.apiKey);
      expect(k.status).toBeLessThan(300);
      const ro = { ...owner, apiKey: k.data.api_key as string };
      expect((await getPins(ro)).status).toBe(200);
      expect((await pin(ro, ids.Charlie, "user")).status).toBe(403);
      expect((await pin(ro, ids.Charlie, "nest")).status).toBe(403);
      expect((await unpin(ro, ids.Alpha, "nest")).status).toBe(403);
      const order = (await getPins(owner)).data.editorial.map((p: any) => p.node_id);
      expect((await reorder(ro, order)).status).toBe(403);
    });

    it("a named system key never reaches /pins (systems sync content; they don't curate)", async () => {
      const sys = await jsonRequest(app, "POST", "/systems", { name: "Pin bot", capability: "write", nest_ids: [nestId] }, superUser.apiKey);
      expect(sys.status).toBe(201);
      const bot = { ...owner, apiKey: sys.data.api_key as string };
      // The key works on the nest's documents…
      expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${ids.Alpha}`, undefined, bot.apiKey)).status).toBe(200);
      // …but not on pins, in either direction.
      expect((await getPins(bot)).status).toBe(403);
      expect((await pin(bot, ids.Alpha, "user")).status).toBe(403);
      expect((await pin(bot, ids.Alpha, "nest")).status).toBe(403);
    });

    it("a non-admin PATCH of the other switches is still 403", async () => {
      for (const body of [{ workflow_plane_enabled: true }, { metacognition_enabled: true }]) {
        expect((await jsonRequest(app, "PATCH", "/admin/settings", body, owner.apiKey)).status).toBe(403);
      }
    });
  });

  // ─── 8. Schema ────────────────────────────────────────────────────────
  describe("schema (SQLite)", () => {
    it("editorial rows carry no user; personal rows must", async () => {
      const d = await db();
      // A well-formed row goes in — so the refusals below are the CHECK, not a
      // missing table.
      await d.run(
        "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('ok1', ?, ?, 'user', ?, 0)",
        [nestId, ids.Foxtrot, owner.userId],
      );
      await d.run("DELETE FROM node_pins WHERE id = 'ok1'", []);
      await expect(
        d.run(
          "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('x1', ?, ?, 'nest', ?, 0)",
          [nestId, ids.Alpha, owner.userId],
        ),
      ).rejects.toThrow();
      await expect(
        d.run(
          "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('x2', ?, ?, 'user', NULL, 0)",
          [nestId, ids.Alpha],
        ),
      ).rejects.toThrow();
      await expect(
        d.run(
          "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('x3', ?, ?, 'bogus', NULL, 0)",
          [nestId, ids.Alpha],
        ),
      ).rejects.toThrow();
    });

    it("one editorial pin per document; one personal pin per person per document", async () => {
      const d = await db();
      // Alpha is already editorially pinned.
      await expect(
        d.run(
          "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('x4', ?, ?, 'nest', NULL, 0)",
          [nestId, ids.Alpha],
        ),
      ).rejects.toThrow();
      // editor already has a personal pin on Delta.
      await expect(
        d.run(
          "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('x5', ?, ?, 'user', ?, 0)",
          [nestId, ids.Delta, editor.userId],
        ),
      ).rejects.toThrow();
    });
  });
});

// ─── Cap vs. hidden pins (review round 3) ─────────────────────────────
// A personal pin on a document the caller can no longer read is invisible to
// them, so it must not use up their 50. Revoking a folder grant leaves 50
// such pins behind; the next pin on a document they CAN read must succeed.
describe("document pins — hidden pins don't count against the cap", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let guest: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_PINS = "true";
    app = await createTestApp("key");
    owner = await registerUser(app, "capowner@acme.com", "Owner");
    guest = await registerUser(app, "capguest@acme.com", "Guest");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Cap" }, owner.apiKey);
    nestId = data.nest.id;
  }, 60000);

  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_PINS;
    return env.cleanup();
  });

  it("a revoked grant leaves 50 hidden pins; a new readable pin still succeeds", async () => {
    const shared: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: `Shared ${i}`, content: "x", folder: "shared" }, owner.apiKey);
      expect(r.status).toBe(201);
      shared.push(r.data.node.id);
    }
    const keep = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Keep", content: "x" }, owner.apiKey);
    const keepId = keep.data.node.id as string;

    const folder = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "folder", target: "nodes/shared", email: guest.email, role: "read" }, owner.apiKey);
    expect(folder.status).toBe(201);
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target: keepId, email: guest.email, role: "read" }, owner.apiKey);
    expect(doc.status).toBe(201);

    for (const id of shared) {
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: id, scope: "user" }, guest.apiKey)).status).toBe(201);
    }
    // At the cap while they can see all 50.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: keepId, scope: "user" }, guest.apiKey)).status).toBe(400);

    // Revoke the folder grant: the 50 pins are now hidden from the guest.
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/grants/${folder.data.grant.id}`, undefined, owner.apiKey);
    expect(del.status).toBeLessThan(300);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/pins`, undefined, guest.apiKey)).data.personal).toEqual([]);

    const res = await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: keepId, scope: "user" }, guest.apiKey);
    expect(res.status).toBe(201);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/pins`, undefined, guest.apiKey)).data.personal.map((p: any) => p.node_id)).toEqual([keepId]);
  }, 60000);

  it("caps the editorial strip at 50; a pin whose document is gone doesn't count", async () => {
    const { getDb } = await import("../src/db/client.js");
    const d = getDb();
    const listed = await jsonRequest(app, "GET", `/nests/${nestId}/nodes?folder=shared`, undefined, owner.apiKey);
    const shared: string[] = (listed.data.nodes ?? []).map((n: any) => n.id).filter((id: string) => id.startsWith("nodes/shared/"));
    expect(shared).toHaveLength(50);
    for (const id of shared) {
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: id, scope: "nest" }, owner.apiKey)).status).toBe(201);
    }
    const keepId = "nodes/keep";
    const full = await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: keepId, scope: "nest" }, owner.apiKey);
    expect(full.status).toBe(400);
    expect(full.data.error).toMatch(/50/);

    // Swap one real pin for a dangling row (its document is gone): still 50
    // rows, 49 visible — the dangling one must not hold the slot.
    expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/pins?node_id=${encodeURIComponent(shared[0])}&scope=nest`, undefined, owner.apiKey)).status).toBe(200);
    await d.run(
      "INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('ghost-cap', ?, 'nodes/ghost', 'nest', NULL, 999)",
      [nestId],
    );
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/pins`, { node_id: keepId, scope: "nest" }, owner.apiKey)).status).toBe(201);
  }, 60000);
});

// ─── 6. Unlicensed ──────────────────────────────────────────────────────
describe("document pins — unlicensed install (real license module)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.AUTH_MODE = "open";
    process.env.EXPERIMENTAL_DOC_PINS = "true";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    const { FREE_TIER_MAX_USERS } = await import("../src/auth/free-tier.js");
    await seedPeople(FREE_TIER_MAX_USERS + 1);
    const { createApp } = await import("../src/app.js");
    app = createApp();
  });

  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_PINS;
    return env.cleanup();
  });

  it("GET /nests/:id/pins → 503 License required", async () => {
    const res = await app.request("/nests/some-nest/pins");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("License required");
  });

  it("the writes are 503 too", async () => {
    for (const [method, path] of [
      ["POST", "/nests/some-nest/pins"],
      ["DELETE", "/nests/some-nest/pins?node_id=nodes/a&scope=user"],
      ["PUT", "/nests/some-nest/pins/order"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ node_id: "nodes/a", scope: "user", node_ids: [] }),
      });
      expect(res.status).toBe(503);
    }
  });

  it("a plain node read whose slug is 'pins' does not trip the gate", async () => {
    const res = await app.request("/nests/some-nest/nodes/nodes%2Fpins");
    expect(res.status).not.toBe(503);
  });
});

// ─── 8b. Schema on Postgres (gated) ─────────────────────────────────────
const PG_URL = process.env.TEST_DATABASE_URL;
(PG_URL ? describe : describe.skip)("node_pins schema (Postgres)", () => {
  let pool: any;
  let adapter: any;
  const schema = `cnst_pins_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    const { PostgresAdapter } = await import("../src/db/adapter.postgres.js");
    const admin = new Pool({ connectionString: PG_URL });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}` });
    adapter = new PostgresAdapter(pool);
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    await runPostgresMigrations(adapter);
    await adapter.run("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@x.com', 'x')", []);
    await adapter.run("INSERT INTO nests (id, user_id, name, slug) VALUES ('n1', 'u1', 'N', 'n')", []);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  it("records migration 071 and enforces the scope/user CHECK + per-scope uniqueness", async () => {
    const rec = await adapter.get("SELECT id FROM schema_migrations WHERE id = '071_node_pins'", []);
    expect(rec).toBeTruthy();
    await adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p1', 'n1', 'nodes/a', 'nest', NULL, 0)", []);
    await adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p2', 'n1', 'nodes/a', 'user', 'u1', 0)", []);
    await expect(
      adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p3', 'n1', 'nodes/a', 'nest', NULL, 1)", []),
    ).rejects.toThrow();
    await expect(
      adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p4', 'n1', 'nodes/a', 'user', 'u1', 1)", []),
    ).rejects.toThrow();
    await expect(
      adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p5', 'n1', 'nodes/b', 'nest', 'u1', 0)", []),
    ).rejects.toThrow();
    await expect(
      adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p6', 'n1', 'nodes/b', 'user', NULL, 0)", []),
    ).rejects.toThrow();
  });

  it("cascades on user and nest deletion", async () => {
    await adapter.run("INSERT INTO users (id, email, password_hash) VALUES ('u2', 'u2@x.com', 'x')", []);
    await adapter.run("INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position) VALUES ('p7', 'n1', 'nodes/c', 'user', 'u2', 0)", []);
    await adapter.run("DELETE FROM users WHERE id = 'u2'", []);
    expect(await adapter.all("SELECT * FROM node_pins WHERE id = 'p7'", [])).toEqual([]);
    await adapter.run("DELETE FROM nests WHERE id = 'n1'", []);
    expect(await adapter.all("SELECT * FROM node_pins", [])).toEqual([]);
  });
});

// ─── Reorder with pins the curator can't see (review round 4) ───────────
// GET filters editorial pins by the caller's read access, so a curator could in
// principle see fewer pins than exist. Today every curator path (owner, nest
// admin, server admin, nest-wide reviewer steward) reads the whole nest, so
// this isn't reachable end to end — the merge rule is pinned here instead:
// the curator's new order fills the slots of the pins they can see, and the
// pins they can't see keep their slots.
describe("mergeEditorialOrder", () => {
  it("reorders the visible pins and leaves hidden ones in their slots", async () => {
    const { mergeEditorialOrder } = await import("../src/nodes/doc-pins.js");
    // Full order a, H, b, c (H hidden); the curator reverses what they see.
    expect(mergeEditorialOrder(["a", "H", "b", "c"], ["c", "b", "a"])).toEqual(["c", "H", "b", "a"]);
    // Nothing hidden: the new order is the order.
    expect(mergeEditorialOrder(["a", "b"], ["b", "a"])).toEqual(["b", "a"]);
    // Hidden at both ends.
    expect(mergeEditorialOrder(["H1", "a", "b", "H2"], ["b", "a"])).toEqual(["H1", "b", "a", "H2"]);
  });
});
