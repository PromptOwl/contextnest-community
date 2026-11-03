/**
 * Hootie in the nest — the assistant side panel on every page.
 *
 * A slim tab on the right edge opens a slide-over panel beside the page (it
 * pushes the page over on wide screens, overlays it on narrow ones, and can be
 * resized from its left edge). The panel knows where you are: the
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
 * has the feature off, and when there is no API key — except for an admin,
 * who gets it with the "what's missing" notice and the way to fix it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Loader2,
  KeyRound,
  Database,
  RotateCcw,
  AlertCircle,
  FileText,
  PanelRightClose,
} from "lucide-react";
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
import { HootieAnswerMarkdown } from "./HootieAnswer";
import type { MentionMember } from "./MarkdownEditor/picker-match";
import hootieIcon from "../assets/hootie.svg";
import {
  HOOTIE_PANEL_DEFAULT,
  clampPanelWidth,
  hootieAccentStyle,
  hootieGreeting,
  pushesContent,
  readPanelWidth,
  savePanelWidth,
} from "@/lib/hootie-panel";

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
  const { hootieEnabled, hootieBrand, runnerKeyConfigured, isAdmin } = useAuth();
  const name = hootieBrand.name;
  const logo = hootieBrand.logo_url || hootieIcon;
  const accent = hootieAccentStyle(hootieBrand.accent_color);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number>(() => readPanelWidth());
  const [viewport, setViewport] = useState<number>(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const push = open && pushesContent(viewport);
  // On wide screens the open panel sits beside the page instead of over it:
  // the app shell pads its right side by --hootie-inset (App.tsx).
  useEffect(() => {
    const root = document.documentElement;
    if (push) root.style.setProperty("--hootie-inset", `${width}px`);
    else root.style.removeProperty("--hootie-inset");
    return () => {
      root.style.removeProperty("--hootie-inset");
    };
  }, [push, width]);

  // Drag the left edge to resize; the width is remembered per browser.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setWidth(clampPanelWidth(window.innerWidth - ev.clientX, window.innerWidth));
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setWidth((w) => {
        savePanelWidth(w);
        return w;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const nudgeWidth = (delta: number) =>
    setWidth((w) => {
      const next = clampPanelWidth(w + delta, window.innerWidth);
      savePanelWidth(next);
      return next;
    });
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

  // `text` sends a suggestion chip as-is; otherwise the draft goes.
  const send = useCallback(async (text?: string) => {
    const message = (text ?? draft).trim();
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
          content: e?.message || `${name} couldn't answer that.`,
          failed: true,
          pending: false,
        });
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
    }
  }, [draft, busy, scope, override, page, messages, name]);

  if (!hootieEnabled) return null;
  // On without a key answers nothing. An admin still gets the launcher —
  // that's the route to the setting that fixes it — but for everyone else a
  // dead owl is worse than none, so they see nothing until the key is there.
  if (!runnerKeyConfigured && !isAdmin) return null;

  const scopeLabel = !scope
    ? "Pick a nest to ask about"
    : !override && page?.nodeId
      ? `Asking about ${nodeTitle ? `“${nodeTitle}”` : "this document"} in ${scope.nestName}`
      : `Asking about ${scope.nestName}`;

  return (
    <>
      {/* Launcher: a slim tab on the right edge, out of the way of the page. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${name}`}
          title={`Ask ${name}`}
          data-testid="hootie-launcher"
          style={accent ?? undefined}
          className={cn(
            "fixed right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center gap-2 rounded-l-xl py-3 pl-1.5 pr-1 shadow-lg transition-all hover:pl-2.5 focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
            !accent && "bg-primary text-primary-foreground",
          )}
        >
          <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-background">
            <img src={logo} alt="" referrerPolicy="no-referrer" className="h-6 w-6 object-contain" />
          </span>
          <span className="max-h-40 overflow-hidden text-xs font-medium [writing-mode:vertical-rl]">
            {name}
          </span>
        </button>
      )}

      {/* Panel: slides in from the right edge; resizable from its left edge. */}
      {open && (
        <aside
          role="complementary"
          aria-label={name}
          data-testid="hootie-panel"
          data-pushes={push ? "true" : "false"}
          style={{ width: pushesContent(viewport) ? width : undefined }}
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l bg-background shadow-2xl animate-in slide-in-from-right duration-200",
            !pushesContent(viewport) && "w-full sm:w-[420px]",
          )}
        >
          {pushesContent(viewport) && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${name}`}
              aria-valuenow={width}
              tabIndex={0}
              data-testid="hootie-resize"
              onPointerDown={startResize}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  nudgeWidth(24);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  nudgeWidth(-24);
                }
              }}
              onDoubleClick={() => {
                setWidth(HOOTIE_PANEL_DEFAULT);
                savePanelWidth(HOOTIE_PANEL_DEFAULT);
              }}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20 focus:bg-primary/30 focus:outline-none"
            />
          )}
          <header
            style={accent ?? undefined}
            className={cn(
              "flex items-center gap-3 px-4 py-3",
              !accent && "bg-primary text-primary-foreground",
            )}
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background">
              <img src={logo} alt="" referrerPolicy="no-referrer" className="h-6 w-6 object-contain" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight" data-testid="hootie-name">
                {name}
              </div>
              <div className="truncate text-xs opacity-75" title={scopeLabel}>
                {scopeLabel}
              </div>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  abortRef.current?.abort();
                  setMessages([]);
                }}
                aria-label="New conversation"
                title="New conversation"
                className="rounded-md p-1.5 opacity-75 hover:bg-black/10 hover:opacity-100"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={`Close ${name}`}
              title="Close panel (Esc)"
              data-testid="hootie-close"
              className="rounded-md p-1.5 opacity-75 hover:bg-black/10 hover:opacity-100"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </header>

          {!runnerKeyConfigured ? (
            <NoKeyNotice name={name} isAdmin={isAdmin} onOpenSettings={onOpenSettings} />
          ) : !scope ? (
            <PickNest name={name} nests={nests} onPick={pickNest} />
          ) : (
            <>
              <div ref={listRef} className="flex-1 overflow-y-auto bg-muted/30 px-4 py-4">
                {messages.length === 0 && (
                  <Welcome
                    name={name}
                    logo={logo}
                    greeting={hootieGreeting(hootieBrand)}
                    onDocument={!override && !!page?.nodeId}
                    subject={
                      !override && page?.nodeId
                        ? nodeTitle ?? "this document"
                        : scope.nestName
                    }
                    onAsk={(q) => void send(q)}
                  />
                )}
                <ul className="space-y-4">
                  {messages.map((m) => (
                    <li key={m.id} data-testid={`hootie-${m.role}`}>
                      {m.role === "user" ? (
                        <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm">
                          {m.content}
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm">
                            <img src={logo} alt="" referrerPolicy="no-referrer" className="h-[18px] w-[18px] object-contain" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <AnswerBubble
                              name={name}
                              message={m}
                              nestId={scope.nestId}
                              onOpenNode={onOpenNode}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t bg-background px-3 pb-2.5 pt-3">
                <div className="relative rounded-xl border bg-background shadow-sm transition focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
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
                    placeholder={`Ask ${name} anything…`}
                    data-testid="hootie-input"
                    className="block w-full resize-none rounded-xl border-0 bg-transparent px-3.5 py-2.5 pr-12 text-sm placeholder:text-muted-foreground/70 focus:outline-none"
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
                    className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  <kbd className="rounded border bg-muted px-1 font-sans">@</kbd> tag a colleague ·{" "}
                  <kbd className="rounded border bg-muted px-1 font-sans">/</kbd> switch nest · answers
                  use only what you can read
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
  name,
  isAdmin,
  onOpenSettings,
}: {
  name: string;
  isAdmin: boolean;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/30 px-6 text-center text-sm">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 ring-8 ring-amber-500/5">
        <KeyRound className="h-6 w-6 text-amber-600 dark:text-amber-400" />
      </span>
      <p className="text-base font-semibold">{name} needs an API key</p>
      <p className="text-muted-foreground">
        {isAdmin
          ? `Add an Anthropic API key under Server settings → Hootie and ${name} can answer from your nests.`
          : "Ask your server admin to add an Anthropic API key under Server settings → Hootie."}
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
  name,
  nests,
  onPick,
}: {
  name: string;
  nests: NestOption[];
  onPick: (n: NestOption) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      <p className="mb-3 text-muted-foreground">
        {name} answers about one nest at a time. Which one?
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

/** Empty-conversation greeting with a few starter questions for the scope. */
function Welcome({
  name,
  logo,
  greeting,
  onDocument,
  subject,
  onAsk,
}: {
  name: string;
  logo: string;
  greeting: string;
  onDocument: boolean;
  subject: string;
  onAsk: (question: string) => void;
}) {
  const starters = onDocument
    ? ["Summarize this document", "What are the key points here?", "What's unclear or missing?"]
    : ["What's in this nest?", "Summarize the main topics", "Where should I start?"];
  return (
    <div className="flex flex-col items-center px-2 pt-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 ring-8 ring-primary/5">
        <img src={logo} alt="" referrerPolicy="no-referrer" className="h-10 w-10 object-contain" />
      </span>
      <h2 className="mt-4 text-base font-semibold" data-testid="hootie-greeting" aria-label={`${greeting} (${name})`}>
        {greeting}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask me anything about <span className="font-medium text-foreground">{subject}</span>.
      </p>
      <div className="mt-5 flex w-full flex-col gap-2" data-testid="hootie-starters">
        {starters.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onAsk(q)}
            className="flex items-center gap-2 rounded-xl border bg-background px-3 py-2 text-left text-sm shadow-sm transition hover:border-primary/40 hover:bg-accent"
          >
            {onDocument ? (
              <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <Database className="h-3.5 w-3.5 shrink-0 text-primary" />
            )}
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * An answer with its citations. `[[X]]` in the text becomes a chip for a
 * cited node; a wiki link the server didn't resolve becomes plain text
 * without its brackets. Images and other links never render as such — see
 * HootieAnswer.tsx: nothing in an answer is fetched or clickable unless the
 * server cited it.
 */
function AnswerBubble({
  name,
  message,
  nestId,
  onOpenNode,
}: {
  name: string;
  message: Message;
  nestId: string;
  onOpenNode: (nestId: string, nodeId: string) => void;
}) {
  const cited = message.cited ?? [];
  if (message.failed) {
    return (
      <div className="flex items-start gap-2 rounded-2xl rounded-tl-md border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message.content}</span>
      </div>
    );
  }
  return (
    <div>
      <div className="rounded-2xl rounded-tl-md border bg-background px-3.5 py-2.5 text-sm shadow-sm">
        {message.pending && !message.content ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground" aria-label={`${name} is thinking`}>
            <span className="flex gap-1">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
            <span className="text-xs">Reading the nest…</span>
          </span>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <HootieAnswerMarkdown
              content={message.content}
              cited={message.cited}
              nestId={nestId}
              onOpenNode={onOpenNode}
            />
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
              className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
              title={n.id}
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{n.title}</span>
            </button>
          ))}
        </div>
      )}
      {message.mention && (
        <MentionOutcome name={name} outcome={message.mention} nestId={nestId} onOpenNode={onOpenNode} />
      )}
    </div>
  );
}

function MentionOutcome({
  name,
  outcome,
  nestId,
  onOpenNode,
}: {
  name: string;
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
        ? `Couldn't tag anyone: there's no document to attach this to. Open one, or ask something ${name} can cite.`
        : "Couldn't post the comment — the mention wasn't delivered."}
    </p>
  );
}
