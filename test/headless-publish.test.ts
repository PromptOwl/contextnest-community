/**
 * Headless publishing (CU-wdqcq0314u) — a private nest handed out as API-only
 * access keys. A key holder reads the nest's APPROVED content through ctx /
 * MCP / the read REST routes and nothing else: no writes, no history, no
 * export, no UI, no account routes. Everything a key can't do is a 403 with
 * code "headless_reader".
 *
 * Nest shape used throughout (governed, like a real distillation):
 *   nodes/guide       approved v1 ("Approved text") + an unapproved draft on top
 *   nodes/unreviewed  draft only, never approved
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let writer: User;
let collabReader: User;
let nestId: string;
let otherNestId: string;
let readerKey: string;
let readerKeyId: string;

async function mcp(
  apiKey: string,
  method: string,
  params: Record<string, unknown> = {},
  path = `/nests/${nestId}/mcp`,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { status: res.status, body: await res.json() };
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: dataLine ? JSON.parse(dataLine.slice(6)) : text };
}

/** Text of a tools/call result, plus whether the tool reported an error. */
async function tool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  path?: string,
): Promise<{ text: string; isError: boolean; rpcError?: any }> {
  const { body } = await mcp(apiKey, "tools/call", { name, arguments: args }, path);
  if (body.error) return { text: body.error.message, isError: true, rpcError: body.error };
  return {
    text: (body.result?.content ?? []).map((c: any) => c.text).join(""),
    isError: !!body.result?.isError,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  // The owner is also the license admin, so the teammates list is reachable.
  app = await createTestApp("key", { ownerEmail: "owner@headless.test" });
  owner = await registerUser(app, "owner@headless.test", "Owner");
  writer = await registerUser(app, "writer@headless.test", "Writer");
  await resetAuthRateLimit();
  collabReader = await registerUser(app, "reader@headless.test", "Reader");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Distillation" }, owner.apiKey);
  nestId = nest.data.nest.id;
  const other = await jsonRequest(app, "POST", "/nests", { name: "Other" }, owner.apiKey);
  otherNestId = other.data.nest.id;

  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Guide", content: "# Guide\n\nApproved text." }, owner.apiKey,
  );
  await jsonRequest(
    app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey,
  );
  await jsonRequest(
    app, "PATCH", `/nests/${nestId}/nodes/nodes/guide`,
    { content: "# Guide\n\nDraft text nobody approved." }, owner.apiKey,
  );
  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Unreviewed", content: "# Unreviewed\n\nNever approved." }, owner.apiKey,
  );

  for (const [u, permission] of [[writer, "write"], [collabReader, "read"]] as const) {
    await jsonRequest(
      app, "POST", `/nests/${nestId}/collaborators`,
      { email: u.email, permission }, owner.apiKey,
    );
  }
}, 30000);

afterAll(() => env.cleanup());

describe("turning headless publishing on", () => {
  it("starts off, with no keys", async () => {
    const { status, data } = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: false, keys: [] });
  });

  it("says who keeps their seat — collaborators aren't affected by headless", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(data.shared_with).toEqual({ collaborators: 2, teams: 0, grants: 0 });
  });

  it("refuses to mint a key while it is off", async () => {
    const { status } = await jsonRequest(
      app, "POST", `/nests/${nestId}/headless/keys`, { label: "Acme" }, owner.apiKey,
    );
    expect(status).toBe(409);
  });

  it("is owner/admin only", async () => {
    const { status } = await jsonRequest(
      app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, writer.apiKey,
    );
    expect(status).toBe(403);
  });

  it("refuses a nest that is org or public", async () => {
    await jsonRequest(
      app, "PATCH", `/nests/${otherNestId}/visibility`,
      { visibility: "public", acknowledge_public: true }, owner.apiKey,
    );
    const { status, data } = await jsonRequest(
      app, "PUT", `/nests/${otherNestId}/headless`, { enabled: true }, owner.apiKey,
    );
    expect(status).toBe(409);
    expect(data.error).toMatch(/private/i);
    await jsonRequest(app, "PATCH", `/nests/${otherNestId}/visibility`, { visibility: "private" }, owner.apiKey);
  });

  it("turns on for a private nest", async () => {
    const { status, data } = await jsonRequest(
      app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.enabled).toBe(true);
  });

  it("then keeps the nest private — org and public are refused", async () => {
    for (const visibility of ["org", "public"]) {
      const { status } = await jsonRequest(
        app, "PATCH", `/nests/${nestId}/visibility`,
        { visibility, acknowledge_public: true }, owner.apiKey,
      );
      expect(status, visibility).toBe(409);
    }
  });
});

