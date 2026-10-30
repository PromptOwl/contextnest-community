/**
 * Surfaces S1 — bindings and the two-flag guard against the real permission
 * model (§4.10, §4.17, §12 R1, binding state machine §12 R3), over REST, MCP
 * and the services. The connector is the in-memory fake; no network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

  it("AC-GRD-05: another agent reading N blocks capture; this binding's own listener does not", async () => {
    const n = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, created_by) VALUES (?, 'nodes/listener', ?, ?)",
      [n, randomUUID(), alice.email],
    );
    setConv("C-05", ["SA"]);
    const other = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-05", nest_id: n }, alice.apiKey);
    expect(other.data.guard.capture_ok).toBe(false);
    expect(other.data.guard.detail.non_user_principals).toContain("agent");
    // The listener is recorded server-side when Surfaces creates the binding
    // (round-2 M3: never client-supplied), so this goes through the service.
    const own = await S.bindings.createBinding({
      actorUserId: alice.userId,
      installId,
      conversationId: "C-05",
      nestId: n,
      listenerAgentNodeId: "nodes/listener",
    });
    expect(own.binding.capture_ok).toBe(true);
    expect(own.binding.listener_agent_node_id).toBe("nodes/listener");
  });

  it("AC-GRD-06: an enabled outbound connector on N → capture_ok false with connector", async () => {
    for (const channel of ["slack", "teams", "webhook"]) {
      const n = await newNest(alice);
      const url = channel === "slack" ? "https://hooks.slack.com/services/T/B/X" : "https://example.com/hook";
      const cr = await jsonRequest(app, "POST", `/nests/${n}/connectors`, { channel, url, events: ["*"] }, alice.apiKey);
      expect(cr.status, JSON.stringify(cr.data)).toBeLessThan(300);
      setConv("C-06", ["SA"]);
      const r = await jsonRequest(app, "POST", "/surfaces/bindings/preview", { install_id: installId, conversation_id: "C-06", nest_id: n }, alice.apiKey);
      expect(r.data.guard.capture_ok, channel).toBe(false);
      expect(r.data.guard.detail.non_user_principals).toContain("connector");
    }
  });

  it("AC-GRD-07: link-shared or public N → capture_ok false for a non-public conversation", async () => {
    const pub = await newNest(alice);
    const v = await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, alice.apiKey);
    expect(v.status).toBeLessThan(300);
    const linked = await newNest(alice);
    await S.db.getDb().run(
      "INSERT INTO publish (id, nest_id, node_id, slug, access_mode, created_by) VALUES (?, ?, 'nodes/x', ?, 'public', ?)",
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
    const nonAdmin = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, dave.apiKey);
    expect(nonAdmin.status).toBe(403);
    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.binding.status).toBe("active");
  });

  it("resume refuses while the guard still fails", async () => {
    const n = await newNest(alice);
    await share(n, dave);
    setConv("C-16b", ["SA", "SD"]);
    const b = await bind({ conversation_id: "C-16b", nest_id: n });
    setConv("C-16b", ["SA"]);
    await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/recheck`, {}, alice.apiKey);
    const res = await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/resume`, {}, alice.apiKey);
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

    it("AC-GRD-17: outbound connector created / disabled / deleted", async () => {
      await freshBinding();
      const cr = await jsonRequest(app, "POST", `/nests/${n}/connectors`, { channel: "webhook", url: "https://example.com/h", events: ["*"] }, alice.apiKey);
      await expectRecomputed("connector created");
      const cid = cr.data.connector?.id ?? ((await S.db.getDb().get("SELECT id FROM connectors WHERE nest_id = ?", [n])) as any).id;
      await jsonRequest(app, "PATCH", `/nests/${n}/connectors/${cid}`, { enabled: false }, alice.apiKey);
      await expectRecomputed("connector disabled");
      await jsonRequest(app, "PATCH", `/nests/${n}/connectors/${cid}`, { enabled: true }, alice.apiKey);
      await expectRecomputed("connector enabled");
      await jsonRequest(app, "DELETE", `/nests/${n}/connectors/${cid}`, undefined, alice.apiKey);
      await expectRecomputed("connector deleted");
    });

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
    const resume = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, alice.apiKey);
    expect(resume.status).toBe(409);
    await S.bindings.consentToReturn({ bindingId: id, surfaceUserId: "SC" });
    const ok = await jsonRequest(app, "POST", `/surfaces/bindings/${id}/resume`, {}, alice.apiKey);
    expect(ok.status).toBe(200);
    expect(ok.data.binding.status).toBe("active");
  });

  it("re-bind after a boot is allowed once the booting member has left", async () => {
    const n = await newNest(alice);
    setConv("C-BOOT2", ["SA", "SC"]);
    const b = await bind({ conversation_id: "C-BOOT2", nest_id: n });
    await S.bindings.bootBinding({ bindingId: b.data.binding.id, surfaceUserId: "SC" });
    setConv("C-BOOT2", ["SA"]);
    const ok = await jsonRequest(app, "POST", `/surfaces/bindings/${b.data.binding.id}/resume`, {}, alice.apiKey);
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
    const del = await jsonRequest(app, "DELETE", `/surfaces/bindings/${b.data.binding.id}`, undefined, alice.apiKey);
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
