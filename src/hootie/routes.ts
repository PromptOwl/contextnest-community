/**
 * Hootie in the nest — POST /nests/:nestId/chat.
 *
 * The assistant that lives inside the nest UI. It is /context plus a model
 * call: retrieval runs through `resolveContext` AS THE CALLER, so the answer
 * can only draw on what this person may read — the per-user gate hosted
 * Hootie can't apply (it retrieves with one shared key). The route streams
 * the answer as server-sent events so the panel renders it as it lands.
 *
 * Two retrievals feed one prompt: the open document (with its neighbours)
 * when the panel is on one, and whatever the question itself matches. Both
 * are the ordinary /context path — nothing here decides what's readable.
 *
 * "@name" in a message is how you pull a colleague in. The exchange is posted
 * as a comment on the anchor document (the open one, else the first the
 * answer cites) under the asker's name, and the comment-mention path notifies
 * them — inbox row, email, channel — exactly as a hand-written comment would.
 * Nothing is posted when nobody is named.
 *
 * Read-tier (see isReadQuery in app.ts): if you can read the nest you can
 * ask about it. The feature gate is HOOTIE_ENABLED; the credential is the
 * server-wide ANTHROPIC_API_KEY. Off → 404 (the route doesn't exist);
 * no key → 503 with a reason the UI can explain.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import {
  resolveContext,
  type ContextNodeSummary,
} from "../nodes/context-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { createThread, syncAnnotationsNode } from "../annotations/service.js";
import { notifyCommentMentions } from "../governance/mention-notify.js";
import { extractMentions } from "../shared/mentions.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { tryConsume } from "../shared/rate-limit.js";
import { getNest } from "../nests/service.js";
import { trackEvent } from "../telemetry/tracker.js";
import { streamAnswer, type ModelTurn, ModelRefusedError } from "./model.js";

export const hootieRoutes = new Hono<AuthEnv>();

/** Longest message and history we'll send; a chat panel, not a bulk API. */
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 8000;
/** Retrieval budget per source (anchor document, question) — tokens. */
const CONTEXT_BUDGET = 6000;
/**
 * Chats one person may start per window. Each one is a paid external call
 * on the server's key, so a looping client must hit a ceiling — but the
 * ceiling has to be invisible to someone actually working through a topic.
 */
export const CHAT_BUDGET = { max: 30, windowMs: 5 * 60_000 };

interface ChatBody {
  message?: unknown;
  node_id?: unknown;
  history?: unknown;
}

/** Result of delivering the message's @mentions, reported in the done event. */
type MentionOutcome =
  | {
      status: "posted";
      node_id: string;
      node_title: string;
      thread_id: string;
      notified: number;
    }
  | { status: "undeliverable"; reason: "no_anchor" | "post_failed" };

