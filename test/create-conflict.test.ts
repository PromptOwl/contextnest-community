/**
 * Create-time collisions (CU-wdqcpzxcg8).
 *
 * Two separate guards, one per surface:
 *  - the service refuses a create whose id is already taken — writeDocument
 *    overwrites, so this used to replace the existing document's body and
 *    restart its history behind a 201.
 *  - MCP context_create additionally refuses a title used ANYWHERE in the
 *    vault, because every title-addressed tool would otherwise be ambiguous.
 *    REST keeps allowing the same title in two folders.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import * as versions from "../src/governance/version-service.js";

let env: ReturnType<typeof setupTestEnv>;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callTool(
  app: any,
  nestId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(payload.error).toBeUndefined();
  return payload.result.content.map((c: any) => c.text).join("");
}

beforeAll(() => {
  env = setupTestEnv();
});

afterAll(() => env.cleanup());

describe("REST create — occupied id", () => {
  let app: any;
  let alice: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Briefs" }, alice.apiKey);
    nestId = nest.data.nest.id;
  });

  it("refuses a second create at the same folder + title and keeps the original", async () => {
    const first = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Call Brief", content: "FIRST", folder: "briefs" },
      alice.apiKey,
    );
    expect(first.status).toBe(201);
    expect(first.data.node.id).toBe("nodes/briefs/call-brief");

    const second = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Call Brief", content: "SECOND", folder: "briefs" },
      alice.apiKey,
    );
    expect(second.status).toBe(409);
    expect(String(second.data.error)).toContain("nodes/briefs/call-brief");

    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/briefs/call-brief`,
      undefined,
      alice.apiKey,
    );
    expect(read.status).toBe(200);
    expect(read.data.node.content).toContain("FIRST");
  });

  it("treats a nodes/-prefixed folder as the same occupied location", async () => {
    // The prefix strip and the conflict guard have to agree: "nodes/briefs"
    // must collide with "briefs" rather than slip into nodes/nodes/briefs.
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Call Brief", content: "THIRD", folder: "nodes/briefs" },
      alice.apiKey,
    );
    expect(res.status).toBe(409);
  });

  it("lets exactly one of two concurrent creates win", async () => {
    // Invariant guard, not a repro: on the synchronous SQLite adapter these
    // requests don't actually interleave inside the check→write window, so
    // this passes with or without the per-node lock. Real async I/O
    // (Postgres) does interleave, which is why createNode takes the lock.
    const post = (content: string) =>
      jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Race Brief", content, folder: "briefs" },
        alice.apiKey,
      );
    const results = await Promise.all(
      ["A", "B", "C", "D", "E", "F"].map((tag) => post(`RACER-${tag}`)),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);

    const winner = results.find((r) => r.status === 201)!;
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/briefs/race-brief`,
      undefined,
      alice.apiKey,
    );
    expect(read.status).toBe(200);
    expect(read.data.node.content).toContain(winner.data.node.content.trim());
    // One document, one version — the loser wrote nothing at all.
    const history = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/briefs/race-brief/versions`,
      undefined,
      alice.apiKey,
    );
    expect(history.data.versions).toHaveLength(1);
  });

  it("creates over orphaned version history instead of a duplicate-key error", async () => {
    // Version rows can outlive their document (file removed outside the app,
    // vault re-sync), and deleteNode's purge never ran because the delete
    // 404'd. The create used to reach the version insert and fail with a raw
    // UNIQUE violation on node_versions(nest_id, node_id, version).
    for (const version of [1, 2, 3]) {
      await versions.createVersion({
        nestId,
        nodeId: "nodes/ghost/stale-brief",
        version,
        content: `orphan v${version}`,
        author: "ghost@acme.com",
        status: "approved",
      });
    }

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Stale Brief", content: "fresh start", folder: "ghost" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.id).toBe("nodes/ghost/stale-brief");

    // The dead history is gone — the new document owns the sequence.
    const history = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/ghost/stale-brief/versions`,
      undefined,
      alice.apiKey,
    );
    expect(history.status).toBe(200);
    expect(history.data.versions).toHaveLength(1);
    expect(history.data.versions[0].version).toBe(1);
  });

  it("still allows the same title in a different folder", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Call Brief", content: "ELSEWHERE", folder: "archive" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.id).toBe("nodes/archive/call-brief");
  });
});

describe("MCP context_create — duplicate title", () => {
  let app: any;
  let nestId: string;

  beforeAll(async () => {
    app = await createTestApp("open");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "MCP Briefs" });
    nestId = nest.data.nest.id;
  });

  it("creates under a nodes/-prefixed folder without doubling it", async () => {
    const text = await callTool(app, nestId, "context_create", {
      title: "Micromanager AI Call Brief",
      content: "# Brief",
      folder: "nodes/briefs",
    });
    expect(text).toContain("nodes/briefs/micromanager-ai-call-brief");
    expect(text).not.toContain("nodes/nodes/");
  });

  it("refuses a duplicate title filed elsewhere and names the existing node", async () => {
    const text = await callTool(app, nestId, "context_create", {
      title: "micromanager ai call brief",
      content: "# Placeholder",
      folder: "briefs",
    });
    expect(text).toContain("already exists");
    expect(text).toContain("nodes/briefs/micromanager-ai-call-brief");
    expect(text).toContain("context_update");

    // Nothing was written: the vault still holds exactly one such node.
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`);
    const ids = (list.data.nodes ?? []).map((n: any) => n.id);
    expect(ids.filter((id: string) => id.endsWith("micromanager-ai-call-brief"))).toHaveLength(1);
  });

  it("names the recovery path when the twin is a half-finished create", async () => {
    // A create interrupted after the document was written leaves a node with no
    // version rows. Under stewardship it reads as "not found" and never appears
    // in a draft list, so the generic message pointed at something invisible.
    const dir = join(process.env.DATA_ROOT!, "nests", nestId, "nodes", "playbooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "signal-monitoring-playbook.md"),
      "---\ntitle: Signal Monitoring Playbook\ntype: document\nstatus: published\nversion: 1\ntags: []\n---\n\n# half-written\n",
    );
    const { engineCache } = await import("../src/nodes/engine.js");
    (await engineCache.get(nestId)).invalidateDiscovery();

    const text = await callTool(app, nestId, "context_create", {
      title: "Signal Monitoring Playbook",
      content: "# Retry",
      folder: "playbooks",
    });
    expect(text).toContain("no version history");
    expect(text).toContain("context_delete");
    expect(text).toContain("nodes/playbooks/signal-monitoring-playbook");
  });

  it("refuses the twin even when both creates target different folders at once", async () => {
    // Two twins land on DIFFERENT ids, so createNode's per-id lock can't see
    // the collision — the scan and the create share one nest-wide key instead.
    const texts = await Promise.all(
      ["one", "two", "three"].map((folder) =>
        callTool(app, nestId, "context_create", {
          title: "Concurrent Brief",
          content: `# From ${folder}`,
          folder,
        }),
      ),
    );

    expect(texts.filter((t) => t.startsWith("Created node:"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("already exists"))).toHaveLength(2);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`);
    const ids = (list.data.nodes ?? []).map((n: any) => n.id);
    expect(ids.filter((id: string) => id.endsWith("concurrent-brief"))).toHaveLength(1);
  });
});