describe("access keys", () => {
  it("need a label", async () => {
    const { status } = await jsonRequest(app, "POST", `/nests/${nestId}/headless/keys`, {}, owner.apiKey);
    expect(status).toBe(400);
  });

  it("are minted once, token shown once, then listed without it", async () => {
    const { status, data } = await jsonRequest(
      app, "POST", `/nests/${nestId}/headless/keys`, { label: "Acme Corp" }, owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.api_key).toMatch(/^cnst_/);
    readerKey = data.api_key;
    readerKeyId = data.key.id;

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(list.data.keys).toHaveLength(1);
    const [k] = list.data.keys;
    expect(k).toMatchObject({ id: readerKeyId, label: "Acme Corp" });
    expect(k.key_prefix).toBeTruthy();
    expect(JSON.stringify(list.data)).not.toContain(readerKey);
  });
});

describe("a key reads approved content over MCP (what ctx uses)", () => {
  it("lists only the read tools", async () => {
    const { body } = await mcp(readerKey, "tools/list");
    const names: string[] = body.result.tools.map((t: any) => t.name);
    for (const n of ["context_list", "context_get", "context_query", "context_search"]) {
      expect(names).toContain(n);
    }
    for (const n of ["context_create", "context_update", "context_delete", "context_export",
      "context_versions", "context_comment", "context_submit_review", "context_request_deletion"]) {
      expect(names, n).not.toContain(n);
    }
  });

  it("context_list offers approved documents, never a draft-only one", async () => {
    const { text, isError } = await tool(readerKey, "context_list", {});
    expect(isError).toBe(false);
    expect(text).toContain("Guide");
    expect(text).not.toContain("Unreviewed");
  });

  it("context_get returns the approved body, not the draft on top", async () => {
    const { text, isError } = await tool(readerKey, "context_get", { id: "nodes/guide" });
    expect(isError).toBe(false);
    expect(text).toContain("Approved text");
    expect(text).not.toContain("Draft text");
  });

  it("context_search works", async () => {
    const { isError } = await tool(readerKey, "context_search", { query: "Guide" });
    expect(isError).toBe(false);
  });

  it("refuses write, history, export and comment tools even when called by name", async () => {
    // Over the transport they aren't registered for the key, so the MCP SDK
    // itself answers "not found"; handleToolCall's own gate is pinned below.
    for (const [name, args] of [
      ["context_create", { title: "Sneaky", content: "x" }],
      ["context_update", { id: "nodes/guide", content: "x" }],
      ["context_export", {}],
      ["context_versions", { id: "nodes/guide" }],
      ["context_comment", { id: "nodes/guide", body: "hi" }],
    ] as const) {
      const r = await tool(readerKey, name, args as any);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/read-only access key|not found/i);
    }
  });

  it("handleToolCall refuses a non-read tool for the key's identity whatever the transport", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { handleToolCall } = await import("../src/mcp/tools.js");
    const row = (await getDb().get("SELECT user_id FROM api_keys WHERE id = ?", [readerKeyId])) as { user_id: string };
    for (const name of ["context_create", "context_export", "context_versions", "run_agent", "some_future_tool"]) {
      const out = (await handleToolCall(name, {}, {
        nestId, userId: row.user_id, userEmail: "x@headless.invalid",
      } as any)) as { text: string; isError?: boolean };
      expect(out.isError, name).toBe(true);
      expect(out.text, name).toMatch(/read-only access key/i);
    }
  });

  it("the server-level /mcp answers the same way", async () => {
    const got = await tool(readerKey, "context_get", { nest: nestId, id: "nodes/guide" }, "/mcp");
    expect(got.isError).toBe(false);
    expect(got.text).toContain("Approved text");
    const made = await tool(readerKey, "context_create", { nest: nestId, title: "S", content: "x" }, "/mcp");
    expect(made.isError).toBe(true);
    const { body } = await mcp(readerKey, "tools/list", {}, "/mcp");
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("context_create");
  });
});

