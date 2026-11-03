/**
 * One question is one turn (PRD §3.1). The turn context is the server's
 * record of what this caller's model may name, and how much looking it may
 * do — pure state, no I/O, unit-tested in test/hootie-turn.test.ts.
 *
 * - `allowNodes` holds the node ids the SERVER handed this caller this turn
 *   (the open document, the first retrieval, every search and read result),
 *   each with the title the caller read. A node id the model passes to a tool
 *   must be in it; a title must name exactly one node in it. Nothing a
 *   document says can add to it — only a tool result the server itself
 *   produced (must-never 4).
 * - `allowBoards` is the same for boards: ids and names list_boards returned.
 * - The budget (§3.12) counts extra searches and reads separately, under one
 *   wall-clock cap. A call over budget is refused and ends the looking; the
 *   answer then says so with `stoppedLine`.
 * - `rejectedCall`: the model asked for something malformed or outside the
 *   allowlist. The turn is answer-only from then on.
 */
import { citationKey } from "./citations.js";

export type EffortPreset = "quick" | "standard" | "thorough";

export interface Budget {
  /** Extra searches the model may run (ticket B's cap is 2). */
  searches: number;
  reads: number;
  wallClockMs: number;
}

export const EFFORT_PRESETS: Record<EffortPreset, Budget> = {
  quick: { searches: 1, reads: 3, wallClockMs: 10_000 },
  standard: { searches: 2, reads: 6, wallClockMs: 20_000 },
  thorough: { searches: 2, reads: 12, wallClockMs: 40_000 },
};

/** Until the admin setting lands (H6a), every nest runs Standard. */
export const DEFAULT_EFFORT: EffortPreset = "standard";

export type ToolKind = "search" | "read";

export interface TurnCaller {
  userId: string;
  email: string;
  /** Hootie runs only as a signed-in person: never on an API key. */
  apiKeyId: null;
}

export class TurnContext {
  readonly nestId: string;
  readonly turnId: string;
  readonly caller: TurnCaller;
  /** The raw user message, verbatim, for deterministic checks. */
  readonly userText: string;
  readonly budget: Budget;
  /** id → the title as this caller read it. */
  readonly allowNodes = new Map<string, string>();
  /** board id → name. */
  readonly allowBoards = new Map<string, string>();
  readonly used: Record<ToolKind, number> = { search: 0, read: 0 };
  rejectedCall = false;
  /** A call was refused for budget or time: no more looking this turn. */
  exhausted = false;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(opts: {
    nestId: string;
    turnId: string;
    caller: { userId: string; email: string };
    userText: string;
    budget?: Budget;
    now?: () => number;
  }) {
    this.nestId = opts.nestId;
    this.turnId = opts.turnId;
    this.caller = { userId: opts.caller.userId, email: opts.caller.email, apiKeyId: null };
    this.userText = opts.userText;
    this.budget = { ...(opts.budget ?? EFFORT_PRESETS[DEFAULT_EFFORT]) };
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Called only with what a server read returned for this caller. */
  allowNode(id: string, title: string): void {
    if (!this.allowNodes.has(id)) this.allowNodes.set(id, title);
  }

  allowBoard(id: string, name: string): void {
    if (!this.allowBoards.has(id)) this.allowBoards.set(id, name);
  }

  /** No more tool calls this turn: the model must answer with what it has. */
  get answerOnly(): boolean {
    return this.rejectedCall || this.exhausted;
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }
}

/** The id, if the model may name it this turn; else null. */
export function admitNodeId(ctx: TurnContext, id: unknown): string | null {
  return typeof id === "string" && id !== "" && ctx.allowNodes.has(id) ? id : null;
}

/**
 * A node the model named by `id` or `title`. An id must be allowed; a title
 * must match (case, dash and quote variants aside) exactly one allowed node.
 * Both given: they must agree.
 */
export function admitNodeRef(ctx: TurnContext, ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const { id, title } = ref as { id?: unknown; title?: unknown };
  const byId = id === undefined ? undefined : admitNodeId(ctx, id);
  if (byId === null) return null;
  if (title === undefined) return byId ?? null;
  if (typeof title !== "string" || !title.trim()) return null;
  const key = citationKey(title);
  const matches = [...ctx.allowNodes].filter(([, t]) => citationKey(t) === key).map(([nid]) => nid);
  if (matches.length !== 1) return null;
  if (byId !== undefined && byId !== matches[0]) return null;
  return matches[0];
}

/** A board the model named by id, or by a name exactly one listed board has. */
export function admitBoard(ctx: TurnContext, ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  if (ctx.allowBoards.has(ref)) return ref;
  const key = citationKey(ref);
  const matches = [...ctx.allowBoards].filter(([, name]) => citationKey(name) === key);
  return matches.length === 1 ? matches[0][0] : null;
}

/**
 * Spend one call of `kind`. False — and the turn is exhausted — when that
 * budget is used up or the wall-clock cap has passed.
 */
export function spend(ctx: TurnContext, kind: ToolKind): boolean {
  const cap = kind === "search" ? ctx.budget.searches : ctx.budget.reads;
  if (ctx.exhausted || ctx.used[kind] >= cap || ctx.elapsedMs() > ctx.budget.wallClockMs) {
    ctx.exhausted = true;
    return false;
  }
  ctx.used[kind]++;
  return true;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The fixed line an answer ends with when the looking was cut short. */
export function stoppedLine(ctx: TurnContext): string {
  return `I stopped looking after ${plural(ctx.used.search, "search", "searches")} and ${plural(ctx.used.read, "read", "reads")}.`;
}

/** Time the answer itself gets after the looking budget (§3.12). */
export const ANSWER_GRACE_MS = 30_000;

/**
 * When the whole turn is cut off — looking and answering, the broadened
 * re-answer included. A route-level deadline, not only a check when a tool
 * call is admitted (security r1 F8). An object so a test can shorten it.
 */
export const turnDeadline = {
  ms: (budget: Budget): number => budget.wallClockMs + ANSWER_GRACE_MS,
};
