import { describe, it, expect } from "vitest";
import {
  PRESETS,
  presetOf,
  formFromConfig,
  configFromForm,
  emptyForm,
  summarize,
  effortText,
  applySuggestion,
  formProblems,
  toggleReadFolder,
  type FormState,
} from "./metacognition-form";
import type { MetacognitionAgentConfig } from "./api";

// The server's defaults (src/metacognition/config.ts CAPS). Standard must be
// exactly these, so a Standard agent is what an untouched config already was.
const SERVER_DEFAULTS = { max_steps: 12, max_tokens: 300_000, max_seconds: 300, max_proposals: 5, max_comments: 5 };
// …and the ceilings no preset may exceed.
const CEILINGS = {
  max_steps: [1, 50],
  max_tokens: [10_000, 2_000_000],
  max_seconds: [10, 1_800],
  max_proposals: [0, 20],
  max_comments: [0, 20],
} as const;

const base: MetacognitionAgentConfig = {
  persona: { name: "Archivist", avatar: "🦉" },
  scope: { read: ["gtm", "ops"], propose: ["gtm"] },
  caps: { ...SERVER_DEFAULTS },
  feeds: [],
  mcp_servers: [],
  model: null,
  // The server always returns a notify block; no recipients = off.
  notify: { recipients: [], channels: [], max_per_run: 3 },
};

describe("effort presets", () => {
  it("Standard is the server defaults", () => {
    expect(PRESETS.standard).toEqual(SERVER_DEFAULTS);
  });

  it("Light and Thorough stay inside the server ceilings, Light < Standard < Thorough", () => {
    for (const p of [PRESETS.light, PRESETS.thorough]) {
      for (const [k, [min, max]] of Object.entries(CEILINGS)) {
        const v = p[k as keyof typeof p];
        expect(v, k).toBeGreaterThanOrEqual(min);
        expect(v, k).toBeLessThanOrEqual(max);
      }
    }
    for (const k of Object.keys(CEILINGS) as Array<keyof typeof SERVER_DEFAULTS>) {
      expect(PRESETS.light[k], k).toBeLessThanOrEqual(PRESETS.standard[k]);
      expect(PRESETS.thorough[k], k).toBeGreaterThanOrEqual(PRESETS.standard[k]);
    }
  });

  it("picking Standard saves the Standard caps", () => {
    const f: FormState = { ...formFromConfig("nodes/a", true, { ...base, caps: { ...PRESETS.light } }), caps: { ...PRESETS.standard } };
    expect(configFromForm(f).caps).toEqual(PRESETS.standard);
  });

  it("reads Custom once any advanced number differs from a preset", () => {
    expect(presetOf(PRESETS.light)).toBe("light");
    expect(presetOf(PRESETS.standard)).toBe("standard");
    expect(presetOf(PRESETS.thorough)).toBe("thorough");
    expect(presetOf({ ...PRESETS.standard, max_seconds: 301 })).toBe("custom");
    expect(presetOf({ ...PRESETS.thorough, max_comments: 0 })).toBe("custom");
  });

  it("describes a preset in plain words: minutes, suggestions, a rough cost", () => {
    const t = effortText(PRESETS.standard);
    expect(t).toMatch(/about 5 minutes/);
    expect(t).toMatch(/up to 5 suggestions/);
    expect(t).toMatch(/\$\d+\.\d\d/);
  });
});

