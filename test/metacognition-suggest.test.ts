/**
 * Metacognition setup suggestions (CU-wdqcq05rkp) — GET
 * /nests/:id/metacognition/:node/suggest reads the agent document's APPROVED
 * instructions and returns a starting config, each field with a plain `why`.
 *
 * Deterministic heuristics only (no model call), and read-only: the
 * suggestion is never saved. Everything it suggests must still pass
 * parseConfig, so the form can save it as-is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { suggestConfig } from "../src/metacognition/suggest.js";
import { parseConfig, CAPS } from "../src/metacognition/config.js";

const FOLDERS = ["gtm", "gtm/deals", "ops", "private"];

describe("suggestConfig (pure heuristics)", () => {
  it("reads folders the instructions name, and may suggest edits when told to update", () => {
    const s = suggestConfig({
      title: "Archivist",
      frontmatter: {},
      instructions: "Watch nodes/gtm/ and update stale pricing.",
      folders: FOLDERS,
    });
    expect(s.config.scope.read).toEqual(["gtm"]);
    expect(s.config.scope.propose).toEqual(["*"]);
    expect(s.why["scope.read"]).toMatch(/nodes\/gtm\//);
    expect(s.why["scope.propose"]).toMatch(/update/i);
  });

  it("comments only when told to flag and not edit", () => {
    const s = suggestConfig({
      title: "Auditor",
      frontmatter: {},
      instructions: "Look through the ops folder. Only flag problems, do not edit anything.",
      folders: FOLDERS,
    });
    expect(s.config.scope.read).toEqual(["ops"]);
    expect(s.config.scope.propose).toEqual([]);
    expect(s.why["scope.propose"]).toBeTruthy();
  });

  it("proposes nothing by default when the instructions name no action", () => {
    const s = suggestConfig({ title: "Watcher", frontmatter: {}, instructions: "Keep an eye on things.", folders: FOLDERS });
    expect(s.config.scope.propose).toEqual([]);
  });

  it("never suggests a folder the nest doesn't have", () => {
    const s = suggestConfig({
      title: "Archivist",
      frontmatter: {},
      instructions: "Keep nodes/legal/ and nodes/gtm/ current; fix what is stale.",
      folders: FOLDERS,
    });
    expect(s.config.scope.read).toEqual(["gtm"]);
    expect(s.config.scope.read).not.toContain("legal");
  });

  it("reads the whole nest when no folder is named, and says so", () => {
    const s = suggestConfig({ title: "Archivist", frontmatter: {}, instructions: "Fix typos.", folders: FOLDERS });
    expect(s.config.scope.read).toEqual([]);
    expect(s.why["scope.read"]).toMatch(/whole nest/i);
  });

  it("keeps a subfolder only when its parent isn't also named", () => {
    const a = suggestConfig({ title: "A", frontmatter: {}, instructions: "Review nodes/gtm/deals/ only.", folders: FOLDERS });
    expect(a.config.scope.read).toEqual(["gtm/deals"]);
    const b = suggestConfig({ title: "A", frontmatter: {}, instructions: "Review nodes/gtm/ and nodes/gtm/deals/.", folders: FOLDERS });
    expect(b.config.scope.read).toEqual(["gtm"]);
  });

  it("matches a folder named in plain words ('the GTM folder') to its real name", () => {
    const s = suggestConfig({ title: "A", frontmatter: {}, instructions: "Keep the GTM folder current.", folders: FOLDERS });
    expect(s.config.scope.read).toEqual(["gtm"]);
  });

  it("takes the persona name from the title and an avatar from a frontmatter emoji", () => {
    const s = suggestConfig({ title: "Pricing Archivist", frontmatter: { emoji: "🦉" }, instructions: "", folders: FOLDERS });
    expect(s.config.persona).toEqual({ name: "Pricing Archivist", avatar: "🦉" });
    expect(s.why["persona.name"]).toBeTruthy();
    expect(s.why["persona.avatar"]).toBeTruthy();
  });

  it("never takes a URL as an avatar, and makes any title a valid persona name", () => {
    const s = suggestConfig({ title: "🤖 Agent: Q3 / pricing!", frontmatter: { icon: "https://x.test/a.png" }, instructions: "", folders: [] });
    expect(s.config.persona.avatar).toBeNull();
    expect(() => parseConfig(s.config)).not.toThrow();
  });

  it("suggests public feed URLs, never localhost or private ones, and lists /mcp URLs as MCP servers", () => {
    const s = suggestConfig({
      title: "Scout",
      frontmatter: {},
      instructions: [
        "Read https://feeds.example.com/news.xml and https://blog.example.org/feed every run.",
        "Ignore https://localhost/feed.xml, https://192.168.1.5/rss.xml, https://169.254.169.254/latest/feed and http://plain.example.com/feed.xml.",
        "Tickets are at https://desk.example.com/mcp.",
      ].join("\n"),
      folders: [],
    });
    expect(s.config.feeds.map((f) => f.url)).toEqual(["https://feeds.example.com/news.xml", "https://blog.example.org/feed"]);
    expect(s.mcp_candidates.map((m) => m.url)).toEqual(["https://desk.example.com/mcp"]);
    expect(s.why.feeds).toBeTruthy();
    // MCP servers need their allowed tools named by a person; never in the
    // saveable config.
    expect(s.config.mcp_servers).toEqual([]);
  });

  // Review round 1: "update"/"improve" as nouns or about the agent's own
  // reply must not grant edits; "do not update the footer" must not make a
  // fixing agent comments-only.
  for (const text of [
    "Send a weekly status update to the team.",
    "Improve the summary in your reply.",
    "Post an update in Slack when you are done.",
    "Refresh your memory of the gtm folder before answering.",
  ]) {
    it(`doesn't grant edits for "${text}"`, () => {
      const s = suggestConfig({ title: "A", frontmatter: {}, instructions: text, folders: FOLDERS });
      expect(s.config.scope.propose).toEqual([]);
    });
  }

  // Review round 2: phrasings that say "no edits" without "do not".
  for (const text of ["Fix nothing; just report what looks stale.", "Never update.", "No edits, only notes.", "Make no changes to documents."]) {
    it(`comments only for "${text}"`, () => {
      const s = suggestConfig({ title: "A", frontmatter: {}, instructions: text, folders: FOLDERS });
      expect(s.config.scope.propose).toEqual([]);
    });
  }

  it("a narrow 'do not update the footer' doesn't override 'fix stale pricing'", () => {
    const s = suggestConfig({
      title: "A",
      frontmatter: {},
      instructions: "Fix stale pricing in nodes/gtm/. Do not update the footer.",
      folders: FOLDERS,
    });
    expect(s.config.scope.propose).toEqual(["*"]);
  });

  it("a whole-agent 'do not edit anything' still means comments only", () => {
    const s = suggestConfig({ title: "A", frontmatter: {}, instructions: "Fix nothing. Do not edit anything; flag stale pricing.", folders: FOLDERS });
    expect(s.config.scope.propose).toEqual([]);
  });

  it("matches folder names with regex characters literally", () => {
    const s = suggestConfig({
      title: "A",
      frontmatter: {},
      instructions: "Review nodes/c++/ and nodes/a.b/ only.",
      folders: ["c++", "a.b", "axb", "c"],
    });
    expect(s.config.scope.read.sort()).toEqual(["a.b", "c++"]);
  });

  it("trims a trailing ')' or '.' off a feed link", () => {
    const s = suggestConfig({
      title: "A",
      frontmatter: {},
      instructions: "Sources (https://feeds.example.com/a.xml) and https://feeds.example.org/feed.",
      folders: [],
    });
    expect(s.config.feeds.map((f) => f.url)).toEqual(["https://feeds.example.com/a.xml", "https://feeds.example.org/feed"]);
  });

  it("returns a config parseConfig accepts unchanged, with the Standard caps", () => {
    const s = suggestConfig({
      title: "Archivist",
      frontmatter: { avatar: "AR" },
      instructions: "Watch nodes/gtm/ and nodes/ops/. Update stale facts. Source: https://feeds.example.com/a.rss",
      folders: FOLDERS,
    });
    expect(parseConfig(s.config)).toEqual(s.config);
    expect(s.config.caps).toEqual({
      max_steps: CAPS.max_steps.default,
      max_tokens: CAPS.max_tokens.default,
      max_seconds: CAPS.max_seconds.default,
      max_proposals: CAPS.max_proposals.default,
      max_comments: CAPS.max_comments.default,
    });
  });
});

describe("GET /nests/:id/metacognition/:node/suggest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; email: string; userId: string };
  let editor: { apiKey: string; email: string; userId: string };
  let reviewer: { apiKey: string; email: string; userId: string };
  let nestId: string;
  const suggest = (node: string, key = owner.apiKey) =>
    jsonRequest(app, "GET", `/nests/${nestId}/metacognition/${node}/suggest`, undefined, key);

  beforeAll(async () => {
    process.env.FEATURE_WORKFLOW_PLANE = "true";
    process.env.FEATURE_METACOGNITION = "true";
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Suggest" }, owner.apiKey);
    nestId = nest.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: reviewer.email, permission: "read" }, owner.apiKey);
    for (const [title, content] of [
      ["Archivist", "Watch nodes/gtm/ and nodes/legal/ and update stale pricing. News: https://feeds.example.com/news.xml https://localhost/feed.xml"],
      ["Auditor", "Read the ops folder. Only flag problems, do not edit."],
    ]) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content, type: "agent" }, owner.apiKey);
      expect(r.status).toBe(201);
    }
    for (const [folder, title] of [
      ["gtm", "Pricing"],
      ["ops", "Runbook"],
    ]) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}\n\nText.`, folder }, owner.apiKey);
      expect(r.status).toBe(201);
    }
  });

  afterAll(async () => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    delete process.env.FEATURE_METACOGNITION;
    await env.cleanup();
  });

  it("suggests read gtm and propose * from 'nodes/gtm/' + 'update stale pricing', each with a why", async () => {
    const r = await suggest("nodes/archivist");
    expect(r.status).toBe(200);
    const s = r.data.suggestion;
    expect(s.config.scope.read).toEqual(["gtm"]);
    expect(s.config.scope.propose).toEqual(["*"]);
    expect(s.why["scope.read"]).toBeTruthy();
    expect(s.why["scope.propose"]).toBeTruthy();
    expect(s.config.persona.name).toBe("Archivist");
    expect(s.instructions).toBe("approved");
  });

  it("drops the folder that doesn't exist and the unsafe feed URL", async () => {
    const s = (await suggest("nodes/archivist")).data.suggestion;
    expect(s.config.scope.read).not.toContain("legal");
    expect(s.config.feeds.map((f: any) => f.url)).toEqual(["https://feeds.example.com/news.xml"]);
  });

  it("suggests comments only for 'only flag problems, do not edit'", async () => {
    const s = (await suggest("nodes/auditor")).data.suggestion;
    expect(s.config.scope.read).toEqual(["ops"]);
    expect(s.config.scope.propose).toEqual([]);
  });

  it("never saves anything", async () => {
    await suggest("nodes/archivist");
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition`, undefined, owner.apiKey);
    expect(list.data.agents).toEqual([]);
  });

  it("is 400 for a document that isn't an agent, or no document, like PUT", async () => {
    expect((await suggest("nodes/gtm/pricing")).status).toBe(400);
    expect((await suggest("nodes/nope")).status).toBe(400);
  });

  it("is 403 for a caller who is not the owner or an admin, like PUT", async () => {
    expect((await suggest("nodes/archivist", editor.apiKey)).status).toBe(403);
    expect((await suggest("nodes/archivist", reviewer.apiKey)).status).toBe(403);
  });

  it("is 404 with the feature switch off, like PUT", async () => {
    process.env.FEATURE_METACOGNITION = "false";
    try {
      expect((await suggest("nodes/archivist")).status).toBe(404);
    } finally {
      process.env.FEATURE_METACOGNITION = "true";
    }
  });

  it("reads the approved instructions, not an unreviewed draft", async () => {
    // Govern the nest, then edit the agent doc: the edit is a draft until a
    // reviewer approves it, and an unapproved instruction must not steer the
    // suggestion (same text the run reads).
    const steward = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
      owner.apiKey,
    );
    expect(steward.status).toBe(201);
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/auditor`,
      { content: "Read nodes/gtm/ and rewrite whatever is stale." },
      owner.apiKey,
    );
    expect(edit.status).toBeLessThan(300);
    const s = (await suggest("nodes/auditor")).data.suggestion;
    expect(s.config.scope.read).toEqual(["ops"]);
    expect(s.config.scope.propose).toEqual([]);
  });
});
