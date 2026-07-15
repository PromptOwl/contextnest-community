/**
 * Tools + HITL notify:
 *  - nest_env: write-only store (masked reads), delivered in the run bundle
 *  - tool nodes: bodies ride the run bundle for reachable tools
 *  - watchers: tagging a person to an agent notifies them when the agent's
 *    output lands for review; /me/work surfaces the notifications
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Tools" }, alice.apiKey);
  nestId = nest.data.nest.id;

  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Poster Agent", content: "# Post the digest", type: "agent" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Slack Tool", content: "export async function post(env, msg) { /* … */ }", type: "tool" },
    alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Digest Output", content: "# empty" }, alice.apiKey);
  // agent → tool (uses) and agent → output (flow) edges
  await jsonRequest(app, "POST", `/nests/${nestId}/edges`,
    { from_node: "nodes/poster-agent", to_node: "nodes/slack-tool", type: "next" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/edges`,
    { from_node: "nodes/poster-agent", to_node: "nodes/digest-output", type: "next" }, alice.apiKey);
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("nest env store", () => {
  it("PUT + masked GET; rejects bad keys", async () => {
    const put = await jsonRequest(app, "PUT", `/nests/${nestId}/env`,
      { key: "SLACK_TOKEN", value: "xoxb-secret-12345" }, alice.apiKey);
    expect(put.status).toBe(201);
    expect(put.data.value_masked).toBe("••••2345");

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/env`, undefined, alice.apiKey);
    expect(list.status).toBe(200);
    expect(list.data.env[0].key).toBe("SLACK_TOKEN");
    expect(JSON.stringify(list.data)).not.toContain("xoxb-secret");

    const bad = await jsonRequest(app, "PUT", `/nests/${nestId}/env`,
      { key: "lower case!", value: "x" }, alice.apiKey);
    expect(bad.status).toBe(400);
  });

  it("run bundle carries env values + reachable tool bodies", async () => {
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/poster-agent`,
      {}, alice.apiKey);
    expect(run.status).toBe(201);
    expect(run.data.env.SLACK_TOKEN).toBe("xoxb-secret-12345");
    expect(run.data.tools["nodes/slack-tool"]).toContain("export async function post");
    expect(run.data.node_types["nodes/slack-tool"]).toBe("tool");
  });

  it("DELETE removes a key", async () => {
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/env/SLACK_TOKEN`,
      undefined, alice.apiKey);
    expect(del.status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/env`, undefined, alice.apiKey);
    expect(list.data.count).toBe(0);
  });
});

describe("watchers → notifications", () => {
  it("tags bob to the agent; a review on its output notifies him", async () => {
    const tag = await jsonRequest(app, "POST",
      `/nests/${nestId}/nodes/nodes/poster-agent/watchers`,
      { email: bob.email }, alice.apiKey);
    expect(tag.status).toBe(201);
    expect(tag.data.watchers.map((w: any) => w.user_email)).toContain(bob.email);

    // Turn on stewardship (bob as reviewer) so submit-review works, then
    // submit the agent's OUTPUT doc — bob watches the agent, not the doc.
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: bob.email, role: "reviewer" }] }, alice.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/digest-output`,
      { content: "# digest v2" }, alice.apiKey);
    const submit = await jsonRequest(app, "POST",
      `/nests/${nestId}/nodes/nodes/digest-output/submit-review`,
      { note: "agent output" }, alice.apiKey);
    expect([200, 201]).toContain(submit.status);

    const inbox = await jsonRequest(app, "GET", "/me/notifications?unread=true",
      undefined, bob.apiKey);
    expect(inbox.status).toBe(200);
    const mine = inbox.data.notifications.filter((n: any) =>
      n.message.includes("poster-agent"));
    expect(mine.length).toBe(1);
    expect(mine[0].message).toContain("digest-output");

    // /me/work carries them too, and mark-read clears them.
    const work = await jsonRequest(app, "GET", "/me/work", undefined, bob.apiKey);
    expect(work.data.notifications.length).toBeGreaterThanOrEqual(1);
    const read = await jsonRequest(app, "POST", "/me/notifications/read",
      { ids: "all" }, bob.apiKey);
    expect(read.status).toBe(200);
    const after = await jsonRequest(app, "GET", "/me/notifications?unread=true",
      undefined, bob.apiKey);
    expect(after.data.notifications.length).toBe(0);
  });

  it("submitter is not notified about their own submission", async () => {
    const inbox = await jsonRequest(app, "GET", "/me/notifications?unread=true",
      undefined, alice.apiKey);
    expect(inbox.data.notifications.length).toBe(0);
  });

  it("verdict notifies the submitter (approve path)", async () => {
    // Bob (reviewer) approves alice's pending submission from the earlier
    // test; alice — the submitter — must hear the verdict.
    const approve = await jsonRequest(app, "POST",
      `/nests/${nestId}/nodes/nodes/digest-output/approve`,
      { note: "looks right" }, bob.apiKey);
    expect([200, 201]).toContain(approve.status);

    const inbox = await jsonRequest(app, "GET", "/me/notifications?unread=true",
      undefined, alice.apiKey);
    const verdicts = inbox.data.notifications.filter(
      (n: any) => n.kind === "review_approved");
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].message).toContain("approved by");
    // The approver themself hears nothing.
    const bobInbox = await jsonRequest(app, "GET", "/me/notifications?unread=true",
      undefined, bob.apiKey);
    expect(bobInbox.data.notifications.filter(
      (n: any) => n.kind === "review_approved").length).toBe(0);
  });

  it("untag stops future notifications", async () => {
    const untag = await jsonRequest(app, "DELETE",
      `/nests/${nestId}/nodes/nodes/poster-agent/watchers?email=${encodeURIComponent(bob.email)}`,
      undefined, alice.apiKey);
    expect(untag.status).toBe(200);
    expect(untag.data.watchers.length).toBe(0);
  });
});
