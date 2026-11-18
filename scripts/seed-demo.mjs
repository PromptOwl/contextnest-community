#!/usr/bin/env node
/**
 * Seed a demo nest so the new My Work and Review screens have something to show.
 *
 *   CN_API_KEY=<your key> CN_EMAIL=<your login email> node scripts/seed-demo.mjs [http://localhost:3838]
 *
 * Your key: Settings → API keys. The script makes ONE new nest, named
 * "Demo" ("Demo 2" if that is taken), owned by you. Nothing else is touched.
 *
 * What you get:
 *   - published docs in governed/ and tasks assigned to you across stages,
 *     some overdue, some done
 *   - a second identity, a named system ("Demo Agent"), that files nine changes for your
 *     review: two Grok signals, two Claude tasks, three new documents, and edits
 *     to two published docs (one by an agent, one by a person). Agent changes
 *     carry agent, session and listener
 *
 * The agent is a separate account because a person can't approve their own
 * change (separation of duties). It is a named system, which takes no billable seat.
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
        : "";
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 300)}${hint}`);
  }
  return data;
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// 1. Your nest, with published content (stewardship is still off)
// A short name, since deleting a nest means typing it back. "Demo", then "Demo 2"... if taken.
let nest;
for (let i = 1; i <= 30 && !nest; i++) {
  const name = i === 1 ? "Demo" : `Demo ${i}`;
  const { res, data } = await call("POST", "/nests", { name });
  if (res.ok) nest = data.nest;
  else if (!/already have a nest/i.test(JSON.stringify(data))) await must("POST", "/nests", { name }); // throws with the real reason
}
if (!nest) throw new Error("Demo, Demo 2 ... Demo 30 are all taken. Delete an old demo nest and run again.");
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
const northwind = await make({
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

// 2. A second identity to play the agent. A named system (a service identity)
// takes no billable seat, so this works on a plan with no spare editor seat,
// and it is still a different account from you, which separation of duties needs.
const sys = await must("POST", "/systems", { name: `Demo Agent ${nest.name}`, capability: "write", nest_ids: [nest.id] });
const agentKey = sys.api_key;
if (!agentKey) throw new Error(`No agent key: ${JSON.stringify(sys)}`);

// 3. Turn the review gate on, then let the agent file changes
// allow_self_approve: as the nest's owner you hold no steward role, and the review
// inbox only lists changes you are allowed to decide. The agent's changes still
// need you, because you never review your own.
await must("PATCH", `${N}/settings`, { stewardship_enabled: true, allow_self_approve: true });

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

// More document approvals: new pages, an edit by a person (no agent), and an
// urgent one, so the queue has a mix to sort and review.
const d2 = await make(
  {
    title: "Competitor profile: Tidewater",
    folder: "governed",
    type: "document",
    tags: ["#competitor"],
    content:
      "# Tidewater\n\n## Positioning\n\nSells compliance reporting to mid-size banks. Leads with dashboards, not audit trails.\n\n## Objection handling\n\nAsk what the dashboard shows when an agent changes a record at 2 a.m.\n",
    client: { agent: "claude", session_id: "s-31d8", listener },
  },
  agentKey,
);
await submit(d2.id, "New profile from this week's research. Dated facts are in signals.");

const d3 = await make(
  {
    title: "Why audit trails beat promises",
    folder: "open/content/blog",
    type: "document",
    tags: ["#content", "#stage:draft"],
    content:
      "# Why audit trails beat promises\n\nA vendor can promise an agent behaves. A log shows what it touched.\n\n## What to ask for\n\n1. Who changed the record\n2. Which agent, in which session\n3. Who approved it, and when\n",
    client: { agent: "claude", session_id: "s-31d8", listener },
  },
  agentKey,
);
await submit(d3.id, "First draft for the content calendar. Needs your voice pass.");

const d4 = await make(
  {
    title: "Partner pricing and referral terms",
    folder: "governed",
    type: "document",
    tags: ["#partner"],
    content:
      "# Partner pricing and referral terms\n\nReferral fee is paid on closed deals only. Wording is with legal and not final.\n",
    client: { agent: "grok", session_id: "s-77b0", listener },
  },
  agentKey,
);
await submit(d4.id, "Needed before Friday's partner call.", "urgent");

// A person's edit, not an agent's: no client block, so the pane shows who and when only.
await must(
  "PATCH",
  `${N}/nodes/${northwind.id}`,
  {
    content:
      "# Northwind Labs\n\nPositioning and objection handling live here. Dated facts go in signals.\n\n## Where they win\n\nStrong in regulated support teams. Weak on version history.\n",
  },
  agentKey,
);
await submit(northwind.id, "Added where they win, from the call notes.");

console.log(`
Done. Open ${BASE}, pick "${nest.name}", then go to My Work and the nest's Review tab.
Expect 9 changes waiting on you (5 documents, 2 tasks, 2 signals), 8 open tasks (two are the ones the agent filed) and 2 finished ones.
The agent is the named system "Demo Agent ${nest.name}" (it goes away with the nest's access).
`);
