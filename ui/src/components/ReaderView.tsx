import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderOpen, BookOpen } from "lucide-react";
import { FolderTree } from "./FolderTree";
import { DocumentViewer } from "./DocumentViewer";
import * as api from "../lib/api";
import { conventionKey, isHomeNode } from "@/lib/nest-caps";

/**
 * Public Docs Reader Mode — a clean, read-only three-pane docs reader.
 *
 * Shown INSTEAD of the tabbed NestView for read-only callers when a nest has
 * reader mode on (owners/editors/reviewers/admins keep the full authoring UI).
 * There are NO write / edit / comment / review affordances here:
 *
 *   left   — a read-only FolderTree for navigation (reuses tocGroups /
 *            knownFolders from NestView)
 *   center — the DocumentViewer for the selected document
 *   right  — the persistent resolved home/overview node (always visible),
 *            or a synthesized Contents table when no home node resolves.
 */

const HOME_NODE_CONVENTION = ["welcome", "index", "readme", "home", "overview"];

export interface ReaderViewProps {
  nestId: string;
  nestName: string;
  /** Flat document list (metadata: id, title, type, folder). */
  nodes: any[];
  /** Folder → docs groups, from NestView's tocGroups. */
  tocGroups: { folder: string; items: any[] }[];
  /** Known folders (lazy tree), from NestView's knownFolders. */
  knownFolders: any[];
  /** Designated home/hub node id (nest.reader_home_node), or null. */
  readerHomeNode: string | null;
}

export function ReaderView({
  nestId,
  nestName,
  nodes,
  tocGroups,
  knownFolders,
  readerHomeNode,
}: ReaderViewProps) {
  // Resolve the home node: explicit designation wins; else first node whose
  // id-leaf or title matches the welcome|index|readme|home|overview convention;
  // else null → the right pane falls back to a synthesized Contents table.
  const homeNode = useMemo(() => {
    if (readerHomeNode) {
      const exact = nodes.find((n) => isHomeNode(n, readerHomeNode));
      if (exact) return exact;
    }
    for (const name of HOME_NODE_CONVENTION) {
      const hit = nodes.find((n) => conventionKey(n).includes(name));
      if (hit) return hit;
    }
    return null;
  }, [nodes, readerHomeNode]);

  const [selectedId, setSelectedId] = useState<string | null>(
    () => homeNode?.id ?? null,
  );
  useEffect(() => {
    // When the resolved home changes (data load) and nothing is selected yet,
    // open the home node in the center pane.
    if (!selectedId && homeNode) setSelectedId(homeNode.id);
  }, [homeNode, selectedId]);

  // Per-node markdown cache so re-selecting a doc doesn't refetch.
  const [content, setContent] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // In-flight guard, keyed by node id. The `content` check below reads a stale
  // closure across the two effects that both call loadNode in the same commit
  // (selectedId + homeNode.id are the same node on first mount), so without a
  // synchronous ref both would pass the cache check and fire duplicate fetches.
  const inFlight = useRef<Set<string>>(new Set());

  const loadNode = async (nodeId: string) => {
    if (content[nodeId] !== undefined || inFlight.current.has(nodeId)) return;
    inFlight.current.add(nodeId);
    setLoadingId(nodeId);
    try {
      const { node } = await api.getNode(nestId, nodeId);
      setContent((prev) => ({ ...prev, [nodeId]: node?.content ?? "" }));
    } catch {
      setContent((prev) => ({
        ...prev,
        [nodeId]: "_This document could not be loaded._",
      }));
    } finally {
      inFlight.current.delete(nodeId);
      setLoadingId((cur) => (cur === nodeId ? null : cur));
    }
  };

  useEffect(() => {
    if (selectedId) void loadNode(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nestId]);
  useEffect(() => {
    if (homeNode?.id) void loadNode(homeNode.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeNode?.id, nestId]);

  const selectByTitle = (title: string) => {
    const hit = nodes.find(
      (n) => String(n.title || "").toLowerCase() === title.toLowerCase(),
    );
    if (hit) setSelectedId(hit.id);
  };

  const selectedNode = selectedId
    ? nodes.find((n) => n.id === selectedId)
    : null;

  const centerBody = () => {
    if (!selectedId) {
      return (
        <p className="text-sm text-muted-foreground">
          Select a document from the list to start reading.
        </p>
      );
    }
    if (content[selectedId] === undefined && loadingId === selectedId) {
      return <p className="text-sm text-muted-foreground">Loading…</p>;
    }
    return (
      <DocumentViewer
        content={content[selectedId] ?? ""}
        onWikiLinkClick={selectByTitle}
      />
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(200px,260px)_1fr_minmax(240px,340px)] gap-4">
      {/* LEFT — read-only navigation */}
      <aside className="lg:sticky lg:top-4 self-start border rounded-lg p-3 bg-card min-w-0">
        <div className="flex items-center gap-2 mb-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{nestName}</span>
        </div>
        <FolderTree
          className="space-y-0.5"
          groups={tocGroups}
          known={knownFolders}
          renderFolder={(node) => (
            <div className="flex items-center gap-2 py-1 px-1 -mx-1">
              <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium truncate">{node.label}</span>
            </div>
          )}
          renderDoc={(n) => (
            <button
              type="button"
              onClick={() => setSelectedId(n.id)}
              className={`flex items-center gap-2 py-1 px-2 rounded-md w-full text-left min-w-0 hover:bg-muted/50 ${
                selectedId === n.id ? "bg-muted font-medium" : ""
              }`}
              title={n.title || n.id}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-sm truncate flex-1">
                {n.title || n.id}
              </span>
            </button>
          )}
        />
      </aside>

      {/* CENTER — selected document */}
      <section className="min-w-0 border rounded-lg p-5 bg-card">
        {selectedNode && (
          <h1 className="text-2xl font-bold mb-4">
            {selectedNode.title || selectedNode.id}
          </h1>
        )}
        {centerBody()}
      </section>

      {/* RIGHT — persistent home / overview (or Contents fallback) */}
      <aside className="lg:sticky lg:top-4 self-start min-w-0 border rounded-lg p-4 bg-muted/30">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {homeNode ? (homeNode.title || "Overview") : "Contents"}
        </div>
        {homeNode ? (
          content[homeNode.id] === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <DocumentViewer
              content={content[homeNode.id] ?? ""}
              onWikiLinkClick={selectByTitle}
            />
          )
        ) : (
          // No home node resolves → the synthesized Contents table of contents.
          <nav className="space-y-3">
            {tocGroups.map((g) => (
              <div key={g.folder}>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  {g.folder === "Root" ? "General" : g.folder}
                </div>
                <ul className="space-y-0.5">
                  {g.items.map((n: any) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(n.id)}
                        className="text-sm text-left hover:underline truncate w-full"
                        title={n.title || n.id}
                      >
                        {n.title || n.id}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        )}
      </aside>
    </div>
  );
}