describe("a key over REST", () => {
  it("reads the nest, the approved list and an approved node", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, readerKey)).status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, readerKey);
    expect(list.status).toBe(200);
    const ids = list.data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/guide");
    expect(ids).not.toContain("nodes/unreviewed");
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/guide`, undefined, readerKey);
    expect(node.status).toBe(200);
    expect(node.data.node.content).toContain("Approved text");
    expect(node.data.node.content).not.toContain("Draft text");
  });

  it("can run a context retrieval", async () => {
    const { status } = await jsonRequest(
      app, "POST", `/nests/${nestId}/context`, { selector: "#guide" }, readerKey,
    );
    expect(status).not.toBe(403);
  });

  it("is refused everything else with code headless_reader", async () => {
    for (const [m, p, body] of [
      ["POST", `/nests/${nestId}/nodes`, { title: "S", content: "x" }],
      ["PATCH", `/nests/${nestId}/nodes/nodes/guide`, { content: "x" }],
      ["GET", `/nests/${nestId}/nodes/nodes/guide/versions`],
      ["GET", `/nests/${nestId}/nodes/nodes/guide/comments`],
      ["POST", `/nests/${nestId}/nodes/nodes/guide/comments`, { body: "hi" }],
      ["GET", `/nests/${nestId}/export`],
      ["GET", `/nests/${nestId}/collaborators`],
      ["GET", `/nests/${nestId}/activity`],
      ["POST", `/nests/${nestId}/chat`, { message: "hi" }],
      ["POST", `/nests/${nestId}/pin`],
      ["GET", `/nests/${nestId}/headless`],
      ["POST", `/nests/${nestId}/headless/keys`, { label: "Mine" }],
      ["GET", "/runs/some-run"],
      ["GET", "/stats"],
    ] as const) {
      const { status, data } = await jsonRequest(app, m, p, body as any, readerKey);
      expect(status, `${m} ${p}`).toBe(403);
      expect(data.code, `${m} ${p}`).toBe("headless_reader");
    }
  });

  it("can't reach another nest or any account route", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${otherNestId}`, undefined, readerKey)).status).toBe(403);
    expect((await jsonRequest(app, "POST", "/auth/keys", { label: "x" }, readerKey)).status).toBe(403);
    expect((await jsonRequest(app, "GET", "/me/work", undefined, readerKey)).status).toBe(403);
  });

  it("sees only the nest's public face — no owner id, team shares or settings", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, readerKey);
    expect(data.nest).toMatchObject({ id: nestId, name: "Distillation" });
    for (const hidden of ["user_id", "shared_teams", "stewardship_enabled", "headless", "reader_mode", "visibility"]) {
      expect(data.nest, hidden).not.toHaveProperty(hidden);
    }
    expect(data.permission).toBe("read");
    // The owner still gets the whole row (regression).
    const own = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, owner.apiKey);
    expect(own.data.nest).toHaveProperty("user_id");
  });

  it("can't read the folder tree or the glossary (they aren't approval-gated)", async () => {
    for (const p of [`/nests/${nestId}/folders`, `/nests/${nestId}/definitions`]) {
      const { status, data } = await jsonRequest(app, "GET", p, undefined, readerKey);
      expect(status, p).toBe(403);
      expect(data.code, p).toBe("headless_reader");
    }
  });

  it("HEAD never gets a key more than a read collaborator gets", async () => {
    // (The nest gate treats every non-GET, HEAD included, as write-tier for all
    // readers — pre-existing, not changed here. What matters is that a key is
    // never ahead of a real read collaborator.)
    const head = (path: string, key: string) =>
      app.request(path, { method: "HEAD", headers: { Authorization: `Bearer ${key}` } }).then((r: any) => r.status);
    expect(await head(`/nests/${nestId}/nodes`, readerKey)).toBe(await head(`/nests/${nestId}/nodes`, collabReader.apiKey));
    expect(await head(`/nests/${nestId}/export`, readerKey)).toBe(403);
  });

  it("a signed-in person's cookie sent along with the key doesn't widen the key", async () => {
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: writer.email, password: "testpass" }),
    });
    const cookie = login.headers.get("set-cookie") || "";
    expect(cookie).toContain("cnst_session=");
    const res = await app.request(`/nests/${nestId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readerKey}`, Cookie: cookie },
      body: JSON.stringify({ title: "Via cookie", content: "x" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("headless_reader");
  });
});

