/**
 * Workflows → Agents: metacognition agents (CU-wdqcq041jm).
 *
 * An agent document the SERVER runs as a persona, on the nest's model key. It
 * reads inside the folders you give it, and every change it wants is filed as
 * a proposal for a reviewer — it never publishes. Configure one (owner/admin),
 * run it now, and see what each run cost and did. Scheduling is the ordinary
 * Activity → Schedules row; the full step-by-step trace is the Run tab.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Play, Pencil, Trash2, Plus, Brain, ChevronDown, ChevronRight } from "lucide-react";
import {
  listMetacognitionAgents,
  saveMetacognitionAgent,
  deleteMetacognitionAgent,
  runMetacognitionAgent,
  listNodesMeta,
  listRuns,
  type MetacognitionAgent,
  type MetacognitionAgentConfig,
  type MetacognitionTrace,
  type RunSummary,
} from "../lib/api";
import { formatServerDate } from "../lib/dates";
import { AgentActivity } from "./AgentActivity";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

interface Draft {
  node_id: string;
  enabled: boolean;
  name: string;
  avatar: string;
  read: string;
  propose: string;
  max_steps: number;
  max_proposals: number;
  max_seconds: number;
  max_tokens: number;
  feeds: string;
  mcp: string;
  model: string;
}

const EMPTY: Draft = {
  node_id: "",
  enabled: true,
  name: "",
  avatar: "",
  read: "",
  propose: "",
  max_steps: 12,
  max_proposals: 5,
  max_seconds: 300,
  max_tokens: 300_000,
  feeds: "",
  mcp: "",
  model: "",
};

const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function toDraft(a: MetacognitionAgent): Draft {
  return {
    node_id: a.node_id,
    enabled: a.enabled,
    name: a.persona.name,
    avatar: a.persona.avatar ?? "",
    read: a.scope.read.join(", "),
    propose: a.scope.propose.join(", "),
    max_steps: a.caps.max_steps,
    max_proposals: a.caps.max_proposals,
    max_seconds: a.caps.max_seconds,
    max_tokens: a.caps.max_tokens,
    feeds: a.feeds.map((f) => `${f.name} ${f.url}`).join("\n"),
    mcp: a.mcp_servers
      .map((m) => [m.name, m.url, m.allowed_tools.join(","), m.auth_env ?? ""].join(" ").trim())
      .join("\n"),
    model: a.model ?? "",
  };
}

/** "name url" per line → feeds; "name url tool1,tool2 [ENV_KEY]" → MCP servers. */
function toConfig(d: Draft): MetacognitionAgentConfig & { enabled: boolean } {
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    enabled: d.enabled,
    persona: { name: d.name.trim(), avatar: d.avatar.trim() || null },
    scope: { read: list(d.read), propose: list(d.propose) },
    caps: {
      max_steps: d.max_steps,
      max_proposals: d.max_proposals,
      max_seconds: d.max_seconds,
      max_tokens: d.max_tokens,
    },
    feeds: lines(d.feeds).map((l) => {
      const [name, url] = l.split(/\s+/);
      return { name, url };
    }),
    mcp_servers: lines(d.mcp).map((l) => {
      const [name, url, tools, auth_env] = l.split(/\s+/);
      return { name, url, allowed_tools: list(tools ?? ""), ...(auth_env ? { auth_env } : {}) };
    }),
    model: d.model.trim() || null,
  };
}

