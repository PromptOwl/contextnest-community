/**
 * Hootie in the nest — the floating assistant on every page.
 *
 * A launcher in the corner opens a slide-over that knows where you are: the
 * document you have open, or the nest, and asks about that. Answers stream in
 * and cite documents as chips that open them. The composer keeps real
 * Hootie's conventions — `@` loops a colleague in, `/` switches the nest.
 *
 * Tagging someone is a real delivery, not decoration: the server posts the
 * exchange as a comment on the anchor document and notifies them the way a
 * comment mention does. The panel says where it landed.
 *
 * Always mounted (below the app shell) so the conversation survives closing
 * the panel and moving between pages; it resets only when the nest changes,
 * since the answers were about that nest. The launcher hides when the server
 * has the feature off; without an API key it stays and says what's missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Send, Loader2, MessageSquareText, KeyRound, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuth } from "../auth/AuthContext";
import { reads } from "@/lib/queries";
import {
  chatWithHootie,
  type HootieMention,
  type HootieNode,
  type HootieTurn,
} from "@/lib/api";
import { MentionTextarea } from "./MentionTextarea";
import type { MentionMember } from "./MarkdownEditor/picker-match";
import hootieIcon from "../assets/hootie.svg";

/** Where the page is; the panel derives its scope from it. */
export interface HootieScope {
  nestId: string;
  nestName: string;
  /** The open document, when the page is one. */
  nodeId?: string;
}

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Assistant only: documents the answer cites, in order. */
  cited?: HootieNode[];
  /** Assistant only: what happened to the @mentions in the question. */
  mention?: HootieMention | null;
  /** Assistant only: still streaming in. */
  pending?: boolean;
  /** Assistant only: the model call failed; content is the explanation. */
  failed?: boolean;
}

interface NestOption {
  id: string;
  name: string;
}

export interface HootiePanelProps {
  /** What the page is showing; null on pages without a nest (the dashboard). */
  page: HootieScope | null;
  /** Open a document in the app. Hootie's citation chips route through this. */
  onOpenNode: (nestId: string, nodeId: string) => void;
  /** Where the admin turns the key on; shown only to admins. */
  onOpenSettings?: () => void;
}

const MAX_TURNS_SENT = 20;

