/**
 * Surfaces S3 — the pure seed core (PRD §13): manifest validation
 * (AC-SEED-05, all-or-nothing), the idempotency decision (AC-SEED-02/03),
 * the never_propose filter (AC-SEED-08) and the AC-SEED-06 lint: no bundled
 * seed's folder name appears in src/surfaces/**.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parseManifest, assertSeedSize, decideItem, seedHash, folderNames, SeedInvalidError, SEED_MAX_NODES } from "../src/surfaces/services/seed-format.js";
import { categoryHit } from "../src/surfaces/core/filters.js";

const SEEDS = join(process.cwd(), "seeds");
const bundled = () => readdirSync(SEEDS).filter((d) => statSync(join(SEEDS, d)).isDirectory());
const manifestOf = (id: string) => readFileSync(join(SEEDS, id, "seed.md"), "utf8");
const base = (over = "") => `---
id: t1
version: 1
title: Test seed
layers: [framework]
folders:
  - { path: alpha/, purpose: people }
  - { path: beta/, purpose: areas, admin_only: true }
tags:
  - { tag: domain-a, meaning: A domain. }
definitions:
  - { term: alpha, definition: The first letter. }
thesis: seeds/t1/thesis
listener:
  propose_folders: [alpha/]
  domain_tags: [domain-a]
  never_propose: [compensation]
nodes:
  - { id: seeds/t1/instructions, target: context }
  - { id: seeds/t1/thesis, target: thesis }
${over}---
`;
const refuse = (text: string, re: RegExp) => {
  let err: unknown = null;
  try {
    parseManifest(text);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SeedInvalidError);
  expect((err as Error).message).toMatch(re);
};

describe("manifest format", () => {
  it("parses frontmatter and a fenced ```yaml block the same way", () => {
    const fm = parseManifest(base());
    const yamlBody = base().replace(/^---\n/, "").replace(/---\n$/, "");
    expect(parseManifest(`Some prose.\n\n\`\`\`yaml\n${yamlBody}\`\`\`\n`)).toEqual(fm);
    expect(fm.listener).toEqual({ propose_folders: ["alpha/"], domain_tags: ["domain-a"], never_propose: ["compensation"], never_terms: [] });
    expect(fm.folders[1]).toEqual({ path: "beta/", purpose: "areas", admin_only: true });
  });

  it("every bundled seed is valid", () => {
    expect(bundled()).toContain("generic-team");
    for (const id of bundled()) expect(parseManifest(manifestOf(id)).id).toBe(id);
  });

  it("generic-team: the PRD's five folders + an admin-only agents folder, 4 definitions, CONTEXT.md and a thesis", () => {
    const m = parseManifest(manifestOf("generic-team"));
    expect(m.folders.length).toBe(6);
    expect(m.folders.filter((f) => f.admin_only).length).toBe(1);
    expect(m.listener.propose_folders.length).toBe(5);
    expect(m.definitions.map((d) => d.term).sort()).toEqual(["customer", "decision", "owner", "renewal"]);
    expect(m.nodes.some((n) => n.target === "context")).toBe(true);
    expect(m.thesis).toBe("seeds/generic-team/thesis");
    expect(m.folders.filter((f) => f.purpose === "people").length).toBe(1);
  });
});

describe("AC-SEED-05: validation refuses the whole manifest", () => {
  it("AC-SEED-05: a path with ..", () => {
    refuse(base().replace("target: thesis }", "target: ../thesis }"), /safe relative path/);
    refuse(base().replace("path: alpha/", "path: ../alpha/"), /no "\.\."/);
    refuse(base().replace("{ id: seeds/t1/thesis, target: thesis }", "{ id: seeds/t1/../t2/thesis, target: thesis }"), /outside seeds\/t1\//);
  });
  it("AC-SEED-05: a node id outside seeds/<id>/", () => {
    refuse(base().replace("{ id: seeds/t1/thesis, target: thesis }", "{ id: seeds/t2/thesis, target: thesis }"), /outside seeds\/t1\//);
    refuse(base().replace("thesis: seeds/t1/thesis", "thesis: nodes/thesis"), /outside seeds\/t1\//);
  });
  it("AC-SEED-05: a folder outside the seed (undeclared target or listener folder, absolute, or the library's own area)", () => {
    refuse(base().replace("target: thesis }", "target: gamma/thesis }"), /doesn't declare/);
    refuse(base().replace("propose_folders: [alpha/]", "propose_folders: [gamma/]"), /isn't one of the seed's folders/);
    refuse(base().replace("path: alpha/", "path: /alpha/"), /slug segments/);
    refuse(base().replace("path: alpha/", "path: seeds/"), /seed library area/);
  });
  it("AC-SEED-05: more than 50 nodes", () => {
    const many = Array.from({ length: SEED_MAX_NODES }, (_, i) => `  - { id: seeds/t1/n${i} }\n`).join("");
    refuse(base().replace("nodes:\n", `nodes:\n${many}`), /more than 50 nodes/);
  });
  it("AC-SEED-05: more than 200 KB in total", () => {
    const m = parseManifest(base());
    const contents = new Map([
      ["seeds/t1/instructions", { title: "Ctx", body: "x" }],
      ["seeds/t1/thesis", { title: "Thesis", body: "y".repeat(201 * 1024) }],
    ]);
    expect(() => assertSeedSize(base(), m, contents)).toThrow(/200 KB/);
    contents.set("seeds/t1/thesis", { title: "Thesis", body: "small" });
    expect(() => assertSeedSize(base(), m, contents)).not.toThrow();
    contents.delete("seeds/t1/thesis");
    expect(() => assertSeedSize(base(), m, contents)).toThrow(/missing/);
  });
  it("AC-SEED-05: unknown keys, bad ids, undeclared domain tags and bad YAML are refused, never ignored", () => {
    refuse(base("surprise: true\n"), /unknown manifest key/);
    refuse(base().replace("id: t1", "id: T 1"), /id must be/);
    refuse(base().replace("domain_tags: [domain-a]", "domain_tags: [domain-b]"), /isn't one of the seed's tags/);
    refuse("---\nid: [\n---\n", /doesn't parse/);
    refuse("no yaml here", /no YAML/);
    refuse(base().replace("version: 1", "version: 0"), /version/);
  });
});

describe("AC-SEED-02/03: what apply does to one item", () => {
  const h = seedHash("seed body v1");
  const d = (over: Partial<Parameters<typeof decideItem>[0]>) =>
    decideItem({ present: true, recordedHash: h, currentHash: h, recordedVersion: 1, seedVersion: 1, seedHash: h, upgrade: false, ...over });
  it("absent → create; untouched → unchanged; edited → kept_human_edit (with or without upgrade)", () => {
    // S7-R2 L2 changed this: absent AND never recorded → create (a recorded one a person deleted is kept_human_delete).
    expect(d({ present: false, recordedHash: null })).toBe("create");
    expect(d({})).toBe("unchanged");
    expect(d({ currentHash: seedHash("a person edited this") })).toBe("kept_human_edit");
    expect(d({ currentHash: seedHash("a person edited this"), upgrade: true, seedVersion: 2, seedHash: seedHash("v2") })).toBe("kept_human_edit");
    expect(d({ recordedHash: null })).toBe("kept_human_edit");
  });
  it("a newer seed version: upgrade_available without upgrade, updated with it; never for an equal version", () => {
    expect(d({ seedVersion: 2, seedHash: seedHash("v2") })).toBe("upgrade_available");
    expect(d({ seedVersion: 2, seedHash: seedHash("v2"), upgrade: true })).toBe("updated");
    expect(d({ seedVersion: 1, seedHash: seedHash("v2"), upgrade: true })).toBe("unchanged");
  });
  it("the hash ignores CRLF and surrounding whitespace", () => {
    expect(seedHash("a\r\nb\n\n")).toBe(seedHash("a\nb"));
  });
});

describe("AC-SEED-08: never_propose categories as a deterministic filter", () => {
  it("matches a category as words (hyphens and underscores are spaces), case-insensitive", () => {
    expect(categoryHit("The LITIGATION goes to mediation", ["litigation"])).toBe(true);
    expect(categoryHit("their personal life is complicated", ["personal-life"])).toBe(true);
    expect(categoryHit("a litigator was hired", ["litigation"])).toBe(false);
    expect(categoryHit("anything", [])).toBe(false);
  });
});

describe("AC-SEED-06: seed content is data, not code", () => {
  it("AC-SEED-06: no bundled seed's folder name appears in src/surfaces/** (as a path or a quoted literal)", () => {
    const names = new Set<string>();
    for (const id of bundled()) for (const n of folderNames(parseManifest(manifestOf(id)))) names.add(n);
    expect(names.size).toBeGreaterThan(0);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    const esc = [...names].map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
    const re = new RegExp(`(?<![\\w-])(${esc})/|["'\`](${esc})["'\`]`, "g");
    const hits: string[] = [];
    for (const f of walk(join(process.cwd(), "src", "surfaces"))) {
      for (const m of readFileSync(f, "utf8").matchAll(re)) hits.push(`${f.split("src/surfaces/")[1]}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("judge schema: seed-driven folders and tags", () => {
  it("admin_only folders take only agent suggestions; tags must be among the seed's domain tags (≤ 3)", async () => {
    const { validateVerdict } = await import("../src/surfaces/core/judge-schema.js");
    const w = { forced: false, messages: [{ id: "m1", author_display: "Ann", text: "we agreed" }], mentions: [] };
    const item = (over: Record<string, unknown>) => ({
      verdict: "propose",
      reason_code: "proposed",
      ask_signature: null,
      items: [{ kind: "decision", op: "new", target_folder: "alpha/", target_node_id: null, title: "A decision made", summary: "S.", body: "B.", owner: null, due_date: null, evidence_message_ids: ["m1"], why: "w", confidence: 0.9, sensitive: false, conflict: null, ...over }],
    });
    const n = { nodeIds: new Set<string>(), folders: ["alpha/", "beta/"], adminFolders: ["beta/"], domainTags: ["domain-a"] };
    expect(validateVerdict(item({}), w, n).ok).toBe(true);
    expect(validateVerdict(item({ target_folder: "beta/" }), w, n)).toEqual({ ok: false, error: "target_folder" });
    const tagged = validateVerdict(item({ tags: ["domain-a"] }), w, n);
    expect(tagged.ok && tagged.verdict.items[0].tags).toEqual(["domain-a"]);
    expect(validateVerdict(item({ tags: ["other"] }), w, n)).toEqual({ ok: false, error: "tags" });
    expect(validateVerdict(item({ tags: ["domain-a", "domain-a", "domain-a", "domain-a"] }), w, n)).toEqual({ ok: false, error: "tags" });
    expect(validateVerdict(item({ tags: ["domain-a"] }), w, { ...n, domainTags: [] })).toEqual({ ok: false, error: "tags" });
  });
});

// ═══ Security round 2 (run/s7-security-s3/security.md) — pure parts ═════════

describe("S7-R2 L2: a seeded item a person deleted is not re-created", () => {
  it("L2: absent + recorded → kept_human_delete (with or without upgrade); absent + never recorded → create", () => {
    const h = seedHash("x");
    const base = { present: false, recordedHash: h, currentHash: null, recordedVersion: 1, seedVersion: 2, seedHash: seedHash("y") };
    expect(decideItem({ ...base, upgrade: false })).toBe("kept_human_delete");
    expect(decideItem({ ...base, upgrade: true })).toBe("kept_human_delete");
    expect(decideItem({ ...base, recordedHash: null, upgrade: false })).toBe("create");
  });
});

describe("generic-team never_propose terms don't eat the seed's own business content", () => {
  const terms = () => {
    const l = parseManifest(manifestOf("generic-team")).listener as { never_propose: string[]; never_terms: string[] };
    return [...l.never_propose, ...l.never_terms];
  };
  it.each([
    "Priya is the relationship owner for the Globex account",
    "We agreed to protect the customer relationship during the renewal",
    "Decision: close the Series A equity round by March",
    "The build was sick after the dependency bump",
  ])("passes: %s", (text) => expect(categoryHit(text, terms())).toBe(false));
  it.each([
    "Sam is off sick until Thursday",
    "she mentioned she is in therapy",
    "he is dating someone from sales",
    "their romantic relationship ended",
    "my equity grant vests next year",
    "salary bands for next year",
  ])("blocks: %s", (text) => expect(categoryHit(text, terms())).toBe(true));
});

describe("S7-R2 L5: never_propose is normalised, has seed-data synonyms, and covers every text field", () => {
  it("L5: plurals and simple inflections match on both sides", () => {
    expect(categoryHit("two leaked credential files", ["credentials"])).toBe(true);
    expect(categoryHit("the salaries were discussed", ["salary"])).toBe(true);
    expect(categoryHit("ongoing litigations", ["litigation"])).toBe(true);
    expect(categoryHit("he was diagnosed", ["diagnosis"])).toBe(false); // no fuzzy guessing beyond simple stems
    expect(categoryHit("THE LAWSUITS", ["lawsuit"])).toBe(true);
  });
  it("L5: a manifest may give never_propose as {category, terms}; terms are words, not code", () => {
    const m = parseManifest(base().replace("never_propose: [compensation]", "never_propose: [{ category: compensation, terms: [salary, pay rise, bonus] }, credentials]"));
    expect(m.listener.never_propose).toEqual(["compensation", "credentials"]);
    expect(m.listener.never_terms).toEqual(["salary", "pay rise", "bonus"]);
    refuse(base().replace("never_propose: [compensation]", "never_propose: [{ category: compensation, terms: [\"<script>\"] }]"), /term/);
  });
  it("L5: every default category in generic-team carries synonyms in the seed data", () => {
    const raw = readFileSync(join(SEEDS, "generic-team", "seed.md"), "utf8");
    const m = parseManifest(raw);
    expect(m.listener.never_propose.length).toBeGreaterThan(3);
    expect(m.listener.never_terms.length).toBeGreaterThanOrEqual(m.listener.never_propose.length * 2);
  });
  it("L5: applyBar checks title, summary, body, why, owner, agent and conflict fields", async () => {
    const { applyBar } = await import("../src/surfaces/core/judge-schema.js");
    const w = { forced: false, messages: [{ id: "m1", author_display: "Ann", text: "we agreed on the plan for the quarter" }], mentions: [] };
    const item = (over: Record<string, unknown>) => ({
      kind: "decision", op: "new", target_folder: "alpha/", target_node_id: null, title: "Quarter plan agreed", summary: "S.", body: "B.",
      owner: null, due_date: null, evidence_message_ids: ["m1"], why: "w", confidence: 0.9, sensitive: false, conflict: null, agent: null, tags: [], ...over,
    }) as any;
    const ctx = { forced: false, threshold: 0.7, window: w, otherNodeTexts: () => [], folderExists: () => true, duplicate: null, neverPropose: ["litigation"] };
    expect(applyBar(item({}), ctx)).toEqual({ pass: true, previously_held_on: null });
    expect(applyBar(item({ agent: { name: "Litigations tracker", description: "d", read_folders: [] } }), ctx)).toEqual({ pass: false, reason: "sensitive" });
    expect(applyBar(item({ op: "edit", conflict: { node_id: "nodes/x", on_record_claim: "a", thread_claim: "the litigation moved" } }), ctx)).toEqual({ pass: false, reason: "sensitive" });
    expect(applyBar(item({ agent: { name: "Pay tracker", description: "tracks salary bands", read_folders: [] } }), { ...ctx, neverPropose: [] })).toEqual({ pass: false, reason: "sensitive" });
  });
});

describe("S7-R2 L6: reserved names and the CONTEXT.md body", () => {
  it("L6: node targets and the thesis may not use a name storage treats specially (context, index, readme, view, seed, agent-config names)", () => {
    for (const leaf of ["context", "index", "readme", "view", "seed", "claude", "gemini"]) {
      refuse(base().replace("{ id: seeds/t1/thesis, target: thesis }", `{ id: seeds/t1/thesis, target: alpha/${leaf} }`), /reserved/);
    }
    refuse(base().replace("{ id: seeds/t1/thesis, target: thesis }", "{ id: seeds/t1/thesis, target: index }"), /reserved/);
    // A seed node's own id can't use one either (a library nest couldn't store it).
    refuse(base().replace("{ id: seeds/t1/instructions, target: context }", "{ id: seeds/t1/context, target: context }"), /reserved/);
    refuse(base().replace("thesis: seeds/t1/thesis", "thesis: seeds/t1/index").replace("{ id: seeds/t1/thesis, target: thesis }", "{ id: seeds/t1/index, target: thesis }"), /reserved/);
  });
  it("L6: an empty CONTEXT.md body is refused (the instructions validation)", () => {
    const m = parseManifest(base());
    const contents = new Map([
      ["seeds/t1/instructions", { title: "Ctx", body: "   \n " }],
      ["seeds/t1/thesis", { title: "Thesis", body: "t" }],
    ]);
    expect(() => assertSeedSize(base(), m, contents)).toThrow(/instructions/i);
  });
});

describe("S7-R2 INFO: bundled seeds", () => {
  it("INFO: no symlinks anywhere under seeds/", async () => {
    const { lstatSync } = await import("fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return [p];
      return st.isDirectory() ? walk(p) : [];
    });
    expect(walk(SEEDS)).toEqual([]);
  });
  it("INFO: the bundled seeds directory is the package root's, never a parent's", async () => {
    const { bundledSeedsDir } = await import("../src/surfaces/services/seed-service.js");
    expect(bundledSeedsDir()).toBe(SEEDS);
  });
});
