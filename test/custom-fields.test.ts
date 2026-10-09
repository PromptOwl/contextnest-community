/**
 * Custom fields — nest-level definitions, node-level values.
 *
 * Locked here:
 *   1. Definition CRUD over REST and MCP, and who may do it: the owner, a nest
 *      admin, and a nest-wide reviewer steward — never a write/read
 *      collaborator or an editor steward. Everyone who reads the nest reads
 *      the definitions.
 *   2. Every value type validates on REST create/update AND MCP
 *      context_create/context_update; unknown keys, wrong node types,
 *      computed fields and cleared required fields are refused.
 *   3. Defaults and required on create; presets (estimate, time_in_status).
 *   4. A value change is a governed edit: new version, new checksum, the
 *      value in the stored frontmatter.
 *   5. Time in status counts from moved_at (else created_at), restarts on a
 *      column move, and is read-only.
 *   6. Filtering the list by select / multi_select / user / checkbox / none,
 *      on REST and MCP, and the field values in MCP get/list output.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import {
  addComputedFields,
  formatDuration,
  matchesFieldFilter,
  timeInStatusSeconds,
  type FieldDefinition,
} from "../src/nodes/custom-fields.js";
import { cleanConfig } from "../src/nests/board-service.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** The engine's history.yaml for a node — the hash chain. */
function historyOf(slug: string): string {
  const walk = (dir: string): string | null => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (e === "history.yaml" && p.includes(slug)) {
        return p;
      }
    }
    return null;
  };
  const found = walk(join(env.dataDir, "nests", nestId));
  if (!found) throw new Error(`no history for ${slug}`);
  return readFileSync(found, "utf8");
}
const chainHashes = (yaml: string) => [...yaml.matchAll(/chain_hash:\s*["']?(sha256:[0-9a-f]+)/g)].map((m) => m[1]);

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let owner: User;
let admin: User;
let writer: User;
let reader: User;
let reviewer: User; // read collaborator + nest-wide reviewer steward
let editorStew: User; // read collaborator + nest-wide editor steward

const fieldsUrl = () => `/nests/${nestId}/fields`;
const createField = (u: User, body: Record<string, unknown>) =>
  jsonRequest(app, "POST", fieldsUrl(), body, u.apiKey);
const createNode = (u: User, body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { content: "notes", type: "task", ...body }, u.apiKey);
const patchNode = (u: User, slug: string, body: Record<string, unknown>) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/${slug}`, body, u.apiKey);
async function getNode(slug: string) {
  const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/${slug}`, undefined, owner.apiKey);
  return data.node;
}
async function list(query = "") {
  const { status, data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes${query}`, undefined, owner.apiKey);
  return { status, data };
}

let rpc = 1;
async function mcp(u: User, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${u.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : text;
  }
  const result = body.result;
  return {
    text: (result?.content ?? []).map((c: any) => c.text).join(""),
    data: result?.structuredContent,
    isError: !!result?.isError,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  admin = await registerUser(app, "admin@acme.com", "Admin");
  writer = await registerUser(app, "writer@acme.com", "Writer");
  await resetAuthRateLimit();
  reader = await registerUser(app, "reader@acme.com", "Reader");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  editorStew = await registerUser(app, "editor@acme.com", "Editor");
  await resetAuthRateLimit();

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Fields" }, owner.apiKey);
  nestId = data.nest.id;
  for (const [u, permission] of [
    [admin, "admin"],
    [writer, "write"],
    [reader, "read"],
    [reviewer, "read"],
    [editorStew, "read"],
  ] as const) {
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
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
});

afterAll(() => env.cleanup());

describe("field definitions — CRUD and who may do it", () => {
  it("the owner defines a select field; it lists for any reader", async () => {
    const { status, data } = await createField(owner, {
      key: "severity",
      label: "Severity",
      type: "select",
      options: ["low", "high", "critical"],
    });
    expect(status).toBe(201);
    expect(data.field).toMatchObject({
      key: "severity",
      type: "select",
      options: ["low", "high", "critical"],
      applies_to: ["task"],
      required: false,
    });
    const read = await jsonRequest(app, "GET", fieldsUrl(), undefined, reader.apiKey);
    expect(read.status).toBe(200);
    expect(read.data.fields.map((f: any) => f.key)).toContain("severity");
    expect(read.data.can_manage).toBe(false);
  });

  it("a nest admin and a nest-wide reviewer steward may define fields", async () => {
    expect((await createField(admin, { key: "area", label: "Area", type: "multi_select", options: ["ui", "api", "docs"] })).status).toBe(201);
    expect((await createField(reviewer, { key: "owner_person", label: "Owner", type: "user" })).status).toBe(201);
    const asReviewer = await jsonRequest(app, "GET", fieldsUrl(), undefined, reviewer.apiKey);
    expect(asReviewer.data.can_manage).toBe(true);
  });

  it("write and read collaborators and editor stewards may not", async () => {
    for (const u of [writer, reader, editorStew]) {
      const { status } = await createField(u, { key: "nope", label: "Nope", type: "text" });
      expect(status).toBe(403);
    }
    const sev = (await jsonRequest(app, "GET", fieldsUrl(), undefined, owner.apiKey)).data.fields.find((f: any) => f.key === "severity");
    expect((await jsonRequest(app, "PATCH", `${fieldsUrl()}/${sev.id}`, { label: "X" }, writer.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "DELETE", `${fieldsUrl()}/${sev.id}`, undefined, writer.apiKey)).status).toBe(403);
  });

  it("refuses bad definitions", async () => {
    expect((await createField(owner, { key: "Bad Key", label: "x", type: "text" })).status).toBe(400);
    expect((await createField(owner, { key: "s2", label: "x", type: "select" })).status).toBe(400);
    expect((await createField(owner, { key: "t2", label: "x", type: "text", options: ["a"] })).status).toBe(400);
    expect((await createField(owner, { key: "z", label: "x", type: "colour" })).status).toBe(400);
    expect((await createField(owner, { key: "severity", label: "dup", type: "text" })).status).toBe(409);
  });

  it("updates label/options but never key or type; delete removes it", async () => {
    await createField(owner, { key: "temp", label: "Temp", type: "select", options: ["a", "b"] });
    const up = await jsonRequest(app, "PATCH", `${fieldsUrl()}/temp`, { label: "Temporary", options: ["a", "b", "c"] }, owner.apiKey);
    expect(up.status).toBe(200);
    expect(up.data.field).toMatchObject({ label: "Temporary", options: ["a", "b", "c"] });
    expect((await jsonRequest(app, "PATCH", `${fieldsUrl()}/temp`, { type: "text" }, owner.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "PATCH", `${fieldsUrl()}/temp`, { key: "other" }, owner.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "DELETE", `${fieldsUrl()}/temp`, undefined, owner.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", fieldsUrl(), undefined, owner.apiKey)).data.fields.some((f: any) => f.key === "temp")).toBe(false);
  });

  it("presets: estimate is a number with a scale; time_in_status is computed", async () => {
    const est = await createField(owner, { preset: "estimate", unit: "hours" });
    expect(est.status).toBe(201);
    expect(est.data.field).toMatchObject({ key: "estimate", type: "number", unit: "hours", preset: "estimate" });
    const tis = await createField(owner, { preset: "time_in_status" });
    expect(tis.status).toBe(201);
    expect(tis.data.field).toMatchObject({ key: "time_in_status", type: "time_in_status" });
    // One per nest.
    expect((await createField(owner, { key: "tis2", label: "x", type: "time_in_status" })).status).toBe(409);
  });

  it("the remaining types define cleanly", async () => {
    for (const [key, type] of [
      ["notes", "text"],
      ["target", "date"],
      ["spec", "url"],
      ["blocked", "checkbox"],
    ] as const) {
      expect((await createField(owner, { key, label: key, type })).status).toBe(201);
    }
  });
});

describe("field values — validated on every REST write", () => {
  it("accepts a valid value of every type on create", async () => {
    const { status, data } = await createNode(owner, {
      title: "ship-it",
      fields: {
        severity: "HIGH",
        area: ["api", "ui", "api"],
        owner_person: "Writer@Acme.com",
        estimate: 3,
        notes: "  context  ",
        target: "2026-11-01",
        spec: "https://example.com/spec",
        blocked: true,
      },
    });
    expect(status).toBe(201);
    expect(data.node.fields).toMatchObject({
      severity: "high",
      area: ["ui", "api"], // option order, deduped
      owner_person: "writer@acme.com",
      estimate: 3,
      notes: "context",
      target: "2026-11-01",
      spec: "https://example.com/spec",
      blocked: true,
    });
  });

  it.each([
    [{ severity: "medium" }, /one of/],
    [{ area: ["ui", "mobile"] }, /isn't an option/],
    [{ owner_person: "stranger@else.com" }, /isn't on this nest/],
    [{ estimate: "three" }, /must be a number/],
    [{ target: "next tuesday" }, /date like/],
    [{ spec: "ftp://x" }, /http/],
    [{ spec: "not a url" }, /full URL/],
    [{ blocked: "maybe" }, /true or false/],
    [{ notes: 42 }, /must be text/],
    [{ mystery: "x" }, /unknown field "mystery"/],
    [{ time_in_status: 5 }, /computed/],
  ])("refuses %j", async (fields, msg) => {
    const { status, data } = await patchNode(owner, "ship-it", { fields });
    expect(status).toBe(400);
    expect(data.error).toMatch(msg);
  });

  it("a field that applies only to tasks is refused on a document", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "plain-doc", content: "x", fields: { severity: "low" } },
      owner.apiKey,
    );
    expect(status).toBe(400);
    expect(data.error).toMatch(/doesn't apply to document/);
  });

  it("null clears; keys left out are untouched", async () => {
    await patchNode(owner, "ship-it", { fields: { notes: null } });
    const n = await getNode("ship-it");
    expect(n.fields.notes).toBeUndefined();
    expect(n.fields.severity).toBe("high");
  });

  it("defaults fill on create; required is enforced on create and on clear", async () => {
    await createField(owner, {
      key: "stage",
      label: "Stage",
      type: "select",
      options: ["triage", "ready"],
      required: true,
      default_value: "triage",
    });
    const made = await createNode(writer, { title: "defaulted" });
    expect(made.status).toBe(201);
    expect(made.data.node.fields.stage).toBe("triage");
    const cleared = await patchNode(writer, "defaulted", { fields: { stage: null } });
    expect(cleared.status).toBe(400);
    expect(cleared.data.error).toMatch(/required/);
    // No default → a create without it fails.
    await jsonRequest(app, "PATCH", `${fieldsUrl()}/stage`, { default_value: null }, owner.apiKey);
    const bare = await createNode(writer, { title: "no-stage" });
    expect(bare.status).toBe(400);
    expect(bare.data.error).toMatch(/Stage \(stage\) is required/);
    await jsonRequest(app, "PATCH", `${fieldsUrl()}/stage`, { required: false }, owner.apiKey);
  });

  it("widening applies_to to every type lets a document carry it", async () => {
    await jsonRequest(app, "PATCH", `${fieldsUrl()}/spec`, { applies_to: ["*"] }, owner.apiKey);
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "spec-doc", content: "x", fields: { spec: "https://example.com" } },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.node.fields.spec).toBe("https://example.com");
  });
});

describe("a value change is a governed edit", () => {
  it("seals a new version, extends the hash chain, stores the value in frontmatter", async () => {
    const raw = async () => {
      const res = await app.request(`/nests/${nestId}/nodes/nodes/ship-it?format=raw&frontmatter=1`, {
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      return res.text();
    };
    const before = await getNode("ship-it");
    const chainBefore = chainHashes(historyOf("ship-it"));
    const { status } = await patchNode(owner, "ship-it", { fields: { estimate: 8 } });
    expect(status).toBe(200);
    const after = await getNode("ship-it");
    expect(after.version).toBe(before.version + 1);
    expect(after.fields.estimate).toBe(8);
    // The engine hashes the serialized document, frontmatter included, so a
    // field change is a new link in the chain.
    const chainAfter = chainHashes(historyOf("ship-it"));
    expect(chainAfter.length).toBe(chainBefore.length + 1);
    expect(chainAfter.slice(0, -1)).toEqual(chainBefore);
    expect(new Set(chainAfter).size).toBe(chainAfter.length);
    const rawAfter = await raw();
    expect(rawAfter).toMatch(/fields:/);
    expect(rawAfter).toMatch(/estimate: 8/);
    const hist = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/ship-it/versions`, undefined, owner.apiKey);
    expect(hist.status).toBe(200);
  });

  it("re-sending the same values is not an edit", async () => {
    const before = await getNode("ship-it");
    await patchNode(owner, "ship-it", { fields: { estimate: 8, severity: "high" } });
    expect((await getNode("ship-it")).version).toBe(before.version);
  });
});

