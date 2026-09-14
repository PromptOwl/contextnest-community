import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  FolderOpen,
  BookOpen,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
} from "lucide-react";
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
 *            knownFolders from NestView). Docs are loaded lazily one folder
 *            level at a time, same as the Documents tab: clicking a folder
 *            row fetches its documents via onExpandFolder. Folders default
 *            open but can be collapsed back (and re-expanded) via the same
 *            row click, so a folder with many docs doesn't permanently eat
 *            the pane's height once opened.
 *   center — the DocumentViewer for the selected document. Shows a "Back to
 *            Overview" link whenever the reader has navigated away from the
 *            home node, so there's always a way back to it.
 *   right  — the persistent resolved home/overview node, shown whenever the
 *            reader is looking at something OTHER than the home node itself
 *            (otherwise it would just duplicate the center pane); falls back
 *            to a synthesized Contents table when no home node resolves, or
 *            when the home node IS the selected/center document.
 *
 * All three panes share PANE_BODY_CLASS (min/max-h-[60vh] + overflow-y-auto,
 * matching DocumentViewer's own sizing) so they line up at the same height
 * regardless of content, and scroll internally instead of growing the page.
 */

const HOME_NODE_CONVENTION = ["welcome", "index", "readme", "home", "overview"];
const PANE_BODY_CLASS = "min-h-[60vh] max-h-[60vh] overflow-y-auto";

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
  /** Fetch a folder's documents on demand (mirrors the Documents tab's lazy
   *  per-level loading — NestView owns the actual fetch + `nodes` merge). */
  onExpandFolder: (path: string) => void;
  /** Folder paths currently being fetched, for a lightweight row indicator. */
  loadingFolders?: Set<string>;
}

export function ReaderView({
  nestId,
  nestName,
  nodes,
  tocGroups,
  knownFolders,
  readerHomeNode,
  onExpandFolder,
  loadingFolders,
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

  // Folders default to expanded (matching the prior always-expanded tree) but
  // can be collapsed back after opening, so reading through a large folder
  // doesn't permanently consume the pane's height. Collapsing is purely a
  // display toggle; expanding re-fetches via onExpandFolder, which NestView
  // already treats as a no-op once a level is loaded.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleFolder = (path: string) => {
    const opening = collapsedFolders.has(path);
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (opening) next.delete(path);
      else next.add(path);
      return next;
    });
    if (opening) onExpandFolder(path);
  };

  const selectByTitle = (title: string) => {
    const hit = nodes.find(
      (n) => String(n.title || "").toLowerCase() === title.toLowerCase(),
    );
    if (hit) setSelectedId(hit.id);
  };

  const selectedNode = selectedId
    ? nodes.find((n) => n.id === selectedId)
    : null;

  // The home/overview pane duplicates the center pane when the reader is
  // already looking at the home node itself — fall back to Contents then.
  const showHomeContent = !!homeNode && selectedId !== homeNode.id;

  const centerBody = () => {
    if (!selectedId) {
      return (
        <div className={`${PANE_BODY_CLASS} flex items-center`}>
          <p className="text-sm text-muted-foreground">
            Select a document from the list to start reading.
          </p>
        </div>
      );
    }
    if (content[selectedId] === undefined && loadingId === selectedId) {
      return (
        <div className={PANE_BODY_CLASS}>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      );
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
        <div className={PANE_BODY_CLASS}>
          <FolderTree
            className="space-y-0.5"
            groups={tocGroups}
            known={knownFolders}
            isCollapsed={(path) => collapsedFolders.has(path)}
            renderFolder={(node, { collapsed }) => (
              <button
                type="button"
                onClick={() => toggleFolder(node.path)}
                className="flex items-center gap-2 py-1 px-1 -mx-1 w-full text-left rounded-md hover:bg-muted/50"
              >
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate flex-1">
                  {node.label}
                </span>
                {loadingFolders?.has(node.path) && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    Loading…
                  </span>
                )}
              </button>
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
        </div>
      </aside>

      {/* CENTER — selected document */}
      <section className="min-w-0 border rounded-lg p-5 bg-card">
        {homeNode && selectedId !== homeNode.id && (
          <button
            type="button"
            onClick={() => setSelectedId(homeNode.id)}
            className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Overview
          </button>
        )}
        {selectedNode && (
          <h1 className="text-2xl font-bold mb-4">
            {selectedNode.title || selectedNode.id}
          </h1>
        )}
        {centerBody()}
      </section>

      {/* RIGHT — persistent home / overview (or Contents fallback). Only
          shown when it wouldn't just duplicate the center pane — i.e. the
          reader is looking at something other than the home node itself. */}
      <aside className="lg:sticky lg:top-4 self-start min-w-0 border rounded-lg p-4 bg-muted/30">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {showHomeContent ? (homeNode!.title || "Overview") : "Contents"}
        </div>
        {showHomeContent ? (
          content[homeNode!.id] === undefined ? (
            <div className={PANE_BODY_CLASS}>
              <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
          ) : (
            <DocumentViewer
              content={content[homeNode!.id] ?? ""}
              onWikiLinkClick={selectByTitle}
            />
          )
        ) : (
          // No home node resolves, or it's already the center document →
          // the synthesized Contents table of contents.
          <nav className={`space-y-3 ${PANE_BODY_CLASS}`}>
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
