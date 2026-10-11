/**
 * Structure rules per nest (docs/prds/structure-rules.md §6): read, save and
 * check a nest's folder layout, naming and template rules. Each nest keeps its
 * own rules in its own vault; owners and admins save them, anyone who can read
 * the nest can read and check them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let writer: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;
let otherNestId: string;

const RULES = {
  structure: { enforce: false, closed: false },
  folders: {
    "clients/{client}": {
      folder_name: "/[a-z]+-[0-9]{3}/",
      types: ["document"],
      files: { overview: { template: "client-overview" } },
    },
    "clients/{client}/meetings": {
      required: true,
      types: ["document"],
      file_name: "{date}-{slug}",
      template: "meeting-note",
    },
  },
  templates: {
    "meeting-note": { body: "## Attendees\n\n## Decisions\n", required_sections: ["Decisions"] },
    "client-overview": { body: "## Summary\n", required_sections: [] },
  },
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  writer = await registerUser(app, "writer@acme.com", "Writer");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Clients" }, owner.apiKey)).data.nest.id;
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Runbooks" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [[writer, "write"], [reader, "read"]] as const) {
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
  }
});

afterAll(() => env.cleanup());

describe("structure rules per nest", () => {
  it("a new nest has no rules", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/structure`, undefined, reader.apiKey);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ enforce: false, closed: false, folders: [], templates: {} });
  });

  it("an owner saves the rules into the nest's own vault and reads them back", async () => {
    const put = await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, RULES, owner.apiKey);
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect(put.data.folders.map((f: { pattern: string }) => f.pattern)).toEqual([
      "clients/{client}",
      "clients/{client}/meetings",
    ]);
    expect(put.data.violations).toBe(0);
    const get = await jsonRequest(app, "GET", `/nests/${nestId}/structure?folder=clients/acme-042/meetings`, undefined, reader.apiKey);
    expect(get.data.resolved).toMatchObject({ pattern: "clients/{client}/meetings", file_name: "{date}-{slug}", template: "meeting-note" });
    expect(get.data.yaml).toContain("clients/{client}/meetings");
    const config = join(env.dataDir, "nests", nestId, ".context", "config.yaml");
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, "utf-8")).toContain("{date}-{slug}");
  });

  it("another nest keeps its own rules: saving one never touches the other", async () => {
    const other = await jsonRequest(app, "GET", `/nests/${otherNestId}/structure`, undefined, owner.apiKey);
    expect(other.data.folders).toEqual([]);
    const own = { folders: { runbooks: { types: ["document"], file_name: "rb-{n}-{slug}" } } };
    expect((await jsonRequest(app, "PUT", `/nests/${otherNestId}/structure`, own, owner.apiKey)).status).toBe(200);
    const first = await jsonRequest(app, "GET", `/nests/${nestId}/structure`, undefined, owner.apiKey);
    expect(first.data.folders.map((f: { pattern: string }) => f.pattern)).toEqual(["clients/{client}", "clients/{client}/meetings"]);
    const second = await jsonRequest(app, "GET", `/nests/${otherNestId}/structure`, undefined, owner.apiKey);
    expect(second.data.folders.map((f: { pattern: string }) => f.pattern)).toEqual(["runbooks"]);
  });

  it("only owners and admins save rules: a write or read collaborator is refused", async () => {
    expect((await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, RULES, writer.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, RULES, reader.apiKey)).status).toBe(403);
  });

  it("rules that cannot work are refused with the field at fault", async () => {
    const bad = { folders: { "clients/{client}": { folder_name: "/(a+)+/" } } };
    const res = await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, bad, owner.apiKey);
    expect(res.status).toBe(400);
    expect(Object.keys(res.data.fieldErrors)).toEqual(["folders.clients/{client}.folder_name"]);
    expect(res.data.error).toMatch(/repeats a group/);
  });

  it("anyone who reads the nest can check a title against the saved rules", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/structure/check`,
      {
        tests: [
          { folder: "clients/acme-042/meetings", title: "Kickoff with Acme", type: "document" },
          { folder: "clients/acme-042/meetings", title: "2026-10-07 Kickoff with Acme", type: "document" },
        ],
        folders: ["clients/acme", "clients/acme-042"],
      },
      reader.apiKey,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.results[0]).toMatchObject({ ok: false, slug: "kickoff-with-acme" });
    expect(res.data.results[0].violations[0].code).toBe("FILE_NAME");
    expect(res.data.results[1], JSON.stringify(res.data.results[1])).toMatchObject({ ok: true, slug: "2026-10-07-kickoff-with-acme", violations: [] });
    expect(res.data.folders[0].violations[0].code).toBe("FOLDER_NAME");
    expect(res.data.folders[1]).toMatchObject({
      folder: "clients/acme-042",
      violations: [],
      creates: { folders: ["clients/acme-042/meetings"], files: [{ path: "clients/acme-042/overview" }] },
    });
  });

  it("checking a draft is for owners and admins, and reports its problems without saving", async () => {
    const draft = { ...RULES, folders: { ...RULES.folders, decisions: { file_name: "adr-{n}-{slug}", template: "nope" } } };
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/structure/check`, { rules: draft }, reader.apiKey)).status).toBe(403);
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/structure/check`,
      { rules: draft, tests: [{ folder: "decisions", title: "ADR 7 Use Postgres" }], report: true },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.fieldErrors).toEqual({});
    expect(res.data.warnings.join(" ")).toMatch(/nope/);
    expect(res.data.results[0]).toMatchObject({ ok: true, slug: "adr-7-use-postgres" });
    expect(Array.isArray(res.data.report.violations)).toBe(true);
    const bad = await jsonRequest(app, "POST", `/nests/${nestId}/structure/check`, { rules: { folders: { x: { types: ["nope"] } } } }, owner.apiKey);
    expect(bad.status).toBe(200);
    expect(Object.keys(bad.data.fieldErrors)).toEqual(["folders.x.types"]);
    const saved = await jsonRequest(app, "GET", `/nests/${nestId}/structure`, undefined, owner.apiKey);
    expect(saved.data.folders.map((f: { pattern: string }) => f.pattern)).not.toContain("decisions");
  });

  it("a title or folder name is tried against a format alone, whatever folder it is for", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/structure/check`,
      {
        tests: [
          { title: "Kickoff with Acme", file_name: "{date}-{slug}" },
          { title: "2026-10-07 Kickoff", file_name: "{date}-{slug}" },
          { name: "acme", folder_name: "/[a-z]+-[0-9]{3}/" },
          { name: "acme-042", folder_name: "/[a-z]+-[0-9]{3}/" },
          { title: "Anything", file_name: "" },
          { title: "x", file_name: "/(a+)+/" },
        ],
      },
      reader.apiKey,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const r = res.data.results;
    expect(r[0]).toMatchObject({ ok: false, slug: "kickoff-with-acme" });
    expect(r[0].violations[0].message).toMatch(/\{date\}-\{slug\}/);
    expect(r[1]).toMatchObject({ ok: true, slug: "2026-10-07-kickoff" });
    expect(r[2]).toMatchObject({ ok: false, slug: "acme" });
    expect(r[3]).toMatchObject({ ok: true, slug: "acme-042" });
    expect(r[4]).toMatchObject({ ok: true, slug: "anything" });
    expect(r[5].ok).toBe(false);
    expect(r[5].violations[0].message).toMatch(/repeats a group/);
  });

  it("caps a check at 50 tests", async () => {
    const tests = Array.from({ length: 51 }, () => ({ title: "x" }));
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/structure/check`, { tests }, reader.apiKey)).status).toBe(400);
  });

  it("once enforced, a document that breaks a rule is refused with a 400 naming the rule", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, { ...RULES, structure: { enforce: true, closed: false } }, owner.apiKey);
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Kickoff", content: "## Decisions\nShip.\n", folder: "clients/acme-042/meetings" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/\{date\}-\{slug\}/);
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "2026-10-07 Kickoff", content: "## Decisions\nShip.\n", folder: "clients/acme-042/meetings" },
      owner.apiKey,
    );
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
  });
});
