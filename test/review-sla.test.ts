/**
 * Review SLA escalation — a review nobody picks up climbs the steward ladder.
 *
 * Per-nest `review_sla_hours` (off by default). Past the SLA a pending review
 * escalates ONE rung per window — tag reviewers, then nest reviewers, then the
 * nest owner — notifying the new rung through the inbox, the connector
 * dispatch and email. The rung is recorded on the review row before anyone is
 * notified, so no rung ever hears twice: not on the next tick, not after a
 * restart, not when two ticks race.
 *
 * The tick is driven directly with a fake `now`, the way schedules.test.ts
 * drives the workflow scheduler — no timers, no waiting.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const { dispatchEvent, sendEmailToRecipient, notifyNestEvent, cantOpen } = vi.hoisted(() => ({
  dispatchEvent: vi.fn(async () => {}),
  sendEmailToRecipient: vi.fn(async () => {}),
  notifyNestEvent: vi.fn(async () => {}),
  /** Emails canOpenNode refuses, on top of the real check. */
  cantOpen: new Set<string>(),
}));
// A matched reviewer steward normally can open the document (the steward row
// grants it), so the access gate is defence in depth — exercised by refusing
// chosen people here while everyone else goes through the real check.
vi.mock("../src/governance/mention-notify.js", async () => {
  const actual = await vi.importActual<typeof import("../src/governance/mention-notify.js")>(
    "../src/governance/mention-notify.js",
  );
  return {
    ...actual,
    canOpenNode: async (...a: Parameters<typeof actual.canOpenNode>) =>
      cantOpen.has(a[3].toLowerCase()) ? false : actual.canOpenNode(...a),
  };
});
// The server-wide Slack/Teams digest — the channel path review requests take.
// End-to-end delivery is covered in review-sla-channels.test.ts.
vi.mock("../src/notify/notify.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/notify.js")>(
    "../src/notify/notify.js",
  );
  return { ...actual, notifyNestEvent };
});
vi.mock("../src/notify/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/dispatch.js")>(
    "../src/notify/dispatch.js",
  );
  return { ...actual, dispatchEvent };
});
vi.mock("../src/notify/email.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/email.js")>(
    "../src/notify/email.js",
  );
  return { ...actual, sendEmailToRecipient };
});

type User = { apiKey: string; userId: string; email: string };

const H = 3_600_000;

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User; // rung 3
let alice: User; // author / submitter (editor)
let dora: User; // document reviewer (rung 0 — notified at submit)
let tara: User; // tag reviewer (rung 1)
let nate: User; // nest reviewer (rung 2)
let nestId: string;
let tick: (now?: number) => Promise<
  Array<{ reviewId: string; level: number; recipients: string[] }>
>;

async function escalations(u: User) {
  const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey);
  return (
    data.notifications as Array<{ kind: string; message: string; node_id: string | null }>
  ).filter((n) => n.kind === "review_escalated");
}

async function reviewsOf(nodeId: string) {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${nodeId}/reviews`,
    undefined,
    owner.apiKey,
  );
  return data.reviews as Array<{
    id: string;
    status: string;
    escalationLevel: number;
    escalatedAt?: string;
  }>;
}

async function steward(body: Record<string, unknown>) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/stewards`, body, owner.apiKey);
  expect(r.status).toBe(201);
}

