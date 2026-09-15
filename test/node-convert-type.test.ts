/**
 * PATCH /nodes with `type` re-types an existing node — the editor's "Convert
 * to…" action. The engine's context_update has accepted `type` for a while;
 * the Community update path just never forwarded it, so a document could only
 * be born an agent or a table, never become one.
 *
 * Same gate as create: the accepted set, the artifact/table feature flags,
 * and the runnable-only schedule rule (converting away from a runnable type
 * drops its schedule rather than leaving an orphaned one behind).
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Convert" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

const create = (title: string, extra: Record<string, unknown> = {}) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}`, ...extra }, alice.apiKey);
const patch = (id: string, body: Record<string, unknown>) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, body, alice.apiKey);
const read = async (id: string) => {
  const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, alice.apiKey);
  expect(res.status).toBe(200);
  return res.data.node ?? res.data;
};

describe("convert a node's type", () => {
  it("a document becomes an agent, and reads back as one", async () => {
    expect((await create("Ops Runbook")).status).toBe(201);
    const res = await patch("nodes/ops-runbook", { type: "agent" });
    expect(res.status).toBe(200);
    expect((await read("nodes/ops-runbook")).type).toBe("agent");
  });

  it("a document becomes a table, keeping its body and tags", async () => {
    expect((await create("Prices", { tags: ["pricing"] })).status).toBe(201);
    expect((await patch("nodes/prices", { type: "table" })).status).toBe(200);
    const node = await read("nodes/prices");
    expect(node.type).toBe("table");
    expect(node.content).toContain("# Prices");
    expect(node.tags).toEqual(["#pricing"]);
  });

  it("a document becomes a skill without the caller supplying a trigger", async () => {
    // Create defaults the trigger from the title; convert does the same, so
    // the same UI action works for every target type.
    expect((await create("Summarize Deal")).status).toBe(201);
    expect((await patch("nodes/summarize-deal", { type: "skill" })).status).toBe(200);
    expect((await read("nodes/summarize-deal")).type).toBe("skill");
  });

  it("converting away from a runnable type drops its schedule", async () => {
    expect((await create("Nightly", { type: "agent", schedule: "0 6 * * *" })).status).toBe(201);
    expect((await read("nodes/nightly")).schedule).toBe("0 6 * * *");
    expect((await patch("nodes/nightly", { type: "document" })).status).toBe(200);
    const node = await read("nodes/nightly");
    expect(node.type).toBe("document");
    expect(node.schedule ?? null).toBeNull();
  });

  it("rejects an unknown type with a 400, and leaves the node alone", async () => {
    expect((await create("Stays")).status).toBe(201);
    const res = await patch("nodes/stays", { type: "spreadsheet" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/unknown node type/i);
    expect((await read("nodes/stays")).type).toBe("document");
  });

  it("a patch without type never touches the type", async () => {
    // Regression guard for the editor's ordinary save, which sends title,
    // content and tags but no type.
    expect((await patch("nodes/ops-runbook", { content: "# Ops Runbook\n\nedited" })).status).toBe(200);
    expect((await read("nodes/ops-runbook")).type).toBe("agent");
  });
});
