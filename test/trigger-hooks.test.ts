/**
 * Inbound trigger hooks: tokenized public URLs that create runs.
 *  - webhook preset: raw JSON → run inputs
 *  - slack and teams presets: nothing is accepted without a valid signature
 *    for the secret in the nest env store (po-1058)
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

const JSON_CT = { "Content-Type": "application/json" };
const FORM_CT = { "Content-Type": "application/x-www-form-urlencoded" };
const SECRET = "shhh-secret";
const TEAMS_SECRET = Buffer.from("teams-secret").toString("base64");

const setEnv = async (key: string, value: string) =>
  expect((await jsonRequest(app, "PUT", `/nests/${nestId}/env`, { key, value }, alice.apiKey)).status).toBe(201);
const clearEnv = (key: string) => jsonRequest(app, "DELETE", `/nests/${nestId}/env/${key}`, undefined, alice.apiKey);
const listRuns = async (): Promise<any[]> =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey)).data.runs;

const slackSign = (body: string, secret = SECRET, ageSeconds = 0) => {
  const ts = String(Math.floor(Date.now() / 1000) - ageSeconds);
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  };
};
const teamsSign = (body: string, key: Buffer = Buffer.from(TEAMS_SECRET, "base64")) => ({
  authorization: `HMAC ${createHmac("sha256", key).update(body, "utf8").digest("base64")}`,
});

/** Refused with 401, and the Runs list is unchanged. */
const expectRefused = async (hookId: string, body: string, headers: Record<string, string>, error: RegExp) => {
  const before = (await listRuns()).length;
  const res = await fireRaw(hookId, body, headers);
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(text).toMatch(error);
  expect(text).not.toContain("c123");
  expect((await listRuns()).length).toBe(before);
};

const MENTION = JSON.stringify({
  type: "event_callback",
  event: { type: "app_mention", text: "<@U0AGENT> summarize the week", user: "U0MISHA", channel: "C0GTM" },
});
const COMMAND = new URLSearchParams({ text: "foley Q3", user_name: "misha", channel_name: "gtm" }).toString();
const CHALLENGE = JSON.stringify({ type: "url_verification", challenge: "c123" });
const EACH = [[MENTION, JSON_CT], [COMMAND, FORM_CT], [CHALLENGE, JSON_CT]] as const;

describe("slack preset with no signing secret", () => {
  it("refuses events, commands and the URL check, and names the secret to set", async () => {
    const { id } = await createHook("slack");
    for (const [body, ct] of EACH) {
      await expectRefused(id, body, ct, /SLACK_SIGNING_SECRET/);
      await expectRefused(id, body, { ...ct, ...slackSign(body, "") }, /SLACK_SIGNING_SECRET/);
    }
  });

  it("refuses when the saved secret is blank or cannot be decrypted", async () => {
    const { id } = await createHook("slack");
    try {
      await setEnv("SLACK_SIGNING_SECRET", "  ");
      await expectRefused(id, MENTION, { ...JSON_CT, ...slackSign(MENTION, "  ") }, /SLACK_SIGNING_SECRET/);
      await setEnv("SLACK_SIGNING_SECRET", SECRET);
      const { getDb } = await import("../src/db/client.js");
      await getDb().run(
        "UPDATE nest_env SET value = ? WHERE nest_id = ? AND key = 'SLACK_SIGNING_SECRET'",
        ["enc.v1.broken", nestId],
      );
      await expectRefused(id, MENTION, { ...JSON_CT, ...slackSign(MENTION) }, /SLACK_SIGNING_SECRET/);
    } finally {
      await clearEnv("SLACK_SIGNING_SECRET");
    }
  });
});

describe("slack preset with a signing secret", () => {
  beforeAll(() => setEnv("SLACK_SIGNING_SECRET", SECRET));
  afterAll(() => clearEnv("SLACK_SIGNING_SECRET"));

  it("refuses a missing, wrong or stale (>5 min) signature, the URL check included", async () => {
    const { id } = await createHook("slack");
    for (const [body, ct] of EACH) {
      await expectRefused(id, body, ct, /bad signature/);
      await expectRefused(id, body, { ...ct, ...slackSign(body, "wrong") }, /bad signature/);
      await expectRefused(id, body, { ...ct, ...slackSign(body, SECRET, 600) }, /bad signature/);
    }
  });

  it("answers a signed url_verification challenge", async () => {
    const { id } = await createHook("slack");
    const res = await fireRaw(id, CHALLENGE, { ...JSON_CT, ...slackSign(CHALLENGE) });
    expect(res.status).toBe(200);
    expect((await res.json()).challenge).toBe("c123");
  });

  it("signed slash command: form post → run inputs + ephemeral ack", async () => {
    const { id } = await createHook("slack");
    const res = await fireRaw(id, COMMAND, { ...FORM_CT, ...slackSign(COMMAND) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Queued");
    const run = (await listRuns()).find((r) => r.triggered_by === `hook:slack:${alice.email}`);
    expect(run.inputs.input).toBe("foley Q3");
    expect(run.inputs.from).toBe("misha");
  });

  it("signed app_mention → run; other signed events ignored", async () => {
    const { id } = await createHook("slack");
    expect((await fireRaw(id, MENTION, { ...JSON_CT, ...slackSign(MENTION) })).status).toBe(200);
    const runs = await listRuns();
    expect(runs.find((r) => r.inputs?.input === "summarize the week")).toBeTruthy();

    const other = JSON.stringify({ type: "event_callback", event: { type: "reaction_added" } });
    expect((await fireRaw(id, other, { ...JSON_CT, ...slackSign(other) })).status).toBe(200);
    expect((await listRuns()).length).toBe(runs.length);
  });
});

describe("teams preset", () => {
  const ASK = JSON.stringify({ text: "<at>Agent</at> teams ask", from: { name: "Dana" } });

  it("refuses everything with no secret, or one that is not base64", async () => {
    const { id } = await createHook("teams");
    await expectRefused(id, ASK, JSON_CT, /TEAMS_WEBHOOK_SECRET/);
    try {
      await setEnv("TEAMS_WEBHOOK_SECRET", "!!!");
      await expectRefused(id, ASK, { ...JSON_CT, ...teamsSign(ASK, Buffer.alloc(0)) }, /bad signature/);
    } finally {
      await clearEnv("TEAMS_WEBHOOK_SECRET");
    }
  });

  it("with a secret: unsigned and wrongly signed are refused, signed starts a run", async () => {
    const { id } = await createHook("teams");
    await setEnv("TEAMS_WEBHOOK_SECRET", TEAMS_SECRET);
    try {
      await expectRefused(id, ASK, JSON_CT, /bad signature/);
      await expectRefused(id, ASK, { ...JSON_CT, ...teamsSign(ASK, Buffer.from("wrong")) }, /bad signature/);
      const res = await fireRaw(id, ASK, { ...JSON_CT, ...teamsSign(ASK) });
      expect(res.status).toBe(200);
      const run = (await listRuns()).find((r) => r.inputs?.input === "teams ask");
      expect(run.inputs.from).toBe("Dana");
    } finally {
      await clearEnv("TEAMS_WEBHOOK_SECRET");
    }
  });
});
