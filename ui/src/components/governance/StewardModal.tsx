/**
 * StewardModal — single modal for both assigning a new steward and editing an
 * existing one. Pass a `steward` to enter edit mode (email is fixed, fields
 * prefill from the row); omit it to assign a new steward (email is editable,
 * stewards.yaml sync is offered). Both flows share the scope/target/role
 * picker. The backend rejects a scope+target the same user already holds.
 */
import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../../lib/queries";
import { isEmailish } from "../../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  UserPlus,
  AlertCircle,
  Tag,
  FileText,
  Building2,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Steward, StewardshipScope } from "./StewardList";

export type StewardRole = "editor" | "reviewer" | "viewer";

export interface StewardSubmit {
  email: string;
  scope: StewardshipScope;
  target?: string;
  role: StewardRole;
}

interface StewardModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  /** Present → edit mode (email fixed, fields prefilled). Omit → assign mode. */
  steward?: Steward;
  onSubmit: (data: StewardSubmit) => Promise<void>;
  /** stewards.yaml → DB sync. Assign-mode only; omit to hide. */
  onSync?: () => Promise<void> | void;
}

const scopeConfig: Record<
  StewardshipScope,
  { label: string; icon: React.ComponentType<{ className?: string }>; placeholder: string }
> = {
  nest: { label: "Entire Nest", icon: Building2, placeholder: "" },
  tag: { label: "Tag", icon: Tag, placeholder: "e.g., #architecture" },
  document: { label: "Document", icon: FileText, placeholder: "e.g., nodes/getting-started" },
};

// Current target value for a steward, in the form the backend expects.
function currentTarget(s: Steward): string {
  if (s.scope === "tag") return s.tagName || "";
  if (s.scope === "document") return s.nodePattern || "";
  return "";
}

export function StewardModal({
  isOpen,
  onClose,
  nestId,
  steward,
  onSubmit,
  onSync,
}: StewardModalProps) {
  const isEdit = !!steward;
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<StewardshipScope>("tag");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<StewardRole>("reviewer");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; title: string }>>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const qc = useQueryClient();

  // Seed fields from the steward (edit) or reset to defaults (assign).
  useEffect(() => {
    if (!isOpen) return;
    setEmail(steward?.userEmail ?? "");
    setScope(steward?.scope ?? "tag");
    setTarget(steward ? currentTarget(steward) : "");
    setRole(steward?.role ?? "reviewer");
    setError(null);
  }, [isOpen, steward]);

  // Fetch document/tag options on demand when targeting one.
  useEffect(() => {
    if (!isOpen) return;
    if (scope !== "document" && scope !== "tag") return;
    let cancelled = false;
    setOptionsLoading(true);
    const fetcher =
      scope === "document"
        ? qc.fetchQuery(reads.nodes(nestId)).then((res) => {
            if (cancelled) return;
            const list = Array.isArray(res?.nodes) ? res.nodes : [];
            setNodes(list as Array<{ id: string; title: string }>);
          })
        : qc.fetchQuery(reads.tags(nestId)).then((list) => {
            if (cancelled) return;
            setTags(list);
          });
    fetcher
      .catch((err) =>
        console.error(`[StewardModal] ${scope} fetch failed`, err),
      )
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally exclude state mutated inside this effect; including it
    // would cause a refetch loop when the response is empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope, nestId]);

  // Edit mode: only submit when something actually changed.
  const dirty =
    !isEdit ||
    role !== steward!.role ||
    scope !== steward!.scope ||
    target !== currentTarget(steward!);

  const handleSync = async () => {
    if (!onSync) return;
    setSyncing(true);
    setError(null);
    try {
      await onSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync stewards.yaml");
    } finally {
      setSyncing(false);
    }
  };

  const handleSubmit = async () => {
    if (isEdit && !dirty) {
      onClose();
      return;
    }
    if (!isEdit && !email.trim()) {
      setError("Please enter an email");
      return;
    }
    // Reject malformed input before it becomes a steward row — a bad address
    // would never match a real account, so the steward could never act.
    if (!isEdit && !isEmailish(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    if (scope !== "nest" && !target.trim()) {
      setError(`Please specify the ${scope} target`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        email: (steward?.userEmail ?? email).trim(),
        scope,
        target: scope === "nest" ? undefined : target.trim(),
        role,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEdit
            ? "Failed to update steward"
            : "Failed to assign steward",
      );
      setLoading(false);
    }
  };

  const busy = loading || syncing;
  const ScopeIcon = scopeConfig[scope].icon;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit steward" : "Assign Context Steward"}</DialogTitle>
          <DialogDescription>
            {isEdit ? (
              <>
                Change the role and scope for{" "}
                <strong className="text-foreground">{steward!.userEmail}</strong>.
              </>
            ) : (
              "Stewards can approve or reject documents within their assigned scope, ensuring quality context is available for AI."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Email — editable when assigning, fixed when editing. */}
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="email">Steward Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="reviewer@acme.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {/* Scope */}
          <div className="space-y-2">
            <Label>Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => {
                setScope(v as StewardshipScope);
                setTarget("");
              }}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(scopeConfig) as [StewardshipScope, typeof scopeConfig[StewardshipScope]][]).map(
                  ([key, cfg]) => {
                    const Icon = cfg.icon;
                    return (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4" />
                          {cfg.label}
                        </div>
                      </SelectItem>
                    );
                  },
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Target */}
          {scope !== "nest" && (
            <div className="space-y-2">
              <Label htmlFor="target">
                <ScopeIcon className="h-4 w-4 inline mr-2" />
                {scope === "tag" ? "Tag" : scopeConfig[scope].label}
              </Label>

              {scope === "tag" ? (
                <Select value={target} onValueChange={setTarget} disabled={loading || optionsLoading}>
                  <SelectTrigger id="target">
                    <SelectValue
                      placeholder={
                        optionsLoading
                          ? "Loading tags..."
                          : tags.length === 0
                            ? "No tags in this nest"
                            : "Select a tag"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {tags.map((t) => (
                      <SelectItem key={t} value={t}>
                        #{t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={target} onValueChange={setTarget} disabled={loading || optionsLoading}>
                  <SelectTrigger id="target">
                    <SelectValue
                      placeholder={
                        optionsLoading
                          ? "Loading documents..."
                          : nodes.length === 0
                            ? "No documents in this nest"
                            : "Select a document"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        <div className="flex flex-col">
                          <span>{n.title}</span>
                          <span className="text-xs text-muted-foreground">{n.id}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <p className="text-xs text-muted-foreground">
                {scope === "tag"
                  ? "Steward approves any document with this tag."
                  : "Steward governs this specific document."}
              </p>
            </div>
          )}

          {/* Role */}
          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as StewardRole)}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="editor">Editor — can edit but not approve</SelectItem>
                <SelectItem value="reviewer">Reviewer — can approve/reject</SelectItem>
                <SelectItem value="viewer">Viewer — read-only access</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {onSync && !isEdit ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={busy}
              title="Re-import steward rows from the nest's stewards.yaml"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Sync stewards.yaml
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={busy || (!isEdit && !email.trim())}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : !isEdit ? (
                <UserPlus className="h-4 w-4 mr-2" />
              ) : null}
              {isEdit ? "Save" : "Assign Steward"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
