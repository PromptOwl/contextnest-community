/**
 * Surfaces S1 — identity linking (§4.11, M6, HR3): AC-IDN-01..16.
 *
 * The Slack OAuth callback and the Approve button itself land in S2a/S2b;
 * here the identity service entry points they will call are exercised
 * directly, plus the one-time link page and the REST/MCP admin surface.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { createFakeConnector, profile, type FakeConnector } from "./surfaces-fake-connector.js";
import { autoMatchVerdict, checkInteraction } from "../src/surfaces/core/identity-rules.js";

type User = { apiKey: string; userId: string; email: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: User; // nest owner + installer
let root: User; // server admin
let marcus: User;
let alice: User;
let bob: User;
let fake: FakeConnector;
let installId: string;
let homeNest: string;
let I: typeof import("../src/surfaces/services/identity-service.js");
let DB: typeof import("../src/db/client.js");

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
async function verify(user: User) {
  await DB.getDb().run("UPDATE users SET email_verified_at = ? WHERE id = ?", [new Date().toISOString(), user.userId]);
}
async function activeLink(surfaceUserId: string) {
  return (await DB.getDb().get("SELECT * FROM surface_identity_links WHERE install_id = ? AND surface_user_id = ? AND status = 'active'", [
    installId,
    surfaceUserId,
  ])) as any;
}
/** A verified Community person with a unique email (one link per person per install). */
async function person(name: string): Promise<{ userId: string; email: string; name: string }> {
  const userId = randomUUID();
  const email = `${name.toLowerCase().replace(/[^a-z]/g, "")}-${userId.slice(0, 8)}@idn.test`;
  await DB.getDb().run("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, ?, 'x', ?)", [
    userId, email, name, new Date().toISOString(),
  ]);
  return { userId, email, name };
}
const INSTALL = { surface: "slack" as const, home_team_id: "T1", enterprise_id: null };

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@idn.test"] });
  admin = await registerUser(app, "admin@idn.test", "Admin");
  root = await registerUser(app, "root@idn.test", "Root");
  marcus = await registerUser(app, "marcus@idn.test", "Marcus Lee");
  await resetAuthRateLimit();
  alice = await registerUser(app, "alice@idn.test", "Alice");
  bob = await registerUser(app, "bob@idn.test", "Bob");
  await resetAuthRateLimit();
  I = await import("../src/surfaces/services/identity-service.js");
  DB = await import("../src/db/client.js");
  const registry = await import("../src/surfaces/registry.js");
  const installs = await import("../src/surfaces/services/install-store.js");
  fake = createFakeConnector("slack");
  registry.registerConnector(fake);
  homeNest = (await jsonRequest(app, "POST", "/nests", { name: "Home" }, admin.apiKey)).data.nest.id;
  installId = (
    await installs.createInstall({
      surface: "slack",
      mode: "manifest",
      tenantKey: "T1",
      teamId: "T1",
      botUserId: "B_OURS",
      homeNestId: homeNest,
      installedByUserId: admin.userId,
      status: "active",
    })
  ).id;
  await verify(marcus);
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.FEATURE_SURFACES;
  delete process.env.OIDC_ALLOWED_DOMAINS;
  delete process.env.SHARED_DEPLOYMENT;
  await env.cleanup();
});

afterEach(() => {
  delete process.env.OIDC_ALLOWED_DOMAINS;
  delete process.env.SHARED_DEPLOYMENT;
});

describe("explicit link", () => {
  it("AC-IDN-01: the installer's authed_user.id is linked to the signed-in admin, method explicit, no first-use confirm", async () => {
    const l = await I.completeInstallerLink({ installId, authedUserId: "U_ADMIN", communityUserId: admin.userId });
    expect(l.method).toBe("explicit");
    const r = await I.resolveActor({ installId, surfaceUserId: "U_ADMIN", action: "approve" });
    expect(r).toMatchObject({ status: "ok", userId: admin.userId });
  });
});

