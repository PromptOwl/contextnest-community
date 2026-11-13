/**
 * Control room → the trace drawer (po-1186 CR2): one ledger entry's chain,
 * run → evidence and verdict → proposal → review → saved version → source,
 * from GET /ledger/:entryId. A missing hop the entry should have is shown as
 * a gap, never hidden. The "Reason" row is the agent's own reason (its code
 * in plain words, plus its one-line summary), never the verdict repeated.
 *
 * A side sheet on Radix Dialog (focus trap, Esc, focus return). It slides in
 * once on open and respects reduced motion; nothing else moves.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, CircleAlert, Copy, Download, ExternalLink, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLedgerTrace, type CrTrace } from "../../../lib/api";
import { STATE_BADGE, formatDuration, fmtWhen, reasonLine, rowTitle, sourceLabel, usd, verdictBadge, type LedgerEntry } from "../../../lib/control-room-overview";
import { ErrorLine, KV, Loading, Mono, ToneBadge } from "./parts";
import { cn } from "@/lib/utils";

const CARD_KIND: Record<string, string> = { single: "1 card · in the thread", multi: "One card, several items · in the thread", dm: "A direct message" };

/**
 * A private-nest row (N1) is drawn from the ledger row itself: the server
 * already removed everything but counts, and a sealed personal nest refuses
 * a trace read to anyone but its owner, a server admin included.
 */
function fromRedactedRow(e: LedgerEntry): CrTrace {
  return {
    api_version: "2026-11",
    entry: e,
    chain: {
      run: e.run ? { id: e.run.id, agent_node: e.agent.node_id, status: e.run.outcome ?? "succeeded", outcome: e.run.outcome, started_at: e.at, finished_at: null, cost_usd: e.run.cost_usd } : null,
      verdict: e.verdict,
      proposal: e.proposal ? { count: e.proposal.counts?.proposals ?? 1 } : null,
      review: e.review ? { state: e.proposal?.state ?? "approved", at: e.review.at } : null,
      version: e.commit ? { version: e.commit.version, at: e.review?.at ?? e.at } : null,
      source: null,
    },
    steps: [],
    gaps: [],
  };
}

