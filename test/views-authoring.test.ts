/**
 * §1.12 view authoring (AC-17, M9, S4): a `view` input on REST create/PATCH
 * and MCP context_create/context_update, validated with the engine's own view
 * schema (§13 rules 30–36), accepted only on type: view, stored as the `view`
 * frontmatter key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

const VALID = {
  blocks: [
    { md: { ref: "nodes/overview" } },
    { id: "metrics", list: { select: "#board-metric" } },
    { id: "h", html: { ref: "nodes/dash", data_from: ["metrics"] } },
  ],
};

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authed(owner.apiKey),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const raw = await res.text();
    const line = raw.split("\n").find((l: string) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : raw;
  }
  const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
  return { isError: body?.result?.isError === true || !!body?.error, text };
}

async function rawFrontmatter(id: string): Promise<string> {
  const res = await app.request(`/nests/${nestId}/nodes/${id}?format=raw&frontmatter=1`, {
    headers: authed(owner.apiKey),
  });
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@author-view.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Authoring" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("AC-17: REST", () => {
  it("creates a type:view node with a valid view block (201) and round-trips it", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Board", type: "view", content: "Intro.", view: VALID },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.node.type).toBe("view");
    const fm = await rawFrontmatter(r.data.node.id);
    expect(fm).toMatch(/^---\n[\s\S]*\nview:\n/);
    expect(fm).toContain("select: '#board-metric'");
    expect(fm).toContain("data_from:");
    expect(fm).toContain("Intro.");
  });

  it.each([
    ["an unknown key", { ...VALID, colour: "red" }],
    ["an unknown block option", { blocks: [{ md: { ref: "nodes/x", extra: 1 } }] }],
    ["a ../ ref", { blocks: [{ md: { ref: "../other-nest/nodes/secret" } }] }],
    ["a URL ref", { blocks: [{ html: { ref: "https://evil.example/x" } }] }],
    ["a forward data_from", { blocks: [{ id: "h", html: { ref: "nodes/dash", data_from: ["later"] } }, { id: "later", list: { select: "#x" } }] }],
    ["render:pinned with an unpinned md", { render: "pinned", blocks: [{ md: { ref: "nodes/overview" } }] }],
    ["no blocks", { blocks: [] }],
    ["not an object", "blocks"],
  ])("refuses %s with a 400 naming the problem", async (_label, view) => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: `Bad ${_label}`, type: "view", content: "x", view },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBe(400);
    expect(String(r.data.error)).toMatch(/view|block|ref|rule|object/i);
    // Refused for what is wrong with the block — not because none arrived.
    expect(String(r.data.error)).not.toContain("rule 30");
  });

  it("refuses a view block on type:document (and on the default type)", async () => {
    for (const type of ["document", undefined]) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: `Doc with view ${type}`, ...(type ? { type } : {}), content: "x", view: VALID },
        owner.apiKey,
      );
      expect(r.status, JSON.stringify(r.data)).toBe(400);
      expect(String(r.data.error)).toMatch(/type: view|type "view"|only valid/i);
    }
  });

  it("still refuses type:view with no view block (unchanged engine message)", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "No Block", type: "view", content: "x" },
      owner.apiKey,
    );
    expect(r.status).toBe(400);
    expect(String(r.data.error)).toContain("§13 rule 30");
  });

  it("PATCH replaces the view block, validates it, and refuses it on a document", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Patchable", type: "view", content: "x", view: VALID },
      owner.apiKey,
    );
    expect(created.status).toBe(201);
    const id = created.data.node.id;
    const next = { blocks: [{ callout: { text: "replaced", tone: "info" } }] };
    const ok = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { view: next }, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const fm = await rawFrontmatter(id);
    expect(fm).toContain("text: replaced");
    expect(fm).not.toContain("#board-metric");

    const bad = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { view: { blocks: [{ md: { ref: "../x" } }] } },
      owner.apiKey,
    );
    expect(bad.status).toBe(400);

    const doc = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Plain Doc", content: "x" },
      owner.apiKey,
    );
    const onDoc = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${doc.data.node.id}`,
      { view: VALID },
      owner.apiKey,
    );
    expect(onDoc.status).toBe(400);
    // Converting in the same call is allowed.
    const convert = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${doc.data.node.id}`,
      { type: "view", view: VALID },
      owner.apiKey,
    );
    expect(convert.status, JSON.stringify(convert.data)).toBe(200);
    expect(convert.data.node.type).toBe("view");
  });
});

describe("S4: MCP", () => {
  it("context_create and context_update accept the same view input", async () => {
    const made = await mcp("context_create", {
      title: "Mcp View",
      type: "view",
      content: "from mcp",
      view: VALID,
    });
    expect(made.isError, made.text).toBe(false);
    expect(await rawFrontmatter("nodes/mcp-view")).toContain("#board-metric");

    const upd = await mcp("context_update", {
      id: "nodes/mcp-view",
      view: { blocks: [{ callout: { text: "mcp replaced" } }] },
    });
    expect(upd.isError, upd.text).toBe(false);
    expect(await rawFrontmatter("nodes/mcp-view")).toContain("mcp replaced");

    const bad = await mcp("context_create", {
      title: "Mcp Bad View",
      type: "view",
      content: "x",
      view: { blocks: [{ md: { ref: "https://evil.example" } }] },
    });
    expect(bad.isError).toBe(true);
  });
});
