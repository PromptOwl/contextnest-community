/**
 * ChangePasswordDialog — self-service password change, usable by anyone
 * signed in (including a user on an admin-issued temporary password). Calls
 * /auth/password, which verifies the current password and invalidates other
 * sessions. Opened from the Account page.
 */
import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { changePassword } from "../lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Eye toggle pinned inside a password field to reveal/hide the value.
function PasswordToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      aria-label={shown ? "Hide password" : "Show password"}
      title={shown ? "Hide password" : "Show password"}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
    >
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

export function ChangePasswordDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reveal toggles per field so a user can verify what they typed.
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setShowCurrent(false);
    setShowNext(false);
    setShowConfirm(false);
  };

  const submit = async () => {
    setError(null);
    if (next.trim().length === 0) {
      setError("New password cannot be empty or only whitespace.");
      return;
    }
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (next === current) {
      setError("New password must be different from the current password.");
      return;
    }
    setSaving(true);
    try {
      await changePassword(current, next);
      toast.success("Password changed. Your other sessions were signed out.");
      reset();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Could not change password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Change password
          </DialogTitle>
          <DialogDescription>
            If an admin gave you a temporary password, set your own here. This
            signs out your other sessions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label
              htmlFor="cp-current"
              className="block text-sm font-medium"
            >
              Current password
            </label>
            <div className="relative">
              <Input
                id="cp-current"
                type={showCurrent ? "text" : "password"}
                placeholder="Enter your current password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                className="pr-10"
              />
              <PasswordToggle
                shown={showCurrent}
                onToggle={() => setShowCurrent((s) => !s)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="cp-next" className="block text-sm font-medium">
              New password
            </label>
            <div className="relative">
              <Input
                id="cp-next"
                type={showNext ? "text" : "password"}
                placeholder="At least 8 characters"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                className="pr-10"
              />
              <PasswordToggle
                shown={showNext}
                onToggle={() => setShowNext((s) => !s)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="cp-confirm"
              className="block text-sm font-medium"
            >
              Confirm new password
            </label>
            <div className="relative">
              <Input
                id="cp-confirm"
                type={showConfirm ? "text" : "password"}
                placeholder="Re-enter your new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                aria-invalid={confirm.length > 0 && confirm !== next}
                className="pr-10"
              />
              <PasswordToggle
                shown={showConfirm}
                onToggle={() => setShowConfirm((s) => !s)}
              />
            </div>
            {confirm.length > 0 && confirm !== next && (
              <p className="text-sm text-destructive">
                Passwords don't match.
              </p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !current || !next || !confirm || next !== confirm}
          >
            {saving ? "Saving..." : "Change password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
