/**
 * MCP-surface port of the OSS concurrent-writes regression
 * (packages/cli/src/__tests__/concurrent-writes.regression.test.ts),
 * same-node case. Community seals no checkpoints, so the faithful
 * translation of "checkpoint advanced by exactly N + verify clean" is:
 * contiguous duplicate-free version numbers, every version reconstructable
 * (a broken chain returns content: null), and a drift scan that stages
 * nothing.
 *
 * The N-different-nodes case is deliberately deferred to the engine release
 * that ships the per-vault write lock: distinct nodes bypass the in-process
 * per-node lock and race the nest-wide index regeneration, which only the
 * vault lock serializes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let nodeId: string;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const dataLine = text.split("\n").find((l: string) => l.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "MCP Concurrency Nest",
  });
  nestId = created.data.nest.id;
  const node = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "MCP Race Doc",
    content: "# base\n\nbody",
  });
  nodeId = node.data.node.id;
});

afterAll(() => env.cleanup());

describe("concurrent MCP writes", () => {
  it("serializes a burst of context_update calls into a clean history", async () => {
    const before = (
      await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}/versions`)
    ).data.currentVersion;

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        callTool(
          "context_update",
          { id: nodeId, content: `# base\n\nmcp edit ${i}` },
          100 + i,
        ),
      ),
    );

    // Every call succeeded and produced its own version.
    const versionsSeen: number[] = [];
    for (const body of results) {
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBeFalsy();
      expect(body.result.structuredContent.version).toBeTypeOf("number");
      versionsSeen.push(body.result.structuredContent.version);
    }
    const sorted = [...versionsSeen].sort((a, b) => a - b);
    expect(new Set(sorted).size).toBe(N);
    expect(sorted[N - 1] - sorted[0]).toBe(N - 1);

    const after = (
      await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}/versions`)
    ).data;
    expect(after.currentVersion).toBe(before + N);

    // Integrity: every recorded version still reconstructs, and every
    // concurrent body landed in some version.
    const contents: string[] = [];
    for (const v of after.versions.map((row: any) => row.version)) {
      const rec = await jsonRequest(
        app,
        "GET",
        `/nests/${nestId}/nodes/${nodeId}/versions/${v}`,
      );
      expect(rec.status).toBe(200);
      expect(rec.data.content).not.toBeNull();
      contents.push(rec.data.content);
    }
    for (let i = 0; i < N; i++) {
      expect(contents.some((body) => body.includes(`mcp edit ${i}`))).toBe(true);
    }

    // Drift scan stages nothing: disk and recorded checksums agree.
    const scan = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/external-edits/scan`,
      {},
    );
    expect(scan.status).toBe(200);
    expect(scan.data.staged).toBe(0);
  });
});