describe("form ⇄ config", () => {
  const configs: Array<[string, MetacognitionAgentConfig]> = [
    ["named folders", base],
    ["whole nest, propose anywhere it reads", { ...base, scope: { read: [], propose: ["*"] } }],
    ["comments only", { ...base, scope: { read: ["gtm"], propose: [] } }],
    ["whole nest, propose in named", { ...base, scope: { read: [], propose: ["gtm/deals"] } }],
    [
      "feeds, MCP servers, model, no avatar, custom caps",
      {
        persona: { name: "Scout", avatar: null },
        scope: { read: ["gtm"], propose: ["*"] },
        caps: { max_steps: 7, max_tokens: 123_000, max_seconds: 45, max_proposals: 0, max_comments: 9 },
        feeds: [{ name: "news", url: "https://feeds.example.com/a.xml" }],
        mcp_servers: [
          { name: "desk", url: "https://desk.example.com/mcp", allowed_tools: ["search", "get"], auth_env: "MCP_DESK_TOKEN" },
          { name: "wiki", url: "https://wiki.example.com/mcp", allowed_tools: ["read"] },
        ],
        model: "claude-sonnet-5",
        notify: { recipients: [], channels: [], max_per_run: 3 },
      },
    ],
    ["a folder the nest no longer has", { ...base, scope: { read: ["gone"], propose: ["gone"] } }],
    [
      "notify on: people and both channels",
      { ...base, notify: { recipients: ["owner", "ann@example.com"], channels: ["email", "connectors"], max_per_run: 5 } },
    ],
  ];

  for (const [label, cfg] of configs) {
    it(`round-trips losslessly: ${label}`, () => {
      const form = formFromConfig("nodes/a", false, cfg);
      expect(configFromForm(form)).toEqual({ ...cfg, enabled: false });
      // and form → config → form
      expect(formFromConfig("nodes/a", false, configFromForm(form))).toEqual(form);
    });
  }

  it("maps scope semantics to plain choices", () => {
    expect(formFromConfig("n", true, { ...base, scope: { read: [], propose: [] } })).toMatchObject({ readAll: true, proposeMode: "none" });
    expect(formFromConfig("n", true, { ...base, scope: { read: ["gtm"], propose: ["*"] } })).toMatchObject({ readAll: false, proposeMode: "reads" });
    expect(formFromConfig("n", true, base)).toMatchObject({ proposeMode: "folders", propose: ["gtm"] });
  });

  it("unticking a folder it reads drops it from where it may suggest edits", () => {
    const f = toggleReadFolder(formFromConfig("n", true, base), "gtm", false);
    expect(f.read).toEqual(["ops"]);
    expect(f.propose).toEqual([]);
  });

  it("names what blocks a save, in plain words", () => {
    const f = formFromConfig("n", true, base);
    expect(formProblems(f)).toEqual([]);
    expect(formProblems({ ...f, name: "" }).join(" ")).toMatch(/name/i);
    expect(formProblems({ ...f, proposeMode: "folders", propose: [] }).join(" ")).toMatch(/folder/i);
    expect(formProblems({ ...f, readAll: false, read: [] }).join(" ")).toMatch(/folder|whole nest/i);
    expect(
      formProblems({ ...f, mcp: [{ name: "desk", url: "https://desk.example.com/mcp", tools: "", auth_env: "" }] }).join(" "),
    ).toMatch(/tool/i);
  });
});

describe("summary sentence", () => {
  it("whole nest, may suggest edits anywhere it reads", () => {
    expect(summarize({ ...base, scope: { read: [], propose: ["*"] } })).toBe(
      "Archivist reads the whole nest, may suggest edits anywhere it reads, up to 5 per run, and never publishes anything itself.",
    );
  });

  it("named folders, may suggest edits in one", () => {
    expect(summarize(base)).toBe(
      "Archivist reads gtm and ops, may suggest edits in gtm, up to 5 per run, and never publishes anything itself.",
    );
  });

  it("propose * with named folders", () => {
    expect(summarize({ ...base, scope: { read: ["gtm", "ops", "sales"], propose: ["*"] } })).toBe(
      "Archivist reads gtm, ops and sales, may suggest edits anywhere it reads, up to 5 per run, and never publishes anything itself.",
    );
  });

  it("propose empty = comments only", () => {
    expect(summarize({ ...base, scope: { read: ["gtm"], propose: [] } })).toBe(
      "Archivist reads gtm, only leaves comments (up to 5 per run), and never publishes anything itself.",
    );
  });

  it("uses a placeholder name until one is typed", () => {
    expect(summarize({ ...base, persona: { name: "", avatar: null } })).toMatch(/^This agent reads/);
  });
});