/** Create a draft as alice and submit it; returns the time just after. */
async function submit(title: string, tags: string[] = []): Promise<number> {
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content: "v1", tags },
    alice.apiKey,
  );
  expect(created.status).toBe(201);
  const id = created.data.node?.id ?? `nodes/${title.toLowerCase()}`;
  const s = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${id}/submit-review`,
    {},
    alice.apiKey,
  );
  expect(s.status).toBe(201);
  return Date.now();
}

const escalatedEvents = () =>
  dispatchEvent.mock.calls
    .map((c) => c[0] as { kind: string; subjectId?: string; message: string })
    .filter((e) => e.kind === "review_escalated");

const overdueEmails = () =>
  sendEmailToRecipient.mock.calls.filter(
    (c) => (c[1] as { status: string }).status === "review_overdue",
  );

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  dora = await registerUser(app, "dora@acme.com", "Dora");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  tara = await registerUser(app, "tara@acme.com", "Tara");
  nate = await registerUser(app, "nate@acme.com", "Nate");

  ({ reviewSlaTick: tick } = await import("../src/governance/review-sla.js"));

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "SLA" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true },
    owner.apiKey,
  );
  await steward({ scope: "nest", users: [{ email: alice.email, role: "editor" }] });
  await steward({ scope: "nest", users: [{ email: nate.email, role: "reviewer" }] });
  await steward({
    scope: "tag",
    tagName: "finance",
    users: [{ email: tara.email, role: "reviewer" }],
  });
  await steward({
    scope: "document",
    documentId: "nodes/budget",
    users: [{ email: dora.email, role: "reviewer" }],
  });
});

afterAll(() => env.cleanup());

describe("setting", () => {
  it("is off (null) by default", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(data.review_sla_hours).toBeNull();
  });

  it("rejects a non-integer, negative or absurd SLA, writing nothing", async () => {
    for (const bad of [1.5, -3, 100_000, "24"]) {
      const r = await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/settings`,
        { review_sla_hours: bad, allow_self_approve: true },
        owner.apiKey,
      );
      expect(r.status).toBe(400);
    }
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(data.review_sla_hours).toBeNull();
    // The bad SLA was refused before the rest of the body was applied.
    expect(data.allow_self_approve).toBe(false);
  });

  it("is admin-only to set", async () => {
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { review_sla_hours: 24 },
      alice.apiKey,
    );
    expect(r.status).toBe(403);
  });
});

describe("off = inert", () => {
  it("never escalates while the SLA is off, however old the review", async () => {
    await submit("Budget", ["finance"]);
    dispatchEvent.mockClear();
    sendEmailToRecipient.mockClear();

    expect(await tick(Date.now() + 10_000 * H)).toEqual([]);
    for (const u of [owner, tara, nate]) expect(await escalations(u)).toEqual([]);
    expect(escalatedEvents()).toEqual([]);
    expect(overdueEmails()).toEqual([]);
    const [review] = await reviewsOf("nodes/budget");
    expect(review.escalationLevel).toBe(0);
    expect(review.escalatedAt).toBeUndefined();
  });
});