describe("time in status", () => {
  it("counts from created_at, then restarts on a column move", async () => {
    await createNode(owner, { title: "mover", tags: ["todo"] });
    const fresh = await getNode("mover");
    expect(fresh.status_since).toBe(fresh.created_at);
    expect(typeof fresh.fields.time_in_status).toBe("number");
    expect(fresh.fields.time_in_status).toBeGreaterThanOrEqual(0);
    await patchNode(owner, "mover", { tags: ["doing"] });
    const moved = await getNode("mover");
    expect(moved.moved_at).toBeTruthy();
    expect(moved.status_since).toBe(moved.moved_at);
    const row = (await list()).data.nodes.find((n: any) => n.id === "nodes/mover");
    expect(typeof row.fields.time_in_status).toBe("number");
  });

  it("computes whole seconds from moved_at, else created_at", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(timeInStatusSeconds({ created_at: "2026-10-09T11:00:00Z" }, now)).toBe(3600);
    expect(
      timeInStatusSeconds({ created_at: "2026-10-01T00:00:00Z", moved_at: "2026-10-09T11:59:00Z" }, now),
    ).toBe(60);
    expect(timeInStatusSeconds({}, now)).toBeUndefined();
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatDuration(125 * 60)).toBe("2h 5m");
    expect(formatDuration(30)).toBe("<1m");
    const def = { key: "tis", type: "time_in_status", applies_to: ["task"] } as FieldDefinition;
    const [task, doc] = addComputedFields(
      [
        { type: "task", created_at: "2026-10-09T11:00:00Z" },
        { type: "document", created_at: "2026-10-09T11:00:00Z" },
      ] as any[],
      [def],
      now,
    );
    expect(task.fields).toEqual({ tis: 3600 });
    expect(doc.fields).toBeUndefined();
  });

  it("a time-in-status field on documents stamps their moves too", async () => {
    await jsonRequest(app, "PATCH", `${fieldsUrl()}/time_in_status`, { applies_to: ["*"] }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "doc-mover", content: "x", tags: ["a"] }, owner.apiKey);
    await patchNode(owner, "doc-mover", { tags: ["b"] });
    expect((await getNode("doc-mover")).moved_at).toBeTruthy();
  });
});