describe("prefill from the agent document", () => {
  it("applies the suggestion and marks each prefilled field with its why", () => {
    const start = emptyForm("nodes/archivist", "Archivist");
    const { form, prefilled } = applySuggestion(start, {
      config: { ...base, scope: { read: ["gtm"], propose: ["*"] }, feeds: [{ name: "news", url: "https://feeds.example.com/a.xml" }] },
      why: { "scope.read": "The instructions mention nodes/gtm/.", "scope.propose": 'The instructions say "update".', feeds: "Found 1 feed link." },
      mcp_candidates: [{ name: "desk", url: "https://desk.example.com/mcp" }],
      instructions: "approved",
    });
    expect(form).toMatchObject({ readAll: false, read: ["gtm"], proposeMode: "reads" });
    expect(form.feeds).toEqual([{ name: "news", url: "https://feeds.example.com/a.xml" }]);
    // An MCP server needs its tools named by a person before it can be saved.
    expect(form.mcp).toEqual([{ name: "desk", url: "https://desk.example.com/mcp", tools: "", auth_env: "" }]);
    expect(prefilled["scope.read"]).toMatch(/nodes\/gtm\//);
    expect(prefilled["scope.propose"]).toBeTruthy();
    expect(prefilled.feeds).toBeTruthy();
    expect(prefilled.mcp_servers).toBeTruthy();
    // The node and on/off are the owner's, not the document's.
    expect(form.node_id).toBe("nodes/archivist");
    expect(form.enabled).toBe(true);
  });
});

describe("who sees the Agents tab (admin-only feature)", () => {
  it("only a nest owner or admin, and only with metacognition on", async () => {
    const { canManageMetacognition } = await import("./metacognition-form");
    expect(canManageMetacognition(true, "owner")).toBe(true);
    expect(canManageMetacognition(true, "admin")).toBe(true);
    for (const p of ["write", "read", "public", undefined]) expect(canManageMetacognition(true, p), String(p)).toBe(false);
    expect(canManageMetacognition(false, "owner")).toBe(false);
  });
});

describe("Save (review round 1)", () => {
  it("is blocked while a suggestion for a newly picked document is loading", async () => {
    const { saveBlocked } = await import("./metacognition-form");
    const f = formFromConfig("nodes/a", true, base);
    expect(saveBlocked(f, { saving: false, suggesting: false })).toBe(false);
    expect(saveBlocked(f, { saving: false, suggesting: true })).toBe(true);
    expect(saveBlocked(f, { saving: true, suggesting: false })).toBe(true);
    expect(saveBlocked({ ...f, name: "" }, { saving: false, suggesting: false })).toBe(true);
    expect(saveBlocked({ ...f, node_id: "" }, { saving: false, suggesting: false })).toBe(true);
  });
});

describe("review round 2", () => {
  const suggestion = {
    config: {
      ...base,
      persona: { name: "Doc Name", avatar: null },
      scope: { read: ["ops"], propose: [] },
      feeds: [{ name: "news", url: "https://feeds.example.com/a.xml" }],
    },
    why: { "scope.read": "The instructions mention nodes/ops/." },
    mcp_candidates: [
      { name: "desk", url: "https://desk.example.com/mcp" },
      { name: "wiki", url: "https://wiki.example.com/mcp" },
    ],
    instructions: "approved" as const,
  };

  it("picking another document starts from an empty, fail-closed form, never the previous one's scope", async () => {
    const { pickDocument } = await import("./metacognition-form");
    const a = formFromConfig("nodes/a", false, { ...base, scope: { read: [], propose: ["*"] }, feeds: [{ name: "n", url: "https://x.example.com/f.xml" }] });
    const b = pickDocument(a, "nodes/b", "Bee");
    expect(b).toEqual({ ...emptyForm("nodes/b", "Bee"), enabled: false });
    expect(configFromForm(b).scope).toEqual({ read: [], propose: [] });
  });

  it("re-suggesting an existing agent keeps its caps, model, MCP servers and feeds", async () => {
    const { applySuggestion: apply } = await import("./metacognition-form");
    const saved = formFromConfig("nodes/a", true, {
      ...base,
      caps: { ...PRESETS.thorough, max_seconds: 600 },
      model: "claude-opus-5",
      feeds: [{ name: "old", url: "https://old.example.com/feed" }],
      mcp_servers: [{ name: "desk", url: "https://desk.example.com/mcp", allowed_tools: ["search"], auth_env: "MCP_DESK_TOKEN" }],
    });
    const { form } = apply(saved, suggestion, { keepSettings: true });
    expect(form.caps).toEqual(saved.caps);
    expect(form.model).toBe("claude-opus-5");
    // The configured desk row is kept as-is; only the new MCP link is added.
    expect(form.mcp).toEqual([
      { name: "desk", url: "https://desk.example.com/mcp", tools: "search", auth_env: "MCP_DESK_TOKEN" },
      { name: "wiki", url: "https://wiki.example.com/mcp", tools: "", auth_env: "" },
    ]);
    expect(form.feeds).toEqual([
      { name: "old", url: "https://old.example.com/feed" },
      { name: "news", url: "https://feeds.example.com/a.xml" },
    ]);
    // What the suggestion has an opinion on still comes from the document.
    expect(form).toMatchObject({ name: "Doc Name", readAll: false, read: ["ops"], proposeMode: "none" });
  });

  it("prefilledFrom gives the hints of a suggestion alone", async () => {
    const { prefilledFrom } = await import("./metacognition-form");
    expect(prefilledFrom(suggestion)).toMatchObject({ "scope.read": "The instructions mention nodes/ops/." });
    expect(prefilledFrom(suggestion).mcp_servers).toBeTruthy();
  });

  it("leaves out the $ estimate when a non-default model is set", () => {
    expect(effortText(PRESETS.standard, "claude-opus-5")).not.toMatch(/\$/);
    expect(effortText(PRESETS.standard, "")).toMatch(/\$/);
  });
});

describe("review round 4", () => {
  it("warns when it may suggest edits anywhere in the whole nest", async () => {
    const { wideScopeWarning } = await import("./metacognition-form");
    expect(wideScopeWarning(formFromConfig("n", true, { ...base, scope: { read: [], propose: ["*"] } }))).toMatch(/every document/i);
    expect(wideScopeWarning(formFromConfig("n", true, { ...base, scope: { read: ["gtm"], propose: ["*"] } }))).toBeNull();
    expect(wideScopeWarning(formFromConfig("n", true, { ...base, scope: { read: [], propose: [] } }))).toBeNull();
  });
});

describe("review round 6", () => {
  it("says in plain words when the name has characters the server refuses", () => {
    const f = emptyForm("nodes/a", "🤖 Pricing watcher");
    expect(formProblems(f).join(" ")).toMatch(/name/i);
    expect(formProblems({ ...f, name: "Pricing watcher" })).toEqual([]);
  });

  it("calls the cost a rough figure, not a ceiling", () => {
    expect(effortText(PRESETS.standard)).toMatch(/roughly \$0\.90/);
  });
});

describe("notify (merged with CU-wdqcq05rkq)", () => {
  const notify = { recipients: ["owner"], channels: ["email" as const], max_per_run: 2 };
  const suggestion = { config: base, why: {}, mcp_candidates: [], instructions: "approved" as const };

  it("a suggestion never changes who it may notify, new setup or re-suggest", () => {
    const f = formFromConfig("nodes/a", true, { ...base, notify });
    for (const keepSettings of [true, false]) {
      expect(configFromForm(applySuggestion(f, suggestion, { keepSettings }).form).notify).toEqual(notify);
    }
  });

  it("picking another document turns notify off", async () => {
    const { pickDocument } = await import("./metacognition-form");
    const f = formFromConfig("nodes/a", true, { ...base, notify });
    expect(configFromForm(pickDocument(f, "nodes/b", "Bee")).notify?.recipients).toEqual([]);
  });
});
