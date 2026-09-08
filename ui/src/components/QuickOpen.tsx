/**
 * QuickOpen — Cmd/Ctrl+K palette. Searches documents by title, tags, AND
 * content (server full-text endpoint, debounced) and jumps straight to the
 * picked doc. Keyboard: ↑/↓ to move, Enter to open, Esc to close.
 *
 * Two modes: given a `nestId` it searches that nest (and lists its documents
 * on an empty query); without one it searches every nest the caller can see
 * and each row names the nest it came from.
 *
 * The mode is stated in the header and switchable from inside a nest
 * (CU-wdqcq0042v) — the same palette silently changing scope with the page
 * made "No matches" read as "that document does not exist".
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Database, FileText, Loader2, Search } from "lucide-react";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { matchNests } from "../lib/nest-search";

/**
 * Document rows the palette lists, and the page size it asks the server for.
 *
 * 20 is the server's default page size for `/search` (its ceiling is 50) — a
 * deliberate stop short of that, not the most a request could carry. Eight rows
 * used to hide the rest with no way to reach it; 20 scrolls comfortably, and
 * since results are ranked title-first, rows past that are progressively weaker
 * matches. A broad query is answered by typing more, not by paging further —
 * which is what the "Showing X of Y" line below the list says out loud.
 */
const DOC_ROWS = 20;

export interface QuickOpenResult {
  /** "nest" rows open the nest itself; "node" rows open a document. */
  kind: "nest" | "node";
  id: string;
  title: string;
  tags?: string[];
  nest_id?: string;
  nest_name?: string;
  /** Nest rows only — the nest's own description, shown as the subtitle. */
  description?: string | null;
  /** Document rows from a search — body text around the match. */
  snippet?: string;
}

/** Split a snippet on the query terms so the matching text can be marked.
 *  Terms are escaped — a query is user text, not a regex. */
function highlight(text: string, query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return text;
  const re = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  const lower = terms.map((t) => t.toLowerCase());
  return text
    .split(re)
    .map((part, i) =>
      part && lower.includes(part.toLowerCase()) ? (
        <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/60 rounded-sm px-0.5">
          {part}
        </mark>
      ) : (
        part
      ),
    );
}

function ScopeTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`max-w-[16rem] truncate rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "bg-muted font-medium text-foreground"
          : "hover:bg-muted/60"
      }`}
    >
      {label}
    </button>
  );
}

interface QuickOpenProps {
  /** Omit to search across every nest the caller can see. */
  nestId?: string;
  /** Names the current nest on its rows, so a pick from either scope carries
   *  the nest it belongs to. */
  nestName?: string;
  onSelect: (id: string, result: QuickOpenResult) => void;
  onClose: () => void;
}

