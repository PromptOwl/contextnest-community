/**
 * TeammatesPage — admin-only view for inviting teammates and managing their keys.
 */
import React, { useState, useEffect } from "react";
import * as api from "../lib/api";
import { copyTextWithToast } from "../lib/clipboard";
import {
  ArrowLeft, UserPlus, Shield, ShieldCheck, ShieldOff, Users, Copy, Check,
  AlertCircle, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface TeammatesPageProps {
  onBack: () => void;
}

interface Teammate {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  is_invited?: number | boolean;
  key_count: number;
  last_active: string | null;
}

export function TeammatesPage({ onBack }: TeammatesPageProps) {
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [pendingStewards, setPendingStewards] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteSeedEmail, setInviteSeedEmail] = useState<string>("");
  const [newKey, setNewKey] = useState<{ email: string; password: string } | null>(null);
  // Temp password to reveal after an admin reset (no email — shown once).
  // password === null means we're still generating (shows a loader).
  const [resetPw, setResetPw] = useState<{ email: string; password: string | null } | null>(null);
  // User pending removal confirmation.
  const [removeTarget, setRemoveTarget] = useState<Teammate | null>(null);
  const [removing, setRemoving] = useState(false);
  // User pending superadmin-grant confirmation.
  const [grantTarget, setGrantTarget] = useState<Teammate | null>(null);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  // User pending superadmin-revoke confirmation.
  const [revokeTarget, setRevokeTarget] = useState<Teammate | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // email (lowercased) → { source, self }. Only "granted" non-self rows are
  // revocable: "license"/"config" admins are file-authoritative, and you can't
  // revoke your own access (it would 403 the very next fetch and break the page).
  const [adminSource, setAdminSource] =
    useState<Record<string, { source: string; self: boolean }>>({});

  const fetchTeammates = async () => {
    setLoading(true);
    try {
      const [data, admins] = await Promise.all([
        api.listTeammates(),
        api.listSuperAdmins(),
      ]);
      setTeammates(data.teammates);
      setPendingStewards(data.pending_stewards || []);
      setAdminSource(
        Object.fromEntries(
          admins.super_admins.map((a) => [
            a.email.toLowerCase(),
            { source: a.source, self: a.self },
          ]),
        ),
      );
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTeammates(); }, []);

  const formatDate = (d: string | null) => {
    if (!d) return "Never";
    const date = new Date(d);
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-2xl font-semibold">Teammates</h2>
          <p className="text-sm text-muted-foreground">
            Add teammates and manage their access
          </p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <UserPlus className="h-4 w-4 mr-2" />
          Invite Teammate
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-4 w-4" />
            All Users
          </CardTitle>
          <CardDescription>
            Everyone who has access to this community server
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : teammates.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No teammates yet. Click "Invite Teammate" to add one.
            </div>
          ) : (
            <div className="space-y-2">
              {teammates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 p-3 rounded-lg border"
                >
                  <Avatar className="h-9 w-9">
                    <AvatarFallback>
                      {(t.email[0] || "?").toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {t.name || t.email}
                      </span>
                      {t.is_admin && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-blue-200 bg-blue-50 text-blue-700"
                        >
                          <Shield className="h-3 w-3" />
                          Admin
                        </Badge>
                      )}
                      {!!t.is_invited && (
                        <Badge
                          variant="outline"
                          className="border-amber-200 bg-amber-50 text-amber-700"
                          title="Added with a temporary password. They can sign in with their email + that password (use Reset password to re-issue one), then change it."
                        >
                          Invited
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-3">
                      <span>{t.email}</span>
                      <span>·</span>
                      <span>
                        {t.key_count} key{t.key_count !== 1 ? "s" : ""}
                      </span>
                      {t.last_active && (
                        <>
                          <span>·</span>
                          <span>last active {formatDate(t.last_active)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {t.is_admin &&
                    adminSource[t.email.toLowerCase()]?.source === "granted" &&
                    !adminSource[t.email.toLowerCase()]?.self && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setRevokeTarget(t)}
                      title="Revoke this user's superadmin access"
                    >
                      <ShieldOff className="h-4 w-4 mr-2" />
                      Revoke superadmin
                    </Button>
                  )}
                  {!t.is_admin && (
                    <>
                    {!t.is_invited && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setGrantTarget(t)}
                        title="Grant this user superadmin access"
                      >
                        <ShieldCheck className="h-4 w-4 mr-2" />
                        Grant superadmin
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!resetPw}
                      onClick={async () => {
                        setResetPw({ email: t.email, password: null });
                        try {
                          const r = await api.resetUserPassword(t.id);
                          setResetPw({
                            email: t.email,
                            password: r.temporary_password || "",
                          });
                          await fetchTeammates();
                        } catch (e: any) {
                          setResetPw(null);
                          setError(e.message);
                        }
                      }}
                      title="Generate a temporary password to share with this user (no email is sent)"
                    >
                      Reset password
                    </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setRemoveTarget(t)}
                        title="Remove this user and revoke all access"
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pendingStewards.length > 0 && (
        <Card className="mt-4 border-amber-200 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-4 w-4 text-amber-700" />
              Stewards without server access
            </CardTitle>
            <CardDescription>
              These emails are assigned as stewards on one or more nests, but
              haven't registered to this server yet — they
              can't log in or approve anything until they claim an account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {pendingStewards.map((email) => (
                <div
                  key={email}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-background"
                >
                  <Avatar className="h-9 w-9">
                    <AvatarFallback className="bg-amber-100 text-amber-800">
                      {(email[0] || "?").toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm truncate">{email}</span>
                    <div className="text-xs text-muted-foreground">
                      Assigned as steward · not registered yet
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setInviteSeedEmail(email);
                      setShowInvite(true);
                    }}
                  >
                    <UserPlus className="h-3.5 w-3.5 mr-1" />
                    Invite
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {showInvite && (
        <InviteTeammateModal
          seedEmail={inviteSeedEmail}
          onClose={() => {
            setShowInvite(false);
            setInviteSeedEmail("");
          }}
          onCreated={(email, password) => {
            setShowInvite(false);
            setInviteSeedEmail("");
            setNewKey({ email, password });
            fetchTeammates();
          }}
        />
      )}

      {newKey && (
        <NewKeyModal
          email={newKey.email}
          password={newKey.password}
          onClose={() => setNewKey(null)}
        />
      )}

      {resetPw && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setResetPw(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border bg-background p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-1">Temporary password</h3>
            {resetPw.password === null ? (
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Generating a temporary password for
                  <br />
                  <strong className="text-foreground">{resetPw.email}</strong>
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Share this with <strong>{resetPw.email}</strong> directly — no
                  email is sent. They sign in with it, then change it from their
                  account. It won't be shown again. Their existing API keys keep
                  working; revoke a key separately if it may be compromised.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted border rounded px-2 py-1.5 text-sm font-mono break-all">
                    {resetPw.password}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copyTextWithToast(resetPw.password!)}
                  >
                    Copy
                  </Button>
                </div>
                <div className="mt-4 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetPw(null)}
                  >
                    Done
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && !removing && setRemoveTarget(null)}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.email}?</DialogTitle>
            <DialogDescription>
              This revokes all their access (API keys, sessions, steward +
              collaborator roles) and deletes the account. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                if (!removeTarget) return;
                setRemoving(true);
                try {
                  await api.removeUser(removeTarget.id);
                  setRemoveTarget(null);
                  await fetchTeammates();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!grantTarget}
        onOpenChange={(o) => !o && !granting && setGrantTarget(null)}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Grant superadmin to {grantTarget?.email}?</DialogTitle>
            <DialogDescription>
              They immediately get server-admin access everywhere: every nest,
              teammate management, and the activity trace. You can revoke
              this later from this list.
            </DialogDescription>
          </DialogHeader>
          {grantError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{grantError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGrantTarget(null)}
              disabled={granting}
            >
              Cancel
            </Button>
            <Button
              disabled={granting}
              onClick={async () => {
                if (!grantTarget) return;
                setGranting(true);
                setGrantError(null);
                try {
                  await api.addSuperAdmin(grantTarget.email);
                  setGrantTarget(null);
                  await fetchTeammates();
                } catch (e: any) {
                  setGrantError(e.message);
                } finally {
                  setGranting(false);
                }
              }}
            >
              {granting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Grant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(o) => !o && !revoking && setRevokeTarget(null)}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Revoke superadmin from {revokeTarget?.email}?</DialogTitle>
            <DialogDescription>
              They immediately lose server-admin access. They keep their account
              and any nest/collaborator roles granted separately. You can grant
              superadmin again later.
            </DialogDescription>
          </DialogHeader>
          {revokeError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{revokeError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={revoking}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revoking}
              onClick={async () => {
                if (!revokeTarget) return;
                setRevoking(true);
                setRevokeError(null);
                try {
                  await api.removeSuperAdmin(revokeTarget.email);
                  setRevokeTarget(null);
                  await fetchTeammates();
                } catch (e: any) {
                  setRevokeError(e.message);
                } finally {
                  setRevoking(false);
                }
              }}
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteTeammateModal({
  seedEmail,
  onClose,
  onCreated,
}: {
  seedEmail?: string;
  onClose: () => void;
  onCreated: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState(seedEmail || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.inviteTeammate(email);
      onCreated(email, result.temporary_password);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Add Teammate</DialogTitle>
          <DialogDescription>
            Create a login for a teammate. They get a temporary password to sign
            in with, then can change it and create their own API key.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleInvite} className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1">
            <Label>Email</Label>
            <Input
              type="email"
              placeholder="jane@acme.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Add teammate"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewKeyModal({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyTextWithToast(password))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Teammate added: {email}</DialogTitle>
          <DialogDescription>
            Send them this temporary password via Slack, email, or another
            secure channel. <strong>It won't be shown again.</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            Temporary password
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded text-xs font-mono break-all">
              {password}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground pt-2">
            They sign in at this server with their email + this password, then
            can change it under their account and create their own API key for
            Hootie, Claude Desktop, or the CLI.
          </p>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
