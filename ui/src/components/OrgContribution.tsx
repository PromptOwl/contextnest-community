/**
 * Org contributions (CU-wdqcq05rz6) — the three UI pieces:
 *
 * - OrgContributionsSetting: the owner/admin switch under nest visibility
 *   ("Anyone in the organization can suggest drafts"), plus the email-domain
 *   list a shared deployment requires. Shown only while visibility is 'org'.
 * - SuggestDialog: what an org contributor writes in — a new document or an
 *   edit to one — always saying it goes to review.
 * - OrgContributorPanel: the contributor's entry point on the nest overview
 *   (Suggest a document) and their own suggestions with where each stands.
 *
 * A contributor's nest permission stays 'read'; `org_contributor` on
 * GET /nests/:id is what turns these on. The server re-checks every write.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PenLine, Send, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "../lib/api";
import { keys, useNestMeta, useNestSettings } from "../lib/queries";
import { useAuth } from "../auth/AuthContext";

/** True when the signed-in caller is an org contributor on this nest. */
export function useIsOrgContributor(nestId: string | undefined): boolean {
  const meta = useNestMeta(nestId);
  return !!(meta.data as { org_contributor?: boolean } | undefined)?.org_contributor;
}

// ── Owner/admin setting ───────────────────────────────────────────────────

export function OrgContributionsSetting({
  nestId,
  onError,
}: {
  nestId: string;
  onError?: (message: string | null) => void;
}) {
  const settings = useNestSettings(nestId);
  const qc = useQueryClient();
  const { sharedDeployment } = useAuth();
  const on = settings.data?.org_contributions === "drafts";
  const savedDomains = (settings.data?.org_domains ?? []).join(", ");
  const [domains, setDomains] = useState(savedDomains);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDomains(savedDomains), [savedDomains]);

  const parsed = domains
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  const save = async (patch: { org_contributions?: "off" | "drafts"; org_domains?: string[] }) => {
    setSaving(true);
    onError?.(null);
    try {
      await api.updateNestSettings(nestId, patch);
      await qc.invalidateQueries({ queryKey: keys.settings(nestId) });
    } catch (err: any) {
      onError?.(err?.message || "Couldn't save the contribution setting");
    } finally {
      setSaving(false);
    }
  };

  if (!settings.data) return null;
  return (
    <div className="rounded-md border border-dashed p-3 space-y-2" data-testid="org-contributions-setting">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="org-contributions" className="text-sm font-medium">
            Anyone in the organization can suggest drafts
          </Label>
          <p className="text-xs text-muted-foreground">
            People who can read this nest may suggest new documents and edits without being added.
            Every suggestion is a draft that goes to review. Nothing they write is published until a
            reviewer approves it, and they can't approve, delete, move or change settings.
            {sharedDeployment
              ? " This server hosts several organizations, so only people whose verified email is on one of your domains can suggest."
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Switch
            id="org-contributions"
            checked={on}
            disabled={saving}
            onCheckedChange={(v) =>
              void save(
                v
                  ? { org_contributions: "drafts", ...(parsed.length ? { org_domains: parsed } : {}) }
                  : { org_contributions: "off" },
              )
            }
            data-testid="org-contributions-switch"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="org-domains" className="text-xs">
          {sharedDeployment ? "Your organization's email domains (required)" : "Limit to email domains (optional)"}
        </Label>
        <div className="flex gap-2">
          <Input
            id="org-domains"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="acme.com, acme.co.uk"
            className="h-8 text-xs"
            data-testid="org-domains-input"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={saving || domains === savedDomains}
            onClick={() => void save({ org_domains: parsed })}
          >
            Save
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Matched exactly: acme.com doesn't include eng.acme.com or evil-acme.com. A domain only counts
          for an address an identity provider verified (single sign-on or PromptOwl), not a password
          sign-up.
        </p>
      </div>
    </div>
  );
}

// ── Contributor: write a suggestion ───────────────────────────────────────

export function SuggestDialog({
  nestId,
  open,
  onOpenChange,
  edit,
  onDone,
}: {
  nestId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present: suggest an edit to this document, prefilled with its text. */
  edit?: { nodeId: string; title: string; content: string };
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(edit?.title ?? "");
    setContent(edit?.content ?? "");
    setNote("");
    setError(null);
    setDone(null);
  }, [open, edit?.nodeId]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (edit) {
        await api.suggestEdit(nestId, edit.nodeId, {
          content,
          ...(title.trim() && title.trim() !== edit.title ? { title: title.trim() } : {}),
          ...(note.trim() ? { changeNote: note.trim() } : {}),
        });
      } else {
        await api.suggestDocument(nestId, { title: title.trim(), content });
      }
      await qc.invalidateQueries({ queryKey: ["my-contributions", nestId] });
      setDone(
        edit
          ? "Your edit was sent to review. The document stays as it is until a reviewer approves it."
          : "Your document was sent to review. It will be published once a reviewer approves it.",
      );
      onDone?.();
    } catch (err: any) {
      setError(err?.message || "Couldn't send your suggestion");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="suggest-dialog">
        <DialogHeader>
          <DialogTitle>{edit ? "Suggest an edit" : "Suggest a document"}</DialogTitle>
          <DialogDescription data-testid="suggest-goes-to-review">
            This will go to review. You're contributing as a member of the organization, so a
            reviewer approves it before anyone else sees it.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="text-sm" data-testid="suggest-done">{done}</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="suggest-title" className="text-xs">Title</Label>
              <Input
                id="suggest-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="suggest-title"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="suggest-content" className="text-xs">Content</Label>
              <Textarea
                id="suggest-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="font-mono text-xs"
                data-testid="suggest-content"
              />
            </div>
            {edit && (
              <div className="space-y-1">
                <Label htmlFor="suggest-note" className="text-xs">What did you change? (optional)</Label>
                <Input id="suggest-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={() => void submit()}
                disabled={saving || !content.trim() || (!edit && !title.trim())}
                data-testid="suggest-submit"
              >
                {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
                Send for review
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Contributor: overview entry point ─────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending_review: "Waiting for review",
  draft: "Draft — not sent yet",
  rejected: "Sent back",
};

export function OrgContributorPanel({ nestId }: { nestId: string }) {
  const isContributor = useIsOrgContributor(nestId);
  const [open, setOpen] = useState(false);
  const mine = useQuery({
    queryKey: ["my-contributions", nestId],
    queryFn: () => api.listMyContributions(nestId),
    enabled: isContributor,
  });
  if (!isContributor) return null;
  const items = mine.data?.contributions ?? [];
  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="org-contributor-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Users className="h-4 w-4" />
            You can contribute to this nest
          </p>
          <p className="text-xs text-muted-foreground">
            Anyone in your organization can suggest documents and edits here. Your suggestions go to
            review and are published once a reviewer approves them.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="suggest-document">
          <PenLine className="h-4 w-4 mr-1.5" />
          Suggest a document
        </Button>
      </div>
      {items.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Your suggestions</p>
          <ul className="divide-y rounded-md border text-sm" data-testid="my-contributions">
            {items.map((c) => (
              <li key={c.node_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate">{c.title || c.node_id.replace(/^nodes\//, "")}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {STATUS_LABEL[c.status] ?? c.status} · v{c.version}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SuggestDialog nestId={nestId} open={open} onOpenChange={setOpen} />
    </div>
  );
}
