/**
 * LiveSearchResults — the "enterprise search" half of a nest search. When a
 * nest has plugins with a search() face enabled, the same query fans out to
 * them and the hits come back here, in their own section, marked as not
 * governed. Promote lands a hit in the nest through the normal review path;
 * until then it is a pointer, not context.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import type { LiveSearchSource } from "../lib/api";

interface Props {
  nestId: string;
  sources: LiveSearchSource[];
  errors?: Array<{ plugin: string; error: string }>;
  canPromote: boolean;
  onPromoted?: (nodeId: string) => void;
}

export function LiveSearchResults({ nestId, sources, errors = [], canPromote, onPromoted }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const total = sources.reduce((n, s) => n + s.hits.length, 0);
  if (total === 0 && errors.length === 0) return null;

  const promote = async (plugin: string, externalId: string) => {
    const key = `${plugin}:${externalId}`;
    setBusy(key);
    try {
      const { result } = await api.promoteLiveHit(nestId, plugin, externalId);
      if (result.outcome === "conflict") toast.warning("Already in the nest with local edits — not overwritten");
      else toast.success(result.outcome === "created" ? "Added to the nest — pending review where stewardship is on" : "Nest copy updated");
      onPromoted?.(result.id);
    } catch (e: any) {
      toast.error(e?.message || "Could not promote");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t pt-3 mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">Live sources</span>
        <Badge variant="outline" className="text-[10px] font-normal">not governed</Badge>
        <span className="text-xs text-muted-foreground">{total} result{total === 1 ? "" : "s"} · promote one to bring it into the nest</span>
      </div>
      {sources.map((src) =>
        src.hits.length === 0 ? null : (
          <div key={src.plugin} className="mb-2">
            <div className="text-xs text-muted-foreground mb-1">{src.displayName}</div>
            <ul className="divide-y">
              {src.hits.map((h) => {
                const key = `${src.plugin}:${h.externalId}`;
                return (
                  <li key={key} className="flex items-start gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{h.title}</div>
                      {h.snippet && <div className="text-xs text-muted-foreground line-clamp-2">{h.snippet}</div>}
                      {h.occurredAt && <div className="text-[11px] text-muted-foreground">{new Date(h.occurredAt).toLocaleString()}</div>}
                    </div>
                    {h.url && (
                      <a href={h.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Open in source">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    {canPromote && (
                      <Button variant="outline" size="sm" className="h-7" disabled={busy === key} onClick={() => promote(src.plugin, h.externalId)}>
                        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        <span className="ml-1">Promote</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ),
      )}
      {errors.map((e) => (
        <div key={e.plugin} className="text-xs text-destructive">{e.plugin}: {e.error}</div>
      ))}
    </div>
  );
}
