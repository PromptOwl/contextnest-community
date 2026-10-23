/**
 * Enforced structure rules on every way a document reaches a nest besides the
 * app's own create/update/move/folder routes (test/structure.test.ts): `ctx
 * push` (POST /nests/:id/publish), a push held for confirmation, the nest's MCP
 * tools, and an out-of-band edit approved from the app. Whatever the door, a
 * document that breaks a rule never lands, and the caller is told which rule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string };
let owner: { apiKey: string; userId: string; email: string };

const RULES = {
  structure: { enforce: true, closed: true },
  folders: {
    "clients/{client}": { folder_name: "/[a-z]+-[0-9]{3}/", types: ["document"] },
    "clients/{client}/meetings": { types: ["document"], file_name: "{date}-{slug}", template: "meeting-note" },
  },
  templates: { "meeting-note": { body: "## Decisions\n", required_sections: ["Decisions"] } },
};
const MEETINGS = "clients/acme-042/meetings";
const GOOD = { title: "2026-10-07 Kickoff", content: "## Decisions\nShip.\n", folder: MEETINGS };
/** One document per rule, each breaking only that rule. */
const BAD = [
  { title: "Kickoff", content: "## Decisions\nShip.\n", folder: MEETINGS, rule: /\{date\}-\{slug\}/ },
  { title: "2026-10-08 Sync", content: "Nothing decided.\n", folder: MEETINGS, rule: /Decisions/ },
  { title: "2026-10-09 Persona", content: "## Decisions\nx\n", folder: MEETINGS, type: "persona", rule: /persona/ },
  { title: "Notes", content: "x\n", folder: "misc", rule: /not an allowed folder/ },
  { title: "Overview", content: "x\n", folder: "clients/Acme", rule: /\[a-z\]\+-\[0-9\]\{3\}/ },
];

const vault = (nestId: string) => join(process.env.DATA_ROOT!, "nests", nestId);
const onDisk = (nestId: string, folder: string, slug: string) => existsSync(join(vault(nestId), "nodes", folder, `${slug}.md`));

async function enforcedNest(name: string): Promise<string> {
  const nestId = (await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey)).data.nest.id;
  const saved = await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, RULES, owner.apiKey);
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
  return nestId;
}

async function callTool(nestId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${owner.apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const raw = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return { isError: !!raw.result.isError, text: (raw.result.content || []).map((c: any) => c.text).join("") };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  owner = await registerUser(app, "owner@acme.com", "Owner");
});

afterAll(() => env.cleanup());

describe("enforced structure rules on every way in", () => {
  it("ctx push (POST /publish): each document that breaks a rule fails alone, naming the rule, and never lands", async () => {
    const nestId = await enforcedNest("Push");
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/publish`, { documents: [GOOD, ...BAD] }, owner.apiKey);
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data.node_ids).toEqual([`nodes/${MEETINGS}/2026-10-07-kickoff`]);
    expect(res.data.failed.map((f: { title: string }) => f.title)).toEqual(BAD.map((b) => b.title));
    for (const [i, bad] of BAD.entries()) expect(res.data.failed[i].error, bad.title).toMatch(bad.rule);
    expect(onDisk(nestId, MEETINGS, "kickoff")).toBe(false);
    expect(onDisk(nestId, MEETINGS, "2026-10-08-sync")).toBe(false);
    expect(onDisk(nestId, "misc", "notes")).toBe(false);
    expect(existsSync(join(vault(nestId), "nodes", "misc"))).toBe(false);
    expect(existsSync(join(vault(nestId), "nodes", "clients", "Acme"))).toBe(false);
  });

  it("a push held for confirmation is refused when sent if any document breaks a rule — a reviewer is never asked to confirm what cannot land", async () => {
    const nestId = await enforcedNest("Held push");
    const gate = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { require_push_confirmation: true }, root.apiKey);
    expect(gate.status, JSON.stringify(gate.data)).toBe(200);
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/publish`, { documents: [GOOD, BAD[0], BAD[3]] }, owner.apiKey);
    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.data.error).toMatch(/Kickoff/);
    expect(res.data.error).toMatch(/\{date\}-\{slug\}/);
    expect(res.data.error).toMatch(/Notes/);
    const pending = await jsonRequest(app, "GET", `/nests/${nestId}/pending-pushes`, undefined, owner.apiKey);
    expect(pending.status, JSON.stringify(pending.data)).toBe(200);
    expect(pending.data.pending_pushes).toEqual([]);
    // A push that keeps the rules is held as before.
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/publish`, { documents: [GOOD] }, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(202);
    const held = await jsonRequest(app, "GET", `/nests/${nestId}/pending-pushes`, undefined, owner.apiKey);
    expect(held.data.pending_pushes).toHaveLength(1);
  });

  it("the nest's MCP tools: create, update and move are refused with the rule", async () => {
    const nestId = await enforcedNest("MCP");
    for (const bad of BAD) {
      const { rule, ...args } = bad;
      const res = await callTool(nestId, "context_create", args);
      expect(res.isError, bad.title).toBe(true);
      expect(res.text, bad.title).toMatch(rule);
    }
    expect((await callTool(nestId, "context_create", GOOD)).isError).toBe(false);
    const id = `nodes/${MEETINGS}/2026-10-07-kickoff`;
    const update = await callTool(nestId, "context_update", { id, content: "Nothing decided.\n" });
    expect(update.isError).toBe(true);
    expect(update.text).toMatch(/Decisions/);
    const move = await callTool(nestId, "context_move", { id, folder: "misc" });
    expect(move.isError).toBe(true);
    expect(move.text).toMatch(/not an allowed folder/);
    expect(readFileSync(join(vault(nestId), `${id}.md`), "utf-8")).toMatch(/## Decisions/);
  });

  it("an out-of-band edit that drops a required section cannot be approved from the app", async () => {
    const nestId = await enforcedNest("Drift");
    const created = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, GOOD, owner.apiKey);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const id = created.data.node.id as string;
    const file = join(vault(nestId), `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf-8").replace("## Decisions\n", "Decided nothing.\n"));
    await jsonRequest(app, "POST", `/nests/${nestId}/external-edits/scan`, {}, owner.apiKey);
    const staged = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/external-edits`, undefined, owner.apiKey);
    expect(staged.data.pending, JSON.stringify(staged.data)).toBeTruthy();
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${id}/external-edits/${encodeURIComponent(staged.data.pending.suggestion_id)}/approve`,
      {},
      owner.apiKey,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.data.error).toMatch(/Decisions/);
    const head = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(JSON.stringify(head.data)).toMatch(/## Decisions/);
  });
});
