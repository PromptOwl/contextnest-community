/**
 * Hootie as a member of the conversation (team chat C7, PO-1198).
 *
 * "@hootie what did we decide about pricing?" in a channel thread runs ONE
 * Hootie turn — the same retrieval and tool loop as the panel
 * (src/hootie/routes.ts), AS THE ASKER: `resolveContext` and every read tool
 * run under the asker's user id, so the answer can only draw on, and cite,
 * what that person may read. The thread's earlier messages are part of the
 * context, but only inside the turn's random data fence, marked as quoted,
 * untrusted text (buildSystemPrompt `conversation`): what people said, never
 * instructions.
 *
 * The answer is posted into the thread as a message AUTHORED `hootie` —
 * never as the asker — with a stored attribution the timeline reads back as
 * `actor: { human: <asker>, agent: "hootie", label: "Hootie, for <asker>" }`,
 * `model_answer: true` and `citations` (the ids the server verified), so a
 * client renders it with the untrusted-text renderer and shows chips only for
 * those ids. The body itself goes through `inertAnswer` (links removed,
 * markdown link syntax escaped, wiki links kept, cut at 4,000 characters), so
 * it is harmless in any renderer. It fans out to nobody: no notification, no
 * mention row, no wake-up, no further Hootie turn.
 *
 * A turn never writes. When the model wants to (propose_* tools,
 * proposal-tools.ts), the turn records a proposal and posts a card for a
 * writer to approve (proposals.ts).
 *
 * Bounded: the Hootie chat budget per asker (CHAT_BUDGET), the turn's own
 * search/read budget and wall-clock deadline (turn.ts), at most
 * MAX_PROPOSALS_PER_TURN proposals. Abortable: every turn has an
 * AbortController, tracked in `inFlight` (settleNestAsks awaits them;
 * abortNestAsks stops them). Never silent: a failure is posted as a short
 * agent message — "I couldn't answer: <reason>" — except when the asker lost
 * access mid-turn (nobody to answer) or the feature is off.
 *
 * Off means off: EXPERIMENTAL_AGENT_STREAM off → nothing here exists;
 * HOOTIE_ENABLED off, or no model credential → a mention posts nothing and
 * the ask routes answer 404 / 503 `no_api_key`, as the chat route does.
 *
 * A DM to Hootie (C2's conversations) is the same turn with the conversation
 * node in place of the channel node: `nodeId` is any node that holds comment
 * threads the asker may read.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { hasEntitlement } from "../auth/entitlements.js";
import { resolveModelCredential, hootieModel, resolveGatewayModel, ownModelRoute } from "../shared/model-credential.js";
import { resolveContext, type ContextNodeSummary, type ContextResult } from "../nodes/context-service.js";
import { standingBlockFor } from "../governance/always-include-service.js";
import { resolveNestPermission } from "../shared/access.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { addComment, createThread, syncAnnotationsNode } from "../annotations/service.js";
import { extractMentions, stripMentions } from "../shared/mentions.js";
import { tryConsume } from "../shared/rate-limit.js";
import { getNest } from "../nests/service.js";
import { AppError, NotFoundError, ValidationError } from "../shared/errors.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { trackEvent } from "../telemetry/tracker.js";
import { citedNodes } from "../hootie/citations.js";
import { Gathered } from "../hootie/retrieval.js";
import { runAgent, dataFenceTag, AccessLostError } from "../hootie/agent.js";
import { canStillAsk } from "../hootie/access.js";
import { hootieTools } from "../hootie/tools.js";
import { TurnContext, stoppedLine, turnDeadline } from "../hootie/turn.js";
import { buildSystemPrompt, CHAT_BUDGET } from "../hootie/routes.js";
import { inertAnswer, INERT_MAX_CHARS } from "../hootie/inert.js";
import { describeModelError, ModelRefusedError, ToolsRejectedError } from "../hootie/model.js";
import { effectiveHootieBrand } from "../hootie/brand.js";
import { isChannelNode } from "../channels/channel-node.js";
import { channelNameOf } from "../channels/channel-node.js";
import { channelPostRefusal, getReadableChannel, isNestMember } from "../channels/channel-service.js";
import { displayNames, namedActor } from "../channels/message-meta.js";
import { ConflictError, ForbiddenError } from "../shared/errors.js";
import { readableTime } from "../stream/promote.js";
import { justWritten } from "../mentions/mention-index.js";
import { HOOTIE_ALIASES, HOOTIE_HANDLE } from "./reserved.js";
import { proposalTools, PROPOSAL_PROMPT_LINES, type PendingProposal } from "./proposal-tools.js";
import { fileProposal, type ProposalView } from "./proposals.js";

/** How Hootie's reads and messages are attributed. */
const HOOTIE_CLIENT: ClientMetadata = { agent: HOOTIE_HANDLE };
/** Retrieval budget for the question (tokens), as the panel's. */
const CONTEXT_BUDGET = 6000;
/** Thread messages quoted to the model, newest MAX_THREAD_MESSAGES. */
export const MAX_THREAD_MESSAGES = 30;
/** Each quoted message is cut to this many characters … */
const MAX_THREAD_MESSAGE_CHARS = 1000;
/** … and the whole quoted thread to this many. */
const MAX_THREAD_CHARS = 8000;
/** The longest question a conversation turn takes (the panel's cap). */
const MAX_QUESTION_CHARS = 4000;
/** Proposal cards one turn may post. */
export const MAX_PROPOSALS_PER_TURN = 5;
/** Turns in flight at once, per nest and server-wide (security review r2
 *  F12): the per-person budget bounds one asker, this bounds a team. */
