/**
 * Surfaces S1 — round 2 security regressions (security.md H1–H2, M1–M7,
 * L1–L5). Interleavings are driven deterministically: the fake connector's
 * gate() holds one members() call, and binding-service exposes test hooks
 * at its commit points. No sleeps.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { createFakeConnector, conversation, member, profile, type FakeConnector } from "./surfaces-fake-connector.js";
import { computeGuard } from "../src/surfaces/core/guard.js";

type User = { apiKey: string; userId: string; email: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: User; // nest owner, ordinary user
let bob: User;
let carol: User;
let dave: User;
let root: User; // server admin
let fake: FakeConnector;
let installId: string;
let homeNest: string;
let S: {
  installs: typeof import("../src/surfaces/services/install-store.js");
  bindings: typeof import("../src/surfaces/services/binding-service.js");
  runner: typeof import("../src/surfaces/services/guard-runner.js");
  identity: typeof import("../src/surfaces/services/identity-service.js");
  flags: typeof import("../src/surfaces/flags.js");
  db: typeof import("../src/db/client.js");
};
const paused: Array<{ bindingId: string; reason: string }> = [];

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
async function mcp(path: string, method: string, params: Record<string, unknown>, key: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) : { raw: text };
}
async function newNest(owner: User): Promise<string> {
  const r = await jsonRequest(app, "POST", "/nests", { name: `N-${randomUUID().slice(0, 6)}` }, owner.apiKey);
  expect(r.status).toBe(201);
  return r.data.nest.id;
}
async function share(nestId: string, user: User, permission = "read", by: User = alice) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: user.email, permission }, by.apiKey);
  expect(r.status).toBeLessThan(300);
}
function setConv(id: string, members: string[], over: Parameters<typeof conversation>[1] = {}) {
  fake.conversations.set(id, { info: conversation(id, over), members: members.map((m) => member(m)) });
}
async function bind(body: Record<string, unknown>, key = alice.apiKey) {
  return jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, ...body }, key);
}
async function row(id: string) {
  return (await S.db.getDb().get("SELECT * FROM surface_bindings WHERE id = ?", [id])) as any;
}
/** Mint a key for `user` through a session (optionally nest-scoped / read-only). */
async function mintKey(user: User, body: Record<string, unknown>): Promise<string> {
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "testpass" }),
  });
  const cookie = login.headers.get("set-cookie") || "";
  const k = await app.request("/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ label: `k-${randomUUID().slice(0, 4)}`, ...body }),
  });
  const data = await k.json();
  expect(k.status, JSON.stringify(data)).toBeLessThan(300);
  return data.api_key;
}
/** A bound, active private channel with alice + dave reading. */
async function activeBinding(conv: string) {
  const n = await newNest(alice);
  await share(n, dave);
  setConv(conv, ["SA", "SD", "SC"]);
  const b = await bind({ conversation_id: conv, nest_id: n });
  expect(b.status).toBe(201);
  return { nestId: n, id: b.data.binding.id as string };
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@r2.test"] });
  alice = await registerUser(app, "alice@r2.test", "Alice");
  bob = await registerUser(app, "bob@r2.test", "Bob");
  carol = await registerUser(app, "carol@r2.test", "Carol");
  await resetAuthRateLimit();
  dave = await registerUser(app, "dave@r2.test", "Dave");
  root = await registerUser(app, "root@r2.test", "Root");
  await resetAuthRateLimit();
  S = {
    installs: await import("../src/surfaces/services/install-store.js"),
    bindings: await import("../src/surfaces/services/binding-service.js"),
    runner: await import("../src/surfaces/services/guard-runner.js"),
    identity: await import("../src/surfaces/services/identity-service.js"),
    flags: await import("../src/surfaces/flags.js"),
    db: await import("../src/db/client.js"),
  };
  const registry = await import("../src/surfaces/registry.js");
  fake = createFakeConnector("slack");
  registry.registerConnector(fake);
  homeNest = await newNest(alice);
  installId = (
    await S.installs.createInstall({
      surface: "slack",
      mode: "manifest",
      tenantKey: "T1",
      teamId: "T1",
      botUserId: "B_OURS",
      homeNestId: homeNest,
      installedByUserId: alice.userId,
      status: "active",
    })
  ).id;
  for (const [sid, u] of [["SA", alice], ["SB", bob], ["SC", carol], ["SD", dave], ["SR", root]] as const) {
    await S.identity.linkExplicit({ installId, surfaceUserId: sid, communityUserId: u.userId });
  }
  S.runner.onBindingPaused(async (b, reason) => {
    paused.push({ bindingId: b.id, reason });
  });
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.FEATURE_SURFACES;
  await env.cleanup();
});

