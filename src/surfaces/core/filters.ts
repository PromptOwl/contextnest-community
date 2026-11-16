/**
 * Deterministic filters behind the proposal bar (PRD §4.6): the sensitive
 * lexicon, the people-folder field allowlist, the verbatim-copy cap, the 8-word
 * out-of-target leak filter (prompt-injection defence) and the date check.
 * Pure; every check is on words, never on the model's say-so.
 */

const SENSITIVE: Array<[string, RegExp]> = [
  ["compensation", /\b(salar(y|ies)|compensation|comp (change|band|review)|pay (rise|raise|cut|band|grade)|bonus(es)?|equity grant|stock options?|raise to \$?\d|\$\d[\d,.]*k?\s*(a|per)\s*year|\d{2,3}k\b)/i],
  ["health", /\b(health (issue|condition|problem|scare)s?|medical|diagnos(is|ed|es)|pregnan(t|cy)|illness|sick leave|therapy|therapist|surgery|disabilit(y|ies)|mental health|chemo|prescription)\b/i],
  ["performance_hr", /\b(performance review|performance improvement plan|PIP|disciplinary|termination of employment|(was|were|is|being|get|got|getting) (fired|let go|terminated)|written warning|underperform(ing|ance|er)?|layoffs?|severance)\b/i],
  ["immigration", /\b(visa status|immigration|green card|work permit|h-?1b|deport)/i],
  ["gossip", /\b(between (you and|us)|don'?t tell (anyone|him|her)|keep (it|this) quiet|off the record|rumou?r|gossip|dating|affair|divorce)\b/i],
  ["credential", /\b(password|passwd|pwd|secret|api[_ -]?key|token)\s*[:=]\s*\S+/i],
  ["credential", /\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|cnst_[A-Za-z0-9]{10,})/],
  ["credential", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** The lexicon category a text hits, or null. */
export function sensitiveHit(text: string): string | null {
  for (const [cat, re] of SENSITIVE) if (re.test(text)) return cat;
  return null;
}

const PEOPLE_FIELDS = new Set(["role", "owns", "contact", "team"]);
const PERSONAL = /\b(lazy|unreliable|slow|incompetent|brilliant|difficult|toxic|rude|annoying|great|terrible|bad at|good at|attitude|personality|family|kids?|children|wife|husband|partner|girlfriend|boyfriend|wedding|divorce|religio(n|us)|politic(s|al)|age|birthday|home address|vacation|holiday|hobby|hobbies)\b/i;

/**
 * A people-folder draft holds role, ownership and contact only: every non-empty
 * line is `role|owns|contact|team: …` (bullets allowed), with nothing about
 * performance or personal life.
 */
export function peopleBodyOk(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  for (const raw of lines) {
    const line = raw.replace(/^[-*•]\s*/, "").replace(/^\*\*([^*]+)\*\*/, "$1");
    const m = /^([A-Za-z ]+):\s*(.+)$/.exec(line);
    if (!m || !PEOPLE_FIELDS.has(m[1].trim().toLowerCase())) return false;
    if (PERSONAL.test(m[2]) || sensitiveHit(m[2])) return false;
  }
  return true;
}

/** Lower-cased words, punctuation stripped (apostrophes kept inside words). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** The longest run of consecutive words `text` shares with any one source. */
export function longestVerbatimRun(text: string, sources: string[]): number {
  const a = words(text);
  let best = 0;
  for (const src of sources) {
    const b = words(src);
    if (!a.length || !b.length) continue;
    let prev = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Array<number>(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
  }
  return best;
}

export const SHINGLE = 8;

function shingles(ws: string[], n = SHINGLE): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

/**
 * How many 8-word shingles of the item occur in some other node of the nest
 * but not in the window — text the model can only have carried in from the
 * nest (e.g. on an injected instruction). Any > 0 blocks the item.
 */
export function leakedShingles(itemText: string, otherNodeTexts: string[], windowText: string): number {
  const mine = shingles(words(itemText));
  if (!mine.size) return 0;
  const win = shingles(words(windowText));
  const others = new Set<string>();
  for (const t of otherNodeTexts) for (const s of shingles(words(t))) others.add(s);
  let n = 0;
  for (const s of mine) if (others.has(s) && !win.has(s)) n++;
  return n;
}

const DATE_EXPR = new RegExp(
  [
    "\\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\\b",
    "\\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\\b",
    "\\b(today|tonight|tomorrow|yesterday|eod|eow|eom|eoq|end of (the )?(day|week|month|quarter|year)|next (week|month|quarter|year)|this (week|month|quarter)|in \\d+ (days?|weeks?|months?))\\b",
    "\\bq[1-4]\\b",
    "\\b\\d{4}-\\d{2}-\\d{2}\\b",
    "\\b\\d{1,2}[/.]\\d{1,2}([/.]\\d{2,4})?\\b",
  ].join("|"),
  "i",
);

export function hasDateExpression(text: string): boolean {
  return DATE_EXPR.test(text);
}

/** A very small stemmer: lower-case word → a shared stem for simple inflections. */
export function stem(w: string): string {
  let x = w.toLowerCase();
  if (x.length > 4 && x.endsWith("ies")) return `${x.slice(0, -3)}y`;
  if (x.length > 5 && x.endsWith("ing")) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith("ed")) x = x.slice(0, -2);
  else if (x.length > 4 && /(?:ses|xes|zes|ches|shes)$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith("s") && !x.endsWith("ss")) x = x.slice(0, -1);
  return x;
}

/**
 * A seed's `never_propose` categories and their synonyms (AC-SEED-08, S7-R2
 * L5) as a deterministic, lexical backstop: each term matches as whole words
 * ("personal-life" → "personal life"), case-insensitive, after simple
 * stemming on both sides ("credentials" ~ "credential", "salaries" ~
 * "salary"). The prompt instruction and human review remain the main guard.
 */
export function categoryHit(text: string, categories: readonly string[]): boolean {
  if (!categories.length) return false;
  const hay = ` ${words(text).map(stem).join(" ")} `;
  return categories.some((c) => {
    const w = words(c.replace(/[-_]+/g, " ")).map(stem).join(" ");
    return !!w && hay.includes(` ${w} `);
  });
}
