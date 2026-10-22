/**
 * The metacognition setup form's logic, kept out of the component so it can
 * be unit-tested (CU-wdqcq05rkp).
 *
 * The form asks plain questions — what should it look at, what may it
 * change, how much may it do each run — and maps the answers onto the config
 * the server stores, losslessly both ways: a saved config reopened in the form
 * saves back unchanged. Scope semantics are the server's
 * (src/metacognition/config.ts): read [] = the whole nest; propose [] = no
 * edits (comments only); propose ["*"] = anywhere it reads.
 */
import type { MetacognitionAgentConfig, MetacognitionSuggestion } from "./api";

export interface Caps {
  max_steps: number;
  max_tokens: number;
  max_seconds: number;
  max_proposals: number;
  max_comments: number;
}

export type Effort = "light" | "standard" | "thorough";

/**
 * How much an agent may do per run. Standard is the server's defaults (CAPS
 * in src/metacognition/config.ts), so an untouched config is Standard. Light
 * is a quick look that can't cost much; Thorough is a long pass over a big
 * folder. Both sit well inside the server ceilings (50 turns, 2M tokens,
 * 30 minutes, 20 proposals, 20 comments).
 */
export const PRESETS: Record<Effort, Caps> = {
  light: { max_steps: 6, max_tokens: 100_000, max_seconds: 120, max_proposals: 2, max_comments: 3 },
  standard: { max_steps: 12, max_tokens: 300_000, max_seconds: 300, max_proposals: 5, max_comments: 5 },
  thorough: { max_steps: 30, max_tokens: 1_000_000, max_seconds: 900, max_proposals: 12, max_comments: 10 },
};

export const EFFORT_LABEL: Record<Effort | "custom", string> = {
  light: "Light",
  standard: "Standard",
  thorough: "Thorough",
  custom: "Custom",
};

const CAP_KEYS: Array<keyof Caps> = ["max_steps", "max_tokens", "max_seconds", "max_proposals", "max_comments"];

/** Which preset these caps are, or "custom" once any number differs. */
export function presetOf(caps: Caps): Effort | "custom" {
  for (const e of Object.keys(PRESETS) as Effort[]) {
    if (CAP_KEYS.every((k) => PRESETS[e][k] === caps[k])) return e;
  }
  return "custom";
}

/**
 * A rough upper bound on what a run costs, for the effort hint. Not a quote:
 * the model is the nest's choice and most of a run's tokens are cheap cache
 * re-reads. $3 per million tokens is about a Sonnet-class model's blend of
 * input, output and cache reads.
 */
const ROUGH_USD_PER_MTOK = 3;

/** "about 5 minutes, up to 5 suggestions and 5 comments, ≈$0.90 at most".
 *  No $ figure for a chosen model: the rough rate is a default-model guess. */
export function effortText(caps: Caps, model = ""): string {
  const mins = caps.max_seconds / 60;
  const time = mins < 1 ? `about ${caps.max_seconds} seconds` : `about ${Math.round(mins)} minute${Math.round(mins) === 1 ? "" : "s"}`;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const cost = (caps.max_tokens / 1_000_000) * ROUGH_USD_PER_MTOK;
  const work = `${time}, up to ${plural(caps.max_proposals, "suggestion")} and ${plural(caps.max_comments, "comment")}`;
  return model.trim() ? work : `${work}, ≈$${cost.toFixed(2)} at most`;
}

export type ProposeMode = "none" | "reads" | "folders";

export interface FeedRow {
  name: string;
  url: string;
}

export interface McpRow {
  name: string;
  url: string;
  /** Comma-separated tool names, as typed. */
  tools: string;
  auth_env: string;
}

export interface FormState {
  node_id: string;
  enabled: boolean;
  name: string;
  avatar: string;
  /** "The whole nest". When false, `read` lists the folders. */
  readAll: boolean;
  read: string[];
  proposeMode: ProposeMode;
  /** Used when proposeMode is "folders". */
  propose: string[];
  caps: Caps;
  feeds: FeedRow[];
  mcp: McpRow[];
  model: string;
}

