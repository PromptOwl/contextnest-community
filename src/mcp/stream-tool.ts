/**
 * `context_stream` (po-1214): the document stream for agents, at parity with
 * GET /me/stream — the same reader (streamForCaller), so the same nests, the
 * same access filter and the same attribution. Prose for chat clients, the
 * REST page as `structuredContent`.
 */
import { config } from "../config.js";
import { streamForCaller } from "../governance/stream-read.js";
import type { StreamItem } from "../governance/stream-service.js";
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

const one = (v: unknown) => (typeof v === "string" && v.trim() ? [v.trim()] : []);

export async function streamToolResult(
  userId: string,
  userEmail: string,
  args: Record<string, any>,
  /** The nest this call is scoped to; undefined = every readable nest. */
  onlyNest?: string,
): Promise<ToolResult> {
  const since = sinceArg(args.since);
  if (since === null) {
    return { text: "since must be a date, e.g. 2026-11-01T09:00:00Z", data: { code: "INVALID_INPUT", message: "since must be a date" }, isError: true };
  }
  const source = args.source === "agent" || args.source === "human" ? args.source : undefined;
  if (args.source && !source) {
    return { text: 'source must be "agent" or "human"', data: { code: "INVALID_INPUT", message: "source must be agent or human" }, isError: true };
  }
  const page = await streamForCaller({
    userId,
    userEmail,
    onlyNest,
    filters: { author: one(args.author), tag: one(args.tag), type: one(args.type), since, source },
    limit: typeof args.limit === "number" ? args.limit : 25,
    offset: typeof args.offset === "number" ? args.offset : 0,
    facets: false,
  });
  if (page.items.length === 0) {
    return { text: since ? "Nothing new in the stream since then." : "The stream is empty.", data: page };
  }
  const lines = page.items.map((i) => {
    const who = i.authorName || i.author?.split("@")[0] || "Someone";
    const agent = i.client?.agent ? ` via ${i.client.agent}` : "";
    const head = `- **${who}${agent}** ${streamAction(i)} "${i.title}" in ${i.nestName} · ${i.at}`;
    const meta = [
      `id: ${i.nodeId} v${i.version}`,
      i.commentCount !== null ? `${i.commentCount} open comment${i.commentCount === 1 ? "" : "s"}` : null,
      i.review ? (i.review.canReview ? "in review — you may approve or reject" : "in review") : null,
    ].filter(Boolean);
    const note = i.changeNote ? `\n  Change: ${i.changeNote}` : "";
    const excerpt = i.summary ? `\n  > ${i.summary}` : "";
    return `${head}\n  ${meta.join(" · ")}${note}${excerpt}`;
  });
  const more = page.has_more ? `\n\n_${page.total} in all — pass offset ${page.offset + page.items.length} for more._` : "";
  return {
    text: `# Stream\n\n${lines.join("\n")}${more}\n\nReply with \`context_comment\`; review with \`context_approve\` / \`context_reject\`.`,
    data: page,
  };
}
