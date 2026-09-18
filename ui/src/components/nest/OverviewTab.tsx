/**
 * Overview tab — the nest's landing: stat tiles, recently edited, and the
 * folder index. Everything here derives from reads the nest page already
 * holds (census, the loaded folder levels), so it takes them as props; the
 * one loader is the nest's cold load.
 */
import { ChevronRight, Clock, FileText, FolderOpen, Loader2, Plus } from "lucide-react";
import type { KnownFolder } from "../FolderTree";
import { FolderTree, prettyFolderPath } from "../FolderTree";
import { timeAgo, typePill } from "./node-display";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  /** Cold load still in flight — the tiles show placeholders. */
  initialLoad: boolean;
  stats: { total: number };
  recentlyEdited: { id: string; title?: string; type?: string; updated_at?: string }[];
  recentlyEditedCount: number;
  folderCount: number;
  /** Folder → documents, from the loaded levels. */
  tocGroups: { folder: string; depth: number; items: any[] }[];
  knownFolders: KnownFolder[];
  isReadOnly: boolean;
  canEditDocs: boolean;
  onOpenDocument: (nodeId: string, opts?: { folder?: string }) => void;
  /** Jump to the Documents tab scoped to a folder. */
  onOpenFolder: (folder: string) => void;
}

export function OverviewTab({
  initialLoad,
  stats,
  recentlyEdited,
  recentlyEditedCount,
  folderCount,
  tocGroups,
  knownFolders,
  isReadOnly,
  canEditDocs,
  onOpenDocument,
  onOpenFolder,
}: Props) {
  return (
    <>
      {initialLoad ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Stat tiles — only the metrics NOT already in the top stat
              cards (Total Documents / AI Ready live there). This row adds
              folder + recency context, so nothing is repeated. */}
          <div className="grid gap-3 grid-cols-2">
            <Card className="border-muted/60">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-md bg-blue-500/10 text-blue-600 p-2">
                  <FolderOpen className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-2xl font-semibold leading-none">
                    {folderCount}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Folder{folderCount === 1 ? "" : "s"}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-muted/60">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-md bg-amber-500/10 text-amber-600 p-2">
                  <Clock className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-2xl font-semibold leading-none">
                    {recentlyEditedCount}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Edited this week
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recently edited */}
          {recentlyEdited.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Recently edited
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="divide-y">
                  {recentlyEdited.map((n) => (
                    <li key={n.id}>
                      <button
                        onClick={() => onOpenDocument(n.id)}
                        className="w-full flex items-center gap-3 py-2 px-1 -mx-1 rounded hover:bg-muted/50 text-left group"
                      >
                        <NodeTypeIcon type={n.type} />
                        <span className="text-sm truncate flex-1">
                          {n.title || n.id}
                        </span>
                        {(() => {
                          const p = typePill(n.type || "document");
                          return p ? (
                            <span
                              className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${p.cls}`}
                              title={p.title}
                            >
                              {p.label}
                            </span>
                          ) : null;
                        })()}
                        {n.updated_at && (
                          <span className="text-xs text-muted-foreground shrink-0">
                            {timeAgo(n.updated_at)}
                          </span>
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Grouped table of contents */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                Contents
              </CardTitle>
              <CardDescription>
                Browse documents grouped by folder.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Empty folders still deserve the tree (CU-wdqcq0247y) —
                  only a nest with neither docs nor folders is empty. */}
              {stats.total === 0 && knownFolders.length === 0 ? (
                <div className="py-8 text-center">
                  <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No documents yet.
                  </p>
                  {/* The header's New Document button is right there, so
                      offer the action itself rather than directions to it.
                      Read-only callers get the bare line. */}
                  {!isReadOnly && canEditDocs && (
                    <Button
                      className="mt-3"
                      size="sm"
                      onClick={() => onOpenDocument("new")}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      New Document
                    </Button>
                  )}
                </div>
              ) : (
                <FolderTree
                  className="space-y-1"
                  groups={tocGroups}
                  known={knownFolders}
                  renderFolder={(node) => (
                    // Overview folders navigate into the Documents tab scoped to
                    // that folder — no collapse here; the whole tree stays open.
                    <button
                      type="button"
                      onClick={() => onOpenFolder(node.path)}
                      className="flex items-center gap-2 py-1 group/folder rounded px-1 -mx-1 hover:bg-muted/60 w-full text-left"
                      title={`Browse ${prettyFolderPath(node.path)} in Documents`}
                    >
                      <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium group-hover/folder:underline">
                        {node.label}
                      </span>
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 h-5"
                      >
                        {node.total}
                      </Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover/folder:text-muted-foreground" />
                      {canEditDocs && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/folder:opacity-100 hover:text-primary hover:bg-primary/10"
                          title={`New document in ${prettyFolderPath(node.path)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenDocument("new", { folder: node.path });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.stopPropagation();
                              onOpenDocument("new", { folder: node.path });
                            }
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </button>
                  )}
                  renderDoc={(n) => (
                    <button
                      onClick={() => onOpenDocument(n.id)}
                      className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 text-left group min-w-0 w-full"
                      title={n.title || n.id}
                    >
                      <NodeTypeIcon type={n.type} className="h-3.5 w-3.5" />
                      <span className="text-sm truncate flex-1">
                        {n.title || n.id}
                      </span>
                      {(() => {
                        const p = typePill(n.type || "document");
                        return p ? (
                          <span
                            className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${p.cls}`}
                            title={p.title}
                          >
                            {p.label}
                          </span>
                        ) : null;
                      })()}
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                    </button>
                  )}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
