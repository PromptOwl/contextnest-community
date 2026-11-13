/**
 * `context_stream` (po-1214): the document stream for agents, at parity with
 * GET /me/stream — the same reader (streamForCaller), so the same nests, the
 * same access filter and the same attribution. Prose for chat clients, the
 * REST page as `structuredContent`.
 */
import { config } from "../config.js";
import { streamForCaller } from "../governance/stream-read.js";
import { STREAM_MAX_LIMIT, STREAM_MAX_OFFSET, type StreamItem } from "../governance/stream-service.js";
import type { ToolResult } from "./tools.js";

export const STREAM_TOOL = "context_stream";

/** Advertised and served only while the experimental switch is on. */
export function streamToolEnabled(): boolean {
  return config.EXPERIMENTAL_DOC_STREAM;
}

/** What a version was, in words — the same verbs the Stream page uses. */
export function streamAction(i: Pick<StreamItem, "kind" | "status">): string {
  if (i.status === "pending_review") return "submitted for review";
  switch (i.kind) {
    case "approved":
      return "got approval on";
    case "rejected":
      return "got changes requested on";
    case "updated":
      return "edited";
    default:
      return i.kind;
  }
}

function sinceArg(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw);
  const noZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const t = Date.parse(noZone ? `${s.replace(" ", "T")}Z` : s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/** A filter value as REST takes it: one value, a comma-separated list, or an
 *  array; OR within the filter. */
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);

const invalid = (message: string): ToolResult => ({ text: message, data: { code: "INVALID_INPUT", message }, isError: true });

/** A whole number inside [min, max], undefined when absent, null when bad. */
function intArg(raw: unknown, min: number, max: number): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function streamToolResult(
  userId: string,
  userEmail: string,
  args: Record<string, any>,
  /** The nest this call is scoped to; undefined = every readable nest. */
  onlyNest?: string,
): Promise<ToolResult> {
  const since = sinceArg(args.since);
  if (since === null) return invalid("since must be a date, e.g. 2026-11-01T09:00:00Z");
  const source = args.source === "agent" || args.source === "human" ? args.source : undefined;
  if (args.source && !source) return invalid('source must be "agent" or "human"');
  const limit = intArg(args.limit, 1, STREAM_MAX_LIMIT);
  if (limit === null) return invalid(`limit must be a whole number from 1 to ${STREAM_MAX_LIMIT}`);
  const offset = intArg(args.offset, 0, STREAM_MAX_OFFSET);
  if (offset === null) return invalid(`offset must be a whole number from 0 to ${STREAM_MAX_OFFSET}`);
  const page = await streamForCaller({
    userId,
    userEmail,
    onlyNest,
    filters: { author: list(args.author), tag: list(args.tag), type: list(args.type), since, source },
    limit: limit ?? 25,
    offset: offset ?? 0,
    facets: false,
  });
  if (page.items.length === 0) {
    return { text: since ? "Nothing new in the stream since then." : "The stream is empty.", data: page };
  }
  const lines = page.items.map((i) => {
    const who = i.authorName || i.author?.split("@")[0] || "Someone";
    const agent = i.client?.agent ? ` via ${i.client.agent}` : "";
    // Names, agent, title, nest and note are caller data: collapse their
    // whitespace, or a newline in one would forge a post line of its own.
    const head = `- **${who}${agent}** ${streamAction(i)} "${i.title}" in ${i.nestName} · ${i.at}`.replace(/\s+/g, " ");
    const meta = [
      `id: ${i.nodeId} v${i.version}`,
      i.commentCount !== null ? `${i.commentCount} open comment${i.commentCount === 1 ? "" : "s"}` : null,
      i.review ? (i.review.canReview ? "in review — you may approve or reject" : "in review") : null,
    ].filter(Boolean);
    const note = i.changeNote ? `\n  Change: ${i.changeNote.replace(/\s+/g, " ")}` : "";
    const excerpt = i.summary ? `\n  > ${i.summary}` : "";
    return `${head}\n  ${meta.join(" · ")}${note}${excerpt}`;
  });
  const more = page.has_more ? `\n\n_${page.total} in all — pass offset ${page.offset + page.items.length} for more._` : "";
  return {
    text: `# Stream\n\n${lines.join("\n")}${more}\n\nReply with \`context_comment\`; review with \`context_approve\` / \`context_reject\`.`,
    data: page,
  };
}
