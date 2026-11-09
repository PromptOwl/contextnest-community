/**
 * WelcomeScreen — first-run onboarding (PO-1185). Shown in place of the nest
 * list for a signed-in person with no nest of their own, and from Home via
 * "Getting started". Three steps on one page:
 *
 *   1. Your nest        — "Create my nest" (one click, "<Name>'s nest")
 *   2. Connect agents   — one tile per harness, each with the nest's MCP URL
 *                         and the connect proof (the server saw a real read)
 *   3. Fill it          — write, distill a site or repo, or connect Slack
 *
 * Pure logic lives in lib/onboarding.ts; every server call is /onboarding/*.
 * Motion is tied to real events only: a spinner while a request or a poll is
 * actually in flight, the progress bar moving as the distill job reports steps.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { ArrowRight, Check, CircleDashed, ExternalLink, Loader2, MessageSquare, PenLine, Sparkles, TriangleAlert } from "lucide-react";
import * as api from "../lib/api";
import {
  connectionLabel,
  distillProgress,
  generalInstructionsUrl,
  harnessTiles,
  slackReturn,
  slackTile,
  type HarnessTile,
  type OnboardingState,
} from "../lib/onboarding";
import { HOOTIE_OPEN_EVENT } from "../lib/hootie-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

interface Props {
  state: OnboardingState;
  logoUrl: string;
  userName?: string | null;
  onOpenNest: (nest: { id: string; name: string }) => void;
  onManageKeys: () => void;
  /** Closed locally after Skip / Done (the server is told first). */
  onClosed: () => void;
}

function Step({ n, title, done, children, description }: { n: number; title: string; done?: boolean; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 sm:grid-cols-[2rem_1fr]" aria-labelledby={`welcome-step-${n}`}>
      <div
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium",
          done ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
        )}
        aria-hidden
      >
        {done ? <Check className="h-3.5 w-3.5" /> : n}
      </div>
      <div className="min-w-0 space-y-3">
        <div>
          <h2 id={`welcome-step-${n}`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Monogram({ tile, logoUrl }: { tile: HarnessTile; logoUrl: string }) {
  if (tile.id === "hootie") return <img src={logoUrl} alt="" className="h-6 w-6 object-contain" />;
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground" aria-hidden>
      {tile.name.charAt(0)}
    </span>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <article className="prose prose-sm dark:prose-invert max-w-none prose-pre:text-xs prose-code:before:content-none prose-code:after:content-none prose-code:break-all">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </article>
  );
}

/** The connect proof for one open tile: polls while the tile is open and not yet proven. */
function ConnectionCheck({ tile, nestId }: { tile: HarnessTile; nestId: string }) {
  // The moment the tile opened: only reads after it count for this tile.
  const [since] = useState(() => new Date(Date.now() - 5_000).toISOString());
  const q = useQuery({
    queryKey: ["onboarding", "connection", nestId, tile.id, since],
    queryFn: () => api.getConnectionEvidence(nestId, since),
    refetchInterval: (query) => (query.state.data?.connected ? false : 3_000),
    refetchIntervalInBackground: false,
  });
  const label = connectionLabel(q.data, tile);
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
        label.state === "connected" && "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
      )}
      role="status"
      data-testid={`connection-${tile.id}`}
    >
      {label.state === "waiting" ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Check className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <span>
        {label.text}
        {label.state === "waiting" && <span className="text-muted-foreground"> — ask it to list the documents in your nest.</span>}
        {label.state === "other" && <span className="text-muted-foreground"> If that was {tile.name}, it is connected.</span>}
      </span>
    </div>
  );
}