describe("filtering", () => {
  beforeAll(async () => {
    await createNode(owner, { title: "f-low", fields: { severity: "low", area: ["docs"], blocked: false } });
    await createNode(owner, {
      title: "f-high",
      fields: { severity: "high", area: ["ui"], owner_person: "reader@acme.com", blocked: true },
    });
  });

  const ids = (nodes: any[]) => nodes.map((n) => n.id.replace("nodes/", "")).sort();

  it("by select, multi_select, user and checkbox", async () => {
    expect(ids((await list("?field.severity=low")).data.nodes)).toEqual(["f-low"]);
    expect(ids((await list("?field.area=ui")).data.nodes)).toEqual(["f-high", "ship-it"]);
    expect(ids((await list("?field.owner_person=READER@acme.com")).data.nodes)).toEqual(["f-high"]);
    const blocked = ids((await list("?field.blocked=true")).data.nodes);
    expect(blocked).toEqual(["f-high", "ship-it"]);
    expect(ids((await list("?field.blocked=false&field.severity=low")).data.nodes)).toEqual(["f-low"]);
  });

  it("'none' matches unset; an unknown key is a 400", async () => {
    const unset = ids((await list("?field.severity=none&type=task")).data.nodes);
    expect(unset).toContain("mover");
    expect(unset).not.toContain("f-low");
    expect((await list("?field.nope=1")).status).toBe(400);
  });

  it("matchesFieldFilter per type", () => {
    expect(matchesFieldFilter({ type: "text" }, "Hello world", "WORLD")).toBe(true);
    expect(matchesFieldFilter({ type: "number" }, 3, "3")).toBe(true);
    expect(matchesFieldFilter({ type: "checkbox" }, undefined, "false")).toBe(true);
    expect(matchesFieldFilter({ type: "multi_select" }, ["a", "b"], "B")).toBe(true);
    expect(matchesFieldFilter({ type: "select" }, undefined, "none")).toBe(true);
  });
});