describe("the key's identity is not a person", () => {
  async function serviceEmail(): Promise<string> {
    const db = (await import("../src/db/client.js")).getDb();
    const row = (await db.get(
      `SELECT u.email FROM users u JOIN api_keys k ON k.user_id = u.id WHERE k.id = ?`,
      [readerKeyId],
    )) as { email: string };
    return row.email;
  }

  it("can't sign in to the UI", async () => {
    const email = await serviceEmail();
    const res = await jsonRequest(app, "POST", "/auth/login", { email, password: "" + "!" }, undefined);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("never shows up in the admin teammates list, people search or user count", async () => {
    const email = await serviceEmail();
    const people = await jsonRequest(app, "GET", "/people/suggest?q=headless", undefined, owner.apiKey);
    expect(JSON.stringify(people.data)).not.toContain(email);
    const { getDb } = await import("../src/db/client.js");
    const { countPeople } = await import("../src/auth/headless.js");
    const all = (await getDb().get("SELECT COUNT(*) AS c FROM users")) as { c: number };
    expect(await countPeople()).toBe(all.c - 1);
  });

  it("can never be given a browser session, whatever sign-in path asks", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { createSession } = await import("../src/auth/sessions.js");
    const row = (await getDb().get("SELECT user_id FROM api_keys WHERE id = ?", [readerKeyId])) as { user_id: string };
    await expect(createSession(row.user_id)).rejects.toThrow(/access key/i);
    // A real person still gets one (regression).
    await expect(createSession(writer.userId)).resolves.toBeTruthy();
  });

  it("lists its one nest in the agent index and the nest list", async () => {
    const idx = await jsonRequest(app, "GET", "/index?format=json", undefined, readerKey);
    expect(idx.status).toBe(200);
    expect(idx.data.nests.map((n: any) => n.id)).toEqual([nestId]);
    const list = await jsonRequest(app, "GET", "/nests", undefined, readerKey);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).toContain(nestId);
    expect(JSON.stringify(list.data)).not.toContain(otherNestId);
  });

  it("is not in the server admin's teammates list", async () => {
    const email = await serviceEmail();
    const { status, data } = await jsonRequest(app, "GET", "/auth/teammates", undefined, owner.apiKey);
    expect(status).toBe(200);
    expect(JSON.stringify(data)).toContain("writer@headless.test");
    expect(JSON.stringify(data)).not.toContain(email);
  });

  it("is not offered by the all-users people directory, or resolvable as a mention", async () => {
    const email = await serviceEmail();
    process.env.PEOPLE_SUGGEST_ALL_USERS = "true";
    try {
      const { withDirectory, findDirectoryPerson } = await import("../src/nests/people-service.js");
      const dir = await withDirectory([]);
      expect(dir.map((p) => p.email)).toContain("writer@headless.test");
      expect(dir.map((p) => p.email)).not.toContain(email);
      expect(await findDirectoryPerson(email)).toBeUndefined();
    } finally {
      delete process.env.PEOPLE_SUGGEST_ALL_USERS;
    }
  });

  it("is not counted in /stats", async () => {
    const { data } = await jsonRequest(app, "GET", "/stats", undefined, owner.apiKey);
    const { countPeople } = await import("../src/auth/headless.js");
    expect(data.users).toBe(await countPeople());
  });
});