function TilePanel({ tile, state, onOpenNest, onManageKeys }: { tile: HarnessTile; state: OnboardingState; onOpenNest: Props["onOpenNest"]; onManageKeys: () => void }) {
  const nest = state.nest!;
  return (
    <Card className="border-dashed" data-testid={`tile-panel-${tile.id}`}>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{tile.name}</h3>
          <span className="text-sm text-muted-foreground">{tile.maker}</span>
          {!tile.confirmed && (
            <Badge variant="secondary" className="gap-1">
              <TriangleAlert className="h-3 w-3" aria-hidden /> Steps not confirmed
            </Badge>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">This nest's MCP URL</span>
            <CopyButton text={nest.mcp_url} variant="ghost" className="h-6 px-2" />
          </div>
          <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs">{nest.mcp_url}</pre>
        </div>
        {tile.inApp && (
          <Button
            onClick={() => {
              onOpenNest(nest);
              // The panel lives under the shell; open it once the nest page is up.
              setTimeout(() => window.dispatchEvent(new Event(HOOTIE_OPEN_EVENT)), 0);
            }}
          >
            <MessageSquare className="mr-2 h-4 w-4" /> Ask Hootie about {nest.name}
          </Button>
        )}
        <Markdown text={tile.steps} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {tile.source && (
            <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={tile.source} target="_blank" rel="noopener noreferrer">
              {tile.name} documentation <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={generalInstructionsUrl(state.server_url)} target="_blank" rel="noopener noreferrer">
            General MCP instructions <ExternalLink className="h-3 w-3" />
          </a>
          {tile.auth === "key" && !state.open_mode && (
            <button type="button" className="underline-offset-2 hover:underline" onClick={onManageKeys}>
              Create an API key
            </button>
          )}
        </div>
        <ConnectionCheck tile={tile} nestId={nest.id} />
      </CardContent>
    </Card>
  );
}

function DistillCard({ state, onOpenNest }: { state: OnboardingState; onOpenNest: Props["onOpenNest"] }) {
  const nest = state.nest;
  const [url, setUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<{ reason: string; prompt: string } | null>(null);
  const job = useQuery({
    queryKey: ["onboarding", "distill", jobId],
    queryFn: () => api.getDistillJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.job.status === "running" ? 1_500 : false),
  });
  const progress = distillProgress(job.data?.job);
  const running = job.data?.job.status === "running" || (!!jobId && !job.data);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nest || !url.trim()) return;
    setStarting(true);
    setAgentPrompt(null);
    try {
      const out = await api.startDistill(nest.id, url.trim());
      if (out.mode === "server") setJobId(out.job.id);
      else setAgentPrompt({ reason: out.reason, prompt: out.prompt });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The distill could not start.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden /> Distill a site or repo
        </CardTitle>
        <CardDescription>
          Give a public site or a public GitHub repo. {state.distill.mode === "server" ? "This server writes a first set of linked documents into your nest." : "You get a prompt to give your connected agent."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com or github.com/owner/repo"
            aria-label="Site or repo URL"
            disabled={!nest || running}
            inputMode="url"
          />
          <Button type="submit" disabled={!nest || !url.trim() || starting || running}>
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Distill"}
          </Button>
        </form>
        {jobId && (
          <div className="space-y-1.5" role="status" data-testid="distill-progress">
            <Progress value={progress.percent} aria-label="Distill progress" />
            <p className={cn("text-xs", job.data?.job.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{progress.label || "Starting"}</p>
            {job.data?.job.status === "done" && nest && (
              <Button variant="outline" size="sm" onClick={() => onOpenNest(nest)}>
                See the documents <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
        {agentPrompt && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{agentPrompt.reason}</span>
              <CopyButton text={agentPrompt.prompt} variant="outline" className="h-7 px-2" label="Copy prompt" />
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">{agentPrompt.prompt}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SlackCard({ state }: { state: OnboardingState }) {
  const s = slackTile(state.connectors.slack, !!state.nest);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden /> Connect Slack
        </CardTitle>
        <CardDescription>{s.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {s.action === "connect" && state.nest && (
          <Button asChild variant="outline">
            <a href={api.slackConnectUrl(state.nest.id)}>Connect Slack</a>
          </Button>
        )}
        {s.action === "connected" && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400" data-testid="slack-connected">
            <Check className="h-4 w-4" /> Connected
          </p>
        )}
        {s.action === "admin" && state.connectors.slack.admin_settings_path && (
          <Button asChild variant="outline">
            <a href={state.connectors.slack.admin_settings_path}>Open Server settings</a>
          </Button>
        )}
        {(s.action === "connect" || s.action === "connected") && <p className="text-xs text-muted-foreground">{state.connectors.slack.disclosure}</p>}
      </CardContent>
    </Card>
  );
}

export function WelcomeScreen({ state, logoUrl, userName, onOpenNest, onManageKeys, onClosed }: Props) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [openTile, setOpenTile] = useState<string | null>(null);
  const nest = state.nest;

  const tiles = useMemo(
    () =>
      nest
        ? harnessTiles({ nest, serverUrl: state.server_url, openMode: state.open_mode, mcpOauthEnabled: state.mcp_oauth_enabled, hootieEnabled: state.hootie_enabled })
        : [],
    [nest, state.server_url, state.open_mode, state.mcp_oauth_enabled, state.hootie_enabled],
  );

  // Back from Slack's OAuth: say so once and drop the query string.
  useEffect(() => {
    const r = slackReturn(window.location.search);
    if (!r.returned) return;
    if (r.connected) toast.success("Slack is connected to your nest.");
    window.history.replaceState(null, "", `${window.location.pathname}${r.clean}`);
    void qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
  }, [qc]);

  const create = async () => {
    setCreating(true);
    try {
      const out = await api.createMyNest();
      qc.setQueryData(ONBOARDING_QUERY_KEY, out.state);
      void qc.invalidateQueries({ queryKey: ["nests"] });
      setOpenTile("hootie");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Your nest could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const close = async (thenOpen?: boolean) => {
    setClosing(true);
    try {
      const next = await api.dismissOnboarding();
      qc.setQueryData(ONBOARDING_QUERY_KEY, next);
      onClosed();
      if (thenOpen && nest) onOpenNest(nest);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close the welcome screen.");
    } finally {
      setClosing(false);
    }
  };

  const first = (userName ?? "").trim().split(/\s+/)[0];
  const active = tiles.find((t) => t.id === openTile) ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-6" data-testid="welcome-screen">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <img src={logoUrl} alt="" className="mt-0.5 h-9 w-9 object-contain" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{first ? `Welcome, ${first}` : "Welcome"}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A nest is a governed knowledge base your agents read from. Make yours, connect an agent, then fill it.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void close()} disabled={closing} data-testid="welcome-skip">
          Skip
        </Button>
      </header>

      <Step n={1} title="Your nest" done={!!nest} description={nest ? undefined : "One click. You own it, and it is private until you share it."}>
        {nest ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{nest.name}</p>
              <p className="text-xs text-muted-foreground">Private · owned by you</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenNest(nest)}>
              Open
            </Button>
          </div>
        ) : state.can_create_nest ? (
          <Button onClick={create} disabled={creating} data-testid="create-my-nest">
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create {state.suggested_nest_name}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Only a server admin can create nests on this server. Ask your admin to make one for you or share one with you.</p>
        )}
      </Step>

      <Step n={2} title="Connect your agents" description="Pick the agent you use. Each one gets this nest's address, and the check turns green when it really reads your nest.">
        {!nest ? (
          <p className="text-sm text-muted-foreground">Create your nest first.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="Agents">
              {tiles.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={openTile === t.id}
                  data-testid={`tile-${t.id}`}
                  onClick={() => setOpenTile(openTile === t.id ? null : t.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    openTile === t.id && "border-primary bg-muted/40",
                  )}
                >
                  <Monogram tile={t} logoUrl={logoUrl} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.confirmed ? t.maker : "General steps"}</span>
                  </span>
                </button>
              ))}
            </div>
            {active && <TilePanel key={active.id} tile={active} state={state} onOpenNest={onOpenNest} onManageKeys={onManageKeys} />}
          </>
        )}
      </Step>

      <Step n={3} title="Fill it" description="Start from nothing, or let a source do the first pass.">
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <PenLine className="h-4 w-4 text-muted-foreground" aria-hidden /> Start from scratch
              </CardTitle>
              <CardDescription>Write a document, or use Add with AI in your nest to draft one from a few lines.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" disabled={!nest} onClick={() => nest && onOpenNest(nest)}>
                Open my nest
              </Button>
            </CardContent>
          </Card>
          <DistillCard state={state} onOpenNest={onOpenNest} />
          <SlackCard state={state} />
        </div>
      </Step>

      <footer className="flex items-center justify-between border-t pt-6">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleDashed className="h-3.5 w-3.5" aria-hidden /> Open this again any time from Getting started on Home.
        </p>
        <Button onClick={() => void close(true)} disabled={closing || !nest} data-testid="welcome-done">
          Done <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </footer>
    </div>
  );
}