export function emptyForm(node_id: string, title: string): FormState {
  return {
    node_id,
    enabled: true,
    name: title.slice(0, 60),
    avatar: "",
    readAll: true,
    read: [],
    proposeMode: "none",
    propose: [],
    caps: { ...PRESETS.standard },
    feeds: [],
    mcp: [],
    model: "",
  };
}

const splitTools = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function formFromConfig(node_id: string, enabled: boolean, c: MetacognitionAgentConfig): FormState {
  const propose = c.scope.propose;
  return {
    node_id,
    enabled,
    name: c.persona.name,
    // A URL avatar saved before glyph-only avatars is dropped on the next save.
    avatar: c.persona.avatar && !c.persona.avatar.includes("://") ? c.persona.avatar : "",
    readAll: c.scope.read.length === 0,
    read: [...c.scope.read],
    proposeMode: propose.length === 0 ? "none" : propose[0] === "*" ? "reads" : "folders",
    propose: propose[0] === "*" ? [] : [...propose],
    caps: {
      max_steps: c.caps.max_steps,
      max_tokens: c.caps.max_tokens,
      max_seconds: c.caps.max_seconds,
      max_proposals: c.caps.max_proposals,
      max_comments: c.caps.max_comments ?? PRESETS.standard.max_comments,
    },
    feeds: c.feeds.map((f) => ({ name: f.name, url: f.url })),
    mcp: c.mcp_servers.map((m) => ({
      name: m.name,
      url: m.url,
      tools: m.allowed_tools.join(", "),
      auth_env: m.auth_env ?? "",
    })),
    model: c.model ?? "",
  };
}

export function configFromForm(f: FormState): MetacognitionAgentConfig & { enabled: boolean } {
  return {
    enabled: f.enabled,
    persona: { name: f.name.trim(), avatar: f.avatar.trim() || null },
    scope: {
      read: f.readAll ? [] : [...f.read],
      propose: f.proposeMode === "none" ? [] : f.proposeMode === "reads" ? ["*"] : [...f.propose],
    },
    caps: { ...f.caps },
    feeds: f.feeds.map((r) => ({ name: r.name.trim(), url: r.url.trim() })),
    mcp_servers: f.mcp.map((r) => ({
      name: r.name.trim(),
      url: r.url.trim(),
      allowed_tools: splitTools(r.tools),
      ...(r.auth_env.trim() ? { auth_env: r.auth_env.trim() } : {}),
    })),
    model: f.model.trim() || null,
  };
}

/** Is `folder` inside one of `list` (itself or a subfolder)? */
const within = (folder: string, list: string[]) => list.some((r) => folder === r || folder.startsWith(`${r}/`));

/** Tick or untick a folder it reads. Folders it may change must stay inside
 *  what it reads (the server refuses otherwise), so an untick prunes those. */
export function toggleReadFolder(f: FormState, folder: string, on: boolean): FormState {
  const read = on ? [...new Set([...f.read, folder])] : f.read.filter((r) => r !== folder);
  return { ...f, readAll: false, read, propose: f.propose.filter((p) => within(p, read)) };
}

/** What stops this form saving, in plain words; empty when it can save. */
export function formProblems(f: FormState): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push("Give it a name.");
  if (!f.readAll && f.read.length === 0) out.push('Pick at least one folder for it to look at, or choose "The whole nest".');
  if (f.proposeMode === "folders" && f.propose.length === 0) {
    out.push('Pick at least one folder it may change, or choose "Nothing".');
  }
  f.feeds.forEach((r, i) => {
    if (!r.name.trim() || !r.url.trim()) out.push(`Feed ${i + 1} needs a name and a link.`);
  });
  f.mcp.forEach((r, i) => {
    const label = r.name.trim() || `MCP server ${i + 1}`;
    if (!r.name.trim() || !r.url.trim()) out.push(`MCP server ${i + 1} needs a name and a link.`);
    if (splitTools(r.tools).length === 0) out.push(`${label}: list the tools it may call (at least one), or remove it.`);
  });
  return out;
}

