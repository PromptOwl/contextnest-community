/**
 * Per-nest MCP permission matrix — every role class against the transport
 * and the tool-level gates.
 *
 * The transport (POST /nests/:id/mcp) is read-tier: MCP is always POST, so
 * the middleware admits anyone with nest read; mutating tools enforce their
 * own permission inside runTool. Denials at the middleware come back as
 * JSON-RPC error envelopes so MCP clients show the reason instead of a
 * generic "no tools found".
 *
 * Roles covered:
 *   owner / admin / write / read  — collaborator tiers
 *   read + reviewer steward       — can approve, cannot create
 *   read + editor steward (nest)  — can create, cannot approve
 *   stranger (no access)          — 404 JSON-RPC
 *   nest-scoped key, wrong nest   — 403 JSON-RPC
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let sideNestId: string;

let owner: User;
let admin: User;
let writer: User;
let reader: User;
let reviewer: User; // read collab + nest-scope reviewer steward
let editorStew: User; // read collab + nest-scope editor steward
let stranger: User;
let scopedKey: string; // owner-2's key, scoped to sideNest

async function mcpCall(
  apiKey: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
  targetNest: string = nestId,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/nests/${targetNest}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json"))
    return { status: res.status, body: await res.json() };
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  return {
    status: res.status,
    body: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text,
  };
}

async function callTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  id = 100,
): Promise<string> {
  const { status, body } = await mcpCall(
    apiKey,
    "tools/call",
    { name, arguments: args },
    id,
  );
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  return body.result.content.map((c: any) => c.text).join("");
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");

  // 8 registrations from one test IP — clear the 3/hr register limit between
  // batches (see REGISTER_LIMIT in src/auth/routes.ts).
  owner = await registerUser(app, "owner@acme.com", "Owner");
  admin = await registerUser(app, "admin@acme.com", "Admin");
  writer = await registerUser(app, "writer@acme.com", "Writer");
  await resetAuthRateLimit();
  reader = await registerUser(app, "reader@acme.com", "Reader");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  editorStew = await registerUser(app, "editor-steward@acme.com", "EditorStew");
  await resetAuthRateLimit();
  stranger = await registerUser(app, "stranger@acme.com", "Stranger");

  const nest = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Matrix Nest" },
    owner.apiKey,
  );
  nestId = nest.data.nest.id;

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Runbook", content: "# Runbook\n\nSteps.", tags: ["ops"] },
    owner.apiKey,
  );

  for (const [user, permission] of [
    [admin, "admin"],
    [writer, "write"],
    [reader, "read"],
    [reviewer, "read"],
    [editorStew, "read"],
  ] as const) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: user.email, permission },
      owner.apiKey,
    );
  }

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    {
      scope: "nest",
      users: [
        { email: reviewer.email, role: "reviewer" },
        { email: editorStew.email, role: "editor" },
      ],
    },
    owner.apiKey,
  );

  // Pending review for the approve cases.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Draft Doc", content: "# Draft\n\nNeeds review." },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${encodeURIComponent("nodes/draft-doc")}/submit-review`,
    {},
    owner.apiKey,
  );

  // Second owner with a key scoped to their OWN nest — used against Matrix
  // Nest to exercise the wrong-scope denial.
  const owner2 = await registerUser(app, "owner2@acme.com", "Owner2");
  const side = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Side Nest" },
    owner2.apiKey,
  );
  sideNestId = side.data.nest.id;
  const rotate = await app.request("/auth/keys/rotate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${owner2.apiKey}`,
    },
    body: JSON.stringify({ nest_id: sideNestId }),
  });
  scopedKey = (await rotate.json()).api_key;
});

afterAll(() => env.cleanup());

describe("MCP transport access — tools/list per role", () => {
  it.each([
    ["owner", () => owner],
    ["admin collaborator", () => admin],
    ["write collaborator", () => writer],
    ["read collaborator", () => reader],
    ["reviewer steward (read collab)", () => reviewer],
    ["editor steward (read collab)", () => editorStew],
  ])("%s can list tools", async (_label, who) => {
    const { status, body } = await mcpCall(who().apiKey, "tools/list", {});
    expect(status).toBe(200);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_get");
    expect(names).toContain("context_create");
  });

  it.each([
    ["owner", () => owner],
    ["admin collaborator", () => admin],
    ["write collaborator", () => writer],
    ["read collaborator", () => reader],
    ["reviewer steward (read collab)", () => reviewer],
    ["editor steward (read collab)", () => editorStew],
  ])("%s can call a read tool", async (_label, who) => {
    const text = await callTool(who().apiKey, "context_get", {
      title: "Runbook",
    });
    expect(text).toContain("Runbook");
  });
});

describe("context_create — write gate per role", () => {
  it.each([
    ["owner", () => owner, "By Owner"],
    ["admin collaborator", () => admin, "By Admin"],
    ["write collaborator", () => writer, "By Writer"],
    ["editor steward (read collab)", () => editorStew, "By Editor Steward"],
  ])("%s can create", async (_label, who, title) => {
    const text = await callTool(who().apiKey, "context_create", {
      title,
      content: "created via MCP",
    });
    expect(text).toContain("Created node");
  });

  it.each([
    ["read collaborator", () => reader],
    ["reviewer steward (read collab)", () => reviewer],
  ])("%s is denied with a clear message", async (_label, who) => {
    const text = await callTool(who().apiKey, "context_create", {
      title: "Sneak",
      content: "nope",
    });
    expect(text).toMatch(/don't have permission to create/i);
  });
});

describe("context_delete — write gate per role", () => {
  // Denials first: they must not consume the node the allowed case deletes.
  it.each([
    ["read collaborator", () => reader],
    ["reviewer steward (read collab)", () => reviewer],
  ])("%s is denied with a clear message", async (_label, who) => {
    const text = await callTool(who().apiKey, "context_delete", {
      title: "By Owner",
    });
    expect(text).toMatch(/don't have permission to delete/i);
  });

  it("write collaborator can delete, and the node is gone", async () => {
    const text = await callTool(writer.apiKey, "context_delete", {
      title: "By Owner",
    });
    expect(text).toContain("Deleted node");
    const gone = await callTool(writer.apiKey, "context_delete", {
      title: "By Owner",
    });
    expect(gone).toMatch(/Node not found/i);
  });
});

describe("context_move — write gate per role", () => {
  it.each([
    ["read collaborator", () => reader],
    ["reviewer steward (read collab)", () => reviewer],
  ])("%s is denied with a clear message", async (_label, who) => {
    const text = await callTool(who().apiKey, "context_move", {
      title: "By Admin",
      folder: "archive",
    });
    expect(text).toMatch(/don't have permission to move/i);
  });

  it("write collaborator can move, and the node answers at its new id", async () => {
    const text = await callTool(writer.apiKey, "context_move", {
      title: "By Admin",
      folder: "archive",
    });
    expect(text).toContain("Moved");
    expect(text).toContain("nodes/archive/by-admin");

    const again = await callTool(writer.apiKey, "context_move", {
      id: "nodes/archive/by-admin",
      folder: "archive",
    });
    expect(again).toMatch(/already at/i);
  });
});

describe("context_approve — governance gate per role", () => {
  // Order matters: denied attempts run BEFORE the reviewer resolves the
  // single pending review.
  it("editor steward cannot approve", async () => {
    const text = await callTool(editorStew.apiKey, "context_approve", {
      title: "Draft Doc",
    });
    expect(text).toMatch(/^Cannot approve:/);
  });

  it("read collaborator (non-steward) cannot approve", async () => {
    const text = await callTool(reader.apiKey, "context_approve", {
      title: "Draft Doc",
    });
    expect(text).toMatch(/^Cannot approve:/);
  });

  it("reviewer steward can approve", async () => {
    const text = await callTool(reviewer.apiKey, "context_approve", {
      title: "Draft Doc",
    });
    expect(text).toContain("Approved");
  });
});

describe("MCP transport denials — JSON-RPC envelope with reason", () => {
  it("stranger (no collaborator row) gets 404 + explanation", async () => {
    const { status, body } = await mcpCall(
      stranger.apiKey,
      "tools/list",
      {},
      7,
    );
    expect(status).toBe(404);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/Nest not found — .*share the nest/i);
  });

  it("nest-scoped key against another nest gets 403 + scope explanation", async () => {
    const { status, body } = await mcpCall(scopedKey, "tools/list", {}, 8);
    expect(status).toBe(403);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(8);
    expect(body.error.message).toMatch(/scoped to nest/i);
    expect(body.error.message).toContain(sideNestId);
  });

  it("same scoped key works on its own nest", async () => {
    const { status, body } = await mcpCall(
      scopedKey,
      "tools/list",
      {},
      9,
      sideNestId,
    );
    expect(status).toBe(200);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  // Regression for the ConnectModal key-scope trap: rotating with
  // nest_id: null must CLEAR the per-nest scope (omitting the field keeps
  // it), so a key minted by an older scoped build can be un-scoped.
  it("rotate with nest_id: null clears the scope", async () => {
    // owner2's second nest — the scoped key can't reach it (403)...
    const second = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Side Nest 2" },
      scopedKey,
    );
    // (creating a nest is not nest-scoped; if this ever 403s, adjust)
    expect(second.status).toBe(201);
    const secondId = second.data.nest.id;
    const blocked = await mcpCall(scopedKey, "tools/list", {}, 10, secondId);
    expect(blocked.status).toBe(403);

    // ...rotate to user-level, and the fresh key reaches both nests.
    const rotate = await app.request("/auth/keys/rotate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scopedKey}`,
      },
      body: JSON.stringify({ nest_id: null }),
    });
    const userKey = (await rotate.json()).api_key;
    for (const target of [sideNestId, secondId]) {
      const { status } = await mcpCall(userKey, "tools/list", {}, 11, target);
      expect(status).toBe(200);
    }
  });
});
