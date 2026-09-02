/**
 * Push Confirmation Gate (superadmin) — server contract.
 *
 * A superadmin can require confirmation for `ctx push` (POST /nests/:id/publish).
 * On a gated nest the push is HELD as a pending_pushes row (202
 * pending_confirmation) instead of applying; it applies only after a reviewer
 * confirms in the web UI. An "always allow" whitelists future pushes from that
 * exact API key.
 *
 * Mirrors test/self-approve-autopublish.test.ts and admin-super-admins.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string }; // superadmin
let owner: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };

/** Mint a second API key for an already-registered user (same user, new key_id). */
async function mintKey(apiKey: string, label: string): Promise<string> {
  const { data } = await jsonRequest(
    app,
    "POST",
    "/auth/keys",
    { label },
    apiKey,
  );
  return data.api_key as string;
}

/** Fetch the docs a nest currently holds (published node list). */
async function nodeIds(caller: any, nestId: string): Promise<string[]> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes`,
    undefined,
    caller.apiKey,
  );
  return (data.nodes || []).map((n: any) => n.id);
}

/** Turn the superadmin push-confirmation gate on/off for a nest. */
async function setGate(nestId: string, on: boolean, caller = root) {
  return jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { require_push_confirmation: on },
    caller.apiKey,
  );
}

/** Create a fresh nest owned by `owner`. */
async function makeNest(name: string): Promise<string> {
  const { data } = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name },
    owner.apiKey,
  );
  return data.nest.id as string;
}

const oneDoc = {
  documents: [{ title: "Doc A", content: "# Doc A\n\nbody", tags: ["alpha"] }],
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
});

afterAll(() => env.cleanup());

describe("config: superadmin-only require_push_confirmation", () => {
  it("gate defaults off — GET settings reports false", async () => {
    const nestId = await makeNest("cfg-default");
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(data.require_push_confirmation).toBe(false);
  });

  it("a non-superadmin nest owner CANNOT set the field (per-field 403)", async () => {
    const nestId = await makeNest("cfg-owner-403");
    const res = await setGate(nestId, true, owner);
    expect(res.status).toBe(403);
    // …and the field did not change as a side effect.
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(data.require_push_confirmation).toBe(false);
  });

  it("a superadmin CAN set the field", async () => {
    const nestId = await makeNest("cfg-super-ok");
    const res = await setGate(nestId, true);
    expect(res.status).toBe(200);
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(data.require_push_confirmation).toBe(true);
  });
});

describe("gate OFF is a no-op — publish applies immediately", () => {
  it("push applies at once (200/201), docs present", async () => {
    const nestId = await makeNest("gate-off");
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      oneDoc,
      owner.apiKey,
    );
    expect([200, 201]).toContain(status);
    expect(data.status).not.toBe("pending_confirmation");
    expect(await nodeIds(owner, nestId)).toContain("nodes/doc-a");
  });
});

describe("gate ON — push is held pending, applies only on confirm", () => {
  let nestId: string;
  let pendingId: string;

  it("gated push → 202 pending_confirmation + wire contract fields", async () => {
    nestId = await makeNest("gate-on");
    await setGate(nestId, true);

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      oneDoc,
      owner.apiKey,
    );
    expect(status).toBe(202);
    expect(data.status).toBe("pending_confirmation");
    expect(data.pending_id).toBeTruthy();
    expect(data.confirm_url).toBeTruthy();
    expect(data.poll_url).toBe(
      `/nests/${nestId}/pending-pushes/${data.pending_id}`,
    );
    expect(data.message).toBeTruthy();
    expect(data.expires_at).toBeTruthy();
    pendingId = data.pending_id;

    // The docs are NOT applied yet.
    expect(await nodeIds(owner, nestId)).not.toContain("nodes/doc-a");
  });

  it("a pending_pushes row exists with attribution", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/pending-pushes/${pendingId}`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.status).toBe("pending");
    expect(data.nest_name).toBe("gate-on");
    expect(data.doc_count).toBe(1);
    // Attribution: who pushed.
    expect((data.submitter_email || data.submitter_label || "").length).toBeGreaterThan(0);
  });

  it("confirm → applied, docs present, decided_by stamped", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${pendingId}/confirm`,
      {},
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.status).toBe("applied");

    expect(await nodeIds(owner, nestId)).toContain("nodes/doc-a");

    const poll = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/pending-pushes/${pendingId}`,
      undefined,
      owner.apiKey,
    );
    expect(poll.data.status).toBe("applied");
    expect(poll.data.decided_by).toBeTruthy();
    expect(poll.data.applied_node_count).toBe(1);
  });

  it("confirming an already-applied push → 409", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${pendingId}/confirm`,
      {},
      owner.apiKey,
    );
    expect(status).toBe(409);
  });
});

describe("reject → never applied", () => {
  it("rejected push leaves no docs behind", async () => {
    const nestId = await makeNest("gate-reject");
    await setGate(nestId, true);
    const { data: pending } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Rejected Doc", content: "x" }] },
      owner.apiKey,
    );
    const rej = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${pending.pending_id}/reject`,
      {},
      owner.apiKey,
    );
    expect(rej.status).toBe(200);
    expect(rej.data.status).toBe("rejected");
    expect(await nodeIds(owner, nestId)).not.toContain("nodes/rejected-doc");
  });
});

