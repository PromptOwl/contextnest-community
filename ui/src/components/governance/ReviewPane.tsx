/**
 * ReviewPane — the document under review, opened beside the queue
 * (CU-wdqcq05mhk). Replaces the read-only review modal: the reviewer reads the
 * pending text, compares it with what is published, sees why the author made
 * the change, and decides in place.
 *
 * Decisions are one step: Approve & publish takes an optional comment inline,
 * Request changes takes a required reason inline. Edit draft hands off to the
 * document editor, where the edit-and-approve flow (CU-wdqcq04wnw) lives.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CornerUpLeft,
  Eye,
  FileDiff,
  FileText,
  Loader2,
  Lock,
  Pencil,
  Send,
  X,
} from "lucide-react";
import * as api from "../../lib/api";
import { reads } from "../../lib/queries";
import { decideWikiLinkAction } from "../../lib/wiki-preview";
import { parseServerDate } from "@/lib/dates";
import {
  defaultReviewTab,
  readOnlyReason,
  requestChangesError,
  type ReviewPaneTab,
} from "../../lib/review-pane";
import { MarkdownEditor } from "../MarkdownEditor";
import { DiffViewer } from "./DiffViewer";
import { unifiedDiff } from "./diff-util";
import { APPROVE_BUTTON_CLASS, REJECT_BUTTON_CLASS } from "@/lib/review-actions-style";
import type { ReviewRequest } from "./ReviewQueue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ReviewPaneProps {
  nestId: string;
  request: ReviewRequest;
  /** Lower-cased email of the caller, for the separation-of-duties message. */
  currentUser?: string;
  /** Edit draft hands off to approve-with-edits, which needs edit rights and
   *  refuses prime documents — offer it only when it can work. */
  canEditDocs: boolean;
  primeTags: string[];
  onApprove: (note?: string) => Promise<void>;
  onRequestChanges: (note: string) => Promise<void>;
  /** Open the document in the editor (Edit, Save & approve). */
  onEditDraft: () => void;
  onOpenDocument: (nodeId: string) => void;
  onClose: () => void;
}