export function TraceSheet({
  entryId,
  known,
  onClose,
  onOpenDoc,
}: {
  entryId: string | null;
  /** The row as the ledger list served it, when the drawer was opened from the list. */
  known?: LedgerEntry | null;
  onClose: () => void;
  onOpenDoc: (nestId: string, nodeId: string) => void;
}) {
  const [state, setState] = useState<{ id: string; data: CrTrace | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!entryId) return;
    if (known && known.entry_id === entryId && known.redacted === "n1") {
      setState({ id: entryId, data: fromRedactedRow(known), error: null });
      return;
    }
    let live = true;
    setState({ id: entryId, data: null, error: null });
    getLedgerTrace(entryId).then(
      (data) => live && setState({ id: entryId, data, error: null }),
      (e: unknown) => live && setState({ id: entryId, data: null, error: e instanceof Error ? e.message : "Couldn't load this entry." }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, known?.entry_id, known?.redacted]);
  const t = state?.id === entryId ? state.data : null;

  return (
    <DialogPrimitive.Root open={!!entryId} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l bg-background shadow-xl focus:outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-right"
          data-testid="cr-trace"
          aria-describedby={undefined}
        >
          <div className="flex items-start gap-3 border-b px-4 py-4 sm:px-5">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-muted-foreground">{t ? `${fmtWhen(t.entry.at)} · ${t.entry.redacted === "n1" ? "DM · private nest" : t.entry.nest.label}` : " "}</div>
              <DialogPrimitive.Title className="mt-0.5 text-base font-semibold [overflow-wrap:anywhere]" data-testid="cr-trace-title">
                {t ? traceTitle(t) : "Loading…"}
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="outline" size="icon" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            {state?.error && <ErrorLine text={state.error} />}
            {!t && !state?.error && <Loading what="the trace" />}
            {t && <Chain t={t} onOpenDoc={onOpenDoc} />}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function traceTitle(t: CrTrace): string {
  const e = t.entry;
  if (e.redacted === "n1") return "DM · private nest · title hidden";
  const title = rowTitle(e);
  if (title) return title;
  if (e.verdict.code === "error") return "Run failed";
  return `No proposal: ${reasonLine(e).text}`;
}

function Step({ n, title, gap, pending, children }: { n: number; title: string; gap?: boolean; pending?: boolean; children: ReactNode }) {
  return (
    <li className="relative pb-5 pl-9 last:pb-1">
      <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border" aria-hidden />
      <span
        className={cn(
          "absolute left-0 top-0 grid h-6 w-6 place-items-center rounded-full text-sm font-semibold",
          gap ? "bg-amber-100 text-amber-800" : pending ? "border bg-background text-muted-foreground" : "bg-primary text-primary-foreground",
        )}
        aria-hidden
      >
        {gap ? "!" : n}
      </span>
      <h3 className="text-sm font-semibold leading-6">{title}</h3>
      {children}
    </li>
  );
}

function Note({ tone, icon, children }: { tone: "ok" | "info" | "warn"; icon: ReactNode; children: ReactNode }) {
  const cls = {
    ok: "border-green-200 bg-green-50 text-green-900",
    info: "border bg-muted/50 text-foreground",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
  }[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm", cls)}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function EvidenceRef({ r }: { r: { kind: string; ref: string } }) {
  if (/^https?:\/\//i.test(r.ref)) {
    return (
      <a href={r.ref} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">
        {r.ref.replace(/^https?:\/\//i, "")}
      </a>
    );
  }
  return <Mono className="[overflow-wrap:anywhere]">{r.ref}</Mono>;
}

const HOP_WORD: Record<string, string> = { run: "the run", verdict: "the verdict", proposal: "the proposal", review: "the review", version: "the saved version", source: "the source" };

function Chain({ t, onOpenDoc }: { t: CrTrace; onOpenDoc: (nestId: string, nodeId: string) => void }) {
  const e = t.entry;
  const c = t.chain;
  const isListener = e.agent.source === "surfaces";
  const private_ = e.redacted === "n1";
  const [vt, vl] = verdictBadge(e.verdict.code);
  const reason = reasonLine(e);
  const complete = !private_ && t.gaps.length === 0 && !!c.version;
  let n = 0;
  const steps: ReactNode[] = [];

  steps.push(
    <Step key="run" n={++n} title="Agent run">
      <KV
        rows={[
          ["Agent", <><span>{e.agent.name ?? "Agent"}</span> <span className="text-muted-foreground">{sourceLabel(e.agent.source)}</span></>],
          c.run ? ["Run", <Mono>{c.run.id}</Mono>] : ["Run", <span className="text-muted-foreground">Too few messages to send to the model, so no run</span>],
          ["Started", fmtWhen(c.run?.started_at ?? e.at)],
          ["Cost", usd(e.run?.cost_usd ?? c.run?.cost_usd ?? 0)],
          !!c.run?.external_ref && ["Reported as", <Mono>{c.run.external_ref}</Mono>],
          isListener && !!c.verdict?.model && ["Model", `${c.verdict.model}${c.verdict.prompt_version ? ` · prompt ${c.verdict.prompt_version}` : ""}`],
          !!c.run && c.run.outcome !== "succeeded" && ["Outcome", c.run.outcome ?? c.run.status],
        ]}
      />
    </Step>,
  );

  if (private_) {
    steps.push(
      <Step key="verdict" n={++n} title="Verdict">
        <KV rows={[["Verdict", <ToneBadge tone={vt}>{vl}</ToneBadge>], ["Nest", "DM · private nest"]]} />
      </Step>,
    );
  } else if (e.verdict.code === "error") {
    steps.push(
      <Step key="stopped" n={++n} title="Stopped" gap>
        <KV
          rows={[
            ["Outcome", <ToneBadge tone="rejected">Failed</ToneBadge>],
            ["Reason", <ReasonCell reason={reason} />],
            ["Steps", `${t.steps.length} recorded before it stopped`],
          ]}
        />
      </Step>,
    );
  } else {
    const ev = e.decision?.evidence ?? null;
    steps.push(
      <Step key="verdict" n={++n} title="Evidence and verdict">
        <KV
          rows={[
            isListener && e.verdict.message_count != null && ["Evidence", `${e.verdict.message_count} ${e.verdict.message_count === 1 ? "message" : "messages"} in one conversation window`],
            ["Verdict", <ToneBadge tone={vt}>{vl}</ToneBadge>],
            ["Reason", <ReasonCell reason={reason} />],
            !!e.verdict.kinds?.length && ["Kind", e.verdict.kinds.map((k) => k.replace(/_/g, " ")).join(", ")],
            e.decision?.confidence != null && ["Confidence", `${Math.round(e.decision.confidence * 100)}%`],
            !!ev?.length && ["Evidence", <div className="space-y-0.5">{ev.map((r, i) => <div key={i}><EvidenceRef r={r} /></div>)}</div>],
            !isListener && e.decision && e.decision.summary === null && ["Detail", <span className="text-muted-foreground">Hidden at your access level</span>],
          ]}
        />
        {isListener && (
          <p className="mt-1.5 text-sm text-muted-foreground">The messages were held encrypted for at most 24 hours to judge this window, then deleted. No text is kept.</p>
        )}
      </Step>,
    );
    if (e.verdict.code === "no_op") {
      steps.push(
        <li key="end" className="pl-9">
          <Note tone="info" icon={<Check className="h-4 w-4" />}>
            No proposal, so the chain ends here. That is the normal case.{isListener ? " Nobody was pinged and nothing was posted in the channel." : ""}
          </Note>
        </li>,
      );
    } else if (e.verdict.code === "act" && !c.proposal) {
      const outcome = t.steps.find((s) => s.action === "outcome")?.detail as { kind?: string; ref?: string; status?: string } | null | undefined;
      steps.push(
        <Step key="outcome" n={++n} title="Outcome">
          <KV
            rows={[
              ["Did", outcome?.kind ? outcome.kind.replace(/_/g, " ") : "Acted outside the nest"],
              !!outcome?.ref && ["Link", <EvidenceRef r={{ kind: "url", ref: outcome.ref }} />],
              ["Nest change", "None. Acting outside the nest needs no review here."],
            ]}
          />
        </Step>,
      );
    }
  }

  if (c.proposal && !private_) {
    const p = c.proposal;
    steps.push(
      <Step key="proposal" n={++n} title="Proposal">
        <KV
          rows={[
            isListener
              ? !!e.proposal?.title && ["Title", e.proposal.title]
              : !!p.node_id && ["Document", <Mono>{String(p.node_id).replace(/^nodes\//, "")}</Mono>],
            isListener ? ["Card", CARD_KIND[p.card_kind as string] ?? "A card in the thread"] : ["Card", `Review request${p.count > 1 ? ` (${p.count})` : ""}`],
            !!p.items?.length && p.items.length > 1 && ["Items", `${p.items.length}`],
          ]}
        />
      </Step>,
    );
  } else if (c.proposal && private_) {
    steps.push(
      <Step key="proposal" n={++n} title="Proposal">
        <KV rows={[["Items", `${e.proposal?.counts?.proposals ?? 1}`]]} />
      </Step>,
    );
  }

  if (c.proposal) {
    const state = c.review?.state ?? e.proposal?.state ?? "pending";
    const badge = STATE_BADGE[state === "approved" && e.proposal?.edited ? "edited" : state] ?? STATE_BADGE.pending;
    if (!c.review) {
      steps.push(
        <Step key="review" n={++n} title="Review" pending>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === "expired"
              ? "Nobody decided in 7 days. The card updated once, the draft was deleted, and the same proposal is held back for 30 days."
              : isListener
                ? "Waiting for a named person in the thread. The card ends after 7 days if nobody decides."
                : "Waiting in the review queue."}
          </p>
        </Step>,
      );
    } else {
      steps.push(
        <Step key="review" n={++n} title="Review">
          <KV
            rows={[
              ["Outcome", <ToneBadge tone={badge[0]}>{badge[1]}</ToneBadge>],
              !private_ && !!c.review.by && ["By", c.review.by],
              ["After", formatDuration(Date.parse(c.review.at) - Date.parse(c.run?.started_at ?? e.at))],
              !private_ && !!c.review.reason && ["Their reason", c.review.reason],
            ]}
          />
        </Step>,
      );
    }
  }

  if (c.version) {
    const v = c.version;
    steps.push(
      <Step key="version" n={++n} title="Saved version">
        <KV
          rows={[
            !private_ && !!v.node_id && [
              "Document",
              <button type="button" className="text-left font-mono text-[13px] text-primary underline underline-offset-2 [overflow-wrap:anywhere]" onClick={() => onOpenDoc(e.nest.id, v.node_id!)}>
                {v.node_id!.replace(/^nodes\//, "")}
              </button>,
            ],
            ["Version", `v${v.version ?? "?"} · served to agents`],
            !private_ && !!(v.saved_by ?? v.author) && ["Saved as", `${v.saved_by ?? v.author}, not the agent`],
          ]}
        />
      </Step>,
    );
  }

  if (c.source && !private_ && isListener && c.version) {
    steps.push(
      <Step key="source" n={++n} title="Source">
        <KV
          rows={[
            ["Conversation", c.source.label ?? "A channel"],
            !!c.source.url && [
              "Link",
              <a href={c.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
                Open in Slack <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>,
            ],
          ]}
        />
      </Step>,
    );
  }

  const exportRow = () => {
    const blob = new Blob([JSON.stringify(t.entry, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${t.entry.entry_id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("section", "ledger");
      u.searchParams.set("entry", t.entry.entry_id);
      await navigator.clipboard.writeText(u.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard refused: nothing to do */
    }
  };

  return (
    <div className="space-y-4" data-testid="cr-trace-body">
      {complete && (
        <Note tone="ok" icon={<Check className="h-4 w-4" />}>
          <b>Complete chain.</b> Every step from the run to the saved version is on record.
        </Note>
      )}
      {t.gaps.length > 0 && (
        <Note tone="warn" icon={<CircleAlert className="h-4 w-4" />}>
          <b>Missing from the record:</b> {t.gaps.map((g) => HOP_WORD[g] ?? g).join(", ")}. The steps that are on record are below.
        </Note>
      )}
      <ol data-testid="cr-trace-chain">{steps}</ol>
      {private_ && (
        <Note tone="info" icon={<Lock className="h-4 w-4" />}>
          This row comes from someone's private nest. Only its owner sees the title, the reviewer and the source. Counts still feed the dashboard and rollups.
        </Note>
      )}
      {!isListener && !private_ && t.steps.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold">Steps the agent reported</h3>
          <div className="divide-y rounded-lg border text-sm" data-testid="cr-trace-steps">
            {t.steps.map((s) => (
              <div key={s.seq} className="grid grid-cols-[2rem_6rem_minmax(0,1fr)] gap-2 px-3 py-2">
                <span className="tabular-nums text-muted-foreground">{s.seq}</span>
                <Mono>{s.action}</Mono>
                <span className="min-w-0 [overflow-wrap:anywhere]">{stepText(s)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="text-sm" onClick={copyLink}>
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {copied ? "Link copied" : "Copy link"}
        </Button>
        <Button variant="outline" size="sm" className="text-sm" onClick={exportRow}>
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Export this row
        </Button>
      </div>
    </div>
  );
}

function ReasonCell({ reason }: { reason: ReturnType<typeof reasonLine> }) {
  return (
    <div data-testid="cr-trace-reason">
      <span>{reason.text}</span>
      {reason.code && <Mono className="ml-1.5 text-muted-foreground">{reason.code}</Mono>}
      {reason.detail && <div className="text-muted-foreground">{reason.detail}</div>}
    </div>
  );
}

function stepText(s: CrTrace["steps"][number]): string {
  const d = s.detail;
  if (!d) return s.node_id ? s.node_id.replace(/^nodes\//, "") : "Detail hidden at your access level";
  if (s.action === "decision") return [d.verdict, d.reason_code ? reasonLine({ verdict: { code: d.verdict, reason_code: d.reason_code, kinds: null, message_count: null }, decision: null }).text : null].filter(Boolean).join(" · ");
  if (s.action === "proposal") return d.node_id ? `review opened · ${String(d.node_id).replace(/^nodes\//, "")}` : "review opened";
  if (s.action === "outcome") return [d.kind?.replace?.(/_/g, " "), d.status].filter(Boolean).join(" · ");
  if (s.node_id) return s.node_id.replace(/^nodes\//, "");
  return Object.keys(d).slice(0, 3).join(", ");
}