describe("MCP parity", () => {
  it("context_fields lists the definitions for any reader", async () => {
    const r = await mcp(reader, "context_fields");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Severity/);
    expect(r.data.fields.map((f: any) => f.key)).toContain("estimate");
  });

  it("definition writes are gated like REST", async () => {
    const denied = await mcp(writer, "context_create_field", { key: "mcp_x", label: "X", type: "text" });
    expect(denied.isError).toBe(true);
    expect(denied.data.code).toBe("UNAUTHORIZED_ACTION");
    const made = await mcp(reviewer, "context_create_field", {
      key: "risk",
      label: "Risk",
      type: "select",
      options: ["low", "high"],
    });
    expect(made.isError).toBe(false);
    expect(made.data.field.key).toBe("risk");
    const up = await mcp(admin, "context_update_field", { field: "risk", options: ["low", "medium", "high"] });
    expect(up.data.field.options).toEqual(["low", "medium", "high"]);
    const bad = await mcp(admin, "context_update_field", { field: "risk", options: [] });
    expect(bad.isError).toBe(true);
    expect(bad.data.code).toBe("VALIDATION_FAILED");
    expect((await mcp(editorStew, "context_delete_field", { field: "risk" })).isError).toBe(true);
    expect((await mcp(owner, "context_delete_field", { field: "risk" })).isError).toBe(false);
  });

  it("context_create and context_update validate field values", async () => {
    const ok = await mcp(owner, "context_create", {
      title: "mcp-task",
      content: "from an agent",
      type: "task",
      fields: { severity: "critical", estimate: 5 },
    });
    expect(ok.isError).toBe(false);
    expect((await getNode("mcp-task")).fields).toMatchObject({ severity: "critical", estimate: 5 });

    const bad = await mcp(owner, "context_create", {
      title: "mcp-bad",
      content: "x",
      type: "task",
      fields: { severity: "urgent" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.code).toBe("VALIDATION_FAILED");
    expect(bad.text).toMatch(/one of/);

    const up = await mcp(owner, "context_update", { id: "nodes/mcp-task", fields: { estimate: "13", blocked: true } });
    expect(up.isError).toBe(false);
    expect((await getNode("mcp-task")).fields).toMatchObject({ estimate: 13, blocked: true });
    const badUp = await mcp(owner, "context_update", { id: "nodes/mcp-task", fields: { target: "soon" } });
    expect(badUp.isError).toBe(true);
    expect(badUp.data.code).toBe("VALIDATION_FAILED");
  });

  it("context_get and context_list return values; context_list filters", async () => {
    const got = await mcp(owner, "context_get", { id: "nodes/mcp-task" });
    expect(got.text).toMatch(/\*\*Severity:\*\* critical/);
    expect(got.text).toMatch(/\*\*Estimate:\*\* 13 hours/);
    expect(got.text).toMatch(/\*\*Time in status:\*\*/);
    expect(got.data.frontmatter.metadata.fields).toMatchObject({ severity: "critical", estimate: 13 });

    const listed = await mcp(owner, "context_list", { fields: { severity: "critical" } });
    expect(listed.data.documents.map((d: any) => d.id)).toEqual(["nodes/mcp-task"]);
    expect(listed.data.documents[0].frontmatter.metadata.fields.severity).toBe("critical");
    expect(listed.text).toMatch(/Severity: critical/);

    const badFilter = await mcp(owner, "context_list", { fields: { nope: "x" } });
    expect(badFilter.isError).toBe(true);
  });

  it("context_query output carries field values", async () => {
    const q = await mcp(owner, "context_query", { query: "type:task", hops: 0 });
    expect(q.isError).toBe(false);
    const doc = q.data.documents.find((d: any) => d.id === "nodes/mcp-task");
    expect(doc.frontmatter.metadata.fields.severity).toBe("critical");
  });
});

describe("boards group and filter by fields", () => {
  it("a board config accepts a field dimension, swimlane and field filters", () => {
    const c = cleanConfig({
      dimension: "field",
      fieldKey: "severity",
      swimlane: "field",
      swimlaneField: "owner_person",
      filterFields: { blocked: "true", severity: "high" },
    });
    expect(c).toMatchObject({
      dimension: "field",
      fieldKey: "severity",
      swimlane: "field",
      swimlaneField: "owner_person",
      filterFields: { blocked: "true", severity: "high" },
    });
    expect(() => cleanConfig({ dimension: "field" })).toThrow(/fieldKey/);
    expect(() => cleanConfig({ dimension: "tag", filterFields: { x: 1 } })).toThrow(/filterFields/);
  });

  it("a board saves with a field dimension over REST", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/boards`,
      { name: "By severity", config: { dimension: "field", fieldKey: "severity", tasksOnly: true } },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.board.config).toMatchObject({ dimension: "field", fieldKey: "severity" });
  });
});
