/**
 * StewardAssignmentModal — ported from packages/ui-components/src/stewardship/StewardAssignmentModal.tsx
 * Adapted for community server: simpler scope targets (tag/folder patterns),
 * email-based user assignment, callback for submit.
 */
import React, { useEffect, useState } from "react";
import * as api from "../../lib/api";
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
import type { StewardshipScope } from "./StewardList";

export type StewardRole = "editor" | "reviewer" | "viewer";

interface StewardAssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  onSubmit: (data: {
    email: string;
    scope: StewardshipScope;
    target?: string;
    role: StewardRole;
  }) => Promise<void>;
  /** stewards.yaml → DB sync. Omit to hide the action. */
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

export function StewardAssignmentModal({
  isOpen,
  onClose,
  nestId,
  onSubmit,
  onSync,
}: StewardAssignmentModalProps) {
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<StewardshipScope>("tag");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<StewardRole>("reviewer");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; title: string }>>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

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

  // Fetch the document list when scope flips to "document".
  useEffect(() => {
    if (!isOpen) return;
    if (scope !== "document") return;
    if (optionsLoading) return;
    let cancelled = false;
    setOptionsLoading(true);
    api
      .listNodes(nestId)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.nodes) ? res.nodes : [];
        setNodes(list as Array<{ id: string; title: string }>);
      })
      .catch((err) => {
        console.error("[StewardAssignmentModal] documents fetch failed", err);
      })
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

  const handleAssign = async () => {
    if (!email.trim()) {
      setError("Please enter an email");
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
        email: email.trim(),
        scope,
        target: scope === "nest" ? undefined : target.trim(),
        role,
      });
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign steward");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setEmail("");
      setScope("tag");
      setTarget("");
      setRole("reviewer");
      setError(null);
      setNodes([]);
      onClose();
    }
  };

  const ScopeIcon = scopeConfig[scope].icon;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Assign Context Steward</DialogTitle>
          <DialogDescription>
            Stewards can approve or reject documents within their assigned scope,
            ensuring quality context is available for AI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Email */}
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
                {scope === "tag"
                  ? "Tag"
                  : `${scopeConfig[scope].label}`}
              </Label>

              {scope === "tag" ? (
                <Input
                  id="target"
                  placeholder={scopeConfig.tag.placeholder}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={loading}
                />
              ) : (
                <Select
                  value={target}
                  onValueChange={setTarget}
                  disabled={loading || optionsLoading}
                >
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
                          <span className="text-xs text-muted-foreground">
                            {n.id}
                          </span>
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
          {onSync ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={loading || syncing}
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
            <Button variant="outline" onClick={handleClose} disabled={loading || syncing}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={loading || syncing || !email.trim()}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4 mr-2" />
              )}
              Assign Steward
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
