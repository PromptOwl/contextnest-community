/**
 * Metacognition agents can notify people (CU-wdqcq05rkq).
 *
 * The safety property under test is the one `comment` already keeps: a name
 * the model writes may have been echoed from a feed or an MCP result, so it
 * must never decide who is contacted. Recipients come only from the owner's
 * saved config (the tool's `to` is an enum of those keys), each is re-checked
 * as a current member at send time, sends are capped per run, and the text is
 * defanged with links limited to this nest's documents.
 *
 * The model (createTurn), the mail transport (nodemailer) and the connector
 * fan-out (dispatchEvent, so nothing hits the network) are the seams; the
 * routes, loop, tools, email rendering and message log are real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { parseConfig, CAPS } from "../src/metacognition/config.js";
import { toolsFor, defangNotice } from "../src/metacognition/tools.js";
import { ValidationError } from "../src/shared/errors.js";

const { sendMail, createTransport, dispatchSpy } = vi.hoisted(() => {
  const sendMail = vi.fn(async (_msg: any) => ({ messageId: "test" }));
  return {
    sendMail,
    createTransport: vi.fn(() => ({ sendMail, verify: async () => true, close: () => {} })),
    dispatchSpy: vi.fn(async (_ev: any) => {}),
  };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("../src/notify/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/dispatch.js")>("../src/notify/dispatch.js");
  // hasAnyConnector stays real (it reads the connectors table); the post is the spy.
  return { ...actual, dispatchEvent: dispatchSpy };
});

type Turn = { content: any[]; stop_reason: string; usage?: Record<string, number> };
let script: Turn[] = [];
let requests: any[] = [];

const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`,
  name,
  input,
});
const say = (text: string): Turn => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
const call = (...uses: any[]): Turn => ({ content: uses, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>("../src/metacognition/model.js");
    return {
      ...actual,
      createTurn: async (params: any) => {
        requests.push(JSON.parse(JSON.stringify(params.request)));
        return script.shift() ?? say("Nothing more to do.");
      },
    };
  });
});
afterAll(() => {
  vi.doUnmock("../src/metacognition/model.js");
});

const base = { persona: { name: "Archivist" } };

describe("notify config (parseConfig)", () => {
  it("is off by default, and max_per_run is clamped like the other caps", () => {
    expect(parseConfig(base).notify).toEqual({ recipients: [], channels: [], max_per_run: CAPS.max_notifications.default });
    expect(CAPS.max_notifications.default).toBe(3);
    expect(CAPS.max_notifications.max).toBe(10);
    const n = (max_per_run: unknown) =>
      parseConfig({ ...base, notify: { recipients: ["owner"], channels: ["email"], max_per_run } }).notify.max_per_run;
    expect(n(99)).toBe(10);
    expect(n(0)).toBe(1);
    expect(n(undefined)).toBe(3);
  });

  it("accepts owner, reviewers and member emails (deduped, lower-cased)", () => {
    const c = parseConfig(
      { ...base, notify: { recipients: ["owner", "Alice@Acme.com", "alice@acme.com", "reviewers"], channels: ["email", "connectors", "email"] } },
      { members: new Set(["alice@acme.com"]) },
    );
    expect(c.notify).toEqual({ recipients: ["owner", "alice@acme.com", "reviewers"], channels: ["email", "connectors"], max_per_run: 3 });
  });

  it("refuses a malformed recipient", () => {
    for (const bad of ["not an email", "<b>@x.com", "everyone", "", 42, "a@b"]) {
      expect(() => parseConfig({ ...base, notify: { recipients: [bad], channels: ["email"] } })).toThrow(ValidationError);
    }
  });

  it("refuses a recipient who is not a member of the nest", () => {
    expect(() =>
      parseConfig(
        { ...base, notify: { recipients: ["eve@evil.com"], channels: ["email"] } },
        { members: new Set(["alice@acme.com"]) },
      ),
    ).toThrow(ValidationError);
  });

  it("needs a way to reach them, and only known channels", () => {
    expect(() => parseConfig({ ...base, notify: { recipients: ["owner"], channels: [] } })).toThrow(ValidationError);
    expect(() => parseConfig({ ...base, notify: { recipients: ["owner"], channels: ["sms"] } })).toThrow(ValidationError);
    // No recipients = off, whatever channels say.
    expect(parseConfig({ ...base, notify: { recipients: [], channels: ["email"] } }).notify.recipients).toEqual([]);
  });
});

describe("the notify tool", () => {
  const agentWith = (notify?: unknown) => ({ config: parseConfig({ ...base, ...(notify ? { notify } : {}) }) }) as any;

  it("is not offered when notify isn't configured", () => {
    expect(toolsFor(agentWith()).map((t) => t.name)).not.toContain("notify");
  });

  it("is offered with `to` as an enum of exactly the configured recipients", () => {
    const tools = toolsFor(agentWith({ recipients: ["owner", "alice@acme.com"], channels: ["email"] }));
    const notify = tools.find((t) => t.name === "notify");
    expect(notify).toBeTruthy();
    const to = (notify!.input_schema as any).properties.to;
    expect(to.enum).toEqual(["owner", "alice@acme.com"]);
    expect((notify!.input_schema as any).additionalProperties).toBe(false);
  });
});

describe("defangNotice", () => {
  const own = "https://nest.example.com/?nest=n1";
  it("drops markup and breaks links that aren't this nest's documents", () => {
    const out = defangNotice(
      'Hi <script>alert(1)</script><b>bold</b> <!channel> see [docs](https://evil.example/phish) or https://evil.example/x and www.evil.example',
      own,
    );
    expect(out).not.toMatch(/<script|<b>|<!channel>/i);
    expect(out).not.toContain("https://evil.example");
    expect(out).not.toContain("www.evil.example");
    expect(out).toContain("evil[.]example");
  });

  it("with no base URL nothing is a link; scripts, data URIs and Slack controls are neutralised", () => {
    const out = defangNotice("go https://nest.example.com/?nest=n1 <@U123> <#C1> javascript:alert(1) data:text/html,x", "");
    expect(out).not.toContain("https://");
    expect(out).not.toMatch(/<@U123>|<#C1>/);
    expect(out).not.toMatch(/javascript:|data:/i);
  });

  it("an own link followed by punctuation stays a link", () => {
    const link = "https://nest.example.com/?nest=n1&doc=nodes%2Fa";
    expect(defangNotice(`(see ${link}).`, own)).toContain(link);
  });

  it("keeps a link to this nest's own documents", () => {
    const link = "https://nest.example.com/?nest=n1&doc=nodes%2Fgtm%2Fpricing";
    expect(defangNotice(`Look: ${link}`, own)).toContain(link);
    // Another nest on the same server is not "this nest".
    expect(defangNotice("https://nest.example.com/?nest=n2&doc=x", own)).not.toContain("https://nest.example.com");
  });
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string; userId: string };
let alice: { apiKey: string; email: string; userId: string };
let rita: { apiKey: string; email: string; userId: string };
let nestId: string;

const AGENT = "nodes/archivist";

async function waitForRun(runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    if (r.data?.run?.status && r.data.run.status !== "running") return r.data;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never finished`);
}

async function configure(notify?: unknown) {
  return jsonRequest(
    app,
    "PUT",
    `/nests/${nestId}/metacognition/${AGENT}`,
    {
      persona: { name: "Archivist", avatar: "🦉" },
      scope: { read: ["gtm"], propose: [] },
      caps: { max_steps: 8, max_seconds: 60 },
      ...(notify ? { notify } : {}),
    },
    owner.apiKey,
  );
}

async function run(turns: Turn[]) {
  requests = [];
  script = turns;
  sendMail.mockClear();
  dispatchSpy.mockClear();
  const start = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/${AGENT}/run`, {}, owner.apiKey);
  expect(start.status).toBe(202);
  return waitForRun(start.data.run_id);
}

/** The agent's mail only — inviting collaborators sends mail too. */
const agentMail = () => sendMail.mock.calls.map((c) => c[0] as any).filter((m) => /\(agent\)/.test(String(m.subject)));
const notifySteps = (done: any) => done.steps.filter((s: any) => s.action === "notify" && s.detail?.tool === "notify");

