/**
 * NestsPage — the dashboard's landing page (/): server info, the whole-brain
 * banner and the nest grid, with archived nests behind a switch.
 */
import React, { useState, useEffect, useMemo } from "react";
import * as api from "../../../lib/api";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { reads, useNests } from "../../../lib/queries";
import { useAuth } from "../../../auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import {
  FileText, Plus, Database, Copy, Check, Bot, Monitor, Globe, Trash2, Loader2, Users, Eye, Pencil, Shield, FolderInput, CheckCircle2, FolderSync, Folder, Archive, ArchiveRestore, Bookmark,
} from "lucide-react";
import { ANON_USER_ID } from "../../../lib/constants";
import { copyTextWithToast } from "../../../lib/clipboard";
import { toast } from "sonner";
import { AllNestsBar } from "../../../components/AllNestsBar";
import { relTime, formatServerDate } from "../../../lib/dates";
import { nestNameProblem } from "../../../lib/nest-name";
import {
  scopeShowsNests,
  visibleUnsynced,
  type NestScope,
} from "../../../lib/dashboard-scope";
import { canRequestNestRemoval } from "../../../lib/nest-caps";
import { filterAndSortArchivedNests } from "../../../lib/archived-nests";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CountSkeleton } from "@/components/ui/count-skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReasonDialog } from "../../../components/governance";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DeleteNestDialog } from "../../../components/DeleteNestDialog";
import { RenameNestDialog } from "../../../components/RenameNestDialog";
import { ImportFolderModal } from "../../../components/ImportFolderModal";

/** How many nest cards render before "Show more" — a 50-nest account should
 *  not mount 50 cards on load. */
const NEST_PAGE_SIZE = 24;

// relTime / formatServerDate live in lib/dates: SQL-default timestamps arrive
// as UTC with no zone, which new Date() would read as local time.

