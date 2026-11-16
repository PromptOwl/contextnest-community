/**
 * Links a person can open, in what an agent reads (PO-1336).
 *
 * An agent asked "give me the link" used to build one from the API or MCP
 * URL (/nests/<id>), which a browser cannot open. Every surface an agent reads
 * now carries the web app's own address — /nest/<id> and
 * /nest/<id>?doc=<node id> — and a browser that still lands on /nests/<id> is
 * sent to the app.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";
import { renderLlmsTxt } from "../src/mcp/server-routes";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: Awaited<ReturnType<typeof registerUser>>;
let nestId: string;

const ORIGIN = "http://localhost";
let rpcId = 1;

async function rpc(path: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${alice.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
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
  expect(body.error).toBeUndefined();
  return {
    text: body.result.content.map((c: any) => c.text).join("") as string,
    data: body.result.structuredContent as any,
    isError: body.result.isError === true,
  };
}
const nestTool = (name: string, args: Record<string, unknown> = {}) =>
  rpc(`/nests/${nestId}/mcp`, name, args);
const serverTool = (name: string, args: Record<string, unknown> = {}) => rpc("/mcp", name, args);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@example.com");
  const created = await jsonRequest(app, "POST", "/nests", { name: "Link Nest" }, alice.apiKey);
  nestId = created.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Pricing Notes", content: "# Pricing\n\nSeat based.", folder: "gtm" },
    alice.apiKey,
  );
});

afterAll(() => {
  delete process.env.PUBLIC_BASE_URL;
  env.cleanup();
});

describe("nest index", () => {
  it("gives each nest a web_url, structured and in the prose", async () => {
    const { text, data } = await serverTool("nest_index");
    const mine = data.nests.find((n: any) => n.id === nestId);
    expect(mine.web_url).toBe(`${ORIGIN}/nest/${nestId}`);
    expect(text).toContain(`${ORIGIN}/nest/${nestId}`);
  });

  it("says which URL is for people and which are for agents", async () => {
    const { text } = await serverTool("nest_index");
    expect(text).toMatch(/for people/i);
    expect(text).toMatch(/for agents/i);
    // The line that carries the web link is not the line that carries the API urls.
    const webLine = text.split("\n").find((l) => l.includes(`/nest/${nestId}`))!;
    expect(webLine).not.toContain(`/nests/${nestId}`);
  });

  it("GET /index carries the same link in both formats", async () => {
    const md = await app.request("/index", { headers: { Authorization: `Bearer ${alice.apiKey}` } });
    expect(await md.text()).toContain(`${ORIGIN}/nest/${nestId}`);
    const json = await jsonRequest(app, "GET", "/index?format=json", undefined, alice.apiKey);
    expect(json.data.nests.find((n: any) => n.id === nestId).web_url).toBe(`${ORIGIN}/nest/${nestId}`);
  });

  it("uses PUBLIC_BASE_URL when an admin set one", async () => {
    process.env.PUBLIC_BASE_URL = "https://nest.example.com/";
    try {
      const { data } = await serverTool("nest_index");
      expect(data.nests.find((n: any) => n.id === nestId).web_url).toBe(
        `https://nest.example.com/nest/${nestId}`,
      );
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  it("nest_create answers with the new nest's web link", async () => {
    const { text } = await serverTool("nest_create", { name: "Second Link Nest" });
    expect(text).toMatch(new RegExp(`${ORIGIN}/nest/[0-9a-f-]{36}`));
  });
});

describe("llms.txt", () => {
  it("documents the web addresses and who each URL is for", () => {
    const txt = renderLlmsTxt("https://nest.example.com");
    expect(txt).toContain("https://nest.example.com/nest/<nest-id>");
    expect(txt).toContain("https://nest.example.com/nest/<nest-id>?doc=<node-id>");
    expect(txt).toMatch(/Links for people/);
  });
});

describe("document tools", () => {
  const docUrl = (id: string) => `${ORIGIN}/nest/${nestId}?doc=${encodeURIComponent(id)}`;

  it("context_get carries the document's web link", async () => {
    const { text, data } = await nestTool("context_get", { title: "Pricing Notes" });
    expect(data.id).toBe("nodes/gtm/pricing-notes");
    expect(text).toContain(docUrl("nodes/gtm/pricing-notes"));
    expect(text).toMatch(/for people/i);
  });

  it("context_create and context_update answer with the web link", async () => {
    const made = await nestTool("context_create", { title: "Launch Plan", content: "# Plan\n\nShip it." });
    expect(made.isError).toBe(false);
    expect(made.text).toContain(docUrl(made.data.id));
    const updated = await nestTool("context_update", { id: made.data.id, content: "# Plan\n\nShipped." });
    expect(updated.text).toContain(docUrl(made.data.id));
  });

  it("context_list and context_search say how to build a document link", async () => {
    const pattern = `${ORIGIN}/nest/${nestId}?doc=<node id, URL-encoded>`;
    expect((await nestTool("context_list")).text).toContain(pattern);
    expect((await nestTool("context_search", { query: "pricing" })).text).toContain(pattern);
  });

  it("the server-level endpoint links into the right nest", async () => {
    const { text } = await serverTool("context_get", { nest: nestId, title: "Pricing Notes" });
    expect(text).toContain(docUrl("nodes/gtm/pricing-notes"));
  });
});

describe("a browser that lands on the API address of a nest", () => {
  const browser = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

  it("is sent to the nest page, signed in or not", async () => {
    for (const headers of [browser, { ...browser, Cookie: alice.cookie }]) {
      const res = await app.request(`/nests/${nestId}`, { headers });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/nest/${nestId}`);
    }
  });

  it("is sent there from the MCP and retrieval addresses too", async () => {
    for (const tail of ["mcp", "context"]) {
      const res = await app.request(`/nests/${nestId}/${tail}`, { headers: browser });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/nest/${nestId}`);
    }
  });

  it("works on the Accept header alone (older browsers send no Sec-Fetch-*)", async () => {
    const res = await app.request(`/nests/${nestId}`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(302);
  });

  it("does not confirm whether a nest exists", async () => {
    const res = await app.request(`/nests/00000000-0000-4000-8000-000000000000`, { headers: browser });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/nest/00000000-0000-4000-8000-000000000000`);
  });

  it("leaves programmatic clients exactly as they were", async () => {
    // API key, whatever it Accepts.
    const keyed = await app.request(`/nests/${nestId}`, {
      headers: { ...browser, Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(keyed.status).toBe(200);
    expect((await keyed.json()).nest.id).toBe(nestId);
    // The app's own fetch: a session cookie, no HTML Accept.
    const fetched = await app.request(`/nests/${nestId}`, { headers: { Cookie: alice.cookie } });
    expect(fetched.status).toBe(200);
    // No credentials, no HTML Accept: still the API's own refusal, in JSON.
    const anon = await app.request(`/nests/${nestId}`, { headers: { Accept: "application/json" } });
    expect(anon.status).toBe(404);
    expect((await anon.json()).error).toBeTruthy();
    // A fetch()/XHR that happens to accept HTML is not a page load.
    const xhr = await app.request(`/nests/${nestId}`, {
      headers: { Accept: "text/html", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors" },
    });
    expect(xhr.status).toBe(404);
    // A query string keeps the API answer, even for a page load.
    const withQuery = await app.request(`/nests/${nestId}?raw=1`, { headers: browser });
    expect(withQuery.status).not.toBe(302);
    // Not a GET.
    const post = await app.request(`/nests/${nestId}/mcp`, { method: "POST", headers: browser });
    expect(post.status).not.toBe(302);
    // The nest list and other nest sub-paths are not redirected.
    const list = await app.request(`/nests`, { headers: browser });
    expect(list.status).not.toBe(302);
    const exportRes = await app.request(`/nests/${nestId}/export?format=markdown`, { headers: browser });
    expect(exportRes.status).not.toBe(302);
    const unsynced = await app.request(`/nests/unsynced`, { headers: browser });
    expect(unsynced.status).not.toBe(302);
  });
});
