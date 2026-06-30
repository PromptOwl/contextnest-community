/**
 * DocumentPickerModal — pick a document inside a nest to link to from
 * the markdown editor. Lists existing nodes, supports search via the
 * server's full-text endpoint, and short-circuits to a client-side
 * filter on the already-loaded list when no query is entered.
 *
 * On select: returns `{id, title}` to the caller. Caller is responsible
 * for inserting the link into the editor.
 */
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText, Loader2, Search } from "lucide-react";

interface DocumentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  /** ID of the document the user is currently editing, so we can hide
   *  it from the list (linking to yourself is pointless). */
  excludeNodeId?: string;
  onSelect: (node: { id: string; title: string }) => void;
}

interface PickerNode {
  id: string;
  title: string;
  tags?: string[];
}

export function DocumentPickerModal({
  isOpen,
  onClose,
  nestId,
  excludeNodeId,
  onSelect,
}: DocumentPickerModalProps) {
  // Full list preloaded on open — never overwritten by search, so it can
  // be restored when the query is cleared.
  const [nodes, setNodes] = useState<PickerNode[]>([]);
  // Server FTS results for the current query (null = no active search).
  const [searchResults, setSearchResults] = useState<PickerNode[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always preload the full list on open so users see something
  // immediately. Search refines via server FTS once they type.
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSearchResults(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { nodes: list } = await api.listNodes(nestId);
        if (!cancelled) setNodes(list as PickerNode[]);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, nestId]);

  // Debounced server search on query. When cleared, drop the search
  // results so the preloaded full list shows again.
  useEffect(() => {
    if (!isOpen) return;
    if (!query.trim()) {
      setSearchResults(null); // restore full list
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const { nodes: list } = await api.searchNodes(nestId, query.trim());
        if (!cancelled) setSearchResults(list as PickerNode[]);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isOpen, nestId, query]);

  // Display source: server search results when a query is active, else the
  // preloaded full list. Client-side title filter covers tiny queries that
  // arrive before the debounce fires.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = q && searchResults !== null ? searchResults : nodes;
    return source.filter((n) => {
      if (n.id === excludeNodeId) return false;
      if (!q) return true;
      return n.title.toLowerCase().includes(q);
    });
  }, [nodes, searchResults, query, excludeNodeId]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Link to a document</DialogTitle>
          <DialogDescription>
            Pick a document in this nest. The link will use this title and
            point at the document — clicking it inside the editor opens the
            target.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title..."
            className="pl-8"
            autoFocus
            data-testid="document-picker-search"
          />
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {error && (
            <div className="text-sm text-destructive p-2">{error}</div>
          )}

          {loading && nodes.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading documents...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-10">
              {query.trim()
                ? "No matches"
                : "No other documents in this nest yet"}
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    onSelect({ id: n.id, title: n.title });
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 p-2 rounded hover:bg-muted text-left"
                  data-testid={`document-picker-row-${n.id}`}
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{n.title}</div>
                    {n.tags && n.tags.length > 0 && (
                      <div className="text-xs text-muted-foreground truncate">
                        {n.tags.slice(0, 4).join(" · ")}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default DocumentPickerModal;
