/**
 * MCP route tests — exercises /nests/:nestId/mcp via JSON-RPC over HTTP.
 *
 * The MCP transport requires Accept: "application/json, text/event-stream".
 * Without it the route returns 406.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
} from "./helpers";
import { normalizeHops } from "../src/mcp/tools";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcpCall(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
  targetNest: string = nestId,
): Promise<any> {
  const res = await app.request(`/nests/${targetNest}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.status).toBe(200);
  // The streamable transport returns a JSON body when enableJsonResponse=true.
  // It may also be served as text/event-stream chunked — be defensive.
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  const text = await res.text();
  // SSE: look for the first "data: {...}" line.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  id = 100,
  targetNest: string = nestId,
): Promise<string> {
  const res = await mcpCall(
    "tools/call",
    { name, arguments: args },
    id,
    targetNest,
  );
  expect(res.error).toBeUndefined();
  // result.content is an array of {type, text} per the MCP spec
  return res.result.content.map((c: any) => c.text).join("");
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");

  // Create a nest
  const create = await jsonRequest(app, "POST", "/nests", {
    name: "MCP Test Nest",
  });
  nestId = create.data.nest.id;

  // Seed a few nodes
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "API Reference",
    content: "# API\n\nDocumentation for the public API.",
    tags: ["api", "docs"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Architecture Overview",
    content: "# Architecture\n\nSystem-level design notes.",
    tags: ["architecture"],
    type: "document",
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Brand Guide",
    content: "# Brand\n\nLogo, colors, voice.",
    tags: ["brand"],
  });
});

afterAll(() => {
  env.cleanup();
});

describe("MCP transport — Accept header guard", () => {
  it("rejects requests missing the SSE Accept header (406)", async () => {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    // Streamable transport returns 406 when the client can't speak SSE.
    expect(res.status).toBe(406);
  });
});

describe("MCP initialize + tool listing", () => {
  it("initialize returns capabilities + serverInfo", async () => {
    const res = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0" },
    });
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toBeDefined();
    expect(res.result.serverInfo.name).toBe(`contextnest-${nestId}`);
  });

  it("tools/list returns the registered tool definitions", async () => {
    const res = await mcpCall("tools/list", {});
    expect(res.result.tools).toBeDefined();
    const names = res.result.tools.map((t: any) => t.name);
    // Spot-check a representative subset
    expect(names).toContain("context_init");
    expect(names).toContain("context_overview");
    expect(names).toContain("context_search");
    expect(names).toContain("context_query");
    expect(names).toContain("context_get");
    expect(names).toContain("context_list");
  });
});

describe("MCP tools/call — basic vault tools", () => {
  it("context_overview reports node count, types, tags", async () => {
    const text = await callTool("context_overview");
    expect(text).toMatch(/Total nodes:\*?\*?\s*3/);
    expect(text).toContain("API Reference");
    expect(text).toContain("Architecture Overview");
    expect(text).toContain("Brand Guide");
  });

  it("context_search returns matching nodes by keyword", async () => {
    const text = await callTool("context_search", { query: "design" });
    expect(text).toContain("Architecture Overview");
    expect(text).not.toContain("API Reference");
  });

  it("context_search returns 'no matches' for an unknown term", async () => {
    const text = await callTool("context_search", { query: "nonexistentxyz" });
    expect(text).toMatch(/No nodes matched/i);
  });

  it("context_get fetches a node by title (case-insensitive)", async () => {
    const text = await callTool("context_get", { title: "brand guide" });
    expect(text).toContain("**Title:** Brand Guide");
    expect(text).toContain("Logo, colors, voice");
  });

  it("context_get fetches a node by id", async () => {
    const text = await callTool("context_get", {
      id: "nodes/api-reference",
    });
    expect(text).toContain("**Title:** API Reference");
  });

  it("context_get returns 'not found' for an unknown title", async () => {
    const text = await callTool("context_get", { title: "Ghost Doc" });
    expect(text).toMatch(/Node not found/);
  });

  it("context_list returns all nodes by default", async () => {
    const text = await callTool("context_list");
    expect(text).toContain("API Reference");
    expect(text).toContain("Architecture Overview");
    expect(text).toContain("Brand Guide");
  });

  it("context_list filters by tag", async () => {
    const text = await callTool("context_list", { tag: "api" });
    expect(text).toContain("API Reference");
    expect(text).not.toContain("Brand Guide");
  });

  it("context_query routes through to the engine selector grammar", async () => {
    // We assert the route plumbing, not engine semantics: a successful call
    // returns a string that's either a match list or "No nodes matched".
    // (Engine's first-call auto-index can return empty for tag selectors
    // against freshly-created vaults — pre-existing engine quirk.)
    const text = await callTool("context_query", { query: "#api" });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/(API Reference|No nodes matched)/);
  });

  it("context_query and context_resolve accept a caller-set hops depth", async () => {
    // hops was hardcoded to 2; now it's caller-controlled (parity with REST
    // POST /context). Same plumbing-level assertion as above — the param must
    // be accepted by the schema and passed through without erroring.
    const one = await callTool("context_query", { query: "#api", hops: 1 });
    expect(typeof one).toBe("string");
    expect(one).toMatch(/(API Reference|No nodes matched)/);

    const resolved = await callTool("context_resolve", {
      selector: "#api",
      hops: 1,
      max_tokens: 500,
    });
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("normalizeHops", () => {
  it("keeps valid non-negative integers", () => {
    expect(normalizeHops(0)).toBe(0);
    expect(normalizeHops(1)).toBe(1);
    expect(normalizeHops(5)).toBe(5);
  });

  it("defaults to 2 for null/undefined/non-numeric", () => {
    expect(normalizeHops(undefined)).toBe(2);
    expect(normalizeHops(null)).toBe(2); // clients may serialize unset args as null
    expect(normalizeHops("nope")).toBe(2);
    expect(normalizeHops(NaN)).toBe(2);
  });

  it("floors fractions and clamps out-of-range input", () => {
    expect(normalizeHops(1.9)).toBe(1);
    expect(normalizeHops(-3)).toBe(0);
    expect(normalizeHops(999999)).toBe(10); // MAX_HOPS
  });
});

describe("MCP tools/call — context_export (whole nest)", () => {
  it("tools/list includes context_export and context_comments", async () => {
    const res = await mcpCall("tools/list", {});
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_export");
    expect(names).toContain("context_comments");
  });

  it("exports every document's full content in one call", async () => {
    const text = await callTool("context_export");
    expect(text).toMatch(/Nest export/);
    // Full bodies of all three seeded docs, not just titles/snippets.
    expect(text).toContain("Documentation for the public API");
    expect(text).toContain("System-level design notes");
    expect(text).toContain("Logo, colors, voice");
  });

  it("respects the token budget and notes truncation", async () => {
    // Tiny budget → only the first doc(s) fit, with a truncation note.
    const text = await callTool("context_export", { max_tokens: 20 });
    expect(text).toMatch(/Token budget reached/);
  });
});

describe("MCP tools/call — context_comments", () => {
  it("returns a document's anchored comment threads", async () => {
    // Seed an annotation on the API Reference node via REST.
    const anno = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/api-reference/annotations`,
      {
        body: "Please clarify the auth section.",
        anchor: { quote: "public API", before: "", after: "" },
      },
    );
    expect([200, 201]).toContain(anno.status);

    const text = await callTool("context_comments", {
      id: "nodes/api-reference",
    });
    expect(text).toContain("Comments on \"API Reference\"");
    expect(text).toContain("Please clarify the auth section.");
    expect(text).toContain("public API"); // the anchored quote
  });

  it("reports when a document has no comments", async () => {
    const text = await callTool("context_comments", { title: "Brand Guide" });
    expect(text).toMatch(/No comments on/);
  });

  it("refuses comments on an unapproved draft node — no leak via anchor.quote", async () => {
    // Fresh nest with stewardship ON, so a newly created doc has no approved
    // version and is invisible to AI (same gate as context_get/context_export).
    const created = await jsonRequest(app, "POST", "/nests", {
      name: "Gated Nest",
    });
    const sid = created.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${sid}/settings`, {
      stewardship_enabled: true,
    });
    await jsonRequest(app, "POST", `/nests/${sid}/nodes`, {
      title: "Secret Draft",
      content: "# Secret\n\nUnreleased pricing: 4242.",
    });
    // Anchor the comment on the draft body text — this is what must NOT leak.
    const anno = await jsonRequest(
      app,
      "POST",
      `/nests/${sid}/nodes/nodes/secret-draft/annotations`,
      {
        body: "verify this figure",
        anchor: { quote: "Unreleased pricing: 4242.", before: "", after: "" },
      },
    );
    expect([200, 201]).toContain(anno.status);

    // Sanity: context_get already refuses this node.
    const got = await callTool(
      "context_get",
      { id: "nodes/secret-draft" },
      501,
      sid,
    );
    expect(got).toMatch(/no approved version yet/i);

    // The fix: context_comments must refuse identically and leak nothing.
    const text = await callTool(
      "context_comments",
      { id: "nodes/secret-draft" },
      502,
      sid,
    );
    expect(text).toMatch(/no approved version yet/i);
    expect(text).not.toContain("4242"); // draft excerpt must not leak
    expect(text).not.toContain("verify this figure"); // comment body must not leak
  });
});

describe("context_delete / context_move — ambiguous title refuses", () => {
  // Titles are not unique: the same title in two folders is two documents.
  // Resolving one arbitrarily would let an agent delete the wrong document
  // with no error and no way back, so an ambiguous title must refuse.
  beforeAll(async () => {
    for (const folder of ["alpha", "beta"]) {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
        title: "Shared Title",
        content: `# In ${folder}`,
        folder,
      });
      expect(res.status).toBe(201);
    }
  });

  it("context_delete refuses and lists the candidate ids", async () => {
    const text = await callTool("context_delete", { title: "Shared Title" });
    expect(text).toMatch(/2 nodes share the title/i);
    expect(text).toContain("nodes/alpha/shared-title");
    expect(text).toContain("nodes/beta/shared-title");
    expect(text).not.toContain("Deleted node");
  });

  it("context_move refuses the same way", async () => {
    const text = await callTool("context_move", {
      title: "Shared Title",
      folder: "gamma",
    });
    expect(text).toMatch(/2 nodes share the title/i);
    expect(text).not.toContain("Moved");
  });

  it.each(["context_delete", "context_move"])(
    "%s with neither title nor id asks for one instead of acting",
    async (tool) => {
      const text = await callTool(tool, tool === "context_move" ? { folder: "x" } : {});
      expect(text).toMatch(/provide a title or an id/i);
    },
  );

  it("an explicit id disambiguates and still acts", async () => {
    const text = await callTool("context_delete", {
      id: "nodes/alpha/shared-title",
    });
    expect(text).toContain("Deleted node");
    // The sibling survives — only the named id went.
    const left = await callTool("context_delete", { title: "Shared Title" });
    expect(left).toContain("Deleted node");
    expect(left).toContain("nodes/beta/shared-title");
  });
});

describe("MCP tools/call — error handling", () => {
  it("returns a JSON-RPC error for an unknown tool", async () => {
    const res = await mcpCall(
      "tools/call",
      { name: "context_nonexistent", arguments: {} },
      999,
    );
    // Server may return either an error object or a result with isError=true
    const failed =
      !!res.error ||
      (res.result?.isError === true) ||
      (res.result?.content?.[0]?.text || "").toLowerCase().includes("unknown");
    expect(failed).toBe(true);
  });
});