describe("auto-match (all six conditions)", () => {
  const candidate = (over: Partial<{ id: string; email: string; email_verified: boolean }> = {}) => ({
    id: "u-marcus",
    email: "marcus@idn.test",
    email_verified: true,
    ...over,
  });
  const good = profile("U_M", { email: "Marcus@idn.test", email_confirmed: true });

  it("AC-IDN-02: a user meeting every condition → auto_email link on first click, first-use confirm, out-of-band email", async () => {
    fake.profiles.set("U_MARCUS", profile("U_MARCUS", { email: "marcus@idn.test" }));
    const r = await I.resolveActor({ installId, surfaceUserId: "U_MARCUS", action: "approve" });
    expect(r.status).toBe("confirm");
    if (r.status === "confirm") {
      expect(r.verb).toBe("approve");
      expect(r.prompt).toContain("Marcus Lee");
      expect(r.prompt).toContain("marcus@idn.test");
    }
    const link = await activeLink("U_MARCUS");
    expect(link.method).toBe("auto_email");
    expect(link.community_user_id).toBe(marcus.userId);
    expect(link.first_use_confirmed_at).toBeNull();
    const notice = (await DB.getDb().get(
      "SELECT * FROM surface_notices WHERE kind = 'link_created' AND recipient_user_id = ? AND audience = 'user'",
      [marcus.userId],
    )) as any;
    expect(notice).toBeTruthy();
    expect(JSON.parse(notice.detail).channel).toBe("email");
  });

  it("AC-IDN-03: home team ≠ install (Slack Connect) → fails even with a matching verified email", () => {
    const v = autoMatchVerdict({ profile: { ...good, home_team_id: "T_OTHER" }, install: INSTALL, candidates: [candidate()], verifiedDomains: [], blocked: false });
    expect(v).toEqual({ ok: false, reason: "home_team" });
    const ent = autoMatchVerdict({
      profile: { ...good, enterprise_id: "E2" },
      install: { ...INSTALL, enterprise_id: "E1" },
      candidates: [candidate()],
      verifiedDomains: [],
      blocked: false,
    });
    expect(ent.ok).toBe(false);
  });

  it("AC-IDN-04: is_restricted or is_ultra_restricted → fails", () => {
    for (const flag of ["is_restricted", "is_ultra_restricted", "is_stranger", "is_bot", "deleted"] as const) {
      const v = autoMatchVerdict({ profile: { ...good, [flag]: true }, install: INSTALL, candidates: [candidate()], verifiedDomains: [], blocked: false });
      expect(v.ok, flag).toBe(false);
    }
    const guest = autoMatchVerdict({ profile: { ...good, user_role: "guest" }, install: { ...INSTALL, surface: "teams" }, candidates: [candidate()], verifiedDomains: [], blocked: false });
    expect(guest.ok).toBe(false);
  });

  it("AC-IDN-05: is_email_confirmed false or absent → fails, and the user is offered the one-time link", async () => {
    for (const email_confirmed of [false, null]) {
      const v = autoMatchVerdict({ profile: { ...good, email_confirmed }, install: INSTALL, candidates: [candidate()], verifiedDomains: [], blocked: false });
      expect(v).toEqual({ ok: false, reason: "email_unconfirmed" });
    }
    fake.profiles.set("U_UNCONF", profile("U_UNCONF", { email: "marcus@idn.test", email_confirmed: null }));
    const r = await I.resolveActor({ installId, surfaceUserId: "U_UNCONF", action: "approve" });
    expect(r.status).toBe("needs_link");
    if (r.status === "needs_link") expect(r.url).toMatch(/\/link\/[A-Za-z0-9_-]{20,}$/);
    expect(await activeLink("U_UNCONF")).toBeUndefined();
  });

  it("AC-IDN-06: two users share the email, the only match is outside the org, or the email is unverified → fails", async () => {
    expect(
      autoMatchVerdict({ profile: good, install: INSTALL, candidates: [candidate(), candidate({ id: "u2", email: "MARCUS@idn.test" })], verifiedDomains: [], blocked: false }),
    ).toEqual({ ok: false, reason: "ambiguous" });
    expect(autoMatchVerdict({ profile: good, install: INSTALL, candidates: [], verifiedDomains: [], blocked: false })).toEqual({ ok: false, reason: "no_match" });
    expect(
      autoMatchVerdict({ profile: good, install: INSTALL, candidates: [candidate({ email_verified: false })], verifiedDomains: [], blocked: false }),
    ).toEqual({ ok: false, reason: "unverified" });

    // service level: an unverified Community account never auto-matches
    // (users.email is unique case-insensitively, so "two users share it" can
    // only arise in the pure rule above)
    fake.profiles.set("U_ALICE", profile("U_ALICE", { email: "ALICE@idn.test" }));
    expect(await I.evaluateAutoMatch(installId, "U_ALICE")).toEqual({ ok: false, reason: "unverified" });

    // shared deployment: the owning org is the home nest's domains; none → nobody is in the org
    const p6 = await person("Org Six");
    process.env.SHARED_DEPLOYMENT = "true";
    fake.profiles.set("U_MARCUS2", profile("U_MARCUS2", { email: p6.email }));
    expect(await I.evaluateAutoMatch(installId, "U_MARCUS2")).toEqual({ ok: false, reason: "no_match" });
    await DB.getDb().run("UPDATE nests SET org_domains = ? WHERE id = ?", [JSON.stringify(["idn.test"]), homeNest]);
    expect(await I.evaluateAutoMatch(installId, "U_MARCUS2")).toEqual({ ok: true, userId: p6.userId });
    await DB.getDb().run("UPDATE nests SET org_domains = NULL WHERE id = ?", [homeNest]);
  });

  it("AC-IDN-07: verified domains configured and the email's domain isn't one → fails", async () => {
    expect(autoMatchVerdict({ profile: good, install: INSTALL, candidates: [candidate()], verifiedDomains: ["acme.com"], blocked: false })).toEqual({
      ok: false,
      reason: "domain",
    });
    const p7 = await person("Dom Seven");
    process.env.OIDC_ALLOWED_DOMAINS = "acme.com";
    fake.profiles.set("U_MARCUS3", profile("U_MARCUS3", { email: p7.email }));
    expect((await I.evaluateAutoMatch(installId, "U_MARCUS3")).ok).toBe(false);
    process.env.OIDC_ALLOWED_DOMAINS = "idn.test";
    expect((await I.evaluateAutoMatch(installId, "U_MARCUS3")).ok).toBe(true);
  });

  it("AC-IDN-08: a changed Slack email (user_change) never re-points or revokes a link", async () => {
    const p8 = await person("Chang Eight");
    await I.linkExplicit({ installId, surfaceUserId: "U_CHG", communityUserId: p8.userId });
    await I.recordUserChange(installId, profile("U_CHG", { email: "marcus@idn.test" }));
    const l = await activeLink("U_CHG");
    expect(l.community_user_id).toBe(p8.userId);
    expect(l.status).toBe("active");
    const cached = (await DB.getDb().get("SELECT email FROM surface_users_cache WHERE install_id = ? AND surface_user_id = 'U_CHG'", [installId])) as any;
    expect(cached.email).toBe("marcus@idn.test");
  });
});

