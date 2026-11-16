/**
 * Asked to post an HTML page, an agent used to file a markdown document whose
 * whole body was one ```html block, so the person saw source code (PO-1336).
 *
 * The tool descriptions now say how to post a page (type "artifact", raw HTML
 * in `content`), and an agent write that is an HTML page anyway is stored as
 * one: MCP always, REST when the caller holds an API key. A person saving in
 * the web app (session cookie) is never converted.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";
import { TOOL_DEFINITIONS } from "../src/mcp/tools";
import { renderLlmsTxt } from "../src/mcp/server-routes";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: Awaited<ReturnType<typeof registerUser>>;
let nestId: string;
let rpcId = 1;

const PAGE = "<!DOCTYPE html>\n<html><head><title>Deck</title></head><body><h1>Q3</h1></body></html>";
const FENCED = "```html\n" + PAGE + "\n```";
const MIXED = "# Embed snippet\n\nPaste this:\n\n```html\n<div class=\"w\">hi</div>\n```\n";

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${alice.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  return {
    text: body.result.content.map((c: any) => c.text).join("") as string,
    data: body.result.structuredContent as any,
    isError: body.result.isError === true,
  };
}

/** The stored node, straight from REST: type and body as they are on disk. */
async function stored(id: string) {
  const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, alice.apiKey);
  expect(res.status).toBe(200);
  return res.data.node as { type: string; content: string };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@example.com");
  const created = await jsonRequest(app, "POST", "/nests", { name: "HTML Nest" }, alice.apiKey);
  nestId = created.data.nest.id;
});

afterEach(() => {
  delete process.env.TYPE_ARTIFACT_ENABLED;
});
afterAll(() => env.cleanup());

describe("what the agent is told", () => {
  const def = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name)! as any;

  it("context_create says how to post an HTML page", () => {
    const d = def("context_create");
    expect(d.description).toMatch(/HTML page/);
    expect(d.description).toMatch(/type "artifact"/);
    expect(d.inputSchema.properties.content.description).toMatch(/raw HTML/);
    expect(d.inputSchema.properties.content.description).toMatch(/no (markdown )?code fence/i);
    expect(d.inputSchema.properties.type.description).toMatch(/artifact/);
    expect(d.inputSchema.properties.type.description).toMatch(/renders/);
  });

  it("context_update says the same for an artifact's content", () => {
    const d = def("context_update");
    expect(d.inputSchema.properties.content.description).toMatch(/raw HTML/);
    expect(d.inputSchema.properties.content.description).toMatch(/no (markdown )?code fence/i);
  });

  it("llms.txt says it for REST", () => {
    const txt = renderLlmsTxt("https://nest.example.com");
    expect(txt).toMatch(/"type": "artifact"/);
    expect(txt).toMatch(/raw HTML/);
  });
});

describe("context_create with an HTML page and no artifact type", () => {
  it("stores a fenced page as an artifact, without the fence, and says so", async () => {
    const out = await tool("context_create", { title: "Fenced Deck", content: FENCED });
    expect(out.isError).toBe(false);
    const node = await stored(out.data.id);
    expect(node.type).toBe("artifact");
    expect(node.content.trim()).toBe(PAGE);
    expect(out.text).toMatch(/stored as an HTML artifact/i);
    expect(out.text).toMatch(/code fence was removed/i);
    expect(out.text).toContain(`http://localhost/nest/${nestId}?doc=${encodeURIComponent(out.data.id)}`);
  });

  it("stores a bare HTML document as an artifact (type document sent explicitly)", async () => {
    const out = await tool("context_create", { title: "Bare Deck", type: "document", content: PAGE });
    const node = await stored(out.data.id);
    expect(node.type).toBe("artifact");
    expect(node.content.trim()).toBe(PAGE);
    expect(out.text).toMatch(/stored as an HTML artifact/i);
    expect(out.text).not.toMatch(/code fence was removed/i);
  });

  it("keeps it as sent when artifacts are disabled, and says they are disabled", async () => {
    process.env.TYPE_ARTIFACT_ENABLED = "false";
    const out = await tool("context_create", { title: "Disabled Deck", content: FENCED });
    expect(out.isError).toBe(false);
    const node = await stored(out.data.id);
    expect(node.type).toBe("document");
    expect(node.content.trim()).toBe(FENCED);
    expect(out.text).toMatch(/artifact nodes are disabled on this server/i);
  });

  it("does not touch markdown that merely contains an html code block", async () => {
    const out = await tool("context_create", { title: "Snippet Doc", content: MIXED });
    const node = await stored(out.data.id);
    expect(node.type).toBe("document");
    expect(node.content.trim()).toBe(MIXED.trim());
    expect(out.text).not.toMatch(/artifact/i);
  });

  it("does not touch another node type", async () => {
    const out = await tool("context_create", { title: "Glossary Html", type: "glossary", content: FENCED });
    expect((await stored(out.data.id)).type).toBe("glossary");
  });

  it("unwraps a fence sent with type artifact", async () => {
    const out = await tool("context_create", { title: "Typed Deck", type: "artifact", content: FENCED });
    const node = await stored(out.data.id);
    expect(node.type).toBe("artifact");
    expect(node.content.trim()).toBe(PAGE);
    expect(out.text).toMatch(/code fence .* removed/i);
  });
});

