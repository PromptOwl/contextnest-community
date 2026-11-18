#!/usr/bin/env node
/**
 * Seed a demo nest so the new My Work and Review screens have something to show.
 *
 *   CN_API_KEY=<your key> CN_EMAIL=<your login email> node scripts/seed-demo.mjs [http://localhost:3838]
 *
 * Your key: Settings → API keys. The script makes ONE new nest, "Demo Ops
 * (POGOSA) <time>", owned by you. Nothing else is touched. Running it twice
 * makes a second nest, so delete the old one in the UI.
 *
 * What you get:
 *   - published docs in governed/ and tasks assigned to you across stages,
 *     some overdue, some done
 *   - a second user, demo-agent@example.com, who files five changes for your
 *     review: two Grok signals, two Claude tasks (one short, one without a listener) and an
 *     edit to a published doc, each carrying agent, session and listener
 *
 * The agent is a real second account because a person can't approve their own
 * change (separation of duties).
 */
const BASE = (process.argv[2] || "http://localhost:3838").replace(/\/$/, "");
const KEY = process.env.CN_API_KEY;
if (!KEY) {
  console.error("Set CN_API_KEY to an API key from Settings → API keys, then run again.");
  process.exit(1);
}
const ME = process.env.CN_EMAIL;
if (!ME) {
  console.error("Set CN_EMAIL to the email you sign in with (the tasks are assigned to it), then run again.");
  process.exit(1);
}
const AGENT_EMAIL = process.env.CN_AGENT_EMAIL || "demo-agent@example.com";
const AGENT_PASSWORD = process.env.CN_AGENT_PASSWORD || "demo-agent-pass-1";

async function call(method, path, body, key = KEY, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Billing": "true",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { res, data };
}
async function must(method, path, body, key) {
  const { res, data } = await call(method, path, body, key);
  if (!res.ok) {
    const hint =
      res.status === 403 && path === "/nests"
        ? " (Only server admins can create nests: use an admin's key, or set NEST_CREATION=everyone.)"
        : res.status === 402
          ? " (This server's plan has no seat for a second editor. The demo agent needs one to file changes.)"
          : "";
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 300)}${hint}`);
  }
  return data;
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// 1. Your nest, with published content (stewardship is still off)
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
const nest = (await must("POST", "/nests", { name: `Demo Ops (POGOSA) ${stamp}` })).nest;
const N = `/nests/${nest.id}`;
const me = ME;
console.log(`Created nest ${nest.name}`);

const make = (body, key) => must("POST", `${N}/nodes`, body, key).then((d) => d.node);

const playbook = await make({
  title: "Objection handling playbook",
  folder: "governed",
  type: "document",
  tags: ["#playbook"],
  content: "# Objection handling\n\nLead with the audit trail. Every change is versioned and attributable.\n",
});
await make({
  title: "Competitor profile: Northwind Labs",
  folder: "governed",
  type: "document",
  content: "# Northwind Labs\n\nPositioning and objection handling live here. Dated facts go in signals.\n",
});

const tasks = [
  ["Schedule intro call with Tidewater", "stage:doing", day(-2), "urgent"],
  ["Send Northwind outreach touch two", "stage:doing", day(1), "high"],
  ["Confirm Brightline registration", "stage:backlog", day(2), "medium"],
  ["Update outreach log with last week's replies", "stage:backlog", day(3), "low"],
  ["Finalize referral fee wording with legal", "stage:review", day(6), "high"],
  ["Record partner demo walkthrough", "stage:backlog", day(10), "medium"],
  ["Publish the weekly sync", "stage:done", day(-3), "medium"],
  ["Archive the October campaign board", "stage:done", day(-8), "low"],
];
for (const [title, stage, due, priority] of tasks) {
  await make({
    title,
    folder: "projects/tasks",
    type: "task",
    tags: ["#task", `#${stage}`, "#owner-stacey"],
    assignee: me,
    due,
    priority,
    content: stage === "stage:done" ? "Done.\n" : `Owner: ${me}.\n`,
  });
}
console.log(`Published ${2 + tasks.length} nodes`);

