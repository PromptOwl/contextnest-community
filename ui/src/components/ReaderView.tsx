import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, ChevronDown, ChevronLeft, Menu, BookOpen, Folder, FolderOpen, Search, X } from "lucide-react";
import { NodeTypeGlyph } from "./nest/NodeTypeIcon";
import { FolderTree } from "./FolderTree";
import { DocumentViewer } from "./DocumentViewer";
import { PdfDocumentPanel } from "./PdfDocumentPanel";
import * as api from "../lib/api";
import { conventionKey, pickHomeNode } from "@/lib/nest-caps";
import { extractHeadings } from "@/lib/toc";
import { folderCollapsed } from "@/lib/nest-overview";
import { breadcrumbFor, commonRootFolder, neighbours, readingOrder, resolveWikiTarget, sectionLabel, stripLeadingTitle, displayTitle, orderWithinFolder, ancestorsOf, READER_SIDE_COLUMN_CLASS, READER_CARD_CLASS, searchNodes } from "@/lib/reader";
import { relTime } from "@/lib/dates";
import { brandingToCssVars, brandedDocumentTitle, cssUrl, isBranded, type NestBranding } from "@/lib/branding";

/**
 * Public Docs Reader Mode — the read-only face of a nest.
 *
 * A docs site, not a dashboard: one article at reading width, a folder nav
 * on the left that stays put, an outline of the open page on the right,
 * previous/next at the end. Three cards on the app's usual card surface —
 * the same frame the rest of the nest UI uses — so the reader reads as part
 * of the product rather than a bare page.
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
  /** Serve approved bodies only — an owner previewing what a visitor gets. */
  approvedOnly?: boolean;
  /** Per-nest branding (nest.branding). Null/absent → the reader renders exactly as unbranded. */
  branding?: NestBranding | null;
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
  approvedOnly = false,
  branding = null,
}: ReaderViewProps) {
  const branded = isBranded(branding);
  const homeNode = useMemo(() => {
    const designated = pickHomeNode(nodes, readerHomeNode);
    if (designated) return designated;
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
  // The shell can move the reader too (header brand → home), so follow `?doc=`.
  useEffect(() => {
    setSelectedIdState(initialDoc ?? homeNode?.id ?? null);
  }, [initialDoc]);

  // Per-node markdown cache; an in-flight set so the two effects that can
  // both ask for the same node on first mount don't fetch it twice.
  const [content, setContent] = useState<Record<string, string>>({});
  // pdf nodes: their `pdf:` block, so the page shows the PDF above its text.
  const [pdfMetas, setPdfMetas] = useState<Record<string, api.PdfMeta>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const loadNode = async (nodeId: string) => {
    if (content[nodeId] !== undefined || inFlight.current.has(nodeId)) return;
    inFlight.current.add(nodeId);
    setLoadingId(nodeId);
    try {
      const { node } = await api.getNode(nestId, nodeId, approvedOnly);
      setContent((prev) => ({ ...prev, [nodeId]: node?.content ?? "" }));
      if (node?.type === "pdf" && node?.pdf) {
        setPdfMetas((prev) => ({ ...prev, [nodeId]: node.pdf as api.PdfMeta }));
      }
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

  // Folder rows: collapsed until opened (the page's own ancestors open below);
  // a click overrides either way and fetches on first open.
  const [folderOverrides, setFolderOverrides] = useState<Map<string, boolean>>(() => new Map());
  const isFolderCollapsed = (path: string) => folderCollapsed(path, folderOverrides);
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
  // Nav search: title or tag. While a query is typed the tree gives way to a
  // flat list of hits with their folder, so a page is one keystroke away.
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchNodes(nodes, query), [nodes, query]);

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

  // Same outline the editor shows: every heading, indented by level.
  const outline = useMemo(() => (body ? extractHeadings(body) : []), [body]);
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
          {collapsed ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
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
              "flex w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 " +
              (current ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
            }
            title={n.title || n.id}
          >
            <NodeTypeGlyph type={n.type} className="h-3.5 w-3.5" />
            <span className="truncate">{n.title || n.id}</span>
          </button>
        );
      }}
    />
  );

  const grid = (
    // Desktop: the three cards fill the viewport below the shell header
    // (4rem + 1px border, 1rem main padding each side, 3rem footer) and
    // scroll on their own — the page itself never scrolls. --reader-offset
    // lets a wrapper (the preview banner) claim part of that height, and
    // --reader-banner the branded banner (unset — 0 — when unbranded). Phone:
    // cards stack and the page scrolls.
    <div className="mx-auto w-full max-w-[88rem] lg:grid lg:h-[calc(100vh-9.25rem-var(--reader-offset,0px)-var(--reader-banner,0px))] lg:grid-cols-[16rem_minmax(0,1fr)_14rem] lg:gap-5">
      {/* Nav — a card that scrolls on its own at desktop width, a disclosure above the article on a phone. */}
      <aside className={READER_SIDE_COLUMN_CLASS + " " + READER_CARD_CLASS + " mb-4 lg:mb-0"}>
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
          {/* The nest's name heads the nav; with a home page it is also the way back to it. */}
          <h2 className="mb-3 border-b pb-3">
            <button
              type="button"
              onClick={() => homeNode && setSelectedId(homeNode.id)}
              disabled={!homeNode}
              aria-current={homeNode && selectedId === homeNode.id ? "page" : undefined}
              title={nestName}
              className={
                "flex w-full items-center gap-2 text-left text-base font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm disabled:cursor-default " +
                (homeNode && selectedId !== homeNode.id ? "text-foreground/80 hover:text-foreground" : "text-foreground")
              }
            >
              <BookOpen className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">{nestName}</span>
            </button>
          </h2>
          <label className="relative mb-3 block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or tag"
              aria-label="Search pages by title or tag"
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          {hits ? (
            hits.length === 0 ? (
              <p className="px-2 text-[13px] text-muted-foreground/70">No pages match.</p>
            ) : (
              <ul className="space-y-px">
                {hits.map((n) => {
                  const current = selectedId === n.id;
                  const where = breadcrumbFor(n.id).join(" / ");
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(n.id)}
                        aria-current={current ? "page" : undefined}
                        title={n.title || n.id}
                        className={
                          "flex w-full items-start gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 " +
                          (current ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
                        }
                      >
                        <NodeTypeGlyph type={n.type} className="mt-[3px] h-3.5 w-3.5" />
                        <span className="min-w-0">
                          <span className="block truncate">{n.title || n.id}</span>
                          {where && <span className="block truncate text-[11px] font-normal text-muted-foreground/70">{where}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            nav
          )}
        </div>
      </aside>

      {/* Article — page-scrolled, reading width. */}
      <article className={"min-w-0 " + READER_CARD_CLASS + " px-6 py-6 lg:min-h-0 lg:overflow-y-auto lg:px-8"}>
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
              <nav aria-label="Breadcrumb" className="mb-2 truncate text-[13px] text-muted-foreground" title={crumbs.join(" / ")}>
                {crumbs.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <span aria-hidden className="mx-1.5 text-muted-foreground/60">/</span>}
                    {c}
                  </span>
                ))}
              </nav>
            )}
            <h1 className="break-words text-[2rem] leading-[1.15] font-semibold tracking-tight text-foreground">{title}</h1>
            <Provenance node={selectedNode} />
          </header>
        )}
        {!selectedId && <p className="text-sm text-muted-foreground">Choose a page from the contents.</p>}
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {selectedId && body !== undefined && pdfMetas[selectedId] && (
          <PdfDocumentPanel
            nestId={nestId}
            nodeId={selectedId}
            title={title}
            pdf={pdfMetas[selectedId]}
            approvedOnly={approvedOnly}
          />
        )}
        {selectedId && body !== undefined && (
          <DocumentViewer
            content={body}
            onWikiLinkClick={openWikiLink}
            plainLinks
            className="max-w-none px-0 py-0 min-h-0 max-h-none overflow-visible prose-base prose-headings:scroll-mt-24 prose-h2:mt-10 prose-h2:text-xl prose-h3:text-base prose-p:leading-7 prose-pre:rounded-sm prose-code:before:content-none prose-code:after:content-none"
          />
        )}
        {(prev || next) && (
          <nav aria-label="Previous and next pages" className="mt-14 grid grid-cols-2 gap-4 border-t pt-6 text-sm">
            <div className="min-w-0">
              {prev && (
                <button
                  type="button"
                  onClick={() => setSelectedId(prev.id)}
                  title={prev.title || prev.id}
                  className="group flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left hover:border-primary/60 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  <span className="min-w-0">
                    <span className="block text-[12px] text-muted-foreground">Previous</span>
                    <span className="block truncate font-medium text-foreground group-hover:text-primary">{prev.title || prev.id}</span>
                  </span>
                </button>
              )}
            </div>
            <div className="min-w-0">
              {next && (
                <button
                  type="button"
                  onClick={() => setSelectedId(next.id)}
                  title={next.title || next.id}
                  className="group flex w-full items-center justify-end gap-3 rounded-lg border px-4 py-3 text-right hover:border-primary/60 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="min-w-0">
                    <span className="block text-[12px] text-muted-foreground">Next</span>
                    <span className="block truncate font-medium text-foreground group-hover:text-primary">{next.title || next.id}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                </button>
              )}
            </div>
          </nav>
        )}
      </article>

      {/* Outline — headings of the open page; only rendered when there is more than one. */}
      <aside className={"hidden lg:block " + READER_SIDE_COLUMN_CLASS + " " + READER_CARD_CLASS}>
        <nav aria-label="On this page">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
          {outline.length === 0 ? (
            <p className="text-[13px] text-muted-foreground/70">{selectedId ? "No headings yet." : "Open a page to see its headings."}</p>
          ) : (
            <ul className="space-y-1">
              {outline.map((h) => (
                <li key={h.id} style={{ paddingLeft: (h.level - 1) * 12 }}>
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
          )}
        </nav>
      </aside>
    </div>
  );

  // Unbranded: exactly the reader as it was — no wrapper, no variables.
  if (!branded) return grid;

  // The banner is the landing page's hero: on the home page (or every page
  // when the nest has no home page), never on the pages a reader is working
  // through, where it would only push the article down.
  const showBanner =
    !!(branding!.banner_url || branding!.banner_headline) && (!homeNode || selectedId === homeNode.id);
  return (
    <div
      data-reader-branded=""
      style={{
        ...(brandingToCssVars(branding, readerTheme()) as CSSProperties),
        ...(showBanner ? ({ "--reader-banner": "11rem" } as CSSProperties) : {}),
      }}
    >
      <BrandTitle branding={branding!} nestName={nestName} pageTitle={selectedNode ? title : null} />
      {showBanner && <ReaderBanner branding={branding!} />}
      {grid}
    </div>
  );
}

/** "dark" when the app shell is in dark mode (a `.dark` class on <html>). */
function readerTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Tab title and favicon while a branded reader is on screen; both are put back
 * when it unmounts (leaving the reader, exiting an owner's preview).
 */
function BrandTitle({ branding, nestName, pageTitle }: { branding: NestBranding; nestName: string; pageTitle: string | null }) {
  const next = brandedDocumentTitle(pageTitle, branding, nestName);
  useEffect(() => {
    const prev = document.title;
    document.title = next;
    return () => {
      document.title = prev;
    };
  }, [next]);
  const favicon = branding.favicon_url || null;
  useEffect(() => {
    if (!favicon) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const prev = link.href;
    link.href = favicon;
    return () => {
      link.href = prev;
    };
  }, [favicon]);
  return null;
}

/**
 * The branded hero. Bounded height (7rem phone → 10rem desktop — the reader's
 * desktop grid subtracts 11rem for it via --reader-banner). With an image the
 * text sits on a dark scrim, so white is always legible; without one the
 * banner is the accent itself with its auto-contrast foreground.
 */
function ReaderBanner({ branding }: { branding: NestBranding }) {
  const img = branding.banner_url || null;
  const hasAccent = !!branding.accent_color;
  return (
    <section
      aria-label={branding.banner_headline || branding.site_title || "Banner"}
      className="relative mx-auto mb-4 flex h-28 w-full max-w-[88rem] flex-col justify-end overflow-hidden rounded-lg border px-5 py-4 sm:h-36 sm:px-8 lg:h-40"
      style={
        img
          ? { backgroundImage: cssUrl(img), backgroundSize: "cover", backgroundPosition: "center", color: "#ffffff" }
          : {
              background: hasAccent ? "var(--reader-accent)" : "hsl(var(--primary))",
              color: hasAccent ? "var(--reader-accent-fg)" : "hsl(var(--primary-foreground))",
            }
      }
    >
      {img && <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/25 to-black/0" />}
      {img && hasAccent && <div aria-hidden className="absolute inset-x-0 bottom-0 h-1" style={{ background: "var(--reader-accent)" }} />}
      {branding.banner_headline && (
        <h2 className="relative max-w-3xl truncate text-xl font-semibold tracking-tight sm:text-2xl lg:text-3xl">{branding.banner_headline}</h2>
      )}
      {branding.banner_subtext && (
        <p className="relative mt-1 line-clamp-2 max-w-3xl text-sm opacity-90 sm:text-base">{branding.banner_subtext}</p>
      )}
    </section>
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