describe("escalation ladder", () => {
  let t0: number;

  beforeAll(async () => {
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { review_sla_hours: 24 },
      owner.apiKey,
    );
    expect(r.status).toBe(200);
    expect(r.data.review_sla_hours).toBe(24);
    // Budget was submitted in the suite above; measure from now (later than
    // its requested_at), so "t0 + 25h" is past the SLA for it.
    t0 = Date.now();
    dispatchEvent.mockClear();
    sendEmailToRecipient.mockClear();
    notifyNestEvent.mockClear();
  });

  it("does nothing before the SLA has elapsed", async () => {
    expect(await tick(t0 + 23 * H)).toEqual([]);
  });

  it("rung 1: past the SLA, the tag reviewers hear — nobody else", async () => {
    const out = await tick(t0 + 25 * H);
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe(1);
    expect(out[0].recipients).toEqual([tara.email]);

    const rows = await escalations(tara);
    expect(rows).toHaveLength(1);
    expect(rows[0].node_id).toBe("nodes/budget");
    expect(rows[0].message).toContain("Budget");
    expect(rows[0].message).toContain(alice.email);
    for (const u of [owner, nate, dora, alice]) expect(await escalations(u)).toEqual([]);

    // Connector dispatch + email went to the same rung.
    expect(escalatedEvents()).toHaveLength(1);
    expect(escalatedEvents()[0].subjectId).toBe("nodes/budget");
    expect(escalatedEvents()[0].message).toContain(tara.email);
    expect(overdueEmails()).toHaveLength(1);
    expect(overdueEmails()[0][0]).toEqual([tara.email]);
    // …and the server-wide channel digest, without the team-inbox email.
    const digest = notifyNestEvent.mock.calls.filter((c) =>
      String(c[1]).includes("escalated"),
    );
    expect(digest).toHaveLength(1);
    expect(digest[0][0]).toBe(nestId);
    expect(String(digest[0][1])).toContain(tara.email);
    expect(digest[0][3]).toEqual({ skipEmail: true });

    const [review] = await reviewsOf("nodes/budget");
    expect(review.escalationLevel).toBe(1);
    expect(review.escalatedAt).toBeTruthy();
  });

  it("is idempotent: later ticks inside the next window notify nobody", async () => {
    expect(await tick(t0 + 25 * H)).toEqual([]);
    expect(await tick(t0 + 40 * H)).toEqual([]);
    expect(await escalations(tara)).toHaveLength(1);
    expect(escalatedEvents()).toHaveLength(1);
  });

  it("two ticks racing (a second instance, a restart mid-tick) claim the rung once", async () => {
    const [a, b] = await Promise.all([tick(t0 + 50 * H), tick(t0 + 50 * H)]);
    const all = [...a, ...b];
    expect(all).toHaveLength(1);
    expect(all[0].level).toBe(2);
    expect(all[0].recipients).toEqual([nate.email]);
    expect(await escalations(nate)).toHaveLength(1);
  });

  it("state lives on the review row, so a restart can't re-notify", async () => {
    // The tick keeps no memory between runs — the claimed rung and its time
    // are columns on review_requests, which is all a restarted process has.
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT escalation_level, escalated_at FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending'",
      [nestId, "nodes/budget"],
    )) as { escalation_level: number; escalated_at: string };
    expect(row.escalation_level).toBe(2);
    expect(row.escalated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Stop and restart the loop the server runs, then tick inside the window.
    const mod = await import("../src/governance/review-sla.js");
    mod.stopReviewSlaLoop();
    mod.startReviewSlaLoop(3_600_000);
    mod.stopReviewSlaLoop();
    expect(await tick(t0 + 60 * H)).toEqual([]);
    expect(await escalations(nate)).toHaveLength(1);
  });

  it("rung 3: then the nest owner", async () => {
    const out = await tick(t0 + 75 * H);
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe(3);
    expect(out[0].recipients).toEqual([owner.email]);
    expect(await escalations(owner)).toHaveLength(1);
  });

  it("stops at the owner — nothing past the top rung", async () => {
    expect(await tick(t0 + 500 * H)).toEqual([]);
    const [review] = await reviewsOf("nodes/budget");
    expect(review.escalationLevel).toBe(3);
    // Every rung heard exactly once; the submitter and doc reviewer never.
    expect(await escalations(tara)).toHaveLength(1);
    expect(await escalations(nate)).toHaveLength(1);
    expect(await escalations(owner)).toHaveLength(1);
    expect(await escalations(alice)).toEqual([]);
    expect(await escalations(dora)).toEqual([]);
  });

  it("an empty rung is skipped in the same step (no tag reviewers → nest)", async () => {
    const t1 = await submit("Ops"); // no tags, no document steward
    const out = await tick(t1 + 25 * H);
    const mine = out.filter((o) => o.level > 0);
    expect(mine).toHaveLength(1);
    expect(mine[0].level).toBe(2);
    expect(mine[0].recipients).toEqual([nate.email]);
  });

  it("escalation doesn't grant approval: separation of duties is unchanged", async () => {
    // The submitter still can't approve their own work, escalated or not.
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/budget/can-approve`,
      undefined,
      alice.apiKey,
    );
    expect(data.allowed).toBe(false);
    // And the escalated rungs approve exactly as they could before.
    const nateCan = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/budget/can-approve`,
      undefined,
      nate.apiKey,
    );
    expect(nateCan.data.allowed).toBe(true);
  });

  it("a resolved review stops escalating", async () => {
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/ops/approve`,
      {},
      nate.apiKey,
    );
    expect(approve.status).toBe(200);
    expect(await tick(t0 + 1000 * H)).toEqual([]);
  });
});

describe("access gate", () => {
  it("never escalates to someone who can't open the document; their rung is skipped", async () => {
    cantOpen.add(tara.email.toLowerCase());
    sendEmailToRecipient.mockClear();
    try {
      const t1 = await submit("Forecast", ["finance"]); // tara's tag
      const out = (await tick(t1 + 25 * H)).filter((o) => o.level > 0);
      expect(out).toHaveLength(1);
      expect(out[0].level).toBe(2); // rung 1 (tara) skipped → nest reviewers
      expect(out[0].recipients).toEqual([nate.email]);
      expect(await escalations(tara)).not.toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("Forecast") }),
      );
      const mailed = overdueEmails().flatMap((c) => [c[0]].flat() as string[]);
      expect(mailed).not.toContain(tara.email);
      // Walk it to the top so later ticks in this file stay quiet.
      expect((await tick(t1 + 50 * H)).map((o) => o.level)).toEqual([3]);
    } finally {
      cantOpen.clear();
    }
  });
});

describe("edges", () => {
  it("parks a review at the top, notifying nobody, when nobody is left who can open it", async () => {
    for (const u of [tara, nate, owner]) cantOpen.add(u.email.toLowerCase());
    dispatchEvent.mockClear();
    try {
      const t1 = await submit("Orphan"); // no tags, no document steward
      const mine = async (at: number) =>
        (await tick(at)).filter((o) => o.level > 0);
      expect(await mine(t1 + 25 * H)).toEqual([]);
      const [review] = await reviewsOf("nodes/orphan");
      expect(review.escalationLevel).toBe(3);
      expect(escalatedEvents()).toEqual([]);
      // Parked: access granted later doesn't restart the ladder.
      cantOpen.clear();
      expect(await mine(t1 + 200 * H)).toEqual([]);
    } finally {
      cantOpen.clear();
    }
  });

  it("a failed notification keeps the rung claimed and is not retried", async () => {
    const t1 = await submit("Fragile");
    dispatchEvent.mockImplementationOnce(() => {
      throw new Error("connector down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await tick(t1 + 25 * H);
      expect(first.map((o) => o.level)).toEqual([2]); // no tags → nest reviewers
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("was claimed but its notification failed"),
        expect.any(Error),
      );
      const [review] = await reviewsOf("nodes/fragile");
      expect(review.escalationLevel).toBe(2);
      // Same window: nothing repeats.
      expect(await tick(t1 + 30 * H)).toEqual([]);
      // Walk it to the top so later ticks in this file stay quiet.
      expect((await tick(t1 + 50 * H)).map((o) => o.level)).toEqual([3]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("nextRung", () => {
  it("skips the submitter and anyone already on a lower rung", async () => {
    const { nextRung } = await import("../src/governance/review-sla.js");
    const rungs = [["doc@x"], ["doc@x", "sub@x"], ["n1@x", "doc@x"], ["owner@x"]];
    // Rung 1 has only the doc reviewer (already heard) and the submitter.
    expect(nextRung(rungs, 0, "sub@x")).toEqual({ level: 2, recipients: ["n1@x"] });
    expect(nextRung(rungs, 2, "sub@x")).toEqual({ level: 3, recipients: ["owner@x"] });
    // The owner submitted: nobody is left above the nest rung.
    expect(nextRung(rungs, 2, "owner@x")).toBeNull();
    expect(nextRung(rungs, 3, "sub@x")).toBeNull();
  });

  it("parses the DB's zone-less UTC timestamps as UTC", async () => {
    const { parseDbTimestamp } = await import("../src/governance/review-sla.js");
    expect(parseDbTimestamp("2026-10-02 12:00:00")).toBe(Date.UTC(2026, 9, 2, 12));
    expect(parseDbTimestamp("2026-10-02T12:00:00.000Z")).toBe(Date.UTC(2026, 9, 2, 12));
    expect(Number.isNaN(parseDbTimestamp(null))).toBe(true);
  });
});
