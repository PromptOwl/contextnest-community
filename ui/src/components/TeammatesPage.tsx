/**
 * TeammatesPage — admin-only view for inviting teammates and managing their keys.
 */
import React, { useState, useEffect } from "react";
import * as api from "../lib/api";
import {
  ArrowLeft, UserPlus, Shield, Users, Copy, Check,
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
  const [newKey, setNewKey] = useState<{ email: string; key: string } | null>(null);

  const fetchTeammates = async () => {
    setLoading(true);
    try {
      const data = await api.listTeammates();
      setTeammates(data.teammates);
      setPendingStewards(data.pending_stewards || []);
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
            Invite teammates and manage their access keys
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
                          title="Invited but not yet registered. They must complete registration with this email to claim the account."
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
          onCreated={(email, key) => {
            setShowInvite(false);
            setInviteSeedEmail("");
            setNewKey({ email, key });
            fetchTeammates();
          }}
        />
      )}

      {newKey && (
        <NewKeyModal
          email={newKey.email}
          apiKey={newKey.key}
          onClose={() => setNewKey(null)}
        />
      )}
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
  onCreated: (email: string, key: string) => void;
}) {
  const [email, setEmail] = useState(seedEmail || "");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.inviteTeammate(email, label || undefined);
      onCreated(email, result.api_key);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Invite Teammate</DialogTitle>
          <DialogDescription>
            Create an API key for a teammate. They'll use it to authenticate
            from Hootie, Claude Desktop, or the CLI.
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
          <div className="space-y-1">
            <Label>Key label (optional)</Label>
            <Input
              placeholder="Jane's laptop"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
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
                "Generate Key"
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
  apiKey,
  onClose,
}: {
  email: string;
  apiKey: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Key created for {email}</DialogTitle>
          <DialogDescription>
            Copy this key and send it to them via Slack, email, or another
            secure channel. <strong>It won't be shown again.</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">API Key</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded text-xs font-mono break-all">
              {apiKey}
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
            They'll paste this into:
          </p>
          <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
            <li>Hootie → Settings → Vault → Remote Server → API Key</li>
            <li>
              Claude Desktop → add as{" "}
              <code className="text-[10px]">Authorization: Bearer ...</code>{" "}
              in MCP config
            </li>
            <li>
              CLI → <code className="text-[10px]">--key ...</code> flag
            </li>
          </ul>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
