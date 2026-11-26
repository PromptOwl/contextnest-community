/**
 * Version history must not leak drafts or people to callers who only see
 * approved content.
 *
 * The rule: a public reader, and any non-member, sees only versions up to the
 * approved version, plus their own draft if they authored one (an org
 * contributor's proposal). Members follow the existing stewardship rules. A
 * read-only key reads as its owner but never carries editor / reviewer
 * identity or caller attribution.
 *
 * Shared setup per nest: owner `owner@`, write collaborator `ed@`, the owner
 * as the sole reviewer. "Pricing": v1 by `ed@` ("APPROVED-V1"), submitted and
 * approved by `owner@`; then `ed@` saves v2 ("DRAFT-V2") and does not submit.
 *
 * One `it` per example row (EX-1..EX-16; EX-14 lives in
 * test/version-read-access.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers";

type User = { apiKey: string; userId: string; email: string };

const OWNER = "owner@pricing.test";
const ED = "ed@pricing.test";
const READER = "reader@pricing.test";
const PAT = "pat@pricing.test";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean; data?: any; raw: any }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(payload.error).toBeUndefined();
  return {
    text: (payload.result.content ?? []).map((c: any) => c.text ?? "").join("\n"),
    isError: payload.result.isError,
    data: payload.result.structuredContent,
    raw: payload.result,
  };
}

/** GET as an anonymous caller (no credentials). */
async function anon(app: any, path: string) {
  const res = await app.request(path);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

/** GET with a bearer key. */
async function getAs(app: any, path: string, apiKey: string) {
  const res = await app.request(path, { headers: authed(apiKey) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

const versionNumbers = (list: any): number[] =>
  (list?.versions ?? []).map((v: any) => Number(v.version)).sort((a: number, b: number) => a - b);

describe("version history: drafts and identities stay with members", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let ed: User;
  let reader: User;
  let pat: User;
  let ownerReadKey: string;

  let pubNest: string; // "Pricing Nest" — public, reader mode on
  let orgNest: string; // "Pricing Org" — org-visible, org contributions on

  const PRICING = "nodes/pricing";
  const REVISIONS = "nodes/pricing-revisions";
  const DECK = "nodes/pricing-deck";
  const PROPOSALS = "nodes/pricing-proposals";

  const req = (method: string, nest: string, path: string, body: any, key: string) =>
    jsonRequest(app, method, `/nests/${nest}${path}`, body, key);

  /** v1 by ed (submitted, approved by owner). Returns the approved version. */
  async function approvedV1(
    nest: string,
    title: string,
    content: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await req("POST", nest, "/nodes", { title, content, ...extra }, ed.apiKey);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const id = created.data.node.id as string;
    const submit = await req("POST", nest, `/nodes/${id}/submit-review`, {}, ed.apiKey);
    expect(submit.status, JSON.stringify(submit.data)).toBe(201);
    const approve = await req("POST", nest, `/nodes/${id}/approve`, {}, owner.apiKey);
    expect(approve.status, JSON.stringify(approve.data)).toBe(200);
    return id;
  }

  /** Owner's (member) view of the version list — used to prove the Given. */
  async function memberList(nest: string, id: string) {
    const r = await req("GET", nest, `/nodes/${id}/versions`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    return r.data;
  }

  async function governedNest(name: string): Promise<string> {
    const nest = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
    expect(nest.status, JSON.stringify(nest.data)).toBe(201);
    const id = nest.data.nest.id as string;
    const added = await req("POST", id, "/collaborators", { email: ED, permission: "write" }, owner.apiKey);
    expect(added.status).toBeLessThan(300);
    // The owner is the sole reviewer: ed's edits land as drafts and need the
    // owner's approval (separation of duties: approver ≠ submitter).
    const nestPath = join(env.dataDir, "nests", id);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:\n  - email: ${OWNER}, role: reviewer, can_approve: true\n`,
    );
    const sync = await req("POST", id, "/stewards/sync", {}, owner.apiKey);
    expect(sync.status).toBeLessThan(300);
    const s = await req("PATCH", id, "/settings", { stewardship_enabled: true }, owner.apiKey);
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    return id;
  }

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: [OWNER] });
    const reg = async (email: string) => {
      resetAuthRateLimit();
      return registerUser(app, email) as Promise<User>;
    };
    owner = await reg(OWNER);
    ed = await reg(ED);
    reader = await reg(READER);
    pat = await reg(PAT);

    // ── Public nest ──────────────────────────────────────────────────────
    pubNest = await governedNest("Pricing Nest");

    // "Pricing": v1 approved, v2 draft (not submitted). v2 carries caller
    // attribution so "no client block" has something to hide.
    expect(await approvedV1(pubNest, "Pricing", "# Pricing\n\nAPPROVED-V1")).toBe(PRICING);
    const v2 = await req(
      "PATCH",
      pubNest,
      `/nodes/${PRICING}`,
      { content: "# Pricing\n\nDRAFT-V2", client: { agent: "ed-agent", session_id: "ed-session" } },
      ed.apiKey,
    );
    expect(v2.status, JSON.stringify(v2.data)).toBe(200);

    // "Pricing Revisions": v1 approved, v2 sent back for changes, v3 approved.
    expect(await approvedV1(pubNest, "Pricing Revisions", "# Revisions\n\nAPPROVED-V1")).toBe(REVISIONS);
    const rv2 = await req("PATCH", pubNest, `/nodes/${REVISIONS}`, { content: "# Revisions\n\nREJECTED-V2" }, ed.apiKey);
    expect(rv2.status, JSON.stringify(rv2.data)).toBe(200);
    expect((await req("POST", pubNest, `/nodes/${REVISIONS}/submit-review`, {}, ed.apiKey)).status).toBe(201);
    const reject = await req(
      "POST",
      pubNest,
      `/nodes/${REVISIONS}/reject`,
      { note: "needs changes", kind: "changes" },
      owner.apiKey,
    );
    expect(reject.status, JSON.stringify(reject.data)).toBe(200);
    const rv3 = await req("PATCH", pubNest, `/nodes/${REVISIONS}`, { content: "# Revisions\n\nAPPROVED-V3" }, ed.apiKey);
    expect(rv3.status, JSON.stringify(rv3.data)).toBe(200);
    expect((await req("POST", pubNest, `/nodes/${REVISIONS}/submit-review`, {}, ed.apiKey)).status).toBe(201);
    const approve3 = await req("POST", pubNest, `/nodes/${REVISIONS}/approve`, {}, owner.apiKey);
    expect(approve3.status, JSON.stringify(approve3.data)).toBe(200);

    // "Pricing Deck": an HTML artifact, v1 approved, v2 draft.
    expect(
      await approvedV1(
        pubNest,
        "Pricing Deck",
        "<!doctype html><html><body><p>APPROVED-HTML</p></body></html>",
        { type: "artifact" },
      ),
    ).toBe(DECK);
    const dv2 = await req(
      "PATCH",
      pubNest,
      `/nodes/${DECK}`,
      { content: "<!doctype html><html><body><p>DRAFT-HTML</p></body></html>" },
      ed.apiKey,
    );
    expect(dv2.status, JSON.stringify(dv2.data)).toBe(200);

    const vis = await req("PATCH", pubNest, "/visibility", { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status, JSON.stringify(vis.data)).toBe(200);
    const rm = await req("PATCH", pubNest, "/reader-mode", { enabled: true }, owner.apiKey);
    expect(rm.status, JSON.stringify(rm.data)).toBe(200);

    // A read-only key of the owner, scoped to the public nest.
    const key = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "owner-readonly", nest_id: pubNest, capability: "read" },
      owner.apiKey,
    );
    expect(key.status, JSON.stringify(key.data)).toBeLessThan(300);
    ownerReadKey = key.data.api_key;
    expect(ownerReadKey).toBeTruthy();

    // ── Org nest ─────────────────────────────────────────────────────────
    orgNest = await governedNest("Pricing Org");
    expect(await approvedV1(orgNest, "Pricing", "# Pricing\n\nAPPROVED-V1")).toBe(PRICING);
    const ov2 = await req("PATCH", orgNest, `/nodes/${PRICING}`, { content: "# Pricing\n\nDRAFT-V2" }, ed.apiKey);
    expect(ov2.status, JSON.stringify(ov2.data)).toBe(200);
    expect(await approvedV1(orgNest, "Pricing Proposals", "# Proposals\n\nAPPROVED-V1")).toBe(PROPOSALS);
    const ovis = await req("PATCH", orgNest, "/visibility", { visibility: "org" }, owner.apiKey);
    expect(ovis.status, JSON.stringify(ovis.data)).toBe(200);
    const contrib = await req("PATCH", orgNest, "/settings", { org_contributions: "drafts" }, owner.apiKey);
    expect(contrib.status, JSON.stringify(contrib.data)).toBe(200);
    // pat (signed in, not a collaborator) proposes v2 on the approved doc.
    const proposal = await req("PATCH", orgNest, `/nodes/${PROPOSALS}`, { content: "# Proposals\n\nPAT-DRAFT" }, pat.apiKey);
    expect(proposal.status, JSON.stringify(proposal.data)).toBe(200);
  }, 120000);

  afterAll(() => env.cleanup());

  // ── The Given holds, and where it lands in the real chain ────────────────
  //
  // Approving seals a publish bump of its own, so the examples' "v1 approved,
  // v2 draft" lands as: v1 ed's write, v2 the owner's approval (the approved
  // version), v3 ed's unsubmitted draft. Each case below works from the
  // numbers the member's own view reports, never from hard-coded ones.

  type Chain = { approved: number; draft: number; versions: Array<{ version: number; status: string }> };
  const chains: Record<string, Chain> = {};
  /** Versions a visibility-only reader should see: approved snapshots up to
   *  the approved version — no draft, pending or rejected one. */
  const approvedOnly = (c: Chain) =>
    c.versions
      .filter((v) => v.version <= c.approved && !["draft", "pending_review", "rejected"].includes(v.status))
      .map((v) => v.version)
      .sort((a, b) => a - b);
  const all = (c: Chain) => c.versions.map((v) => v.version).sort((a, b) => a - b);

  it("setup: the approved and draft versions are what the Given says", async () => {
    const load = async (key: string, nest: string, id: string) => {
      const l = await memberList(nest, id);
      const versions = l.versions.map((v: any) => ({ version: Number(v.version), status: v.status }));
      const drafts = versions.filter((v: any) => v.status === "draft" || v.status === "pending_review");
      chains[key] = {
        approved: l.approvedVersion,
        draft: drafts.length ? Math.max(...drafts.map((v: any) => v.version)) : -1,
        versions,
      };
      return l;
    };

    const pricing = await load("pub", pubNest, PRICING);
    expect(chains.pub.approved).toBeGreaterThan(0);
    expect(chains.pub.draft).toBe(pricing.currentVersion);
    expect(chains.pub.draft).toBeGreaterThan(chains.pub.approved);
    const approvedBody = await req("GET", pubNest, `/nodes/${PRICING}/versions/${chains.pub.approved}`, undefined, owner.apiKey);
    expect(approvedBody.data.content).toContain("APPROVED-V1");
    const draftBody = await req("GET", pubNest, `/nodes/${PRICING}/versions/${chains.pub.draft}`, undefined, owner.apiKey);
    expect(draftBody.data.content).toContain("DRAFT-V2");
    expect(pricing.versions.find((v: any) => v.version === chains.pub.draft).status).toBe("draft");

    const rev = await load("rev", pubNest, REVISIONS);
    const rejected = rev.versions.find((v: any) => v.status === "rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.version).toBeLessThan(rev.approvedVersion);
    const rejBody = await req("GET", pubNest, `/nodes/${REVISIONS}/versions/${rejected.version}`, undefined, owner.apiKey);
    expect(rejBody.data.content).toContain("REJECTED-V2");
    expect(rev.currentVersion).toBe(rev.approvedVersion);

    await load("deck", pubNest, DECK);
    expect(chains.deck.draft).toBeGreaterThan(chains.deck.approved);

    await load("org", orgNest, PRICING);
    expect(chains.org.draft).toBeGreaterThan(chains.org.approved);

    const prop = await load("prop", orgNest, PROPOSALS);
    expect(chains.prop.draft).toBeGreaterThan(chains.prop.approved);
    expect(prop.versions.find((v: any) => v.version === chains.prop.draft).editedBy).toBe(PAT);
  });

  // ── REST, anonymous public reader ────────────────────────────────────────

  it("EX-1 anonymous public reader cannot read the draft version body", async () => {
    const r = await anon(app, `/nests/${pubNest}/nodes/${PRICING}/versions/${chains.pub.draft}`);
    expect(r.text).not.toContain("DRAFT-V2");
    expect(r.status).toBe(404);
  });

  it("EX-2 anonymous public reader reads the approved version body", async () => {
    const r = await anon(app, `/nests/${pubNest}/nodes/${PRICING}/versions/${chains.pub.approved}`);
    expect(r.status).toBe(200);
    expect(r.json.content).toContain("APPROVED-V1");
  });

  it("EX-3 anonymous public reader lists only approved versions, no diff, no emails", async () => {
    const r = await anon(app, `/nests/${pubNest}/nodes/${PRICING}/versions`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("DRAFT-V2");
    expect(r.text).not.toContain(ED);
    expect(r.text).not.toContain(OWNER);
    expect(versionNumbers(r.json)).toEqual(approvedOnly(chains.pub));
    expect(r.json.currentVersion).toBe(chains.pub.approved);
    for (const v of r.json.versions) expect(v.diff).toBeUndefined();
  });

  // ── REST, org reader ─────────────────────────────────────────────────────

  it("EX-4 org reader cannot read the draft and lists only approved versions without emails", async () => {
    const body = await getAs(app, `/nests/${orgNest}/nodes/${PRICING}/versions/${chains.org.draft}`, reader.apiKey);
    expect(body.text).not.toContain("DRAFT-V2");
    expect(body.status).toBe(404);

    const list = await getAs(app, `/nests/${orgNest}/nodes/${PRICING}/versions`, reader.apiKey);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(ED);
    expect(list.text).not.toContain(OWNER);
    expect(versionNumbers(list.json)).toEqual(approvedOnly(chains.org));
  });

  // ── REST, sent-back version between two approvals ────────────────────────

  it("EX-5 anonymous public reader cannot see a version sent back for changes", async () => {
    const rejected = chains.rev.versions.find((v) => v.status === "rejected")!.version;
    const body = await anon(app, `/nests/${pubNest}/nodes/${REVISIONS}/versions/${rejected}`);
    expect(body.text).not.toContain("REJECTED-V2");
    expect(body.status).toBe(404);

    const list = await anon(app, `/nests/${pubNest}/nodes/${REVISIONS}/versions`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("REJECTED-V2");
    expect(versionNumbers(list.json)).not.toContain(rejected);
    expect(versionNumbers(list.json)).toEqual(approvedOnly(chains.rev));
  });

  // ── REST, owner's read-only key ──────────────────────────────────────────

  it("EX-6 read-only key of the owner reads the draft body", async () => {
    const r = await getAs(app, `/nests/${pubNest}/nodes/${PRICING}/versions/${chains.pub.draft}`, ownerReadKey);
    expect(r.status).toBe(200);
    expect(r.json.content).toContain("DRAFT-V2");
  });

  it("EX-7 read-only key of the owner lists every version with no emails and no client block", async () => {
    const r = await getAs(app, `/nests/${pubNest}/nodes/${PRICING}/versions`, ownerReadKey);
    expect(r.status).toBe(200);
    expect(versionNumbers(r.json)).toEqual(all(chains.pub));
    expect(r.text).not.toContain(ED);
    expect(r.text).not.toContain(OWNER);
    for (const v of r.json.versions) {
      expect(v.editedBy ?? null).toBeNull();
      expect(v.author ?? null).toBeNull();
      expect(v.resolvedBy ?? null).toBeNull();
      expect(v.client).toBeUndefined();
    }
  });

  // ── REST, member editor ──────────────────────────────────────────────────

  it("EX-8 member editor reads the draft and the full list naming the editor", async () => {
    const body = await getAs(app, `/nests/${pubNest}/nodes/${PRICING}/versions/${chains.pub.draft}`, ed.apiKey);
    expect(body.status).toBe(200);
    expect(body.json.content).toContain("DRAFT-V2");

    const list = await getAs(app, `/nests/${pubNest}/nodes/${PRICING}/versions`, ed.apiKey);
    expect(list.status).toBe(200);
    expect(versionNumbers(list.json)).toEqual(all(chains.pub));
    expect(list.json.versions.find((v: any) => v.version === chains.pub.draft).editedBy).toBe(ED);
  });

  // ── REST, org contributor's own draft ────────────────────────────────────

  it("EX-9 org contributor reads their own proposed draft and sees no other person's email", async () => {
    const body = await getAs(app, `/nests/${orgNest}/nodes/${PROPOSALS}/versions/${chains.prop.draft}`, pat.apiKey);
    expect(body.status).toBe(200);
    expect(body.json.content).toContain("PAT-DRAFT");

    const list = await getAs(app, `/nests/${orgNest}/nodes/${PROPOSALS}/versions`, pat.apiKey);
    expect(list.status).toBe(200);
    expect(versionNumbers(list.json)).toEqual([...approvedOnly(chains.prop), chains.prop.draft]);
    expect(list.text).not.toContain(ED);
    expect(list.text).not.toContain(OWNER);
  });

  // ── MCP context_versions ─────────────────────────────────────────────────

  const mcpNumbers = (r: { data?: any }) =>
    (r.data?.versions ?? []).map((v: any) => Number(v.version)).sort((a: number, b: number) => a - b);

  it("EX-10 signed-in non-member on the public nest sees only approved versions over MCP, without editors", async () => {
    const r = await callTool(app, pubNest, reader.apiKey, "context_versions", { title: "Pricing" });
    expect(r.isError).toBeFalsy();
    expect(mcpNumbers(r)).toEqual(approvedOnly(chains.pub));
    for (const v of r.data.versions) expect(v.edited_by).toBeUndefined();
    expect(r.text).not.toContain(`**v${chains.pub.draft}**`);
    expect(r.text).not.toContain("DRAFT-V2");
    expect(JSON.stringify(r.raw)).not.toContain(ED);
    expect(JSON.stringify(r.raw)).not.toContain(OWNER);
  });

  it("EX-11 read-only key of the owner lists every version over MCP, without editors or client", async () => {
    const r = await callTool(app, pubNest, ownerReadKey, "context_versions", { title: "Pricing" });
    expect(r.isError).toBeFalsy();
    expect(mcpNumbers(r)).toEqual(all(chains.pub));
    for (const v of r.data.versions) {
      expect(v.edited_by).toBeUndefined();
      expect(v.client).toBeUndefined();
    }
    expect(JSON.stringify(r.raw)).not.toContain(ED);
    expect(JSON.stringify(r.raw)).not.toContain(OWNER);
    expect(JSON.stringify(r.raw)).not.toContain("ed-agent");
  });

  it("EX-12 member editor lists every version over MCP with edited_by", async () => {
    const r = await callTool(app, pubNest, ed.apiKey, "context_versions", { title: "Pricing" });
    expect(r.isError).toBeFalsy();
    expect(mcpNumbers(r)).toEqual(all(chains.pub));
    const draft = r.data.versions.find((v: any) => Number(v.version) === chains.pub.draft);
    expect(draft.edited_by).toBe(ED);
  });

  // ── Hosted HTML artifact snapshots ───────────────────────────────────────

  it("EX-13 anonymous public reader cannot pin a draft artifact snapshot, but can pin the approved one", async () => {
    const draft = await anon(app, `/nests/${pubNest}/nodes/${DECK}/hosted?v=${chains.deck.draft}`);
    const approved = await anon(app, `/nests/${pubNest}/nodes/${DECK}/hosted?v=${chains.deck.approved}`);
    // Approved half first, so a draft-half failure can't hide it.
    expect(approved.status).toBe(200);
    expect(approved.text).toContain("APPROVED-HTML");
    expect(draft.text).not.toContain("DRAFT-HTML");
    expect(draft.status).toBe(404);
  });

  // ── Errors ───────────────────────────────────────────────────────────────

  it("EX-15 anonymous public reader asking for a version that does not exist gets 404", async () => {
    const r = await anon(app, `/nests/${pubNest}/nodes/${PRICING}/versions/99`);
    expect(r.status).toBe(404);
  });

  // ── Public docs site (regression) ────────────────────────────────────────

  it("EX-16 the public docs site page holds the approved text, not the draft or an editor email", async () => {
    const res = await app.request(`http://localhost/d/pricing-nest/pricing`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("APPROVED-V1");
    expect(html).not.toContain("DRAFT-V2");
    expect(html).not.toContain(ED);
  });
});
