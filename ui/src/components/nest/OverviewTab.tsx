/**
 * Overview tab — the nest's landing page, in the public reader's design
 * language (CU-wdqcq02qb1). It reads like the reader's home page: the nest
 * as the page title, its description as the lede, the governance facts as
 * the provenance line, then the contents as the reader's folder nav — an
 * expandable tree with full-width rows and one right-aligned column for
 * counts and recency. Recently edited sits in a side card the way "On this
 * page" does in the reader.
 *
 * Data comes from reads the nest page already makes (census, folder levels);
 * opening a folder here asks NestView for that level — the same read the
 * Documents tab makes. Actions are callbacks into NestView.
 */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import type { KnownFolder } from "../FolderTree";
import { FolderTree, prettyFolderPath } from "../FolderTree";
import { typePill } from "./node-display";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { READER_CARD_CLASS, breadcrumbFor } from "@/lib/reader";
import { relTime } from "@/lib/dates";
import { capFolderDocs, emptyStateActions, folderCollapsed, foldersToPrefetch, overviewFacts, type MoreMarker } from "@/lib/nest-overview";

interface Props {
  /** Cold load still in flight — shows a spinner instead of an empty index. */
  initialLoad: boolean;
  nestName: string;
  stats: { total: number };
  recentlyEdited: { id: string; title?: string; type?: string; updated_at?: string }[];
  recentlyEditedCount: number;
  folderCount: number;
  /** Folder → documents, from the loaded levels. */
  tocGroups: { folder: string; depth: number; items: any[] }[];
  knownFolders: KnownFolder[];
  /** Folder levels whose documents are loaded / in flight. */
  loadedFolders: Set<string>;
  loadingFolders: Set<string>;
  /** Load one folder level (no-op when already loaded). */
  onExpandFolder: (path: string) => void;
  isReadOnly: boolean;
  canEditDocs: boolean;
  onOpenDocument: (nodeId: string, opts?: { folder?: string }) => void;
  /** Jump to the Documents tab scoped to a folder. */
  onOpenFolder: (folder: string) => void;
  /** The nest's description — the page's lede when set. */
  description?: string | null;
  /** Governed nest only: the counts the stat cards carry on the other tabs. */
  governance?: { pending: number; approved: number; reviewable: number };
  /** Open the Review Queue tab; omitted when the caller can't see it. */
  onOpenReview?: () => void;
  /** Open the nest's Import menu (files, whole vault — and whatever else it offers). */
  onImport?: () => void;
  /** Omitted when the header doesn't offer Add with AI either (read-only). */
  onAddWithAI?: () => void;
  /** Delete (or request deletion of) a folder; omitted for read-only callers. */
  onDeleteFolder?: (folder: { path: string; label: string; total: number }) => void;
}

/** Top-level folders opened on arrival, and documents shown per folder before "View all". */
const PREFETCH_FOLDERS = 5;
const DOCS_PER_FOLDER = 5;

// The reader's shared text treatments, so the two surfaces can't drift apart
// one class at a time.
const SECTION_LABEL = "text-[12px] font-semibold uppercase tracking-wide text-muted-foreground";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
/** Every index row: full width, the reader nav's hover, one right column. */
const ROW = "group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-1 pr-2 text-left text-sm " + FOCUS;
/** The right column — counts on folders, recency on documents — so both line up. */
const META = "w-16 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/80";
/** Hover-revealed row actions (always visible, dimmer, on touch). */
const ROW_ACTION =
  "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 max-sm:opacity-60 " + FOCUS;