hootieRoutes.post("/chat", async (c) => {
  if (!config.HOOTIE_ENABLED) return c.json({ error: "Not found" }, 404);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        error:
          "Hootie needs an Anthropic API key. A server admin can add one under Settings → General.",
        reason: "no_api_key",
      },
      503,
    );
  }

  let body: ChatBody;
  try {
    body = await c.req.json<ChatBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return c.json(
      { error: `message is too long (max ${MAX_MESSAGE_CHARS} characters)` },
      400,
    );
  }
  const nodeId =
    typeof body.node_id === "string" && body.node_id.trim()
      ? body.node_id.trim()
      : null;
  const history = normalizeHistory(body.history);
  if (history === null) {
    return c.json(
      { error: "history must be a list of {role: user|assistant, content}" },
      400,
    );
  }

  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  if (!tryConsume(`hootie:${userId}`, CHAT_BUDGET)) {
    return c.json(
      { error: "Too many questions in a short time — give it a few minutes." },
      429,
    );
  }
  const userEmail = await resolveCallerEmail(userId);
  const baseUrl = requestBaseUrl(c.req.url);

  // ── Retrieval, as the caller ──
  // The open document first (so it always leads the context), then whatever
  // the question matches. De-duped by id; the anchor's own block is never
  // repeated by the question path.
  const nodes: ContextNodeSummary[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  const take = (r: Awaited<ReturnType<typeof resolveContext>>) => {
    for (let i = 0; i < r.nodes.length; i++) {
      const n = r.nodes[i];
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      nodes.push(n);
      blocks.push(r.blocks[i].markdown);
    }
  };

  let anchor: ContextNodeSummary | null = null;
  if (nodeId) {
    // Anchored by ID — `[[nodes/…]]` is the id-style wiki target — never by
    // title: titles aren't unique, and a same-titled sibling must not lead
    // the context for a document the person doesn't have open.
    // hops: 1 — the document plus what it links to and what links to it.
    // include_drafts: the person has this document OPEN — very often the
    // draft they are writing — and "is this right?" has to be about the text
    // in front of them, not the last approved version. filterAccessible and
    // resolveReadableBody still decide what this caller may see of it (a
    // public reader gets the approved body, or nothing).
    const r = await resolveContext({
      nestId,
      userId,
      baseUrl,
      body: {
        selector: `[[${nodeId}]]`,
        hops: 1,
        max_tokens: CONTEXT_BUDGET,
        include_drafts: true,
      },
    });
    anchor = r.nodes.find((n) => n.id === nodeId) ?? null;
    // Not in the gated result = not a document this caller can ask about.
    // One answer for "doesn't exist" and "exists, but not for you": the
    // node_id is caller-supplied, and the gate must not double as an
    // existence oracle. Checked before anything is retrieved for the model.
    if (!anchor) return c.json({ error: "Node not found" }, 404);
    take(r);
  }
  // The question itself. @names are colleagues, not search terms — strip
  // them so a mention doesn't drag in every document that quotes an email.
  const question = stripMentions(message);
  if (question) {
    const r = await resolveContext({
      nestId,
      userId,
      baseUrl,
      body: { prompt: question, max_tokens: CONTEXT_BUDGET },
    });
    take(r);
  }

  const nest = await getNest(nestId);
  const system = buildSystemPrompt({
    nestName: nest?.name ?? "this nest",
    userEmail,
    anchor,
    blocks,
  });
  const turns: ModelTurn[] = [...history, { role: "user", content: message }];
  const mentionNames = extractMentions(message);

  trackEvent("hootie.chat", {
    nestId,
    anchored: !!anchor,
    context_nodes: nodes.length,
    history_turns: history.length,
    mentions: mentionNames.length,
  });

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({ nodes, anchor }),
    });
    let answer = "";
    try {
      for await (const chunk of streamAnswer({
        apiKey,
        model: config.HOOTIE_MODEL,
        system,
        turns,
      })) {
        answer += chunk;
        await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: chunk }) });
      }
    } catch (err) {
      const text =
        err instanceof ModelRefusedError
          ? err.message
          : "Hootie couldn't reach the model. Try again in a moment.";
      console.error("[hootie] model call failed", nestId, err);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: text }) });
      return;
    }

    const cited = citedNodes(answer, nodes);

    let mention: MentionOutcome | null = null;
    if (mentionNames.length > 0) {
      mention = await deliverMentions({
        nestId,
        userEmail,
        baseUrl,
        message,
        answer,
        anchor: anchor ?? cited[0] ?? null,
      });
    }

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({ answer, cited, mention }),
    });
  });
});

/**
 * Validate the client's conversation so far. Null means malformed; an empty
 * list is fine. Bounded in turns AND characters so a hostile client can't pad
 * a request with a novel — and trimmed from the front, so the most recent
 * turns are what survive.
 */
function normalizeHistory(raw: unknown): ModelTurn[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const turns: ModelTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const role = (t as any).role;
    const content = (t as any).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string")
      return null;
    const text = content.trim();
    if (!text) continue;
    turns.push({ role, content: text });
  }
  let kept = turns.slice(-MAX_HISTORY_TURNS);
  let chars = kept.reduce((n, t) => n + t.content.length, 0);
  while (kept.length > 0 && chars > MAX_HISTORY_CHARS) {
    chars -= kept[0].content.length;
    kept = kept.slice(1);
  }
  // The API wants the first turn to be the user's.
  while (kept.length > 0 && kept[0].role !== "user") kept = kept.slice(1);
  return kept;
}

