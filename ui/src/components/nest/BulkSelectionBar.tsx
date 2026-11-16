import { useState } from "react";
import { FolderInput, Loader2, Send, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import * as api from "../../lib/api";
import { prettyFolderPath } from "../FolderTree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Row = { id: string; title?: string; outcome: string; code?: string; reason?: string };
type Action = "move" | "tag" | "delete" | "submit";

const splitTags = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

/**
 * Actions on the documents ticked in the Documents list: move, tag, delete,
 * submit for review.
 * Each document is its own governed write on the server, so a batch is not a
 * transaction — what couldn't be done (under review, no permission, …) is listed
 * per document after the rest went through.
 */
export function BulkSelectionBar({
  nestId,
  nodes,
  folders,
  canEdit,
  canDelete,
  canSubmit = false,
  onClear,
  onDone,
}: {
  nestId: string;
  nodes: { id: string; title?: string; status?: string }[];
  /** Every folder path in the nest. */
  folders: string[];
  /** Whether the caller may edit every selected document (move, tag). */
  canEdit: boolean;
  /** Whether the caller may delete every selected document outright. */
  canDelete: boolean;
  /** Whether any selected document is a draft the caller may submit. */
  canSubmit?: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [dest, setDest] = useState("__root__");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Row[] | null>(null);

  const n = nodes.length;
  const ids = nodes.map((x) => x.id);
  const titleOf = new Map(nodes.map((x) => [x.id, x.title || x.id]));
  const close = () => !busy && setAction(null);

  const run = async () => {
    if (!action) return;
    setBusy(true);
    try {
      let res: { requested: number; skipped: number; failed: number; results: Row[] };
      let done: number;
      if (action === "move") {
        const r = await api.bulkMoveNodes(nestId, ids, dest === "__root__" ? "" : dest);
        res = r;
        done = r.done;
      } else if (action === "delete") {
        const r = await api.bulkDeleteNodes(nestId, ids);
        res = r;
        done = r.done;
      } else if (action === "submit") {
        // Drafts only, five at a time, through the row button's own call; the
        // server's refusal (e.g. no permission) becomes that row's reason.
        const drafts = nodes.filter((x) => x.status === "draft").map((x) => x.id);
        const results: Row[] = nodes
          .filter((x) => x.status !== "draft")
          .map((x) => ({ id: x.id, outcome: "skipped", reason: "Not a draft" }));
        for (let i = 0; i < drafts.length; i += 5) {
          const batch = drafts.slice(i, i + 5);
          const settled = await Promise.allSettled(batch.map((id) => api.submitForReview(nestId, id)));
          settled.forEach((s, j) =>
            results.push(
              s.status === "fulfilled"
                ? { id: batch[j], outcome: "updated" }
                : { id: batch[j], outcome: "failed", reason: (s.reason as any)?.message || "Submit failed" },
            ),
          );
        }
        done = results.filter((r) => r.outcome === "updated").length;
        res = { requested: ids.length, skipped: ids.length - drafts.length, failed: drafts.length - done, results };
      } else {
        const r = await api.bulkUpdateNodes(
          nestId,
          ids,
          { add_tags: splitTags(addTags), remove_tags: splitTags(removeTags) },
          { allowDraft: true },
        );
        res = r;
        done = r.updated;
      }
      const verb =
        action === "move" ? "Moved" : action === "delete" ? "Deleted" : action === "submit" ? "Submitted" : "Tagged";
      const notDone = res.results.filter((r) => r.outcome === "skipped" || r.outcome === "failed");
      if (done > 0) toast.success(`${verb} ${done} of ${res.requested} document${res.requested === 1 ? "" : "s"}`);
      else if (notDone.length === 0) toast.info("Nothing to change");
      if (notDone.length > 0) setProblems(notDone);
      setAction(null);
      onClear(); // ids change on a move and vanish on a delete
      onDone();
    } catch (err: any) {
      console.error("[BulkSelectionBar] bulk action failed", nestId, action, err);
      toast.error(err?.message || "Bulk action failed");
    } finally {
      setBusy(false);
    }
  };

  const tagInvalid = splitTags(addTags).length === 0 && splitTags(removeTags).length === 0;

  return (
    <>
      {n > 0 && (
        <div
          className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 shadow-md"
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium">{n} selected</span>
          {canEdit && (
            <>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setAction("move")} data-testid="bulk-move">
                <FolderInput className="h-3.5 w-3.5 mr-1.5" />
                Move
              </Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setAction("tag")} data-testid="bulk-tag">
                <Tag className="h-3.5 w-3.5 mr-1.5" />
                Tag
              </Button>
            </>
          )}
          {canSubmit && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => setAction("submit")} data-testid="bulk-submit">
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Submit for review
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-destructive hover:text-destructive"
              onClick={() => setAction("delete")}
              data-testid="bulk-delete"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 ml-auto" onClick={onClear}>
            <X className="h-3.5 w-3.5 mr-1.5" />
            Clear
          </Button>
        </div>
      )}

      <Dialog open={action !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {action === "move" && `Move ${n} document${n === 1 ? "" : "s"}`}
              {action === "tag" && `Tag ${n} document${n === 1 ? "" : "s"}`}
              {action === "delete" && `Delete ${n} document${n === 1 ? "" : "s"}?`}
              {action === "submit" && `Submit ${n} document${n === 1 ? "" : "s"} for review`}
            </DialogTitle>
          </DialogHeader>
          {action === "move" && (
            <>
              <p className="text-sm text-muted-foreground">
                Version history, review state and [[wiki links]] follow each document. Ones under
                review or that you can't edit are skipped and listed.
              </p>
              <Select value={dest} onValueChange={setDest}>
                <SelectTrigger data-testid="bulk-move-select">
                  <SelectValue placeholder="Choose a folder" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__root__">Nest root</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f} value={f}>{prettyFolderPath(f)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {action === "tag" && (
            <>
              <p className="text-sm text-muted-foreground">
                Separate tags with commas or spaces. Documents that would need review for the change
                are skipped and listed, not turned into drafts.
              </p>
              <Input
                autoFocus
                value={addTags}
                onChange={(e) => setAddTags(e.target.value)}
                placeholder="Add tags, e.g. q4, finance"
                data-testid="bulk-add-tags"
              />
              <Input
                value={removeTags}
                onChange={(e) => setRemoveTags(e.target.value)}
                placeholder="Remove tags (optional)"
                data-testid="bulk-remove-tags"
              />
            </>
          )}
          {action === "delete" && (
            <p className="text-sm text-muted-foreground">
              This removes {n === 1 ? "the document" : `all ${n} documents`}, their version history, comments and
              annotations. It cannot be undone. Ones under review are skipped and listed.
            </p>
          )}
          {action === "submit" && (
            <p className="text-sm text-muted-foreground">
              Each draft goes to its reviewers. Ones that aren't drafts or that you can't submit are
              skipped and listed.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
            <Button
              variant={action === "delete" ? "destructive" : "default"}
              disabled={busy || (action === "tag" && tagInvalid)}
              onClick={run}
              data-testid="bulk-confirm"
            >
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {action === "move" ? "Move" : action === "tag" ? "Apply tags" : action === "submit" ? "Submit" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={problems !== null} onOpenChange={(o) => !o && setProblems(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Some documents were not changed</DialogTitle>
          </DialogHeader>
          <ul className="text-sm space-y-2 max-h-72 overflow-auto" data-testid="bulk-problems">
            {problems?.map((p) => (
              <li key={p.id}>
                <span className="font-medium">{p.title || titleOf.get(p.id) || p.id}</span>
                <span className="text-muted-foreground"> — {p.reason || p.code}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button onClick={() => setProblems(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
