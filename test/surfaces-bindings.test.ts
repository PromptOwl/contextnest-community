/**
 * Surfaces S1 — bindings and the two-flag guard against the real permission
 * model (§4.10, §4.17, §12 R1, binding state machine §12 R3), over REST, MCP
 * and the services. The connector is the in-memory fake; no network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { createFakeConnector, conversation, member, type FakeConnector } from "./surfaces-fake-connector.js";

type User = { apiKey: string; userId: string; email: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: User; // nest owner
let bob: User;
let carol: User;
let dave: User;
let root: User; // server admin (superadmin)
let fake: FakeConnector;
let installId: string;
let S: {
  registry: typeof import("../src/surfaces/registry.js");
  installs: typeof import("../src/surfaces/services/install-store.js");
  bindings: typeof import("../src/surfaces/services/binding-service.js");
  runner: typeof import("../src/surfaces/services/guard-runner.js");
  identity: typeof import("../src/surfaces/services/identity-service.js");
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

async function newNest(owner: User, name = `N-${randomUUID().slice(0, 6)}`): Promise<string> {
  const r = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
  expect(r.status).toBe(201);
  return r.data.nest.id;
}
async function share(nestId: string, user: User, permission = "read") {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: user.email, permission }, alice.apiKey);
  expect(r.status).toBeLessThan(300);
}
/** Link a surface user to a Community user (explicit), so members map. */
async function link(surfaceUserId: string, user: User) {
  await S.identity.linkExplicit({ installId, surfaceUserId, communityUserId: user.userId });
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

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@surf.test"] });
  alice = await registerUser(app, "alice@surf.test", "Alice");
  bob = await registerUser(app, "bob@surf.test", "Bob");
  carol = await registerUser(app, "carol@surf.test", "Carol");
  await resetAuthRateLimit();
  dave = await registerUser(app, "dave@surf.test", "Dave");
  root = await registerUser(app, "root@surf.test", "Root");
  await resetAuthRateLimit();

  S = {
    registry: await import("../src/surfaces/registry.js"),
    installs: await import("../src/surfaces/services/install-store.js"),
    bindings: await import("../src/surfaces/services/binding-service.js"),
    runner: await import("../src/surfaces/services/guard-runner.js"),
    identity: await import("../src/surfaces/services/identity-service.js"),
    db: await import("../src/db/client.js"),
  };
  fake = createFakeConnector("slack");
  S.registry.registerConnector(fake);
  const homeNest = await newNest(alice, "Home");
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
  await link("SA", alice);
  await link("SB", bob);
  await link("SC", carol);
  await link("SD", dave);
  await link("SR", root);
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

describe("feature flag", () => {
  it("FEATURE_SURFACES off → /surfaces routes 404", async () => {
    process.env.FEATURE_SURFACES = "false";
    try {
      const r = await jsonRequest(app, "GET", "/surfaces/bindings", undefined, alice.apiKey);
      expect(r.status).toBe(404);
    } finally {
      process.env.FEATURE_SURFACES = "true";
    }
  });
});

describe("guard against the real permission model", () => {
  it("AC-GRD-01: private channel whose members map to every user reader → binding created, capture_ok", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    setConv("C-01", ["SA", "SB", "SC"]);
    const r = await bind({ conversation_id: "C-01", nest_id: n });
    expect(r.status).toBe(201);
    expect(r.data.binding.status).toBe("active");
    expect(r.data.binding.capture_ok).toBe(true);
    expect(r.data.binding.conversation_kind).toBe("private_channel");
  });

  it("AC-GRD-02: 312 readers vs a 7-member channel → 409, readers_absent 305, no active row", async () => {
    const n = await newNest(alice);
    const db = S.db.getDb();
    const members = ["SA"];
    for (let i = 0; i < 311; i++) {
      const id = randomUUID();
      await db.run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)", [id, `r${i}-${id}@surf.test`, null, "x"]);
      await db.run("INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, 'read', ?)", [
        randomUUID(), n, id, alice.userId,
      ]);
      if (i < 6) {
        await S.identity.linkExplicit({ installId, surfaceUserId: `R${i}`, communityUserId: id });
        members.push(`R${i}`);
      }
    }
    setConv("C-02", members);
    const r = await bind({ conversation_id: "C-02", nest_id: n });
    expect(r.status).toBe(409);
    expect(r.data.guard_detail.readers_total).toBe(312);
    expect(r.data.guard_detail.readers_absent).toBe(305);
    const rows = await db.all("SELECT * FROM surface_bindings WHERE conversation_id = 'C-02' AND status = 'active'");
    expect(rows).toEqual([]);
  });

  it("AC-GRD-03: an org/service key (system account) with read on N → capture_ok false, non_user_principals has key", async () => {
    const n = await newNest(alice);
    const sys = await jsonRequest(app, "POST", "/systems", { name: "Sync bot", capability: "read", nest_ids: [n] }, alice.apiKey);
    expect(sys.status).toBe(201);
    setConv("C-03", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-03", nest_id: n }, alice.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.guard.capture_ok).toBe(false);
    expect(r.data.guard.detail.non_user_principals).toContain("key");
  });

  it("AC-GRD-04: a personal key or MCP token bound to a member adds no principal", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    // bob mints a nest-scoped personal key and holds an MCP OAuth token
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: bob.email, password: "testpass" }),
    });
    const cookie = login.headers.get("set-cookie") || "";
    const k = await app.request("/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ label: "bob-n", nest_id: n, capability: "read" }),
    });
    expect(k.status).toBeLessThan(300);
    await S.db.getDb().run(
      "INSERT INTO oauth_tokens (id, user_id, client_id, client_name, access_token_hash, scope, expires_at) VALUES (?, ?, 'c', 'Claude', ?, 'mcp', '2999-01-01')",
      [randomUUID(), bob.userId, randomUUID()],
    );
    setConv("C-04", ["SA", "SB"]);
    const r = await bind({ conversation_id: "C-04", nest_id: n });
    expect(r.status).toBe(201);
    expect(r.data.binding.capture_ok).toBe(true);
    expect(r.data.guard.detail.non_user_principals).toEqual([]);
  });

  it("AC-GRD-05 (amended by S2a carry-forward 2): another agent reading N blocks capture; only the server-tied listener of a binding does not", async () => {
    const n = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/listener', ?, ?)",
      [n, randomUUID(), alice.email],
    );
    setConv("C-05", ["SA"]);
    const other = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-05", nest_id: n }, alice.apiKey);
    expect(other.data.guard.capture_ok).toBe(false);
    expect(other.data.guard.detail.non_user_principals).toContain("agent");
    // Naming an existing agent as the listener no longer exempts it: the tie
    // must be one Surfaces created for this binding.
    await expect(
      S.bindings.createBinding({ actorUserId: alice.userId, installId, conversationId: "C-05", nestId: n, listenerAgentNodeId: "nodes/listener" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await S.db.getDb().run("DELETE FROM metacognition_agents WHERE nest_id = ? AND node_id = 'nodes/listener'", [n]);
    const { createBindingWithListener } = await import("../src/surfaces/services/listener-service.js");
    const own = await createBindingWithListener({ actorUserId: alice.userId, installId, conversationId: "C-05", nestId: n });
    expect(own.binding.listener_agent_node_id).toMatch(/^nodes\/nest-listener-/);
    const again = await S.bindings.recheckBinding(own.binding.id);
    expect(again.capture_ok).toBe(1);
  });

  // po-1431 replaces the old AC-GRD-06 (connector → refused): a bound nest's
  // connector posts carry no content, so a connector is not a reader.
  it("AC-GRD-06 (po-1431): an enabled outbound connector on N no longer blocks the bind", async () => {
    for (const channel of ["slack", "teams", "webhook"]) {
      const n = await newNest(alice);
      const url = channel === "slack" ? "https://hooks.slack.com/services/T/B/X" : "https://example.com/hook";
      const cr = await jsonRequest(app, "POST", `/nests/${n}/connectors`, { channel, url, events: ["*"] }, alice.apiKey);
      expect(cr.status, JSON.stringify(cr.data)).toBeLessThan(300);
      setConv("C-06", ["SA"]);
      const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-06", nest_id: n }, alice.apiKey);
      expect(r.data.guard.capture_ok, channel).toBe(true);
      expect(r.data.guard.detail.non_user_principals).not.toContain("connector");
    }
  });

  it("AC-GRD-07: link-shared or public N → capture_ok false for a non-public conversation", async () => {
    const pub = await newNest(alice);
    const v = await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, alice.apiKey);
    expect(v.status).toBeLessThan(300);
    const linked = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO publish (id, nest_id, node_id, slug, access_mode, created_by, created_at) VALUES (?, ?, 'nodes/x', ?, 'public', ?, '2026-10-30T00:00:00.000Z')",
      [randomUUID(), linked, `s-${randomUUID()}`, alice.userId],
    );
    setConv("C-07", ["SA"]);
    for (const n of [pub, linked]) {
      const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-07", nest_id: n }, alice.apiKey);
      expect(r.data.guard.capture_ok).toBe(false);
      expect(r.data.guard.detail.universe).toBe(true);
    }
  });

  it("AC-GRD-08 (superseded by §12 R1): a server admin who is not a member does not block; a nest admin who is not a member does", async () => {
    const n = await newNest(alice);
    setConv("C-08", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-08", nest_id: n }, alice.apiKey);
    expect(r.data.guard.capture_ok).toBe(true);
    await share(n, carol, "admin");
    const r2 = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-08", nest_id: n }, alice.apiKey);
    expect(r2.data.guard.capture_ok).toBe(false);
    expect(r2.data.guard.detail.readers_absent).toBe(1);
  });

  it("AC-GRD-08 (superseded by §12 R1): an owner who isn't in the conversation still blocks", async () => {
    const n = await newNest(alice);
    await share(n, bob, "admin");
    setConv("C-08b", ["SB"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-08b", nest_id: n }, bob.apiKey);
    expect(r.data.guard.capture_ok).toBe(false);
  });

  it("AC-GRD-ADM: every collaborator and team member present, server admin absent → capture_ok, with disclosure", async () => {
    const n = await newNest(alice);
    await share(n, bob, "write");
    const teamId = randomUUID();
    await S.db.getDb().run("INSERT INTO teams (id, name, owner_id, members) VALUES (?, 'Ops', ?, ?)", [
      teamId, alice.userId, JSON.stringify([{ userId: carol.userId, email: carol.email, role: "editor" }]),
    ]);
    await S.db.getDb().run("UPDATE nests SET shared_teams = ? WHERE id = ?", [JSON.stringify([{ teamId, teamName: "Ops" }]), n]);
    setConv("C-ADM", ["SA", "SB"]);
    const missingTeam = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-ADM", nest_id: n }, alice.apiKey);
    expect(missingTeam.data.guard.capture_ok).toBe(false); // a team member is a reader too
    setConv("C-ADM", ["SA", "SB", "SC"]);
    const r = await bind({ conversation_id: "C-ADM", nest_id: n });
    expect(r.status).toBe(201);
    expect(r.data.binding.capture_ok).toBe(true);
    expect(r.data.disclosure).toBe("This server's administrators can read every nest.");
    expect(r.data.binding.disclosure).toBe("This server's administrators can read every nest.");
    expect(r.data.guard.detail.server_admins_disclosed).toBe(true);
  });

  it("AC-GRD-09: public channel, explicit_public_bind, readers outside → capture_ok", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    setConv("C-09", ["SA"], { kind: "public_channel", is_private: false });
    // round-2 M4: only a server admin may make an explicit public bind
    const r = await bind({ conversation_id: "C-09", nest_id: n, explicit_public_bind: true }, root.apiKey);
    expect(r.status).toBe(201);
    expect(r.data.binding.capture_ok).toBe(true);
    expect(r.data.binding.explicit_public_bind).toBe(true);
  });

  it("AC-GRD-10: an admin binds a public channel with a single-channel guest using explicit_public_bind — not 422; org_public false; subset rule decides (201 when all readers are present, 409 when not)", async () => {
    const guestChannel = (id: string) =>
      fake.conversations.set(id, {
        info: conversation(id, { kind: "public_channel", is_private: false }),
        members: [member("SR"), member("G1", { is_guest: true })],
      });
    // (a) every reader of the nest is in the channel → 201 under the subset rule
    const allIn = await newNest(root);
    guestChannel("C-10a");
    const a = await bind({ conversation_id: "C-10a", nest_id: allIn, explicit_public_bind: true }, root.apiKey);
    expect(a.status).toBe(201);
    expect(a.data.binding.capture_ok).toBe(true);
    expect(a.data.guard.org_public).toBe(false);
    expect(a.data.guard.capture_basis).toBe("subset");
    expect(a.data.guard.detail.guests).toBe(1);
    expect(a.data.binding.surface_ok).toBe(false); // a guest is present
    // (b) a reader is outside the channel → refused under the subset rule (409, counts only), never 422
    const outside = await newNest(root);
    const sh = await jsonRequest(app, "POST", `/nests/${outside}/collaborators`, { email: bob.email, permission: "read" }, root.apiKey);
    expect(sh.status).toBeLessThan(300);
    guestChannel("C-10b");
    const b = await bind({ conversation_id: "C-10b", nest_id: outside, explicit_public_bind: true }, root.apiKey);
    expect(b.status).toBe(409);
    expect(b.data.code).toBe("guard_refused");
    expect(b.data.guard.org_public).toBe(false);
    expect(b.data.guard_detail).toMatchObject({ readers_absent: 1, guests: 1 });
    expect(JSON.stringify(b.data.guard_detail)).not.toMatch(/bob|SR|G1/);
  });

  it("AC-GRD-10 (MCP): the same explicit bind over context_surfaces_binding_create falls back to the subset rule", async () => {
    const n = await newNest(root);
    fake.conversations.set("C-10m", {
      info: conversation("C-10m", { kind: "public_channel", is_private: false }),
      members: [member("SR"), member("G1", { is_guest: true })],
    });
    const out = await mcp(
      `/nests/${n}/mcp`,
      "tools/call",
      { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C-10m", explicit_public_bind: true } },
      root.apiKey,
    );
    expect(out.result?.isError).toBeFalsy();
    const r = (await S.db.getDb().get("SELECT * FROM surface_bindings WHERE conversation_id = 'C-10m'")) as any;
    expect(r.status).toBe("active");
    expect(r.capture_ok).toBe(1);
    expect(JSON.parse(r.guard_detail).guests).toBe(1);
  });

  it("explicit_public_bind on a private conversation → 422", async () => {
    const n = await newNest(alice);
    setConv("C-09p", ["SA"]);
    const r = await bind({ conversation_id: "C-09p", nest_id: n, explicit_public_bind: true });
    expect(r.status).toBe(422);
  });

  it("AC-GRD-13: ext-shared → external capture off by default (refused), explicit public bind 422, enabling evaluates capture and surface stays off", async () => {
    const n = await newNest(alice);
    setConv("C-13", ["SA"], { is_ext_shared: true });
    const pre = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-13", nest_id: n }, alice.apiKey);
    expect(pre.data.guard.capture_ok).toBe(false);
    expect(pre.data.ext_capture_enabled).toBe(false);
    const refused = await bind({ conversation_id: "C-13", nest_id: n });
    expect(refused.status).toBe(409);
    const pub = await bind({ conversation_id: "C-13", nest_id: n, explicit_public_bind: true });
    expect(pub.status).toBe(422);
    const on = await bind({ conversation_id: "C-13", nest_id: n, ext_capture_enabled: true });
    expect(on.status).toBe(201);
    expect(on.data.binding.capture_ok).toBe(true);
    expect(on.data.binding.surface_ok).toBe(false);
    expect(on.data.binding.ext_capture_enabled).toBe(true);
  });

  it("AC-GRD-14: members unknown → refused; an existing binding whose re-check can't see members → paused_guard", async () => {
    const n = await newNest(alice);
    fake.conversations.set("C-14", { info: conversation("C-14"), members: [member("SA")], fail: "throw" });
    // round-2 M5: only a server admin sees the guard verdict for a conversation whose members can't be read
    const r = await bind({ conversation_id: "C-14", nest_id: n }, root.apiKey);
    expect(r.status).toBe(409);
    expect(r.data.guard.members_known).toBe(false);
    setConv("C-14", ["SA"]);
    const ok = await bind({ conversation_id: "C-14", nest_id: n });
    expect(ok.status).toBe(201);
    fake.conversations.get("C-14")!.fail = "incomplete";
    const re = await jsonRequest(app, "POST", `/surfaces/bindings/${ok.data.binding.id}/recheck`, {}, alice.apiKey);
    expect(re.status).toBe(200);
    expect(re.data.binding.status).toBe("paused_guard");
    expect(re.data.binding.members_known).toBe(false);
  });
});

describe("guard re-checks (§4.17)", () => {
  it("AC-GRD-15: a reader leaves → within the guard tick the binding pauses, buffer/pending hooks run, admin alert is counts only", async () => {
    expect(S.runner.GUARD_TICK_MS).toBeLessThanOrEqual(60_000);
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-15", ["SA", "SD"]);
    const b = await bind({ conversation_id: "C-15", nest_id: n });
    expect(b.status).toBe(201);
    const id = b.data.binding.id;
    // dave leaves
    setConv("C-15", ["SA"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_left", conversation: "C-15", user: "SD" });
    expect((await row(id)).guard_dirty).toBe(1);
    await S.runner.runGuardSweep();
    const r = await row(id);
    expect(r.status).toBe("paused_guard");
    expect(r.guard_dirty).toBe(0);
    expect(paused).toEqual([{ bindingId: id, reason: "guard" }]);
    const notices = (await S.db.getDb().all("SELECT * FROM surface_notices WHERE binding_id = ? AND kind = 'binding_paused'", [id])) as any[];
    expect(notices.length).toBe(1);
    expect(notices[0].audience).toBe("admins");
    const detail = notices[0].detail as string;
    for (const leak of ["dave", "Dave", "SD", "surf.test", "#C-15"]) expect(detail).not.toContain(leak);
    expect(JSON.parse(detail)).toMatchObject({ readers_absent: 1 });
  });

  it("AC-GRD-16: a paused_guard binding that becomes valid stays paused until an admin resumes it", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-16", ["SA", "SD"]);
    const b = await bind({ conversation_id: "C-16", nest_id: n });
    const id = b.data.binding.id;
    setConv("C-16", ["SA"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_left", conversation: "C-16", user: "SD" });
    await S.runner.runGuardSweep();
    expect((await row(id)).status).toBe("paused_guard");
    setConv("C-16", ["SA", "SD"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_joined", conversation: "C-16", user: "SD" });
    await S.runner.runGuardSweep();
    const after = await row(id);
    expect(after.status).toBe("paused_guard");
    expect(after.capture_ok).toBe(1);
    const nonAdmin = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, { reason: "test resume" }, dave.apiKey);
    expect(nonAdmin.status).toBe(403);
    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, { reason: "test resume" }, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.binding.status).toBe("active");
  });

  it("po-1437: a nest admin pauses listening; the guard never resumes it; Resume brings it back with the reason cleared", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-1437", ["SA", "SD"]);
    const b = await bind({ conversation_id: "C-1437", nest_id: n });
    expect(b.status).toBe(201);
    const id = b.data.binding.id;
    paused.length = 0;

    const nonAdmin = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/pause`, { reason: "launch week" }, dave.apiKey);
    expect(nonAdmin.status).toBe(403);
    // A reason is required, so the team can see why.
    for (const body of [{}, { reason: "  " }, { reason: "ok" }]) {
      expect((await jsonRequest(app, "POST", `/surfaces/bindings/${id}/pause`, body, alice.apiKey)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, alice.apiKey)).status).toBe(422);
    expect((await jsonRequest(app, "DELETE", `/surfaces/bindings/${id}`, undefined, alice.apiKey)).status).toBe(422);
    expect((await row(id)).status).toBe("active");
    const p = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/pause`, { reason: "launch week" }, alice.apiKey);
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data.binding).toMatchObject({ status: "paused_guard", paused_by_admin: true });
    // The pause hooks purge the buffer and withdraw pending cards, as for any pause.
    expect(paused).toEqual([{ bindingId: id, reason: "admin" }]);
    // No "the guard failed" alert for a pause an admin chose.
    expect((await S.db.getDb().all("SELECT 1 FROM surface_notices WHERE binding_id = ? AND kind = 'binding_paused'", [id])).length).toBe(0);
    expect((await jsonRequest(app, "POST", `/surfaces/bindings/${id}/pause`, { reason: "again" }, alice.apiKey)).status).toBe(409);

    // A passing guard sweep leaves it paused.
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_joined", conversation: "C-1437", user: "SD" });
    await S.runner.runGuardSweep();
    expect((await row(id)).status).toBe("paused_guard");

    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, { reason: "launch is over" }, alice.apiKey);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.binding).toMatchObject({ status: "active", paused_by_admin: false });

    // The history keeps every change, newest first, with the actual person (id + email) and the reason.
    expect((await jsonRequest(app, "GET", `/surfaces/bindings/${id}/history`, undefined, dave.apiKey)).status).toBe(403);
    const h = await jsonRequest(app, "GET", `/surfaces/bindings/${id}/history`, undefined, alice.apiKey);
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(h.data.history.map((e: any) => [e.action, e.reason, e.by?.email ?? null])).toEqual([
      ["resumed", "launch is over", alice.email],
      ["paused", "launch week", alice.email],
      ["started", null, alice.email],
    ]);
    expect(h.data.history[0].by.user_id).toBe(alice.userId);
  });

  it("po-1437: a pause nobody chose (the guard) and a removal go on the history too", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-1437g", ["SA", "SD"]);
    const id = (await bind({ conversation_id: "C-1437g", nest_id: n })).data.binding.id;
    setConv("C-1437g", ["SA"]);
    await S.runner.handleSurfaceSignal(installId, { surface: "slack", workspace: "T1", kind: "member_left", conversation: "C-1437g", user: "SD" });
    await S.runner.runGuardSweep();
    expect((await jsonRequest(app, "DELETE", `/surfaces/bindings/${id}`, { reason: "channel retired" }, alice.apiKey)).status).toBe(200);
    const h = (await jsonRequest(app, "GET", `/surfaces/bindings/${id}/history`, undefined, alice.apiKey)).data.history;
    expect(h.map((e: any) => [e.action, e.by ? "person" : "nest"])).toEqual([
      ["removed", "person"],
      ["paused", "nest"],
      ["started", "person"],
    ]);
    expect(h[1].reason).toMatch(/^Paused by Nest/);
  });

  it("archiving a nest pauses its listening channels as an admin pause; deleting removes them and its pending installs", async () => {
    const nests = await import("../src/nests/service.js");
    const a = await newNest(alice);
    setConv("C-arch", ["SA"]);
    const aId = (await bind({ conversation_id: "C-arch", nest_id: a })).data.binding.id;
    paused.length = 0;
    await nests.archiveNest(a);
    expect(await row(aId)).toMatchObject({ status: "paused_guard", pause_reason: "admin" });
    expect(paused).toEqual([{ bindingId: aId, reason: "admin" }]);

    const d = await newNest(alice);
    setConv("C-del", ["SA"]);
    const dId = (await bind({ conversation_id: "C-del", nest_id: d })).data.binding.id;
    const pending = await S.installs.createInstall({ surface: "slack", mode: "hosted", tenantKey: `pending:${randomUUID()}`, homeNestId: d, installedByUserId: alice.userId });
    paused.length = 0;
    await nests.deleteNest(d);
    // Stopped first (hooks purge + withdraw), then the nest's FK cascade drops the row.
    expect(paused).toEqual([{ bindingId: dId, reason: "removed" }]);
    expect(await row(dId)).toBeUndefined();
    expect(await S.installs.getInstall(pending.id)).toBeNull();
    // The active install homed elsewhere is untouched.
    expect((await S.installs.getInstall(installId))?.status).toBe("active");
  });

  it("po-1437: moving a channel to another nest = remove, then bind the same channel to the new nest", async () => {
    const n1 = await newNest(alice);
    const n2 = await newNest(alice);
    setConv("C-1437m", ["SA"]);
    const first = await bind({ conversation_id: "C-1437m", nest_id: n1 });
    expect(first.status).toBe(201);
    expect((await jsonRequest(app, "DELETE", `/surfaces/bindings/${first.data.binding.id}`, { reason: "test remove" }, alice.apiKey)).status).toBe(200);
    const moved = await bind({ conversation_id: "C-1437m", nest_id: n2 });
    expect(moved.status, JSON.stringify(moved.data)).toBe(201);
    expect(moved.data.binding).toMatchObject({ nest_id: n2, status: "active" });
  });

  it("po-1437 review: a second stop is 409 with no extra history row; a move names the nest from the server; history stays per nest", async () => {
    const n1 = await newNest(alice, "Old Nest");
    const n2 = await newNest(alice, "New Nest");
    setConv("C-1437r", ["SA"]);
    const id = (await bind({ conversation_id: "C-1437r", nest_id: n1 })).data.binding.id;
    // moved_to_nest_id is resolved server-side; a free-text moved_to is ignored.
    const del = await jsonRequest(app, "DELETE", `/surfaces/bindings/${id}`, { reason: "new team", moved_to_nest_id: n2, moved_to: "<!channel>" }, alice.apiKey);
    expect(del.status, JSON.stringify(del.data)).toBe(200);
    expect((await jsonRequest(app, "DELETE", `/surfaces/bindings/${id}`, { reason: "double click" }, alice.apiKey)).status).toBe(409);
    const old = (await S.db.getDb().all("SELECT action, reason, nest_id FROM surface_binding_history WHERE binding_id = ? ORDER BY created_at", [id])) as any[];
    expect(old.map((h) => h.action)).toEqual(["started", "moved"]);
    expect(old[1].reason).toBe("new team (moved to New Nest)");

    // Re-bound to the new nest (same row): its admins see only the new nest's history.
    expect((await bind({ conversation_id: "C-1437r", nest_id: n2 })).status).toBe(201);
    const h = (await jsonRequest(app, "GET", `/surfaces/bindings/${id}/history`, undefined, alice.apiKey)).data.history;
    expect(h.map((e: any) => e.action)).toEqual(["started"]);
  });

  it("po-1446: activity maps verdicts and card states, and counts only the last 7 UTC days", async () => {
    const n = await newNest(alice);
    setConv("C-1446", ["SA"]);
    const id = (await bind({ conversation_id: "C-1446", nest_id: n })).data.binding.id;
    const db = S.db.getDb();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const counter = (day: string, metric: string, value: number) =>
      db.run("INSERT INTO surface_counters (org_id, nest_id, binding_id, day, metric, value, created_at) VALUES ('default', ?, ?, ?, ?, ?, ?)", [n, id, day, metric, value, now]);
    await counter(now.slice(0, 10), "buffered", 4);
    await counter(now.slice(0, 10), "drop_too_short", 2);
    await counter(old.slice(0, 10), "buffered", 50); // outside the window
    const win = (status: string, verdict: string | null, judgedAt: string | null) =>
      db.run(
        "INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, status, verdict, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), id, n, randomUUID(), now, now, status, verdict, judgedAt],
      );
    await win("open", null, null);
    await win("judged", "propose", now);
    await win("judged", "no_op", now);
    await win("judged", "filtered", now);
    await win("judged", "error", now);
    await win("judged", "budget_exhausted", now);
    await win("judged", "propose", old); // outside the window
    await win("discarded", "discarded", now); // never counted
    const card = (state: string, postedAt: string | null, createdAt: string) =>
      db.run(
        "INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, posted_at, expires_at, created_at) VALUES (?, ?, ?, ?, 'single', ?, ?, ?, ?)",
        [randomUUID(), randomUUID(), id, n, state, postedAt, now, createdAt],
      );
    await card("held", null, now);
    await card("queued", null, now);
    await card("decided", now, now); // reached the channel
    await card("expired", null, now); // expired while held: never posted
    await card("posted", old, old); // outside the window

    const a = (await jsonRequest(app, "GET", `/surfaces/bindings/${id}/activity`, undefined, alice.apiKey)).data;
    expect(a).toMatchObject({
      days: 7,
      received: 6,
      buffered: 4,
      skipped: { too_short: 2 },
      waiting: 1,
      judged: { proposed: 1, nothing_kept: 2, failed: 2 },
      cards: { posted: 1, queued: 1, held: 1 },
    });
  });

  it("resume refuses while the guard still fails", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-16b", ["SA", "SD"]);
    const b = await bind({ conversation_id: "C-16b", nest_id: n });
    setConv("C-16b", ["SA"]);
    await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/recheck`, {}, alice.apiKey);
    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/resume`, { reason: "test resume" }, alice.apiKey);
    expect(res.status).toBe(409);
  });

  describe("AC-GRD-17: every Community mutation marks the nest's bindings dirty and they are recomputed", () => {
    let n: string;
    let id: string;
    async function freshBinding() {
      n = await newNest(alice);
      setConv("C-17", ["SA", "SB", "SC"]);
      await S.db.getDb().run("DELETE FROM surface_bindings WHERE conversation_id = 'C-17'");
      const b = await bind({ conversation_id: "C-17", nest_id: n });
      expect(b.status).toBe(201);
      id = b.data.binding.id;
      // settle: nothing pending
      await S.runner.runGuardSweep();
      expect(await S.runner.runGuardSweep()).not.toContain(id);
    }
    async function expectRecomputed(label: string) {
      const recomputed = await S.runner.runGuardSweep();
      expect(recomputed, label).toContain(id);
      expect((await row(id)).guard_dirty, label).toBe(0);
    }

    it("AC-GRD-17: share added / role changed / removed", async () => {
      await freshBinding();
      await share(n, bob, "read");
      await expectRecomputed("share added");
      const collab = (await S.db.getDb().get("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [n, bob.userId])) as any;
      await jsonRequest(app, "PATCH", `/nests/${n}/collaborators/${collab.id}`, { permission: "write" }, alice.apiKey);
      await expectRecomputed("role changed");
      await jsonRequest(app, "DELETE", `/nests/${n}/collaborators/${collab.id}`, undefined, alice.apiKey);
      await expectRecomputed("share removed");
    });

    it("AC-GRD-17: visibility / link-sharing changed", async () => {
      await freshBinding();
      await jsonRequest(app, "PATCH", `/nests/${n}/visibility`, { visibility: "org" }, alice.apiKey);
      await expectRecomputed("visibility");
      expect((await row(id)).status).toBe("paused_guard");
    });

    it("AC-GRD-17: server admin added / removed", async () => {
      await freshBinding();
      const add = await jsonRequest(app, "POST", "/admin/super-admins", { email: carol.email }, root.apiKey);
      expect(add.status).toBeLessThan(300);
      await expectRecomputed("admin added");
      await jsonRequest(app, "DELETE", `/admin/super-admins/${encodeURIComponent(carol.email)}`, undefined, root.apiKey);
      await expectRecomputed("admin removed");
    });

    it("AC-GRD-17: service key created / revoked", async () => {
      await freshBinding();
      const sys = await jsonRequest(app, "POST", "/systems", { name: `K-${randomUUID().slice(0, 4)}`, capability: "read", nest_ids: [n] }, alice.apiKey);
      expect(sys.status).toBe(201);
      await expectRecomputed("key created");
      expect((await row(id)).status).toBe("paused_guard");
      const revoked = await jsonRequest(app, "DELETE", `/systems/${sys.data.id}`, undefined, alice.apiKey);
      expect(revoked.status).toBeLessThan(300);
      await expectRecomputed("key revoked");
      expect((await row(id)).capture_ok).toBe(1); // guard passes again, but stays paused until Resume
    });

    it("AC-GRD-17: agent created / deleted", async () => {
      await freshBinding();
      await S.db.getDb().run(
        "INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/other', ?, ?)",
        [n, randomUUID(), alice.email],
      );
      await expectRecomputed("agent created");
      await S.db.getDb().run("DELETE FROM metacognition_agents WHERE nest_id = ?", [n]);
      await expectRecomputed("agent deleted");
    });

    // Outbound connectors are not readers since po-1431, so a connector change needs no re-check.

    it("AC-GRD-17: identity link created / revoked", async () => {
      await freshBinding();
      const newbie = randomUUID();
      await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'New', 'x')", [newbie, `new-${newbie}@surf.test`]);
      await S.identity.linkExplicit({ installId, surfaceUserId: "S-NEW", communityUserId: newbie });
      await expectRecomputed("link created");
      const l = (await S.db.getDb().get("SELECT id FROM surface_identity_links WHERE surface_user_id = 'S-NEW' AND status = 'active'")) as any;
      await S.identity.revokeLink({ linkId: l.id, byUserId: root.userId, reason: "test" });
      await expectRecomputed("link revoked");
    });

    it("AC-GRD-17: user email verification changed", async () => {
      await freshBinding();
      const { markEmailVerified } = await import("../src/auth/email-verified.js");
      await markEmailVerified(dave.userId, "test");
      await expectRecomputed("email verified");
    });
  });
});