function Avatar({ avatar, name }: { avatar: string | null; name: string }) {
  if (avatar && /^https:\/\//.test(avatar)) {
    return <img src={avatar} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />;
  }
  return (
    <span className="h-7 w-7 rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 flex items-center justify-center text-sm shrink-0">
      {avatar || name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** One line of what a run did and cost. */
export function RunCost({ trace }: { trace: MetacognitionTrace | null | undefined }) {
  if (!trace) return null;
  if (trace.skipped) return <span className="text-muted-foreground">Skipped: {trace.skipped}</span>;
  const u = trace.usage;
  const total = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0;
  return (
    <span className="text-muted-foreground" data-testid="metacognition-run-cost">
      {trace.proposals ?? 0} proposal{trace.proposals === 1 ? "" : "s"} · {tokens(total)} tokens
      {typeof trace.est_cost_usd === "number" ? ` · ~$${trace.est_cost_usd.toFixed(3)}` : ""} ·{" "}
      {trace.billing === "own_key" ? "your key (not billed by PromptOwl)" : "PromptOwl credits"}
      {trace.stopped_by && trace.stopped_by !== "end_turn" ? ` · stopped: ${trace.stopped_by.replace(/_/g, " ")}` : ""}
    </span>
  );
}

export function MetacognitionPanel({
  nestId,
  canConfigure,
  onOpenRun,
}: {
  nestId: string;
  canConfigure: boolean;
  /** Open a run's trace (Workflows → Run). */
  onOpenRun?: (runId: string) => void;
}) {
  const [agents, setAgents] = useState<MetacognitionAgent[]>([]);
  const [agentDocs, setAgentDocs] = useState<Array<{ id: string; title: string }>>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Which agents have their activity history open.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const load = useCallback(async () => {
    try {
      const [a, n, r] = await Promise.all([
        listMetacognitionAgents(nestId),
        listNodesMeta(nestId).then((x) => x.nodes).catch(() => []),
        listRuns(nestId, undefined, 100).catch(() => [] as RunSummary[]),
      ]);
      setAgents(a);
      setAgentDocs(n.filter((d: any) => d.type === "agent").map((d: any) => ({ id: d.id, title: d.title })));
      setRuns(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A run in flight finishes on its own; poll while any is.
  const anyRunning = runs.some((r) => r.status === "running" && agents.some((a) => a.node_id === r.agent_node));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const unconfigured = useMemo(
    () => agentDocs.filter((d) => !agents.some((a) => a.node_id === d.id)),
    [agentDocs, agents],
  );
  const titleOf = (id: string) => agentDocs.find((d) => d.id === id)?.title || id.replace(/^nodes\//, "");

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveMetacognitionAgent(nestId, draft.node_id, toConfig(draft));
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const num = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => (d ? { ...d, [k]: Number(e.target.value) || 0 } : d));
  const text = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => (d ? { ...d, [k]: e.target.value } : d));

  return (
    <div className="space-y-4" data-testid="metacognition-panel">
      <p className="text-sm text-muted-foreground">
        A metacognition agent is an agent document this server runs for you, under its own name. It reads
        the folders you give it, checks its feeds and MCP tools, looks back at how its earlier proposals were
        judged, and <b>proposes</b> fixes — every change goes to a reviewer, nothing is published by the
        agent. Runs use PromptOwl credits, or your own key if you've added one. Schedule it under Activity.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline" />
        </div>
      ) : agents.length === 0 && !draft ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <Brain className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
          <p className="text-sm font-medium mb-1">No metacognition agents yet</p>
          <p className="text-xs text-muted-foreground">
            {agentDocs.length
              ? canConfigure
                ? "Turn one of this nest's agent documents into one below."
                : "An owner or admin can turn an agent document into one."
              : "Create an agent document first (Documents → New → type Agent). Its approved text is the agent's instructions."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {agents.map((a) => {
            const last = runs.find((r) => r.agent_node === a.node_id);
            return (
              <div key={a.node_id} className="px-3 py-2.5 space-y-1" data-testid="metacognition-agent-row">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Avatar avatar={a.persona.avatar} name={a.persona.name} />
                  <span className="font-medium truncate shrink-0 max-w-[16rem]">{a.persona.name}</span>
                  <span className="text-xs text-muted-foreground truncate" title={a.node_id}>
                    runs {titleOf(a.node_id)}
                  </span>
                  {!a.enabled && (
                    <Badge variant="outline" className="text-[10px]">
                      off
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-[10px] shrink-0" title="Where it may read / propose">
                    reads {a.scope.read.length ? a.scope.read.join(", ") : "everything"} · proposes in{" "}
                    {a.scope.propose[0] === "*" ? "what it reads" : a.scope.propose.length ? a.scope.propose.join(", ") : "nothing (proposals off)"}
                  </Badge>
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs shrink-0"
                    onClick={() => toggle(a.node_id)}
                    aria-expanded={open.has(a.node_id)}
                    data-testid="metacognition-activity-toggle"
                  >
                    {open.has(a.node_id) ? (
                      <ChevronDown className="h-3.5 w-3.5 mr-1" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 mr-1" />
                    )}
                    Activity
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs shrink-0"
                    disabled={!a.enabled || busy === a.node_id || last?.status === "running"}
                    onClick={async () => {
                      setBusy(a.node_id);
                      try {
                        await runMetacognitionAgent(nestId, a.node_id);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not start the run");
                      } finally {
                        setBusy(null);
                      }
                    }}
                    data-testid="metacognition-run-now"
                  >
                    {busy === a.node_id || last?.status === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5 mr-1" />
                    )}
                    {last?.status === "running" ? "Running" : "Run now"}
                  </Button>
                  {canConfigure && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        title="Edit"
                        onClick={() => setDraft(toDraft(a))}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                        title="Stop it being a metacognition agent (the document stays)"
                        onClick={async () => {
                          await deleteMetacognitionAgent(nestId, a.node_id);
                          await load();
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
                {last && (
                  <div className="pl-9 text-xs space-y-0.5">
                    <div>
                      <Badge
                        variant={last.status === "succeeded" ? "default" : last.status === "running" ? "secondary" : "destructive"}
                        className="text-[10px] mr-1.5"
                      >
                        {last.status === "cancelled" && (last.trace as MetacognitionTrace | null)?.skipped ? "skipped" : last.status}
                      </Badge>
                      <span className="text-muted-foreground mr-1.5">{formatServerDate(last.started_at)}</span>
                      <RunCost trace={last.trace as MetacognitionTrace | null} />
                    </div>
                    {(last.trace as MetacognitionTrace | null)?.summary && (
                      <div className="text-muted-foreground line-clamp-2" data-testid="metacognition-run-summary">
                        {(last.trace as MetacognitionTrace).summary}
                      </div>
                    )}
                  </div>
                )}
                {open.has(a.node_id) && (
                  <div className="pl-9 pt-2 pb-1">
                    <AgentActivity
                      nestId={nestId}
                      nodeId={a.node_id}
                      onOpenRun={onOpenRun}
                      refreshKey={`${last?.id ?? ""}:${last?.status ?? ""}`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canConfigure && !draft && unconfigured.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDraft({ ...EMPTY, node_id: unconfigured[0].id, name: unconfigured[0].title.slice(0, 60) })}
          data-testid="metacognition-add"
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Make an agent document a metacognition agent
        </Button>
      )}

      {draft && (
        <div className="rounded-lg border p-4 space-y-3" data-testid="metacognition-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Agent document</Label>
              {agents.some((a) => a.node_id === draft.node_id) ? (
                <div className="text-sm">{titleOf(draft.node_id)}</div>
              ) : (
                <select
                  value={draft.node_id}
                  onChange={(e) => setDraft({ ...draft, node_id: e.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {unconfigured.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex items-end gap-2">
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
              <span className="text-sm">{draft.enabled ? "On" : "Off"}</span>
            </div>
            <div className="space-y-1">
              <Label>Persona name</Label>
              <Input value={draft.name} onChange={text("name")} placeholder="Archivist" data-testid="metacognition-name" />
            </div>
            <div className="space-y-1">
              <Label>Avatar (an emoji or an https image URL)</Label>
              <Input value={draft.avatar} onChange={text("avatar")} placeholder="🦉" />
            </div>
            <div className="space-y-1">
              <Label>Reads in (folders, comma-separated; empty = whole nest)</Label>
              <Input value={draft.read} onChange={text("read")} placeholder="gtm, ops" data-testid="metacognition-read" />
            </div>
            <div className="space-y-1">
              <Label>Proposes in (inside what it reads; * = anywhere it reads; empty = no proposals)</Label>
              <Input value={draft.propose} onChange={text("propose")} placeholder="gtm" data-testid="metacognition-propose" />
            </div>
          </div>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label>Turns per run</Label>
              <Input type="number" min={1} max={50} value={draft.max_steps} onChange={num("max_steps")} />
            </div>
            <div className="space-y-1">
              <Label>Proposals per run</Label>
              <Input type="number" min={0} max={20} value={draft.max_proposals} onChange={num("max_proposals")} />
            </div>
            <div className="space-y-1">
              <Label>Seconds per run</Label>
              <Input type="number" min={10} max={1800} value={draft.max_seconds} onChange={num("max_seconds")} />
            </div>
            <div className="space-y-1">
              <Label>Tokens per run</Label>
              <Input type="number" min={10000} max={2000000} step={10000} value={draft.max_tokens} onChange={num("max_tokens")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Feeds — one per line: name https-url</Label>
            <Textarea rows={2} value={draft.feeds} onChange={text("feeds")} placeholder="news https://example.com/feed.xml" />
          </div>
          <div className="space-y-1">
            <Label>
              MCP servers — one per line: name https-url allowed,tools [MCP_… env name holding a bearer token]
            </Label>
            <Textarea
              rows={2}
              value={draft.mcp}
              onChange={text("mcp")}
              placeholder="desk https://mcp.example.com/mcp search_tickets,get_ticket MCP_DESK_TOKEN"
            />
            <p className="text-[11px] text-muted-foreground">
              Only the tools you list can be called. What feeds and MCP tools return is treated as untrusted data,
              and the agent can only act on it by proposing.
            </p>
          </div>
          <div className="space-y-1 sm:w-1/2">
            <Label>Model (optional; default is the nest's Hootie model)</Label>
            <Input value={draft.model} onChange={text("model")} placeholder="claude-sonnet-5" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving || !draft.name.trim() || !draft.node_id} data-testid="metacognition-save">
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
