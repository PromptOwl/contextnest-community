/**
 * Overview tab — the nest's landing page, in the public reader's design
 * language (CU-wdqcq02qb1): an index on the reader's card surface, calm
 * type, nav-style rows, and the governance facts written as one provenance-
 * style line instead of a grid of stat cards. Recently edited sits in a side
 * card the way "On this page" does in the reader.
 *
 * Everything here derives from reads the nest page already holds (census,
 * the loaded folder levels), so it takes them as props; the one loader is
 * the nest's cold load. Actions are callbacks into NestView — this file owns
 * no state and no API calls.
 */
import type { ComponentType, ReactNode } from "react";
import { ChevronRight, FileText, Folder, Loader2, Plus, Sparkles, Upload } from "lucide-react";
import type { KnownFolder } from "../FolderTree";
import { FolderTree, prettyFolderPath } from "../FolderTree";
import { typePill } from "./node-display";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { READER_CARD_CLASS, breadcrumbFor } from "@/lib/reader";
import { relTime } from "@/lib/dates";
import { overviewFacts } from "@/lib/nest-overview";

interface Props {
  /** Cold load still in flight — shows a spinner instead of an empty index. */
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
  /** The nest's description — the index's lede when set. */
  description?: string | null;
  /** Governed nest only: the counts the stat cards carry on the other tabs. */
  governance?: { pending: number; approved: number; reviewable: number };
  /** Open the Review Queue tab; omitted when the caller can't see it. */
  onOpenReview?: () => void;
  /** Open the nest's Import menu (files, whole vault — and whatever else it offers). */
  onImport?: () => void;
  onAddWithAI?: () => void;
}

// The reader's shared text treatments, so the two surfaces can't drift apart
// one class at a time.
const SIDE_LABEL = "mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

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
  description,
  governance,
  onOpenReview,
  onImport,
  onAddWithAI,
}: Props) {
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
      <section aria-labelledby="nest-overview-heading" className={"min-w-0 " + READER_CARD_CLASS + " px-5 py-6 sm:px-8"}>
        {empty ? (
          <EmptyNest canWrite={canWrite} onOpenDocument={onOpenDocument} onImport={onImport} onAddWithAI={onAddWithAI} />
        ) : (
          <>
            <header className="mb-6">
              <h2 id="nest-overview-heading" className="text-xl font-semibold tracking-tight text-foreground">
                Contents
              </h2>
              {description && (
                <p className="mt-1.5 max-w-[72ch] text-[15px] leading-7 text-muted-foreground">{description}</p>
              )}
              {/* The reader's provenance line, for the whole nest. */}
              <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground" data-testid="nest-overview-facts">
                {facts.map((f) =>
                  f.action === "review" && onOpenReview ? (
                    <button
                      key={f.key}
                      type="button"
                      onClick={onOpenReview}
                      className={"rounded-sm text-primary underline-offset-2 hover:underline " + FOCUS}
                    >
                      {f.text}
                    </button>
                  ) : (
                    <span key={f.key} className="inline-flex items-center gap-1.5">
                      {f.tone && (
                        <span
                          aria-hidden
                          className={"inline-block h-1.5 w-1.5 rounded-full " + (f.tone === "ok" ? "bg-emerald-500" : "bg-amber-500")}
                        />
                      )}
                      {f.text}
                    </span>
                  ),
                )}
              </p>
            </header>

            <FolderTree
              className="max-w-2xl space-y-px"
              groups={tocGroups}
              known={knownFolders}
              indentRem={1.25}
              renderFolder={(node) => (
                // Folders navigate into the Documents tab scoped to that
                // folder — no collapse here; the whole index stays open.
                <div className="group/folder flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onOpenFolder(node.path)}
                    className={"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left text-sm font-medium text-foreground/85 hover:bg-accent/60 hover:text-foreground " + FOCUS}
                    title={`Browse ${prettyFolderPath(node.path)} in Documents`}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{node.label}</span>
                    <span className="shrink-0 text-[12px] font-normal tabular-nums text-muted-foreground" aria-label={`${node.total} documents`}>
                      {node.total}
                    </span>
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => onOpenDocument("new", { folder: node.path })}
                      className={
                        "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100 max-sm:opacity-60 " +
                        FOCUS
                      }
                      title={`New document in ${prettyFolderPath(node.path)}`}
                      aria-label={`New document in ${prettyFolderPath(node.path)}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              renderDoc={(n) => <DocRow node={n} onOpen={() => onOpenDocument(n.id)} />}
            />
          </>
        )}
      </section>

      {/* Recently edited — the reader's side card ("On this page"). */}
      {showRecent && (
        <aside aria-labelledby="nest-overview-recent" className={"min-w-0 self-start " + READER_CARD_CLASS}>
          <h2 id="nest-overview-recent" className={SIDE_LABEL}>
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

/** One document in the index: the reader's nav row, with type and recency on the right. */
function DocRow({ node, onOpen }: { node: any; onOpen: () => void }) {
  const type = node.type || "document";
  const pill = typePill(type);
  const when = node.updated_at ? relTime(node.updated_at) : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={node.title || node.id}
      className={"group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground " + FOCUS}
    >
      {/* A plain glyph for documents, as in the reader; any other type keeps
          its tinted chip — there the icon is information. */}
      {type === "document" ? (
        <FileText className="h-4 w-4 shrink-0 opacity-70" />
      ) : (
        <NodeTypeIcon type={type} className="h-3 w-3" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground/90 group-hover:text-foreground">{node.title || node.id}</span>
      {pill && (
        <span className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`} title={pill.title}>
          {pill.label}
        </span>
      )}
      {when && <span className="hidden shrink-0 text-[12px] tabular-nums text-muted-foreground/80 sm:inline">{when}</span>}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/70" />
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
  if (!canWrite) {
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
        Write one from scratch, bring in files you already have, or have AI draft a starting set.
      </p>
      <ul className="mt-6 grid gap-3">
        <EmptyAction
          icon={Plus}
          title="New document"
          detail="Write a page in the editor."
          onClick={() => onOpenDocument("new")}
          primary
        />
        {onImport && (
          <EmptyAction icon={Upload} title="Import files" detail="Markdown or HTML files, or a whole vault folder with its structure." onClick={onImport} />
        )}
        {onAddWithAI && (
          <EmptyAction icon={Sparkles} title="Add with AI" detail="Describe the nest and get draft pages to edit." onClick={onAddWithAI} />
        )}
      </ul>
      <p className="mt-5 text-[13px] text-muted-foreground max-sm:hidden">You can also drop files anywhere on this page.</p>
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