describe("one-time link", () => {
  it("AC-IDN-09: used after 15 min or a second time → refused, no link", async () => {
    fake.profiles.set("U_BOB", profile("U_BOB", { email: "bob@idn.test", email_confirmed: true }));
    await verify(bob);
    const t0 = Date.now();
    const old = await I.issueLinkToken({ installId, surfaceUserId: "U_BOB", now: t0 });
    const late = await I.redeemLinkToken({ token: old, userId: bob.userId, now: t0 + 16 * 60_000 });
    expect(late).toMatchObject({ ok: false, reason: "expired" });
    expect(await activeLink("U_BOB")).toBeUndefined();

    const tok = await I.issueLinkToken({ installId, surfaceUserId: "U_BOB" });
    const first = await I.redeemLinkToken({ token: tok, userId: bob.userId });
    expect(first.ok).toBe(true);
    await I.revokeLink({ linkId: (await activeLink("U_BOB")).id, byUserId: root.userId, reason: "reset" });
    const second = await I.redeemLinkToken({ token: tok, userId: bob.userId });
    expect(second).toMatchObject({ ok: false, reason: "used" });
    expect(await activeLink("U_BOB")).toBeUndefined();
  });

  it("AC-IDN-10: a token for @bob submitted by Alice → refused, review row, Bob stays unlinked (via the link page)", async () => {
    fake.profiles.set("U_BOB2", profile("U_BOB2", { email: "bob@idn.test", email_confirmed: false }));
    const tok = await I.issueLinkToken({ installId, surfaceUserId: "U_BOB2" });
    const page = await jsonRequest(app, "GET", `/link/${tok}`, undefined, alice.apiKey);
    expect(page.status).toBe(200);
    expect(page.data.surface_identity).toContain("bob@idn.test");
    expect(page.data.community_identity).toContain("alice@idn.test");
    const post = await jsonRequest(app, "POST", `/link/${tok}`, { csrf: page.data.csrf }, alice.apiKey);
    expect(post.status).toBe(409);
    expect(post.data.linked).toBe(false);
    const review = (await DB.getDb().get("SELECT * FROM surface_link_reviews WHERE surface_user_id = 'U_BOB2'")) as any;
    expect(review.status).toBe("pending");
    expect(review.community_user_id).toBe(alice.userId);
    expect(await activeLink("U_BOB2")).toBeUndefined();
  });

  it("AC-IDN-11: a successful link never executes the clicked action; the user is told to click again", async () => {
    fake.profiles.set("U_BOB3", profile("U_BOB3", { email: "bob@idn.test", email_confirmed: true }));
    const tok = await I.issueLinkToken({ installId, surfaceUserId: "U_BOB3" });
    const page = await jsonRequest(app, "GET", `/link/${tok}`, undefined, bob.apiKey);
    const post = await jsonRequest(app, "POST", `/link/${tok}`, { csrf: page.data.csrf }, bob.apiKey);
    expect(post.status).toBe(200);
    expect(post.data.linked).toBe(true);
    expect(post.data.executed).toBe(false);
    expect(post.data.message).toMatch(/click .*again/i);
    // the next click still asks the first-use confirm — nothing ran
    const r = await I.resolveActor({ installId, surfaceUserId: "U_BOB3", action: "approve" });
    expect(r.status).toBe("confirm");
  });

  it("the link page refuses a POST without the CSRF token", async () => {
    fake.profiles.set("U_BOB4", profile("U_BOB4", { email: "bob@idn.test", email_confirmed: false }));
    const tok = await I.issueLinkToken({ installId, surfaceUserId: "U_BOB4" });
    const post = await jsonRequest(app, "POST", `/link/${tok}`, { csrf: "nope" }, bob.apiKey);
    expect(post.status).toBe(403);
    expect(await activeLink("U_BOB4")).toBeUndefined();
  });
});

