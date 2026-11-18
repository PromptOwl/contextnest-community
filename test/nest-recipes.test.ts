/**
 * Recipes (PO-1411): pick a recipe when you create a nest.
 *
 * A recipe is a Surfaces seed manifest with a `recipe` block, applied through
 * the seed engine. Each acceptance criterion of the ticket is a describe block
 * named by its id (AC1..AC10); the manifest rules are pinned first.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { parseManifest, assertSeedSize, SeedInvalidError, DISTILL_TARGET, SEED_AGENT_KINDS, boardConfigFor } from "../src/surfaces/services/seed-format.js";
import { ruleRecipeAgents } from "../src/hire/rules.js";

const SEEDS = join(process.cwd(), "seeds");
const RECIPES = ["product-factory", "gtm-factory", "operations", "ideation"];
const manifestOf = (id: string) => readFileSync(join(SEEDS, id, "seed.md"), "utf8");
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

type User = { apiKey: string; userId: string; email: string; cookie: string };
let app: any;
let db: any;
let owner: User;
let other: User;

async function rpc(path: string, name: string, args: Record<string, unknown>, apiKey: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return { text: String(body?.result?.content?.[0]?.text ?? ""), data: body?.result?.structuredContent };
}

const createNest = (u: User, body: Record<string, unknown>) => jsonRequest(app, "POST", "/nests", body, u.apiKey);
const nodeIds = async (u: User, nestId: string): Promise<string[]> => {
  const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, u.apiKey);
  return (r.data?.nodes ?? []).map((n: any) => n.id);
};
const applySeedDirect = async (nestId: string, seedId: string, userId: string, upgrade = false) => {
  const { applySeed } = await import("../src/surfaces/services/seed-service.js");
  return applySeed({ nestId, seedId, actorUserId: userId, upgrade });
};
const chatOn = () => {
  process.env.TEAM_CHAT_ENABLED = "true";
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
};
const chatOff = () => {
  process.env.TEAM_CHAT_ENABLED = "false";
  process.env.EXPERIMENTAL_AGENT_STREAM = "false";
};

beforeAll(async () => {
  setupTestEnv();
  chatOn();
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.HOOTIE_ENABLED = "true";
  app = await createTestApp("key", { ownerEmail: "olivia@recipes.test", gateway: { baseUrl: "https://gateway.example.test", key: "gw-test-key" } });
  db = (await import("../src/db/client.js")).getDb();
  owner = await registerUser(app, "olivia@recipes.test", "Olivia Owner");
  other = await registerUser(app, "otto@recipes.test", "Otto Other");
  await resetAuthRateLimit();
});
afterEach(() => chatOn());

// ─── the manifest ────────────────────────────────────────────────────────────

const base = (over = "") => `---
id: r1
version: 1
title: Test recipe
recipe: { name: Test, purpose: A test recipe. }
layers: [framework]
folders:
  - { path: alpha/, purpose: things }
${over}nodes:
  - { id: seeds/r1/instructions, target: context }
---
`;
const refuse = (text: string, re: RegExp) => {
  let err: unknown = null;
  try {
    parseManifest(text);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SeedInvalidError);
  expect(String((err as Error).message)).toMatch(re);
};

describe("AC10: the bundled recipes parse, fit the caps and name nobody", () => {
  it("each recipe parses with a recipe block, a stage board, and fits the seed size caps", () => {
    for (const id of RECIPES) {
      const text = manifestOf(id);
      const m = parseManifest(text);
      expect(m.id).toBe(id);
      expect(m.recipe?.name).toBeTruthy();
      expect(m.recipe?.purpose.length).toBeLessThanOrEqual(200);
      expect(m.boards.length).toBeGreaterThan(0);
      expect(m.boards.filter((b) => b.task_stages)).toHaveLength(1);
      const contents = new Map<string, { title: string; body: string }>();
      for (const n of m.nodes) {
        const raw = readFileSync(join(SEEDS, id, `${n.id.slice(`seeds/${id}/`.length)}.md`), "utf8");
        const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
        contents.set(n.id, { title: /^title:\s*(.+)$/m.exec(fm?.[1] ?? "")?.[1] ?? "x", body: fm ? raw.slice(fm[0].length) : raw });
      }
      expect(() => assertSeedSize(text, m, contents)).not.toThrow();
    }
  });

  it("no recipe file names a company, a client or a person", () => {
    const banned = /\b(promptowl|misha|stacey|hiren|qaish|taimur|foley|martonomy|evergreen|carta|fireflies|posthog)\b/i;
    const hits: string[] = [];
    for (const id of RECIPES) {
      const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
      for (const f of walk(join(SEEDS, id))) {
        const m = banned.exec(readFileSync(f, "utf8"));
        if (m) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the agent kinds are the C10 hire catalog's, and the distill target is the onboarding ontology's", async () => {
    const { KINDS } = await import("../src/hire/catalog.js");
    expect([...SEED_AGENT_KINDS].sort()).toEqual([...KINDS].sort());
    const { ONTOLOGY_SLUG } = await import("../src/onboarding/distill.js");
    expect(DISTILL_TARGET).toBe(ONTOLOGY_SLUG);
  });

  it("refuses a bad board, channel or agent before anything is written", () => {
    refuse(base("boards:\n  - { name: B, stages: [one] }\n"), /2–12 stages/);
    refuse(base("boards:\n  - { name: B, stages: [one, one] }\n"), /stage twice/);
    refuse(base("boards:\n  - { name: B, stages: [One, two] }\n"), /lowercase slug/);
    refuse(base("boards:\n  - { name: B, stages: [a, b], task_stages: true }\n  - { name: C, stages: [a, b], task_stages: true }\n"), /only one board/);
    refuse(base("channels:\n  - { name: Bad Name, purpose: x }\n"), /lowercase name/);
    refuse(base("channels:\n  - { name: search, purpose: x }\n"), /lowercase name/);
    refuse(base("hire:\n  - { kind: robot, handle: r, why: x }\n"), /agent kind/);
    refuse(base("hire:\n  - { kind: watcher, handle: w, why: x, channels: [nowhere] }\n"), /doesn't declare/);
    refuse(base("hire:\n  - { kind: watcher, handle: w, why: x }\n"), /at least one/);
    refuse(base("hire:\n  - { kind: key, handle: k, why: x, channels: [] }\n  - { kind: key, handle: k, why: y }\n"), /listed twice/);
    refuse(base("recipe2: {}\n"), /unknown manifest key/);
  });

  it("a board is a tag board over the stage namespace with the stages as its exact columns", () => {
    expect(boardConfigFor({ stages: ["a", "b"] })).toEqual({ dimension: "tag", tagNamespace: "stage", tasksOnly: true, layouts: { "tag:stage": { columnOrder: ["a", "b"] } } });
  });

  it("distill: lands the node on the onboarding ontology without a declared folder", () => {
    const m = parseManifest(base("distill: seeds/r1/distill\n"));
    expect(m.distill).toBe("seeds/r1/distill");
    expect(m.nodes).toContainEqual({ id: "seeds/r1/distill", target: DISTILL_TARGET });
  });
});

// ─── AC1: the catalog ────────────────────────────────────────────────────────

describe("AC1: GET /recipes lists the four recipes, then Blank", () => {
  it("names, purposes and what you get, in order", async () => {
    const r = await jsonRequest(app, "GET", "/recipes", undefined, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const ids = r.data.recipes.map((x: any) => x.id);
    expect(ids).toEqual([...RECIPES, "blank"]);
    const pf = r.data.recipes[0];
    expect(pf.name).toBe("Product factory");
    expect(pf.purpose).toMatch(/eight reviewed stages/);
    expect(pf.gets.boards[0]).toEqual({ name: "Build pipeline", stages: ["intent", "red-team", "design", "design-review", "prd", "build", "smoke-eval", "retro", "shipped"] });
    expect(pf.gets.channels.map((c: any) => c.name)).toEqual(["builds", "releases"]);
    expect(pf.gets.agents.map((a: any) => a.handle)).toEqual(["builder", "builds-watcher", "hootie"]);
    expect(pf.gets.documents).toEqual(expect.arrayContaining(["Runbook (start here)", "Thesis"]));
    expect(pf.gets.folders).not.toContain("agents/"); // admin-only folders aren't advertised
    expect(pf.gets.instructions).toBe(true);
    expect(pf.gets.distill).toBe(true);
    const blank = r.data.recipes.at(-1);
    expect(blank).toMatchObject({ id: "blank", name: "Blank", gets: { boards: [], channels: [], agents: [] } });
  });

  it("needs a credential", async () => {
    const r = await app.request("/recipes");
    expect(r.status).toBe(401);
  });
});

// ─── AC2 + AC3: create from a recipe ─────────────────────────────────────────

let factoryId: string;

describe("AC2: POST /nests with a recipe makes a nest shaped by it", () => {
  it("folders, documents, CONTEXT.md, glossary, the stage board, task stages and suggested agents", async () => {
    const r = await createNest(owner, { name: "Factory", recipe: "product-factory" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    factoryId = r.data.nest.id;
    expect(r.data.recipe.status).toBe("applied");
    expect(r.data.recipe.items.filter((i: any) => i.action === "failed")).toEqual([]);
    expect(r.data.recipe.suggested_agents.map((a: any) => a.handle)).toEqual(["builder", "builds-watcher", "hootie"]);

    const ids = await nodeIds(owner, factoryId);
    expect(ids).toEqual(expect.arrayContaining(["nodes/runbook", "nodes/thesis", "nodes/standards/prd", "nodes/standards/evaluation"]));
    const ins = await jsonRequest(app, "GET", `/nests/${factoryId}/instructions`, undefined, owner.apiKey);
    expect(JSON.stringify(ins.data)).toMatch(/product pipeline/);
    const defs = (await db.all("SELECT term FROM definitions WHERE nest_id = ?", [factoryId])).map((d: any) => d.term);
    expect(defs).toEqual(expect.arrayContaining(["stage", "gate", "loop", "isolation"]));
    // The ontology the onboarding distill reads is the recipe's own.
    const onto = await jsonRequest(app, "GET", `/nests/${factoryId}/nodes/nodes/${DISTILL_TARGET}`, undefined, owner.apiKey);
    expect(onto.status).toBe(200);
    expect(JSON.stringify(onto.data)).toMatch(/Distill in this order/);

    const boards = await jsonRequest(app, "GET", `/nests/${factoryId}/boards`, undefined, owner.apiKey);
    const board = boards.data.boards.find((b: any) => b.name === "Build pipeline");
    expect(board.config).toMatchObject({ dimension: "tag", tagNamespace: "stage", tasksOnly: true });
    expect(board.config.layouts["tag:stage"].columnOrder[0]).toBe("intent");

    const settings = await jsonRequest(app, "GET", `/nests/${factoryId}/settings`, undefined, owner.apiKey);
    expect(settings.data.task_rules.stage_order).toEqual(["intent", "red-team", "design", "design-review", "prd", "build", "smoke-eval", "retro", "shipped"]);
    expect(settings.data.task_rules.default_stage_tag).toBe("stage:intent");
  });

  it("a new task on that nest lands in the first stage column", async () => {
    const t = await jsonRequest(app, "POST", `/nests/${factoryId}/nodes`, { title: "Saved searches", content: "Let people save a search.", type: "task" }, owner.apiKey);
    expect(t.status, JSON.stringify(t.data)).toBe(201);
    expect(t.data.node.tags).toContain("#stage:intent");
  });
});

describe("AC3: channels need team chat", () => {
  it("team chat on: the recipe's channels exist", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${factoryId}/channels`, undefined, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.channels.map((c: any) => c.name)).toEqual(expect.arrayContaining(["builds", "releases"]));
  });

  it("team chat off: channels are skipped with a reason, everything else applies", async () => {
    chatOff();
    const r = await createNest(owner, { name: "Quiet ops", recipe: "operations" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const ch = r.data.recipe.items.filter((i: any) => i.kind === "channel");
    expect(ch.map((i: any) => [i.target, i.action])).toEqual([
      ["ops", "skipped"],
      ["incidents", "skipped"],
    ]);
    expect(ch[0].note).toMatch(/Team chat is off/);
    expect(r.data.recipe.items.filter((i: any) => i.kind !== "channel").every((i: any) => i.action === "created")).toBe(true);
    // On again, a re-apply completes it: the channels are created now.
    chatOn();
    const again = await applySeedDirect(r.data.nest.id, "operations", owner.userId);
    expect(again.items.filter((i) => i.kind === "channel").map((i) => i.action)).toEqual(["created", "created"]);
  });
});

// ─── AC4: idempotent, people's edits kept ────────────────────────────────────

describe("AC4: re-applying duplicates nothing and keeps what people changed", () => {
  it("a second apply changes nothing", async () => {
    const out = await applySeedDirect(factoryId, "product-factory", owner.userId);
    expect(out.status).toBe("already_applied");
    expect(out.items.filter((i) => !["unchanged"].includes(i.action))).toEqual([]);
    const boards = await jsonRequest(app, "GET", `/nests/${factoryId}/boards`, undefined, owner.apiKey);
    expect(boards.data.boards.filter((b: any) => b.name.startsWith("Build pipeline"))).toHaveLength(1);
  });

  it("a board a person reordered, task stages a person changed, a channel a person archived are all kept", async () => {
    const boards = await jsonRequest(app, "GET", `/nests/${factoryId}/boards`, undefined, owner.apiKey);
    const board = boards.data.boards.find((b: any) => b.name === "Build pipeline");
    const cols = [...board.config.layouts["tag:stage"].columnOrder].reverse();
    const p = await jsonRequest(app, "PATCH", `/nests/${factoryId}/boards/${board.id}`, { config: { ...board.config, layouts: { "tag:stage": { columnOrder: cols } } } }, owner.apiKey);
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    const s = await jsonRequest(app, "GET", `/nests/${factoryId}/settings`, undefined, owner.apiKey);
    const rules = { ...s.data.task_rules, stage_order: ["intent", "build", "shipped"] };
    const ps = await jsonRequest(app, "PATCH", `/nests/${factoryId}/settings`, { task_rules: rules }, owner.apiKey);
    expect(ps.status, JSON.stringify(ps.data)).toBe(200);
    // A channel can't be deleted (its conversation would go), only archived.
    const arch = await jsonRequest(app, "POST", `/nests/${factoryId}/channels/releases/archive`, {}, owner.apiKey);
    expect(arch.status, JSON.stringify(arch.data)).toBeLessThan(300);

    const out = await applySeedDirect(factoryId, "product-factory", owner.userId);
    const by = (kind: string, target: string) => out.items.find((i) => i.kind === kind && i.target === target)?.action;
    expect(by("board", "Build pipeline")).toBe("kept_human_edit");
    expect(by("task_rules", "stages")).toBe("kept_human_edit");
    expect(by("channel", "releases")).toBe("unchanged");
    const after = await jsonRequest(app, "GET", `/nests/${factoryId}/boards`, undefined, owner.apiKey);
    expect(after.data.boards.find((b: any) => b.id === board.id).config.layouts["tag:stage"].columnOrder).toEqual(cols);
    const s2 = await jsonRequest(app, "GET", `/nests/${factoryId}/settings`, undefined, owner.apiKey);
    expect(s2.data.task_rules.stage_order).toEqual(["intent", "build", "shipped"]);
    const ch = await jsonRequest(app, "GET", `/nests/${factoryId}/channels`, undefined, owner.apiKey);
    expect(ch.data.channels.map((c: any) => c.name)).not.toContain("releases"); // still archived, not restored
  });

  it("a channel whose node is gone is not re-created", async () => {
    // Channels can't be deleted through the API; the record is what decides.
    const n = await createNest(owner, { name: "Gone channel", recipe: "ideation" });
    const nestId = n.data.nest.id;
    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage } = await engineCache.get(nestId);
    await storage.deleteDocument("nodes/channels/weekly-review");
    engineCache.evict(nestId);
    const out = await applySeedDirect(nestId, "ideation", owner.userId);
    expect(out.items.find((i) => i.kind === "channel")?.action).toBe("kept_human_delete");
  });

  it("a person's own board of the same name is theirs: the recipe makes no second one", async () => {
    const n = await jsonRequest(app, "POST", "/nests", { name: "Has a board" }, owner.apiKey);
    const nestId = n.data.nest.id;
    const b = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, { name: "Idea intake", config: { dimension: "status" } }, owner.apiKey);
    expect(b.status).toBe(201);
    const out = await applySeedDirect(nestId, "ideation", owner.userId);
    expect(out.items.find((i) => i.kind === "board")?.action).toBe("kept_human_edit");
    const boards = await jsonRequest(app, "GET", `/nests/${nestId}/boards`, undefined, owner.apiKey);
    expect(boards.data.boards.map((x: any) => x.name)).toEqual(["Idea intake"]);
  });
});

// ─── AC5: unknown recipe, blank ──────────────────────────────────────────────

describe("AC5: an unknown recipe creates nothing; Blank is today's nest", () => {
  it("unknown → 404, no nest", async () => {
    const r = await createNest(owner, { name: "Nope nest", recipe: "nope" });
    expect(r.status).toBe(404);
    expect(r.data.error).toMatch(/Recipe not found/);
    const row = await db.get("SELECT id FROM nests WHERE name = ?", ["Nope nest"]);
    expect(row).toBeUndefined();
  });

  it("a library the caller can't read → 404, no nest, nothing leaked", async () => {
    const lib = await createNest(other, { name: "Otto library" });
    const r = await createNest(owner, { name: "From a library", recipe: `${lib.data.nest.id}:product-factory` });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("Recipe not found");
    expect(await db.get("SELECT id FROM nests WHERE name = ?", ["From a library"])).toBeUndefined();
  });

  it("a nest-scoped key can't read the catalog or create a nest", async () => {
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: factoryId }, owner.apiKey);
    expect(k.status, JSON.stringify(k.data)).toBeLessThan(300);
    const key = k.data.api_key ?? k.data.key;
    expect((await jsonRequest(app, "GET", "/recipes", undefined, key)).status).toBe(403);
    expect((await createNest({ ...owner, apiKey: key }, { name: "Scoped", recipe: "ideation" })).status).toBe(403);
  });

  it("a failed apply still creates the nest and says why", async () => {
    const { applyRecipe } = await import("../src/nests/recipe-service.js");
    const n = await createNest(owner, { name: "Claimed" });
    // Another apply holds the nest's claim: the recipe reports failed, never throws.
    await db.run("INSERT INTO surface_seed_claims (nest_id, token, expires_at) VALUES (?, ?, ?)", [n.data.nest.id, "x", new Date(Date.now() + 60_000).toISOString()]);
    const out = await applyRecipe(n.data.nest.id, { seedId: "ideation", libraryNestId: null }, owner.userId, { keyId: null, agentSurface: false });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/already being applied/);
  });

  it("a seed that is not a recipe → 404", async () => {
    const r = await createNest(owner, { name: "Generic", recipe: "generic-team" });
    expect(r.status).toBe(404);
  });

  it("blank and no recipe → an empty nest, no recipe in the reply", async () => {
    for (const recipe of ["blank", undefined]) {
      const r = await createNest(owner, { name: `Plain ${recipe ?? "none"}`, ...(recipe ? { recipe } : {}) });
      expect(r.status).toBe(201);
      expect(r.data.recipe).toBeUndefined();
      expect(await nodeIds(owner, r.data.nest.id)).toEqual([]);
      const app2 = await db.get("SELECT 1 AS x FROM surface_seed_applications WHERE nest_id = ?", [r.data.nest.id]);
      expect(app2).toBeUndefined();
    }
  });
});

// ─── AC6: MCP parity ─────────────────────────────────────────────────────────

describe("AC6: MCP nest_create {recipe} and context_recipes", () => {
  it("context_recipes lists the same catalog as GET /recipes", async () => {
    const r = await rpc("/mcp", "context_recipes", {}, owner.apiKey);
    expect(r.data.recipes.map((x: any) => x.id)).toEqual([...RECIPES, "blank"]);
    expect(r.text).toMatch(/product-factory: Product factory/);
  });

  it("nest_create with a recipe applies it, like REST", async () => {
    const r = await rpc("/mcp", "nest_create", { name: "MCP GTM", recipe: "gtm-factory" }, owner.apiKey);
    expect(r.text).toMatch(/Created nest "MCP GTM"/);
    expect(r.text).toMatch(/Recipe gtm-factory: applied/);
    const nestId = r.data.nest.id;
    const boards = await jsonRequest(app, "GET", `/nests/${nestId}/boards`, undefined, owner.apiKey);
    expect(boards.data.boards.map((b: any) => b.name)).toEqual(["Experiments"]);
  });

  it("nest_create with an unknown recipe says so and creates nothing", async () => {
    const r = await rpc("/mcp", "nest_create", { name: "MCP nope", recipe: "nope" }, owner.apiKey);
    expect(r.text).toMatch(/Recipe not found/);
    expect(await db.get("SELECT id FROM nests WHERE name = ?", ["MCP nope"])).toBeUndefined();
  });

  it("context_onboarding_update create_nest takes a recipe", async () => {
    const r = await rpc("/mcp", "context_onboarding_update", { action: "create_nest", name: "Otto ideas", recipe: "ideation" }, other.apiKey);
    expect(r.text).toMatch(/Created "Otto ideas"/);
    expect(r.text).toMatch(/Recipe ideation: applied/);
  });
});

// ─── AC7: suggested agents become recommendations ────────────────────────────

describe("AC7: a recipe's suggested agents show as recommendations until hired", () => {
  it("the rule: unhired and available only; a watcher needs its channels", () => {
    const agents = [
      { kind: "key" as const, handle: "builder", why: "Builds.", channels: [] },
      { kind: "watcher" as const, handle: "w", why: "Watches.", channels: ["builds"] },
      { kind: "hootie" as const, handle: "hootie", why: "Answers.", channels: [] },
    ];
    const ids = (opts: Partial<Parameters<typeof ruleRecipeAgents>[1]>) =>
      ruleRecipeAgents(agents, { nestId: "n", known: new Set(), channels: new Set(["builds"]), available: () => true, ...opts }).map((r) => r.id);
    expect(ids({})).toEqual(["recipe:builder", "recipe:w", "recipe:hootie"]);
    expect(ids({ known: new Set(["builder", "hootie"]) })).toEqual(["recipe:w"]);
    expect(ids({ channels: new Set() })).toEqual(["recipe:builder", "recipe:hootie"]);
    expect(ids({ available: (k) => k !== "watcher" })).toEqual(["recipe:builder", "recipe:hootie"]);
    const [b] = ruleRecipeAgents(agents, { nestId: "n", known: new Set(), channels: new Set(["builds"]), available: () => true });
    expect(b.hire).toEqual({ kind: "key", handle: "builder" });
  });

  it("over REST, and hiring one removes it", async () => {
    const list = async () => (await jsonRequest(app, "GET", `/nests/${factoryId}/agents/recommendations`, undefined, owner.apiKey)).data.recommendations.map((r: any) => r.id);
    const before = await list();
    expect(before).toEqual(expect.arrayContaining(["recipe:builder", "recipe:builds-watcher", "recipe:hootie"]));
    const h = await jsonRequest(app, "POST", `/nests/${factoryId}/hire`, { kind: "key", handle: "builder" }, owner.apiKey);
    expect(h.status, JSON.stringify(h.data)).toBeLessThan(300);
    expect(await list()).not.toContain("recipe:builder");
  });

  it("a recipe recommendation can be dismissed", async () => {
    const d = await jsonRequest(app, "POST", `/nests/${factoryId}/agents/recommendations/${encodeURIComponent("recipe:hootie")}/dismiss`, {}, owner.apiKey);
    expect(d.status, JSON.stringify(d.data)).toBe(200);
  });
});

// ─── first-run onboarding ────────────────────────────────────────────────────

describe("AC9 (server): POST /onboarding/nest takes a recipe", () => {
  it("creates the person's nest from it, once", async () => {
    const newbie = await registerUser(app, "nina@recipes.test", "Nina New");
    const r = await jsonRequest(app, "POST", "/onboarding/nest", { recipe: "operations" }, newbie.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.nest.recipe.status).toBe("applied");
    const again = await jsonRequest(app, "POST", "/onboarding/nest", { recipe: "operations" }, newbie.apiKey);
    expect(again.status).toBe(200);
    expect(again.data.nest.recipe).toBeUndefined();
    expect(again.data.recipe_ignored).toMatch(/already have a nest/);
  });

  it("an unknown recipe makes no nest", async () => {
    const newbie = await registerUser(app, "nico@recipes.test", "Nico New");
    const r = await jsonRequest(app, "POST", "/onboarding/nest", { recipe: "nope" }, newbie.apiKey);
    expect(r.status).toBe(404);
    expect(await db.get("SELECT id FROM nests WHERE user_id = ?", [newbie.userId])).toBeUndefined();
  });
});
