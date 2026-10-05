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
import { extractMentions, stripMentions } from "../shared/mentions.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { tryConsume } from "../shared/rate-limit.js";
import { getNest } from "../nests/service.js";
import { trackEvent } from "../telemetry/tracker.js";
import {
  streamAnswer,
  describeModelError,
  type ModelTurn,
  ModelRefusedError,
} from "./model.js";
import { effectiveHootieBrand } from "./brand.js";

export const hootieRoutes = new Hono<AuthEnv>();

/** Longest message and history we'll send; a chat panel, not a bulk API. */
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 8000;
/** Raw history entries examined at all — merging can only shrink a run of
 *  turns, so nothing older than this could reach the model anyway. */
const MAX_HISTORY_RAW = MAX_HISTORY_TURNS * 4;
/** Retrieval budget per source (anchor document, question) — tokens. */
const CONTEXT_BUDGET = 6000;
/**
 * Chats one person may start per window, across ALL nests — the budget
 * guards one server-wide key, so it is keyed per user, not per nest. Each
 * chat is a paid external call, so a looping client must hit a ceiling — but
 * the ceiling has to be invisible to someone actually working through a
 * topic.
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
  // The id is interpolated into a selector ([[nodes/…]]) below, so it must
  // BE an id before it goes anywhere near the grammar: slash-joined slug
  // segments under nodes/. Anything else — traversal, a `]]` or `|` aimed at
  // the selector parser — is simply not a document: the same 404 as a
  // missing one, and nothing reaches the engine.
  if (nodeId !== null && !isNodeIdShaped(nodeId)) {
    return c.json({ error: "Node not found" }, 404);
  }
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
    // A client that hangs up mid-answer (panel closed, nest switched, a new
    // question fired) must stop the model too — every chat is a paid call,
    // and nobody is listening. Both hang-up signals feed one controller: the
    // SSE stream's own abort and the request's.
    const cancel = new AbortController();
    const hangUp = () => cancel.abort();
    stream.onAbort(hangUp);
    c.req.raw.signal.addEventListener("abort", hangUp, { once: true });

    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({ nodes, anchor }),
    });
    let answer = "";
    try {
      for await (const chunk of streamAnswer({
        apiKey,
        model: config.HOOTIE_MODEL,
        baseUrl: config.ANTHROPIC_BASE_URL || null,
        system,
        turns,
        signal: cancel.signal,
      })) {
        if (cancel.signal.aborted) return;
        answer += chunk;
        await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: chunk }) });
      }
    } catch (err) {
      // Our own cancellation surfaces as an abort error from the SDK: nothing
      // to report, and nobody to report it to.
      if (cancel.signal.aborted) return;
      const text =
        err instanceof ModelRefusedError ? err.message : describeModelError(err);
      console.error("[hootie] model call failed", nestId, err);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: text }) });
      return;
    }

    if (cancel.signal.aborted) return;
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
 * A well-formed node id: `nodes/` then one or more slug segments. Every id
 * this server mints is of this shape (see nodes/service.ts); the check is a
 * whitelist, not a blacklist of known-bad characters.
 */
const NODE_ID_SHAPE = /^nodes(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
function isNodeIdShaped(id: string): boolean {
  return id.length <= 512 && NODE_ID_SHAPE.test(id);
}

/**
 * Validate the client's conversation so far. Null means malformed; an empty
 * list is fine. Bounded in turns AND characters so a hostile client can't pad
 * a request with a novel — and trimmed from the front, so the most recent
 * turns are what survive.
 */
function normalizeHistory(raw: unknown): ModelTurn[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  // Only the tail can survive the caps below, so only the tail is looked at:
  // the work done on a request is bounded by what it can use, not by what
  // the client chose to send (the global body cap bounds the rest).
  const tail = raw.length > MAX_HISTORY_RAW ? raw.slice(-MAX_HISTORY_RAW) : raw;
  const turns: ModelTurn[] = [];
  for (const t of tail) {
    if (!t || typeof t !== "object") return null;
    const role = (t as any).role;
    const content = (t as any).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string")
      return null;
    const text = content.trim();
    if (!text) continue;
    turns.push({ role, content: text });
  }
  // The Messages API wants strict user/assistant alternation. A client can
  // send anything (this is a public route, not only the panel): adjacent
  // same-role turns are MERGED rather than dropped — nothing the person
  // said disappears — and the sequence must start with the user and end
  // with the assistant, since the new question is appended as the user.
  const merged: ModelTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += "\n\n" + t.content;
    else merged.push({ ...t });
  }
  let kept = merged.slice(-MAX_HISTORY_TURNS);
  let chars = kept.reduce((n, t) => n + t.content.length, 0);
  while (kept.length > 0 && chars > MAX_HISTORY_CHARS) {
    chars -= kept[0].content.length;
    kept = kept.slice(1);
  }
  while (kept.length > 0 && kept[0].role !== "user") kept = kept.slice(1);
  while (kept.length > 0 && kept[kept.length - 1].role !== "assistant")
    kept = kept.slice(0, -1);
  return kept;
}