export function OverviewTab({
  initialLoad,
  nestName,
  stats,
  recentlyEdited,
  recentlyEditedCount,
  folderCount,
  tocGroups,
  knownFolders,
  loadedFolders,
  loadingFolders,
  onExpandFolder,
  isReadOnly,
  canEditDocs,
  onOpenDocument,
  onOpenFolder,
  description,
  governance,
  onOpenReview,
  onImport,
  onAddWithAI,
  onDeleteFolder,
}: Props) {
  // Folder rows: open once loaded, closed until then; a click wins either way.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const isCollapsed = (path: string) => folderCollapsed(path, overrides, loadedFolders);
  const toggle = (path: string) => {
    const opening = isCollapsed(path);
    setOverrides((prev) => new Map(prev).set(path, !opening));
    if (opening) onExpandFolder(path);
  };

  // Open the first few top-level folders on arrival, so the index shows
  // documents rather than a column of closed folders.
  const prefetch = useMemo(() => foldersToPrefetch(knownFolders, loadedFolders, PREFETCH_FOLDERS), [knownFolders, loadedFolders]);
  // Keyed on the prefetch list only: loadingFolders / overrides are read
  // inside, not deps — an in-flight folder is skipped here, and one the user
  // has collapsed by hand is never reopened behind their back.
  useEffect(() => {
    if (initialLoad) return;
    for (const p of prefetch) if (!loadingFolders.has(p) && !overrides.has(p)) onExpandFolder(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoad, prefetch.join("|")]);

  const cappedGroups = useMemo(() => capFolderDocs(tocGroups, DOCS_PER_FOLDER), [tocGroups]);

  if (initialLoad) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const canWrite = !isReadOnly && canEditDocs;
  // Empty folders still deserve the tree (CU-wdqcq0247y) — only a nest with
  // neither docs nor folders is empty.
  const empty = stats.total === 0 && knownFolders.length === 0;
  const facts = overviewFacts({ total: stats.total, folderCount, editedThisWeek: recentlyEditedCount, governance });
  const showRecent = recentlyEdited.length > 0;

  return (
    <div className={"grid min-w-0 gap-5 " + (showRecent ? "lg:grid-cols-[minmax(0,1fr)_16rem]" : "")}>
      {/* The index — the reader's article card. */}
      <section aria-labelledby="nest-overview-heading" className={"min-w-0 " + READER_CARD_CLASS + " px-5 py-6 sm:px-8 sm:py-8"}>
        {empty ? (
          <EmptyNest canWrite={canWrite} onOpenDocument={onOpenDocument} onImport={onImport} onAddWithAI={onAddWithAI} />
        ) : (
          <>
            {/* The reader's page header: title, lede, provenance. */}
            <header className="mb-8 max-sm:mb-6">
              {/* On a phone the page header right above already names the nest; the
                  title stays for screen readers only. */}
              <h2 id="nest-overview-heading" className="break-words text-[2rem] font-semibold leading-[1.15] tracking-tight text-foreground max-sm:sr-only">
                {nestName}
              </h2>
              {description && <p className="mt-3 max-sm:mt-0 max-w-[65ch] text-[17px] leading-7 text-muted-foreground">{description}</p>}
              <p className={"mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground" + (description ? "" : " max-sm:mt-0")} data-testid="nest-overview-facts">
                {facts.map((f) =>
                  f.action === "review" && onOpenReview ? (
                    <button key={f.key} type="button" onClick={onOpenReview} className={"rounded-sm text-primary underline-offset-2 hover:underline " + FOCUS}>
                      {f.text}
                    </button>
                  ) : (
                    <span key={f.key} className="inline-flex items-center gap-1.5">
                      {f.tone && (
                        <span aria-hidden className={"inline-block h-1.5 w-1.5 rounded-full " + (f.tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />
                      )}
                      {f.text}
                    </span>
                  ),
                )}
              </p>
            </header>

            <nav aria-label="Contents" className="border-t pt-5">
              <h3 className={SECTION_LABEL + " mb-2 px-1"}>Contents</h3>
              <FolderTree
                className="space-y-px"
                groups={cappedGroups}
                known={knownFolders}
                isCollapsed={isCollapsed}
                renderFolder={(node, { collapsed }) => (
                  <FolderRow
                    label={node.label}
                    path={node.path}
                    total={node.total}
                    collapsed={collapsed}
                    loading={loadingFolders.has(node.path)}
                    onToggle={() => toggle(node.path)}
                    onOpenFolder={() => onOpenFolder(node.path)}
                    onNewDoc={canWrite ? () => onOpenDocument("new", { folder: node.path }) : undefined}
                    onDelete={
                      onDeleteFolder
                        ? () => onDeleteFolder({ path: node.path, label: prettyFolderPath(node.path), total: node.total })
                        : undefined
                    }
                  />
                )}
                renderDoc={(n) =>
                  (n as MoreMarker).more ? (
                    <MoreRow more={(n as MoreMarker).more} onOpen={() => onOpenFolder((n as MoreMarker).more.folder)} />
                  ) : (
                    <DocRow node={n} onOpen={() => onOpenDocument(n.id)} />
                  )
                }
              />
            </nav>
          </>
        )}
      </section>

      {/* Recently edited — the reader's side card ("On this page"). */}
      {showRecent && (
        <aside aria-labelledby="nest-overview-recent" className={"min-w-0 self-start " + READER_CARD_CLASS}>
          <h2 id="nest-overview-recent" className={SECTION_LABEL + " mb-2"}>
            Recently edited
          </h2>
          <ul className="space-y-px">
            {recentlyEdited.map((n) => {
              const where = breadcrumbFor(n.id).join(" / ");
              const when = n.updated_at ? relTime(n.updated_at) : "";
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onOpenDocument(n.id)}
                    title={n.title || n.id}
                    className={"flex w-full items-start gap-1.5 rounded-md py-1.5 pl-2 pr-2 text-left text-[13px] leading-5 text-muted-foreground hover:bg-accent/60 hover:text-foreground " + FOCUS}
                  >
                    <FileText className="mt-[3px] h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0">
                      <span className="block truncate text-foreground/90">{n.title || n.id}</span>
                      {(where || when) && (
                        <span className="flex gap-2 text-[11px] text-muted-foreground/80">
                          {where && <span className="min-w-0 truncate">{where}</span>}
                          {when && <span className="shrink-0">{when}</span>}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}
    </div>
  );
}

/**
 * A folder in the index: the reader nav's folder row. The row opens and
 * closes in place; opening the folder in Documents and adding a document to
 * it are the hover actions on the right, before the count column.
 */
function FolderRow({
  label,
  path,
  total,
  collapsed,
  loading,
  onToggle,
  onOpenFolder,
  onNewDoc,
  onDelete,
}: {
  label: string;
  path: string;
  total: number;
  collapsed: boolean;
  loading: boolean;
  onToggle: () => void;
  onOpenFolder: () => void;
  onNewDoc?: () => void;
  onDelete?: () => void;
}) {
  const where = prettyFolderPath(path);
  const expandable = total > 0;
  return (
    <div className="group/row flex min-w-0 items-center rounded-md hover:bg-accent/60">
      <button
        type="button"
        onClick={expandable ? onToggle : onOpenFolder}
        aria-expanded={expandable ? !collapsed : undefined}
        title={expandable ? (collapsed ? `Show ${where}` : `Hide ${where}`) : `Browse ${where} in Documents`}
        className={ROW + " flex-1 font-medium text-foreground/85 hover:text-foreground"}
      >
        <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
          {expandable && (collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)}
        </span>
        {collapsed || !expandable ? (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Loading" />}
      </button>
      {onNewDoc && (
        <button type="button" onClick={onNewDoc} className={ROW_ACTION} title={`New document in ${where}`} aria-label={`New document in ${where}`}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" onClick={onOpenFolder} className={ROW_ACTION} title={`Open ${where} in Documents`} aria-label={`Open ${where} in Documents`}>
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
      {onDelete && (
        <button type="button" onClick={onDelete} className={ROW_ACTION + " hover:text-destructive"} title={`Delete ${where}`} aria-label={`Delete ${where}`}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      <span className={META + " pr-2"} aria-label={`${total} document${total === 1 ? "" : "s"}`}>
        {total}
      </span>
    </div>
  );
}

/** One document in the index: the reader's nav row, with type and recency in the right column. */
function DocRow({ node, onOpen }: { node: any; onOpen: () => void }) {
  const type = node.type || "document";
  const pill = typePill(type);
  const when = node.updated_at ? relTime(node.updated_at) : "";
  return (
    <button type="button" onClick={onOpen} title={node.title || node.id} className={ROW + " text-muted-foreground hover:bg-accent/60 hover:text-foreground"}>
      {/* The chevron column, empty, so titles line up under folder names. */}
      <span className="w-4 shrink-0" aria-hidden />
      {/* A plain glyph for documents, as in the reader; any other type keeps
          its tinted chip — there the icon is information. */}
      {type === "document" ? <FileText className="h-4 w-4 shrink-0 opacity-70" /> : <NodeTypeIcon type={type} className="h-3 w-3" />}
      <span className="min-w-0 flex-1 truncate text-foreground/90 group-hover:text-foreground">{node.title || node.id}</span>
      {pill && (
        <span className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`} title={pill.title}>
          {pill.label}
        </span>
      )}
      {/* Recency drops on a phone — the title needs the room. */}
      <span className={META + " max-sm:hidden"}>{when}</span>
    </button>
  );
}

/** Past the per-folder cap: one quiet row that opens the whole folder in Documents. */
function MoreRow({ more, onOpen }: { more: MoreMarker["more"]; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${more.hidden} more — open ${prettyFolderPath(more.folder)} in Documents`}
      className={ROW + " text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-primary"}
    >
      <span className="w-4 shrink-0" aria-hidden />
      <span className="w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">View all {more.total}</span>
    </button>
  );
}

/**
 * A nest with nothing in it: the three ways a first page gets here. Import
 * opens the nest's own Import menu, so any source it grows (PDF upload) is
 * offered here without a second list of items.
 */
function EmptyNest({
  canWrite,
  onOpenDocument,
  onImport,
  onAddWithAI,
}: {
  canWrite: boolean;
  onOpenDocument: Props["onOpenDocument"];
  onImport?: () => void;
  onAddWithAI?: () => void;
}) {
  const actions = emptyStateActions({ canWrite, canImport: !!onImport, canAddWithAI: !!onAddWithAI });
  if (actions.length === 0) {
    return (
      <div className="py-6">
        <h2 id="nest-overview-heading" className="text-xl font-semibold tracking-tight text-foreground">
          Contents
        </h2>
        <p className="mt-2 text-[15px] leading-7 text-muted-foreground">No documents yet.</p>
      </div>
    );
  }
  return (
    <div className="max-w-2xl">
      <h2 id="nest-overview-heading" className="text-xl font-semibold tracking-tight text-foreground">
        Add the first page
      </h2>
      <p className="mt-1.5 text-[15px] leading-7 text-muted-foreground">
        {canWrite
          ? "Write one from scratch, bring in files you already have, or have AI draft a starting set."
          : "Have AI draft a starting set of pages."}
      </p>
      <ul className="mt-6 grid gap-3">
        {actions.map((a) =>
          a === "new" ? (
            <EmptyAction key={a} icon={Plus} title="New document" detail="Write a page in the editor." onClick={() => onOpenDocument("new")} primary />
          ) : a === "import" ? (
            <EmptyAction key={a} icon={Upload} title="Import files" detail="Markdown or HTML files, or a whole vault folder with its structure." onClick={onImport!} />
          ) : (
            <EmptyAction key={a} icon={Sparkles} title="Add with AI" detail="Describe the nest and get draft pages to edit." onClick={onAddWithAI!} />
          ),
        )}
      </ul>
      {canWrite && <p className="mt-5 text-[13px] text-muted-foreground max-sm:hidden">You can also drop files anywhere on this page.</p>}
    </div>
  );
}

/** The reader's previous/next card, as a starting action. */
function EmptyAction({
  icon: Icon,
  title,
  detail,
  onClick,
  primary = false,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  detail: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={"group flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left hover:border-primary/60 hover:bg-accent/50 " + FOCUS}
      >
        <span
          className={
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md " +
            (primary ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary")
          }
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground group-hover:text-primary">{title}</span>
          <span className="block text-[13px] text-muted-foreground">{detail}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
      </button>
    </li>
  );
}
