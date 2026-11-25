/** One chat 8 (PO-1539): GET /me/chat/agents. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any, misha: any, ed: any, sal: any, nest: string;
const post = (u: any, channel: string, body: string, agent?: string, thread?: string) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/nodes/channels/${channel}/annotations${thread ? `/${thread}/comments` : ""}`, { body, ...(agent ? { client: { agent } } : {}) }, u.apiKey);
const mine = async (u: any) => (await jsonRequest(app, "GET", "/me/chat/agents", undefined, u.apiKey)).data;

beforeAll(async () => {
  env = setupTestEnv();
  process.env.TEAM_CHAT_ENABLED = "true";
  app = await createTestApp("key");
  misha = await registerUser(app, "misha-a@acme.com");
  ed = await registerUser(app, "ed-a@acme.com");
  await resetAuthRateLimit();
  sal = await registerUser(app, "sal-a@acme.com");
  nest = (await jsonRequest(app, "POST", "/nests", { name: "Fernhill" }, misha.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nest}/collaborators`, { email: ed.email, permission: "write" }, misha.apiKey);
  for (const name of ["general", "leads"]) await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name }, misha.apiKey);
  await jsonRequest(app, "POST", `/nests/${nest}/channels/leads/private`, { private: true }, misha.apiKey);
});
afterAll(() => {
  delete process.env.TEAM_CHAT_ENABLED;
  return env.cleanup();
});

describe("my agents", () => {
  it("EX-1 lists the agents that wrote under my login, with the nest", async () => {
    const r = await post(misha, "general", "Tiers conflict", "grok");
    expect(r.status).toBeLessThan(300);
    const m = await mine(misha);
    expect(m.agents.map((a: any) => a.handle)).toContain("grok");
    expect(m.threads).toHaveLength(1);
    expect(m.threads[0]).toMatchObject({ nest_name: "Fernhill", channel: "general", kind: "channel", answered: false });
  });
  it("EX-3 a reply by someone else marks the thread answered", async () => {
    const t = (await mine(misha)).threads[0].thread_id;
    const r = await post(ed, "general", "Use Priya", undefined, t);
    expect(r.status).toBeLessThan(300);
    expect((await mine(misha)).threads[0].answered).toBe(true);
  });
  it("EX-14 an agent name someone else declares is theirs, not mine", async () => {
    await post(ed, "general", "from Ed's grok", "grok");
    expect((await mine(misha)).threads).toHaveLength(1);
    expect((await mine(ed)).threads[0].excerpt).toBe("from Ed's grok");
  });
  it("EX-12 nobody else sees my agents", async () => {
    expect(JSON.stringify(await mine(sal))).toBe(JSON.stringify({ agents: [], threads: [] }));
    expect(JSON.stringify(await mine(ed))).not.toContain("Tiers conflict");
  });
  it("EX-13 a private channel or a nest I lost takes its rows with it", async () => {
    const add = await jsonRequest(app, "POST", `/nests/${nest}/channels/leads/members`, { member: ed.email }, misha.apiKey);
    expect(add.status).toBeLessThan(300);
    await post(ed, "leads", "secret from Ed's claude", "claude");
    expect(JSON.stringify(await mine(ed))).toContain("secret from Ed's claude");
    await jsonRequest(app, "POST", `/nests/${nest}/channels/leads/leave`, {}, ed.apiKey);
    expect(JSON.stringify(await mine(ed))).not.toContain("secret");
    const people = (await jsonRequest(app, "GET", `/nests/${nest}/collaborators`, undefined, misha.apiKey)).data;
    const row = (people.collaborators ?? people).find((c: any) => c.email === ed.email || c.user_email === ed.email);
    expect((await jsonRequest(app, "DELETE", `/nests/${nest}/collaborators/${row.id}`, undefined, misha.apiKey)).status).toBeLessThan(300);
    const left = await mine(ed);
    const still = await jsonRequest(app, "GET", `/nests/${nest}/channels`, undefined, ed.apiKey);
    if (still.status >= 400) expect(left.threads).toEqual([]);
    expect(still.status).toBeGreaterThanOrEqual(400);
  });
});
