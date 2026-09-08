/**
 * PublishDialog — publish one document as a hosted page at /p/<slug>
 * (see src/nests/publish-routes.ts and src/nests/publish-render-routes.ts):
 *   - POST   /nests/:id/publications          → mint a link with a chosen gate
 *   - GET    /nests/:id/publications          → the links already live
 *   - GET    /nests/:id/publications/:pid/views → who opened it, when
 *   - DELETE /nests/:id/publications/:pid     → revoke
 *
 * Two tabs, because publishing and auditing are different jobs: "New link"
 * mints one, "Links" lists this document's existing links with their view log.
 *
 * Publishing is owner/admin-only server-side (canManageStewards), matching the
 * menu gate in NestView — a plain collaborator never sees the action.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Globe,
  Mail,
  KeyRound,
  UserCheck,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  Eye,
  Ban,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { reads } from "../lib/queries";

interface PublishDialogProps {
  nestId: string;
  nodeId: string;
  nodeTitle: string;
  onClose: () => void;
  /** Stewardship is on for this nest and the document has not been approved —
   *  publishing is still allowed, but it is said out loud (CU-wdqcq01e73). */
  unapproved?: boolean;
}

const MODES: Array<{
  value: api.PublishMode;
  label: string;
  hint: string;
  icon: typeof Globe;
}> = [
  { value: "public", label: "Public", hint: "Anyone with the link", icon: Globe },
  { value: "email", label: "Email", hint: "One-time link by email", icon: Mail },
  { value: "code", label: "Passcode", hint: "One shared code", icon: KeyRound },
  { value: "invite", label: "Invite only", hint: "Named people only", icon: UserCheck },
];

