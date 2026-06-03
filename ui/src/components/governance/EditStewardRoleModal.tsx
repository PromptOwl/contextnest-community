/**
 * EditStewardRoleModal — change an existing steward's role in place, so admins
 * adjust reviewer ↔ editor ↔ viewer without remove-and-re-add. Scope/target are
 * fixed (shown read-only); only the role moves.
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle } from "lucide-react";
import type { Steward } from "./StewardList";
import type { StewardRole } from "./StewardAssignmentModal";

interface EditStewardRoleModalProps {
  steward: Steward;
  onClose: () => void;
  onSave: (role: StewardRole) => Promise<void>;
}

export function EditStewardRoleModal({
  steward,
  onClose,
  onSave,
}: EditStewardRoleModalProps) {
  const [role, setRole] = useState<StewardRole>(steward.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the target steward changes.
  useEffect(() => {
    setRole(steward.role);
    setError(null);
  }, [steward]);

  const handleSave = async () => {
    if (role === steward.role) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(role);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Edit steward role</DialogTitle>
          <DialogDescription>
            Change the role for{" "}
            <strong className="text-foreground">{steward.userEmail}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as StewardRole)}
              disabled={saving}
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

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
