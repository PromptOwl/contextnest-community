/**
 * Every MCP tool declares its effects (readOnlyHint, destructiveHint,
 * openWorldHint) on every endpoint and for every kind of key, and the
 * classification in src/mcp/annotations.ts stays complete. OpenAI's app review
 * reads these from tools/list, and clients use them to warn before a call.
 *
 * The sets below are written out by hand on purpose: they are the reviewed
 * classification, so a change to src/mcp/annotations.ts has to change them too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

type Tool = { name: string; annotations?: Record<string, unknown> };

/** Only reads: nothing in the nest or the server changes. */
const READ_ONLY = [
  "nest_index",
  "context_init",
  "context_instructions_history",
  "context_overview",
  "context_search",
  "context_query",
  "context_table_query",
  "context_get",
  "context_list",
  "context_resolve",
  "context_export",
  "context_comments",
  "context_relations",
  "context_boards",
  "context_board_items",
  "context_fields",
  "context_stewards",
  "context_deletion_queue",
  "context_access_requests",
  "context_review_queue",
  "context_my_drafts",
  "context_versions",
  "context_unsynced_list",
  "context_metacognition_list",
  "context_metacognition_suggest",
  "context_metacognition_preview",
  "workflow_run_get",
  "workflow_runs_list",
  "workflow_edges_list",
  "context_surfaces_status",
  "context_surfaces_bindings_list",
  "context_surfaces_binding_preview",
  "context_surfaces_links_list",
  "context_surfaces_link_reviews_list",
  "context_surfaces_settings_get",
  "context_surfaces_windows_list",
  "context_surfaces_proposals_list",
  "context_surfaces_my_pending",
  "context_surfaces_commits_list",
  "context_surfaces_budget_get",
  "context_surfaces_seed_list",
  "context_surfaces_seed_status",
];

/** Can overwrite or remove something that already exists. */
const DESTRUCTIVE = [
  "context_instructions_update",
  "context_table_rows",
  "context_remove_relation",
  "context_upload",
  "context_update",
  "context_delete",
  "context_bulk_update",
  "context_update_field",
  "context_delete_field",
  "context_resolve_deletion",
  "context_approve",
  "context_grant",
  "context_sync_folder",
  "context_headless",
  "context_set_visibility",
  "context_systems",
  "context_metacognition_configure",
  "context_metacognition_run",
  "context_metacognition_remove",
  "workflow_run_close",
  "workflow_edge_delete",
  "workflow_edge_type_upsert",
  "workflow_edge_type_delete",
  "context_surfaces_binding_update",
  "context_surfaces_binding_delete",
  "context_surfaces_binding_recheck",
  "context_surfaces_link_revoke",
  "context_surfaces_link_unblock",
  "context_surfaces_settings_update",
  "context_surfaces_budget_update",
  "context_surfaces_disconnect",
  "context_surfaces_seed_apply",
];

/** Reaches outside the nest: arbitrary URLs and addresses, the public, or a third-party workspace. */
const OPEN_WORLD = [
  "context_upload",
  "context_share_nest",
  "context_grant",
  "context_assign_steward",
  "context_set_visibility",
  "context_metacognition_configure",
  "context_metacognition_run",
  "context_surfaces_binding_preview",
  "context_surfaces_binding_create",
  "context_surfaces_binding_update",
  "context_surfaces_binding_delete",
  "context_surfaces_binding_recheck",
  "context_surfaces_binding_resume",
  "context_surfaces_binding_invite",
  "context_surfaces_link_revoke",
  "context_surfaces_settings_update",
  "context_surfaces_disconnect",
  "context_surfaces_seed_apply",
];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let ownerKey: string;
let readKey: string;
let headlessKey: string;
let systemKey: string;
let nestId: string;

async function listTools(path: string, key: string): Promise<Tool[]> {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const line = raw.split("\n").find((l: string) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice("data: ".length) : raw);
  return body.result.tools;
}

/** Every endpoint against every kind of key. */
function surfaces(): Array<[string, string, string]> {
  return [
    ["owner, per-nest", `/nests/${nestId}/mcp`, ownerKey],
    ["owner, server-level", "/mcp", ownerKey],
    ["read-only key, per-nest", `/nests/${nestId}/mcp`, readKey],
    ["read-only key, server-level", "/mcp", readKey],
    ["headless key, per-nest", `/nests/${nestId}/mcp`, headlessKey],
    ["headless key, server-level", "/mcp", headlessKey],
    ["system key, per-nest", `/nests/${nestId}/mcp`, systemKey],
    ["system key, server-level", "/mcp", systemKey],
  ];
}

function expectAnnotated(label: string, tools: Tool[]) {
  expect(tools.length, label).toBeGreaterThan(0);
  for (const t of tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
      expect(typeof t.annotations?.[hint], `${label}: ${t.name}.${hint}`).toBe("boolean");
    }
  }
}