describe("always-allow whitelists the exact API key", () => {
  it("2nd push with the SAME key applies immediately; a DIFFERENT key still gates", async () => {
    const nestId = await makeNest("allowlist");
    await setGate(nestId, true);

    const keyA = await mintKey(owner.apiKey, "key-A");
    const keyB = await mintKey(owner.apiKey, "key-B");
    const callerA = { apiKey: keyA };
    const callerB = { apiKey: keyB };

    // First push on key A → gated.
    const first = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "First", content: "1" }] },
      keyA,
    );
    expect(first.status).toBe(202);

    // Confirm WITH always_allow → whitelists key A.
    const confirm = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${first.data.pending_id}/confirm`,
      { always_allow: true },
      owner.apiKey,
    );
    expect(confirm.status).toBe(200);

    // Allowlist now carries a row scoped to that user + key.
    const al = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/push-allowlist`,
      undefined,
      owner.apiKey,
    );
    expect(al.status).toBe(200);
    expect((al.data.allowlist || al.data.entries || []).length).toBeGreaterThan(0);

    // 2nd push on key A → applies immediately (no gate).
    const second = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Second", content: "2" }] },
      keyA,
    );
    expect([200, 201]).toContain(second.status);
    expect(await nodeIds(callerA, nestId)).toContain("nodes/second");

    // A DIFFERENT key still gates.
    const third = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Third", content: "3" }] },
      keyB,
    );
    expect(third.status).toBe(202);
    expect(await nodeIds(callerB, nestId)).not.toContain("nodes/third");
  });
});

describe("submitter-or-steward read scope", () => {
  it("the submitter can GET its own pending-push status but not another nest's", async () => {
    const nestId = await makeNest("read-scope");
    await setGate(nestId, true);
    const { data: pending } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      oneDoc,
      owner.apiKey,
    );

    // Owner (the submitter) can read its own pending-push.
    const mine = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/pending-pushes/${pending.pending_id}`,
      undefined,
      owner.apiKey,
    );
    expect(mine.status).toBe(200);

    // An outsider with no access to the nest gets 404 (existence oracle).
    const theirs = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/pending-pushes/${pending.pending_id}`,
      undefined,
      outsider.apiKey,
    );
    expect(theirs.status).toBe(404);
  });
});

describe("expiry", () => {
  it("an expired pending push reports expired, and confirm-on-expired → 409", async () => {
    const nestId = await makeNest("expiry");
    await setGate(nestId, true);
    const { data: pending } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      oneDoc,
      owner.apiKey,
    );

    // Force the row past its TTL directly in the app's DB.
    const { getDb } = await import("../src/db/client.js");
    await getDb().run(
      "UPDATE pending_pushes SET expires_at = ? WHERE id = ?",
      ["2000-01-01T00:00:00.000Z", pending.pending_id],
    );

    const poll = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/pending-pushes/${pending.pending_id}`,
      undefined,
      owner.apiKey,
    );
    expect(poll.data.status).toBe("expired");

    const confirm = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${pending.pending_id}/confirm`,
      {},
      owner.apiKey,
    );
    expect(confirm.status).toBe(409);
    expect(await nodeIds(owner, nestId)).not.toContain("nodes/doc-a");
  });
});

describe("grantee cannot reach /publish", () => {
  it("a user with no access is denied publish (404 existence oracle)", async () => {
    const nestId = await makeNest("grantee-denied");
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      oneDoc,
      outsider.apiKey,
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe("activity feed surfaces the held push", () => {
  it("a pending_push feed item carries the shape the modal needs", async () => {
    const nestId = await makeNest("feed-shape");
    await setGate(nestId, true);
    const { data: pending } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Feed Doc", content: "x", tags: ["z"] }] },
      owner.apiKey,
    );

    const feed = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/feed?filter=changes`,
      undefined,
      owner.apiKey,
    );
    expect(feed.status).toBe(200);
    expect(feed.data.counts.pending_pushes).toBeGreaterThanOrEqual(1);
    const item = feed.data.items.find(
      (i: any) => i.type === "pending_push" && i.id === pending.pending_id,
    );
    expect(item).toBeTruthy();
    expect(item.docCount).toBe(1);
    expect(item.nestName).toBe("feed-shape");
    expect(Array.isArray(item.manifest)).toBe(true);
    expect(item.manifest[0].title).toBe("Feed Doc");
    // The owner is a reviewer → can confirm from the feed.
    expect(item.canConfirm).toBe(true);
  });
});

describe("license gate — pending-push routes are governance-gated (503)", () => {
  let unlicensed: any;
  let uenv: ReturnType<typeof setupTestEnv>;

  beforeAll(async () => {
    uenv = setupTestEnv();
    process.env.AUTH_MODE = "open";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    const { createApp } = await import("../src/app.js");
    unlicensed = createApp();
  });

  afterAll(() => uenv.cleanup());

  it("503s the pending-pushes list without a license", async () => {
    const res = await unlicensed.request("/nests/some-nest/pending-pushes");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("License required");
  });

  it("503s the push-allowlist without a license", async () => {
    const res = await unlicensed.request("/nests/some-nest/push-allowlist");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("License required");
  });
});
