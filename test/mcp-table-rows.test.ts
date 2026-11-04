/**
 * MCP `context_table_rows` — the agent twin of POST /nests/:id/nodes/:nodeId/rows
 * (CU-wdqcq06fjy). Same row ops, same governance, the caller's own permissions.
 *
 *  - write agent on a governed nest → a draft with only that row changed
 *  - reader → refused, nothing written
 *  - stale base_version → conflict carrying the current version, nothing written
 *  - bad value → VALIDATION_FAILED, nothing written
 *  - read-only key → refused, nothing written
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

// Pass-through: records what each review submission was given (its baseUrl
// builds the notification's "Open document" link).
const submitted: any[] = ((globalThis as any).__cnSubmitted ??= []);
vi.mock("../src/governance/review-service.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    submitForReview: (p: any) => {
      (globalThis as any).__cnSubmitted.push(p);
      return real.submitForReview(p);
    },
  };
});

type User = { apiKey: string; userId: string; email: string };

const T_CSV = "id:key,stage,amount:number\nr1,lead,10\nr2,won,20";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let editor: User;
let reader: User;
let nestId: string;
let tId: string;
let readOnlyKey: string;

async function call(apiKey: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_table_rows", arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const line = (await res.text()).split("\n").find((l: string) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : null;
  }
  if (body?.error) return { isError: true, text: String(body.error.message ?? ""), data: undefined as any };
  return {
    isError: body?.result?.isError === true,
    text: (body?.result?.content ?? []).map((c: any) => c.text).join(""),
    data: body?.result?.structuredContent,
  };
}

async function head() {
  const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${tId}`, undefined, owner.apiKey);
  return { content: (r.data.node.content as string).trimEnd(), version: r.data.node.version as number };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@mcprows.test", "Owner");
  editor = await registerUser(app, "editor@mcprows.test", "Editor");
  reader = await registerUser(app, "reader@mcprows.test", "Reader");
  await resetAuthRateLimit();
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "MCP Rows" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true, allow_self_approve: true }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: reader.email, permission: "read" }, owner.apiKey);
  const t = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Pipeline", type: "table", content: T_CSV }, owner.apiKey);
  tId = t.data.node.id;
  readOnlyKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, editor.apiKey)).data.api_key;
}, 60000);

afterAll(() => env.cleanup());

describe("context_table_rows", () => {
  it("a write agent's update lands as a draft with only that row changed, submitted for review", async () => {
    const before = await head();
    const r = await call(editor.apiKey, {
      table: tId,
      ops: [{ op: "update", key: "r1", set: { stage: "qualified" } }],
      submit_review: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ table: tId, state: "draft", applied: { appended: 0, updated: 1, deleted: 0 } });
    expect(r.data.version).toBeGreaterThan(before.version);
    expect(typeof r.data.review_id).toBe("string");
    // The review notification links back to this server, like every MCP write.
    expect(submitted.at(-1)?.baseUrl).toMatch(/^https?:\/\//);
    const after = await head();
    expect(after.content).toBe(before.content.replace("r1,lead,10", "r1,qualified,10"));
  });

  it("accepts the table by [[Title]] too", async () => {
    const r = await call(editor.apiKey, { table: "[[Pipeline]]", ops: [{ op: "update", key: "r1", set: { stage: "qualified" } }] });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.unchanged).toBe(true);
  });

  it("a reader is refused and nothing is written", async () => {
    const before = await head();
    const r = await call(reader.apiKey, { table: tId, ops: [{ op: "delete", key: "r2" }] });
    expect(r.isError).toBe(true);
    expect(r.data?.code).toBe("UNAUTHORIZED_ACTION");
    expect((await head()).version).toBe(before.version);
  });

  it("a stale base_version is a conflict carrying the current version", async () => {
    const before = await head();
    const r = await call(editor.apiKey, { table: tId, base_version: 1, ops: [{ op: "delete", key: "r2" }] });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ code: "VALIDATION_FAILED", conflict: true, current_version: before.version });
    expect((await head()).version).toBe(before.version);
  });

  it("a bad value is VALIDATION_FAILED and nothing is written", async () => {
    const before = await head();
    const r = await call(editor.apiKey, { table: tId, ops: [{ op: "update", key: "r2", set: { amount: "lots" } }] });
    expect(r.isError).toBe(true);
    expect(r.data?.code).toBe("VALIDATION_FAILED");
    expect((await head()).version).toBe(before.version);
  });

  it("someone else's unreviewed draft is a conflict with reason draft_in_progress", async () => {
    const t = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Drafted", type: "table", content: T_CSV }, owner.apiKey)).data.node.id;
    const other = await registerUser(app, "other@mcprows.test", "Other");
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: other.email, permission: "write" }, owner.apiKey);
    const d = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${t}`, { content: `${T_CSV}\nr7,secret,1` }, other.apiKey);
    expect(d.data.node.status).toBe("draft");
    const r = await call(editor.apiKey, { table: t, ops: [{ op: "update", key: "r1", set: { stage: "won" } }] });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ code: "VALIDATION_FAILED", conflict: true, reason: "draft_in_progress", current_version: d.data.node.version });
  });

  it("a missing table is DOCUMENT_NOT_FOUND, by id or [[Title]]", async () => {
    for (const table of ["nodes/no-such-table", "[[No Such Table]]"]) {
      const r = await call(editor.apiKey, { table, ops: [{ op: "delete", key: "r1" }] });
      expect(r.isError).toBe(true);
      expect(r.data?.code).toBe("DOCUMENT_NOT_FOUND");
    }
  });

  it("an empty table argument is VALIDATION_FAILED; a missing one fails the input schema", async () => {
    for (const table of ["", "  "]) {
      const r = await call(editor.apiKey, { table, ops: [{ op: "delete", key: "r1" }] });
      expect(r.isError).toBe(true);
      expect(r.data?.code).toBe("VALIDATION_FAILED");
    }
    const missing = await call(editor.apiKey, { ops: [{ op: "delete", key: "r1" }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/table/);
  });

  it("a read-only key is refused and nothing is written", async () => {
    const before = await head();
    const r = await call(readOnlyKey, { table: tId, ops: [{ op: "delete", key: "r2" }] });
    expect(r.isError).toBe(true);
    expect((await head()).version).toBe(before.version);
  });
});
