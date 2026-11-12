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
import { normalizeHops, normalizeSearchLimit } from "../src/mcp/tools";

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

describe("MCP transport — no standalone SSE stream (stateless)", () => {
  // A 200 here opened a stream we closed at once; clients reconnected in a
  // tight loop and pinned prod's CPU. 405 tells them there is no stream.
  for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
    for (const path of [() => `/nests/${nestId}/mcp`, () => "/mcp"]) {
      it(`${method} ${path().replace(nestId, ":id")} answers 405`, async () => {
        const res = await app.request(path(), { method, headers: { Accept: "text/event-stream" } });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect((await res.json()).error.code).toBe(-32000);
      });
    }
  }
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

describe("normalizeSearchLimit", () => {
  it("keeps a sane positive integer", () => {
    expect(normalizeSearchLimit(1)).toBe(1);
    expect(normalizeSearchLimit(50)).toBe(50);
    expect(normalizeSearchLimit(200)).toBe(200);
  });

  it("defaults for missing, negative, zero or non-numeric input", () => {
    expect(normalizeSearchLimit(undefined)).toBe(20);
    expect(normalizeSearchLimit(null)).toBe(20);
    expect(normalizeSearchLimit(-1)).toBe(20);
    expect(normalizeSearchLimit(0)).toBe(20);
    expect(normalizeSearchLimit("abc")).toBe(20);
    expect(normalizeSearchLimit(NaN)).toBe(20);
  });

  it("floors fractions and caps at the maximum", () => {
    expect(normalizeSearchLimit(1.7)).toBe(1);
    expect(normalizeSearchLimit("7")).toBe(7);
    expect(normalizeSearchLimit(9999)).toBe(200);
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

  it("returns comments on an unapproved draft to collaborators; context_get still refuses body", async () => {
    // Fresh nest with stewardship ON, so a newly created doc has no approved
    // version and is invisible to AI for public readers (same gate as context_get/context_export).
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

    // With the updated policy, collaborators/stewards who can read the node
    // may read its comment threads over MCP even before approval. Public readers
    // remain blocked elsewhere. Here (open mode), the creator acts as the
    // collaborator/owner, so comments are visible.
    const text = await callTool(
      "context_comments",
      { id: "nodes/secret-draft" },
      502,
      sid,
    );
    expect(text).toContain("Comments on \"Secret Draft\"");
    expect(text).toContain("verify this figure");
    expect(text).toContain("Unreleased pricing: 4242.");
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

// ─── structuredContent (operation-catalog payloads) ───────────────────────
//
// The eight tools `ctx` drives now return BOTH halves: the prose in
// `content` (unchanged — every existing chat client reads only this) and the
// engine's operation-catalog JSON in `structuredContent`.
//
// The prose assertions below are byte-exact on purpose. They are the guard
// that adding the structured half did not "improve" a single string.

/** tools/call, returning the whole result object (content + structuredContent). */
async function callToolRaw(
  name: string,
  args: Record<string, unknown> = {},
  id = 700,
  targetNest: string = nestId,
): Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: any;
  isError?: boolean;
}> {
  const res = await mcpCall("tools/call", { name, arguments: args }, id, targetNest);
  expect(res.error).toBeUndefined();
  return res.result;
}

describe("MCP tools/call — structuredContent", () => {
  let sid: string;

  beforeAll(async () => {
    const created = await jsonRequest(app, "POST", "/nests", {
      name: "Structured Nest",
    });
    sid = created.data.nest.id;
    const seeded = await jsonRequest(app, "POST", `/nests/${sid}/nodes`, {
      title: "Pricing Sheet",
      content: "Enterprise tier is 42.",
      tags: ["pricing"],
    });
    expect(seeded.status).toBe(201);
  });

  it("context_list: prose names the last editor, documents[] alongside it", async () => {
    const r = await callToolRaw("context_list", {}, 710, sid);
    expect(r.content).toHaveLength(1);
    // po-1213: each row ends with who last edited it, human first.
    expect(r.content[0].text).toMatch(
      /^1 node\(s\):\n\n1\. \*\*Pricing Sheet\*\* \[document\] · edited by \S+@\S+( via \S+)?, \d{4}-\d{2}-\d{2}$/,
    );
    expect(r.structuredContent).toEqual({
      documents: [
        {
          id: "nodes/pricing-sheet",
          title: "Pricing Sheet",
          type: "document",
          status: expect.any(String),
          tags: ["#pricing"],
          last_edit: expect.objectContaining({ version: 1, edited_by: expect.any(String), edited_at: expect.any(String) }),
        },
      ],
    });
    // Bodies are NOT served here: listNodesForCaller gates which documents
    // come back, not whether their on-disk text is approved.
    expect(r.structuredContent.documents[0].body).toBeUndefined();
  });

  it("context_list: empty result still carries documents: []", async () => {
    const r = await callToolRaw("context_list", { tag: "nope" }, 711, sid);
    expect(r.content).toEqual([
      { type: "text", text: "No nodes found with the given filters." },
    ]);
    expect(r.structuredContent).toEqual({ documents: [] });
  });

  it("context_get: prose unchanged, documentPayload alongside it", async () => {
    const r = await callToolRaw("context_get", { id: "nodes/pricing-sheet" }, 712, sid);
    const body = r.structuredContent.body;
    expect(body).toContain("Enterprise tier is 42.");
    expect(r.content).toEqual([
      {
        type: "text",
        // The served version's human (and agent, when the write named one).
        text: `**Title:** Pricing Sheet\n**Type:** document\n**Tags:** #pricing\n**Last edited by:** admin@localhost (v1)\n\n---\n\n${body}`,
      },
    ]);
    expect(r.structuredContent.id).toBe("nodes/pricing-sheet");
    expect(r.structuredContent.frontmatter.title).toBe("Pricing Sheet");
    expect(r.structuredContent.frontmatter.tags).toEqual(["#pricing"]);
  });

  it("context_get: under stewardship the frontmatter never describes the draft", async () => {
    // The body a gated read returns is the APPROVED snapshot. Live frontmatter
    // belongs to the pending draft — so version/status/checksum/timestamps must
    // not ride along beside it, or a machine caller reads them as facts about
    // the body it just got.
    const nest = await jsonRequest(app, "POST", "/nests", {
      name: "Skew Nest",
    });
    const gid = nest.data.nest.id;
    // Self-approve on: the owner's create publishes, giving us an approved v1.
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, {
      stewardship_enabled: true,
      allow_self_approve: true,
    });
    await jsonRequest(app, "POST", `/nests/${gid}/nodes`, {
      title: "Gated Doc",
      content: "APPROVED BODY",
    });
    // Self-approve off: the next write stays an unapproved draft on disk.
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, {
      allow_self_approve: false,
    });
    const draft = await callToolRaw(
      "context_update",
      { title: "Gated Doc", content: "DRAFT EDIT", tags: ["#leaky"] },
      730,
      gid,
    );
    // The draft must really exist, or the assertions below pass for the
    // wrong reason (nothing to skew from).
    expect(draft.structuredContent.version).toBeGreaterThan(1);

    const r = await callToolRaw("context_get", { title: "Gated Doc" }, 731, gid);
    expect(r.structuredContent.body).toContain("APPROVED BODY");
    expect(r.structuredContent.body).not.toContain("DRAFT EDIT");
    // Only the fields the prose reports, none of which claim a version.
    for (const k of Object.keys(r.structuredContent.frontmatter)) {
      expect(["title", "description", "type", "tags"]).toContain(k);
    }
    // "Last edited by" names the version served — the approved v1 — never
    // the pending draft's.
    expect(r.content[0].text).toMatch(/\*\*Last edited by:\*\* \S+ (via \S+ )?\(v1\)/);
  });

  it("context_search: prose unchanged, results[] alongside it", async () => {
    const r = await callToolRaw("context_search", { query: "enterprise" }, 713, sid);
    const body = r.structuredContent.results[0].body;
    expect(r.content).toEqual([
      {
        type: "text",
        text: `Found 1 node(s) matching "enterprise":\n\n1. **Pricing Sheet** [document] #pricing\n   ${body.slice(0, 200).replace(/\n/g, " ")}`,
      },
    ]);
    expect(r.structuredContent.results).toHaveLength(1);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.results[0].id).toBe("nodes/pricing-sheet");
    expect(r.structuredContent.results[0].title).toBe("Pricing Sheet");

    const miss = await callToolRaw("context_search", { query: "nonexistentxyz" }, 714, sid);
    expect(miss.content).toEqual([
      { type: "text", text: 'No nodes matched search: "nonexistentxyz"' },
    ]);
    expect(miss.structuredContent).toEqual({ results: [], count: 0 });
  });

  it("context_query: documents[] + traversal alongside the prose", async () => {
    const r = await callToolRaw("context_query", { query: "#pricing" }, 715, sid);
    // Engine auto-index can return empty on a freshly-created vault (see the
    // plumbing test above), so accept either prose — byte-exact both ways.
    const docs = r.structuredContent.documents;
    expect(r.content[0].text).toBe(
      docs.length
        ? "Found 1 node(s) for `#pricing`:\n\n1. **Pricing Sheet** [document] #pricing"
        : "No nodes matched: #pricing",
    );
    expect(r.structuredContent.traversal).toEqual({
      mode: expect.any(String),
      hops_used: expect.any(Number),
      nodes_traversed: expect.any(Number),
    });
    // source_nodes is deliberately never served — this handler does not gate it.
    expect(r.structuredContent.source_nodes).toBeUndefined();
  });

  it("context_create / context_update / context_delete: prose unchanged, {id, version, status, checkpoint}", async () => {
    const created = await callToolRaw(
      "context_create",
      { title: "Widget Spec", content: "First draft." },
      716,
      sid,
    );
    const status = created.structuredContent.status;
    expect(created.content).toEqual([
      {
        type: "text",
        text: `Created node: **Widget Spec** (nodes/widget-spec) — status: ${status}`,
      },
    ]);
    expect(created.structuredContent).toEqual({
      id: "nodes/widget-spec",
      version: expect.any(Number),
      status,
      // No checkpoint concept on this server — writes go live through review.
      checkpoint: null,
    });

    const updated = await callToolRaw(
      "context_update",
      { title: "Widget Spec", content: "Second draft." },
      717,
      sid,
    );
    expect(updated.content).toEqual([
      {
        type: "text",
        text: `Updated node: **Widget Spec** — v${updated.structuredContent.version}, status: ${updated.structuredContent.status}`,
      },
    ]);
    expect(updated.structuredContent.id).toBe("nodes/widget-spec");
    expect(updated.structuredContent.version).toBeGreaterThan(
      created.structuredContent.version,
    );
    expect(updated.structuredContent.checkpoint).toBeNull();

    const versions = await callToolRaw(
      "context_versions",
      { title: "Widget Spec" },
      718,
      sid,
    );
    expect(versions.content[0].text).toMatch(/^# Version History: Widget Spec\n/);
    expect(versions.structuredContent.id).toBe("nodes/widget-spec");
    expect(versions.structuredContent.versions.length).toBeGreaterThan(0);
    for (const v of versions.structuredContent.versions) {
      // Prose and payload must report the same edit, field for field.
      expect(versions.content[0].text).toContain(
        `- **v${v.version}** ${v.status}`,
      );
      expect(versions.content[0].text).toContain(
        `by ${v.edited_by} at ${v.edited_at}`,
      );
      // No honest equivalent on this server — never faked.
      expect(v.keyframe).toBeUndefined();
      expect(v.content_hash).toBeUndefined();
      expect(v.chain_hash).toBeUndefined();
    }
    expect(versions.structuredContent.keyframe_interval).toBeUndefined();

    const deleted = await callToolRaw(
      "context_delete",
      { id: "nodes/widget-spec" },
      719,
      sid,
    );
    expect(deleted.content).toEqual([
      { type: "text", text: "Deleted node: **Widget Spec** (nodes/widget-spec)" },
    ]);
    expect(deleted.structuredContent).toEqual({
      id: "nodes/widget-spec",
      title: "Widget Spec",
      deleted: true,
    });
  });

  it("an unconverted tool still returns bare prose and no structuredContent", async () => {
    const r = await callToolRaw("context_overview", {}, 720, sid);
    expect(r.content[0].text).toMatch(/^# Vault Overview\n/);
    expect(r.structuredContent).toBeUndefined();
  });
});

// ─── addressing a node by id ──────────────────────────────────────────────
//
// `ctx` addresses nodes by id (`nodes/gtm/deals/win-loss-log`), never by
// title. context_update and context_versions used to REQUIRE title and had no
// id property at all, so `ctx update` / `ctx history` failed schema validation
// before reaching a handler. Both now take id | title, resolved through the
// same `resolveTargetNode` context_delete and context_move already use.

describe("MCP tools/call — id or title addressing", () => {
  let aid: string;

  beforeAll(async () => {
    const created = await jsonRequest(app, "POST", "/nests", {
      name: "Addressing Nest",
    });
    aid = created.data.nest.id;
    const seeded = await jsonRequest(app, "POST", `/nests/${aid}/nodes`, {
      title: "Win Loss Log",
      content: "Round one.",
      folder: "gtm/deals",
    });
    expect(seeded.status).toBe(201);
  });

  it("context_update: by id, the way ctx addresses it", async () => {
    const r = await callToolRaw(
      "context_update",
      { id: "nodes/gtm/deals/win-loss-log", content: "Round two." },
      730,
      aid,
    );
    expect(r.content).toEqual([
      {
        type: "text",
        text: `Updated node: **Win Loss Log** — v${r.structuredContent.version}, status: ${r.structuredContent.status}`,
      },
    ]);
    expect(r.structuredContent.id).toBe("nodes/gtm/deals/win-loss-log");
    expect(r.isError).toBeUndefined();

    const body = await callToolRaw(
      "context_get",
      { id: "nodes/gtm/deals/win-loss-log" },
      731,
      aid,
    );
    expect(body.structuredContent.body).toContain("Round two.");
  });

  it("context_update: by title, unchanged", async () => {
    const r = await callToolRaw(
      "context_update",
      { title: "Win Loss Log", append: "Round three." },
      732,
      aid,
    );
    expect(r.content).toEqual([
      {
        type: "text",
        text: `Updated node: **Win Loss Log** — v${r.structuredContent.version}, status: ${r.structuredContent.status}`,
      },
    ]);
    expect(r.structuredContent.id).toBe("nodes/gtm/deals/win-loss-log");
  });

  it("context_versions: by id and by title reach the same history", async () => {
    const byId = await callToolRaw(
      "context_versions",
      { id: "nodes/gtm/deals/win-loss-log" },
      733,
      aid,
    );
    // No args.title on an id-addressed call — the heading falls back to the
    // resolved node's own title rather than rendering "undefined".
    expect(byId.content[0].text).toMatch(/^# Version History: Win Loss Log\n/);
    expect(byId.structuredContent.id).toBe("nodes/gtm/deals/win-loss-log");
    expect(byId.structuredContent.versions.length).toBeGreaterThan(0);

    const byTitle = await callToolRaw(
      "context_versions",
      { title: "Win Loss Log" },
      734,
      aid,
    );
    expect(byTitle.content).toEqual(byId.content);
    expect(byTitle.structuredContent).toEqual(byId.structuredContent);

    // Both sent: the id wins the resolution, so the heading must name the
    // document it resolved, not the title that was ignored.
    const both = await callToolRaw(
      "context_versions",
      { id: "nodes/gtm/deals/win-loss-log", title: "Some Other Doc" },
      737,
      aid,
    );
    expect(both.content).toEqual(byId.content);
  });

  it("a miss is machine-detectable: isError + {code, message}, prose unchanged", async () => {
    const r = await callToolRaw(
      "context_update",
      { id: "nodes/does-not-exist", content: "x" },
      735,
      aid,
    );
    expect(r.content).toEqual([
      { type: "text", text: "Node not found: nodes/does-not-exist" },
    ]);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "DOCUMENT_NOT_FOUND",
      message: "Node not found: nodes/does-not-exist",
    });
  });

  it("an id cannot traverse out of the nest", async () => {
    // readDocument is join(nestRoot, id + ".md") with no containment of its
    // own, so a `../` id would edit another tenant's file. Refused as a miss.
    const r = await callToolRaw(
      "context_update",
      { id: "../../etc/passwd", content: "x" },
      736,
      aid,
    );
    expect(r.content).toEqual([
      { type: "text", text: "Node not found: ../../etc/passwd" },
    ]);
    expect(r.isError).toBe(true);
  });

  it("context_get: a miss is flagged too — the resolver throws, it never returns null", async () => {
    const r = await callToolRaw("context_get", { title: "Ghost Doc" }, 738, aid);
    expect(r.content).toEqual([
      { type: "text", text: "Node not found: Ghost Doc" },
    ]);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "DOCUMENT_NOT_FOUND",
      message: "Node not found: Ghost Doc",
    });
  });
});

// ─── context_submit_review ────────────────────────────────────────────────
//
// Where `ctx publish` lands on a nest that publishes through review: it finds
// no context_publish advertised, so it routes to context_submit_review and
// prints "submitted, NOT published". That only works if this tool answers in
// the structured channel — a prose-only reply makes the client report a
// contract mismatch, so the feature is inert without it.
//
// There is no operation-catalog shape to conform to (governance is an
// unimplemented namespace in the engine), so the payload is exactly the
// review state this handler already computes.

describe("MCP tools/call — context_submit_review", () => {
  let rid: string;

  beforeAll(async () => {
    const created = await jsonRequest(app, "POST", "/nests", {
      name: "Review Nest",
    });
    rid = created.data.nest.id;
    // A steward, so the reviewers[] half of the payload is exercised against a
    // non-empty roster rather than passing vacuously.
    const steward = await jsonRequest(app, "POST", `/nests/${rid}/stewards`, {
      scope: "nest",
      email: "jane@acme.com",
      role: "reviewer",
    });
    expect(steward.status).toBe(201);
    const seeded = await jsonRequest(app, "POST", `/nests/${rid}/nodes`, {
      title: "Launch Plan",
      content: "Ship on Friday.",
    });
    expect(seeded.status).toBe(201);
  });

  it("prose unchanged, review state alongside it", async () => {
    const r = await callToolRaw("context_submit_review", { title: "Launch Plan" }, 740, rid);
    const d = r.structuredContent;

    // Byte-exact prose — the guard that adding the structured half changed
    // not one character of what a chat client reads.
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          'Submitted "Launch Plan" v1 for review (normal priority).' +
          "\n\n**Stewards who can review:**\n- jane@acme.com (nest-level steward)",
      },
    ]);
    expect(r.isError).toBeUndefined();

    expect(d).toEqual({
      id: "nodes/launch-plan",
      submitted: true,
      review: {
        id: expect.any(String),
        version: 1,
        status: "pending",
        priority: "normal",
        requested_by: expect.any(String),
        requested_at: expect.any(String),
      },
      // Same gated array the steward line above is rendered from.
      reviewers: ["jane@acme.com"],
    });
    // Never faked: this operation writes no version and seals no checkpoint —
    // it points a review request at the version that already existed.
    expect(d.version).toBeUndefined();
    expect(d.checkpoint).toBeUndefined();
  });

  it("a second submit fails loudly rather than reading as a payload", async () => {
    const r = await callToolRaw("context_submit_review", { title: "Launch Plan" }, 741, rid);
    expect(r.content).toEqual([
      { type: "text", text: "Failed to submit: A review is already pending for this node" },
    ]);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "INTERNAL",
      message: "Failed to submit: A review is already pending for this node",
    });
  });

  it("a miss is machine-detectable: isError + {code, message}, prose unchanged", async () => {
    const r = await callToolRaw("context_submit_review", { title: "No Such Node" }, 742, rid);
    expect(r.content).toEqual([{ type: "text", text: "Node not found: No Such Node" }]);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "DOCUMENT_NOT_FOUND",
      message: "Node not found: No Such Node",
    });
  });
});
