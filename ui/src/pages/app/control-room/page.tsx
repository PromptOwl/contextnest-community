/**
 * Control room (po-1186): one page for what the agents are doing, how the
 * nest is filling up, the Slack setup and how it all works.
 *
 * CR3 shipped the shell, Setup and How it works; CR2 fills Overview,
 * Decision ledger and Agents from the CR1 ledger and rollups. Who sees what
 * (decision 3, 2026-11-09): a server admin sees every nest and runs Setup;
 * a nest owner or admin sees the nests they administer (the org ledger and
 * rollups narrow themselves server-side) and gets no Setup tab.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { PageTitle } from "@/components/ui/page-title";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import { listNests } from "../../../lib/api";
import { RANGES, rangeFor, type RangeDays } from "../../../lib/control-room-overview";
import { SetupWizard, useSetupState } from "./SetupWizard";
import { HowItWorks } from "./HowItWorks";
import { Overview } from "./Overview";
import { Ledger } from "./Ledger";
import { Agents } from "./Agents";
import type { ControlRoomScope, NestRef } from "./scope";

const TABS = ["overview", "ledger", "agents", "setup", "how"] as const;
/** `?section=` (App owns `?tab=` and strips it on every navigation). */
const SECTION_PARAM = "section";
/** `?entry=<ledger entry id>` opens the trace drawer (Copy link). */
const ENTRY_PARAM = "entry";
type Tab = (typeof TABS)[number];

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function tabFromUrl(): Tab | null {
  const t = param(SECTION_PARAM);
  return (TABS as readonly string[]).includes(t ?? "") ? (t as Tab) : null;
}

function setParams(p: Record<string, string | null>) {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(p)) {
      if (v === null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    window.history.replaceState(window.history.state, "", u.toString());
  } catch {
    /* no URL sync; the view still changes */
  }
}

export default function ControlRoomPage() {
  const { isAdmin } = useAuth();
  const nav = useAppNav();
  const setup = useSetupState();
  const [tab, setTabNow] = useState<Tab | null>(tabFromUrl);
  const [entry, setEntryNow] = useState<string | null>(() => param(ENTRY_PARAM));
  // Until the reader picks a tab: a server admin with setup unfinished lands
  // on Setup; everyone else on Overview — decided once, when the facts load.
  useEffect(() => {
    if (tab !== null) return;
    if (!isAdmin) setTabNow(entry ? "ledger" : "overview");
    else if (setup.loaded) setTabNow(entry ? "ledger" : setup.progress.count === 5 ? "overview" : "setup");
  }, [setup.loaded, tab, setup.progress.count, isAdmin, entry]);
  const shown: Tab = tab === "setup" && !isAdmin ? "overview" : tab ?? (isAdmin ? "setup" : "overview");

  const setTab = useCallback((t: string) => {
    setTabNow(t as Tab);
    setParams({ [SECTION_PARAM]: t, ...(t !== "ledger" ? { [ENTRY_PARAM]: null } : {}) });
  }, []);
  const setEntry = useCallback((id: string | null) => {
    setEntryNow(id);
    setParams({ [ENTRY_PARAM]: id });
  }, []);
  useEffect(() => {
    const onPop = () => {
      setTabNow(tabFromUrl());
      setEntryNow(param(ENTRY_PARAM));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Scope: nest picker, range, refresh.
  const [nestId, setNestId] = useState<string | null>(null);
  const [days, setDays] = useState<RangeDays>(14);
  const [tick, setTick] = useState(0);
  const [nests, setNests] = useState<NestRef[]>([]);
  useEffect(() => {
    listNests()
      .then((r) =>
        setNests(
          (r.nests ?? [])
            .filter((n: any) => n && typeof n.id === "string" && (isAdmin || n.is_owner || n.permission === "owner" || n.permission === "admin"))
            .map((n: any) => ({ id: n.id, name: String(n.name ?? n.id) })),
        ),
      )
      .catch(() => setNests([]));
  }, [isAdmin]);
  // A refresh when the reader comes back to the browser tab — a new report is
  // then the only thing that moves (Agents). No polling.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFor(days), [days, tick]);
  const nestName = useCallback(
    (id: string) => nests.find((n) => n.id === id)?.name ?? setup.nests.find((n) => n.id === id)?.name ?? "a nest",
    [nests, setup.nests],
  );
  const scope: ControlRoomScope = { nestId, days, range, nests, isServerAdmin: isAdmin, nestName, tick };

  const onSetup = isAdmin ? () => setTab("setup") : null;
  const unfinished = isAdmin && setup.loaded && setup.progress.count < 5;
  const dataTab = shown === "overview" || shown === "ledger" || shown === "agents";

  const openDoc = (nid: string, nodeId: string) => nav.openReview(nid, nestName(nid), nodeId);
  const openNest = (nid: string) => nav.openNest(nid, nestName(nid), false, false);

  return (
    <div data-testid="control-room-page" className="min-w-0">
      <PageTitle
        icon={Gauge}
        title="Control room"
        description="See what your agents are doing, how the nest is filling up, and trace any decision back to where it came from."
        actions={
          dataTab ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Nest"
                className="h-9 max-w-[12rem] rounded-md border bg-background px-2 text-sm"
                value={nestId ?? ""}
                onChange={(e) => setNestId(e.target.value || null)}
                data-testid="cr-nest-select"
              >
                <option value="">{isAdmin ? "All nests" : "All my nests"}</option>
                {nests.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Range"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={days}
                onChange={(e) => setDays(Number(e.target.value) as RangeDays)}
                data-testid="cr-range-select"
              >
                {RANGES.map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => setTick((t) => t + 1)}>
                <RefreshCw className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ) : undefined
        }
      />
      <Tabs value={shown} onValueChange={setTab}>
        <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label="Control room sections" className="h-auto">
            <TabsTrigger value="overview" className="px-3 py-1.5">Overview</TabsTrigger>
            <TabsTrigger value="ledger" className="px-3 py-1.5">Decision ledger</TabsTrigger>
            <TabsTrigger value="agents" className="px-3 py-1.5">Agents</TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="setup" className="gap-1.5 px-3 py-1.5">
                Setup
                {unfinished && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                    <span className="sr-only">, not finished</span>
                  </>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="how" className="px-3 py-1.5">How it works</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-5">
          {shown === "overview" && <Overview scope={scope} onSetup={onSetup} onLedger={() => setTab("ledger")} onAgents={() => setTab("agents")} onOpenNest={openNest} />}
        </TabsContent>
        <TabsContent value="ledger" className="mt-5">
          {shown === "ledger" && <Ledger scope={scope} openEntry={entry} onOpenEntry={setEntry} onSetup={onSetup} onAgents={() => setTab("agents")} onOpenDoc={openDoc} />}
        </TabsContent>
        <TabsContent value="agents" className="mt-5">
          {shown === "agents" && <Agents scope={scope} onManageKeys={nav.manageKeys} />}
        </TabsContent>
        {isAdmin && (
          <TabsContent value="setup" className="mt-5">
            <SetupWizard state={setup} onDone={() => setTab("overview")} onHow={() => setTab("how")} />
          </TabsContent>
        )}
        <TabsContent value="how" className="mt-5">
          <HowItWorks settings={setup.settings} orgName={setup.status?.org_name ?? null} onAgents={() => setTab("agents")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