export function QuickOpen({ nestId, nestName, onSelect, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  // Inside a nest the palette starts scoped to it and can widen; on the
  // dashboard there is nothing to scope to, so it is always all-nests.
  const [allNests, setAllNests] = useState(false);
  const [results, setResults] = useState<QuickOpenResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  /** Everything the server matched, so the list can admit what it is hiding —
   *  it shows the top few, and silently truncating reads as "no more matches". */
  const [totalDocs, setTotalDocs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();
  const global = !nestId || allNests;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Empty query → the current nest's documents (there is no equivalent for
  // "every nest", so global mode simply waits for a term); otherwise debounced
  // full-text search (title + tags + content).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const q = query.trim();
      if (global && !q) {
        setResults([]);
        setTotalDocs(0);
        return;
      }
      setSearching(true);
      try {
        if (global) {
          // Nests first: someone searching from the dashboard is often after
          // the vault, not a document inside it. Names come from the cached
          // list — matching them client-side beats a second round-trip.
          const [nests, docs] = await Promise.all([
            qc
              .fetchQuery(reads.nestList())
              .then((d: any) =>
                matchNests(d?.nests ?? [], q).map(
                  (n): QuickOpenResult => ({ ...n, kind: "nest" }),
                ),
              )
              .catch((): QuickOpenResult[] => []),
            // Cached per exact query: the cross-nest search fans out over
            // every visible nest, so retyping a term — or reopening the
            // palette on one — should not pay for that walk again. A write to
            // any document drops the whole search family (see queries.ts).
            qc
              .fetchQuery(reads.globalSearch(q, DOC_ROWS))
              .then((d) => {
                setTotalDocs(d.count);
                return d.nodes.map(
                  (n): QuickOpenResult => ({ ...n, kind: "node" }),
                );
              })
              .catch(() => {
                setTotalDocs(0);
                return [];
              }),
          ]);
          setResults([...nests.slice(0, 4), ...docs.slice(0, DOC_ROWS)]);
        } else {
          const data = q
            ? await api.searchNodes(nestId!, q)
            : await qc.fetchQuery(reads.nodes(nestId!));
          setTotalDocs(data.nodes.length);
          setResults(
            (data.nodes as QuickOpenResult[]).slice(0, DOC_ROWS).map((n) => ({
              ...n,
              kind: "node" as const,
              // Stamp the nest so a picked row carries it either way — the
              // caller opens both scopes through one handler.
              nest_id: n.nest_id ?? nestId,
              nest_name: n.nest_name ?? nestName,
            })),
          );
        }
        setSelected(0);
      } catch {
        setResults([]);
        setTotalDocs(0);
      } finally {
        setSearching(false);
      }
    }, query.trim() ? 250 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [nestId, nestName, global, query, qc]);

  const pick = (i: number) => {
    const r = results[i];
    if (r) onSelect(r.id, r);
  };

  const shownDocs = results.filter((r) => r.kind === "node").length;

  /**
   * What an empty list means here, which is rarely "no matches" (CU-wdqcq01e6x).
   * The global scope searches nothing until a term is typed, so it invites one.
   * The nest scope has ALREADY listed the nest's documents on an empty query,
   * so an empty list there is an empty nest, not a search waiting to happen.
   */
  const emptyState = () => {
    if (searching) return "Searching…";
    if (!query.trim()) {
      if (global) return "Type to search nests and documents…";
      return "This nest has no documents yet.";
    }
    // A scoped miss is not "it doesn't exist" — name the nest that was searched
    // and offer the wider one right here, where the dead end is (CU-wdqcq012ut).
    if (!global) {
      return (
        <>
          No matches in {nestName ?? "this nest"}.{" "}
          <button
            type="button"
            onClick={() => setAllNests(true)}
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            data-testid="quick-open-widen-scope"
          >
            Search all nests
          </button>
        </>
      );
    }
    return "No matches";
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border bg-background shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        // Esc closes from anywhere in the palette, not only from the input —
        // focus may be sitting on a scope tab.
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="flex items-center gap-2 border-b px-3">
          {searching ? (
            <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              // Tab flips the scope instead of leaving the field: the palette
              // is keyboard-first and has one input, so there is nothing else
              // worth tabbing to, and reaching for the mouse to widen a search
              // broke the flow (CU-wdqcq012uu). The tabs stay focusable too.
              // Either direction: the input is the palette's first focusable
              // element, so letting Shift+Tab through moved focus to the page
              // behind an open modal.
              if (e.key === "Tab" && nestId) {
                e.preventDefault();
                setAllNests((v) => !v);
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                pick(selected);
              }
            }}
            placeholder={
              global
                ? "Search nests and documents…"
                : "Search documents — title, tags, content…"
            }
            className="flex-1 bg-transparent py-3 text-sm outline-none"
            data-testid="quick-open-input"
          />
          <kbd className="text-[10px] text-muted-foreground border rounded px-1">esc</kbd>
        </div>
        {/* Scope is stated, not inferred from where the palette was opened. */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span>Searching</span>
          {nestId ? (
            <div className="flex items-center gap-1">
              <ScopeTab
                active={!allNests}
                onClick={() => setAllNests(false)}
                label={nestName ? `This nest — ${nestName}` : "This nest"}
              />
              <ScopeTab
                active={allNests}
                onClick={() => setAllNests(true)}
                label="All nests"
              />
              <kbd className="rounded border px-1 text-[10px]">tab</kbd>
            </div>
          ) : (
            <span className="font-medium text-foreground">all nests</span>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {emptyState()}
            </div>
          ) : (
            results.map((r, i) => (
              <Fragment key={`${r.kind}:${r.nest_id ?? ""}${r.id}`}>
                {/* Results arrive nests-first, so a header before each run
                    labels the two kinds without reordering or re-indexing
                    anything the keyboard selection depends on. */}
                {r.kind !== results[i - 1]?.kind && (
                  <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {r.kind === "nest" ? "Nests" : "Documents"}
                  </div>
                )}
              <button
                type="button"
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${
                  i === selected ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(i)}
              >
                {r.kind === "nest" ? (
                  <Database className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.title}</span>
                    {/* Right-hand column says where the row goes: a nest row
                        opens the nest, a document row names the nest it lives
                        in (the same title can exist in several). */}
                    {r.kind === "nest" ? (
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">
                        Nest
                      </span>
                    ) : global && r.nest_name ? (
                      <span className="ml-auto truncate text-xs text-muted-foreground shrink-0">
                        {r.nest_name}
                      </span>
                    ) : (
                      r.tags &&
                      r.tags.length > 0 && (
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {r.tags.slice(0, 3).join(" ")}
                        </span>
                      )
                    )}
                  </div>
                  {/* Why this row matched: body text around the hit. Only for
                      searched document rows — an empty query has nothing to
                      highlight, and nest rows carry their own description. */}
                  {r.kind === "node" && r.snippet && query.trim() && (
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {highlight(r.snippet, query)}
                    </div>
                  )}
                </div>
              </button>
              </Fragment>
            ))
          )}
        </div>
        {/* Say when the list is a page, not the answer — best matches lead, so
            the rest are narrowed away by typing more, not by scrolling. */}
        {shownDocs > 0 && totalDocs > shownDocs && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            Showing {shownDocs} of {totalDocs} matching documents — keep typing
            to narrow.
          </div>
        )}
      </div>
    </div>
  );
}