beforeEach(() => {
  paused.length = 0;
});
afterEach(() => {
  const hooks = (S.bindings as any).bindingTestHooks;
  if (hooks) {
    hooks.afterEvaluate = undefined;
    hooks.beforeResumeCommit = undefined;
  }
});
/** The commit-point hooks (absent before the fix → the test fails on the assertion it guards). */
const hooks = () =>
  ((S.bindings as any).bindingTestHooks ?? {}) as {
    afterEvaluate?: (id: string) => unknown;
    beforeResumeCommit?: (id: string) => unknown;
    beforeBootCommit?: (id: string) => unknown;
  };

describe("H1: every status transition is a compare-and-set", () => {
  it("H1-A: an admin removal during a re-check is never undone by the re-check", async () => {
    const { id } = await activeBinding("C-H1A");
    const g = fake.gate("C-H1A");
    const re = S.bindings.recheckBinding(id);
    await g.entered;
    await S.bindings.removeBinding(id, alice.userId);
    g.release();
    await re;
    const r = await row(id);
    expect(r.status).toBe("removed");
    expect(r.capture_ok).toBe(0);
  });

  it("H1-B: a member boot during a re-check is never undone by the re-check", async () => {
    const { id } = await activeBinding("C-H1B");
    const g = fake.gate("C-H1B");
    const re = S.bindings.recheckBinding(id);
    await g.entered;
    const boot = await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    expect(boot.ok).toBe(true);
    g.release();
    await re;
    const r = await row(id);
    expect(r.status).toBe("paused_by_member");
    expect(r.booted_by_surface_user_id).toBe("SC");
  });

  it("H1-C: resume is a CAS from the status it read — a boot landing before the commit wins (409)", async () => {
    const { id } = await activeBinding("C-H1C");
    // pause by guard, then make it valid again
    setConv("C-H1C", ["SA", "SC"]);
    await S.bindings.recheckBinding(id);
    expect((await row(id)).status).toBe("paused_guard");
    setConv("C-H1C", ["SA", "SD", "SC"]);
    hooks().beforeResumeCommit = async () => {
      await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    };
    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, alice.apiKey);
    expect(res.status).toBe(409);
    expect((await row(id)).status).toBe("paused_by_member");
  });

  it("H1-D: a re-check never moves paused_guard, paused_by_member or removed to active", async () => {
    const { id } = await activeBinding("C-H1D");
    setConv("C-H1D", ["SA", "SC"]);
    await S.bindings.recheckBinding(id);
    setConv("C-H1D", ["SA", "SD", "SC"]);
    await S.bindings.recheckBinding(id);
    expect((await row(id)).status).toBe("paused_guard");
    await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    await S.bindings.recheckBinding(id);
    expect((await row(id)).status).toBe("paused_by_member");
    await S.bindings.removeBinding(id, alice.userId);
    await S.bindings.recheckBinding(id);
    expect((await row(id)).status).toBe("removed");
  });

  it("H1-E: every transition bumps the binding version", async () => {
    const { id } = await activeBinding("C-H1E");
    const v0 = (await row(id)).version;
    await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    expect((await row(id)).version).toBeGreaterThan(v0);
  });
});