describe("AC-GRD-19: DM bindings", () => {
  it("AC-GRD-19: personal nest read only by U (and server admins) → both flags true; another reader → refused", async () => {
    const personal = await newNest(bob, "Bob personal");
    setConv("D-19", ["SB", "B_OURS"], { kind: "dm", is_private: true });
    fake.conversations.get("D-19")!.members[1].is_bot = true;
    const r = await bind({ conversation_id: "D-19", nest_id: personal }, bob.apiKey);
    expect(r.status).toBe(201);
    expect(r.data.binding.conversation_kind).toBe("dm");
    expect(r.data.binding.capture_ok).toBe(true);
    expect(r.data.binding.surface_ok).toBe(true);
    expect(r.data.binding.dm_owner_user_id).toBe(bob.userId);

    const other = await newNest(bob, "Bob shared");
    await jsonRequest(app, "POST", `/nests/${other}/collaborators`, { email: carol.email, permission: "read" }, bob.apiKey);
    setConv("D-19b", ["SB"], { kind: "dm", is_private: true });
    const refused = await bind({ conversation_id: "D-19b", nest_id: other }, bob.apiKey);
    expect(refused.status).toBe(409);
    expect(refused.data.guard.capture_ok).toBe(false);
    expect(refused.data.guard.surface_ok).toBe(false);
  });
});