/**
 * The message without its @name tokens, for retrieval. Both mention forms
 * from shared/mentions.ts: `@alice@acme.com` and `@(Alice Smith)`.
 */
function stripMentions(message: string): string {
  return message
    .replace(/(^|\s)@(?:\([^)]*\)|[a-zA-Z0-9._@-]+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSystemPrompt(params: {
  nestName: string;
  userEmail: string;
  anchor: ContextNodeSummary | null;
  blocks: string[];
}): string {
  const { nestName, userEmail, anchor, blocks } = params;
  const context =
    blocks.length > 0
      ? blocks.join("\n\n---\n\n")
      : "(nothing in the nest matched this question)";
  return [
    `You are Hootie, the assistant inside the ContextNest nest "${nestName}". You are talking with ${userEmail}.`,
    "",
    "Answer from the documents below and nothing else. They are the governed context this person is allowed to read; do not invent facts that are not in them.",
    "When you use a document, cite it by its exact title as a wiki link, like [[Title]] — this is how the reader opens it. Cite every document you drew on, and only those.",
    "If the documents do not answer the question, say so plainly and, if you can, point to which document comes closest or what to search for. Do not guess.",
    "Be concise and direct. Use short paragraphs or a short list; no preamble.",
    "Names written as @someone in the message are colleagues the person is looping in — they are not questions for you, and you should not address them.",
    anchor
      ? `The person currently has the document [[${anchor.title}]] open; "this" in their message means that document unless they say otherwise.`
      : "The person is looking at the nest as a whole, not a particular document.",
    "",
    "<documents>",
    context,
    "</documents>",
  ].join("\n");
}

/**
 * Which of the retrieved nodes the answer cites, in order of first mention.
 * A citation is the node's exact title as a [[wiki link]] (case-insensitive),
 * which is what the system prompt asks for and what the panel turns into a
 * chip. Titles aren't unique, so two retrieved nodes sharing one are both
 * "cited" — both were in front of the model, and the chips carry ids, so the
 * reader can open either; the ambiguity is the nest's, not invented here.
 */
function citedNodes(
  answer: string,
  nodes: ContextNodeSummary[],
): ContextNodeSummary[] {
  const lower = answer.toLowerCase();
  return nodes
    .map((n) => ({ n, at: lower.indexOf(`[[${n.title.toLowerCase()}]]`) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.n);
}

/**
 * Post the exchange as a comment on the anchor document so the people named
 * hear about it. The comment is the asker's, in their name: Hootie is the
 * medium, not the author. Best-effort like every other fan-out — a failure
 * here never fails the answer, it is reported in the done event instead.
 */
async function deliverMentions(params: {
  nestId: string;
  userEmail: string;
  baseUrl: string;
  message: string;
  answer: string;
  anchor: ContextNodeSummary | null;
}): Promise<MentionOutcome> {
  const { nestId, userEmail, baseUrl, message, answer, anchor } = params;
  if (!anchor) return { status: "undeliverable", reason: "no_anchor" };
  const body = [
    `**Asked Hootie:** ${message}`,
    "",
    "**Hootie answered:**",
    answer.trim(),
  ].join("\n");
  try {
    const thread = await createThread(
      nestId,
      anchor.id,
      { body, anchor: null, snapshotVersion: null },
      userEmail,
    );
    const notified = await notifyCommentMentions({
      nestId,
      nodeId: anchor.id,
      body,
      actorEmail: userEmail,
      baseUrl,
    });
    await syncAnnotationsNode(nestId, anchor.id, userEmail);
    return {
      status: "posted",
      node_id: anchor.id,
      node_title: anchor.title,
      thread_id: thread.id,
      notified,
    };
  } catch (err) {
    console.error("[hootie] mention comment failed", nestId, anchor.id, err);
    return { status: "undeliverable", reason: "post_failed" };
  }
}