export const MAX_INFLIGHT_PER_NEST = 4;
export const MAX_INFLIGHT_TOTAL = 16;
const BUSY = "Hootie is busy with other questions right now — try again in a moment.";

/** No model credential: the chat route's 503, as a thrown error. */
export class NoModelKeyError extends AppError {
  readonly reason = "no_api_key";
  constructor() {
    super(
      503,
      hasEntitlement("byok")
        ? "Hootie needs a model key. A server admin can add one, or a model gateway, under Settings → Hootie."
        : "Hootie runs on PromptOwl models, which arrive with this server's next licence check. If it persists, ask your administrator.",
    );
    this.name = "NoModelKeyError";
  }
}

export interface AskCaller {
  nestId: string;
  userId: string;
  userEmail: string;
  baseUrl: string;
}

export interface AskInput {
  /** The channel (name, #name or node id) to answer in; or … */
  channel?: unknown;
  /** … the thread (post id) to answer in — the thread's node is the channel. */
  thread?: unknown;
  question: unknown;
  /** Post the answer (and any proposal cards) into the thread. Without a
   *  thread, a new post in the channel. */
  post?: boolean;
}

export interface AskResult {
  answer: string;
  cited: Array<{ id: string; title: string }>;
  proposals: ProposalView[];
  /** Where the answer landed, or null when `post` was false. */
  posted: { node_id: string; channel: string | null; thread_id: string; message_id: string; proposal_message_ids: string[] } | null;
  trail: { searches: number; reads: number; stopped: boolean };
}

// ─── Addressing ─────────────────────────────────────────────────────────

/** Does this message address Hootie? (`@hootie` or `@nest`, outside code.) */
export function mentionsHootie(body: string): boolean {
  return extractMentions(body || "").some((n) => HOOTIE_ALIASES.has(n.toLowerCase()));
}

