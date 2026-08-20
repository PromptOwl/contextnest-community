/**
 * ShareTargetDialog — share ONE document or ONE folder with a person.
 *
 * The human half of the grants model (src/governance/grants-service.ts); the
 * agent half is the `context_grant` MCP tool. Both hit the same endpoints:
 *   GET    /nests/:id/grants        → the nest's whole sharing roster
 *   POST   /nests/:id/grants        → { target_type, target, email, role }
 *   DELETE /nests/:id/grants/:id    → unshare
 *
 * Document and folder are the same dialog because they are the same call —
 * only `target_type` differs, and the copy explains the blast radius. The
 * roster comes back nest-wide, so it is filtered here to this target: a
 * folder share and a doc share inside it are separate rows.
 *
 * Access ≠ review governance. A grant lets someone reach this document (or
 * everything under this folder) and nothing else in the nest; it does not
 * make them a steward.
 *
 * Sharing from here is view-only — no role picker. The grants API and
 * `context_grant` still take `write`, so a `write` row made that way is
 * labelled honestly in the roster below; this surface just never creates one.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Share2,
  Trash2,
  Loader2,
  AlertCircle,
  FileText,
  Folder,
} from "lucide-react";
import * as api from "../lib/api";

interface ShareTargetDialogProps {
  nestId: string;
  targetType: "document" | "folder";
  /** Node id (`nodes/win-loss-log`) or folder path (`nodes/gtm/deals`). */
  target: string;
  /** Human label for the header — document title or pretty folder path. */
  label: string;
  onClose: () => void;
}

export function ShareTargetDialog({
  nestId,
  targetType,
  target,
  label,
  onClose,
}: ShareTargetDialogProps) {
  const [grants, setGrants] = useState<api.Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const { grants: all } = await api.listGrants(nestId);
      setGrants(
        all.filter((g) => g.target_type === targetType && g.target === target),
      );
    } catch (err: any) {
      setError(err?.message || "Failed to load who this is shared with");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, targetType, target]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createGrant(nestId, {
        target_type: targetType,
        target,
        email: email.trim(),
        // Sharing from the UI is view-only. The API and `context_grant` still
        // accept `write`; there is deliberately no picker here, so nobody
        // hands out edit rights by leaving a dropdown where it was.
        role: "read",
      });
      setEmail("");
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to share");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (grant: api.Grant) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteGrant(nestId, grant.id);
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to unshare");
    } finally {
      setBusy(false);
    }
  };

  const Icon = targetType === "folder" ? Folder : FileText;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader className="min-w-0">
          {/* min-w-0 + truncate on the label: a long or id-prefixed folder name
              must shorten rather than force the dialog wider than its box. */}
          <DialogTitle className="flex items-center gap-2 min-w-0">
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">
              Share {targetType === "folder" ? "folder" : "document"}: {label}
            </span>
          </DialogTitle>
          <DialogDescription>
            {targetType === "folder" ? (
              <>
                People you add here can <strong>view every document in this
                folder</strong> and its subfolders — nothing else in the nest,
                and no editing. They do not become stewards.
              </>
            ) : (
              <>
                People you add here can <strong>view this document</strong> —
                nothing else in the nest, and no editing. They do not become
                stewards.
              </>
            )}
          </DialogDescription>
          {/* The exact thing being shared, in full. break-all so a long id
              wraps inside the dialog instead of stretching it. */}
          <code className="mt-1 block rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground break-all">
            {target}
          </code>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleAdd} className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                className="flex-1 min-w-0"
                data-testid="share-target-email"
              />
              <Button
                type="submit"
                disabled={busy || !email.trim()}
                className="shrink-0"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Share2 className="h-4 w-4 mr-1" />
                    Share
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If they don't have an account yet, they'll get access when they
              register with this email.
            </p>
          </form>

          <div className="rounded-lg border p-4 space-y-2 max-h-[40vh] overflow-y-auto">
            <Label className="text-sm font-medium">
              Shared with{grants.length > 0 ? ` (${grants.length})` : ""}
            </Label>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : grants.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Not shared with anyone yet. Everyone with access to the nest can
                already see it.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {grants.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 py-1.5">
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {g.email ?? g.user_id}
                    </span>
                    <Badge variant="secondary" className="text-[11px]">
                      {g.role === "write" ? "Can edit" : "Can view"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleRemove(g)}
                      title="Remove access"
                      data-testid={`unshare-${g.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
