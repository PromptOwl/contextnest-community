/**
 * Task rules through the API: exclusive stage tags, a default stage for new
 * tasks, server-assigned ticket numbers that never clash, the backfill, and the
 * moved_at stamp on a folder move.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: any, ann: any;
let nestId: string;

const bare = (t: string) => t.replace(/^#/, "");
const create = (body: Record<string, unknown>, u = owner) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { content: "x", type: "task", ...body }, u.apiKey);
const patch = (slug: string, body: Record<string, unknown>, u = owner) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/${slug}`, body, u.apiKey);
const getById = async (id: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey)).data.node;
const get = (slug: string) => getById(`nodes/${slug}`);
const tagsOf = async (slug: string) => ((await get(slug)).tags as string[]).map(bare);
const ticketOf = async (slug: string) =>
  (await tagsOf(slug)).find((t) => t.startsWith("ticket:"))?.slice("ticket:".length);
const bulk = (body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/bulk-update`, body, owner.apiKey);
const setRules = (rules: Record<string, unknown>, u = owner) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { task_rules: rules }, u.apiKey);

const RULES = {
  exclusive_namespaces: ["stage"],
  default_stage_tag: "stage:backlog",
  ticket_numbering: true,
  ticket_prefix: "PO",
  surfaces: [
    { name: "Community Nest", tags: ["community"] },
    { name: "Core", tags: ["contextnest"] },
  ],
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  ann = await registerUser(app, "ann@acme.com", "Ann");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Eng" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: ann.email, permission: "write" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("settings", () => {
  it("a nest that never saved rules numbers its tasks, with a prefix from its name", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(data.task_rules).toMatchObject({
      exclusive_namespaces: [],
      default_stage_tag: null,
      ticket_numbering: true,
      ticket_prefix: "ENG",
      surfaces: [],
    });
  });

  it("with only the default rules, a task gets a number and nothing else: no stage, two stages allowed", async () => {
    const r = await create({ title: "Plain", tags: ["community", "stage:a", "stage:b"] });
    expect(r.status).toBe(201);
    const tags = await tagsOf("plain");
    expect(tags).toEqual(expect.arrayContaining(["stage:a", "stage:b"]));
    expect(await ticketOf("plain")).toBe("eng-1");
  });

  it("an admin sets the rules; a writer can't; bad rules are refused whole", async () => {
    const bad = await setRules({ ticket_prefix: "c" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/2–6 capital/);
    expect((await setRules(RULES, ann)).status).toBe(403);
    const ok = await setRules(RULES);
    expect(ok.status).toBe(200);
    expect(ok.data.task_rules).toMatchObject({
      exclusive_namespaces: ["stage"],
      default_stage_tag: "stage:backlog",
      ticket_numbering: true,
      ticket_prefix: "PO",
      surfaces: [
        { name: "Community Nest", tags: ["community"] },
        { name: "Core", tags: ["contextnest"] },
      ],
    });
  });

  it("numbering can't be switched on without a prefix", async () => {
    const r = await setRules({ ticket_numbering: true });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/ticket_prefix/);
    // The refused request changed nothing.
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(data.task_rules.ticket_prefix).toBe("PO");
  });
});

describe("opting out", () => {
  it("a nest that saves ticket_numbering: false gets no numbers", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "No numbers" }, owner.apiKey);
    const n = data.nest.id;
    const off = await jsonRequest(app, "PATCH", `/nests/${n}/settings`, { task_rules: { ticket_numbering: false } }, owner.apiKey);
    expect(off.status).toBe(200);
    await jsonRequest(app, "POST", `/nests/${n}/nodes`, { content: "x", type: "task", title: "Unnumbered" }, owner.apiKey);
    const got = await jsonRequest(app, "GET", `/nests/${n}/nodes/nodes/unnumbered`, undefined, owner.apiKey);
    expect((got.data.node.tags as string[]).some((t) => t.includes("ticket:"))).toBe(false);
  });

  it("the default prefix stays put when the nest is renamed", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Alpha Beta" }, owner.apiKey);
    const n = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${n}/nodes`, { content: "x", type: "task", title: "One" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${n}`, { name: "Gamma Delta" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${n}/nodes`, { content: "x", type: "task", title: "Two" }, owner.apiKey);
    const two = await jsonRequest(app, "GET", `/nests/${n}/nodes/nodes/two`, undefined, owner.apiKey);
    expect(two.data.node.tags).toContain("#ticket:ab-2");
  });
});

describe("new tasks", () => {
  it("land in the default stage and get the next number in the nest's one sequence", async () => {
    await create({ title: "First", tags: ["community"] });
    await create({ title: "Second", tags: ["community", "engineering"] });
    await create({ title: "Core thing", tags: ["contextnest"] });
    expect(await tagsOf("first")).toEqual(expect.arrayContaining(["stage:backlog", "ticket:po-1"]));
    expect(await ticketOf("second")).toBe("po-2");
    // The surface is not part of the number: one counter for the whole nest.
    expect(await ticketOf("core-thing")).toBe("po-3");
  });

  it("keep a stage they arrive with", async () => {
    await create({ title: "Arrives mid-flight", tags: ["community", "stage:in-review"] });
    const tags = await tagsOf("arrives-mid-flight");
    expect(tags).toContain("stage:in-review");
    expect(tags).not.toContain("stage:backlog");
  });

  it("with no surface tag at all are still numbered", async () => {
    await create({ title: "Unlabelled", tags: ["engineering"] });
    expect(await ticketOf("unlabelled")).toBe("po-5");
    expect(await tagsOf("unlabelled")).toContain("stage:backlog");
  });

  it("refuse two stages at once, naming the namespace", async () => {
    const r = await create({ title: "Two stages", tags: ["community", "stage:done", "stage:backlog"] });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/stage:/);
  });

  it("refuse a ticket number the caller made up", async () => {
    const r = await create({ title: "Forged", tags: ["community", "ticket:po-999"] });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/assigned by the server/);
  });

  it("leave documents alone", async () => {
    await create({ title: "A document", type: "document", tags: ["community", "stage:a", "stage:b"] });
    const tags = await tagsOf("a-document");
    expect(tags).toEqual(expect.arrayContaining(["stage:a", "stage:b"]));
    expect(tags.some((t) => t.startsWith("ticket:"))).toBe(false);
  });
});

describe("ticket numbers never clash", () => {
  it("20 tasks created at the same moment get 20 different, consecutive numbers", async () => {
    const before = Number((await ticketOf("second"))!.split("-")[1]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => create({ title: `Race ${i}`, tags: ["community"] }, i % 2 ? ann : owner)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = await ticketOf(`race-${i}`);
      expect(t).toMatch(/^po-\d+$/);
      numbers.push(Number(t!.split("-")[1]));
    }
    expect(new Set(numbers).size).toBe(20);
    const sorted = [...numbers].sort((a, b) => a - b);
    // PO-1 to PO-5 are taken above: the race gets 6..25.
    expect(sorted[0]).toBeGreaterThan(before);
    expect(sorted[19] - sorted[0]).toBe(19);
  });

  it("a task that fails to create doesn't corrupt the sequence", async () => {
    const dup = await create({ title: "First", tags: ["community"] }); // same title → conflict
    expect(dup.status).toBe(409);
    await create({ title: "After the failure", tags: ["community"] });
    const n = Number((await ticketOf("after-the-failure"))!.split("-")[1]);
    expect(n).toBeGreaterThan(25);
  });
});

describe("editing tags", () => {
  it("adding a stage swaps it — a card is never in two columns", async () => {
    await patch("first", { tags: ["community", "stage:backlog", "ticket:po-1", "stage:in-progress"] });
    const tags = await tagsOf("first");
    expect(tags).toContain("stage:in-progress");
    expect(tags).not.toContain("stage:backlog");
  });

  it("an editor echoing tags without the ticket keeps the number", async () => {
    await patch("first", { tags: ["community", "stage:in-progress"] });
    expect(await ticketOf("first")).toBe("po-1");
  });

  it("the number can't be changed or invented later", async () => {
    const changed = await patch("first", { tags: ["community", "stage:in-progress", "ticket:po-77"] });
    expect(changed.status).toBe(400);
    expect(changed.data.error).toMatch(/can't be changed/);
    const invented = await patch("unlabelled", { tags: ["engineering", "stage:backlog", "ticket:ab-5"] });
    expect(invented.status).toBe(400);
    expect(await ticketOf("first")).toBe("po-1");
  });

  it("a stage change stamps moved_at", async () => {
    const before = await get("second");
    await new Promise((r) => setTimeout(r, 15));
    await patch("second", { tags: ["community", "engineering", "ticket:po-2", "stage:qa-staging"] });
    const after = await get("second");
    expect(Date.parse(after.moved_at)).toBeGreaterThan(Date.parse(before.moved_at ?? "1970-01-01"));
  });

  it("bulk add_tags swaps the stage with no board involved, and keeps the number", async () => {
    const r = await bulk({
      ids: ["nodes/first", "nodes/second"],
      patch: { add_tags: ["stage:in-review"] },
    });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ updated: 2, failed: 0 });
    for (const slug of ["first", "second"]) {
      const tags = await tagsOf(slug);
      expect(tags.filter((t) => t.startsWith("stage:"))).toEqual(["stage:in-review"]);
    }
    expect(await ticketOf("first")).toBe("po-1");
  });

  it("completing via a done tag still stamps completed_at and swaps out the stage", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { done_tags: ["stage:done"] }, owner.apiKey);
    await bulk({ ids: ["nodes/first"], patch: { add_tags: ["stage:done"] } });
    const done = await get("first");
    expect((done.tags as string[]).map(bare).filter((t) => t.startsWith("stage:"))).toEqual(["stage:done"]);
    expect(Date.parse(done.completed_at)).not.toBeNaN();
  });
});

describe("folder moves", () => {
  it("stamp moved_at on a task", async () => {
    await create({ title: "Walker", tags: ["community"], folder: "projects/a" });
    const before = await getById("nodes/projects/a/walker");
    await new Promise((r) => setTimeout(r, 15));
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/projects/a/walker/move`,
      { folder: "projects/b" },
      owner.apiKey,
    );
    expect(r.status).toBe(200);
    const after = await getById("nodes/projects/b/walker");
    expect(Date.parse(after.moved_at)).toBeGreaterThan(Date.parse(before.moved_at ?? "1970-01-01"));
    // The number travels with the task.
    expect(((after.tags as string[]).map(bare).find((t) => t.startsWith("ticket:")))).toBe(
      (before.tags as string[]).map(bare).find((t) => t.startsWith("ticket:")),
    );
  });
});

describe("backfill", () => {
  let legacyNest: string;
  const legacy = (body: Record<string, unknown>) =>
    jsonRequest(app, "POST", `/nests/${legacyNest}/nodes`, { content: "x", type: "task", ...body }, owner.apiKey);
  const legacyTags = async (slug: string) =>
    (
      (await jsonRequest(app, "GET", `/nests/${legacyNest}/nodes/nodes/${slug}`, undefined, owner.apiKey)).data.node
        .tags as string[]
    ).map(bare);
  const run = (body: Record<string, unknown> = {}, u = owner) =>
    jsonRequest(app, "POST", `/nests/${legacyNest}/tickets/backfill`, body, u.apiKey);

  beforeAll(async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Legacy" }, owner.apiKey);
    legacyNest = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${legacyNest}/collaborators`, { email: ann.email, permission: "write" }, owner.apiKey);
    // A nest that opted out, so these tasks predate numbering.
    await jsonRequest(app, "PATCH", `/nests/${legacyNest}/settings`, { task_rules: { ticket_numbering: false } }, owner.apiKey);
    // Tasks that predate numbering, created oldest to newest.
    for (const t of ["Old one", "Old two", "Old three"]) {
      await legacy({ title: t, tags: ["community"] });
      await new Promise((r) => setTimeout(r, 15));
    }
    await legacy({ title: "Old other", tags: ["engineering"] });
  });

  it("needs numbering switched on first", async () => {
    const r = await run();
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Turn on ticket numbering/);
  });

  it("is for admins only", async () => {
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${legacyNest}/settings`,
      {
        task_rules: { ticket_numbering: true, ticket_prefix: "CMN" },
      },
      owner.apiKey,
    );
    expect((await run({}, ann)).status).toBe(403);
  });

  it("a dry run changes nothing", async () => {
    const r = await run({ dry_run: true });
    expect(r.status).toBe(200);
    expect(r.data.numbered).toBe(0);
    expect((await legacyTags("old-one")).some((t) => t.startsWith("ticket:"))).toBe(false);
  });

  it("numbers every existing task, oldest first, whatever surface it is in", async () => {
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ numbered: 4, failed: 0 });
    expect(await legacyTags("old-one")).toContain("ticket:cmn-1");
    expect(await legacyTags("old-two")).toContain("ticket:cmn-2");
    expect(await legacyTags("old-three")).toContain("ticket:cmn-3");
    expect(await legacyTags("old-other")).toContain("ticket:cmn-4");
    expect(r.data.remaining).toBe(0);
  });

  it("is safe to run again, and live creates continue from the highest number", async () => {
    const again = await run();
    expect(again.data.numbered).toBe(0);
    await legacy({ title: "New after backfill", tags: ["community"] });
    expect(await legacyTags("new-after-backfill")).toContain("ticket:cmn-5");
  });
});

describe("counters line up with tickets a nest already holds", () => {
  let n: string;
  const mk = (body: Record<string, unknown>) =>
    jsonRequest(app, "POST", `/nests/${n}/nodes`, { content: "x", type: "task", ...body }, owner.apiKey);
  const tags = async (slug: string) =>
    (((await jsonRequest(app, "GET", `/nests/${n}/nodes/nodes/${slug}`, undefined, owner.apiKey)).data.node.tags ?? []) as string[]).map(bare);
  const rules = (r: Record<string, unknown>) =>
    jsonRequest(app, "PATCH", `/nests/${n}/settings`, { task_rules: r }, owner.apiKey);

  beforeAll(async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Imported" }, owner.apiKey);
    n = data.nest.id;
    // Rules are off, as in a freshly imported nest: ticket tags arrive with the documents.
    await jsonRequest(app, "PATCH", `/nests/${n}/settings`, { task_rules: { ticket_numbering: false } }, owner.apiKey);
    await mk({ title: "Came with 41", tags: ["community", "ticket:cmn-41"] });
    await mk({ title: "Came with 7", tags: ["community", "ticket:cmn-7"] });
  });

  it("turning numbering on continues after the highest imported number", async () => {
    const r = await rules({ ticket_numbering: true, ticket_prefix: "CMN" });
    expect(r.status).toBe(200);
    await mk({ title: "Fresh one", tags: ["community"] });
    expect(await tags("fresh-one")).toContain("ticket:cmn-42");
  });

  it("ticket_start_at begins the sequence there and never lowers the counter", async () => {
    await rules({ ticket_numbering: true, ticket_prefix: "CMN", ticket_start_at: 500 });
    await mk({ title: "Jumped", tags: ["docs"] });
    expect(await tags("jumped")).toContain("ticket:cmn-500");
    await rules({ ticket_numbering: true, ticket_prefix: "CMN", ticket_start_at: 5 });
    await mk({ title: "Still climbing", tags: ["community"] });
    expect(await tags("still-climbing")).toContain("ticket:cmn-501");
  });

  it("rejects a bad ticket_start_at", async () => {
    const r = await rules({ ticket_numbering: true, ticket_prefix: "CMN", ticket_start_at: 0 });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/ticket_start_at/);
  });

  it("a new prefix starts its own count and leaves issued tickets alone", async () => {
    await rules({ ticket_numbering: true, ticket_prefix: "ENG" });
    await mk({ title: "Under the new prefix", tags: ["community"] });
    expect(await tags("under-the-new-prefix")).toContain("ticket:eng-1");
    expect(await tags("came-with-41")).toContain("ticket:cmn-41");
  });

  it("moving a task between surfaces never touches its number", async () => {
    const patchTags = (slug: string, t: string[]) =>
      jsonRequest(app, "PATCH", `/nests/${n}/nodes/nodes/${slug}`, { tags: t }, owner.apiKey);
    const before = (await tags("under-the-new-prefix")).find((t) => t.startsWith("ticket:"));
    const r = await patchTags("under-the-new-prefix", ["contextnest", `ticket:${before!.slice(7)}`]);
    expect(r.status).toBe(200);
    expect((await tags("under-the-new-prefix")).find((t) => t.startsWith("ticket:"))).toBe(before);
  });
});

describe("configurable priorities", () => {
  let n: string;
  const mk = (body: Record<string, unknown>) =>
    jsonRequest(app, "POST", `/nests/${n}/nodes`, { content: "x", type: "task", ...body }, owner.apiKey);
  const rules = (r: Record<string, unknown>) =>
    jsonRequest(app, "PATCH", `/nests/${n}/settings`, { task_rules: r }, owner.apiKey);
  const prio = async (slug: string) =>
    (await jsonRequest(app, "GET", `/nests/${n}/nodes/nodes/${slug}`, undefined, owner.apiKey)).data.node.priority;

  beforeAll(async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Prio" }, owner.apiKey);
    n = data.nest.id;
  });

  it("a nest with none set keeps the four defaults", async () => {
    expect((await mk({ title: "Def", priority: "high" })).status).toBe(201);
    expect((await mk({ title: "Bad", priority: "p0" })).status).toBe(400);
  });

  it("saves its own levels, labels and all", async () => {
    const r = await rules({ priorities: [{ key: "p0", label: "P0 — Drop everything" }, { label: "Soon" }, { key: "p2", label: "Whenever" }] });
    expect(r.status).toBe(200);
    expect(r.data.task_rules.priorities).toEqual([
      { key: "p0", label: "P0 — Drop everything" },
      { key: "soon", label: "Soon" },
      { key: "p2", label: "Whenever" },
    ]);
  });

  it("only its own keys are accepted on create, update and bulk update", async () => {
    expect((await mk({ title: "Mine", priority: "p0" })).status).toBe(201);
    expect(await prio("mine")).toBe("p0");
    expect((await mk({ title: "Old key", priority: "high" })).status).toBe(400);
    const up = await jsonRequest(app, "PATCH", `/nests/${n}/nodes/nodes/mine`, { priority: "soon" }, owner.apiKey);
    expect(up.status).toBe(200);
    expect(await prio("mine")).toBe("soon");
    const bad = await jsonRequest(app, "POST", `/nests/${n}/nodes/bulk-update`, { ids: ["nodes/mine"], patch: { priority: "urgent" } }, owner.apiKey);
    expect(bad.status).toBe(400);
    const ok = await jsonRequest(app, "POST", `/nests/${n}/nodes/bulk-update`, { ids: ["nodes/mine"], patch: { priority: "p2" } }, owner.apiKey);
    expect(ok.data.updated).toBe(1);
  });

  it("a task keeps a level that was later removed", async () => {
    await rules({ priorities: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });
    expect(await prio("mine")).toBe("p2");
  });

  it("rejects too few levels and duplicate keys", async () => {
    expect((await rules({ priorities: [{ key: "only", label: "Only" }] })).status).toBe(400);
    expect((await rules({ priorities: [{ key: "x", label: "X" }, { key: "x", label: "Y" }] })).status).toBe(400);
    expect((await rules({ priorities: [] })).status).toBe(200);
  });
});

describe("stage order", () => {
  let n: string;
  const rules = (r: Record<string, unknown>) =>
    jsonRequest(app, "PATCH", `/nests/${n}/settings`, { task_rules: r }, owner.apiKey);
  beforeAll(async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Order" }, owner.apiKey);
    n = data.nest.id;
  });
  it("saves a workflow order, normalized", async () => {
    const r = await rules({ exclusive_namespaces: ["stage"], stage_order: ["Backlog", "#stage:In-Progress", "done", "done"] });
    expect(r.status).toBe(200);
    expect(r.data.task_rules.stage_order).toEqual(["backlog", "in-progress", "done"]);
  });
  it("a tag board grouped by that stage lists columns in that order", async () => {
    const mk = (title: string, st: string) =>
      jsonRequest(app, "POST", `/nests/${n}/nodes`, { title, type: "task", content: "x", tags: [st] }, owner.apiKey);
    await mk("A", "stage:done");
    await mk("B", "stage:backlog");
    await mk("C", "stage:in-progress");
    const b = await jsonRequest(app, "POST", `/nests/${n}/boards`, { name: "S", config: { dimension: "tag", tagNamespace: "stage", tasksOnly: true, layouts: {} } }, owner.apiKey);
    const list = await jsonRequest(app, "GET", `/nests/${n}/boards/${b.data.board.id}/items`, undefined, owner.apiKey);
    expect(list.data.groups.map((g: any) => g.key)).toEqual(["backlog", "in-progress", "done"]);
  });
  it("rejects a bad stage name", async () => {
    expect((await rules({ stage_order: ["no spaces!"] })).status).toBe(400);
  });
});