export function PublishDialog({
  nestId,
  nodeId,
  nodeTitle,
  onClose,
  unapproved = false,
}: PublishDialogProps) {
  const [mode, setMode] = useState<api.PublishMode>("public");
  const [comments, setComments] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [noDownload, setNoDownload] = useState(false);
  const [code, setCode] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [links, setLinks] = useState<api.Publication[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  // View log is fetched per link, on demand — a deck with many views should not
  // cost anything until someone actually opens the panel.
  const [views, setViews] = useState<Record<string, api.PublicationView[]>>({});
  const [loadingViews, setLoadingViews] = useState<string | null>(null);
  // Assume mail works until told otherwise, so a slow health read never blocks
  // a gate that would have been fine.
  const [emailReady, setEmailReady] = useState(true);
  const qc = useQueryClient();

  async function refreshLinks() {
    setLoadingLinks(true);
    try {
      const res = await api.listPublications(nestId);
      setLinks(res.publishes.filter((p) => p.node_id === nodeId));
    } catch (e: any) {
      setError(e?.message || "Could not load existing links");
    } finally {
      setLoadingLinks(false);
    }
  }

  useEffect(() => {
    refreshLinks();
    // The email and invite gates are opened only by a mailed magic link, so
    // they are unusable on a server with no mail transport. Read it from the
    // cached health query rather than letting the server reject the publish
    // after someone has typed out an allow-list.
    qc.fetchQuery(reads.health())
      .then((h) => setEmailReady(h.email_configured !== false))
      .catch(() => setEmailReady(true)); // unknown → let the server decide
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, nodeId]);

  // Never leave a disabled gate selected.
  useEffect(() => {
    if (!emailReady && (mode === "email" || mode === "invite")) setMode("public");
  }, [emailReady, mode]);

  async function handleCreate() {
    setError(null);
    if (mode === "code" && !code.trim()) {
      setError("A passcode link needs a passcode.");
      return;
    }
    const emails = allowlist
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (mode === "invite" && !emails.length) {
      setError("An invite-only link needs at least one email address.");
      return;
    }
    setCreating(true);
    try {
      const res = await api.createPublication(nestId, {
        node_id: nodeId,
        access_mode: mode,
        comments_enabled: comments,
        watermark,
        no_download: noDownload,
        code: mode === "code" ? code.trim() : null,
        allowlist: mode === "invite" ? emails : [],
        // <input type="date"> gives a bare day; publish through the end of it.
        expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      });
      setNewLink(res.link);
      setCode("");
      setAllowlist("");
      await refreshLinks();
    } catch (e: any) {
      setError(e?.message || "Could not publish this document");
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy — select the link and copy it manually.");
    }
  }

  async function handleRevoke(publishId: string) {
    setError(null);
    try {
      await api.revokePublication(nestId, publishId);
      await refreshLinks();
    } catch (e: any) {
      setError(e?.message || "Could not revoke this link");
    }
  }

  async function loadViews(publishId: string) {
    setLoadingViews(publishId);
    try {
      const res = await api.listPublicationViews(nestId, publishId);
      setViews((v) => ({ ...v, [publishId]: res.views }));
    } catch (e: any) {
      setError(e?.message || "Could not load the view log");
    } finally {
      setLoadingViews(null);
    }
  }

  const linkFor = (p: api.Publication) =>
    p.link || `${window.location.origin}/p/${p.slug}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish “{nodeTitle}”</DialogTitle>
          <DialogDescription>
            Host this document as a full-screen page at its own link, with the
            access gate you choose.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {unapproved && (
          <Alert className="border-amber-300 bg-amber-50 text-amber-900">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-900">
              This document has not been approved. Anyone opening the link
              reads content that never went through review.
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="new">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="new">New link</TabsTrigger>
            <TabsTrigger value="links">Links ({links.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="new" className="space-y-4 pt-3">
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => {
                const Icon = m.icon;
                const active = mode === m.value;
                const needsMail = m.value === "email" || m.value === "invite";
                const blocked = needsMail && !emailReady;
                return (
                  <button
                    key={m.value}
                    type="button"
                    disabled={blocked}
                    title={
                      blocked
                        ? "This server has no email set up, so nobody could open the link."
                        : undefined
                    }
                    onClick={() => setMode(m.value)}
                    className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                      blocked
                        ? "cursor-not-allowed opacity-50"
                        : active
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Icon className="h-4 w-4" />
                      {m.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {blocked ? "Needs email set up" : m.hint}
                    </span>
                  </button>
                );
              })}
            </div>

            {!emailReady && (
              <p className="text-xs text-muted-foreground">
                Email and invite links are unavailable: this server has no mail
                transport configured, so the one-time link they rely on could
                never be delivered.
              </p>
            )}

            {mode === "code" && (
              <div>
                <Label htmlFor="publish-code">Passcode</Label>
                <Input
                  id="publish-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. autumn-summit"
                  className="mt-1"
                />
              </div>
            )}

            {mode === "invite" && (
              <div>
                <Label htmlFor="publish-allowlist">Invite these people</Label>
                <Textarea
                  id="publish-allowlist"
                  value={allowlist}
                  onChange={(e) => setAllowlist(e.target.value)}
                  placeholder="one email per line"
                  className="mt-1 min-h-20"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Each address gets an email with the link. Only these people can open it.
                </p>
              </div>
            )}

            <div>
              <Label htmlFor="publish-expiry">Expires (optional)</Label>
              <Input
                id="publish-expiry"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="mt-1"
              />
            </div>

            <div className="space-y-3 rounded-lg border p-3">
              <ToggleRow
                id="publish-comments"
                label="Allow comments"
                hint="Readers must give an email; comments go to the steward queue, never onto the page."
                checked={comments}
                onChange={setComments}
              />
              <ToggleRow
                id="publish-watermark"
                label="Watermark viewer email"
                hint="Only possible on the email and invite gates, which identify the reader."
                checked={watermark}
                onChange={setWatermark}
              />
              <ToggleRow
                id="publish-nodownload"
                label="Discourage download and print"
                hint="Blocks copy, right-click, drag and printing. Screenshots and developer tools still work — pair it with a watermark if the content matters."
                checked={noDownload}
                onChange={setNoDownload}
              />
            </div>

            {newLink && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs font-semibold text-muted-foreground">Your link</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 truncate text-sm">{newLink}</code>
                  <Button size="sm" variant="outline" onClick={() => handleCopy(newLink)}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            )}

            <Button onClick={handleCreate} disabled={creating} className="w-full">
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Publish
            </Button>
          </TabsContent>

          <TabsContent value="links" className="space-y-3 pt-3">
            {loadingLinks ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !links.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                This document has no links yet.
              </p>
            ) : (
              links.map((p) => {
                const dead = !!p.revoked_at;
                return (
                  <div key={p.id} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={dead ? "outline" : "secondary"}>{p.access_mode}</Badge>
                      {dead && <Badge variant="outline">revoked</Badge>}
                      {p.expires_at && !dead && (
                        <span className="text-xs text-muted-foreground">
                          until {new Date(p.expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <code className="flex-1 truncate text-xs">{linkFor(p)}</code>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCopy(linkFor(p))}
                        title="Copy link"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => loadViews(p.id)}
                        title="Who viewed"
                      >
                        {loadingViews === p.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      {!dead && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRevoke(p.id)}
                          title="Revoke"
                          className="text-destructive"
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    {views[p.id] && (
                      <div className="mt-2 border-t pt-2">
                        {!views[p.id].length ? (
                          <p className="text-xs text-muted-foreground">No views yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {views[p.id].map((v, i) => (
                              <li
                                key={i}
                                className="flex justify-between gap-3 text-xs text-muted-foreground"
                              >
                                <span className="truncate">{v.email || "anonymous"}</span>
                                <span className="flex-shrink-0">
                                  {new Date(v.created_at).toLocaleString()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
