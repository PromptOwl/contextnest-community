/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import React, { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import {
  FileText, Plus, ArrowLeft, History, Shield, Search,
  Clock, CheckCircle2, Send, Loader2, RefreshCw, Link2, Settings as SettingsIcon,
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  StewardList, StewardAssignmentModal, ReviewQueue, ReviewActions,
  SubmitForReviewModal, VersionHistory, LifecycleStatusBadge,
  type Steward, type ReviewRequest, type Version,
  type DocumentLifecycleStatus,
} from "./governance";
import { useAuth } from "../auth/AuthContext";

interface NestViewProps {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

export function NestView({ nestId, nestName, onBack }: NestViewProps) {
  const { isAdmin } = useAuth();
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
  const [showCreate, setShowCreate] = useState(false);
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

  const openVersions = async (node: any) => {
    setVersionNode(node);
    try {
      const data = await api.getNodeVersions(nestId, node.id);
      setVersionData(data);
    } catch {}
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

  const handleAssignSteward = async (data: any) => {
    await api.assignSteward(nestId, data);
    fetchData();
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
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Document
          </Button>
        </div>
      </div>

      {/* Stats Cards — only governance-related stats when stewardship is on.
          In ungoverned mode every doc is auto-approved so the pending/review
          columns are always zero and just add noise. */}
      <div
        className={`grid grid-cols-1 gap-4 mb-6 ${
          stewardshipEnabled
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

      {/* Two-column layout — PromptOwl ContextDashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8">
        <div className="space-y-4">
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
                      className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors group"
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
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {stewardshipEnabled && node.status === "draft" && (
                          <Button variant="outline" size="sm" onClick={() => setSubmitNode(node)}>
                            <Send className="h-3.5 w-3.5 mr-1" />
                            Submit
                          </Button>
                        )}
                        {stewardshipEnabled && node.status === "pending_review" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setReviewNode(node)}
                            className="border-green-200 text-green-700 hover:bg-green-50"
                          >
                            Review
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => openVersions(node)}>
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {stewardshipEnabled ? (
            <>
              {/* First-time explainer — appears above the review queue so
                  the mental model is established before users see the lists. */}
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

              <ReviewQueue
                requests={reviewQueue}
                loading={loading}
                onRefresh={fetchData}
                onSelect={(req) => {
                  const node = nodes.find((n) => n.id === req.nodeId);
                  if (node) setReviewNode(node);
                }}
              />

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
                              className={`text-xs px-2 py-1 rounded border ${
                                stewardScope === s
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
                    />
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
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
        </div>
      </div>

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

      {showCreate && (
        <CreateDocumentModal
          nestId={nestId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchData(); }}
        />
      )}

      {showAssignSteward && (
        <StewardAssignmentModal
          isOpen={showAssignSteward}
          onClose={() => setShowAssignSteward(false)}
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

function CreateDocumentModal({
  nestId,
  onClose,
  onCreated,
}: {
  nestId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    try {
      await api.createNode(nestId, {
        title,
        content,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onCreated();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>New Document</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Markdown content..."
              rows={10}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Tags</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Comma-separated (e.g., architecture, api)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" disabled={loading || !title || !content}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
        <div className="flex-1 overflow-y-auto bg-muted/30 p-4 rounded-md">
          <pre className="text-sm whitespace-pre-wrap font-mono">
            {node.content || "(no content)"}
          </pre>
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
