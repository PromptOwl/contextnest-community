/**
 * The top of Documents, the nest's one home (po-1213). It carries what the
 * retired Overview tab had and Documents did not: the nest's description as
 * the lede, the summary line (documents, folders, edited this week, and the
 * governance counts on a governed nest) and the "Recently edited" feed. Every
 * feed item says when it changed and who changed it, the human first and the
 * agent second ("Priya Raman via mkt-amplifier"). The document list itself
 * stays in DocumentsTab, below this.
 *
 * Data comes from reads the nest page already makes (the census); actions are
 * callbacks into NestView. A nest with nothing in it gets the start actions
 * Overview offered instead of the list.
 */
import type { ComponentType, ReactNode } from "react";
import { ChevronRight, FileText, Plus, Sparkles, Upload } from "lucide-react";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { breadcrumbFor } from "@/lib/reader";
import { formatServerDate, relTime, SHORT_DATE_TIME } from "@/lib/dates";
import { emptyStateActions, overviewFacts } from "@/lib/nest-overview";
import { rowLastEdit, type LastEdit } from "@/lib/version-author";

export interface RecentItem {
  id: string;
  title?: string;
  type?: string;
  updated_at?: string;
  last_edit?: LastEdit;
}

interface Props {
  /** The nest's description — the page's lede when set. */
  description?: string | null;
  stats: { total: number };
  folderCount: number;
  editedThisWeek: number;
  /** Governed nest only: the counts the summary line adds. */
  governance?: { pending: number; approved: number; reviewable: number };
  /** Open the Review Queue; omitted when the caller can't see it. */
  onOpenReview?: () => void;
  recent: RecentItem[];
  /** Roster, for display names in place of emails. */
  people?: Array<{ email: string; name?: string | null }>;
  onOpenDocument: (nodeId: string) => void;
}

const SECTION_LABEL = "text-[12px] font-semibold uppercase tracking-wide text-muted-foreground";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function DocumentsHome({
  description,
  stats,
  folderCount,
  editedThisWeek,
  governance,
  onOpenReview,
  recent,
  people,
  onOpenDocument,
}: Props) {
  const facts = overviewFacts({ total: stats.total, folderCount, editedThisWeek, governance });
  return (
    <div className="min-w-0 space-y-4" data-testid="documents-home">
      <header className="min-w-0 px-1">
        {description && (
          <p className="max-w-[65ch] text-[15px] leading-6 text-muted-foreground" data-testid="nest-home-description">
            {description}
          </p>
        )}
        <p
          className={"flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground" + (description ? " mt-2" : "")}
          data-testid="nest-home-facts"
        >
          {facts.map((f) => {
            const dot = f.tone && (
              <span aria-hidden className={"inline-block h-1.5 w-1.5 rounded-full " + (f.tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />
            );
            return f.action === "review" && onOpenReview ? (
              <button key={f.key} type="button" onClick={onOpenReview} className={"inline-flex items-center gap-1.5 rounded-sm text-primary underline-offset-2 hover:underline " + FOCUS}>
                {dot}
                {f.text}
              </button>
            ) : (
              <span key={f.key} className="inline-flex items-center gap-1.5">
                {dot}
                {f.text}
              </span>
            );
          })}
        </p>
      </header>

      {recent.length > 0 && (
        <section aria-labelledby="nest-recent-heading" className="min-w-0 rounded-lg border bg-card px-2 py-3 sm:px-3" data-testid="nest-recent-feed">
          <h2 id="nest-recent-heading" className={SECTION_LABEL + " mb-1 px-2"}>
            Recently edited
          </h2>
          <ul className="space-y-px">
            {recent.map((n) => (
              <FeedItem key={n.id} item={n} people={people} onOpen={() => onOpenDocument(n.id)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One feed item: title and folder on the left; editor and time on the right
 *  (a second line on a phone). The full date is on the time's hover. */
function FeedItem({
  item,
  people,
  onOpen,
}: {
  item: RecentItem;
  people?: Props["people"];
  onOpen: () => void;
}) {
  const type = item.type || "document";
  const where = breadcrumbFor(item.id).join(" / ");
  const edit = rowLastEdit(item, people);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={"group flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 sm:items-center " + FOCUS}
        data-testid={`recent-item-${item.id}`}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground sm:mt-0">
          {type === "document" ? <FileText className="h-4 w-4 opacity-70" /> : <NodeTypeIcon type={type} className="h-3 w-3" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex min-w-0 items-baseline gap-2 sm:flex-1">
            <span className="truncate text-foreground/90 group-hover:text-foreground">{item.title || item.id}</span>
            {where && <span className="shrink-0 truncate text-[12px] text-muted-foreground max-sm:hidden">{where}</span>}
          </span>
          {edit && (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground sm:shrink-0">
              {where && <span className="max-w-[40%] shrink-0 truncate sm:hidden">{where}</span>}
              {where && (edit.editor || edit.at) && <span aria-hidden className="sm:hidden">·</span>}
              {edit.editor && (
                <span className="truncate" data-testid="last-editor">
                  {edit.editor}
                </span>
              )}
              {edit.editor && edit.at && <span aria-hidden>·</span>}
              {edit.at && (
                <time dateTime={edit.at} title={formatServerDate(edit.at, SHORT_DATE_TIME)} className="shrink-0 tabular-nums">
                  {relTime(edit.at)}
                </time>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * A nest with nothing in it: the three ways a first page gets here. Import
 * opens the nest's own Import dialog, so any source it grows (PDF upload) is
 * offered here without a second list of items.
 */
export function EmptyNest({
  canWrite,
  onNewDocument,
  onImport,
  onAddWithAI,
}: {
  canWrite: boolean;
  onNewDocument: () => void;
  onImport?: () => void;
  onAddWithAI?: () => void;
}) {
  const actions = emptyStateActions({ canWrite, canImport: !!onImport, canAddWithAI: !!onAddWithAI });
  if (actions.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-5 py-6 sm:px-8">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Contents</h2>
        <p className="mt-2 text-[15px] leading-7 text-muted-foreground">No documents yet.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-card px-5 py-6 sm:px-8 sm:py-8" data-testid="nest-empty">
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Add the first page</h2>
        <p className="mt-1.5 text-[15px] leading-7 text-muted-foreground">
          {canWrite
            ? "Write one from scratch, bring in files you already have, or have AI draft a starting set."
            : "Have AI draft a starting set of pages."}
        </p>
        <ul className="mt-6 grid gap-3">
          {actions.map((a) =>
            a === "new" ? (
              <EmptyAction key={a} icon={Plus} title="New document" detail="Write a page in the editor." onClick={onNewDocument} primary />
            ) : a === "import" ? (
              <EmptyAction key={a} icon={Upload} title="Import files" detail="Markdown or HTML files, or a whole vault folder with its structure." onClick={onImport!} />
            ) : (
              <EmptyAction key={a} icon={Sparkles} title="Add with AI" detail="Describe the nest and get draft pages to edit." onClick={onAddWithAI!} />
            ),
          )}
        </ul>
        {canWrite && <p className="mt-5 text-[13px] text-muted-foreground max-sm:hidden">You can also drop files anywhere on this page.</p>}
      </div>
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
