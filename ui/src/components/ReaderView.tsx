import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Menu } from "lucide-react";
import { FolderTree } from "./FolderTree";
import { DocumentViewer } from "./DocumentViewer";
import * as api from "../lib/api";
import { conventionKey, isHomeNode } from "@/lib/nest-caps";
import { extractHeadings } from "@/lib/toc";
import { breadcrumbFor, commonRootFolder, neighbours, readingOrder, resolveWikiTarget, sectionLabel, stripLeadingTitle, displayTitle, orderWithinFolder, ancestorsOf } from "@/lib/reader";
import { relTime } from "@/lib/dates";

/**
 * Public Docs Reader Mode — the read-only face of a nest.
 *
 * A docs site, not a dashboard: one page-scrolled article at reading width,
 * a folder nav on the left that stays put, an outline of the open page on
 * the right, previous/next at the end. There are no boxes — the nav and the
 * outline are set off from the article by a single hairline each, because
 * that rule is the only structure the page has to encode.
 *
 * What is specific to THIS reader: every page carries its governance under
 * the title — version, status, when it changed. A nest is versioned,
 * hash-chained context, and the reader shows that rather than hiding it.
 *
 * Navigation rules:
 *   - `[[wikilinks]]` resolve by path first, then title (see lib/reader).
 *     A dozen pages titled "Overview" is normal here; a title-first lookup
 *     would open the wrong one.
 *   - The open page is mirrored to `?doc=` by the shell so any page is a
 *     shareable link, and a `?doc=` deep link lands inside this layout.
 *   - NestView loads the whole nest up front (metadata only) so the nav shows
 *     every folder and the home page resolves wherever it lives.
 */

const HOME_NODE_CONVENTION = ["welcome", "index", "readme", "home", "overview"];

export interface ReaderViewProps {
  nestId: string;
  nestName: string;
  /** Flat document list (metadata: id, title, type, folder, status, version, updated_at). */
  nodes: any[];
  /** Folder → docs groups, from NestView's tocGroups. */
  tocGroups: { folder: string; items: any[] }[];
  /** Known folders (lazy tree), from NestView's knownFolders. */
  knownFolders: any[];
  /** Designated home/hub node id (nest.reader_home_node), or null. */
  readerHomeNode: string | null;
  /** Page to open first — a `?doc=` deep link. */
  initialDoc?: string | null;
  /** The open page changed; the shell mirrors it to the address bar. */
  onDocChange?: (nodeId: string | null) => void;
  onExpandFolder: (path: string) => void;
  loadingFolders?: Set<string>;
  loadedFolders?: Set<string>;
}