// 2. A second user to play the agent
let agentKey;
{
  let { res, data } = await call("POST", "/auth/register", { email: AGENT_EMAIL, password: AGENT_PASSWORD, name: "Demo Agent" }, null);
  if (!res.ok) ({ res, data } = await call("POST", "/auth/login", { email: AGENT_EMAIL, password: AGENT_PASSWORD }, null));
  if (!res.ok) throw new Error(`Could not register or sign in ${AGENT_EMAIL}: ${JSON.stringify(data)}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const k = await call("POST", "/auth/keys", { label: "demo seed" }, null, { Cookie: cookie });
  agentKey = k.data.api_key;
  if (!agentKey) throw new Error(`No agent key: ${JSON.stringify(k.data)}`);
}
await must("POST", `${N}/collaborators`, { email: AGENT_EMAIL, permission: "write" });

// 3. Turn the review gate on, then let the agent file changes
await must("PATCH", `${N}/settings`, { stewardship_enabled: true });

const listener = "Northwind Labs Support workspace";
const submit = (nodeId, note, priority = "normal") =>
  must("POST", `${N}/nodes/${nodeId}/submit-review`, { note, priority }, agentKey);

const s1 = await make(
  {
    title: "State complaint over agents in uninvited systems",
    folder: "signals",
    type: "document",
    tags: ["#signal", "#watch"],
    content:
      "# A state attorney general is suing over agents that entered systems they were not invited into\n\nThe complaint says a pre-release model entered systems at two research labs. These are allegations so far.\n\n**For us:** A regulator is now asking what an agent touched, not what a vendor promised. That is the audit-trail argument, made by someone other than us.\n",
    client: { agent: "grok", session_id: "s-4c1e", listener },
  },
  agentKey,
);
await submit(s1.id, "From this morning's sweep. Filed as a watch signal, not an ask.");

const t1 = await make(
  {
    title: "Draft Summit Ridge co-marketing one-pager",
    folder: "projects/tasks",
    type: "task",
    tags: ["#task", "#stage:backlog", "#agent-claude"],
    assignee: me,
    due: day(5),
    priority: "high",
    content: "Draft a one-page co-marketing outline for Summit Ridge.\n\n- Who it is for\n- What each side brings\n- Next step\n",
    client: { agent: "claude", session_id: "s-9f2a", listener },
  },
  agentKey,
);
await submit(t1.id, "Filed from the standup notes.", "high");

// A one-line task with no listener: a short body, so the task card does the work.
const t2 = await make(
  {
    title: "Quarterly partner health check",
    folder: "projects/tasks",
    type: "task",
    tags: ["#task", "#stage:backlog", "#agent-claude"],
    assignee: me,
    due: day(12),
    priority: "medium",
    content: "Recurring check.\n",
    client: { agent: "claude", session_id: "s-9f2a" },
  },
  agentKey,
);
await submit(t2.id, "Recurring item from the weekly sync.");

// An edit to a published doc: shows the Changes tab and the live version.
await must(
  "PATCH",
  `${N}/nodes/${playbook.id}`,
  {
    content:
      "# Objection handling\n\nLead with the audit trail. Every change is versioned and attributable.\n\n## Security and governance\n\nLead with steward approval. Show the version history before anything else.\n",
    client: { agent: "grok", session_id: "s-77b0", listener },
  },
  agentKey,
);
await submit(playbook.id, "Adds the governance talk track to the playbook.");

const d1 = await make(
  {
    title: "Agents fail by silent drift, not errors",
    folder: "signals",
    type: "document",
    tags: ["#signal", "#watch"],
    content: "# Agents fail by silent drift, not errors\n\nA write-up argues the costly failures are quiet ones. Worth a look for the monitoring story.\n",
    client: { agent: "grok", session_id: "s-4c1e", listener },
  },
  agentKey,
);
await submit(d1.id, "Second signal from the same sweep.");

console.log(`
Done. Open ${BASE}, pick "${nest.name}", then go to My Work and the nest's Review tab.
Expect 5 changes waiting on you, 6 open tasks and 2 finished ones.
Agent login for the other side: ${AGENT_EMAIL} / ${AGENT_PASSWORD}
`);