describe("first-use confirm (N3)", () => {
  for (const verb of ["reject", "edit", "approve"] as const) {
    it(`AC-IDN-12: first ${verb} names the verb, and Yes continues to ${verb} — never another action`, async () => {
      const sid = `U_M_${verb}`;
      const who = await person(`Verb ${verb}`);
      fake.profiles.set(sid, profile(sid, { email: who.email }));
      const r = await I.resolveActor({ installId, surfaceUserId: sid, action: verb });
      expect(r.status).toBe("confirm");
      if (r.status !== "confirm") return;
      expect(r.verb).toBe(verb);
      expect(r.prompt).toContain(`**${verb}**`);
      const yes = await I.confirmFirstUse({ linkId: r.linkId, action: verb, answer: "yes" });
      expect(yes).toEqual({ status: "continue", action: verb, userId: who.userId });
      const next = await I.resolveActor({ installId, surfaceUserId: sid, action: "approve" });
      expect(next).toMatchObject({ status: "ok", userId: who.userId });
    });
  }

  it("AC-IDN-13: 'That's not me' → nothing executes, link revoked, auto_match_blocked, org admins notified", async () => {
    const imp = await person("Imp Thirteen");
    fake.profiles.set("U_IMP", profile("U_IMP", { email: imp.email }));
    const r = await I.resolveActor({ installId, surfaceUserId: "U_IMP", action: "approve" });
    if (r.status !== "confirm") throw new Error("expected confirm");
    const out = await I.confirmFirstUse({ linkId: r.linkId, action: "approve", answer: "not_me" });
    expect(out).toEqual({ status: "revoked", executed: false });
    const l = (await DB.getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [r.linkId])) as any;
    expect(l.status).toBe("revoked");
    expect(l.auto_match_blocked).toBe(1);
    const n = (await DB.getDb().get("SELECT * FROM surface_notices WHERE kind = 'link_disowned' AND audience = 'admins'")) as any;
    expect(n).toBeTruthy();
  });

  it("AC-IDN-14: a revoked pair does not auto-match again until an admin clears auto_match_blocked", async () => {
    // U_IMP was revoked above
    const again = await I.resolveActor({ installId, surfaceUserId: "U_IMP", action: "approve" });
    expect(again.status).toBe("needs_link");
    expect(await activeLink("U_IMP")).toBeUndefined();
    const cleared = await jsonRequest(app, "POST", "/surfaces/links/unblock", { install_id: installId, surface_user_id: "U_IMP" }, root.apiKey);
    expect(cleared.status).toBe(200);
    const now = await I.resolveActor({ installId, surfaceUserId: "U_IMP", action: "approve" });
    expect(now.status).toBe("confirm");
  });
});