export function ReaderView({
  nestId,
  nestName,
  nodes,
  tocGroups,
  knownFolders,
  readerHomeNode,
  initialDoc,
  onDocChange,
  onExpandFolder,
  loadingFolders,
  loadedFolders,
}: ReaderViewProps) {
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

  const [selectedId, setSelectedIdState] = useState<string | null>(() => initialDoc ?? homeNode?.id ?? null);
  const setSelectedId = (id: string | null) => {
    setSelectedIdState(id);
    onDocChange?.(id);
    setNavOpen(false);
    setNotice(null);
  };
  useEffect(() => {
    if (!selectedId && homeNode) setSelectedIdState(homeNode.id);
  }, [homeNode, selectedId]);

  // Per-node markdown cache; an in-flight set so the two effects that can
  // both ask for the same node on first mount don't fetch it twice.
  const [content, setContent] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const loadNode = async (nodeId: string) => {
    if (content[nodeId] !== undefined || inFlight.current.has(nodeId)) return;
    inFlight.current.add(nodeId);
    setLoadingId(nodeId);
    try {
      const { node } = await api.getNode(nestId, nodeId);
      setContent((prev) => ({ ...prev, [nodeId]: node?.content ?? "" }));
    } catch {
      // Not cached: a transient failure must be retryable. The notice offers it.
      setNotice("This page could not be loaded.");
    } finally {
      inFlight.current.delete(nodeId);
      setLoadingId((cur) => (cur === nodeId ? null : cur));
    }
  };
  useEffect(() => {
    if (selectedId) void loadNode(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nestId]);

  // Folder rows: expanded once their docs are loaded, collapsed until then;
  // a click overrides either way and fetches on first open.
  const [folderOverrides, setFolderOverrides] = useState<Map<string, boolean>>(() => new Map());
  const isFolderCollapsed = (path: string) => folderOverrides.get(path) ?? !loadedFolders?.has(path);
  const toggleFolder = (path: string) => {
    const opening = isFolderCollapsed(path);
    setFolderOverrides((prev) => new Map(prev).set(path, !opening));
    if (opening) onExpandFolder(path);
  };
  // Open every ancestor of the current page in the nav — a deep link into
  // platform/plugins/google-drive should show Platform › Plugins expanded,
  // not a collapsed tree the reader has to dig through.
  useEffect(() => {
    if (!selectedId) return;
    const ancestors = ancestorsOf(selectedId);
    if (ancestors.length === 0) return;
    setFolderOverrides((prev) => {
      const next = new Map(prev);
      for (const a of ancestors) next.set(a, false);
      return next;
    });
    for (const a of ancestors) if (!loadedFolders?.has(a)) onExpandFolder(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const [notice, setNotice] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const openWikiLink = (target: string) => {
    const hit = resolveWikiTarget(target, nodes);
    if (hit) setSelectedId(hit.id);
    else setNotice(`No page called “${target}” in this nest.`);
  };

  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;
  const rawBody = selectedId ? content[selectedId] : undefined;
  const title = displayTitle(selectedNode, rawBody);
  const body = rawBody === undefined ? undefined : stripLeadingTitle(rawBody, title);
  const loading = !!selectedId && body === undefined && loadingId === selectedId;

  const outline = useMemo(() => (body ? extractHeadings(body).filter((h) => h.level > 1) : []), [body]);
  const order = useMemo(() => readingOrder(tocGroups), [tocGroups]);
  const { prev, next } = selectedId ? neighbours(order, selectedId) : { prev: null, next: null };
  const crumbs = selectedId ? breadcrumbFor(selectedId) : [];

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  // A nest whose every page lives under one folder ("docs/…") starts the nav
  // inside it — the extra level would only indent everything by one step.
  const rootFolder = useMemo(() => commonRootFolder(tocGroups, knownFolders), [tocGroups, knownFolders]);
  // Lead page first within each folder — the nav and prev/next agree.
  const orderedGroups = useMemo(() => tocGroups.map((g) => ({ ...g, items: orderWithinFolder(g.folder, g.items) })), [tocGroups]);
  const nav = (
    <FolderTree
      className="space-y-px"
      groups={orderedGroups}
      baseFolder={rootFolder || undefined}
      known={knownFolders}
      isCollapsed={isFolderCollapsed}
      renderFolder={(node, { collapsed }) => (
        <button
          type="button"
          onClick={() => toggleFolder(node.path)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-[13px] font-medium text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{sectionLabel(node.path)}</span>
          {loadingFolders?.has(node.path) && <span className="ml-auto text-[11px] text-muted-foreground">loading</span>}
        </button>
      )}
      renderDoc={(n) => {
        const current = selectedId === n.id;
        return (
          <button
            type="button"
            onClick={() => setSelectedId(n.id)}
            aria-current={current ? "page" : undefined}
            className={
              "block w-full border-l-2 py-1 pl-3 pr-2 text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-r-sm " +
              (current ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")
            }
            title={n.title || n.id}
          >
            {n.title || n.id}
          </button>
        );
      }}
    />
  );

  return (
    <div className="mx-auto w-full max-w-[88rem] lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_13rem] lg:gap-10">
      {/* Nav — a sticky column at desktop width, a disclosure above the article on a phone. */}
      <aside className="lg:sticky lg:top-6 lg:self-start lg:h-[calc(100vh-5rem)] lg:overflow-y-auto lg:border-r lg:pr-5 mb-6 lg:mb-0">
        <button
          type="button"
          onClick={() => setNavOpen((o) => !o)}
          aria-expanded={navOpen}
          className="lg:hidden inline-flex items-center gap-2 text-sm font-medium py-2"
        >
          <Menu className="h-4 w-4" />
          Contents
        </button>
        <div className={(navOpen ? "block" : "hidden") + " lg:block"}>
          {homeNode && (
            <button
              type="button"
              onClick={() => setSelectedId(homeNode.id)}
              aria-current={selectedId === homeNode.id ? "page" : undefined}
              className={
                "mb-3 block w-full truncate text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm " +
                (selectedId === homeNode.id ? "text-foreground" : "text-foreground/80 hover:text-foreground")
              }
            >
              {nestName}
            </button>
          )}
          {nav}
        </div>
      </aside>

      {/* Article — page-scrolled, reading width. */}
      <article className="min-w-0">
        {notice && (
          <p role="status" className="mb-4 text-sm text-amber-800 dark:text-amber-300">
            {notice}
            {selectedId && content[selectedId] === undefined && (
              <>
                {" "}
                <button type="button" className="underline underline-offset-2" onClick={() => { setNotice(null); void loadNode(selectedId); }}>
                  Try again
                </button>
              </>
            )}
          </p>
        )}
        {selectedNode && (
          <header className="mb-6">
            {crumbs.length > 0 && (
              <nav aria-label="Breadcrumb" className="mb-2 text-[13px] text-muted-foreground">
                {crumbs.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <span aria-hidden className="mx-1.5 text-muted-foreground/60">/</span>}
                    {c}
                  </span>
                ))}
              </nav>
            )}
            <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-tight text-foreground">{title}</h1>
            <Provenance node={selectedNode} />
          </header>
        )}
        {!selectedId && <p className="text-sm text-muted-foreground">Choose a page from the contents.</p>}
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {selectedId && body !== undefined && (
          <DocumentViewer
            content={body}
            onWikiLinkClick={openWikiLink}
            plainLinks
            className="max-w-[72ch] px-0 py-0 min-h-0 max-h-none overflow-visible prose-base prose-headings:scroll-mt-24 prose-h2:mt-10 prose-h2:text-xl prose-h3:text-base prose-p:leading-7 prose-pre:rounded-sm prose-code:before:content-none prose-code:after:content-none"
          />
        )}
        {(prev || next) && (
          <nav aria-label="Previous and next pages" className="mt-14 flex flex-wrap justify-between gap-4 border-t pt-6 text-sm">
            <div>
              {prev && (
                <button type="button" onClick={() => setSelectedId(prev.id)} className="group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm">
                  <span className="block text-[12px] text-muted-foreground">Previous</span>
                  <span className="text-foreground group-hover:underline">{prev.title || prev.id}</span>
                </button>
              )}
            </div>
            <div className="text-right">
              {next && (
                <button type="button" onClick={() => setSelectedId(next.id)} className="group text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm">
                  <span className="block text-[12px] text-muted-foreground">Next</span>
                  <span className="text-foreground group-hover:underline">{next.title || next.id}</span>
                </button>
              )}
            </div>
          </nav>
        )}
      </article>

      {/* Outline — headings of the open page; only rendered when there is more than one. */}
      <aside className="hidden lg:block lg:sticky lg:top-6 lg:self-start lg:h-[calc(100vh-5rem)] lg:overflow-y-auto lg:border-l lg:pl-5">
        {outline.length > 1 && (
          <nav aria-label="On this page">
            <p className="mb-2 text-[12px] font-medium text-muted-foreground">On this page</p>
            <ul className="space-y-1">
              {outline.map((h) => (
                <li key={h.id} className={h.level === 3 ? "pl-3" : ""}>
                  <button
                    type="button"
                    onClick={() => jumpTo(h.id)}
                    className="block w-full truncate text-left text-[13px] leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
                    title={h.text}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </aside>
    </div>
  );
}

/**
 * The governance line under a title. Status carries a small dot because the
 * reader is the one place a visitor sees that this page went through review;
 * version and recency are plain text.
 */
function Provenance({ node }: { node: any }) {
  // Default to draft, like every other status read in the codebase: a
  // governance line must never claim "Published" for a node that hasn't said so.
  const status = String(node.status || "draft");
  const updated = node.updated_at ? relTime(node.updated_at) : null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={"inline-block h-1.5 w-1.5 rounded-full " + (status === "published" ? "bg-emerald-500" : "bg-amber-500")} />
        {status === "published" ? "Published" : status.replace(/_/g, " ")}
      </span>
      {node.version != null && <span>Version {node.version}</span>}
      {updated && <span>Updated {updated}</span>}
    </p>
  );
}