describe("H2: a change during a re-check is not lost", () => {
  it("H2: a member leaving while a re-check is in flight leaves the binding dirty, and the next tick pauses it", async () => {
    const { id } = await activeBinding("C-H2");
    const g = fake.gate("C-H2"); // re-check sees the OLD list (SA, SD, SC)
    const re = S.bindings.recheckBinding(id);
    await g.entered;
    setConv("C-H2", ["SA", "SC"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_left", conversation: "C-H2", user: "SD" });
    g.release();
    await re;
    expect((await row(id)).guard_dirty).toBe(1);
    await S.runner.runGuardSweep();
    expect((await row(id)).status).toBe("paused_guard");
  });
});

describe("M1: a re-check that throws fails closed", () => {
  it("M1: the binding moves to paused_guard with a counts-only alert", async () => {
    const { id } = await activeBinding("C-M1");
    hooks().afterEvaluate = (bid: string) => {
      if (bid === id) throw new Error("db exploded: secret-detail");
    };
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_joined", conversation: "C-M1", user: "SB" });
    await S.runner.runGuardSweep();
    const r = await row(id);
    expect(r.status).toBe("paused_guard");
    expect(r.capture_ok).toBe(0);
    expect(r.surface_ok).toBe(0);
    expect(paused).toContainEqual({ bindingId: id, reason: "guard" });
    const n = (await S.db.getDb().get("SELECT * FROM surface_notices WHERE binding_id = ? AND kind = 'binding_paused'", [id])) as any;
    expect(n).toBeTruthy();
    expect(n.detail).not.toContain("secret-detail");
    expect(JSON.parse(n.detail)).toMatchObject({ recheck_failed: true });
  });
});

describe("M2: key scope and read-only keys", () => {
  it("M2: a read-only key can't mutate /surfaces (REST)", async () => {
    const readKey = await mintKey(alice, { nest_id: homeNest, capability: "read" });
    setConv("C-M2", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C-M2", nest_id: homeNest }, readKey);
    expect(r.status).toBe(403);
  });

  it("M2: a nest-scoped key can't reach the org-level link actions (REST)", async () => {
    const scoped = await mintKey(root, { nest_id: homeNest });
    for (const [method, path, body] of [
      ["GET", "/surfaces/links", undefined],
      ["POST", "/surfaces/links/unblock", { install_id: installId, surface_user_id: "X" }],
      ["GET", "/surfaces/link-reviews", undefined],
    ] as const) {
      const r = await jsonRequest(app, method, path, body as any, scoped);
      expect(r.status, path).toBe(403);
    }
  });

  it("M2: a nest-scoped key can't revoke links, unblock or decide reviews over MCP", async () => {
    const scoped = await mintKey(root, { nest_id: homeNest });
    const link = (await S.db.getDb().get("SELECT id FROM surface_identity_links WHERE surface_user_id = 'SB' AND status = 'active'")) as any;
    for (const [name, args] of [
      ["context_surfaces_link_revoke", { link_id: link.id }],
      ["context_surfaces_link_unblock", { install_id: installId, surface_user_id: "SB" }],
      ["context_surfaces_links_list", {}],
      ["context_surfaces_link_reviews_list", {}],
    ] as const) {
      const out = await mcp(`/nests/${homeNest}/mcp`, "tools/call", { name, arguments: args }, scoped);
      expect(out.result?.isError ?? !!out.error, name).toBe(true);
    }
    expect(((await S.db.getDb().get("SELECT status FROM surface_identity_links WHERE id = ?", [link.id])) as any).status).toBe("active");
  });

  it("M2: a read-only key can't call any surfaces tool over MCP", async () => {
    const readKey = await mintKey(alice, { nest_id: homeNest, capability: "read" });
    const out = await mcp(`/nests/${homeNest}/mcp`, "tools/call", { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C-M2" } }, readKey);
    expect(out.result?.isError ?? !!out.error).toBe(true);
  });
});

describe("M3: the listener is never client-supplied", () => {
  it("M3: REST create / PATCH and MCP create with listener_agent_node_id → 422 / error", async () => {
    const n = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/spy', ?, ?)",
      [n, randomUUID(), alice.email],
    );
    setConv("C-M3", ["SA"]);
    const r = await bind({ conversation_id: "C-M3", nest_id: n, listener_agent_node_id: "nodes/spy" });
    expect(r.status).toBe(422);
    const out = await mcp(
      `/nests/${n}/mcp`,
      "tools/call",
      { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C-M3", listener_agent_node_id: "nodes/spy" } },
      alice.apiKey,
    );
    expect(out.result?.isError).toBe(true);
    // an existing binding can't be PATCHed to exempt an agent either
    const n2 = await newNest(alice);
    setConv("C-M3b", ["SA"]);
    const b = await bind({ conversation_id: "C-M3b", nest_id: n2 });
    const p = await jsonRequest(app, "PATCH", `/surfaces/bindings/${b.data.binding.id}`, { listener_agent_node_id: "nodes/spy" }, alice.apiKey);
    expect(p.status).toBe(422);
  });

  it("M3: a server-side listener must be an agent on that nest; any other agent still counts as a reader", async () => {
    const n = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/listener', ?, ?), (?, 'nodes/other', ?, ?)",
      [n, randomUUID(), alice.email, n, randomUUID(), alice.email],
    );
    setConv("C-M3c", ["SA"]);
    await expect(
      S.bindings.createBinding({ actorUserId: alice.userId, installId, conversationId: "C-M3c", nestId: n, listenerAgentNodeId: "nodes/missing" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      S.bindings.createBinding({ actorUserId: alice.userId, installId, conversationId: "C-M3c", nestId: n, listenerAgentNodeId: "nodes/listener" }),
    ).rejects.toMatchObject({ statusCode: 409 }); // nodes/other still reads
  });
});

describe("M4: explicit_public_bind relaxes only the user-reader subset rule", () => {
  it("M4: a world-readable, link-shared, connector-fed or key-read nest is never public-bound", async () => {
    setConv("C-M4", ["SR"], { kind: "public_channel", is_private: false });
    const pub = await newNest(root);
    await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, root.apiKey);
    const linked = await newNest(root);
    await S.db.getDb().run("INSERT INTO publish (id, nest_id, node_id, slug, access_mode, created_by) VALUES (?, ?, 'nodes/x', ?, 'public', ?)", [
      randomUUID(), linked, `s-${randomUUID()}`, root.userId,
    ]);
    const hooked = await newNest(root);
    await jsonRequest(app, "POST", `/nests/${hooked}/connectors`, { channel: "webhook", url: "https://example.com/h", events: ["*"] }, root.apiKey);
    const keyed = await newNest(root);
    await jsonRequest(app, "POST", "/systems", { name: `M4-${randomUUID().slice(0, 4)}`, capability: "read", nest_ids: [keyed] }, root.apiKey);
    const agented = await newNest(root);
    await S.db.getDb().run("INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/a', ?, ?)", [
      agented, randomUUID(), root.email,
    ]);
    for (const n of [pub, linked, hooked, keyed, agented]) {
      const r = await bind({ conversation_id: "C-M4", nest_id: n, explicit_public_bind: true }, root.apiKey);
      expect(r.status, n).toBe(409);
    }
  });

  it("M4: an org-internal nest (visibility org, readers outside the channel) may be public-bound by a server admin", async () => {
    const n = await newNest(root);
    await share(n, bob, "read", root);
    await jsonRequest(app, "PATCH", `/nests/${n}/visibility`, { visibility: "org" }, root.apiKey);
    setConv("C-M4b", ["SR"], { kind: "public_channel", is_private: false });
    const r = await bind({ conversation_id: "C-M4b", nest_id: n, explicit_public_bind: true }, root.apiKey);
    expect(r.status).toBe(201);
    expect(r.data.binding.capture_ok).toBe(true);
  });

  it("M4: a nest owner who isn't a server admin can't set explicit_public_bind (create or PATCH)", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    setConv("C-M4c", ["SA"], { kind: "public_channel", is_private: false });
    const r = await bind({ conversation_id: "C-M4c", nest_id: n, explicit_public_bind: true });
    expect(r.status).toBe(403);
    const n2 = await newNest(alice);
    setConv("C-M4d", ["SA"], { kind: "public_channel", is_private: false });
    const b = await bind({ conversation_id: "C-M4d", nest_id: n2 });
    expect(b.status).toBe(201);
    const p = await jsonRequest(app, "PATCH", `/surfaces/bindings/${b.data.binding.id}`, { explicit_public_bind: true }, alice.apiKey);
    expect(p.status).toBe(403);
  });
});

describe("M5: no metadata oracle on conversations the caller isn't in", () => {
  it("M5: a nest admin who isn't in a private channel or DM gets 404 with no counts (preview and create)", async () => {
    const n = await newNest(carol);
    setConv("C-M5", ["SA", "SB"]);
    setConv("D-M5", ["SA"], { kind: "dm" });
    for (const conv of ["C-M5", "D-M5", "C-NOPE"]) {
      const pre = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: conv, nest_id: n }, carol.apiKey);
      expect(pre.status, conv).toBe(404);
      expect(pre.data.guard, conv).toBeUndefined();
      expect(JSON.stringify(pre.data)).not.toMatch(/members_total|guests|externals/);
      const cr = await bind({ conversation_id: conv, nest_id: n }, carol.apiKey);
      expect(cr.status, conv).toBe(404);
      expect(cr.data.guard_detail).toBeUndefined();
    }
  });

  it("M5: a member, or a server admin, may preview; a public channel is previewable by any nest admin", async () => {
    const n = await newNest(carol);
    setConv("C-M5b", ["SC"]);
    const member = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-M5b", nest_id: n }, carol.apiKey);
    expect(member.status).toBe(200);
    const rn = await newNest(root);
    const admin = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-M5", nest_id: rn }, root.apiKey);
    expect(admin.status).toBe(200);
    setConv("C-M5p", ["SA"], { kind: "public_channel", is_private: false });
    const pub = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-M5p", nest_id: n }, carol.apiKey);
    expect(pub.status).toBe(200);
  });
});

describe("M6: link redemption needs a surface-confirmed email", () => {
  it("M6: a matching but unconfirmed surface email goes to admin review, never a direct link", async () => {
    const uid = randomUUID();
    const email = `m6-${uid.slice(0, 6)}@r2.test`;
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, 'M6', 'x', ?)", [uid, email, new Date().toISOString()]);
    fake.profiles.set("U_M6", profile("U_M6", { email, email_confirmed: false }));
    const tok = await S.identity.issueLinkToken({ installId, surfaceUserId: "U_M6" });
    const r = await S.identity.redeemLinkToken({ token: tok, userId: uid });
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await S.db.getDb().get("SELECT 1 FROM surface_identity_links WHERE surface_user_id = 'U_M6' AND status = 'active'")).toBeUndefined();
    expect(await S.db.getDb().get("SELECT 1 FROM surface_link_reviews WHERE surface_user_id = 'U_M6' AND status = 'pending'")).toBeTruthy();
  });

  it("M6: the profile is refreshed at redeem time — a cached confirmed email that is now unconfirmed is refused", async () => {
    const uid = randomUUID();
    const email = `m6b-${uid.slice(0, 6)}@r2.test`;
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, 'M6b', 'x', ?)", [uid, email, new Date().toISOString()]);
    fake.profiles.set("U_M6B", profile("U_M6B", { email, email_confirmed: true }));
    await S.identity.getProfile(installId, "U_M6B"); // cache: confirmed
    fake.profiles.set("U_M6B", profile("U_M6B", { email, email_confirmed: false })); // surface now says unconfirmed
    const tok = await S.identity.issueLinkToken({ installId, surfaceUserId: "U_M6B" });
    const r = await S.identity.redeemLinkToken({ token: tok, userId: uid });
    expect(r.ok).toBe(false);
  });
});