/** The question without its `@hootie` / `@nest` (and other @names). */
function questionOf(body: string): string {
  return stripMentions(String(body ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Where ──────────────────────────────────────────────────────────────

interface Place {
  nodeId: string;
  channel: string | null;
  threadId: string | null;
}

/**
 * The conversation an ask names: a thread (its node must be a channel the
 * caller can read) or a channel. NotFound for anything the caller can't
 * read, a thread of another node or nest, and a non-member alike.
 */
async function resolvePlace(caller: AskCaller, input: AskInput): Promise<Place> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  const threadId = typeof input.thread === "string" && input.thread.trim() ? input.thread.trim() : null;
  if (threadId) {
    const row = (await getDb().get("SELECT id, node_id FROM annotation_threads WHERE id = ? AND nest_id = ?", [threadId, caller.nestId])) as
      | { id: string; node_id: string }
      | undefined;
    if (!row || !(await isChannelNode(caller.nestId, row.node_id))) throw new NotFoundError("Thread not found");
    const channelName = channelNameOf(row.node_id);
    if (input.channel !== undefined && input.channel !== null && input.channel !== "") {
      const { node } = await getReadableChannel(caller, input.channel);
      if (node.id !== row.node_id) throw new NotFoundError("Thread not found in this channel");
    } else {
      await getReadableChannel(caller, channelName);
    }
    return { nodeId: row.node_id, channel: channelName, threadId };
  }
  if (input.channel === undefined || input.channel === null || input.channel === "") {
    throw new ValidationError("Say where: pass `channel` (a channel's name) or `thread` (a post id).");
  }
  const { node, view } = await getReadableChannel(caller, input.channel);
  return { nodeId: node.id, channel: view.name, threadId: null };
}

// ─── The thread as context ──────────────────────────────────────────────

/**
 * The thread's messages (newest MAX_THREAD_MESSAGES, oldest first), rendered
 * for the model: "[time] <who>: <text>", each cut, the whole cut. The message
 * that asked is left out (it is the user turn). Model text already in the
 * thread is quoted like the rest — it is still just text.
 */
async function threadContext(nestId: string, threadId: string, excludeCommentId: string | null): Promise<string> {
  const rows = (await getDb().all(
    `SELECT c.id, c.author, c.body, c.created_at, c.client_json
       FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.thread_id = ? AND t.nest_id = ?
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${MAX_THREAD_MESSAGES + 1}`,
    [threadId, nestId],
  )) as Array<{ id: string; author: string; body: string; created_at: string; client_json: string | null }>;
  const kept = rows.filter((r) => r.id !== excludeCommentId).slice(0, MAX_THREAD_MESSAGES).reverse();
  if (kept.length === 0) return "";
  const names = await displayNames([...kept.map((r) => r.author), ...kept.map((r) => String((deserializeClient(r.client_json) as any)?.for ?? "")).filter(Boolean)]);
  const lines: string[] = [];
  let total = 0;
  for (const r of kept) {
    const { actor } = await namedActor(r.author, deserializeClient(r.client_json), names);
    const flat = String(r.body ?? "").replace(/\s+/g, " ").trim();
    const text = flat.length > MAX_THREAD_MESSAGE_CHARS ? `${flat.slice(0, MAX_THREAD_MESSAGE_CHARS)}…` : flat;
    const line = `[${readableTime(r.created_at)}] ${actor.label}: ${text}`;
    if (total + line.length > MAX_THREAD_CHARS) {
      lines.push("[earlier messages left out]");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

// ─── The turn ───────────────────────────────────────────────────────────

interface TurnOutcome {
  answer: string;
  cited: ContextNodeSummary[];
  proposals: PendingProposal[];
  trail: { searches: number; reads: number; stopped: boolean };
  /** The turn ended in a model or tool failure: `answer` is the short reason. */
  failed: boolean;
}

/**
 * One Hootie turn as the caller: retrieval, the tool loop (reads plus the
 * propose_* tools), citations. Throws AccessLostError when the caller lost
 * the nest mid-turn; every other failure becomes `failed: true` with the
 * reason as the answer.
 */
async function runTurn(caller: AskCaller, question: string, conversation: string, signal: AbortSignal): Promise<TurnOutcome> {
  const { nestId, userId, userEmail, baseUrl } = caller;
  const baseCredential = resolveModelCredential();
  if (!baseCredential) throw new NoModelKeyError();
  const picked = hootieModel(baseCredential);
  const gatewayModel = await resolveGatewayModel(baseCredential, picked);
  const own = baseCredential.source === "promptowl" ? ownModelRoute(gatewayModel) : null;
  const credential = own?.credential ?? baseCredential;
  const callModel = own?.model ?? gatewayModel;

  const gathered = new Gathered();
  const turn = new TurnContext({ nestId, turnId: randomUUID(), caller: { userId, email: userEmail }, userText: question });
  let first: ContextResult | null = null;
  first = await resolveContext({ nestId, userId, baseUrl, client: HOOTIE_CLIENT, body: { prompt: question, max_tokens: CONTEXT_BUDGET } });
  gathered.take(first);
  for (const n of gathered.nodes) turn.allowNode(n.id, n.title);

  const nest = await getNest(nestId);
  const { text: standing } = await standingBlockFor(nestId, { userId, userEmail });
  const fenceTag = dataFenceTag();
  const seen = new Map<string, ContextNodeSummary>();
  const grantOnly = (await resolveNestPermission(nestId, userId)) === "none";
  const proposals: PendingProposal[] = [];
  const tools = [
    ...hootieTools({ nestId, userId, userEmail, baseUrl, client: HOOTIE_CLIENT, gathered, turn, seen, grantOnly }),
    ...proposalTools({ turn, proposals, max: MAX_PROPOSALS_PER_TURN }),
  ];
  const citable = () => [...gathered.nodes, ...[...seen.values()].filter((n) => !gathered.has(n.id))];
  const promptFor = (canSearch: boolean) =>
    buildSystemPrompt({
      nestName: nest?.name ?? "this nest",
      userEmail,
      anchor: null,
      blocks: gathered.blocks,
      standing,
      searches: canSearch ? turn.budget.searches : 0,
      reads: canSearch ? turn.budget.reads : 0,
      fenceTag,
      conversation,
      extraTools: canSearch ? PROPOSAL_PROMPT_LINES : [],
    });
  const stillAllowed = () =>
    canStillAsk(nestId, userId).catch((err) => {
      console.error("[ask-nest] access re-check failed; ending the turn", nestId, err);
      return false;
    });
  trackEvent("hootie.ask_nest", { nestId, context_nodes: gathered.nodes.length, in_thread: conversation.length > 0 });

  let answer = "";
  const respond = async (canSearch: boolean) => {
    for await (const ev of runAgent({
      apiKey: credential.apiKey,
      model: callModel,
      baseUrl: credential.baseUrl,
      system: promptFor(canSearch),
      turns: [{ role: "user", content: question }],
      tools: canSearch ? tools : [],
      maxCalls: turn.budget.searches + turn.budget.reads,
      turn,
      fenceTag,
      signal,
      stillAllowed,
    })) {
      if (signal.aborted) return;
      if (ev.type === "status") answer = "";
      else answer += ev.text;
    }
  };
  const trail = () => ({ searches: turn.used.search, reads: turn.used.read, stopped: turn.exhausted });
  try {
    try {
      await respond(true);
    } catch (err) {
      if (!(err instanceof ToolsRejectedError)) throw err;
      answer = "";
      if (!signal.aborted) await respond(false);
    }
    if (signal.aborted && !turn.exhausted) {
      turn.exhausted = true;
    }
    if (turn.exhausted) answer += `${answer.trim() ? "\n\n" : ""}${stoppedLine(turn)}`;
  } catch (err) {
    if (err instanceof AccessLostError) throw err;
    if (signal.aborted) {
      turn.exhausted = true;
      return { answer: `${answer.trim() ? `${answer}\n\n` : ""}${stoppedLine(turn)}`, cited: citedNodes(answer, citable()), proposals, trail: trail(), failed: false };
    }
    const text = err instanceof ModelRefusedError ? err.message : describeModelError(err, { model: hootieModel(credential), gateway: !!credential.baseUrl });
    console.error("[ask-nest] model call failed", nestId, err);
    return { answer: text, cited: [], proposals: [], trail: trail(), failed: true };
  }
  return { answer, cited: citedNodes(answer, citable()), proposals, trail: trail(), failed: false };
}

// ─── Posting ────────────────────────────────────────────────────────────

/** The stored attribution of a Hootie message in a thread. */
export function hootieMessageClient(askedBy: string, extra: Record<string, unknown> = {}): ClientMetadata {
  return { ...HOOTIE_CLIENT, model_answer: true, for: askedBy, ...extra } as ClientMetadata;
}

/**
 * Post a message authored `hootie` — a reply in `threadId`, or a new post in
 * the channel when there is no thread. Never fans out. Returns the thread
 * and message ids.
 */
export async function postHootieMessage(params: {
  nestId: string;
  nodeId: string;
  threadId: string | null;
  askedBy: string;
  body: string;
  extra?: Record<string, unknown>;
}): Promise<{ thread_id: string; message_id: string }> {
  const { nestId, nodeId, threadId, askedBy, body } = params;
  const client = hootieMessageClient(askedBy, params.extra);
  const thread = threadId
    ? await addComment(nestId, nodeId, threadId, HOOTIE_HANDLE, body, client)
    : await createThread(nestId, nodeId, { body, anchor: null }, HOOTIE_HANDLE, client);
  await syncAnnotationsNode(nestId, nodeId, askedBy).catch(() => {});
  return { thread_id: thread.id, message_id: justWritten(thread, HOOTIE_HANDLE) ?? thread.comments[thread.comments.length - 1]?.id ?? "" };
}

/** The "I couldn't answer" line, bounded. */
export function couldNotAnswer(reason: string): string {
  const flat = String(reason ?? "").replace(/\s+/g, " ").trim() || "something went wrong.";
  return `I couldn't answer: ${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}`;
}

// ─── In flight ──────────────────────────────────────────────────────────

const inFlight = new Map<Promise<unknown>, AbortController>();
const inFlightByNest = new Map<string, number>();

/** Reserve a slot for a turn in this nest, or false when the nest or the
 *  server already has as many turns running as it may. */
function reserveSlot(nestId: string): boolean {
  const here = inFlightByNest.get(nestId) ?? 0;
  if (here >= MAX_INFLIGHT_PER_NEST || inFlight.size >= MAX_INFLIGHT_TOTAL) return false;
  inFlightByNest.set(nestId, here + 1);
  return true;
}
function releaseSlot(nestId: string): void {
  const here = (inFlightByNest.get(nestId) ?? 1) - 1;
  if (here <= 0) inFlightByNest.delete(nestId);
  else inFlightByNest.set(nestId, here);
}

/** Await every background turn started so far (tests; shutdown). */
export async function settleNestAsks(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight.keys()]);
}

/** Stop every background turn (server shutdown). */
export function abortNestAsks(): void {
  for (const c of inFlight.values()) c.abort();
}

function track<T>(nestId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const cancel = new AbortController();
  const p = run(cancel.signal);
  inFlight.set(p, cancel);
  void p
    .finally(() => {
      inFlight.delete(p);
      releaseSlot(nestId);
    })
    .catch(() => {});
  return p;
}

// ─── Entry points ───────────────────────────────────────────────────────

/**
 * Ask the nest from a conversation, as the caller (REST POST /ask and MCP
 * context_ask_nest). Throws NotFound (switch or Hootie off, not a member,
 * unreadable place), NoModelKeyError (503), AppError 429 (over budget),
 * ValidationError (no question).
 */
export async function askNest(caller: AskCaller, input: AskInput): Promise<AskResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM || !config.HOOTIE_ENABLED) throw new NotFoundError("Not found");
  if (!resolveModelCredential()) throw new NoModelKeyError();
  const place = await resolvePlace(caller, input);
  const question = questionOf(typeof input.question === "string" ? input.question : "");
  if (!question) throw new ValidationError("question is required");
  if (question.length > MAX_QUESTION_CHARS) throw new ValidationError(`question is too long (max ${MAX_QUESTION_CHARS} characters)`);
  if (input.post === true) {
    // Posting the answer is a post: the channel's rule applies (archived
    // channel or nest, not a member) before any model call.
    const refusal = await channelPostRefusal(caller.nestId, place.nodeId, caller.userId, caller.userEmail);
    if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);
  }
  if (!tryConsume(`hootie:${caller.userId}`, CHAT_BUDGET)) {
    throw new AppError(429, "Too many questions in a short time — give it a few minutes.");
  }
  if (!reserveSlot(caller.nestId)) throw new AppError(429, BUSY);
  return track(caller.nestId, (signal) => answerAndMaybePost(caller, place, question, null, input.post === true, signal));
}

