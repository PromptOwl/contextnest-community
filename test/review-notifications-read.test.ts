/**
 * A resolved review stops asking.
 *
 * "Please review this" inbox rows — the original `review_requested` (to the
 * document's watchers) and any SLA `review_escalated` (to the rung it
 * reached) — are marked read for every recipient once the review is
 * approved, rejected or withdrawn, whoever resolved it. Before this, those
 * rows sat unread in /me/work looking exactly like an open ask.
 *
 * Other rows are untouched: the verdict row the submitter gets stays unread,
 * and so does a still-pending review's request on another document.
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
type Row = { kind: string; node_id: string | null; read_at: string | null };

const H = 3_600_000;

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // submitter
let wally: User; // watcher of every document → review_requested rows
let nate: User; // nest reviewer → review_escalated rows (rung 2)
let nestId: string;
let tick: (now?: number) => Promise<unknown[]>;

async function rows(u: User, nodeId: string): Promise<Row[]> {
  const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey);
  return (data.notifications as Row[]).filter((n) => n.node_id === nodeId);
}

const unread = (rs: Row[], kind: string) =>
  rs.filter((r) => r.kind === kind && r.read_at === null);

/** Create, watch, submit, and escalate one document; asserts both asks land unread. */
async function pendingAndEscalated(title: string): Promise<string> {
  const id = `nodes/${title.toLowerCase()}`;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "v1" }, alice.apiKey);
  const w = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${id}/watchers`,
    { email: wally.email },
    owner.apiKey,
  );
  expect(w.status).toBe(201);
  const s = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${id}/submit-review`,
    {},
    alice.apiKey,
  );
  expect(s.status).toBe(201);
  await tick(Date.now() + 25 * H);

  expect(unread(await rows(wally, id), "review_requested")).toHaveLength(1);
  expect(unread(await rows(nate, id), "review_escalated")).toHaveLength(1);
  return id;
}

async function expectAsksCleared(id: string) {
  expect(unread(await rows(wally, id), "review_requested")).toEqual([]);
  expect(unread(await rows(nate, id), "review_escalated")).toEqual([]);
  // Cleared, not deleted — the inbox history keeps them.
  expect((await rows(wally, id)).some((r) => r.kind === "review_requested")).toBe(true);
  expect((await rows(nate, id)).some((r) => r.kind === "review_escalated")).toBe(true);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  wally = await registerUser(app, "wally@acme.com", "Wally");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  nate = await registerUser(app, "nate@acme.com", "Nate");

  ({ reviewSlaTick: tick } = await import("../src/governance/review-sla.js"));

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Asks" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: wally.email, permission: "read" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, review_sla_hours: 24 },
    owner.apiKey,
  );
  for (const [email, role] of [
    [alice.email, "editor"],
    [nate.email, "reviewer"],
  ]) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email, role }] },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  }
});

afterAll(() => env.cleanup());

describe("resolving a review clears its asks", () => {
  it("approve", async () => {
    const id = await pendingAndEscalated("Approved");
    const other = await pendingAndEscalated("Untouched");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/approve`, {}, nate.apiKey);
    expect(r.status).toBe(200);
    await expectAsksCleared(id);
    // A different, still-pending review keeps its asks.
    expect(unread(await rows(wally, other), "review_requested")).toHaveLength(1);
    expect(unread(await rows(nate, other), "review_escalated")).toHaveLength(1);
    // The submitter's verdict row is news, not an ask — it stays unread.
    expect(unread(await rows(alice, id), "review_approved")).toHaveLength(1);
  });

  it("reject", async () => {
    const id = await pendingAndEscalated("Rejected");
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${id}/reject`,
      { note: "needs sources" },
      nate.apiKey,
    );
    expect(r.status).toBe(200);
    await expectAsksCleared(id);
  });

  it("withdraw (cancel)", async () => {
    const id = await pendingAndEscalated("Withdrawn");
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${id}/cancel-review`,
      {},
      alice.apiKey,
    );
    expect(r.status).toBe(200);
    expect(r.data.review.status).toBe("cancelled");
    await expectAsksCleared(id);
  });
});