async function allDefinedNames(): Promise<string[]> {
  const { TOOL_DEFINITIONS } = await import("../src/mcp/tools.js");
  const { SERVER_TOOL_DEFINITIONS } = await import("../src/mcp/server-routes.js");
  const { WORKFLOW_TOOL_DEFINITIONS } = await import("../src/mcp/workflow-tools.js");
  const { METACOGNITION_TOOL_DEFINITIONS } = await import("../src/mcp/metacognition-tools.js");
  const { SURFACES_TOOL_DEFINITIONS } = await import("../src/mcp/surfaces-tools.js");
  const all = [
    ...TOOL_DEFINITIONS,
    ...SERVER_TOOL_DEFINITIONS,
    ...WORKFLOW_TOOL_DEFINITIONS,
    ...METACOGNITION_TOOL_DEFINITIONS,
    ...SURFACES_TOOL_DEFINITIONS,
  ];
  return [...new Set(all.map((t) => t.name))].sort();
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  const owner = await registerUser(app, "owner@annotations.test", "Owner");
  await resetAuthRateLimit();
  ownerKey = owner.apiKey;
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Annotated" }, ownerKey)).data.nest.id;

  const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, ownerKey);
  expect(ro.status).toBeLessThan(300);
  readKey = ro.data.key ?? ro.data.apiKey ?? ro.data.api_key;
  expect(readKey).toBeTruthy();

  const sys = await jsonRequest(app, "POST", "/systems", { name: "Sync bot", capability: "write", nest_ids: [nestId] }, ownerKey);
  expect(sys.status).toBe(201);
  systemKey = sys.data.api_key;

  const { createHeadlessKey, setNestHeadless } = await import("../src/auth/headless.js");
  await setNestHeadless(nestId, true);
  const made = (await createHeadlessKey(nestId, "Buyer", owner.userId)) as any;
  headlessKey = made.apiKey ?? made.value?.apiKey;
  expect(headlessKey).toBeTruthy();
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.FEATURE_SURFACES;
  await env.cleanup();
});

describe("tools/list on every endpoint, for every key", () => {
  it("carries all three hints as booleans on every tool", async () => {
    for (const [label, path, key] of surfaces()) expectAnnotated(label, await listTools(path, key));
  });

  it("keeps them with the feature flags off", async () => {
    for (const flag of ["FEATURE_SURFACES", "FEATURE_METACOGNITION", "FEATURE_WORKFLOW_PLANE"]) {
      process.env[flag] = "false";
      try {
        for (const [label, path, key] of surfaces()) expectAnnotated(`${flag} off, ${label}`, await listTools(path, key));
      } finally {
        process.env[flag] = "true";
      }
    }
  });

  it("gives a tool the same hints on both endpoints", async () => {
    const perNest = new Map((await listTools(`/nests/${nestId}/mcp`, ownerKey)).map((t) => [t.name, t.annotations]));
    for (const t of await listTools("/mcp", ownerKey)) {
      if (perNest.has(t.name)) expect(t.annotations, t.name).toEqual(perNest.get(t.name));
    }
  });

  it("matches the ticket's QA samples", async () => {
    const tools = await listTools("/mcp", ownerKey);
    const hints = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(hints("context_search")).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(hints("context_delete")).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  it("offers a headless key only read-only, closed-world tools", async () => {
    for (const path of [`/nests/${nestId}/mcp`, "/mcp"]) {
      for (const t of await listTools(path, headlessKey)) {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      }
    }
  });

  it("offers a read-only key nothing that can overwrite or remove", async () => {
    for (const path of [`/nests/${nestId}/mcp`, "/mcp"]) {
      for (const t of await listTools(path, readKey)) {
        expect(t.annotations?.destructiveHint, t.name).toBe(false);
        // The one exception: it seeds the stock edge types the first time it is called.
        if (t.name !== "workflow_edge_types_list") expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      }
    }
  });
});

describe("the classification", () => {
  it("is exactly the reviewed one, for every defined tool", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    const pick = (hint: "readOnlyHint" | "destructiveHint" | "openWorldHint") =>
      Object.entries(TOOL_CLASSIFICATION).filter(([, c]) => c[hint]).map(([n]) => n).sort();
    expect(pick("readOnlyHint")).toEqual([...READ_ONLY].sort());
    expect(pick("destructiveHint")).toEqual([...DESTRUCTIVE].sort());
    expect(pick("openWorldHint")).toEqual([...OPEN_WORLD].sort());
  });

  it("never calls a tool both read-only and destructive", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    for (const [name, c] of Object.entries(TOOL_CLASSIFICATION)) {
      expect(c.readOnlyHint && c.destructiveHint, name).toBe(false);
    }
  });

  it("gives every tool a reason", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    for (const [name, c] of Object.entries(TOOL_CLASSIFICATION)) {
      expect(c.why.trim().length, name).toBeGreaterThan(10);
    }
  });

  // The guard. Adding a tool without classifying it fails the first check;
  // removing or renaming one and leaving its row behind fails the second.
  it("has a row for every defined tool, and no stale rows", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    const defined = await allDefinedNames();
    const classified = Object.keys(TOOL_CLASSIFICATION);
    expect(defined.filter((n) => !classified.includes(n)), "tools with no classification").toEqual([]);
    expect(classified.filter((n) => !defined.includes(n)), "stale classification rows").toEqual([]);
  });

  it("lists every defined tool to a nest owner with the flags on, so the guard sees what clients see", async () => {
    const listed = new Set([
      ...(await listTools(`/nests/${nestId}/mcp`, ownerKey)).map((t) => t.name),
      ...(await listTools("/mcp", ownerKey)).map((t) => t.name),
    ]);
    expect([...listed].sort()).toEqual(await allDefinedNames());
  });

  it("treats an unclassified name as the most cautious case rather than as safe", async () => {
    const { toolAnnotations } = await import("../src/mcp/annotations.js");
    expect(toolAnnotations("context_not_a_real_tool")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});