function buildSystemPrompt(params: {
  nestName: string;
  userEmail: string;
  anchor: ContextNodeSummary | null;
  blocks: string[];
}): string {
  const { nestName, userEmail, anchor, blocks } = params;
  // A document that contains `</documents>` would close the block early and
  // everything after it would read as instructions — defuse the tag in the body.
  const context =
    blocks.length > 0
      ? blocks.join("\n\n---\n\n").replace(/<\/documents>/gi, "</ documents>")
      : "(nothing in the nest matched this question)";
  return [
    // The admin's assistant name on an enterprise licence (one line, ≤40
    // chars, validated in brand.ts), Hootie otherwise.
    `You are ${effectiveHootieBrand().name}, the assistant inside the ContextNest nest "${nestName}". You are talking with ${userEmail}.`,
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
 * chip.
 *
 * Titles aren't unique. When two retrieved nodes share the cited title, the
 * citation resolves to ONE of them — the first in `nodes` order, which is the
 * open document if it is one, else the higher-ranked match — never both: a
 * doubled citation would put two chips on one reference, and the mention
 * anchor below would land on a coin flip. The pick is deterministic and the
 * best-ranked candidate; the chip carries the id, so it is never a mystery
 * which one it was.
 */
function citedNodes(
  answer: string,
  nodes: ContextNodeSummary[],
): ContextNodeSummary[] {
  const lower = answer.toLowerCase();
  const seenTitles = new Set<string>();
  const hits: Array<{ n: ContextNodeSummary; at: number }> = [];
  for (const n of nodes) {
    const key = n.title.toLowerCase();
    if (seenTitles.has(key)) continue;
    const at = lower.indexOf(`[[${key}]]`);
    if (at < 0) continue;
    seenTitles.add(key);
    hits.push({ n, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((x) => x.n);
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
  const name = effectiveHootieBrand().name;
  const body = [
    `**Asked ${name}:** ${message}`,
    "",
    `**${name} answered:**`,
    answer.trim(),
  ].join("\n");
  // Only the comment itself decides "posted": once createThread returns, a
  // comment exists on the document, and that is what the outcome reports.
  // The fan-out and the annotations projection are best-effort by their own
  // contracts (each swallows its failures), and they sit OUTSIDE this try so
  // a future edit that lets one of them throw can't relabel a comment that
  // is already on the page as "post_failed".
  let threadId: string;
  try {
    const thread = await createThread(
      nestId,
      anchor.id,
      { body, anchor: null, snapshotVersion: null },
      userEmail,
    );
    threadId = thread.id;
  } catch (err) {
    console.error("[hootie] mention comment failed", nestId, anchor.id, err);
    return { status: "undeliverable", reason: "post_failed" };
  }
  // Recipients come from the ASKER's text, never the comment body: the body
  // carries the model's answer, and a name the model wrote — echoed out of a
  // retrieved document, or planted in one — would otherwise page a colleague
  // in the asker's name. The comment still says the whole exchange.
  const notified = await notifyCommentMentions({
    nestId,
    nodeId: anchor.id,
    body: message,
    actorEmail: userEmail,
    baseUrl,
  });
  await syncAnnotationsNode(nestId, anchor.id, userEmail);
  return {
    status: "posted",
    node_id: anchor.id,
    node_title: anchor.title,
    thread_id: threadId,
    notified,
  };
}
