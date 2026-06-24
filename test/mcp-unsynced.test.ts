/**
 * MCP unsynced-folder tools — exercises context_unsynced_list +
 * context_sync_folder via JSON-RPC. Mirrors test/unsynced-folder.test.ts but
 * drives the same underlying service through the MCP transport.
 *
 * Open mode skips the admin-only gate so a regular registered user can
 * exercise the tool surface (same as the REST test).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
} from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const writeMd = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
};

async function mcpCall(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  id = 100,
): Promise<string> {
  const res = await mcpCall("tools/call", { name, arguments: args }, id);
  expect(res.error).toBeUndefined();
  return res.result.content.map((c: any) => c.text).join("");
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");

  // Need a nest to scope the MCP endpoint at; the tools themselves are
  // nest-agnostic (they operate on DATA_ROOT) but the route is /nests/:nestId/mcp.
  const create = await jsonRequest(app, "POST", "/nests", {
    name: "MCP Unsynced Host",
  });
  nestId = create.data.nest.id;

  // Seed starter-like layout under DATA_ROOT — same shape the REST test uses.
  writeMd(
    join(env.dataDir, "loose", "doc-l.md"),
    "---\ntitle: Loose\ntype: document\n---\nloose body\n",
  );
  writeMd(
    join(env.dataDir, "nodes", "architecture", "doc-a.md"),
    "---\ntitle: Doc A\ntype: document\n---\nbody a\n",
  );
  writeMd(
    join(env.dataDir, "nodes", "standards", "doc-b.md"),
    "---\ntitle: Doc B\ntype: document\n---\nbody b\n",
  );
});

afterAll(() => env.cleanup());

describe("MCP — unsynced folder tools are registered", () => {
  it("tools/list includes context_unsynced_list + context_sync_folder", async () => {
    const res = await mcpCall("tools/list", {});
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_unsynced_list");
    expect(names).toContain("context_sync_folder");
  });
});

describe("MCP — context_unsynced_list", () => {
  it("returns every leaf folder with md, slash-paths and counts", async () => {
    const text = await callTool("context_unsynced_list");
    // "Host" nest's data dir lives under DATA_ROOT/nests/<id>, which is
    // reserved → never surfaces. Only the seeded loose + nodes/* leaves do.
    expect(text).toContain("loose");
    expect(text).toContain("nodes/architecture");
    expect(text).toContain("nodes/standards");
    expect(text).toMatch(/1 md file\(s\)/);
  });
});

describe("MCP — context_sync_folder", () => {
  it("converts a nested leaf into a real nest and removes the source", async () => {
    const text = await callTool(
      "context_sync_folder",
      { name: "nodes/architecture" },
      200,
    );
    expect(text).toMatch(/Synced folder "nodes\/architecture"/);
    expect(text).toMatch(/nest \*\*architecture\*\*/);
    expect(text).toMatch(/1 document\(s\)/);

    // Source leaf gone; sibling leaf still present.
    expect(existsSync(join(env.dataDir, "nodes", "architecture"))).toBe(false);
    expect(existsSync(join(env.dataDir, "nodes", "standards"))).toBe(true);

    // Listing now reflects the removal — architecture leaf is gone.
    const after = await callTool("context_unsynced_list", {}, 201);
    expect(after).not.toContain("nodes/architecture");
    expect(after).toContain("nodes/standards");
    expect(after).toContain("loose");
  });

  it("rejects unsafe folder names with a user-facing error", async () => {
    for (const bad of ["nests", ".hidden", "../escape", "nodes/../escape"]) {
      const text = await callTool("context_sync_folder", { name: bad }, 300);
      expect(text.toLowerCase()).toMatch(
        /failed to sync folder|invalid folder name|not eligible/,
      );
    }
  });

  it("reports a friendly error when the folder does not exist", async () => {
    const text = await callTool(
      "context_sync_folder",
      { name: "nothing-here" },
      400,
    );
    expect(text).toMatch(/Failed to sync folder/);
    expect(text).toMatch(/not found/i);
  });

  it("rejects missing name at the MCP transport (Zod required-arg gate)", async () => {
    const res = await mcpCall(
      "tools/call",
      { name: "context_sync_folder", arguments: {} },
      500,
    );
    // Required arg → JSON-RPC -32602 from the transport before the handler runs.
    const failed =
      !!res.error ||
      res.result?.isError === true ||
      (res.result?.content?.[0]?.text || "")
        .toLowerCase()
        .includes("invalid");
    expect(failed).toBe(true);
  });
});