async function answerAndMaybePost(
  caller: AskCaller,
  place: Place,
  question: string,
  askingCommentId: string | null,
  post: boolean,
  signal: AbortSignal,
): Promise<AskResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), turnDeadline.ms(new TurnContext({ nestId: caller.nestId, turnId: "", caller: { userId: caller.userId, email: caller.userEmail }, userText: "" }).budget));
  (timer as { unref?: () => void }).unref?.();
  const work = AbortSignal.any([signal, deadline.signal]);
  try {
    const conversation = place.threadId ? await threadContext(caller.nestId, place.threadId, askingCommentId) : "";
    const outcome = await runTurn(caller, question, conversation, work);
    const cited = outcome.cited.map((n) => ({ id: n.id, title: n.title }));
    const body = outcome.failed ? couldNotAnswer(outcome.answer) : inertAnswer(outcome.answer.trim() || "(no answer)");
    let posted: AskResult["posted"] = null;
    let proposals: ProposalView[] = [];
    if (post) {
      // Removed from the nest while the model answered: nothing is posted for
      // them, and nothing of what was retrieved for them lands in the thread.
      if (!(await canStillAsk(caller.nestId, caller.userId).catch(() => false))) throw new AccessLostError();
      const first = await postHootieMessage({
        nestId: caller.nestId,
        nodeId: place.nodeId,
        threadId: place.threadId,
        askedBy: caller.userEmail,
        body,
        extra: { citations: cited, trail: JSON.stringify(outcome.trail) },
      });
      const threadId = first.thread_id;
      const proposalMessageIds: string[] = [];
      for (const p of outcome.proposals) {
        // The write Hootie wanted, as a draft for review authored by hootie
        // (proposals.ts), then its card in the thread.
        const filed = await fileProposal({ nestId: caller.nestId, nodeId: place.nodeId, threadId, channel: place.channel, askedBy: caller.userEmail, baseUrl: caller.baseUrl, pending: p });
        const card = await postHootieMessage({
          nestId: caller.nestId,
          nodeId: place.nodeId,
          threadId,
          askedBy: caller.userEmail,
          body: inertAnswer(`Proposal — ${p.preview}`),
          extra: { proposal: filed },
        });
        proposals.push({ ...filed, message_id: card.message_id });
        proposalMessageIds.push(card.message_id);
      }
      posted = { node_id: place.nodeId, channel: place.channel, thread_id: threadId, message_id: first.message_id, proposal_message_ids: proposalMessageIds };
    } else {
      // Not posted: nothing is filed either — a proposal is only ever a draft
      // WITH its card. The caller sees what would be proposed.
      proposals = outcome.proposals.map((p) => ({
        kind: p.kind,
        node_id: typeof p.target.node_id === "string" ? p.target.node_id : null,
        version: null,
        review_id: null,
        title: String(p.target.title ?? ""),
        preview: p.preview,
        status: "unfiled",
        reason: null,
        message_id: null,
      }));
    }
    return { answer: outcome.failed ? couldNotAnswer(outcome.answer) : outcome.answer, cited, proposals, posted, trail: outcome.trail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "@hootie …" just landed in a channel thread (channels/post-message.ts):
 * answer in the background as the person who wrote it. Fire-and-forget like
 * every fan-out — a failure here never fails the post, and the ONLY things
 * that post nothing are: the feature off, no model credential, the asker gone
 * from the nest. Everything else answers, if only with why it couldn't.
 */
export function triggerHootieForMessage(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  commentId: string;
  body: string;
  authorEmail: string;
  authorUserId: string;
  baseUrl?: string;
}): void {
  const { nestId, nodeId, threadId, commentId, body, authorEmail, authorUserId } = params;
  if (!config.EXPERIMENTAL_AGENT_STREAM || !config.HOOTIE_ENABLED) return;
  if (!mentionsHootie(body)) return;
  if (!resolveModelCredential()) return;
  const caller: AskCaller = { nestId, userId: authorUserId, userEmail: authorEmail, baseUrl: params.baseUrl ?? config.PUBLIC_BASE_URL ?? "" };
  const place: Place = { nodeId, channel: channelNameOf(nodeId), threadId };
  const refuse = (reason: string) => postHootieMessage({ nestId, nodeId, threadId, askedBy: authorEmail, body: couldNotAnswer(reason) });
  if (!reserveSlot(nestId)) {
    void refuse(BUSY).catch(() => {});
    return;
  }
  void track(nestId, async (signal) => {
    try {
      // Asked as a member who can read this channel, now: the post route
      // checked it a moment ago, and the turn re-checks on every round.
      if (!(await isNestMember(nestId, authorUserId)) || !(await canOpenNode(nestId, nodeId, authorUserId, authorEmail))) return;
      // A person's own message only. A message a declared agent wrote
      // (`client.agent`; a bare key label is the person, message-meta.ts)
      // does not make Hootie answer "for" the person behind the key: an agent
      // asks through context_ask_nest and gets the answer itself (security
      // review r2 F1).
      const row = (await getDb().get("SELECT client_json FROM annotation_comments WHERE id = ?", [commentId])) as { client_json: string | null } | undefined;
      if (!row || deserializeClient(row.client_json)?.agent) return;
      const question = questionOf(body);
      if (!question) {
        await refuse("ask me a question after @hootie.");
        return;
      }
      if (question.length > MAX_QUESTION_CHARS) {
        await refuse(`the question is too long (at most ${MAX_QUESTION_CHARS} characters).`);
        return;
      }
      if (!tryConsume(`hootie:${authorUserId}`, CHAT_BUDGET)) {
        await refuse("too many questions in a short time — give it a few minutes.");
        return;
      }
      await answerAndMaybePost(caller, place, question, commentId, true, signal);
    } catch (err) {
      if (err instanceof AccessLostError) return;
      console.error("[ask-nest] turn failed", nestId, threadId, err);
      const reason = err instanceof AppError ? err.message : "something went wrong.";
      await postHootieMessage({ nestId, nodeId, threadId, askedBy: authorEmail, body: couldNotAnswer(reason) }).catch(() => {});
    }
  });
}

/** For a tool's text: the answer with its citations listed. */
export function askText(r: AskResult): string {
  const name = effectiveHootieBrand().name;
  const lines = [r.answer.trim()];
  if (r.cited.length) lines.push("", `Cited: ${r.cited.map((c) => `${c.title} (${c.id})`).join("; ")}.`);
  if (r.proposals.length) {
    lines.push(
      "",
      `${name} proposed ${r.proposals.length} write${r.proposals.length === 1 ? "" : "s"} (nothing was written):`,
      ...r.proposals.map(
        (p) =>
          `- ${p.kind}: ${p.preview.split("\n")[0]}${
            p.review_id
              ? ` — draft ${p.node_id} v${p.version} in the review queue (${p.status}); a writer approves with context_approve or rejects with context_reject`
              : p.status === "failed"
                ? ` — not filed: ${p.reason}`
                : " (not posted, so not filed; pass post: true to post it as a card)"
          }`,
      ),
    );
  }
  if (r.posted) lines.push("", `Posted in ${r.posted.channel ? `#${r.posted.channel}` : r.posted.node_id}, thread ${r.posted.thread_id} (message ${r.posted.message_id}).`);
  return lines.join("\n");
}

export { INERT_MAX_CHARS as HOOTIE_ANSWER_MAX_CHARS };