describe("context_update", () => {
  it("unwraps a fenced body sent to an existing artifact", async () => {
    const made = await tool("context_create", { title: "Live Deck", type: "artifact", content: PAGE });
    const next = PAGE.replace("Q3", "Q4");
    const out = await tool("context_update", { id: made.data.id, content: "```html\n" + next + "\n```" });
    expect(out.isError).toBe(false);
    const node = await stored(made.data.id);
    expect(node.type).toBe("artifact");
    expect(node.content.trim()).toBe(next);
    expect(out.text).toMatch(/code fence .* removed/i);
  });

  it("turns a document into an artifact when its whole new body is an HTML page", async () => {
    const made = await tool("context_create", { title: "Becomes Page", content: "# Draft\n\nwords" });
    const out = await tool("context_update", { id: made.data.id, content: FENCED });
    const node = await stored(made.data.id);
    expect(node.type).toBe("artifact");
    expect(node.content.trim()).toBe(PAGE);
    expect(out.text).toMatch(/stored as an HTML artifact/i);
  });

  it("leaves an append and a mixed body alone", async () => {
    const made = await tool("context_create", { title: "Stays Doc", content: "# Notes\n\nwords" });
    await tool("context_update", { id: made.data.id, append: FENCED });
    expect((await stored(made.data.id)).type).toBe("document");
    await tool("context_update", { id: made.data.id, content: MIXED });
    const node = await stored(made.data.id);
    expect(node.type).toBe("document");
    expect(node.content.trim()).toBe(MIXED.trim());
  });
});

describe("REST parity", () => {
  it("an API-key create is guarded the same way and reports it", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rest Deck", content: FENCED },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.type).toBe("artifact");
    expect(res.data.node.content.trim()).toBe(PAGE);
    expect(res.data.notice).toMatch(/stored as an HTML artifact/i);
    expect(res.data.web_url).toBe(
      `http://localhost/nest/${nestId}?doc=${encodeURIComponent(res.data.node.id)}`,
    );
  });

  it("an API-key update of an artifact is unwrapped", async () => {
    const made = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rest Live Deck", type: "artifact", content: PAGE },
      alice.apiKey,
    );
    const next = PAGE.replace("Q3", "Q5");
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${made.data.node.id}`,
      { content: "```html\n" + next + "\n```" },
      alice.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.content.trim()).toBe(next);
    expect(res.data.notice).toMatch(/code fence .* removed/i);
    expect(res.data.web_url).toContain(`/nest/${nestId}?doc=`);
  });

  it("a person saving in the web app (session cookie) is not converted", async () => {
    const res = await app.request(`/nests/${nestId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: alice.cookie },
      body: JSON.stringify({ title: "Typed By Hand", content: FENCED }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.node.type).toBe("document");
    expect(data.node.content.trim()).toBe(FENCED);
    expect(data.notice).toBeUndefined();
  });

  it("a plain document write carries the web link and no notice", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Plain Rest Doc", content: "# Hi\n\nwords" },
      alice.apiKey,
    );
    expect(res.data.notice).toBeUndefined();
    expect(res.data.web_url).toContain(`/nest/${nestId}?doc=`);
  });
});
