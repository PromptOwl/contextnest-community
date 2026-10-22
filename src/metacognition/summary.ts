/**
 * A metacognition agent's config in plain words — what an MCP harness shows the
 * person before it saves one (metacognition_configure dry_run), and the line
 * metacognition_list gives each agent.
 *
 * Pure: the parsed config in, one paragraph out. The wording follows the scope
 * semantics in config.ts exactly — read empty = the whole nest, propose [] =
 * no edits (comments only), ["*"] = anywhere it reads — and always ends on the
 * one guarantee that holds whatever the config: it never publishes.
 */
import type { MetacognitionConfig } from "./config.js";

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function duration(seconds: number): string {
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

export function summarizeConfig(cfg: MetacognitionConfig, opts: { enabled?: boolean } = {}): string {
  const { persona, scope, caps } = cfg;
  const reads = scope.read.length ? list(scope.read) : "the whole nest";
  const proposes = scope.propose.length > 0 && caps.max_proposals > 0;
  const where =
    scope.propose[0] === "*"
      ? scope.read.length
        ? "anywhere it reads"
        : "anywhere in the nest"
      : `in ${list(scope.propose)}`;
  const comments = caps.max_comments > 0 ? `up to ${plural(caps.max_comments, "comment")} per run` : null;

  let first = `${persona.name} will read ${reads}, `;
  if (proposes) {
    first += `may suggest edits ${where}, up to ${caps.max_proposals} per run, `;
    first += comments ? `and may leave ${comments}.` : "and won't comment.";
  } else {
    first += comments ? `won't suggest edits and may only comment, ${comments}.` : "won't suggest edits and won't comment.";
  }

  const parts = [first];
  parts.push(
    `Each run stops after ${plural(caps.max_steps, "step")}, ${plural(caps.max_tokens, "token")} or ${duration(caps.max_seconds)}, whichever comes first.`,
  );
  if (cfg.feeds.length) {
    parts.push(`It also reads the ${cfg.feeds.length === 1 ? "feed" : "feeds"} ${list(cfg.feeds.map((f) => f.name))}.`);
  }
  for (const m of cfg.mcp_servers) {
    parts.push(`It may call ${list(m.allowed_tools)} on the MCP server ${m.name}.`);
  }
  if (opts.enabled === false) parts.push("It is switched off, so it won't run until it is switched back on.");
  parts.push("It never publishes; every change goes to a reviewer.");
  return parts.join(" ");
}