async function outboundRows(runId: string) {
  const { getDb } = await import("../src/db/client.js");
  return (await getDb().all("SELECT * FROM outbound_messages WHERE run_id = ? ORDER BY created_at", [runId])) as any[];
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
  process.env.PUBLIC_BASE_URL = "https://nest.example.com";
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.MSTEAMS_WEBHOOK_URL;
  env = setupTestEnv();
  app = await createTestApp("key", {
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  await resetAuthRateLimit();
  rita = await registerUser(app, "rita@acme.com", "Rita");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Notify Nest" }, owner.apiKey);
  nestId = nest.data.nest.id;
  for (const [email, permission] of [
    [alice.email, "write"],
    [rita.email, "read"],
  ] as const) {
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email, permission }, owner.apiKey);
  }
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Archivist", content: "Tell people about stale pricing.", type: "agent" }, owner.apiKey);
  const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Pricing", content: "# Pricing\n\n$8 per seat.", folder: "gtm" }, owner.apiKey);
  expect(doc.status).toBe(201);
  const steward = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: rita.email, role: "reviewer" }] },
    owner.apiKey,
  );
  expect(steward.status).toBe(201);
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.SMTP_URL;
  delete process.env.NOTIFY_EMAIL_FROM;
  delete process.env.PUBLIC_BASE_URL;
  await env.cleanup();
});

