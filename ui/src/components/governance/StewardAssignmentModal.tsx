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
import { Checkbox } from "@/components/ui/checkbox";
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
  Folder,
  FileText,
  Building2,
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
    canApprove: boolean;
    canReject: boolean;
  }) => Promise<void>;
}

const scopeConfig: Record<
  StewardshipScope,
  { label: string; icon: React.ComponentType<{ className?: string }>; placeholder: string }
> = {
  nest: { label: "Entire Nest", icon: Building2, placeholder: "" },
  tag: { label: "Tag", icon: Tag, placeholder: "e.g., #architecture" },
  folder: { label: "Folder", icon: Folder, placeholder: "e.g., nodes/api-*" },
  document: { label: "Document", icon: FileText, placeholder: "e.g., nodes/getting-started" },
};

export function StewardAssignmentModal({
  isOpen,
  onClose,
  nestId,
  onSubmit,
}: StewardAssignmentModalProps) {
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<StewardshipScope>("tag");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<StewardRole>("reviewer");
  const [canApprove, setCanApprove] = useState(true);
  const [canReject, setCanReject] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; title: string }>>([]);
  const [folderOptions, setFolderOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  // Fetch the right list when scope flips to document or folder. Documents
  // come from the current nest's nodes API. Folders are user-level (nests)
  // because there is no per-nest folder concept in this product — each nest
  // acts as a top-level folder for its documents.
  useEffect(() => {
    if (!isOpen) return;
    if (scope !== "document" && scope !== "folder") return;
    if (optionsLoading) return;
    let cancelled = false;
    setOptionsLoading(true);
    const fetcher =
      scope === "document"
        ? api.listNodes(nestId).then((res) => ({ kind: "document" as const, res }))
        : api.listNests().then((res) => ({ kind: "folder" as const, res }));
    fetcher
      .then((payload) => {
        if (cancelled) return;
        if (payload.kind === "document") {
          const list = Array.isArray(payload.res?.nodes) ? payload.res.nodes : [];
          setNodes(list as Array<{ id: string; title: string }>);
        } else {
          const list = Array.isArray(payload.res?.nests) ? payload.res.nests : [];
          setFolderOptions(
            list.map((n: any) => ({ id: n.id, name: n.name })),
          );
        }
      })
      .catch((err) => {
        console.error("[StewardAssignmentModal] options fetch failed", err);
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
        canApprove,
        canReject,
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
      setCanApprove(true);
      setCanReject(true);
      setError(null);
      setNodes([]);
      setFolderOptions([]);
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
              ) : scope === "document" ? (
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
                          ? "Loading folders..."
                          : folderOptions.length === 0
                            ? "No folders available"
                            : "Select a folder"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {folderOptions.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <p className="text-xs text-muted-foreground">
                {scope === "tag"
                  ? "Steward approves any document with this tag."
                  : scope === "folder"
                    ? "All documents inside this folder are governed."
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

          {/* Permissions */}
          <div className="space-y-3">
            <Label>Permissions</Label>
            <div className="flex items-center gap-2">
              <Checkbox
                id="can-approve"
                checked={canApprove}
                onCheckedChange={(c) => setCanApprove(!!c)}
                disabled={loading}
              />
              <Label htmlFor="can-approve" className="font-normal cursor-pointer">
                Can approve documents
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="can-reject"
                checked={canReject}
                onCheckedChange={(c) => setCanReject(!!c)}
                disabled={loading}
              />
              <Label htmlFor="can-reject" className="font-normal cursor-pointer">
                Can reject/request changes
              </Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleAssign} disabled={loading || !email.trim()}>
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4 mr-2" />
            )}
            Assign Steward
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
