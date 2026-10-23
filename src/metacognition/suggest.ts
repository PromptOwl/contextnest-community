/**
 * A starting config for a metacognition agent, read off its agent document
 * (CU-wdqcq05rkp) — what GET /metacognition/:node/suggest returns to prefill
 * the setup form.
 *
 * Deterministic heuristics, no model call, and never saved: a person reviews
 * every field before it becomes a scope. Each suggested field carries a `why`
 * in plain words, so the form can say where it came from. Everything in
 * `config` passes parseConfig unchanged; an MCP server can't (its allowed
 * tools have to be named by a person), so those come back separately as
 * `mcp_candidates`.
 */
import { CAPS, urlAllowed, type MetacognitionConfig } from "./config.js";

export interface SuggestInput {
  title: string;
  frontmatter: Record<string, unknown>;
  /** The agent's approved instructions; null when none are approved yet. */
  instructions: string | null;
  /** Every folder path in the nest (under nodes/), e.g. "gtm", "gtm/deals". */
  folders: string[];
}

export interface Suggestion {
  config: MetacognitionConfig;
  /** Keyed by config field ("persona.name", "scope.read", "feeds", …). */
  why: Record<string, string>;
  mcp_candidates: Array<{ name: string; url: string }>;
}

const NAME_RE = /^[A-Za-z0-9][\w .'-]{0,59}$/;

/** Make a title a valid persona name: parseConfig's NAME_RE, at most 60. */
function personaName(title: string): string {
  const cleaned = title
    .replace(/[^\w .'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 60)
    .trim();
  return NAME_RE.test(cleaned) ? cleaned : "Agent";
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A frontmatter emoji, if one is set — never a URL or anything else. */
function frontmatterEmoji(fm: Record<string, unknown>): { key: string; glyph: string } | null {
  for (const key of ["avatar", "emoji", "icon"]) {
    const v = fm[key];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || /[<>"'`\\/:\s]/.test(s)) continue;
    const graphemes = [...GRAPHEMES.segment(s)].length;
    if (graphemes > 4) continue;
    return { key, glyph: s };
  }
  return null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Folders the instructions name. A path counts when written as a path
 * ("nodes/gtm/", "gtm/deals/", "`ops`"); a bare word only next to "folder"
 * ("the GTM folder", "folder ops") — a folder called "notes" must not be
 * picked up from "take notes". Only folders that exist are returned.
 */
function mentionedFolders(text: string, folders: string[]): Array<{ folder: string; as: string }> {
  const hits: Array<{ folder: string; as: string }> = [];
  const lower = text.toLowerCase();
  for (const folder of folders) {
    // Cheap prefilter: most folders aren't named at all.
    if (!lower.includes(folder.toLowerCase())) continue;
    const f = escape(folder);
    // The path ends at whitespace, clause punctuation or the end of the text:
    // "gtm/" or "gtm." count, "gtm/deals" (the subfolder), "gtm.md" and
    // "c++" (when the folder is "c") don't.
    const stop = "(?=[\\s,;:!?)\\]'\"`]|\\.(?!\\w)|$)";
    const forms = [
      new RegExp(`(?<![\\w/.-])nodes/${f}/?${stop}`, "i"),
      new RegExp(`(?<![\\w/.-])${f}/${stop}`, "i"),
      new RegExp("`(?:nodes/)?" + f + "/?`", "i"),
      new RegExp(`(?<![\\w/.-])${f}\\s+folder\\b|\\bfolders?\\s+(?:called\\s+|named\\s+)?["']?${f}${stop}`, "i"),
    ];
    for (const re of forms) {
      const m = text.match(re);
      if (m) {
        hits.push({ folder, as: m[0].trim() });
        break;
      }
    }
  }
  // A subfolder adds nothing when its parent is already read.
  return hits.filter((h) => !hits.some((o) => o !== h && h.folder.startsWith(`${o.folder}/`)));
}

// "Do not edit", "only flag", "comments only" — the instructions ask for
// review, not changes. Checked first: "only flag problems, do not edit" also
// contains "edit". A negation counts only when it covers the whole agent
// ("do not edit", "never change anything"): "do not update the footer" is
// one exception inside an agent that may otherwise fix things.
const READ_ONLY = [
  /\b(?:do not|don't|never|must not|should not|shouldn't|mustn't)\s+(?:directly\s+)?(?:edit|change|modify|update|rewrite|fix|propose|touch)\w*(?:\s+(?:anything|any\s+\w+|documents?|docs?|files?|content|the nest|it|them|nodes?))?\s*(?=[.,;!\n]|$)/i,
  /\bonly\s+(?:flag|comment|review|report|point out|note|summari[sz]e)\w*/i,
  /\b(?:comments?|read)[ -]only\b/i,
  /\b(?:propose|fix|edit|change|update)\s+nothing\b/i,
  /\bno\s+(?:edits|changes)\b/i,
];

// An edit verb used as an instruction: at the start of a sentence or clause,
// or after "and", "but", "to", "please", "then", "also", "or". So "update stale
// pricing" and "and fix typos" count; "a weekly status update" (a noun) does
// not. One aimed at a person or the agent's own output ("correct me",
// "update the user", "propose ideas", "improve your reply") doesn't either:
// that isn't an edit to the nest.
const EDIT_VERB =
  /(?:^|[.!?;:\n]\s*|[-*•]\s+|\b(?:and|but|to|please|then|also|or)\s+)((?:edit|fix|update|correct|rewrite|revise|amend|propose)\w*)\b([^.!?;\n]*)/gi;
const KEEP_CURRENT =
  /(?:^|[.!?;:\n]\s*|[-*•]\s+|\b(?:and|to|please|then|also)\s+)(keep\s+(?:[\w/'-]+\s+){0,4}(?:current|up[ -]to[ -]date|accurate))/i;
const NOT_THE_NEST =
  /\b(?:me|us|you|your|yourself|user|users|people|ideas|reply|response|answer|message|slack|email|team|memory|chat)\b/i;

function editInstruction(text: string): string | null {
  for (const m of text.matchAll(EDIT_VERB)) {
    const object = m[2].trim().split(/\s+/).slice(0, 6).join(" ");
    if (NOT_THE_NEST.test(object)) continue;
    return `${m[1]}${object ? ` ${object}` : ""}`.trim();
  }
  return text.match(KEEP_CURRENT)?.[1] ?? null;
}

function proposeMode(text: string): { propose: string[]; why: string } {
  for (const re of READ_ONLY) {
    const m = text.match(re);
    if (m) return { propose: [], why: `The instructions say "${m[0]}", so it only leaves comments.` };
  }
  const edit = editInstruction(text);
  if (edit) {
    return {
      propose: ["*"],
      why: `The instructions say "${edit}", so it may suggest edits wherever it reads. A reviewer still approves each one.`,
    };
  }
  return {
    propose: [],
    why: "The instructions don't ask it to change anything, so it only leaves comments.",
  };
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const FEED_RE = /\.(?:xml|rss|atom)(?:[?#]|$)|\/(?:feed|rss|atom)(?:\/|\.|[?#]|$)|[?&](?:format|type)=(?:rss|atom)\b/i;
const MCP_RE = /\/mcp\/?(?:[?#]|$)/i;

/** A short unique key from the host ("feeds.example.com" → "feeds"). */
function keyFor(url: string, taken: Set<string>, fallback: string): string {
  let base = fallback;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const label = host.split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    if (/^[a-z0-9]/.test(label)) base = label;
  } catch {
    // keep the fallback
  }
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  taken.add(key);
  return key;
}

/** Bounds on what is scanned: instructions are user-authored and unbounded,
 *  and each folder named in them costs a few regex passes. */
const MAX_TEXT = 100_000;
const MAX_FOLDERS = 2_000;

export function suggestConfig(input: SuggestInput): Suggestion {
  const text = (input.instructions ?? "").slice(0, MAX_TEXT);
  const why: Record<string, string> = {};

  const name = personaName(input.title);
  why["persona.name"] = `The agent document is titled "${input.title}".`;
  const emoji = frontmatterEmoji(input.frontmatter);
  if (emoji) why["persona.avatar"] = `The document's ${emoji.key} is ${emoji.glyph}.`;

  const hits = mentionedFolders(text, input.folders.slice(0, MAX_FOLDERS));
  const read = hits.map((h) => h.folder);
  why["scope.read"] = hits.length
    ? `The instructions mention ${hits.map((h) => `"${h.as}"`).join(", ")}.`
    : input.instructions === null
      ? "The document has no approved instructions yet, so nothing narrows it: the whole nest."
      : "The instructions don't name a folder in this nest, so the whole nest.";

  const p = proposeMode(text);
  why["scope.propose"] = input.instructions === null ? "No approved instructions yet, so it only leaves comments." : p.why;

  const feeds: Array<{ name: string; url: string }> = [];
  const mcp: Array<{ name: string; url: string }> = [];
  const taken = new Set<string>();
  const seen = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    // The same fence parseConfig applies: public https only.
    if (!urlAllowed(url)) continue;
    if (MCP_RE.test(url)) {
      if (mcp.length < 10) mcp.push({ name: keyFor(url, taken, "mcp"), url });
    } else if (FEED_RE.test(url)) {
      if (feeds.length < 20) feeds.push({ name: keyFor(url, taken, "feed"), url });
    }
  }
  if (feeds.length) why.feeds = `The instructions link ${feeds.length === 1 ? "a feed" : `${feeds.length} feeds`}.`;
  if (mcp.length) {
    why.mcp_servers = `The instructions link ${mcp.length === 1 ? "an MCP server" : `${mcp.length} MCP servers`}. Name the tools it may call before saving.`;
  }

  return {
    config: {
      persona: { name, avatar: emoji?.glyph ?? null },
      scope: { read, propose: input.instructions === null ? [] : p.propose },
      caps: {
        max_steps: CAPS.max_steps.default,
        max_tokens: CAPS.max_tokens.default,
        max_seconds: CAPS.max_seconds.default,
        max_proposals: CAPS.max_proposals.default,
        max_comments: CAPS.max_comments.default,
      },
      feeds,
      mcp_servers: [],
      model: null,
      // Who to notify is the owner's pick, never the document's.
      notify: { recipients: [], channels: [], max_per_run: CAPS.max_notifications.default },
    },
    why,
    mcp_candidates: mcp,
  };
}
