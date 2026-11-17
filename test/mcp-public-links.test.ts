/**
 * Public links over MCP (PO-1365): context_public_link_create,
 * context_public_links and context_public_link_revoke are the twins of
 * POST / GET / DELETE /nests/:id/publications — one service, the same people
 * allowed, the same refusals — and their prose states the URL and whether the
 * link is open or gated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const TOOLS = [
  "context_public_link_create",
  "context_public_links",
  "context_public_link_update",
  "context_public_link_revoke",
];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let readKey: string;
let nestId: string;

async function mcp(method: string, params: Record<string, unknown>, key: string): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
}

async function call(name: string, args: Record<string, unknown>, key: string) {
  const body = await mcp("tools/call", { name, arguments: args }, key);
  return {
    isError: !!body?.result?.isError || !!body?.error,
    text: (body?.error?.message ?? (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("")) as string,
    data: body?.result?.structuredContent as any,
  };
}

async function toolNames(key: string): Promise<string[]> {
  const body = await mcp("tools/list", {}, key);
  return (body.result.tools as Array<{ name: string }>).map((t) => t.name);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Showcase" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Handbook", content: "# Handbook\n\nBody." }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Roadmap", content: "Body." }, owner.apiKey);
  const shared = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: "editor@acme.com", permission: "write" },
    owner.apiKey,
  );
  expect(shared.status).toBeLessThan(300);
  const key = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, owner.apiKey);
  expect(key.status).toBeLessThan(300);
  readKey = key.data.key ?? key.data.api_key ?? key.data.apiKey;
  expect(readKey).toBeTruthy();
});

afterAll(() => env.cleanup());

describe("who is offered the tools", () => {
  it("a nest owner sees all three, classified", async () => {
    const body = await mcp("tools/list", {}, owner.apiKey);
    const tools = body.result.tools as Array<{ name: string; annotations: any; title?: string }>;
    const by = (n: string) => tools.find((t) => t.name === n)!;
    for (const n of TOOLS) expect(by(n), n).toBeTruthy();
    expect(by("context_public_links").annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(by("context_public_link_create").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(by("context_public_link_revoke").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("an editor and a read-only key see none of them", async () => {
    for (const key of [editor.apiKey, readKey]) {
      const names = await toolNames(key);
      for (const n of TOOLS) expect(names).not.toContain(n);
    }
  });
});

describe("context_public_link_create", () => {
  it("publishes a document and says the URL and that it is open", async () => {
    const r = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook" }, owner.apiKey);
    expect(r.isError).toBe(false);
    const slug = r.data.publish.slug;
    expect(r.data.link).toBe(`http://localhost/p/${slug}`);
    expect(r.data.access).toBe("open");
    expect(r.text).toContain(`http://localhost/p/${slug}`);
    expect(r.text).toMatch(/open/i);
    expect(r.text).toContain("anyone with the link");
    // The same row REST lists, and the page is live.
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    expect(list.data.publishes.some((p: any) => p.slug === slug && p.access_mode === "public")).toBe(true);
    expect((await app.request(`/p/${slug}`)).status).toBe(200);
  });

  it("says a passcode link is gated, and never repeats the code", async () => {
    const r = await call(
      "context_public_link_create",
      { id: "nodes/handbook", access_mode: "code", code: "swordfish-77" },
      owner.apiKey,
    );
    expect(r.isError).toBe(false);
    expect(r.data.access).toBe("gated");
    expect(r.text).toMatch(/gated/i);
    expect(r.text).toMatch(/passcode/i);
    expect(r.text).not.toContain("swordfish-77");
    expect(JSON.stringify(r.data)).not.toContain("swordfish-77");
    const html = await (await app.request(`/p/${r.data.publish.slug}`)).text();
    expect(html).toContain("Protected document");
  });

  it("refuses exactly what REST refuses, in the same words", async () => {
    const cases: Array<Record<string, unknown>> = [
      { id: "nodes/nope", access_mode: "public" },
      { id: "nodes/handbook", access_mode: "code" },
      { id: "nodes/handbook", access_mode: "email" }, // no mail transport on this server
      { id: "../etc/passwd", access_mode: "public" },
    ];
    for (const args of cases) {
      const { id, ...rest } = args;
      const rest_ = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: id, ...rest }, owner.apiKey);
      expect(rest_.status, JSON.stringify(args)).toBe(400);
      const r = await call("context_public_link_create", args, owner.apiKey);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toBe(rest_.data.error);
      expect(r.data.code).toBe("VALIDATION_FAILED");
    }
  });

  it("refuses a missing access_mode and names the allowed values: an open link is always an explicit choice", async () => {
    const count = async () =>
      (await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey)).data.publishes.length;
    const before = await count();
    const r = await call("context_public_link_create", { id: "nodes/handbook" }, owner.apiKey);
    // The SDK's schema check answers first (the field is required), naming
    // the field and the four values; the handler refuses the same way if it
    // is ever reached without that check.
    expect(r.isError).toBe(true);
    expect(r.text).toContain("access_mode");
    for (const m of ["public", "code", "email", "invite"]) expect(r.text).toContain(m);
    // Nothing was published.
    expect(await count()).toBe(before);
  });

  it("lists access_mode as required in the tool schema", async () => {
    const body = await mcp("tools/list", {}, owner.apiKey);
    const t = body.result.tools.find((x: any) => x.name === "context_public_link_create");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["id", "access_mode"]));
  });

  it("refuses an access_mode REST does not know, before it reaches the service", async () => {
    const rest = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/handbook", access_mode: "everyone" }, owner.apiKey);
    expect(rest.status).toBe(400);
    // The tool's schema lists the four modes, so the MCP layer answers first.
    const r = await call("context_public_link_create", { id: "nodes/handbook", access_mode: "everyone" }, owner.apiKey);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("access_mode");
  });

  it("refuses an editor, as REST does", async () => {
    const rest = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/handbook" }, editor.apiKey);
    expect(rest.status).toBe(403);
    const r = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook" }, editor.apiKey);
    expect(r.isError).toBe(true);
    const before = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    expect(before.data.publishes.every((p: any) => p.node_id === "nodes/handbook")).toBe(true);
  });

  it("refuses a read-only key", async () => {
    const r = await call("context_public_link_create", { access_mode: "public", id: "nodes/roadmap" }, readKey);
    expect(r.isError || /read-only/i.test(r.text)).toBe(true);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    expect(list.data.publishes.some((p: any) => p.node_id === "nodes/roadmap")).toBe(false);
  });
});

describe("context_public_links", () => {
  it("lists a document's links with their URL, gate and state", async () => {
    const made = await call("context_public_link_create", { access_mode: "public", id: "nodes/roadmap" }, owner.apiKey);
    const r = await call("context_public_links", { id: "nodes/roadmap" }, owner.apiKey);
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(1);
    expect(r.data.publishes[0]).toMatchObject({
      id: made.data.publish.id,
      node_id: "nodes/roadmap",
      access_mode: "public",
      link: made.data.link,
      access: "open",
      live: true,
    });
    expect(r.text).toContain(made.data.link);
    expect(r.text).toMatch(/open/i);
    // Without `id`: every link in the nest, the same set REST returns.
    const all = await call("context_public_links", {}, owner.apiKey);
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    expect(all.data.count).toBe(rest.data.count);
    expect(JSON.stringify(all.data)).not.toContain("code_hash");
  });

  it("says so when a document has none", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Quiet", content: "Body." }, owner.apiKey);
    const r = await call("context_public_links", { id: "nodes/quiet" }, owner.apiKey);
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(0);
    expect(r.text).toMatch(/no public link/i);
  });

  it("refuses an editor", async () => {
    const r = await call("context_public_links", {}, editor.apiKey);
    expect(r.isError).toBe(true);
  });
});

describe("the invitation strip (show_invite)", () => {
  it("is on by default and can be left off when the link is made", async () => {
    const on = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook" }, owner.apiKey);
    expect(on.data.publish.show_invite).toBe(true);
    expect(await (await app.request(`/p/${on.data.publish.slug}`)).text()).toContain("data-cn-cta");

    const off = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook", show_invite: false }, owner.apiKey);
    expect(off.isError).toBe(false);
    expect(off.data.publish.show_invite).toBe(false);
    expect(off.text).toMatch(/Make your own nest.*not shown|no .*Make your own nest/i);
    expect(await (await app.request(`/p/${off.data.publish.slug}`)).text()).not.toContain("data-cn-cta");
  });

  it("context_public_link_update switches it on a live link, as PATCH does", async () => {
    const made = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook" }, owner.apiKey);
    const { id, slug } = made.data.publish;
    const off = await call("context_public_link_update", { link_id: id, show_invite: false }, owner.apiKey);
    expect(off.isError).toBe(false);
    expect(off.data.publish.show_invite).toBe(false);
    expect(off.text).toContain(`http://localhost/p/${slug}`);
    expect(await (await app.request(`/p/${slug}`)).text()).not.toContain("data-cn-cta");
    const listed = await call("context_public_links", { id: "nodes/handbook" }, owner.apiKey);
    expect(listed.data.publishes.find((p: any) => p.id === id).show_invite).toBe(false);

    const missing = await call("context_public_link_update", { link_id: "nope", show_invite: false }, owner.apiKey);
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe("DOCUMENT_NOT_FOUND");
    const refused = await call("context_public_link_update", { link_id: id, show_invite: true }, editor.apiKey);
    expect(refused.isError).toBe(true);
    expect(await (await app.request(`/p/${slug}`)).text()).not.toContain("data-cn-cta");
  });

  it("refuses to update a revoked link, over MCP and REST alike", async () => {
    const made = await call("context_public_link_create", { access_mode: "public", id: "nodes/handbook" }, owner.apiKey);
    const { id } = made.data.publish;
    await call("context_public_link_revoke", { link_id: id }, owner.apiKey);
    const r = await call("context_public_link_update", { link_id: id, show_invite: false }, owner.apiKey);
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("DOCUMENT_NOT_FOUND");
    const rest = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/${id}`, { show_invite: false }, owner.apiKey);
    expect(rest.status).toBe(404);
    expect(r.text).toBe(rest.data.error);
    const listed = await call("context_public_links", { id: "nodes/handbook" }, owner.apiKey);
    expect(listed.data.publishes.find((p: any) => p.id === id).show_invite).toBe(true);
  });

  it("classifies the update as a change to a page on the open web", async () => {
    const body = await mcp("tools/list", {}, owner.apiKey);
    const t = body.result.tools.find((x: any) => x.name === "context_public_link_update");
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
});

describe("context_public_link_revoke", () => {
  it("takes the page down, and a second revoke is not found", async () => {
    const made = await call("context_public_link_create", { access_mode: "public", id: "nodes/roadmap" }, owner.apiKey);
    const slug = made.data.publish.slug;
    expect((await app.request(`/p/${slug}`)).status).toBe(200);
    const r = await call("context_public_link_revoke", { link_id: made.data.publish.id }, owner.apiKey);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ revoked: true });
    expect(r.text).toContain(`http://localhost/p/${slug}`);
    expect((await app.request(`/p/${slug}`)).status).toBe(404);
    const listed = await call("context_public_links", { id: "nodes/roadmap" }, owner.apiKey);
    expect(listed.data.publishes.find((p: any) => p.id === made.data.publish.id).live).toBe(false);

    const again = await call("context_public_link_revoke", { link_id: made.data.publish.id }, owner.apiKey);
    expect(again.isError).toBe(true);
    expect(again.data.code).toBe("DOCUMENT_NOT_FOUND");
    const rest = await jsonRequest(app, "DELETE", `/nests/${nestId}/publications/${made.data.publish.id}`, undefined, owner.apiKey);
    expect(rest.status).toBe(404);
    expect(again.text).toBe(rest.data.error);
  });

  it("refuses an editor and leaves the link live", async () => {
    const made = await call("context_public_link_create", { access_mode: "public", id: "nodes/roadmap" }, owner.apiKey);
    const r = await call("context_public_link_revoke", { link_id: made.data.publish.id }, editor.apiKey);
    expect(r.isError).toBe(true);
    expect((await app.request(`/p/${made.data.publish.slug}`)).status).toBe(200);
  });
});
