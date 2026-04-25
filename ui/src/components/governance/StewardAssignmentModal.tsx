/**
 * StewardAssignmentModal — ported from packages/ui-components/src/stewardship/StewardAssignmentModal.tsx
 * Adapted for community server: simpler scope targets (tag/folder patterns),
 * email-based user assignment, callback for submit.
 */
import React, { useState } from "react";
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
                {scopeConfig[scope].label} Pattern
              </Label>
              <Input
                id="target"
                placeholder={scopeConfig[scope].placeholder}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                {scope === "tag"
                  ? "Steward approves any document with this tag."
                  : scope === "folder"
                    ? "Glob pattern for the folder path (supports * wildcards)."
                    : "Exact document ID."}
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