function since(dateStr: string) {
  const date = parseServerDate(dateStr);
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReviewPane({
  nestId,
  request,
  currentUser,
  canEditDocs,
  primeTags,
  onApprove,
  onRequestChanges,
  onEditDraft,
  onOpenDocument,
  onClose,
}: ReviewPaneProps) {
  const qc = useQueryClient();
  const nodeId = request.nodeId;

  // Pending body + metadata, and which version is published.
  const { data: full, isLoading: bodyLoading } = useQuery(reads.node(nestId, nodeId));
  const { data: versions } = useQuery(reads.nodeVersions(nestId, nodeId));
  const node = full?.node;
  const body: string = node?.content ?? "";
  const approvedVersion = versions?.approvedVersion ?? null;
  const pendingVersion = request.version;
  const hasPublished = approvedVersion != null && approvedVersion !== pendingVersion;

  // The published body is fetched only once there is one to compare against.
  const { data: published, isLoading: publishedLoading } = useQuery({
    queryKey: ["review-pane-published", nestId, nodeId, approvedVersion],
    queryFn: () => api.getNodeVersionContent(nestId, nodeId, approvedVersion as number),
    enabled: hasPublished,
  });
  const publishedBody = published?.content ?? null;

  const [tab, setTab] = useState<ReviewPaneTab>("preview");
  // Pick the default tab once per document, after we know whether a
  // published version exists. A tab the reviewer chose is left alone.
  const [tabChosenFor, setTabChosenFor] = useState<string | null>(null);
  useEffect(() => {
    if (!versions || tabChosenFor === nodeId) return;
    setTab(defaultReviewTab({ approvedVersion, pendingVersion }));
    setTabChosenFor(nodeId);
  }, [versions, nodeId, approvedVersion, pendingVersion, tabChosenFor]);

  // Inline decisions: no second dialog.
  const [mode, setMode] = useState<"idle" | "approve" | "changes">("idle");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    setMode("idle");
    setNote("");
    setError(null);
    setLinkError(null);
  }, [nodeId]);

  const lockedReason = readOnlyReason(request, currentUser);
  const canEditDraft = canEditDocs && !!node && !api.isPrimeNode(node, primeTags);

  const decide = async (kind: "approve" | "changes") => {
    if (kind === "changes") {
      const err = requestChangesError(note);
      if (err) {
        setMode("changes");
        setError(err);
        return;
      }
    }
    setProcessing(true);
    setError(null);
    try {
      if (kind === "approve") await onApprove(note.trim() || undefined);
      else await onRequestChanges(note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setProcessing(false);
    }
  };

  // Same wiki-link rule as the editor; reviewers can't create documents, so a
  // broken link gets a note rather than the create flow.
  const handleWikiLinkClick = async (
    title: string,
    _id: string | null,
    displayText?: string | null,
  ) => {
    setLinkError(null);
    try {
      const { nodes } = await qc.fetchQuery(reads.nodes(nestId));
      const action = decideWikiLinkAction(
        nodes as Array<{ id: string; title: string }>,
        title,
        false,
        displayText,
      );
      if (action.kind === "navigate") {
        onOpenDocument(action.node.id);
        return;
      }
      setLinkError(
        `"${action.title}" doesn't exist in this nest. Reviewers can't create new documents — ask an editor to add it.`,
      );
    } catch (e) {
      console.error("[ReviewPane] wiki-link lookup failed", nestId, title, e);
      setLinkError("Couldn't look up that document — try again later.");
    }
  };

  const title = request.title || node?.title || nodeId;
  const type: string | undefined = node?.type;
  const tabs: Array<{ key: ReviewPaneTab; label: string; icon: typeof Eye }> = [
    { key: "preview", label: "Preview", icon: Eye },
    ...(hasPublished
      ? [
          { key: "changes" as const, label: "Changes", icon: FileDiff },
          { key: "published" as const, label: `Published v${approvedVersion}`, icon: FileText },
        ]
      : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="review-pane">
      {/* Header: what this is, who sent it, what it's based on. */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-muted-foreground">{nodeId}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold leading-tight">{title}</h2>
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-[10px]">
              In review
            </Badge>
            {type && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {type}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {request.requestedBy} · v{pendingVersion}
            {hasPublished && <> · based on published v{approvedVersion}</>}
            {!hasPublished && approvedVersion == null && <> · first version</>} · submitted{" "}
            {since(request.requestedAt)}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close review">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Why the author made the change, in full. */}
      {request.requestNote && (
        <div
          className="flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/40"
          data-testid="review-pane-note"
        >
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-blue-800 dark:text-blue-300">
              {request.requestedBy}&rsquo;s note
            </p>
            <p className="mt-0.5 whitespace-pre-wrap">{request.requestNote}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
        {/* The text, three ways. */}
        <div className="min-w-0">
          {tabs.length > 1 && (
            <div className="mb-3 flex gap-1 border-b" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  data-testid={`review-pane-tab-${t.key}`}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                    tab === t.key
                      ? "border-primary font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {linkError && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {linkError}
            </div>
          )}
          <div className="rounded-lg border bg-background">
            {bodyLoading || (tab !== "preview" && publishedLoading) ? (
              // Never let "still loading" read as "empty": approving on an
              // empty box is the one mistake this pane must not invite.
              <p className="p-4 text-sm text-muted-foreground">Loading content…</p>
            ) : tab === "changes" ? (
              publishedBody == null ? (
                <p className="p-4 text-sm text-muted-foreground">
                  The published version can't be reconstructed, so there's nothing to compare.
                </p>
              ) : (
                <DiffViewer
                  patch={unifiedDiff(publishedBody, body)}
                  className="max-h-[70vh] border-0"
                />
              )
            ) : (
              <MarkdownEditor
                // Remount per document and per tab, or TipTap keeps the
                // previous body on swap.
                key={`${nodeId}:${tab}`}
                content={(tab === "published" ? publishedBody : body) || ""}
                onChange={() => {}}
                editable={false}
                nestId={nestId}
                onWikiLinkClick={handleWikiLinkClick}
              />
            )}
          </div>
        </div>

        {/* Decision panel. */}
        <aside className="flex flex-col gap-2 self-start rounded-lg border p-3" data-testid="review-pane-actions">
          {lockedReason ? (
            <div className="flex gap-2 text-sm text-muted-foreground" data-testid="review-pane-readonly">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{lockedReason}</p>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium">Waiting for your review</p>
              <p className="text-xs text-muted-foreground">
                Approve to publish it as the official version, or send it back with a reason.
              </p>
              {mode !== "idle" && (
                <Textarea
                  autoFocus
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setError(null);
                  }}
                  disabled={processing}
                  placeholder={
                    mode === "changes" ? "What needs to change? (required)" : "Comment for the author (optional)"
                  }
                  className="min-h-[90px] text-sm"
                  data-testid="review-pane-note-input"
                />
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                className={cn(APPROVE_BUTTON_CLASS, "w-full justify-center")}
                variant="outline"
                disabled={processing || bodyLoading}
                onClick={() => (mode === "changes" ? setMode("approve") : decide("approve"))}
                data-testid="review-pane-approve"
              >
                {processing && mode !== "changes" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Approve &amp; publish
              </Button>
              {mode === "idle" && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setMode("approve")}
                >
                  Add a comment
                </button>
              )}
              <Button
                variant="outline"
                className={cn(REJECT_BUTTON_CLASS, "w-full justify-center")}
                disabled={processing}
                onClick={() => (mode === "changes" ? decide("changes") : setMode("changes"))}
                data-testid="review-pane-request-changes"
              >
                {processing && mode === "changes" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CornerUpLeft className="mr-2 h-4 w-4" />
                )}
                {mode === "changes" ? "Send back" : "Request changes"}
              </Button>
              {canEditDraft && (
                <Button
                  variant="ghost"
                  className="w-full justify-center"
                  disabled={processing}
                  onClick={onEditDraft}
                  data-testid="review-pane-edit"
                >
                  <Pencil className="mr-2 h-4 w-4" /> Edit draft
                </Button>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