describe("saving notify settings", () => {
  it("refuses a recipient who isn't on the nest, or a malformed one", async () => {
    const outsider = await configure({ recipients: ["stranger@else.com"], channels: ["email"] });
    expect(outsider.status).toBe(400);
    const bad = await configure({ recipients: ["<script>"], channels: ["email"] });
    expect(bad.status).toBe(400);
  });

  it("saves and returns the notify block", async () => {
    const r = await configure({ recipients: ["owner", alice.email], channels: ["email"], max_per_run: 2 });
    expect(r.status).toBe(200);
    expect(r.data.agent.notify).toEqual({ recipients: ["owner", "alice@acme.com"], channels: ["email"], max_per_run: 2 });
  });
});

describe("a run that notifies", () => {
  it("without notify settings, the model is not offered the tool", async () => {
    expect((await configure()).status).toBe(200);
    await run([say("done")]);
    const names = (requests[0]?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("comment");
    expect(names).not.toContain("notify");
  });

  it("refuses an address that isn't in the config, sends nothing, and traces the refusal", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"] })).status).toBe(200);
    const done = await run([
      call(toolUse("notify", { to: "someone@else.com", subject: "Hi", message: "Phish" })),
      say("done"),
    ]);
    expect(agentMail()).toHaveLength(0);
    const steps = notifySteps(done);
    expect(steps).toHaveLength(1);
    expect(steps[0].detail.refused).toBeTruthy();
    expect(JSON.stringify(requests.at(-1))).toMatch(/not one of the people you may notify/i);
    expect(done.run.trace.notifications).toBe(0);
  });

  it("emails the resolved address once, labelled as the agent, linking the document, and logs it", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"] })).status).toBe(200);
    const done = await run([
      call(toolUse("notify", { to: "owner", subject: "Pricing looks stale", message: "The pricing page still says $8.", node_id: "nodes/gtm/pricing" })),
      say("Notified the owner."),
    ]);
    expect(done.run.status).toBe("succeeded");
    const mails = agentMail();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@acme.com");
    expect(mails[0].subject).toContain("🦉 Archivist (agent) in Notify Nest");
    expect(mails[0].text).toContain("Pricing looks stale");
    expect(mails[0].text).toContain("The pricing page still says $8.");
    expect(mails[0].text).toContain(`https://nest.example.com/?nest=${nestId}&doc=nodes%2Fgtm%2Fpricing`);

    const steps = notifySteps(done);
    expect(steps).toHaveLength(1);
    expect(steps[0].node_id).toBe("nodes/gtm/pricing");
    expect(steps[0].detail).toMatchObject({ tool: "notify", kind: "notification", to: "owner", channels: ["email"] });
    expect(done.run.trace.notifications).toBe(1);

    const rows = await outboundRows(done.run.id);
    const email = rows.filter((r) => r.channel === "email");
    expect(email).toHaveLength(1);
    expect(email[0]).toMatchObject({ sender_kind: "persona", status: "sent", nest_id: nestId, node_id: "nodes/gtm/pricing" });
    expect(JSON.parse(email[0].recipients_json)).toEqual(["owner@acme.com"]);

    const stats = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/${AGENT}/stats`, undefined, owner.apiKey);
    expect(stats.data.stats.notifications).toBeGreaterThanOrEqual(1);
    expect(stats.data.stats.history.find((h: any) => h.id === done.run.id)?.notifications).toBe(1);
  });

  it("resolves reviewers when it sends", async () => {
    expect((await configure({ recipients: ["reviewers"], channels: ["email"] })).status).toBe(200);
    await run([call(toolUse("notify", { to: "reviewers", subject: "Please look", message: "Two proposals are waiting." })), say("ok")]);
    const mails = agentMail();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("rita@acme.com");
  });

  it("several reviewers get one send, Bcc'd so no one sees the others", async () => {
    await resetAuthRateLimit();
    await registerUser(app, "rex@acme.com", "Rex");
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "rex@acme.com", permission: "read" }, owner.apiKey);
    const add = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: "rex@acme.com", role: "reviewer" }] },
      owner.apiKey,
    );
    expect(add.status).toBe(201);
    expect((await configure({ recipients: ["reviewers"], channels: ["email"] })).status).toBe(200);
    await run([call(toolUse("notify", { to: "reviewers", subject: "Please look", message: "Waiting." })), say("ok")]);
    const mails = agentMail();
    expect(mails).toHaveLength(1);
    expect([...mails[0].bcc].sort()).toEqual(["rex@acme.com", "rita@acme.com"]);
    expect(mails[0].to).toBe("nest@test.local");
  });

  it("a notify while notify is off is refused and traced", async () => {
    expect((await configure()).status).toBe(200);
    const done = await run([call(toolUse("notify", { to: "owner", subject: "x", message: "y" })), say("ok")]);
    expect(agentMail()).toHaveLength(0);
    expect(notifySteps(done)[0]?.detail.refused).toBe("not_configured");
  });

  it("won't link a document outside its read scope", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"] })).status).toBe(200);
    const done = await run([
      call(toolUse("notify", { to: "owner", subject: "x", message: "y", node_id: "nodes/private/secret" })),
      say("ok"),
    ]);
    expect(agentMail()).toHaveLength(0);
    expect(done.steps.some((s: any) => s.detail?.kind === "access_needed" && s.detail?.tool === "notify")).toBe(true);
    expect(done.run.trace.notifications).toBe(0);
  });

  it("an email that fails to send is not counted or reported as sent", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"] })).status).toBe(200);
    sendMail.mockClear();
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    requests = [];
    script = [call(toolUse("notify", { to: "owner", subject: "Will fail (agent)", message: "y" })), say("ok")];
    dispatchSpy.mockClear();
    const start = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/${AGENT}/run`, {}, owner.apiKey);
    const done = await waitForRun(start.data.run_id);
    expect(done.run.trace.notifications).toBe(0);
    expect(notifySteps(done)[0]?.detail.refused).toBe("delivery_failed");
    expect(JSON.stringify(requests.at(-1))).toMatch(/could not be delivered/i);
    const rows = await outboundRows(done.run.id);
    expect(rows.filter((r) => r.channel === "email" && r.status === "failed")).toHaveLength(1);
  });

  it("stops at its daily ceiling across runs (METACOGNITION_NOTIFY_PER_DAY)", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"], max_per_run: 5 })).status).toBe(200);
    process.env.METACOGNITION_NOTIFY_PER_DAY = "1";
    try {
      // Earlier runs in this file already sent today, so even the first is over the ceiling.
      const done = await run([call(toolUse("notify", { to: "owner", subject: "a", message: "b" })), say("ok")]);
      expect(agentMail()).toHaveLength(0);
      expect(notifySteps(done)[0]?.detail.refused).toBe("daily_cap");
      expect(JSON.stringify(requests.at(-1))).toMatch(/in the last 24 hours/);
    } finally {
      delete process.env.METACOGNITION_NOTIFY_PER_DAY;
    }
  });

  it("the daily ceiling counts when a notification was sent, not when its run started", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"], max_per_run: 5 })).status).toBe(200);
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const row = (await db.get(
      `SELECT COUNT(*) AS n FROM run_steps s JOIN runs r ON r.id = s.run_id
        WHERE r.nest_id = ? AND r.agent_node = ? AND s.at >= ? AND s.action = 'notify' AND s.detail LIKE '%"kind":"notification"%'`,
      [nestId, AGENT, since],
    )) as { n: number };
    // A long run that started two days ago and notified a minute ago.
    const old = `run_old_${Date.now()}`;
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await db.run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, depth) VALUES (?, ?, ?, 'test', 'succeeded', ?, 0)`,
      [old, nestId, AGENT, twoDaysAgo],
    );
    await db.run(
      `INSERT INTO run_steps (run_id, seq, action, detail, at) VALUES (?, 1, 'notify', ?, ?)`,
      [old, JSON.stringify({ tool: "notify", kind: "notification", to: "owner" }), new Date(Date.now() - 60_000).toISOString()],
    );
    process.env.METACOGNITION_NOTIFY_PER_DAY = String(Number(row.n) + 1);
    try {
      const done = await run([call(toolUse("notify", { to: "owner", subject: "a", message: "b" })), say("ok")]);
      expect(notifySteps(done)[0]?.detail.refused).toBe("daily_cap");
    } finally {
      delete process.env.METACOGNITION_NOTIFY_PER_DAY;
    }
  });

  it("stops at max_per_run: the third call of a 2-per-run agent is refused", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"], max_per_run: 2 })).status).toBe(200);
    const n = (i: number) => toolUse("notify", { to: "owner", subject: `Note ${i}`, message: `Message ${i}` });
    const done = await run([call(n(1)), call(n(2)), call(n(3)), say("done")]);
    expect(agentMail()).toHaveLength(2);
    expect(done.run.trace.notifications).toBe(2);
    expect(JSON.stringify(requests.at(-1))).toMatch(/used this run's 2 notifications/);
  });

  it("defangs markup and outside links in what it sends", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["email"] })).status).toBe(200);
    await run([
      call(
        toolUse("notify", {
          to: "owner",
          subject: "Urgent <b>action</b>\r\nBcc: x@evil.example",
          message: 'Reset here: <a href="https://evil.example/login">login</a> or https://evil.example/reset',
        }),
      ),
      say("ok"),
    ]);
    const [mail] = agentMail();
    expect(mail).toBeTruthy();
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).not.toContain("<b>");
    expect(mail.text).not.toContain("https://evil.example");
    expect(mail.html).not.toContain("https://evil.example");
    expect(mail.text).toContain("evil[.]example");
  });

  it("refuses a configured member who has since lost access, and traces it", async () => {
    expect((await configure({ recipients: [alice.email], channels: ["email"] })).status).toBe(200);
    const collabs = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, owner.apiKey);
    const row = collabs.data.collaborators.find((c: any) => String(c.email).toLowerCase() === alice.email);
    expect(row).toBeTruthy();
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/collaborators/${row.id}`, undefined, owner.apiKey);
    expect(del.status).toBe(200);

    const done = await run([call(toolUse("notify", { to: alice.email, subject: "Hi", message: "Hello" })), say("ok")]);
    expect(agentMail()).toHaveLength(0);
    const steps = notifySteps(done);
    expect(steps).toHaveLength(1);
    expect(steps[0].detail.refused).toBeTruthy();
    expect(JSON.stringify(requests.at(-1))).toMatch(/no longer/i);
    expect(done.run.trace.notifications).toBe(0);
  });

  it("never goes to the server-wide Slack/Teams webhook: only a nest's own connectors", async () => {
    const { hasAnyConnector } = await import("../src/notify/dispatch.js");
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T0/B0/server";
    try {
      // This nest has no connector rows yet.
      expect(await hasAnyConnector(nestId, "agent_notify")).toBe(false);
      expect(await hasAnyConnector(nestId, "run_failed")).toBe(true);
    } finally {
      delete process.env.SLACK_WEBHOOK_URL;
    }
  });

  it("posts an agent_notify event to the nest's connectors", async () => {
    const con = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/connectors`,
      { channel: "slack", url: "https://hooks.slack.com/services/T0/B0/x", events: ["agent_notify"] },
      owner.apiKey,
    );
    expect(con.status).toBe(201);
    expect((await configure({ recipients: ["owner"], channels: ["connectors"] })).status).toBe(200);
    const done = await run([
      call(toolUse("notify", { to: "owner", subject: "Stale pricing", message: "See the pricing page.", node_id: "nodes/gtm/pricing" })),
      say("ok"),
    ]);
    expect(agentMail()).toHaveLength(0);
    const evs = dispatchSpy.mock.calls.map((c) => c[0]).filter((e: any) => e.kind === "agent_notify");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ nestId, subjectId: "nodes/gtm/pricing", runId: done.run.id });
    expect(evs[0].message).toContain("Archivist (agent)");
    expect(evs[0].message).toContain("Stale pricing");
    expect(done.run.trace.notifications).toBe(1);
  });

  it("strips chat markup from the subject it posts to a channel", async () => {
    expect((await configure({ recipients: ["owner"], channels: ["connectors"] })).status).toBe(200);
    const done = await run([call(toolUse("notify", { to: "owner", subject: "*bold* _it_ ~x~ `code`", message: "m" })), say("ok")]);
    const ev = dispatchSpy.mock.calls.map((c) => c[0] as any).find((e) => e.kind === "agent_notify");
    expect(ev).toBeTruthy();
    expect(ev.message).toContain("*bold it x code*");
    expect(done.run.trace.notifications).toBe(1);
    expect(notifySteps(done)[0].detail.channels).toEqual(["connectors"]);
  });

  it("doesn't post to a channel when the document isn't open to everyone on the nest", async () => {
    // A guest who holds a share grant on one other document is on the roster
    // but can't open the pricing page: the room may hold people like them.
    await resetAuthRateLimit();
    await registerUser(app, "guest@acme.com", "Guest");
    const other = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Open Doc", content: "# Open", folder: "gtm" }, owner.apiKey);
    const g = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: other.data.node.id, email: "guest@acme.com", role: "read" },
      owner.apiKey,
    );
    expect(g.status).toBe(201);
    expect((await configure({ recipients: ["owner"], channels: ["email", "connectors"] })).status).toBe(200);
    const done = await run([
      call(toolUse("notify", { to: "owner", subject: "Restricted", message: "About pricing.", node_id: "nodes/gtm/pricing" })),
      say("ok"),
    ]);
    expect(dispatchSpy.mock.calls.filter((c) => (c[0] as any).kind === "agent_notify")).toHaveLength(0);
    expect(agentMail()).toHaveLength(1);
    const step = notifySteps(done)[0];
    expect(step.detail.channels).toEqual(["email"]);
    expect(step.detail.skipped_channels).toEqual(["connectors"]);
  });
});