describe("M7: home-workspace bots other than ours", () => {
  it("M7: another app's bot is a member who isn't a reader → surface_ok false; capture_ok unaffected; our bot is excluded", () => {
    const g = computeGuard({
      readers: { users: ["u1"], nonUser: [], universe: false },
      serverAdmins: [],
      members: {
        known: true,
        members: [
          { surface_user_id: "S1", is_guest: false, is_external: false, is_bot: false, home_tenant: "T1", community_user_id: "u1" },
          { surface_user_id: "B_OURS", is_guest: false, is_external: false, is_bot: true, home_tenant: "T1", community_user_id: null },
          { surface_user_id: "B_NOTES", is_guest: false, is_external: false, is_bot: true, home_tenant: "T1", community_user_id: null },
        ],
        conversation: { id: "C", kind: "private_channel", is_private: true, is_ext_shared: false, is_general: false, enumerable: true },
      },
      binding: { conversation_kind: "private_channel", explicit_public_bind: false, ext_capture_enabled: false },
      install: { bot_user_id: "B_OURS", home_tenant: "T1" },
    });
    expect(g.capture_ok).toBe(true);
    expect(g.surface_ok).toBe(false);
    expect(g.detail.members_not_readers).toBe(1);
    expect(g.detail.members_total).toBe(2);
  });
});