describe("binding state machine (§12): active | paused_guard | paused_by_member | removed", () => {
  it("a member boots a non-general conversation → paused_by_member, idempotent; hooks purge + withdraw", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    setConv("C-BOOT", ["SA", "SB", "SC"]);
    const b = await bind({ conversation_id: "C-BOOT", nest_id: n });
    const id = b.data.binding.id;
    const first = await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    expect(first.ok).toBe(true);
    const r1 = await row(id);
    expect(r1.status).toBe("paused_by_member");
    expect(r1.booted_by_surface_user_id).toBe("SC");
    expect(paused).toEqual([{ bindingId: id, reason: "member_boot" }]);
    const second = await S.bindings.bootBinding({ bindingId: id, surfaceUserId: "SC" });
    expect(second).toEqual(first);
    expect(paused.length).toBe(1);
    // admin view shows who booted, no reason field
    const view = await jsonRequest(app, "GET", `/surfaces/bindings/${id}`, undefined, alice.apiKey);
    expect(view.data.binding.status).toBe("paused_by_member");
    expect(view.data.binding.booted_by).toBeTruthy();
    expect(view.data.binding.booted_at).toBeTruthy();
    expect("boot_reason" in view.data.binding).toBe(false);
    // re-bind refused while the booting member is present and hasn't consented
    const resume = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, { reason: "test resume" }, alice.apiKey);
    expect(resume.status).toBe(409);
    await S.bindings.consentToReturn({ bindingId: id, surfaceUserId: "SC" });
    const ok = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, { reason: "test resume" }, alice.apiKey);
    expect(ok.status).toBe(200);
    expect(ok.data.binding.status).toBe("active");
  });

  it("re-bind after a boot is allowed once the booting member has left", async () => {
    const n = await newNest(alice);
    setConv("C-BOOT2", ["SA", "SC"]);
    const b = await bind({ conversation_id: "C-BOOT2", nest_id: n });
    await S.bindings.bootBinding({ bindingId: b.data.binding.id, surfaceUserId: "SC" });
    setConv("C-BOOT2", ["SA"]);
    const ok = await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/resume`, { reason: "test resume" }, alice.apiKey);
    expect(ok.status).toBe(200);
  });

  it("a non-admin cannot boot a general channel; nothing changes", async () => {
    const n = await newNest(alice);
    setConv("C-GEN", ["SA", "SC"], { kind: "public_channel", is_private: false, is_general: true });
    const b = await bind({ conversation_id: "C-GEN", nest_id: n, explicit_public_bind: true }, root.apiKey);
    expect(b.status).toBe(201);
    const r = await S.bindings.bootBinding({ bindingId: b.data.binding.id, surfaceUserId: "SC" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("general_channel");
    expect((await row(b.data.binding.id)).status).toBe("active");
  });

  it("DELETE → removed (hooks run); re-creating the same conversation re-binds through the guard", async () => {
    const n = await newNest(alice);
    setConv("C-DEL", ["SA"]);
    const b = await bind({ conversation_id: "C-DEL", nest_id: n });
    const del = await jsonRequest(app, "DELETE", `/surfaces/bindings/${b.data.binding.id}`, { reason: "test remove" }, alice.apiKey);
    expect(del.status).toBe(200);
    expect(del.data.binding.status).toBe("removed");
    expect(paused).toEqual([{ bindingId: b.data.binding.id, reason: "removed" }]);
    const again = await bind({ conversation_id: "C-DEL", nest_id: n });
    expect(again.status).toBe(201);
    expect(again.data.binding.id).toBe(b.data.binding.id);
    expect(again.data.binding.status).toBe("active");
  });

  it("only a nest admin can bind; a reader gets 403", async () => {
    const n = await newNest(alice);
    await share(n, bob, "read");
    setConv("C-403", ["SA", "SB"]);
    const r = await bind({ conversation_id: "C-403", nest_id: n }, bob.apiKey);
    expect(r.status).toBe(403);
  });

  it("PATCH re-runs the guard; turning explicit_public_bind off on a public channel with absent readers pauses", async () => {
    const n = await newNest(alice);
    await share(n, bob);
    setConv("C-PATCH", ["SA"], { kind: "public_channel", is_private: false });
    const b = await bind({ conversation_id: "C-PATCH", nest_id: n, explicit_public_bind: true }, root.apiKey);
    const p = await jsonRequest(app, "PATCH", `/surfaces/bindings/${b.data.binding.id}`, { explicit_public_bind: false }, alice.apiKey);
    expect(p.status).toBe(200);
    expect(p.data.binding.status).toBe("paused_guard");
  });

  it("GET /surfaces/status and list show bindings with their guard status", async () => {
    const st = await jsonRequest(app, "GET", "/surfaces/status", undefined, alice.apiKey);
    expect(st.status).toBe(200);
    expect(st.data.disclosure).toBe("This server's administrators can read every nest.");
    expect(st.data.bindings.total).toBeGreaterThan(0);
    const list = await jsonRequest(app, "GET", "/surfaces/bindings", undefined, alice.apiKey);
    expect(list.data.bindings.length).toBeGreaterThan(0);
    expect(list.data.bindings[0]).toHaveProperty("capture_ok");
    // a user with no admin nests sees none of alice's
    const daveList = await jsonRequest(app, "GET", "/surfaces/bindings", undefined, dave.apiKey);
    expect(daveList.data.bindings).toEqual([]);
  });
});

describe("MCP parity for bindings", () => {
  it("binding tools are advertised to nest admins only, and create/list/recheck/resume/delete mirror REST", async () => {
    const n = await newNest(alice);
    await share(n, bob, "read");
    const names = ((await mcp(`/nests/${n}/mcp`, "tools/list", {}, alice.apiKey)).result?.tools ?? []).map((t: any) => t.name);
    for (const t of [
      "context_surfaces_status",
      "context_surfaces_bindings_list",
      "context_surfaces_binding_create",
      "context_surfaces_binding_update",
      "context_surfaces_binding_delete",
      "context_surfaces_binding_preview",
      "context_surfaces_binding_recheck",
      "context_surfaces_binding_resume",
      "context_surfaces_links_list",
      "context_surfaces_link_revoke",
      "context_surfaces_link_reviews_list",
      "context_surfaces_link_review_decide",
    ]) {
      expect(names, t).toContain(t);
    }
    const bobNames = ((await mcp(`/nests/${n}/mcp`, "tools/list", {}, bob.apiKey)).result?.tools ?? []).map((t: any) => t.name);
    expect(bobNames).not.toContain("context_surfaces_binding_create");

    setConv("C-MCP", ["SA", "SB"]);
    const created = await mcp(
      `/nests/${n}/mcp`,
      "tools/call",
      { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C-MCP" } },
      alice.apiKey,
    );
    expect(created.result?.isError).toBeFalsy();
    const data = created.result.structuredContent ?? JSON.parse(created.result.content[0].text.split("\n").slice(-1)[0] || "{}");
    const bid = (await S.db.getDb().get("SELECT id FROM surface_bindings WHERE conversation_id = 'C-MCP'")) as any;
    expect(bid?.id).toBeTruthy();
    void data;
    const listed = await mcp(`/nests/${n}/mcp`, "tools/call", { name: "context_surfaces_bindings_list", arguments: {} }, alice.apiKey);
    expect(JSON.stringify(listed.result)).toContain("C-MCP");
    const refused = await mcp(
      `/nests/${n}/mcp`,
      "tools/call",
      { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C-MCP-NO" } },
      alice.apiKey,
    );
    expect(refused.result?.isError).toBe(true);
    const del = await mcp(`/nests/${n}/mcp`, "tools/call", { name: "context_surfaces_binding_delete", arguments: { binding_id: bid.id } }, alice.apiKey);
    expect(del.result?.isError).toBeFalsy();
    expect((await row(bid.id)).status).toBe("removed");
  });
});

describe("po-1431: server webhook and nest connectors vs Slack binding", () => {
  const SLACK = "https://hooks.slack.com/services/T/B/po1431";
  const HOOK = "https://example.com/hook-po1431";
  const SECRET = "Secret Plan Q3";
  const posts: Array<{ url: string; body: string }> = [];
  const sent = (url: string) => posts.filter((p) => p.url === url);

  beforeAll(() => {
    process.env.SLACK_WEBHOOK_URL = SLACK;
    process.env.NOTIFY_DEBOUNCE_MS = "50";
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok");
    });
  });
  afterAll(() => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.NOTIFY_DEBOUNCE_MS;
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    posts.length = 0;
  });

  /** A nest only Alice reads, with a webhook connector, optionally bound to a channel. */
  async function nestWithConnector(bound: boolean, conv: string) {
    const n = await newNest(alice);
    const cr = await jsonRequest(app, "POST", `/nests/${n}/connectors`, { channel: "webhook", url: HOOK, events: ["*"] }, alice.apiKey);
    expect(cr.status, JSON.stringify(cr.data)).toBeLessThan(300);
    setConv(conv, ["SA"]);
    let bindingId: string | null = null;
    if (bound) {
      const { createBindingWithListener } = await import("../src/surfaces/services/listener-service.js");
      bindingId = (await createBindingWithListener({ actorUserId: alice.userId, installId, conversationId: conv, nestId: n })).binding.id;
    }
    return { n, bindingId };
  }

  it("AC 1: with SLACK_WEBHOOK_URL set, a nest whose readers are all in the channel can bind", async () => {
    const n = await newNest(alice);
    setConv("C-1431-A", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-1431-A", nest_id: n }, alice.apiKey);
    expect(r.data.guard.capture_ok).toBe(true);
    expect(r.data.guard.detail.non_user_principals).not.toContain("connector");
  });

  it("AC 3: a bound nest's event reaches the server webhook and its connector with no title, text or subject", async () => {
    const { n } = await nestWithConnector(true, "C-1431-B");
    const { dispatchEvent } = await import("../src/notify/dispatch.js");
    await dispatchEvent({ kind: "run_failed", nestId: n, message: `Run of ${SECRET} failed`, subjectId: "nodes/secret-plan-q3", actor: alice.email });
    await vi.waitFor(() => {
      expect(sent(SLACK)).toHaveLength(1);
      expect(sent(HOOK)).toHaveLength(1);
    });
    for (const p of [...sent(SLACK), ...sent(HOOK)]) {
      expect(p.body).not.toMatch(/secret/i);
      expect(p.body).toContain("open ContextNest");
    }
    const raw = JSON.parse(sent(HOOK)[0].body);
    expect(raw.kind).toBe("run_failed");
    expect(raw.subject_id).toBeNull();
    expect(raw.actor).toBeNull();
  });

  it("AC 4: a bound nest's digest carries a count only", async () => {
    const { n } = await nestWithConnector(true, "C-1431-C");
    const { notifyNestEvent } = await import("../src/notify/notify.js");
    await notifyNestEvent(n, `Alice approved ${SECRET}`);
    await notifyNestEvent(n, `Bob requested review of ${SECRET}`);
    await vi.waitFor(() => expect(sent(SLACK)).toHaveLength(1));
    expect(sent(SLACK)[0].body).not.toMatch(/secret|alice|bob/i);
    expect(sent(SLACK)[0].body).toMatch(/2 updates/);
  });

  it("AC 5: an unbound nest's messages are unchanged", async () => {
    const { n } = await nestWithConnector(false, "C-1431-D");
    const { dispatchEvent } = await import("../src/notify/dispatch.js");
    await dispatchEvent({ kind: "run_failed", nestId: n, message: `Run of ${SECRET} failed`, subjectId: "nodes/secret-plan-q3" });
    await vi.waitFor(() => {
      expect(sent(SLACK)).toHaveLength(1);
      expect(sent(HOOK)).toHaveLength(1);
    });
    expect(sent(SLACK)[0].body).toContain(SECRET);
    expect(JSON.parse(sent(HOOK)[0].body).subject_id).toBe("nodes/secret-plan-q3");
  });

  it("AC 6: adding or removing the server webhook does not change a bound nest's readers or pause it", async () => {
    const { n, bindingId } = await nestWithConnector(true, "C-1431-E");
    const { effectiveReaders } = await import("../src/surfaces/services/readers.js");
    const b = await row(bindingId!);
    const opts = { listenerAgentNodeId: b.listener_agent_node_id, bindingId: b.id };
    const withHook = (await effectiveReaders(n, opts)).fingerprint;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      expect((await effectiveReaders(n, opts)).fingerprint).toBe(withHook);
    } finally {
      process.env.SLACK_WEBHOOK_URL = SLACK;
    }
    await S.bindings.recheckBinding(b.id);
    expect((await row(b.id)).status).toBe("active");
  });

  it("AC 7: when the bound-nest lookup fails, the event is redacted (fail closed)", async () => {
    const { n } = await nestWithConnector(false, "C-1431-F");
    const { sealedTestHooks } = await import("../src/surfaces/sealed.js");
    const { dispatchEvent } = await import("../src/notify/dispatch.js");
    sealedTestHooks.failBound = true;
    try {
      await dispatchEvent({ kind: "run_failed", nestId: n, message: `Run of ${SECRET} failed` });
      await vi.waitFor(() => expect(sent(SLACK)).toHaveLength(1));
    } finally {
      sealedTestHooks.failBound = false;
    }
    expect(sent(SLACK)[0].body).not.toMatch(/secret/i);
  });
});

describe("po-1432: the preview names who blocks a pair and who can't read the nest", () => {
  let erin: { userId: string; email: string };
  beforeAll(async () => {
    // A Community user with no Slack link and no Slack profile in the workspace.
    erin = { userId: randomUUID(), email: "erin@surf.test" };
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Erin', 'x')", [erin.userId, erin.email]);
    fake.profiles.set("SX", { ...(await import("./surfaces-fake-connector.js")).profile("SX"), display_name: "Xavier" });
  });

  async function preview(conv: string, n: string, key = alice.apiKey) {
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: conv, nest_id: n }, key);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  }

  it("AC 1-3, 5: absent readers carry a reason; channel members who can't read are listed with or without an account", async () => {
    const n = await newNest(alice);
    await share(n, bob, "read");
    const er = await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: erin.email, permission: "read" }, alice.apiKey);
    expect(er.status, JSON.stringify(er.data)).toBeLessThan(300);
    setConv("C-1432-A", ["SA", "SC", "SX"]);
    const p = await preview("C-1432-A", n);
    expect(p.would_bind).toBe(false);
    const absent = Object.fromEntries(p.people.absent_readers.map((r: any) => [r.email, r]));
    expect(absent[bob.email]).toMatchObject({ user_id: bob.userId, name: "Bob", reason: "not_in_channel" });
    expect(absent[erin.email]).toMatchObject({ user_id: erin.userId, name: "Erin", reason: "no_slack_link" });
    expect(absent[alice.email]).toBeUndefined();
    const members = Object.fromEntries(p.people.members_not_readers.map((m: any) => [m.surface_user_id, m]));
    expect(members.SC).toMatchObject({ community_user_id: carol.userId, name: "Carol", email: carol.email });
    expect(members.SX).toMatchObject({ community_user_id: null, name: "Xavier", email: null });
    expect(members.SA).toBeUndefined();
  });

  it("po-1445: an unmatched member carries the email Slack confirmed; an unconfirmed one carries none; a matched one never", async () => {
    const { profile } = await import("./surfaces-fake-connector.js");
    fake.profiles.set("SX", profile("SX", { display_name: "Xavier", email: "xavier@elsewhere.test" }));
    fake.profiles.set("SY", profile("SY", { display_name: "Yusuf", email: "yusuf@elsewhere.test", email_confirmed: false }));
    const { getDb } = S.db;
    await getDb().run("DELETE FROM surface_users_cache WHERE surface_user_id IN ('SX', 'SY')");
    const n = await newNest(alice);
    setConv("C-1445-A", ["SA", "SC", "SX", "SY"]);
    const p = await preview("C-1445-A", n);
    const members = Object.fromEntries(p.people.members_not_readers.map((m: any) => [m.surface_user_id, m]));
    expect(members.SX).toMatchObject({ community_user_id: null, slack_email: "xavier@elsewhere.test" });
    expect(members.SY).toMatchObject({ community_user_id: null, slack_email: null });
    expect(members.SC).toMatchObject({ community_user_id: carol.userId, slack_email: null });
  });

  it("QA: another app's bot that turns surface_ok off is named, so the count matches the names", async () => {
    const { profile } = await import("./surfaces-fake-connector.js");
    fake.profiles.set("SBOT", profile("SBOT", { display_name: "Zapier" }));
    const n = await newNest(alice);
    setConv("C-1432-BOT", ["SA", "SBOT"]);
    fake.conversations.get("C-1432-BOT")!.members[1].is_bot = true;
    const p = await preview("C-1432-BOT", n);
    expect(p.guard.surface_ok).toBe(false);
    expect(p.guard.detail.members_not_readers).toBe(1);
    expect(p.people.members_not_readers).toEqual([expect.objectContaining({ surface_user_id: "SBOT", name: "Zapier", community_user_id: null, is_bot: true })]);
  });

  it("a linked server admin who isn't a collaborator is named as an admin, never offered to add", async () => {
    const { loadGrantedSuperAdmins } = await import("../src/governance/access-service.js");
    const { getDb } = S.db;
    await getDb().run("INSERT INTO super_admins (email, granted_by) VALUES (?, 'test')", [carol.email.toLowerCase()]);
    await loadGrantedSuperAdmins();
    try {
      const n = await newNest(alice);
      setConv("C-ADMIN-A", ["SA", "SC"]);
      const p = await preview("C-ADMIN-A", n);
      expect(p.people.members_not_readers.map((m: any) => m.surface_user_id)).not.toContain("SC");
      expect(p.people.server_admins).toEqual([{ user_id: carol.userId, name: "Carol", email: carol.email }]);
    } finally {
      await getDb().run("DELETE FROM super_admins WHERE email = ?", [carol.email.toLowerCase()]);
      await loadGrantedSuperAdmins();
    }
  });

  it("po-1467: a reader whose email a channel member has, but whose link is refused, is not_linked with the reason; never not_in_channel", async () => {
    const { profile } = await import("./surfaces-fake-connector.js");
    // Same email in Community and Slack, but the Community email is not verified.
    const hank = { userId: randomUUID(), email: "hank@surf.test" };
    await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, 'Hank', 'x')", [hank.userId, hank.email]);
    fake.profiles.set("SH", profile("SH", { display_name: "Hank F", email: "Hank@surf.test" }));
    await S.db.getDb().run("DELETE FROM surface_users_cache WHERE surface_user_id = 'SH'");
    const n = await newNest(alice);
    const r = await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: hank.email, permission: "read" }, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    setConv("C-1467-A", ["SA", "SH"]);
    const p = await preview("C-1467-A", n);
    const absent = Object.fromEntries(p.people.absent_readers.map((a: any) => [a.email, a]));
    expect(absent[hank.email]).toMatchObject({ user_id: hank.userId, reason: "not_linked", match_reason: "unverified" });
  });

  it("shared server: a same-email reader is refused as org_domain until the connection's home nest lists the domain", async () => {
    const { profile } = await import("./surfaces-fake-connector.js");
    const ivy = { userId: randomUUID(), email: "ivy@surf.test" };
    await S.db
      .getDb()
      .run("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, 'Ivy', 'x', ?)", [ivy.userId, ivy.email, new Date().toISOString()]);
    fake.profiles.set("SIVY", profile("SIVY", { display_name: "Ivy", email: ivy.email }));
    const n = await newNest(alice);
    expect((await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: ivy.email, permission: "read" }, alice.apiKey)).status).toBeLessThan(300);
    setConv("C-SHARED", ["SA", "SIVY"]);
    const home = (await S.db.getDb().get("SELECT home_nest_id FROM surface_installs WHERE id = ?", [installId])) as { home_nest_id: string | null };
    const before = process.env.SHARED_DEPLOYMENT;
    process.env.SHARED_DEPLOYMENT = "true";
    await S.db.getDb().run("UPDATE surface_installs SET home_nest_id = ? WHERE id = ?", [n, installId]);
    try {
      const find = async () => (await preview("C-SHARED", n)).people.absent_readers.find((a: any) => a.email === ivy.email);
      expect(await find()).toMatchObject({ reason: "not_linked", match_reason: "org_domain" });
      // The setting an admin saves in Setup; the nest stays private.
      const saved = await jsonRequest(app, "PATCH", `/nests/${n}/settings`, { org_domains: ["surf.test"] }, alice.apiKey);
      expect(saved.status, JSON.stringify(saved.data)).toBe(200);
      expect(await find()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.SHARED_DEPLOYMENT;
      else process.env.SHARED_DEPLOYMENT = before;
      await S.db.getDb().run("UPDATE surface_installs SET home_nest_id = ? WHERE id = ?", [home.home_nest_id, installId]);
    }
  });

  it("AC 6: a world-readable nest names its cause", async () => {
    const pub = await newNest(alice);
    await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, alice.apiKey);
    const linked = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO publish (id, nest_id, node_id, slug, access_mode, created_by, created_at) VALUES (?, ?, 'nodes/x', ?, 'public', ?, '2026-10-30T00:00:00.000Z')",
      [randomUUID(), linked, `s-${randomUUID()}`, alice.userId],
    );
    setConv("C-1432-B", ["SA"]);
    expect((await preview("C-1432-B", pub)).people.universe_cause).toBe("public");
    expect((await preview("C-1432-B", linked)).people.universe_cause).toBe("link");
    expect((await preview("C-1432-B", await newNest(alice))).people.universe_cause).toBeNull();
  });

  it("AC 7: the MCP preview returns the same people block", async () => {
    const n = await newNest(alice);
    await share(n, bob, "read");
    setConv("C-1432-C", ["SA", "SC"]);
    const rest = await preview("C-1432-C", n);
    const out = await mcp(
      `/nests/${n}/mcp`,
      "tools/call",
      { name: "context_surfaces_binding_preview", arguments: { install_id: installId, conversation_id: "C-1432-C" } },
      alice.apiKey,
    );
    expect(out.result?.isError).toBeFalsy();
    expect(rest.people.absent_readers.map((r: any) => r.email)).toEqual([bob.email]);
    expect(out.result.structuredContent.people).toEqual(rest.people);
  });

  it("AC 8: a stored binding and its guard detail carry no names", async () => {
    const n = await newNest(alice);
    setConv("C-1432-D", ["SA", "SC"]);
    const r = await bind({ conversation_id: "C-1432-D", nest_id: n });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const stored = JSON.stringify(await row(r.data.binding.id)) + JSON.stringify(r.data.binding);
    expect(stored).not.toMatch(/carol|Carol|people/);
  });
});

describe("po-1432 review: the people lists are capped", () => {
  it("names at most 20 absent readers while guard.detail keeps the full count", async () => {
    const n = await newNest(alice);
    for (let i = 0; i < 22; i++) {
      const id = randomUUID();
      const email = `cap-${i}-${id.slice(0, 6)}@surf.test`;
      await S.db.getDb().run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')", [id, email, `Cap ${i}`]);
      const r = await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email, permission: "read" }, alice.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    }
    setConv("C-1432-CAP", ["SA"]);
    const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-1432-CAP", nest_id: n }, alice.apiKey);
    expect(r.data.guard.detail.readers_absent).toBe(22);
    expect(r.data.people.absent_readers).toHaveLength(20);
  });
});
