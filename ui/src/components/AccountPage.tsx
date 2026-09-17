/**
 * AccountPage — Your Account: who you are on this server. Name is
 * editable in place (PATCH /auth/profile); password opens the change dialog.
 */
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeft, Shield } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { updateProfile } from "../lib/api";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AccountPage({ onBack }: { onBack: () => void }) {
  const { adminStatus, isAdmin, refresh } = useAuth();
  const me = adminStatus?.me ?? null;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (!me) {
    return <div className="py-12 text-center text-muted-foreground">Sign in to see your account.</div>;
  }
  const displayName = me.name?.trim() || me.email;

  const startEdit = () => {
    setName(me.name ?? "");
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await updateProfile(name);
      await refresh();
      toast.success("Name updated.");
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.message || "Could not update name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl" data-testid="account-page">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-2xl font-semibold">Your Account</h2>
      </div>

      <Row label="Profile photo">
        <Avatar className="h-20 w-20">
          <AvatarFallback className="text-3xl">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      </Row>

      <Row
        label="Name"
        action={
          editing ? null : (
            <Button variant="outline" size="sm" onClick={startEdit} data-testid="account-edit-name">
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              value={name}
              maxLength={80}
              placeholder="Your name"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !saving) void save();
                if (e.key === "Escape") setEditing(false);
              }}
              className="max-w-xs"
              data-testid="account-name-input"
            />
            <Button size="sm" onClick={save} disabled={saving || name.trim() === (me.name ?? "").trim()}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">{me.name?.trim() || <em>Not set — your email is shown instead</em>}</span>
        )}
      </Row>

      <Row label="Email address">
        <span className="flex items-center gap-2 text-muted-foreground">
          {me.email}
          {isAdmin && (
            <Badge variant="outline" className="gap-1 border-blue-200 bg-blue-50 text-blue-700 text-[10px] px-1.5 py-0">
              <Shield className="h-2.5 w-2.5" />
              Admin
            </Badge>
          )}
        </span>
      </Row>

      <Row
        label="Password"
        action={
          <Button variant="outline" size="sm" onClick={() => setShowPassword(true)} data-testid="account-change-password">
            Change password
          </Button>
        }
      >
        <span className="tracking-widest text-muted-foreground" aria-hidden>••••••••••••</span>
      </Row>

      <ChangePasswordDialog open={showPassword} onClose={() => setShowPassword(false)} />
    </div>
  );
}

function Row({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-5">
      <div className="min-w-0 space-y-2">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-sm">{children}</div>
      </div>
      {action}
    </div>
  );
}
