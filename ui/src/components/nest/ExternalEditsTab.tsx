/**
 * External Edits tab — files edited on disk, awaiting approval. Owns its
 * read (reads.externalEdits) and its loader, so the nest page paints the
 * other tabs while the on-disk scan is still running. NestView uses the
 * same cached read for the tab badge through useExternalEdits().
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, FileWarning, Loader2, RefreshCw } from "lucide-react";
import * as api from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import { formatServerDate } from "../../lib/dates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The list, shared by the tab and its badge (one cache key, one fetch). */
export function useExternalEdits(nestId: string, enabled = true) {
  return useQuery({ ...reads.externalEdits(nestId), enabled });
}

interface Props {
  nestId: string;
  /** False on a grant-only nest, where the read is not offered. */
  enabled: boolean;
  onOpenDocument: (nodeId: string) => void;
  /** Human title for a document id — falls back to the bare file name. */
  titleOf: (nodeId: string) => string | undefined;
}

export function ExternalEditsTab({ nestId, enabled, onOpenDocument, titleOf }: Props) {
  const qc = useQueryClient();
  const edits = useExternalEdits(nestId, enabled);
  const entries = edits.data?.entries ?? [];
  // Refresh = rescan the disk, then re-read. The scan can be slow; only this
  // tab waits on it.
  const [scanning, setScanning] = useState(false);
  const refresh = async () => {
    setScanning(true);
    try {
      await api.scanExternalEdits(nestId).catch((e) => {
        console.error("[ExternalEditsTab] scanExternalEdits failed", nestId, e);
        return null;
      });
      await qc.invalidateQueries({ queryKey: keys.externalEdits(nestId) });
    } finally {
      setScanning(false);
    }
  };
  const busy = scanning || edits.isFetching;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileWarning className="h-4 w-4 text-orange-600" />
              External Edits
            </CardTitle>
            <CardDescription>
              Files edited directly on disk, awaiting your approval.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            disabled={busy}
            className="h-8 w-8"
            data-testid="external-edits-refresh"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {edits.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mb-3" />
            <p className="text-sm font-medium">No pending external edits</p>
            <p className="text-xs text-muted-foreground">
              All files on disk match their last approved state.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => {
              // Resolve the human-readable title; fall back to the bare doc
              // name so internal `nodes/` paths never leak to the UI.
              const docTitle = titleOf(entry.document_id) || entry.document_id.split("/").pop();
              return (
                <div
                  key={entry.suggestion_id}
                  className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => onOpenDocument(entry.document_id)}
                  data-testid={`external-edit-row-${entry.suggestion_id}`}
                >
                  <FileWarning className="h-5 w-5 text-orange-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{docTitle}</span>
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 bg-orange-100 text-orange-700"
                      >
                        {entry.source}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <Clock className="h-3 w-3" />
                      <span>{formatServerDate(entry.detected_at)}</span>
                      <span>•</span>
                      <span>by {entry.actor}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