describe("lifecycle", () => {
  it("a paused key's nest drops out of its /nests and /index, and comes back", async () => {
    const ids = async (path: string) => {
      const { data } = await jsonRequest(app, "GET", path, undefined, readerKey);
      return JSON.stringify(data);
    };
    await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: false }, owner.apiKey);
    expect(await ids("/nests")).not.toContain(nestId);
    expect(await ids("/index?format=json")).not.toContain(nestId);
    await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, owner.apiKey);
    expect(await ids("/nests")).toContain(nestId);
    expect(await ids("/index?format=json")).toContain(nestId);
  });

  it("revoking is all-or-nothing: a failure part-way leaves the key and its identity intact", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { mintHeadlessKey, revokeHeadlessKey } = await import("../src/auth/headless.js");
    const db = getDb();
    const { key } = await mintHeadlessKey(nestId, "Atomic", owner.userId);
    const svc = (await db.get("SELECT user_id FROM api_keys WHERE id = ?", [key.id])) as { user_id: string };
    // A row that references the identity without ON DELETE CASCADE makes the
    // final DELETE FROM users fail — after the key and reader rows are gone,
    // unless the whole revoke is one transaction.
    await db.run(
      "INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)",
      ["pin-nest", svc.user_id, "Pin", "pin"],
    );
    await expect(revokeHeadlessKey(nestId, key.id)).rejects.toThrow();
    expect(await db.get("SELECT id FROM api_keys WHERE id = ?", [key.id])).toBeTruthy();
    expect(await db.get("SELECT user_id FROM headless_readers WHERE key_id = ?", [key.id])).toBeTruthy();
    await db.run("DELETE FROM nests WHERE id = ?", ["pin-nest"]);
    expect(await revokeHeadlessKey(nestId, key.id)).toBe(true);
  });

  it("turning publishing off pauses every key; turning it on resumes them", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: false }, owner.apiKey);
    const paused = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, readerKey);
    expect([403, 404]).toContain(paused.status);
    await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, owner.apiKey);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, readerKey)).status).toBe(200);
  });

  it("revoking a key kills it and removes its identity", async () => {
    const { status } = await jsonRequest(
      app, "DELETE", `/nests/${nestId}/headless/keys/${readerKeyId}`, undefined, owner.apiKey,
    );
    expect(status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, readerKey)).status).toBe(401);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(list.data.keys).toHaveLength(0);
  });

  it("deleting the nest removes its keys and their identities", async () => {
    const tmp = await jsonRequest(app, "POST", "/nests", { name: "Temp" }, owner.apiKey);
    const tmpId = tmp.data.nest.id;
    await jsonRequest(app, "PUT", `/nests/${tmpId}/headless`, { enabled: true }, owner.apiKey);
    const minted = await jsonRequest(app, "POST", `/nests/${tmpId}/headless/keys`, { label: "T" }, owner.apiKey);
    const res = await jsonRequest(app, "DELETE", `/nests/${tmpId}`, undefined, owner.apiKey);
    expect(res.status).toBeLessThan(300);
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    expect(await db.get("SELECT id FROM api_keys WHERE id = ?", [minted.data.key.id])).toBeFalsy();
    const svc = (await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE is_service = 1",
    )) as { c: number };
    expect(Number(svc.c)).toBe(0);
  });
});

describe("regression — ordinary callers are unchanged", () => {
  it("a read collaborator on a normal nest can still comment", async () => {
    const plain = await jsonRequest(app, "POST", "/nests", { name: "Plain" }, owner.apiKey);
    const plainId = plain.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${plainId}/nodes`, { title: "Doc", content: "# Doc" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${plainId}/collaborators`, { email: collabReader.email, permission: "read" }, owner.apiKey);
    const { status } = await jsonRequest(
      app, "POST", `/nests/${plainId}/nodes/nodes/doc/comments`, { body: "looks good" }, collabReader.apiKey,
    );
    expect(status).toBeLessThan(300);
  });

  it("a nest-scoped user key (#333) on a normal nest can still write there", async () => {
    const keyRes = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: otherNestId }, owner.apiKey);
    expect(keyRes.status).toBe(201);
    const { status } = await jsonRequest(
      app, "POST", `/nests/${otherNestId}/nodes`, { title: "Scoped write", content: "# ok" }, keyRes.data.api_key,
    );
    expect(status).toBe(201);
  });

  it("collaborators on the headless nest keep their normal access (drafts included)", async () => {
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/guide`, undefined, writer.apiKey);
    expect(node.status).toBe(200);
    expect(node.data.node.content).toContain("Draft text");
  });
});
