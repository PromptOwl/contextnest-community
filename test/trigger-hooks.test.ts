/**
 * Inbound trigger hooks: tokenized public URLs that create runs.
 *  - webhook preset: raw JSON → run inputs
 *  - slack preset: url_verification challenge, slash-command form posts,
 *    Events API @mention, signing-secret verification via the nest env store
 *  - management CRUD is nest-scoped + workflow-gated; firing is public
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Hooks" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Digest Agent", content: "# instructions", type: "agent" }, alice.apiKey);
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

const createHook = async (preset: string) => {
  const res = await jsonRequest(app, "POST", `/nests/${nestId}/hooks`,
    { agent_node: "nodes/digest-agent", preset }, alice.apiKey);
  expect(res.status).toBe(201);
  expect(res.data.hook.url).toContain(`/hooks/${res.data.hook.id}`);
  return res.data.hook;
};

const fireRaw = (token: string, body: string, headers: Record<string, string> = {}) =>
  app.request(`http://localhost/hooks/${token}`, { method: "POST", headers, body });

describe("webhook preset", () => {
  it("creates a run with the JSON body as inputs", async () => {
    const hook = await createHook("webhook");
    const res = await fireRaw(hook.id, JSON.stringify({ account: "Foley" }), {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(201);
    const { run_id } = await res.json();

    const runs = await jsonRequest(app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey);
    const run = runs.data.runs.find((r: any) => r.id === run_id);
    expect(run.triggered_by).toBe(`hook:webhook:${alice.email}`);
    expect(run.inputs.account).toBe("Foley");
  });

  it("404s for unknown tokens and after deletion", async () => {
    const ghost = await fireRaw("hk_nope", "{}", { "Content-Type": "application/json" });
    expect(ghost.status).toBe(404);

    const hook = await createHook("webhook");
    await jsonRequest(app, "DELETE", `/nests/${nestId}/hooks/${hook.id}`, undefined, alice.apiKey);
    const gone = await fireRaw(hook.id, "{}", { "Content-Type": "application/json" });
    expect(gone.status).toBe(404);
  });
});

describe("slack preset", () => {
  it("answers the Events API url_verification challenge", async () => {
    const hook = await createHook("slack");
    const res = await fireRaw(hook.id,
      JSON.stringify({ type: "url_verification", challenge: "c123" }),
      { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect((await res.json()).challenge).toBe("c123");
  });

  it("slash command: form post → run inputs + ephemeral ack", async () => {
    const hook = await createHook("webhook"); // separate agent hooks conflict? no — multiple hooks allowed
    const slack = await createHook("slack");
    const res = await fireRaw(slack.id,
      new URLSearchParams({ text: "foley Q3", user_name: "misha", channel_name: "gtm" }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Queued");

    const runs = await jsonRequest(app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey);
    const run = runs.data.runs.find((r: any) => r.triggered_by === `hook:slack:${alice.email}`);
    expect(run.inputs.input).toBe("foley Q3");
    expect(run.inputs.from).toBe("misha");
    void hook;
  });

  it("@mention event: app_mention → run; other events ignored", async () => {
    const slack = await createHook("slack");
    const mention = await fireRaw(slack.id,
      JSON.stringify({
        type: "event_callback",
        event: { type: "app_mention", text: "<@U0AGENT> summarize the week", user: "U0MISHA", channel: "C0GTM" },
      }),
      { "Content-Type": "application/json" });
    expect(mention.status).toBe(200);

    const runs = await jsonRequest(app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey);
    const run = runs.data.runs.find((r: any) => r.inputs?.input === "summarize the week");
    expect(run).toBeTruthy();

    const other = await fireRaw(slack.id,
      JSON.stringify({ type: "event_callback", event: { type: "reaction_added" } }),
      { "Content-Type": "application/json" });
    expect(other.status).toBe(200);
    const runsAfter = await jsonRequest(app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey);
    expect(runsAfter.data.runs.length).toBe(runs.data.runs.length);
  });

  it("verifies the signing secret from the nest env store", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/env`,
      { key: "SLACK_SIGNING_SECRET", value: "shhh-secret" }, alice.apiKey);
    const slack = await createHook("slack");
    const body = new URLSearchParams({ text: "signed", user_name: "misha" }).toString();

    // Unsigned → 401 now that a secret exists.
    const unsigned = await fireRaw(slack.id, body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    expect(unsigned.status).toBe(401);

    // Properly signed → accepted.
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", "shhh-secret").update(`v0:${ts}:${body}`).digest("hex")}`;
    const signed = await fireRaw(slack.id, body, {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    });
    expect(signed.status).toBe(200);

    // Stale timestamp → rejected (replay fence).
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const oldSig = `v0=${createHmac("sha256", "shhh-secret").update(`v0:${oldTs}:${body}`).digest("hex")}`;
    const replayed = await fireRaw(slack.id, body, {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": oldTs,
      "x-slack-signature": oldSig,
    });
    expect(replayed.status).toBe(401);

    await jsonRequest(app, "DELETE", `/nests/${nestId}/env/SLACK_SIGNING_SECRET`,
      undefined, alice.apiKey);
  });
});
