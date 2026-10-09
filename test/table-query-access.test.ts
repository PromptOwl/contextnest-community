/**
 * Table queries are node reads, and must pass the same gate as the node.
 *
 * `context_table_query` (MCP) and `POST /table-query` (REST) resolved the
 * table by id or [[Title]] straight off disk: no `canReadNode`, and the live
 * working copy rather than the approved version. So a caller who could not
 * open a table document could still read its rows through a query —
 *  - a public (or org) reader of a governed nest got the unapproved working
 *    copy of a table — its pending rows — instead of the approved version
 *    that `GET /nodes/:id` serves them;
 *  - a table whose frontmatter says `published` but which was never approved
 *    answered a public reader in full, because the only gate was the
 *    frontmatter status;
 *  - an agent on a governed nest read unapproved rows, where every other MCP
 *    read serves the approved body only (resolveLlmBody).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

type User = { apiKey: string; userId: string; email: string };

const CSV = `sku:key, price:number, region
OWL-100, 99, US
OWL-200, 149, EU`;
const SECRET_ROW = "OWL-999-SECRET, 1, EU";

async function mcpTableQuery(
  app: any,
  nestId: string,
  apiKey: string,
  args: Record<string, unknown>,
): Promise<{ status: number; text: string; isError: boolean }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_table_query", arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const raw = await res.text();
    const dataLine = raw.split("\n").find((l: string) => l.startsWith("data: "));
    body = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : raw;
  }
  if (body?.error) {
    return { status: res.status, text: String(body.error.message ?? ""), isError: true };
  }
  const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
  return { status: res.status, text, isError: body?.result?.isError === true };
}

describe("public reader of a governed nest — approved rows only", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let outsider: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pub.test", "Owner");
    outsider = await registerUser(app, "outsider@example.com", "Outsider");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Public Facts" }, owner.apiKey);
    nestId = nest.data.nest.id;

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true, allow_self_approve: true },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );

    // v1 approved.
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Price List", type: "table", content: CSV },
      owner.apiKey,
    );
    expect(created.status, JSON.stringify(created.data)).toBe(201);

    // From here on, edits wait for review: v2 adds a row nobody approved, and
    // a second table never gets an approved version at all.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: false },
      owner.apiKey,
    );
    const edited = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/price-list`,
      { content: `${CSV}\n${SECRET_ROW}` },
      owner.apiKey,
    );
    expect(edited.status, JSON.stringify(edited.data)).toBe(200);
    const draft = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Draft Table", type: "table", content: `${CSV}\n${SECRET_ROW}` },
      owner.apiKey,
    );
    expect(draft.status, JSON.stringify(draft.data)).toBe(201);
    const flagged = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Flagged Table",
        type: "table",
        status: "published",
        content: `${CSV}\n${SECRET_ROW}`,
      },
      owner.apiKey,
    );
    expect(flagged.status, JSON.stringify(flagged.data)).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("GET serves the public reader the approved version (baseline)", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/price-list`,
      undefined,
      outsider.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.content).not.toContain("SECRET");
  });

  it("a table query serves the approved rows, not the pending ones", async () => {
    const r = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "[[Price List]]",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("OWL-200");
    expect(r.text).not.toContain("SECRET");
  });

  it("a never-approved table is not queryable by a public reader", async () => {
    const r = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "nodes/draft-table",
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("SECRET");
  });

  it("a never-approved table flagged published is not queryable either", async () => {
    const r = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "[[Flagged Table]]",
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("SECRET");
  });

  it("a denied id and a missing id look identical (no existence oracle)", async () => {
    const denied = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "nodes/draft-table",
    });
    const missing = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "nodes/no-such-table",
    });
    expect(denied.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(denied.text.replace("nodes/draft-table", "X")).toBe(
      missing.text.replace("nodes/no-such-table", "X"),
    );
  });

  it("a denied [[Title]] and a missing one look identical", async () => {
    const denied = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "[[Flagged Table]]",
    });
    const missing = await mcpTableQuery(app, nestId, outsider.apiKey, {
      table: "[[No Such Table]]",
    });
    expect(denied.text.replace("Flagged Table", "X")).toBe(
      missing.text.replace("No Such Table", "X"),
    );
  });

  it("an agent (MCP) reads the approved table even as the owner", async () => {
    // MCP serves approved bodies only on a governed nest (resolveLlmBody);
    // a table query is the same read and follows the same rule.
    const r = await mcpTableQuery(app, nestId, owner.apiKey, { table: "[[Price List]]" });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("SECRET");
  });

  it("MCP context_versions: a never-approved node's history is withheld", async () => {
    // REST GET .../versions already denies this; the MCP twin did not.
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${outsider.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "context_versions", arguments: { id: "nodes/draft-table" } },
      }),
    });
    const raw = await res.text();
    const line = raw.split("\n").find((l: string) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice("data: ".length)) : JSON.parse(raw);
    const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
    expect(body?.result?.isError).toBe(true);
    expect(text).not.toContain("owner@pub.test");
    expect(text).toContain("Node not found");
  });

  it("a table id cannot traverse into another nest", async () => {
    // The table ref arrives in the request BODY, so it never passes the
    // :nodeId containment guard the router applies to path params, and
    // storage.readDocument joins it onto the nest root as given. From a nest of
    // their own, a caller could read another nest's table by relative path.
    const own = await jsonRequest(app, "POST", "/nests", { name: "Mine" }, outsider.apiKey);
    const ownId = own.data.nest.id;
    const ref = `../${nestId}/nodes/flagged-table`;
    const rest = await jsonRequest(
      app,
      "POST",
      `/nests/${ownId}/table-query`,
      { table: ref },
      outsider.apiKey,
    );
    expect(rest.status).toBe(400);
    expect(JSON.stringify(rest.data ?? "")).not.toContain("SECRET");
    const mcp = await mcpTableQuery(app, ownId, outsider.apiKey, { table: ref });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).not.toContain("SECRET");
  });

  it("REST: the owner previews the working copy, like GET /nodes/:id", async () => {
    const rest = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/table-query`,
      { table: "[[Price List]]" },
      owner.apiKey,
    );
    expect(rest.status).toBe(200);
    expect(rest.data.rows.map((r: string[]) => r[0])).toContain("OWL-999-SECRET");
  });

  it("REST /overview: a public reader sees approved nodes and bodies only", async () => {
    // The REST twin of context_overview listed every node's title and a body
    // excerpt straight off disk — never-approved tables and pending rows alike.
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/overview`, undefined, outsider.apiKey);
    expect(res.status).toBe(200);
    const titles = (res.data.nodes as any[]).map((n) => n.title);
    expect(titles).toContain("Price List");
    expect(titles).not.toContain("Draft Table");
    expect(titles).not.toContain("Flagged Table");
    expect(JSON.stringify(res.data)).not.toContain("SECRET");
    expect(res.data.total).toBe(titles.length);
  });

  it("REST /overview: the owner still sees every node", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/overview`, undefined, owner.apiKey);
    expect(res.status).toBe(200);
    const titles = (res.data.nodes as any[]).map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["Price List", "Draft Table", "Flagged Table"]));
  });

  it("REST: a public reader never sees pending rows", async () => {
    const rest = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/table-query`,
      { table: "[[Price List]]" },
      outsider.apiKey,
    );
    expect(JSON.stringify(rest.data ?? "")).not.toContain("SECRET");
  });
});