export default function NestsPage() {
  const { openNest: onSelectNest, manageKeys: onManageKeys } = useAppNav();
  const { adminStatus, authMode, isAdmin } = useAuth();
  const currentUserEmail = adminStatus?.me?.email ?? null;
  // Served from the shared read cache: coming back to the dashboard paints the
  // previous list immediately and revalidates behind it. `isLoading` is true
  // only on a genuine first load with nothing cached, so the loader below still
  // appears exactly when it used to and never on a revisit.
  const {
    data: nestsData,
    isLoading: loading,
    refetch: refetchNests,
  } = useNests();
  const allNests = nestsData?.nests ?? [];
  // Archived is a switch on the Nests page, not a tab: the list stays
  // unfetched until someone flips it — archived nests are a rare visit, not
  // part of every dashboard load.
  const [showArchived, setShowArchived] = useState(false);
  const { data: archivedData, isLoading: archivedLoading } = useQuery({
    ...reads.nestList(true),
    enabled: showArchived,
  });
  const archivedNests: any[] = archivedData?.nests ?? [];
  // Archived grid controls — same client-side filter/sort pattern as the live
  // Nests tab (nestQuery/nestSort above), scoped to the archived list so the
  // two tabs don't share state that means different things in each.
  const [archivedQuery, setArchivedQuery] = useState("");
  const [archivedSort, setArchivedSort] = useState<"archived" | "name">(
    "archived",
  );
  const filteredArchivedNests = useMemo(
    () => filterAndSortArchivedNests(archivedNests, archivedQuery, archivedSort),
    [archivedNests, archivedQuery, archivedSort],
  );
  const [restoreTarget, setRestoreTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Grid controls — a long account is otherwise one unbroken scroll. Filtering
  // and sorting are client-side over the list already in hand; the page size
  // just bounds how many cards are mounted at once.
  const [nestQuery, setNestQuery] = useState("");
  const [nestSort, setNestSort] = useState<"activity" | "name">("activity");
  const [nestScope, setNestScope] = useState<NestScope>("all");
  const [nestPageSize, setNestPageSize] = useState(NEST_PAGE_SIZE);
  const nestOwned = (n: any): boolean =>
    n.is_owner ?? (n.permission ?? "owner") === "owner";
  const filteredNests = useMemo(() => {
    if (!scopeShowsNests(nestScope)) return [];
    const q = nestQuery.trim().toLowerCase();
    const matched = allNests.filter((n: any) => {
      if (nestScope === "owned" && !nestOwned(n)) return false;
      if (nestScope === "shared" && nestOwned(n)) return false;
      if (nestScope === "public" && n.visibility !== "public") return false;
      if (nestScope === "org" && n.visibility !== "org") return false;
      if (!q) return true;
      return (
        (n.name ?? "").toLowerCase().includes(q) ||
        (n.description ?? "").toLowerCase().includes(q)
      );
    });
    // Pinned first, then the chosen sort. One extra term rather than a separate
    // list: the search box and scope filter still decide WHICH nests appear —
    // a pinned nest that doesn't match what you typed should stay hidden — and
    // because the page-size slice happens after this, pins are always on the
    // first page.
    return [...matched].sort((a: any, b: any) => {
      const pin = Number(!!b.pinned) - Number(!!a.pinned);
      if (pin !== 0) return pin;
      return nestSort === "name"
        ? String(a.name ?? "").localeCompare(String(b.name ?? ""))
        : String(b.last_activity ?? b.created_at ?? "").localeCompare(
            String(a.last_activity ?? a.created_at ?? ""),
          );
    });
  }, [allNests, nestQuery, nestScope, nestSort]);
  const nests = filteredNests.slice(0, nestPageSize);
  // The Documents browser offers a clear affordance whenever a control is
  // narrowing its list; the Dashboard only offered one once nothing matched,
  // leaving a filtered-but-non-empty grid with no way back.
  const nestFiltersActive =
    nestQuery.trim() !== "" || nestScope !== "all" || nestSort !== "activity";
  const clearNestFilters = () => {
    setNestQuery("");
    setNestScope("all");
    setNestSort("activity");
  };
  const qc = useQueryClient();
  const [unsynced, setUnsynced] = useState<api.UnsyncedFolder[]>([]);
  const filteredUnsynced = useMemo(
    () => visibleUnsynced(unsynced, nestScope, nestQuery),
    [unsynced, nestScope, nestQuery],
  );
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // Nest ids with a pin write in flight — one click at a time per card.
  const [pinBusy, setPinBusy] = useState<Set<string>>(new Set());
  // Pending target sits in state so the modal can render the nest name in
  // the confirmation copy without prop-drilling through a separate child.
  const [deleteTarget, setDeleteTarget] = useState<
    { id: string; name: string; isImported: boolean } | null
  >(null);
  // Non-owner asking for the whole nest to be archived/deleted — same flow
  // NestView's overflow menu offers an editor, just reachable from the card
  // grid too (CU-wdqcq01wb1).
  const [nestRemovalTarget, setNestRemovalTarget] = useState<
    { id: string; name: string } | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<
    { id: string; name: string; description: string | null } | null
  >(null);
  // Unsynced folder pending discard — drives the confirm dialog.
  const [discardTarget, setDiscardTarget] = useState<
    { name: string; label: string } | null
  >(null);

  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3838";

  const fetchNests = async () => {
    // The page loader is gated on the nest list only. The banner stats are
    // derived from that same response (each nest carries document_count), so
    // there is no separate /stats round-trip. /unsynced is a best-effort extra
    // that streams into its own section as it lands — admin-gated (403 for
    // non-admins).
    qc
      .fetchQuery(reads.unsynced())
      .then((d) => setUnsynced(d.folders))
      .catch(() => setUnsynced([]));
    // The list itself comes from the cache. A refetch here is a no-op when a
    // mutation already invalidated it (the query is refetching anyway) and
    // joins the in-flight request on mount rather than doubling it.
    await refetchNests();
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

  // Delete an unsynced folder outright (leftover files the user doesn't want as
  // a nest). Confirmed via the discard dialog — it removes files from disk and
  // can't be undone.
  const handleDiscardUnsynced = async (name: string) => {
    setSyncing((s) => ({ ...s, [name]: true }));
    setSyncErrors((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });
    try {
      await api.deleteUnsyncedFolder(name);
      setUnsynced((prev) => prev.filter((f) => f.name !== name));
      setDiscardTarget(null);
    } catch (e) {
      console.error("[Dashboard] deleteUnsyncedFolder failed", name, e);
      const msg = e instanceof Error ? e.message : "Failed to delete folder";
      setSyncErrors((s) => ({ ...s, [name]: msg }));
      setDiscardTarget(null);
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
    // Say why instead of returning silently — the submit still reaches here
    // when the browser autofills or the button is driven by Enter.
    const problem = nestNameProblem(newName);
    if (problem) {
      setCreateError(problem);
      return;
    }
    setCreateError(null);
    try {
      const { nest } = await api.createNest(newName.trim(), newDesc.trim());
      setNewName(""); setNewDesc(""); setShowCreate(false);
      fetchNests();
      // Straight into the new nest — the next thing anyone does is add a
      // document to it, and the grid would make them find it first.
      onSelectNest(nest.id, nest.name, true, nest.user_id === ANON_USER_ID);
    } catch (e) {
      console.error("[Dashboard] createNest failed", e);
      setCreateError(
        e instanceof Error ? e.message : "Failed to create nest",
      );
    }
  };

  /**
   * Pin or unpin, optimistically. A pin is a one-click reordering of the grid
   * the user is looking at, so waiting a round trip to see the card move reads
   * as a dropped click. The cached row is patched first and the write's own
   * invalidation reconciles it; on failure the patch is rolled back and the
   * error surfaces, since a silently-unpinned nest is worse than a toast.
   */
  const togglePin = async (nestId: string, pinned: boolean) => {
    // Ignore a second click while the first is in flight. Both would read the
    // same `pinned` off the current render and send the SAME request rather
    // than a pin/unpin pair — the server is idempotent about that now, but
    // firing it at all is just a wasted round trip.
    if (pinBusy.has(nestId)) return;
    setPinBusy((prev) => new Set(prev).add(nestId));
    const patch = (value: boolean) =>
      qc.setQueryData(reads.nestList().queryKey, (prev: any) =>
        prev
          ? {
            ...prev,
            nests: prev.nests.map((n: any) =>
              n.id === nestId ? { ...n, pinned: value } : n,
            ),
          }
          : prev,
      );
    patch(pinned);
    try {
      await api.setNestPinned(nestId, pinned);
    } catch (err: any) {
      patch(!pinned);
      toast.error(err?.message ?? `Failed to ${pinned ? "pin" : "unpin"} this nest`);
    } finally {
      setPinBusy((prev) => {
        const next = new Set(prev);
        next.delete(nestId);
        return next;
      });
    }
  };

  const requestDelete = (nestId: string, nestName: string, isImported = false) => {
    setDeleteTarget({ id: nestId, name: nestName, isImported });
  };

  const requestNestRemoval = (nestId: string, nestName: string) => {
    setNestRemovalTarget({ id: nestId, name: nestName });
  };

  return (
    <div className="space-y-4">
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
            {/* On a cold load `nests` is [], and rendering that as 0/0 reads as
                "your content is gone". Hold a placeholder bar until the counts
                are real — `loading` is false on a cached revisit, so this never
                flashes when there's something to show. */}
            <div className="flex gap-6 text-center">
              <div>
                <div className="text-2xl font-bold">
                  {loading ? <CountSkeleton /> : allNests.length}
                </div>
                <div className="text-xs text-muted-foreground">Nests</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {loading ? (
                    <CountSkeleton />
                  ) : (
                    allNests.reduce((sum, n) => sum + Number(n.document_count ?? 0), 0)
                  )}
                </div>
                <div className="text-xs text-muted-foreground">Documents</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid md:grid-cols-2 gap-3 text-xs">
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
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
          <PageTitle
            icon={Database}
            title="Nests"
            description="Shared knowledge vaults for your team"
            className="mb-0"
            actions={
              <>
                {/* Search lives in the header on every page — one entry point,
                    not a second one styled differently here (CU-wdqcq012uv). */}
                <Button variant="outline" onClick={() => setShowImport(true)}>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Import Folder
                </Button>
                <Button onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Nest
                </Button>
              </>
            }
          />

          {/* Whole-brain landing: frame every nest as one connectable brain. */}
          {allNests.length > 0 && (
            <AllNestsBar nests={allNests} onManageKeys={onManageKeys} />
          )}

          {/* Create nest — a modal, like Import Folder, rather than a form
              that expands the page under the buttons. Both are the same kind
              of action: step aside, fill in a short form, come back
              (CU-wdqcpzzzrp). */}
          <Dialog
            open={showCreate}
            onOpenChange={(open) => {
              if (open) return;
              setShowCreate(false);
              setCreateError(null);
            }}
          >
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>New nest</DialogTitle>
                <DialogDescription>
                  A nest holds a set of documents and the governance around them.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-3">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input
                    placeholder="Team Knowledge"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      if (createError) setCreateError(null);
                    }}
                    aria-invalid={!!createError}
                    autoFocus
                  />
                  {/* Say why the button is dead as it happens — a name over the
                      length cap only disabled Create, with nothing to read
                      (CU-wdqcq018qx). The submit error still wins. */}
                  {(createError ??
                    (newName ? nestNameProblem(newName) : null)) && (
                    <p className="text-xs text-destructive">
                      {createError ?? nestNameProblem(newName)}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Description (optional)</Label>
                  <Textarea
                    placeholder="Shared docs for the engineering team"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    rows={3}
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowCreate(false);
                      setCreateError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!!nestNameProblem(newName)}>
                    Create Nest
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          {/* Grid controls — filter/sort the cards in place, the way the
              in-nest Documents browser does. Hidden until there are enough
              nests for it to matter. The Archived switch on the right is
              always there — it's the only way to reach archived nests, and
              the archived list brings its own filter/sort. */}
          {!loading && (
            <div className="flex flex-wrap items-center gap-2">
              {!showArchived && allNests.length > 5 && (
              <>
              <Input
                value={nestQuery}
                onChange={(e) => {
                  setNestQuery(e.target.value);
                  setNestPageSize(NEST_PAGE_SIZE);
                }}
                placeholder="Filter nests by name or description…"
                className="h-9 max-w-xs"
                data-testid="nest-filter-input"
              />
              <select
                value={nestScope}
                onChange={(e) => {
                  setNestScope(e.target.value as typeof nestScope);
                  setNestPageSize(NEST_PAGE_SIZE);
                }}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                aria-label="Filter nests by access"
                data-testid="nest-scope-select"
              >
                <option value="all">All nests</option>
                <option value="owned">Owned by me</option>
                <option value="shared">Shared with me</option>
                <option value="org">Organization</option>
                <option value="public">Public</option>
                {/* Sync scopes are only meaningful while a folder is actually
                    waiting to sync — otherwise "Synced only" just restates
                    "All nests". Kept mounted when selected so the Select never
                    holds a value with no matching option. */}
                {(unsynced.length > 0 ||
                  nestScope === "synced" ||
                  nestScope === "unsynced") && (
                  <>
                    <option value="synced">Synced nests only</option>
                    <option value="unsynced">Unsynced folders only</option>
                  </>
                )}
              </select>
              <select
                value={nestSort}
                onChange={(e) => setNestSort(e.target.value as typeof nestSort)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                aria-label="Sort nests"
                data-testid="nest-sort-select"
              >
                <option value="activity">Recent activity</option>
                <option value="name">Name (A–Z)</option>
              </select>
              <span className="text-xs text-muted-foreground">
                {/* Counts what the grid actually shows — unsynced cards are
                    part of that, so they belong on both sides of the "of". */}
                {filteredNests.length + filteredUnsynced.length} of{" "}
                {allNests.length + unsynced.length}
              </span>
              {nestFiltersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-muted-foreground"
                  onClick={clearNestFilters}
                  data-testid="nest-clear-filters"
                >
                  Clear filters
                </Button>
              )}
              </>
              )}
              <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
                <Archive className="h-4 w-4" />
                Archived
                <Switch
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  aria-label="Show archived nests"
                  data-testid="nest-archived-switch"
                />
              </label>
            </div>
          )}

          {/* Archived nests are put away, not gone — the switch above is the
              one place they appear, and the only place they can be restored
              from. The list replaces the live grid while it is on. */}
          {showArchived ? (
            <div className="space-y-4" data-testid="archived-nests">
            {archivedLoading ? (
              <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading archived nests…
              </div>
            ) : archivedNests.length === 0 ? (
              <div className="rounded-lg border border-dashed py-12 text-center">
                <Archive className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm font-medium">No archived nests</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Archiving a nest puts it here instead of deleting it — the option
                  is in the delete dialog on any nest you own.
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  These nests are read-only. They don't appear on your dashboard,
                  answer agents over MCP, or serve published links until restored.
                </p>
                {archivedNests.length > 5 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={archivedQuery}
                      onChange={(e) => setArchivedQuery(e.target.value)}
                      placeholder="Filter archived nests by name…"
                      className="h-9 max-w-xs"
                      data-testid="archived-filter-input"
                    />
                    <select
                      value={archivedSort}
                      onChange={(e) =>
                        setArchivedSort(e.target.value as typeof archivedSort)
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      aria-label="Sort archived nests"
                      data-testid="archived-sort-select"
                    >
                      <option value="archived">Date archived</option>
                      <option value="name">Name (A–Z)</option>
                    </select>
                    <span className="text-xs text-muted-foreground">
                      {filteredArchivedNests.length} of {archivedNests.length}
                    </span>
                    {archivedQuery.trim() !== "" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs text-muted-foreground"
                        onClick={() => setArchivedQuery("")}
                        data-testid="archived-clear-filter"
                      >
                        Clear filter
                      </Button>
                    )}
                  </div>
                )}
                {filteredArchivedNests.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-12 text-center">
                    <p className="text-sm font-medium">Nothing matches this filter</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => setArchivedQuery("")}
                    >
                      Clear filter
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredArchivedNests.map((n: any) => {
                      const openNest = () =>
                        onSelectNest(
                          n.id,
                          n.name,
                          n.is_owner ?? false,
                          n.user_id === ANON_USER_ID,
                          true,
                        );
                      return (
                        <div
                          key={n.id}
                          role="button"
                          tabIndex={0}
                          onClick={openNest}
                          onKeyDown={(e) => {
                            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                              e.preventDefault();
                              openNest();
                            }
                          }}
                          className="flex items-center gap-3 rounded-lg border px-4 py-3 hover:bg-secondary/50 cursor-pointer"
                        >
                          <Archive className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{n.name}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {n.archived_at
                                ? `Archived ${relTime(n.archived_at)}`
                                : "Archived"}
                              {n.description ? ` — ${n.description}` : ""}
                            </div>
                          </div>
                          {n.is_owner && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRestoreTarget({ id: n.id, name: n.name });
                                }}
                                data-testid="restore-nest"
                              >
                                <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />
                                Restore
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-700 hover:text-red-800"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteTarget({
                                    id: n.id,
                                    name: n.name,
                                    isImported: !!n.is_imported,
                                  });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            </div>
          ) : loading ? (
            <div className="text-center py-12 text-muted-foreground">Loading...</div>
          ) : allNests.length + unsynced.length > 0 &&
            filteredNests.length + filteredUnsynced.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="font-medium">Nothing matches this filter</p>
                <p className="text-sm text-muted-foreground mb-4">
                  {allNests.length + unsynced.length} item
                  {allNests.length + unsynced.length === 1 ? " is" : "s are"} hidden by
                  the current filter.
                </p>
                <Button
                  variant="outline"
                  onClick={clearNestFilters}
                >
                  Clear filters
                </Button>
              </CardContent>
            </Card>
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
                {filteredUnsynced.map((folder) => {
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
                          <div className="flex items-center gap-2 mt-3">
                            <Button
                              size="sm"
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
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setDiscardTarget({ name: folder.name, label: folder.label })}
                              disabled={isSyncing}
                              title="Delete this folder from the server"
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" />
                              Delete
                            </Button>
                          </div>
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
                  // Mirror server rename rule (PATCH /nests/:nestId — owner or
                  // nest-admin), plus the same admin-caretaker carve-out for the
                  // anon commons in key mode. Gate on the caller's RAW grant
                  // (`roles`) rather than `permission`, which folds license
                  // admins to "admin" on every nest — the UI deliberately hides
                  // admin affordances on other users' nests (same philosophy as
                  // NestView). Anon nests already resolve license admins to
                  // is_owner=true server-side; the authMode term is the
                  // client-side fallback matching canDelete above.
                  const canRename =
                    isOwner ||
                    (Array.isArray(nest.roles) && nest.roles.includes("admin")) ||
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
                  const canRequestRemoval = canRequestNestRemoval(effRole, canDelete);
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
                      className={`relative text-left p-4 rounded-lg border bg-card hover:bg-secondary/50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isAnonymous
                          ? "border-dashed border-amber-300"
                          : "border-border"
                        }`}
                    >
                      {/* Card actions — each gated to match server rules so
                      shared/reviewer/viewer nests don't show teasing icons.
                      Rename: owner or nest-admin (PATCH /nests/:nestId).
                      Delete: owner, or admin caretaker on the ungoverned
                      commons in key mode. An editor (or a non-owner nest
                      admin) gets the same bin icon, but it opens the
                      request-removal flow instead — same as NestView's
                      overflow menu, just reachable from the card too.
                      Pin: NO gate — a pin is this person's own bookmark, so a
                      viewer pins exactly as an owner does, and it is the one
                      action here everybody gets.
                      All three share ONE row: two absolutely-positioned groups
                      drifted apart as the gated icons came and went. */}
                      <div className="absolute top-2 right-2 flex items-center gap-0.5">
                        {canRename && (
                          <button
                            type="button"
                            aria-label={`Rename nest ${nest.name}`}
                            title="Rename nest"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget({
                                id: nest.id,
                                name: nest.name,
                                description: nest.description ?? null,
                              });
                            }}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          )}
                          {(canDelete || canRequestRemoval) && (
                          <button
                            type="button"
                            aria-label={
                              canDelete
                                ? `Delete nest ${nest.name}`
                                : `Request removal of nest ${nest.name}`
                            }
                            title={canDelete ? "Delete nest" : "Request nest removal"}
                            onClick={(e) => {
                              e.stopPropagation();
                              canDelete
                                ? requestDelete(nest.id, nest.name, !!nest.is_imported)
                                : requestNestRemoval(nest.id, nest.name);
                            }}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {/* Bookmark, not a pushpin: the pin glyph sits at an
                            angle and read as clutter beside the upright pencil
                            and bin. Not a star either — that already means
                            "prime document" elsewhere in the app. */}
                        <button
                          type="button"
                          aria-label={
                            nest.pinned
                              ? `Unpin nest ${nest.name}`
                              : `Pin nest ${nest.name}`
                          }
                          aria-pressed={!!nest.pinned}
                          title={
                            nest.pinned
                              ? "Unpin — stop keeping this nest at the top"
                              : "Pin — keep this nest at the top for you"
                          }
                          disabled={pinBusy.has(nest.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void togglePin(nest.id, !nest.pinned);
                          }}
                          className={`p-1.5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
                            nest.pinned
                              ? "text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                              : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                          }`}
                          data-testid="pin-nest"
                        >
                          <Bookmark
                            className={`h-3.5 w-3.5 ${nest.pinned ? "fill-current" : ""}`}
                          />
                        </button>
                      </div>

                      {/* Reserve room for up to three icons — a long nest name
                          ran under them once pinning added a third. */}
                      <div className="flex items-start gap-3 pr-20">
                        <div
                          className={`p-2 rounded-md ${isAnonymous ? "bg-amber-100" : "bg-primary/10"
                            }`}
                        >
                          {isAnonymous ? (
                            <Globe className="h-5 w-5 text-amber-700" />
                          ) : (
                            <FileText className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* Truncated names hide the part that tells two
                              similarly prefixed nests apart — keep the full
                              value reachable on hover/focus. */}
                          <h3 className="font-medium truncate" title={nest.name}>
                            {nest.name}
                          </h3>
                          {nest.description && (
                            <p
                              className="text-sm text-muted-foreground truncate mt-0.5"
                              title={nest.description}
                            >
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
                          {/* Provenance for imported nests: the importer is the
                          owner (import sets user_id to the caller) and the
                          import time is the row's created_at. */}
                          {nest.is_imported ? (
                            <p
                              className="flex items-center gap-1 mt-1 text-xs text-muted-foreground truncate"
                              title={`Imported ${formatServerDate(nest.created_at)}`}
                            >
                              <FolderInput className="h-3 w-3 shrink-0" />
                              <span className="truncate">
                                Imported by{" "}
                                <span className="font-medium">
                                  {nest.is_owner ? "you" : nest.owner_email || "unknown user"}
                                </span>{" "}
                                · {formatServerDate(nest.created_at)}
                              </span>
                            </p>
                          ) : null}
                          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                            <span
                              className="inline-flex items-center gap-1"
                              title="Documents"
                            >
                              <FileText className="h-3 w-3" />
                              {nest.document_count ?? 0}
                            </span>
                            {/* WHO, not just counts: shared-with (plain chips)
                            and stewards (shield-tinted chips), initials with
                            the email on hover. */}
                            {(nest.collaborator_emails?.length ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5" title="Shared with">
                                <Users className="h-3 w-3 mr-0.5" />
                                {nest.collaborator_emails!.slice(0, 4).map((e: string) => (
                                  <span
                                    key={e}
                                    title={`Shared with ${e}`}
                                    className="inline-flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-muted px-1 text-[9px] font-semibold uppercase"
                                  >
                                    {e.slice(0, 2)}
                                  </span>
                                ))}
                                {nest.collaborator_emails!.length > 4 && (
                                  <span className="text-[10px]">+{nest.collaborator_emails!.length - 4}</span>
                                )}
                              </span>
                            )}
                            {(nest.steward_emails?.length ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5" title="Stewards">
                                <Shield className="h-3 w-3 mr-0.5 text-emerald-600" />
                                {nest.steward_emails!.slice(0, 4).map((e: string) => (
                                  <span
                                    key={e}
                                    title={`Steward: ${e}`}
                                    className="inline-flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1 text-[9px] font-semibold uppercase"
                                  >
                                    {e.slice(0, 2)}
                                  </span>
                                ))}
                                {nest.steward_emails!.length > 4 && (
                                  <span className="text-[10px]">+{nest.steward_emails!.length - 4}</span>
                                )}
                              </span>
                            )}
                            {isAnonymous && !nest.stewardship_enabled && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                                title="Owned by the anonymous admin — no stewardship applied"
                              >
                                Ungoverned
                              </span>
                            )}
                            {isAnonymous && nest.stewardship_enabled && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                                title="Stewardship is enabled — drafts require review before AI use"
                              >
                                Governed
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
                              className={`px-1.5 py-0.5 rounded ${nest.visibility === "public"
                                  ? "bg-green-100 text-green-700"
                                  : nest.visibility === "org"
                                    ? "bg-blue-100 text-blue-700"
                                    : "bg-secondary text-secondary-foreground"
                                }`}
                            >
                              {nest.visibility === "org"
                                ? "Organization"
                                : nest.visibility === "public"
                                  ? "Public"
                                  : "Private"}
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
                            <span>{formatServerDate(nest.created_at)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {filteredNests.length > nests.length && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => setNestPageSize((n) => n + NEST_PAGE_SIZE)}
                    data-testid="nest-show-more"
                  >
                    Show more ({filteredNests.length - nests.length} left)
                  </Button>
                </div>
              )}
            </>
          )}
      </div>

      {renameTarget && (
        <RenameNestDialog
          nestId={renameTarget.id}
          nestName={renameTarget.name}
          nestDescription={renameTarget.description}
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          onRenamed={(updated) => {
            // Patch the cached row so the card renames instantly. The PATCH
            // already invalidated the list, so a refetch confirms this behind
            // the scenes — this is only about not blanking the name meanwhile.
            qc.setQueryData(reads.nestList().queryKey, (prev) =>
              prev
                ? {
                  ...prev,
                  nests: prev.nests.map((n: any) =>
                    n.id === updated.id
                      ? {
                        ...n,
                        name: updated.name,
                        slug: updated.slug,
                        description: updated.description,
                      }
                      : n,
                  ),
                }
                : prev,
            );
            setRenameTarget(null);
          }}
        />
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
          // Already archived: the card offers Restore, so the dialog it opens
          // is delete-only.
          onArchived={
            showArchived
              ? undefined
              : async () => {
                  setDeleteTarget(null);
                  toast.success(
                    `"${deleteTarget.name}" archived — find it under Archived`,
                  );
                  await fetchNests();
                }
          }
        />
      )}

      {/* Editor (or non-owner nest admin) asking for the nest to be archived
          or deleted — the card-grid equivalent of NestView's overflow-menu
          "Delete" entry once canDeleteNest is false. Same copy, same two
          outcomes, same endpoint. */}
      {nestRemovalTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setNestRemovalTarget(null)}
          title={`Request removal of "${nestRemovalTarget.name}"`}
          description="A nest owner or admin reviews this. Nothing is removed yet — ask for the nest to be archived (reversible, nothing deleted) or deleted outright."
          label="Why should it be removed?"
          placeholder="e.g. project wound down, superseded by another nest"
          confirmLabel="Request deletion"
          secondaryLabel="Request archive"
          onSecondary={async (reason) => {
            await api.requestTargetDeletion(
              nestRemovalTarget.id,
              "nest_archive",
              nestRemovalTarget.id,
              reason,
            );
            toast.success("Archive requested — a nest admin will review it");
          }}
          onConfirm={async (reason) => {
            await api.requestTargetDeletion(
              nestRemovalTarget.id,
              "nest",
              nestRemovalTarget.id,
              reason,
            );
            toast.success("Deletion requested — a nest admin will review it");
          }}
        />
      )}

      {/* Restoring is reversible and non-destructive, but it puts a nest back in
          front of collaborators and re-opens its published links — worth one
          deliberate click rather than an instant, silent change. */}
      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open && !restoring) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore “{restoreTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It goes back exactly as it was — same documents, versions and
              stewards. It returns to your dashboard, becomes writable again,
              and its published links and MCP access start answering.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restoring}
              onClick={async (e) => {
                // Keep the dialog up while the request is in flight; it closes
                // on success below.
                e.preventDefault();
                if (!restoreTarget) return;
                setRestoring(true);
                try {
                  await api.restoreNest(restoreTarget.id);
                  toast.success(`"${restoreTarget.name}" restored`);
                  setRestoreTarget(null);
                  await fetchNests();
                } catch (err: any) {
                  toast.error(err?.message ?? "Failed to restore this nest");
                } finally {
                  setRestoring(false);
                }
              }}
            >
              {restoring ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Restoring...
                </>
              ) : (
                "Restore nest"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!discardTarget}
        onOpenChange={(open) => {
          // Don't let a click-away close it mid-delete.
          if (!open && discardTarget && syncing[discardTarget.name]) return;
          if (!open) setDiscardTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <Trash2 className="h-4 w-4" />
              Delete folder
            </DialogTitle>
            <DialogDescription>
              Permanently delete{" "}
              <strong className="text-foreground">{discardTarget?.label}</strong>{" "}
              and its files from the server. This can't be undone. The folder
              won't be synced into a nest.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDiscardTarget(null)}
              disabled={!!discardTarget && !!syncing[discardTarget.name]}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => discardTarget && handleDiscardUnsynced(discardTarget.name)}
              disabled={!!discardTarget && !!syncing[discardTarget.name]}
            >
              {discardTarget && syncing[discardTarget.name] ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete folder
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        if (!(await copyTextWithToast(value))) return;
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
