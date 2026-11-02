/**
 * Hootie's tools — what the model may do mid-answer, beyond reading what it
 * was given. A small registry: each tool is declared once (name, description,
 * JSON-schema input, a status line for the panel) with a `run` that acts AS
 * THE CALLER. agent.ts offers them to the model, caps how many calls one
 * question may make, and reports each to the panel; nothing about the loop is
 * specific to one tool.
 *
 * Read-only for now: `search_nest`. A tool that writes must not run on the
 * model's say-so — it would need the person's approval in the loop first.
 */
import { resolveContext } from "../nodes/context-service.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { defuseFence, type Gathered } from "./retrieval.js";

export interface ToolOutput {
  /** What the model reads back. */
  content: string;
  isError?: boolean;
}

export interface HootieTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** The panel's line while it runs ("Searching the nest for …"). */
  status(input: unknown): string;
  /** Run as the caller. Invalid input is an error result, never a throw. */
  run(input: unknown, signal: AbortSignal): Promise<ToolOutput>;
}

/** Everything a tool may act with: the caller's identity, never more. */
export interface ToolContext {
  nestId: string;
  userId: string;
  baseUrl: string;
  /** Activity-log attribution: Hootie's reads are Hootie's. */
  client: ClientMetadata;
  /** The question's retrieval so far; search results join it, so the answer
   *  can cite them. */
  gathered: Gathered;
}

/** Tokens per search: two searches stay well under one anchor's budget. */
export const SEARCH_BUDGET = 4000;
const MAX_QUERY_CHARS = 300;

function queryOf(input: unknown): string | null {
  const q = (input as { query?: unknown } | null)?.query;
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim();
  return t && t.length <= MAX_QUERY_CHARS ? t : null;
}

export function searchNestTool(ctx: ToolContext): HootieTool {
  return {
    name: "search_nest",
    description:
      "Search this nest for documents. Use it when the documents you have don't answer the question: " +
      "try other words — synonyms, the likely title of the document, the names involved. " +
      "Returns the matching documents you haven't seen yet, which you may cite like the others.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or a short question, different from what already failed.",
        },
      },
      required: ["query"],
    },
    status: (input) => {
      const q = queryOf(input);
      return q ? `Searching the nest for “${q.length > 80 ? q.slice(0, 79) + "…" : q}”` : "Searching the nest";
    },
    run: async (input) => {
      const query = queryOf(input);
      if (!query) {
        return { content: `query must be a non-empty string of at most ${MAX_QUERY_CHARS} characters.`, isError: true };
      }
      // The same gated path as every other Hootie read — as the caller,
      // recorded as Hootie's read in the activity log.
      const r = await resolveContext({
        nestId: ctx.nestId,
        userId: ctx.userId,
        baseUrl: ctx.baseUrl,
        client: ctx.client,
        body: { prompt: query, max_tokens: SEARCH_BUDGET },
      });
      const { added, repeated } = ctx.gathered.take(r);
      const lines: string[] = [];
      if (added.length === 0) {
        lines.push(
          repeated.length
            ? `Nothing new for "${query}": it only matched documents you already have.`
            : `No documents in this nest match "${query}".`,
        );
      } else {
        lines.push(`${added.length} new document${added.length === 1 ? "" : "s"} for "${query}":`, "", "<documents>");
        lines.push(defuseFence(added.map((a) => a.block).join("\n\n---\n\n")));
        lines.push("</documents>");
      }
      if (added.length && repeated.length) {
        lines.push("", `Also matched, already above: ${repeated.map((n) => `[[${n.title}]]`).join(", ")}.`);
      }
      return { content: lines.join("\n") };
    },
  };
}