/** "gtm", "gtm and ops", "gtm, ops and sales" */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One sentence that says what the saved config lets the agent do. */
export function summarize(c: MetacognitionAgentConfig): string {
  const who = c.persona.name.trim() || "This agent";
  const reads = c.scope.read.length ? `reads ${joinList(c.scope.read)}` : "reads the whole nest";
  const comments = c.caps.max_comments ?? PRESETS.standard.max_comments;
  const changes =
    c.scope.propose.length === 0
      ? `only leaves comments (up to ${comments} per run)`
      : `may suggest edits ${c.scope.propose[0] === "*" ? "anywhere it reads" : `in ${joinList(c.scope.propose)}`}, up to ${c.caps.max_proposals} per run`;
  return `${who} ${reads}, ${changes}, and never publishes anything itself.`;
}

/** Why each field a suggestion fills was filled that way, for the hints. */
export function prefilledFrom(s: MetacognitionSuggestion): Record<string, string> {
  const prefilled: Record<string, string> = {};
  for (const k of ["persona.name", "persona.avatar", "scope.read", "scope.propose", "feeds", "mcp_servers"]) {
    if (s.why[k]) prefilled[k] = s.why[k];
  }
  if (s.mcp_candidates.length && !prefilled.mcp_servers) {
    prefilled.mcp_servers = "The instructions link an MCP server. Name the tools it may call before saving.";
  }
  return prefilled;
}

/**
 * Fill the form from the document's suggestion. Returns the new form and,
 * per prefilled field, why it was filled that way (for the "from the agent
 * document" hints). The agent document and on/off stay the owner's.
 *
 * `keepSettings` (re-suggesting an agent that is already set up): the
 * suggestion only has an opinion on the name, picture, scope and links, so
 * the saved limits, model and configured MCP servers and feeds are kept, and
 * links the document names are added next to them.
 */
export function applySuggestion(
  f: FormState,
  s: MetacognitionSuggestion,
  opts: { keepSettings?: boolean } = {},
): { form: FormState; prefilled: Record<string, string> } {
  const fromDoc = formFromConfig(f.node_id, f.enabled, s.config);
  const candidates: McpRow[] = s.mcp_candidates.map((m) => ({ name: m.name, url: m.url, tools: "", auth_env: "" }));
  const form: FormState = opts.keepSettings
    ? {
        ...fromDoc,
        caps: { ...f.caps },
        model: f.model,
        feeds: [...f.feeds, ...fromDoc.feeds.filter((r) => !f.feeds.some((o) => o.url === r.url))],
        mcp: [...f.mcp, ...candidates.filter((r) => !f.mcp.some((o) => o.url === r.url))],
      }
    : { ...fromDoc, mcp: candidates };
  return { form, prefilled: prefilledFrom(s) };
}

/**
 * Switch the form to another agent document. It starts empty (the whole
 * nest, comments only, no links) rather than carrying the previous
 * document's scope, so if the new document's suggestion fails to load, what
 * could be saved is the fail-closed default, never another agent's grants.
 */
export function pickDocument(f: FormState, node_id: string, title: string): FormState {
  return { ...emptyForm(node_id, title), enabled: f.enabled };
}

/**
 * Metacognition is an owner/admin feature for every action (Misha,
 * 2026-10-22): only they see Workflows → Agents — the panel, Run now and the
 * Activity history. A writer doesn't.
 */
export function canManageMetacognition(enabled: boolean, nestPermission: string | undefined): boolean {
  return enabled && (nestPermission === "owner" || nestPermission === "admin");
}

/**
 * Is Save off? Also while a suggestion is loading: picking another document
 * sets node_id at once, but the scope on screen is still the previous
 * document's until its suggestion lands, and saving then would grant the new
 * document the old one's scope.
 */
export function saveBlocked(f: FormState, state: { saving: boolean; suggesting: boolean }): boolean {
  return state.saving || state.suggesting || !f.node_id || formProblems(f).length > 0;
}