describe("interaction checks", () => {
  const expected = { team_id: "T1", enterprise_id: null, channel_id: "C1", install_home_team: "T1" };
  it("AC-IDN-15: team / enterprise / channel / clicker home mismatch → rejected", () => {
    expect(checkInteraction({ team_id: "T1", enterprise_id: null, channel_id: "C1", clicker_home_team: "T1" }, expected)).toEqual({ ok: true });
    for (const bad of [
      { team_id: "T2", enterprise_id: null, channel_id: "C1", clicker_home_team: "T1" },
      { team_id: "T1", enterprise_id: "E9", channel_id: "C1", clicker_home_team: "T1" },
      { team_id: "T1", enterprise_id: null, channel_id: "C2", clicker_home_team: "T1" },
      { team_id: "T1", enterprise_id: null, channel_id: "C1", clicker_home_team: "T_EXT" },
    ]) {
      const v = checkInteraction(bad, expected);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toMatch(/Only .* members can act on this/);
    }
  });
});

describe("admin revoke over REST and MCP", () => {
  it("AC-IDN-16: an admin revokes via REST → the next click routes to the one-time link flow", async () => {
    const r1 = await person("Rev One");
    fake.profiles.set("U_R1", profile("U_R1", { email: r1.email }));
    await I.linkExplicit({ installId, surfaceUserId: "U_R1", communityUserId: r1.userId });
    const list = await jsonRequest(app, "GET", "/surfaces/links", undefined, root.apiKey);
    const l = list.data.links.find((x: any) => x.surface_user_id === "U_R1");
    expect(l).toBeTruthy();
    const nonAdmin = await jsonRequest(app, "DELETE", `/surfaces/links/${l.id}`, undefined, alice.apiKey);
    expect(nonAdmin.status).toBe(403);
    const del = await jsonRequest(app, "DELETE", `/surfaces/links/${l.id}`, undefined, root.apiKey);
    expect(del.status).toBe(200);
    const r = await I.resolveActor({ installId, surfaceUserId: "U_R1", action: "approve" });
    expect(r.status).toBe("needs_link");
  });

  it("AC-IDN-16: an admin revokes via MCP → the next click routes to the one-time link flow", async () => {
    const r2 = await person("Rev Two");
    fake.profiles.set("U_R2", profile("U_R2", { email: r2.email }));
    await I.linkExplicit({ installId, surfaceUserId: "U_R2", communityUserId: r2.userId });
    const l = await activeLink("U_R2");
    const out = await mcp(`/nests/${homeNest}/mcp`, "tools/call", { name: "context_surfaces_link_revoke", arguments: { link_id: l.id } }, root.apiKey);
    expect(out.result?.isError).toBeFalsy();
    const r = await I.resolveActor({ installId, surfaceUserId: "U_R2", action: "approve" });
    expect(r.status).toBe("needs_link");
  });

  it("link reviews: an admin decides a mismatched link (deny leaves it unlinked)", async () => {
    const reviews = await jsonRequest(app, "GET", "/surfaces/link-reviews", undefined, root.apiKey);
    const rv = reviews.data.reviews.find((x: any) => x.surface_user_id === "U_BOB2");
    expect(rv).toBeTruthy();
    const dec = await jsonRequest(app, "POST", `/surfaces/link-reviews/${rv.id}`, { decision: "deny" }, root.apiKey);
    expect(dec.status).toBe(200);
    expect(await activeLink("U_BOB2")).toBeUndefined();
  });

  it("the /link page is no-store and no-referrer (the token is in the URL)", async () => {
    const res = await app.request("/link/garbage", { headers: { Authorization: `Bearer ${alice.apiKey}` } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("link reviews: approving onto an already-linked account is a 409 that leaves the review pending", async () => {
    const r3 = await person("Rev Three");
    fake.profiles.set("U_R3", profile("U_R3", { email: r3.email }));
    await I.linkExplicit({ installId, surfaceUserId: "U_R3", communityUserId: r3.userId });
    const id = randomUUID();
    await DB.getDb().run(
      "INSERT INTO surface_link_reviews (id, install_id, surface_user_id, community_user_id, status) VALUES (?, ?, 'U_R3', ?, 'pending')",
      [id, installId, r3.userId],
    );
    const dec = await jsonRequest(app, "POST", `/surfaces/link-reviews/${id}`, { decision: "approve" }, root.apiKey);
    expect(dec.status).toBe(409);
    const row = (await DB.getDb().get("SELECT status FROM surface_link_reviews WHERE id = ?", [id])) as any;
    expect(row.status).toBe("pending");
  });
});
