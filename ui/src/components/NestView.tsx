/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import React, { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import {
  FileText, Plus, ArrowLeft, History, Shield, Search,
  Clock, CheckCircle2, Send, Loader2, RefreshCw, Link2, Settings as SettingsIcon,
  Pencil, Trash2,
} from "lucide-react";
import { ConnectModal } from "./ConnectModal";
import { NestSettingsModal } from "./NestSettingsModal";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  StewardList, StewardAssignmentModal, ReviewQueue, ReviewActions,
  SubmitForReviewModal, VersionHistory, LifecycleStatusBadge,
  type Steward, type ReviewRequest, type Version,
  type DocumentLifecycleStatus,
} from "./governance";
import { useAuth } from "../auth/AuthContext";
import { MarkdownEditor } from "./MarkdownEditor";

interface NestViewProps {
  nestId: string;
  nestName: string;
  onBack: () => void;
  onOpenDocument: (nodeId: string | "new") => void;
}

export function NestView({
  nestId,
  nestName,
  onBack,
  onOpenDocument,
}: NestViewProps) {
  const { isAdmin, adminStatus } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  const [nodes, setNodes] = useState<any[]>([]);
  const [stewards, setStewards] = useState<Steward[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewRequest[]>([]);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [stewardScope, setStewardScope] = useState<
    "all" | "document" | "folder" | "tag" | "nest"
  >("all");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reviewNode, setReviewNode] = useState<any | null>(null);
  const [submitNode, setSubmitNode] = useState<any | null>(null);
  const [versionNode, setVersionNode] = useState<any | null>(null);
  const [versionData, setVersionData] = useState<{
    versions: Version[];
    approvedVersion: number | null;
    currentVersion: number;
  }>({ versions: [], approvedVersion: null, currentVersion: 0 });
  const [showAssignSteward, setShowAssignSteward] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Each request is independently swallowed — if listNodes throws, we must
    // still apply stewardshipEnabled from the settings response. Previously a
    // single Promise.all + outer try/catch meant a node-list error silently
    // dropped the settings update, so toggling stewardship appeared to revert.
    const [nodesData, stewardsData, queueData, settingsData] = await Promise.all([
      api.listNodes(nestId).catch(() => ({ nodes: [] })),
      api.listStewards(nestId).catch(() => ({ stewards: [] })),
      api.getReviewQueue(nestId).catch(() => ({ requests: [], total: 0 })),
      api.getNestSettings(nestId).catch(() => ({ stewardship_enabled: false })),
    ]);
    setNodes(nodesData.nodes);
    setStewards(stewardsData.stewards);
    setReviewQueue(queueData.requests);
    setStewardshipEnabled(settingsData.stewardship_enabled);
    setLoading(false);
  }, [nestId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stats = {
    total: nodes.length,
    pending: nodes.filter((n) => n.status === "pending_review").length,
    approved: nodes.filter((n) => n.status === "approved").length,
    reviewQueue: reviewQueue.length,
  };

  const filtered = nodes.filter((n) => {
    if (statusFilter !== "all" && n.status !== statusFilter) return false;
    if (search && !n.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Caller's steward rows in this nest. Used to gate write affordances:
  // owner/admin (no steward row, or isAdmin) get full controls; an
  // assigned 'editor' steward keeps edit/submit; 'reviewer'/'viewer'
  // stewards see only read + review actions. Server still enforces.
  const myStewards = stewards.filter(
    (s) => s.userEmail.toLowerCase() === currentEmail,
  );
  const isStewardOnly = !isAdmin && myStewards.length > 0;
  const canEditDocs =
    !isStewardOnly || myStewards.some((s) => s.role === "editor");
  // Approve/reject is reviewer-only by product rule. Editors, viewers, and
  // nest owners (no steward row) cannot action a review even though server
  // would still enforce; hide the affordance to keep UI honest.
  const canReviewDocs = myStewards.some(
    (s) => s.role === "reviewer" && s.canApprove,
  );

  // Map nodeId → submitter so the per-row Review button can hide on
  // docs the current user submitted (separation-of-duties: authors must
  // not approve their own work). The server already rejects the call,
  // but hiding the affordance keeps the UI honest.
  const submitterByNode = new Map<string, string>();
  for (const r of reviewQueue) {
    submitterByNode.set(r.nodeId, r.requestedBy.toLowerCase());
  }
  // Eligibility check: does the caller hold a steward row whose scope
  // covers this node AND has canApprove? Mirrors server resolution
  // (document > folder > tag > nest), but client-side so the queue can
  // be filtered without N extra round-trips.
  const canReviewNode = (node: { id: string; tags?: string[] }) => {
    if (!node) return false;
    return myStewards.some((s) => {
      if (!s.canApprove) return false;
      if (s.scope === "nest") return true;
      if (s.scope === "document") return s.nodePattern === node.id;
      if (s.scope === "folder") {
        return (
          s.nodePattern === nestId ||
          (s.nodePattern && node.id.startsWith(s.nodePattern + "/"))
        );
      }
      if (s.scope === "tag") {
        const target = (s.tagName || "").toLowerCase().replace(/^#+/, "");
        return (node.tags || [])
          .map((t) => t.toLowerCase().replace(/^#+/, ""))
          .includes(target);
      }
      return false;
    });
  };

  // Review queue: only the assigned reviewer for the node sees the
  // request. Owners and server admins do NOT get a free pass — the
  // queue is purely a reviewer worklist; owners use the audit/version
  // panels for visibility instead. Drops own-submitted requests too
  // (separation of duties).
  const reviewableQueue = reviewQueue.filter((r) => {
    if (r.requestedBy.toLowerCase() === currentEmail) return false;
    const node = nodes.find((n) => n.id === r.nodeId);
    if (!node) return false;
    return canReviewNode(node);
  });

  const openVersions = async (node: any) => {
    setVersionNode(node);
    try {
      const data = await api.getNodeVersions(nestId, node.id);
      setVersionData(data);
    } catch { }
  };

  const handleApprove = async (note?: string) => {
    if (!reviewNode) return;
    await api.approveNode(nestId, reviewNode.id, note);
    setReviewNode(null);
    fetchData();
  };

  const handleReject = async (note: string) => {
    if (!reviewNode) return;
    await api.rejectNode(nestId, reviewNode.id, note);
    setReviewNode(null);
    fetchData();
  };

  const handleSubmitReview = async (note: string, priority: string) => {
    if (!submitNode) return;
    await api.submitForReview(nestId, submitNode.id, note, priority);
    setSubmitNode(null);
    fetchData();
  };

  const handleRemoveSteward = async (stewardId: string) => {
    const ok = window.confirm(
      "Remove this steward? They will lose approval rights immediately. The user account and any documents stay intact.",
    );
    if (!ok) return;
    try {
      await api.removeSteward(nestId, stewardId);
      fetchData();
    } catch (err: any) {
      window.alert(err?.message || "Failed to remove steward");
    }
  };

  const handleAssignSteward = async (data: any) => {
    // Modal returns scope + generic `target`. Backend's legacy shape expects
    // scope-specific fields: nodePattern (document/folder) or tagName (tag).
    const { target, ...rest } = data;
    const payload: any = { ...rest };
    if (data.scope === "document" || data.scope === "folder") {
      payload.nodePattern = target;
    } else if (data.scope === "tag") {
      payload.tagName = target;
    }
    await api.assignSteward(nestId, payload);
    fetchData();
  };

  const handleDeleteNode = async (node: any) => {
    // Plain confirm — destructive, irreversible. Promoting to a fancy
    // AlertDialog when the rest of the destructive surfaces (nest
    // delete, key revoke) standardise on one is a follow-up.
    const ok = window.confirm(
      `Delete "${node.title}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await api.deleteNode(nestId, node.id);
      fetchData();
    } catch (err: any) {
      window.alert(err?.message || "Failed to delete document");
    }
  };

  return (
    <div className="md:py-6">
      {/* Header — PromptOwl ContextDashboard layout */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-2 sm:gap-4 mb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h3 className="text-xl font-semibold">{nestName}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowConnect(true)}>
            <Link2 className="h-4 w-4 mr-2" />
            Connect
          </Button>
          {isAdmin && (
            <Button variant="outline" onClick={() => setShowSettings(true)}>
              <SettingsIcon className="h-4 w-4 mr-2" />
              Settings
            </Button>
          )}
          {stewardshipEnabled && (
            <>
              <Button variant="outline" onClick={() => api.syncStewards(nestId).then(fetchData)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Sync stewards.yaml
              </Button>
              <Button variant="outline" onClick={() => setShowAssignSteward(true)}>
                <Shield className="h-4 w-4 mr-2" />
                Assign Steward
              </Button>
            </>
          )}
          <Button onClick={() => onOpenDocument("new")}>
            <Plus className="h-4 w-4 mr-2" />
            New Document
          </Button>
        </div>
      </div>

      {/* Stats Cards — only governance-related stats when stewardship is on.
          In ungoverned mode every doc is auto-approved so the pending/review
          columns are always zero and just add noise. */}
      <div
        className={`grid grid-cols-1 gap-4 mb-6 ${stewardshipEnabled
          ? "md:grid-cols-4"
          : "md:grid-cols-1 max-w-sm"
          }`}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Documents</CardDescription>
            <CardTitle className="text-3xl">{stats.total}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" />
              <span>
                {stewardshipEnabled ? "In your context" : "Auto-approved, AI-ready"}
              </span>
            </div>
          </CardContent>
        </Card>
        {stewardshipEnabled && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Pending Review</CardDescription>
                <CardTitle className="text-3xl text-amber-600">{stats.pending}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Awaiting approval</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>AI Ready</CardDescription>
                <CardTitle className="text-3xl text-green-600">{stats.approved}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Approved for AI</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Review Queue</CardDescription>
                <CardTitle className="text-3xl text-blue-600">{stats.reviewQueue}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Shield className="h-4 w-4" />
                  <span>Need your review</span>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Tabbed layout — Documents / Review Queue / Stewards.
          When stewardship is off the latter two tabs are hidden because
          their data is empty by definition. */}
      <Tabs defaultValue="documents" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {stewardshipEnabled && (
            <TabsTrigger value="review" className="gap-2">
              Review Queue
              {reviewableQueue.length > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {reviewableQueue.length}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {stewardshipEnabled && (
            <TabsTrigger value="stewards">Stewards</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-lg">Documents</CardTitle>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 w-48 h-8"
                    />
                  </div>
                  {stewardshipEnabled && (
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-[140px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="pending_review">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {search || statusFilter !== "all" ? "No matching documents" : "No documents yet"}
                </div>
              ) : (
                <div className="space-y-2">
                  {filtered.map((node) => (
                    <div
                      key={node.id}
                      onClick={() => onOpenDocument(node.id)}
                      className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors group cursor-pointer"
                      data-testid={`document-row-${node.id}`}
                    >
                      <FileText className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{node.title}</span>
                          {stewardshipEnabled && (
                            <LifecycleStatusBadge
                              status={(node.status as DocumentLifecycleStatus) || "draft"}
                              size="sm"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                          <span>v{node.version || 1}</span>
                          {node.tags?.length > 0 && (
                            <>
                              <span>·</span>
                              <span className="truncate">{node.tags.slice(0, 3).join(" ")}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {stewardshipEnabled && node.status === "draft" && canEditDocs && (
                          <Button variant="outline" size="sm" onClick={() => setSubmitNode(node)}>
                            <Send className="h-3.5 w-3.5 mr-1" />
                            Submit
                          </Button>
                        )}
                        {stewardshipEnabled &&
                          node.status === "pending_review" &&
                          submitterByNode.get(node.id) !== currentEmail &&
                          canReviewDocs && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setReviewNode(node)}
                              className="border-green-200 text-green-700 hover:bg-green-50"
                            >
                              Review
                            </Button>
                          )}
                        {node.status !== "pending_review" && canEditDocs && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onOpenDocument(node.id)}
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => openVersions(node)} title="History">
                          <History className="h-3.5 w-3.5" />
                        </Button>
                        {canEditDocs && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteNode(node)}
                            title="Delete"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {stewardshipEnabled && (
          <TabsContent value="review" className="space-y-4">
            <ReviewQueue
              requests={reviewableQueue}
              loading={loading}
              onRefresh={fetchData}
              onSelect={(req) => {
                const node = nodes.find((n) => n.id === req.nodeId);
                if (node) setReviewNode(node);
              }}
            />
          </TabsContent>
        )}

        {stewardshipEnabled && (
          <TabsContent value="stewards" className="space-y-4">
            <Card className="border-blue-200 bg-blue-50/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-700" />
                  How stewardship works
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-2 leading-relaxed">
                <p>
                  <strong className="text-foreground">New documents start as drafts.</strong>{" "}
                  They're not available to AI queries until a steward approves them.
                </p>
                <p>
                  <strong className="text-foreground">Stewards</strong> are
                  people you name to govern content by scope. Resolution
                  priority (first match wins):
                </p>
                <ol className="list-decimal list-inside ml-2 space-y-0.5">
                  <li><strong>Document</strong> — this exact doc</li>
                  <li><strong>Folder</strong> — everything under a path</li>
                  <li><strong>Tag</strong> — everything with #tag</li>
                  <li><strong>Nest</strong> — anything not matched above</li>
                </ol>
                <p>
                  <strong className="text-foreground">Reviewers</strong> can
                  approve/reject; <strong className="text-foreground">editors</strong> can edit;{" "}
                  <strong className="text-foreground">viewers</strong> have read access.
                  Authors can't approve their own work.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">Stewards</CardTitle>
                    <CardDescription>
                      {stewards.length === 0
                        ? "Nobody's governing content yet"
                        : "Who governs what"}
                    </CardDescription>
                  </div>
                  {stewards.length > 0 && (
                    <div className="flex items-center gap-2">
                      {(["all", "document", "folder", "tag", "nest"] as const).map(
                        (s) => (
                          <button
                            key={s}
                            onClick={() => setStewardScope(s)}
                            className={`text-xs px-2 py-1 rounded border ${stewardScope === s
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-muted-foreground border-border hover:bg-secondary"
                              }`}
                          >
                            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {stewards.length === 0 ? (
                  <div className="text-sm space-y-3 py-2">
                    <p className="text-muted-foreground leading-relaxed">
                      Without stewards, every draft needs the nest owner to
                      approve. Add an editor/reviewer to delegate approvals
                      for a tag, folder, or specific doc.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setShowAssignSteward(true)}
                    >
                      <Shield className="h-3.5 w-3.5 mr-2" />
                      Assign your first steward
                    </Button>
                  </div>
                ) : (
                  <StewardList
                    stewards={
                      stewardScope === "all"
                        ? stewards
                        : stewards.filter((s) => s.scope === stewardScope)
                    }
                    showScope
                    onAddSteward={() => setShowAssignSteward(true)}
                    onRemove={handleRemoveSteward}
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {!stewardshipEnabled && (
        <Card className="mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Stewardship is off
            </CardTitle>
            <CardDescription>
              New documents are auto-approved and immediately AI-ready.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Enable stewardship to require steward approval before documents become AI-ready.
              Versioning stays on either way.
            </p>
            {isAdmin ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setShowSettings(true)}
              >
                <SettingsIcon className="h-3.5 w-3.5 mr-2" />
                Open Settings
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                Only the server admin can enable stewardship.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Modals */}
      {showConnect && (
        <ConnectModal
          isOpen={showConnect}
          onClose={() => setShowConnect(false)}
          nestId={nestId}
          nestName={nestName}
        />
      )}

      {showSettings && (
        <NestSettingsModal
          nestId={nestId}
          nestName={nestName}
          stewardshipEnabled={stewardshipEnabled}
          onClose={() => setShowSettings(false)}
          onChanged={() => { setShowSettings(false); fetchData(); }}
        />
      )}

      {showAssignSteward && (
        <StewardAssignmentModal
          isOpen={showAssignSteward}
          onClose={() => setShowAssignSteward(false)}
          nestId={nestId}
          onSubmit={handleAssignSteward}
        />
      )}

      {submitNode && (
        <SubmitForReviewModal
          isOpen={!!submitNode}
          onClose={() => setSubmitNode(null)}
          documentTitle={submitNode.title}
          currentVersion={submitNode.version || 1}
          onSubmit={handleSubmitReview}
        />
      )}

      {reviewNode && (
        <ReviewDocumentModal
          node={reviewNode}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={() => setReviewNode(null)}
        />
      )}

      {versionNode && (
        <Dialog open onOpenChange={() => setVersionNode(null)}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>{versionNode.title}</DialogTitle>
            </DialogHeader>
            <VersionHistory
              versions={versionData.versions}
              currentVersion={versionData.currentVersion}
              approvedVersion={versionData.approvedVersion}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Sub-modals ─────────────────────────────────────────────────

function ReviewDocumentModal({
  node,
  onApprove,
  onReject,
  onClose,
}: {
  node: any;
  onApprove: (note?: string) => Promise<void>;
  onReject: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{node.title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto rounded-md">
          {node.content ? (
            <MarkdownEditor
              content={node.content}
              onChange={() => { }}
              editable={false}
            />
          ) : (
            <p className="text-sm text-muted-foreground p-4">(no content)</p>
          )}
        </div>
        <DialogFooter>
          <ReviewActions
            documentTitle={node.title}
            version={node.version || 1}
            onApprove={onApprove}
            onReject={onReject}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
