/**
 * QuickOpen — Cmd/Ctrl+K palette. Searches documents by title, tags, AND
 * content (server full-text endpoint, debounced) and jumps straight to the
 * picked doc. Keyboard: ↑/↓ to move, Enter to open, Esc to close.
 *
 * Two modes: given a `nestId` it searches that nest (and lists its documents
 * on an empty query); without one it searches every nest the caller can see
 * and each row names the nest it came from.
 */
import { useEffect, useRef, useState } from "react";
import { Database, FileText, Loader2, Search } from "lucide-react";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { matchNests } from "../lib/nest-search";

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
}

interface QuickOpenProps {
  /** Omit to search across every nest the caller can see. */
  nestId?: string;
  onSelect: (id: string, result: QuickOpenResult) => void;
  onClose: () => void;
}

export function QuickOpen({ nestId, onSelect, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickOpenResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();
  const global = !nestId;

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
            // Search stays uncached — results must reflect the query exactly.
            api
              .searchAllNests(q)
              .then((d) =>
                d.nodes.map((n): QuickOpenResult => ({ ...n, kind: "node" })),
              )
              .catch(() => []),
          ]);
          setResults([...nests.slice(0, 4), ...docs.slice(0, 8)]);
        } else {
          const data = q
            ? await api.searchNodes(nestId!, q)
            : await qc.fetchQuery(reads.nodes(nestId!));
          setResults(
            (data.nodes as QuickOpenResult[])
              .slice(0, 8)
              .map((n) => ({ ...n, kind: "node" as const })),
          );
        }
        setSelected(0);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, query.trim() ? 250 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [nestId, global, query, qc]);

  const pick = (i: number) => {
    const r = results[i];
    if (r) onSelect(r.id, r);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border bg-background shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
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
        <div className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {searching
                ? "Searching…"
                : global && !query.trim()
                  ? "Type to search nests and documents"
                  : "No matches"}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.kind}:${r.nest_id ?? ""}${r.id}`}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  i === selected ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(i)}
              >
                {r.kind === "nest" ? (
                  <Database className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="truncate font-medium">{r.title}</span>
                {/* Right-hand column says where the row goes: a nest row opens
                    the nest, a document row names the nest it lives in (the
                    same title can exist in several). */}
                {r.kind === "nest" ? (
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">
                    Nest
                  </span>
                ) : r.nest_name ? (
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
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