export function HootiePanel({ page, onOpenNode, onOpenSettings }: HootiePanelProps) {
  const { hootieEnabled, runnerKeyConfigured, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  // A nest picked with `/` overrides the page until the page moves to a
  // different nest — then the page wins again, so following the person
  // around the app is the default and the override is the exception.
  const [override, setOverride] = useState<NestOption | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const nextId = useRef(1);

  const scope: HootieScope | null = override
    ? { nestId: override.id, nestName: override.name }
    : page;
  const scopeNestId = scope?.nestId ?? null;

  // The conversation is about one nest. When that changes, so does the
  // subject — start over rather than carry answers about somewhere else.
  const prevNest = useRef<string | null>(scopeNestId);
  useEffect(() => {
    if (prevNest.current !== scopeNestId) {
      prevNest.current = scopeNestId;
      abortRef.current?.abort();
      setMessages([]);
      setBusy(false);
    }
  }, [scopeNestId]);
  useEffect(() => {
    if (override && page && page.nestId !== override.id) setOverride(null);
    // Only the page moving matters; a fresh override is set with the page it
    // was chosen on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.nestId]);

  // The nests you can ask about, for `/`; loaded once the panel is open.
  const { data: nestList } = useQuery({ ...reads.nestList(), enabled: open });
  const nests: NestOption[] = useMemo(
    () =>
      ((nestList as any)?.nests ?? []).map((n: any) => ({
        id: n.id as string,
        name: (n.name as string) || n.id,
      })),
    [nestList],
  );

  // The nest's people for `@`. Read tier, same roster the comment box uses;
  // empty for someone not on it, and then the box is just a textarea.
  const { data: roster } = useQuery({
    ...reads.mentionable(scopeNestId ?? ""),
    enabled: open && !!scopeNestId,
    retry: false,
  });
  const members: MentionMember[] = useMemo(
    () => (roster?.people ?? []).filter((p) => !!p.email),
    [roster],
  );

  // The open document's title for the header. The node read is cached by
  // the page that is showing it, so this is free on the document page.
  const { data: nodeData } = useQuery({
    ...reads.node(page?.nestId ?? "", page?.nodeId ?? ""),
    enabled: open && !!page?.nestId && !!page?.nodeId && !override,
  });
  const nodeTitle: string | null =
    (nodeData as any)?.node?.frontmatter?.title ??
    (nodeData as any)?.node?.title ??
    null;

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, scopeNestId]);

  // `/` at the start of the draft is the nest switcher.
  const slash = draft.startsWith("/") ? draft.slice(1).trim().toLowerCase() : null;
  const slashMatches = useMemo(
    () =>
      slash === null
        ? []
        : nests.filter((n) => !slash || n.name.toLowerCase().includes(slash)).slice(0, 8),
    [slash, nests],
  );
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => setSlashIndex(0), [slash]);

  const pickNest = (n: NestOption) => {
    setOverride(page && page.nestId === n.id ? null : n);
    setDraft("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy || !scope) return;
    const nestId = scope.nestId;
    const nodeId = override ? null : (page?.nodeId ?? null);
    const history: HootieTurn[] = messages
      .filter((m) => !m.failed && !m.pending)
      .slice(-MAX_TURNS_SENT)
      .map((m) => ({ role: m.role, content: m.content }));

    const userId = nextId.current++;
    const answerId = nextId.current++;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: message },
      { id: answerId, role: "assistant", content: "", pending: true },
    ]);
    setDraft("");
    setBusy(true);
    const patch = (p: Partial<Message>) =>
      setMessages((prev) => prev.map((m) => (m.id === answerId ? { ...m, ...p } : m)));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await chatWithHootie(
        nestId,
        { message, node_id: nodeId, history },
        {
          delta: (text) =>
            setMessages((prev) =>
              prev.map((m) =>
                m.id === answerId ? { ...m, content: m.content + text } : m,
              ),
            ),
          done: (d) =>
            patch({ content: d.answer, cited: d.cited, mention: d.mention, pending: false }),
          error: (text) => patch({ content: text, failed: true, pending: false }),
        },
        ctrl.signal,
      );
      // A stream that closed without a done or error event: keep what
      // arrived, but don't leave the bubble spinning.
      setMessages((prev) =>
        prev.map((m) => (m.id === answerId && m.pending ? { ...m, pending: false } : m)),
      );
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        setMessages((prev) => prev.filter((m) => m.id !== answerId && m.id !== userId));
      } else {
        patch({
          content: e?.message || "Hootie couldn't answer that.",
          failed: true,
          pending: false,
        });
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
    }
  }, [draft, busy, scope, override, page, messages]);

  if (!hootieEnabled) return null;

  const scopeLabel = !scope
    ? "Pick a nest to ask about"
    : !override && page?.nodeId
      ? `Asking about ${nodeTitle ? `“${nodeTitle}”` : "this document"} in ${scope.nestName}`
      : `Asking about ${scope.nestName}`;

  return (
    <>
      {/* Launcher */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ask Hootie"
          title="Ask Hootie"
          data-testid="hootie-launcher"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full border bg-background shadow-lg transition hover:scale-105 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={hootieIcon} alt="" className="h-7 w-7" />
        </button>
      )}

      {/* Panel */}
      {open && (
        <aside
          role="dialog"
          aria-label="Hootie"
          data-testid="hootie-panel"
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l bg-background shadow-2xl"
        >
          <header className="flex items-start gap-3 border-b px-4 py-3">
            <img src={hootieIcon} alt="" className="mt-0.5 h-7 w-7 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-tight">Hootie</div>
              <div className="truncate text-xs text-muted-foreground" title={scopeLabel}>
                {scopeLabel}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Hootie"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {!runnerKeyConfigured ? (
            <NoKeyNotice isAdmin={isAdmin} onOpenSettings={onOpenSettings} />
          ) : !scope ? (
            <PickNest nests={nests} onPick={pickNest} />
          ) : (
            <>
              <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
                {messages.length === 0 && (
                  <div className="mt-6 space-y-2 text-center text-sm text-muted-foreground">
                    <MessageSquareText className="mx-auto h-6 w-6 opacity-60" />
                    <p>
                      Ask anything about{" "}
                      {!override && page?.nodeId ? "this document" : scope.nestName}.
                    </p>
                    <p className="text-xs">
                      <kbd className="rounded border px-1">@</kbd> loops a colleague in ·{" "}
                      <kbd className="rounded border px-1">/</kbd> switches nest
                    </p>
                  </div>
                )}
                <ul className="space-y-3">
                  {messages.map((m) => (
                    <li key={m.id} data-testid={`hootie-${m.role}`}>
                      {m.role === "user" ? (
                        <div className="ml-8 whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                          {m.content}
                        </div>
                      ) : (
                        <AnswerBubble
                          message={m}
                          nestId={scope.nestId}
                          onOpenNode={onOpenNode}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t px-3 py-3">
                <div className="relative">
                  {slash !== null && slashMatches.length > 0 && (
                    <ul
                      role="listbox"
                      data-testid="hootie-nest-picker"
                      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
                    >
                      {slashMatches.map((n, i) => (
                        <li key={n.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={i === slashIndex}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickNest(n);
                            }}
                            onMouseEnter={() => setSlashIndex(i)}
                            className={cn(
                              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                              i === slashIndex ? "bg-accent text-accent-foreground" : "",
                            )}
                          >
                            <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{n.name}</span>
                            {n.id === scope.nestId && (
                              <span className="ml-auto text-xs text-muted-foreground">current</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <MentionTextarea
                    ref={inputRef}
                    value={draft}
                    onValueChange={setDraft}
                    members={members}
                    rows={2}
                    placeholder="Ask Hootie…  ( @ mention · / nest )"
                    data-testid="hootie-input"
                    className="w-full resize-none rounded-md border bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onKeyDown={(e) => {
                      if (slash !== null && slashMatches.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSlashIndex((i) => (i + 1) % slashMatches.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashIndex((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
                          return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          pickNest(slashMatches[slashIndex] ?? slashMatches[0]);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setDraft("");
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        // A "/" draft is a nest search, never a question —
                        // with nothing matched, Enter does nothing (the send
                        // button is disabled for the same reason).
                        if (slash === null) void send();
                      }
                      if (e.key === "Escape") setOpen(false);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={busy || !draft.trim() || slash !== null}
                    aria-label="Send"
                    className="absolute bottom-2 right-2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Answers come only from what you can read in this nest. Tagging someone posts the
                  exchange as a comment and notifies them.
                </p>
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

function NoKeyNotice({
  isAdmin,
  onOpenSettings,
}: {
  isAdmin: boolean;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm">
      <KeyRound className="h-6 w-6 text-muted-foreground" />
      <p className="font-medium">Hootie needs an API key</p>
      <p className="text-muted-foreground">
        {isAdmin
          ? "Add an Anthropic API key under Settings → General and Hootie can answer from your nests."
          : "Ask your server admin to add an Anthropic API key under Settings → General."}
      </p>
      {isAdmin && onOpenSettings && (
        <Button size="sm" variant="outline" onClick={onOpenSettings}>
          Open Settings
        </Button>
      )}
    </div>
  );
}

function PickNest({
  nests,
  onPick,
}: {
  nests: NestOption[];
  onPick: (n: NestOption) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      <p className="mb-3 text-muted-foreground">
        Hootie answers about one nest at a time. Which one?
      </p>
      {nests.length === 0 ? (
        <p className="text-xs text-muted-foreground">No nests yet.</p>
      ) : (
        <ul className="space-y-1" data-testid="hootie-nest-list">
          {nests.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onPick(n)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{n.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * An answer with its citations. `[[Title]]` in the text becomes a chip for a
 * cited node; a wiki link the server didn't resolve stays as plain text, so
 * nothing reads as clickable that isn't.
 */
function AnswerBubble({
  message,
  nestId,
  onOpenNode,
}: {
  message: Message;
  nestId: string;
  onOpenNode: (nestId: string, nodeId: string) => void;
}) {
  const cited = message.cited ?? [];
  const byTitle = useMemo(
    () => new Map(cited.map((n) => [n.title.toLowerCase(), n])),
    [cited],
  );
  // Rewrite [[Title]] → [Title](#cite:<id>) for the cited ones; the link
  // renderer below turns those hrefs into chips.
  const source = useMemo(
    () =>
      message.content.replace(/\[\[([^\]]+)\]\]/g, (whole, title: string) => {
        const n = byTitle.get(title.trim().toLowerCase());
        return n ? `[${title.trim()}](#cite:${encodeURIComponent(n.id)})` : whole;
      }),
    [message.content, byTitle],
  );

  if (message.failed) {
    return (
      <div className="mr-8 rounded-2xl rounded-bl-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {message.content}
      </div>
    );
  }
  return (
    <div className="mr-4">
      <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">
        {message.pending && !message.content ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the nest…
          </span>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  if (href?.startsWith("#cite:")) {
                    const id = decodeURIComponent(href.slice(6));
                    return (
                      <button
                        type="button"
                        onClick={() => onOpenNode(nestId, id)}
                        className="inline-flex items-center rounded border bg-background px-1.5 py-0.5 align-baseline text-xs font-medium no-underline hover:bg-accent"
                        data-testid="hootie-citation"
                      >
                        {children}
                      </button>
                    );
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {source}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {cited.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="hootie-cited">
          {cited.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onOpenNode(nestId, n.id)}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={n.id}
            >
              {n.title}
            </button>
          ))}
        </div>
      )}
      {message.mention && <MentionOutcome outcome={message.mention} nestId={nestId} onOpenNode={onOpenNode} />}
    </div>
  );
}

function MentionOutcome({
  outcome,
  nestId,
  onOpenNode,
}: {
  outcome: HootieMention;
  nestId: string;
  onOpenNode: (nestId: string, nodeId: string) => void;
}) {
  if (outcome.status === "posted") {
    return (
      <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="hootie-mention-posted">
        Posted as a comment on{" "}
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => onOpenNode(nestId, outcome.node_id)}
        >
          {outcome.node_title}
        </button>
        {outcome.notified > 0
          ? ` · ${outcome.notified} ${outcome.notified === 1 ? "person" : "people"} notified`
          : " · nobody new to notify"}
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400" data-testid="hootie-mention-undeliverable">
      {outcome.reason === "no_anchor"
        ? "Couldn't tag anyone: there's no document to attach this to. Open one, or ask something Hootie can cite."
        : "Couldn't post the comment — the mention wasn't delivered."}
    </p>
  );
}
