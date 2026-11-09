/**
 * Control room (po-1186): one page for what the agents are doing, how the
 * nest is filling up, the Slack setup and how it all works.
 *
 * CR3 ships the shell, Setup and How it works. Overview, Decision ledger and
 * Agents read the ledger CR1 adds and land with CR2; until then each says so
 * and points to Setup, instead of drawing empty charts.
 */
import { useEffect, useState } from "react";
import { BookOpenText, Gauge, ListChecks, Bot } from "lucide-react";
import { PageTitle } from "@/components/ui/page-title";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { SetupWizard, useSetupState, type SetupState } from "./SetupWizard";
import { HowItWorks } from "./HowItWorks";
import { SETUP_STEPS } from "../../../lib/control-room-setup";

const TABS = ["overview", "ledger", "agents", "setup", "how"] as const;
/** `?section=` (App owns `?tab=` and strips it on every navigation). */
const SECTION_PARAM = "section";
type Tab = (typeof TABS)[number];

function tabFromUrl(): Tab | null {
  try {
    const t = new URLSearchParams(window.location.search).get(SECTION_PARAM);
    return (TABS as readonly string[]).includes(t ?? "") ? (t as Tab) : null;
  } catch {
    return null;
  }
}

export default function ControlRoomPage() {
  const setup = useSetupState();
  const [tab, setTabNow] = useState<Tab | null>(tabFromUrl);
  // Until the reader picks a tab: Setup while setup is unfinished, else
  // Overview — decided once, when the facts load, so finishing setup on this
  // visit doesn't move the reader off the Setup tab.
  useEffect(() => {
    if (setup.loaded && tab === null) setTabNow(setup.progress.count === 5 ? "overview" : "setup");
  }, [setup.loaded, tab, setup.progress.count]);
  const shown: Tab = tab ?? "setup";

  const setTab = (t: string) => {
    setTabNow(t as Tab);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set(SECTION_PARAM, t);
      window.history.replaceState(window.history.state, "", u.toString());
    } catch {
      /* no URL sync; the tab still changes */
    }
  };
  useEffect(() => {
    const onPop = () => setTabNow(tabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const unfinished = setup.loaded && setup.progress.count < 5;

  return (
    <div data-testid="control-room-page" className="min-w-0">
      <PageTitle
        icon={Gauge}
        title="Control room"
        description="See what your agents are doing, how the nest is filling up, and trace any decision back to where it came from."
      />
      <Tabs value={shown} onValueChange={setTab}>
        <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label="Control room sections" className="h-auto">
            <TabsTrigger value="overview" className="px-3 py-1.5">Overview</TabsTrigger>
            <TabsTrigger value="ledger" className="px-3 py-1.5">Decision ledger</TabsTrigger>
            <TabsTrigger value="agents" className="px-3 py-1.5">Agents</TabsTrigger>
            <TabsTrigger value="setup" className="gap-1.5 px-3 py-1.5">
              Setup
              {unfinished && (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                  <span className="sr-only">, not finished</span>
                </>
              )}
            </TabsTrigger>
            <TabsTrigger value="how" className="px-3 py-1.5">How it works</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-5">
          <NextRelease
            icon={Gauge}
            title={setup.progress.count === 5 ? "Listening. The overview comes next" : "Nothing is listening yet"}
            body="This tab will show what the listeners reviewed, what people saved, and what it cost. It arrives in the next release."
            setup={setup}
            onSetup={() => setTab("setup")}
          />
        </TabsContent>
        <TabsContent value="ledger" className="mt-5">
          <NextRelease
            icon={ListChecks}
            title="The decision ledger comes next"
            body="Every run, its verdict and what happened to it, including the times an agent decided to do nothing. It arrives in the next release."
            setup={setup}
            onSetup={() => setTab("setup")}
          />
        </TabsContent>
        <TabsContent value="agents" className="mt-5">
          <NextRelease
            icon={Bot}
            title="Agents come next"
            body="The listeners and any agent you run yourself, such as Claude Code or a scheduled script, with when each last reported. It arrives in the next release."
            setup={setup}
            onSetup={() => setTab("setup")}
          />
        </TabsContent>
        <TabsContent value="setup" className="mt-5">
          <SetupWizard state={setup} onDone={() => setTab("overview")} onHow={() => setTab("how")} />
        </TabsContent>
        <TabsContent value="how" className="mt-5">
          <HowItWorks settings={setup.settings} orgName={setup.status?.org_name ?? null} onAgents={() => setTab("agents")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A tab whose data arrives with the next release: say so, and route to Setup. */
function NextRelease({
  icon: Icon,
  title,
  body,
  setup,
  onSetup,
}: {
  icon: typeof BookOpenText;
  title: string;
  body: string;
  setup: SetupState;
  onSetup: () => void;
}) {
  const p = setup.progress;
  return (
    <div className="rounded-lg border border-dashed px-5 py-8 text-center" data-testid="control-room-next-release">
      <Icon className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {p.count < 5 && (
        <>
          <ol className="mx-auto mt-5 max-w-sm text-left">
            {SETUP_STEPS.map((s, i) => (
              <li key={s.title} className="flex items-center gap-2.5 border-b py-1.5 text-sm last:border-b-0">
                <span
                  className={
                    p.done[i]
                      ? "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                      : "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-sm text-muted-foreground"
                  }
                  aria-hidden
                >
                  {i + 1}
                </span>
                <span>{s.title}</span>
                {p.done[i] && <span className="sr-only">(done)</span>}
              </li>
            ))}
          </ol>
          <Button className="mt-5" onClick={onSetup}>
            {p.count === 0 ? "Start setup" : "Continue setup"}
          </Button>
        </>
      )}
    </div>
  );
}
