/**
 * QuickOpen — Cmd/Ctrl+K palette. Searches the current nest's documents by
 * title, tags, AND content (server full-text endpoint, debounced) and jumps
 * straight to the picked doc. Keyboard: ↑/↓ to move, Enter to open, Esc to
 * close.
 */
import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Search } from "lucide-react";
import * as api from "../lib/api";

interface QuickOpenProps {
  nestId: string;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}

export function QuickOpen({ nestId, onSelect, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; title: string; tags?: string[] }>>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Empty query → recent list (server returns all readable docs); otherwise
  // debounced full-text search (title + tags + content).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const data = query.trim()
          ? await api.searchNodes(nestId, query.trim())
          : await api.listNodes(nestId);
        setResults((data.nodes as any[]).slice(0, 8));
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
  }, [nestId, query]);

  const pick = (i: number) => {
    const r = results[i];
    if (r) onSelect(r.id);
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
            placeholder="Search documents — title, tags, content…"
            className="flex-1 bg-transparent py-3 text-sm outline-none"
            data-testid="quick-open-input"
          />
          <kbd className="text-[10px] text-muted-foreground border rounded px-1">esc</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {searching ? "Searching…" : "No matches"}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  i === selected ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(i)}
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate font-medium">{r.title}</span>
                {r.tags && r.tags.length > 0 && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {r.tags.slice(0, 3).join(" ")}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
