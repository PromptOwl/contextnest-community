/**
 * Custom field values under stewardship: a caller limited to approved content
 * (approved_only / a public reader, or an agent over MCP) gets the APPROVED
 * version's values and filters on them — never an unapproved draft's.
 * Also: a concurrent create of the same key is a 409, not a 500.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string };
let nestId: string;

let rpc = 1;
async function mcp(name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${owner.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : null;
  }
  const result = body.result;
  return {
    text: (result?.content ?? []).map((c: any) => c.text).join(""),
    data: result?.structuredContent,
    isError: !!result?.isError,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@fields-approved.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Governed fields" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app, "POST", `/nests/${nestId}/fields`,
    { key: "severity", label: "Severity", type: "select", options: ["low", "high"], applies_to: ["*"] },
    owner.apiKey,
  );
  // Stewardship off: v1 auto-approves with severity low.
  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Guide", content: "# Guide\n\nApproved text.", fields: { severity: "low" } }, owner.apiKey,
  );
  // Stewardship on: the value change to high is an unapproved draft.
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
  await jsonRequest(
    app, "PATCH", `/nests/${nestId}/nodes/nodes/guide`, { fields: { severity: "high" } }, owner.apiKey,
  );
}, 30000);

afterAll(() => env.cleanup());

const get = (q = "") =>
  jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/guide${q}`, undefined, owner.apiKey);
const listIds = async (q: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes${q}`, undefined, owner.apiKey)).data.nodes.map(
    (n: any) => n.id,
  );

describe("REST approved-only reads @unit", () => {
  it("the owner reads the draft's value normally", async () => {
    expect((await get()).data.node.fields).toEqual({ severity: "high" });
  });

  it("approved_only serves the approved version's value", async () => {
    expect((await get("?approved_only=1")).data.node.fields).toEqual({ severity: "low" });
  });

  it("the approved-only list carries and filters on approved values", async () => {
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes?approved_only=1`, undefined, owner.apiKey,
    );
    expect(data.nodes.find((n: any) => n.id === "nodes/guide").fields).toEqual({ severity: "low" });
    expect(await listIds("?approved_only=1&field.severity=low")).toContain("nodes/guide");
    expect(await listIds("?approved_only=1&field.severity=high")).not.toContain("nodes/guide");
  });
});

describe("MCP under stewardship @unit", () => {
  it("context_get shows the approved value, never the draft's", async () => {
    const out = await mcp("context_get", { id: "nodes/guide" });
    expect(out.isError).toBe(false);
    expect(out.data.frontmatter.metadata.fields).toEqual({ severity: "low" });
    expect(out.text).not.toMatch(/Severity:\*\* high/);
  });

  it("context_list carries and filters on approved values", async () => {
    const all = await mcp("context_list", {});
    const doc = all.data.documents.find((d: any) => d.id === "nodes/guide");
    expect(doc.frontmatter.metadata.fields).toEqual({ severity: "low" });
    const high = await mcp("context_list", { fields: { severity: "high" } });
    expect((high.data.documents ?? []).map((d: any) => d.id)).not.toContain("nodes/guide");
    const low = await mcp("context_list", { fields: { severity: "low" } });
    expect(low.data.documents.map((d: any) => d.id)).toContain("nodes/guide");
  });
});

describe("concurrent definition create @unit", () => {
  it("the same key created twice at once is one 201 and one 409", async () => {
    const body = { key: "owner_note", label: "Owner note", type: "text" };
    const [a, b] = await Promise.all([
      jsonRequest(app, "POST", `/nests/${nestId}/fields`, body, owner.apiKey),
      jsonRequest(app, "POST", `/nests/${nestId}/fields`, body, owner.apiKey),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});
