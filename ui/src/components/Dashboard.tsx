/**
 * Dashboard — landing page with server info + nest list.
 */
import React, { useState, useEffect } from "react";
import * as api from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import {
  FileText, Plus, Database, Copy, Check, Bot, Monitor, Terminal, Globe, Trash2, Loader2, Users, Eye, Pencil, Shield, FolderInput, CheckCircle2, FolderSync, Folder,
} from "lucide-react";
import { ANON_USER_ID } from "../lib/constants";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeleteNestDialog } from "./DeleteNestDialog";
import { ImportFolderModal } from "./ImportFolderModal";

interface DashboardProps {
  onSelectNest: (
    nestId: string,
    name: string,
    isOwner: boolean,
    isAnonOwned: boolean,
  ) => void;
}

interface ServerStats {
  nests: number;
  documents: number;
  users: number;
}

export function Dashboard({ onSelectNest }: DashboardProps) {
  const { adminStatus, authMode, isAdmin } = useAuth();
  const currentUserEmail = adminStatus?.me?.email ?? null;
  const [nests, setNests] = useState<any[]>([]);
  const [unsynced, setUnsynced] = useState<api.UnsyncedFolder[]>([]);
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // Pending target sits in state so the modal can render the nest name in
  // the confirmation copy without prop-drilling through a separate child.
  const [deleteTarget, setDeleteTarget] = useState<
    { id: string; name: string; isImported: boolean } | null
  >(null);

  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3838";

  const fetchNests = async () => {
    setLoading(true);
    try {
      // /stats and /unsynced are best-effort. /stats can 503 on license-gated
      // servers; /unsynced is admin-gated, so non-admin callers get 403. In
      // both cases the dashboard still renders with the rest of the data.
      const [nestsData, statsData, unsyncedData] = await Promise.all([
        api.listNests(),
        api.getServerStats().catch((e) => {
          console.error("[Dashboard] getServerStats failed", e);
          return null;
        }),
        api.listUnsyncedFolders().catch(() => ({ folders: [] })),
      ]);
      setNests(nestsData.nests);
      setStats(statsData);
      setUnsynced(unsyncedData.folders);
    } catch (e) {
      console.error("[Dashboard] fetchNests failed", e);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (name: string) => {
    setSyncing((s) => ({ ...s, [name]: true }));
    setSyncErrors((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });
    try {
      await api.syncUnsyncedFolder(name);
      await fetchNests();
    } catch (e) {
      console.error("[Dashboard] syncUnsyncedFolder failed", name, e);
      const msg = e instanceof Error ? e.message : "Failed to sync folder";
      setSyncErrors((s) => ({ ...s, [name]: msg }));
    } finally {
      setSyncing((s) => {
        const next = { ...s };
        delete next[name];
        return next;
      });
    }
  };

  // Re-fetch whenever the signed-in user changes. In open mode the
  // Dashboard stays mounted across login (authenticated never flips),
  // so without this the list keeps showing the anonymous-admin view
  // until the page is manually reloaded.
  useEffect(() => { fetchNests(); }, [currentUserEmail]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.createNest(newName, newDesc);
      setNewName(""); setNewDesc(""); setShowCreate(false);
      fetchNests();
    } catch (e) {
      console.error("[Dashboard] createNest failed", e);
    }
  };

  const requestDelete = (nestId: string, nestName: string, isImported = false) => {
    setDeleteTarget({ id: nestId, name: nestName, isImported });
  };

  return (
    <div className="space-y-6">
      {/* Server info banner */}
      <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg">Your Community Server</CardTitle>
              <CardDescription>
                Running at{" "}
                <code className="text-xs bg-white/60 px-1.5 py-0.5 rounded font-mono">
                  {serverUrl}
                </code>
                <CopyInline value={serverUrl} />
              </CardDescription>
            </div>
            <div className="flex gap-6 text-center">
              <div>
                <div className="text-2xl font-bold">
                  {stats?.nests ?? nests.length}
                </div>
                <div className="text-xs text-muted-foreground">Nests</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {stats ? stats.documents : "—"}
                </div>
                <div className="text-xs text-muted-foreground">Documents</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {stats ? stats.users : "—"}
                </div>
                <div className="text-xs text-muted-foreground">Users</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid md:grid-cols-3 gap-3 text-xs">
            <ClientHint
              icon={<Bot className="h-4 w-4" />}
              title="Hootie"
              desc="Settings → Vault → Remote Server → paste URL"
            />
            <ClientHint
              icon={<Monitor className="h-4 w-4" />}
              title="Claude Desktop"
              desc="Add MCP endpoint per nest via Connect button"
            />
            <ClientHint
              icon={<Terminal className="h-4 w-4" />}
              title="CLI"
              desc={`ctx push --server ${serverUrl}`}
              mono
            />
          </div>
        </CardContent>
      </Card>

      {/* Nests header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Nests</h2>
          <p className="text-sm text-muted-foreground">
            Shared knowledge vaults for your team
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <FolderInput className="h-4 w-4 mr-2" />
            Import Folder
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Nest
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="Team Knowledge"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label>Description (optional)</Label>
                <Input
                  placeholder="Shared docs for the engineering team"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Create Nest</Button>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Nest list */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : nests.length === 0 && unsynced.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <Database className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No nests yet</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first nest to start sharing knowledge with your team
            </p>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create First Nest
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {unsynced.map((folder) => {
              const isSyncing = !!syncing[folder.name];
              const errMsg = syncErrors[folder.name];
              return (
                <div
                  key={`unsynced:${folder.name}`}
                  className="relative text-left p-4 rounded-lg border border-dashed border-blue-300 bg-blue-50/40"
                >
                  <div className="flex items-start gap-3 pr-2">
                    <div className="p-2 rounded-md bg-blue-100">
                      <Folder className="h-5 w-5 text-blue-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium truncate">{folder.label}</h3>
                      <p
                        className="text-xs text-muted-foreground font-mono truncate mt-0.5"
                        title={folder.name}
                      >
                        {folder.name}
                      </p>
                      <p className="text-sm text-muted-foreground truncate mt-1">
                        {folder.mdCount} markdown file
                        {folder.mdCount === 1 ? "" : "s"} waiting to sync
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200"
                          title="Folder is on disk but not registered as a nest"
                        >
                          <Folder className="h-3 w-3" />
                          Unsynced
                        </span>
                      </div>
                      <Button
                        size="sm"
                        className="mt-3"
                        onClick={() => handleSync(folder.name)}
                        disabled={isSyncing}
                      >
                        {isSyncing ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                            Syncing…
                          </>
                        ) : (
                          <>
                            <FolderSync className="h-3.5 w-3.5 mr-2" />
                            Sync to Nest
                          </>
                        )}
                      </Button>
                      {errMsg && (
                        <p
                          role="alert"
                          className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 break-words"
                          title={errMsg}
                        >
                          {errMsg}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {nests.map((nest) => {
              const isAnonymous = nest.user_id === ANON_USER_ID;
              const openNest = () =>
                onSelectNest(
                  nest.id,
                  nest.name,
                  nest.is_owner ?? (nest.permission ?? "owner") === "owner",
                  isAnonymous,
                );
              // Server now stamps `permission` + `is_owner` on each nest.
              // Fall back to legacy behaviour (treat as owner) when the
              // field is absent so older API responses don't strip
              // ownership during a rolling deploy.
              const permission: string = nest.permission ?? "owner";
              const isOwner: boolean = nest.is_owner ?? permission === "owner";
              const isShared = !isOwner;
              // Mirror server delete rule: real owner, or admin caretaker
              // on the ungoverned commons in key mode. Open-mode anon
              // nests already report is_owner=true via effectivePermission.
              const canDelete =
                isOwner ||
                (isAnonymous && authMode !== "open" && isAdmin);
              // Card role badge — derive from merged effective roles
              // (collaborator + steward), not just the collaborator permission.
              // A steward editor/reviewer resolves to permission='read'
              // server-side, so keying off permission alone mislabeled them
              // "Viewer". Precedence: admin > editor > reviewer > viewer.
              const roleList: string[] = Array.isArray(nest.roles)
                ? nest.roles
                : [];
              const effRole = roleList.includes("admin")
                ? "admin"
                : roleList.includes("editor")
                  ? "editor"
                  : roleList.includes("reviewer")
                    ? "reviewer"
                    : roleList.includes("viewer")
                      ? "viewer"
                      : permission === "admin"
                        ? "admin"
                        : permission === "write"
                          ? "editor"
                          : permission === "read"
                            ? "viewer"
                            : null;
              const roleBadge = effRole
                ? ({
                    admin: {
                      label: "Admin",
                      Icon: Shield,
                      cls: "bg-purple-50 text-purple-700 border-purple-200",
                      title: "Admin — full access except deleting the nest",
                    },
                    editor: {
                      label: "Editor",
                      Icon: Pencil,
                      cls: "bg-indigo-50 text-indigo-700 border-indigo-200",
                      title: "Editor — you can read and edit documents",
                    },
                    reviewer: {
                      label: "Reviewer",
                      Icon: CheckCircle2,
                      cls: "bg-amber-50 text-amber-700 border-amber-200",
                      title:
                        "Reviewer — you can approve or reject submissions",
                    },
                    viewer: {
                      label: "Viewer",
                      Icon: Eye,
                      cls: "bg-slate-50 text-slate-700 border-slate-200",
                      title: "View only — you can read but not edit",
                    },
                  }[effRole])
                : null;
              const RoleIcon = roleBadge?.Icon ?? null;
              return (
                <div
                  key={nest.id}
                  role="button"
                  tabIndex={0}
                  onClick={openNest}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openNest();
                    }
                  }}
                  className={`relative text-left p-4 rounded-lg border bg-card hover:bg-secondary/50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isAnonymous
                      ? "border-dashed border-amber-300"
                      : "border-border"
                  }`}
                >
                  {/* Delete — gated to match server rules (owner, or admin
                      caretaker on the ungoverned commons in key mode).
                      Keeps the affordance off cards the user can't act on
                      so shared/reviewer/viewer nests don't show a teasing
                      Trash icon. */}
                  {canDelete && (
                    <button
                      type="button"
                      aria-label={`Delete nest ${nest.name}`}
                      title="Delete nest"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete(nest.id, nest.name, !!nest.is_imported);
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}

                  <div className="flex items-start gap-3 pr-7">
                    <div
                      className={`p-2 rounded-md ${
                        isAnonymous ? "bg-amber-100" : "bg-primary/10"
                      }`}
                    >
                      {isAnonymous ? (
                        <Globe className="h-5 w-5 text-amber-700" />
                      ) : (
                        <FileText className="h-5 w-5 text-primary" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium truncate">{nest.name}</h3>
                      {nest.description && (
                        <p className="text-sm text-muted-foreground truncate mt-0.5">
                          {nest.description}
                        </p>
                      )}
                      {isShared && (
                        <p
                          className="flex items-center gap-1 mt-1 text-xs text-blue-700 truncate"
                          title={
                            nest.owner_email
                              ? `Shared by ${nest.owner_email}`
                              : "Shared with you"
                          }
                        >
                          <Users className="h-3 w-3 shrink-0" />
                          <span className="truncate">
                            Shared by{" "}
                            <span className="font-medium">
                              {nest.owner_email || "unknown user"}
                            </span>
                          </span>
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                        {isAnonymous && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                            title="Owned by the anonymous admin — no stewardship applied"
                          >
                            Ungoverned
                          </span>
                        )}
                        {isShared && roleBadge && RoleIcon && (
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${roleBadge.cls}`}
                            title={roleBadge.title}
                          >
                            <RoleIcon className="h-3 w-3" />
                            {roleBadge.label}
                          </span>
                        )}
                        <span
                          className={`px-1.5 py-0.5 rounded capitalize ${
                            nest.visibility === "public"
                              ? "bg-green-100 text-green-700"
                              : "bg-secondary text-secondary-foreground"
                          }`}
                        >
                          {nest.visibility}
                        </span>
                        {nest.is_imported ? (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200"
                            title="Imported from a folder — its files were copied into the workspace"
                          >
                            <FolderInput className="h-3 w-3" />
                            Imported
                          </span>
                        ) : null}
                        <span>{new Date(nest.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {deleteTarget && (
        <DeleteNestDialog
          nestId={deleteTarget.id}
          nestName={deleteTarget.name}
          isImported={deleteTarget.isImported}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={async () => {
            setDeleteTarget(null);
            await fetchNests();
          }}
        />
      )}

      <ImportFolderModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        onImported={fetchNests}
      />
    </div>
  );
}

function ClientHint({
  icon,
  title,
  desc,
  mono,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 p-2 rounded bg-white/40">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        <div className={`text-muted-foreground ${mono ? "font-mono text-[10px]" : ""} truncate`}>
          {desc}
        </div>
      </div>
    </div>
  );
}

function CopyInline({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="ml-1 inline-flex items-center hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}