describe("LOW findings", () => {
  it("L1: a refused general-channel boot returns no emails, just 'a workspace admin can remove it'", async () => {
    const n = await newNest(root);
    setConv("C-L1", ["SR", "SC"], { kind: "public_channel", is_private: false, is_general: true });
    const b = await bind({ conversation_id: "C-L1", nest_id: n, explicit_public_bind: true }, root.apiKey);
    expect(b.status).toBe(201);
    const r = await S.bindings.bootBinding({ bindingId: b.data.binding.id, surfaceUserId: "SC" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("@");
    if (!r.ok) expect(r.message).toMatch(/a workspace admin can remove it/i);
  });

  it("L2: a shared-team member with a blank email still counts as a reader", async () => {
    const n = await newNest(alice);
    const ghost = randomUUID();
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Ghost', 'x')", [ghost, `ghost-${ghost}@r2.test`]);
    const teamId = randomUUID();
    await S.db.getDb().run("INSERT INTO teams (id, name, owner_id, members) VALUES (?, 'T', ?, ?)", [
      teamId, alice.userId, JSON.stringify([{ userId: ghost, email: "", role: "viewer" }]),
    ]);
    await S.db.getDb().run("UPDATE nests SET shared_teams = ? WHERE id = ?", [JSON.stringify([{ teamId, teamName: "T" }]), n]);
    setConv("C-L2", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-L2", nest_id: n }, alice.apiKey);
    expect(r.data.guard.capture_ok).toBe(false);
    expect(r.data.guard.detail.readers_absent).toBe(1);
  });

  it("L3: guard ticks never overlap — a tick while one is in flight is skipped", async () => {
    const { id } = await activeBinding("C-L3");
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_joined", conversation: "C-L3", user: "SB" });
    const g = fake.gate("C-L3");
    const first = S.runner.guardTick();
    await g.entered;
    expect(await S.runner.guardTick()).toBe("skipped");
    g.release();
    expect(await first).toContain(id);
  });

  it("L4: one-time link issuance is rate-limited per surface user, and expired tokens are purged", async () => {
    const sid = `U_L4_${randomUUID().slice(0, 4)}`;
    for (let i = 0; i < 5; i++) await S.identity.issueLinkToken({ installId, surfaceUserId: sid });
    await expect(S.identity.issueLinkToken({ installId, surfaceUserId: sid })).rejects.toMatchObject({ statusCode: 429 });
    const r = await S.identity.resolveActor({ installId, surfaceUserId: sid, action: "approve" });
    expect(r.status).toBe("rate_limited");
    const old = Date.now() - 3 * 24 * 60 * 60_000;
    await S.identity.issueLinkToken({ installId, surfaceUserId: `${sid}-old`, now: old });
    const purged = await S.identity.purgeLinkArtifacts();
    expect(purged.tokens).toBeGreaterThanOrEqual(1);
    expect(await S.db.getDb().get("SELECT 1 FROM surface_link_tokens WHERE surface_user_id = ?", [`${sid}-old`])).toBeUndefined();
  });

  it("L5: Surfaces is off in AUTH_MODE=open", () => {
    process.env.AUTH_MODE = "open";
    try {
      expect(S.flags.surfacesEnabled()).toBe(false);
    } finally {
      process.env.AUTH_MODE = "key";
    }
    expect(S.flags.surfacesEnabled()).toBe(true);
  });
});

describe("Round 2 residuals (security re-review)", () => {
  it("M1-partial: one nest's reader computation throwing fails closed only that nest's bindings; the sweep goes on for others", async () => {
    const a = await activeBinding("C-R-A");
    const b = await activeBinding("C-R-B");
    const runner = S.runner as any;
    runner.guardRunnerTestHooks ??= {};
    runner.guardRunnerTestHooks.beforeFingerprint = (nestId: string) => {
      if (nestId === a.nestId) throw new Error("reader query exploded");
    };
    try {
      await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_joined", conversation: "C-R-B", user: "SB" });
      const done = await S.runner.runGuardSweep();
      expect(done).toContain(b.id);
      expect((await row(b.id)).status).toBe("active");
      const ra = await row(a.id);
      expect(ra.status).toBe("paused_guard");
      expect(ra.capture_ok).toBe(0);
      const n = (await S.db.getDb().get("SELECT detail FROM surface_notices WHERE binding_id = ? AND kind = 'binding_paused'", [a.id])) as any;
      expect(JSON.parse(n.detail)).toMatchObject({ recheck_failed: true });
      expect(n.detail).not.toContain("exploded");
    } finally {
      runner.guardRunnerTestHooks.beforeFingerprint = undefined;
    }
  });

  it("N1: a DM bound to an org-visible personal nest is refused — both flags false", () => {
    const g = computeGuard({
      readers: { users: ["u1"], nonUser: [], universe: false, orgWide: true },
      serverAdmins: [],
      members: {
        known: true,
        members: [{ surface_user_id: "S1", is_guest: false, is_external: false, is_bot: false, home_tenant: "T1", community_user_id: "u1" }],
        conversation: { id: "D", kind: "dm", is_private: true, is_ext_shared: false, is_general: false, enumerable: true },
      },
      binding: { conversation_kind: "dm", explicit_public_bind: false, ext_capture_enabled: false, dm_owner_user_id: "u1" },
      install: { bot_user_id: "B_OURS", home_tenant: "T1" },
    });
    expect(g.capture_ok).toBe(false);
    expect(g.surface_ok).toBe(false);
  });

  it("N1 (service): binding a DM to an org-visible nest is refused (409)", async () => {
    const n = await newNest(bob);
    await jsonRequest(app, "PATCH", `/nests/${n}/visibility`, { visibility: "org" }, bob.apiKey);
    setConv("D-N1", ["SB"], { kind: "dm" });
    const r = await bind({ conversation_id: "D-N1", nest_id: n }, bob.apiKey);
    expect(r.status).toBe(409);
    expect(r.data.guard.capture_ok).toBe(false);
    expect(r.data.guard.surface_ok).toBe(false);
  });

  it("N2: a member leaving while a binding is being created is applied within one tick", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-N2", ["SA", "SD", "SC"]);
    const g = fake.gate("C-N2"); // create sees the OLD list
    const created = bind({ conversation_id: "C-N2", nest_id: n });
    await g.entered;
    setConv("C-N2", ["SA", "SC"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_left", conversation: "C-N2", user: "SD" });
    g.release();
    const r = await created;
    expect(r.status).toBe(201);
    await S.runner.runGuardSweep();
    expect((await row(r.data.binding.id)).status).toBe("paused_guard");
  });

  it("INFO: boot gives up after 5 lost compare-and-sets with a 409, never spinning", async () => {
    const { id } = await activeBinding("C-BOOTCAP");
    let bumps = 0;
    hooks().beforeBootCommit = async () => {
      if (bumps++ < 6) await S.db.getDb().run("UPDATE surface_bindings SET version = version + 1 WHERE id = ?", [id]);
    };
    try {
      await expect(S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" })).rejects.toMatchObject({ statusCode: 409 });
      expect((await row(id)).status).toBe("active");
    } finally {
      hooks().beforeBootCommit = undefined;
    }
  });

  it("INFO (M6): if the profile refresh fails at redeem time, a cached 'confirmed' email is never used — admin review", async () => {
    const uid = randomUUID();
    const email = `m6c-${uid.slice(0, 6)}@r2.test`;
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, 'M6c', 'x', ?)", [uid, email, new Date().toISOString()]);
    fake.profiles.set("U_M6C", profile("U_M6C", { email, email_confirmed: true }));
    await S.identity.getProfile(installId, "U_M6C"); // cached: confirmed
    fake.profiles.delete("U_M6C"); // the surface lookup now fails
    const tok = await S.identity.issueLinkToken({ installId, surfaceUserId: "U_M6C" });
    const r = await S.identity.redeemLinkToken({ token: tok, userId: uid });
    expect(r).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await S.db.getDb().get("SELECT 1 FROM surface_identity_links WHERE surface_user_id = 'U_M6C' AND status = 'active'")).toBeUndefined();
  });
});
