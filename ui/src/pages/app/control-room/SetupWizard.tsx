/**
 * Control room → Setup (po-1186 CR3): connect Slack, choose channels, check
 * who can read, add starter folders, turn on listening.
 *
 * Every step is a call to a route that already exists (or, for the channel
 * list, its one new read). Where the wizard is comes from the install, the
 * bindings and the seeds applied, plus the picks made in this visit; nothing
 * about the wizard is stored. Credential fields are write-only: the server
 * answers with saved / not saved, never a value.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, Download, ExternalLink, FolderPlus, Hash, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/SearchableSelect";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  addCollaborator,
  applySurfacesSeed,
  createNest,
  createSlackInstall,
  createSurfacesBinding,
  disconnectSurfacesInstall,
  getSlackInstall,
  getSurfacesSeedStatus,
  getSurfacesSettings,
  getSurfacesStatus,
  listNests,
  listSlackChannels,
  listSurfacesBindings,
  listSurfacesSeeds,
  previewSurfacesBinding,
  pauseSurfacesBinding,
  removeSurfacesBinding,
  resumeSurfacesBinding,
  getSurfacesBindingHistory,
  getSurfacesBindingActivity,
  type SurfacesBindingActivity,
  type SurfacesBindingHistoryEntry,
  putSlackCredentials,
  slackHostedOAuthStartUrl,
  slackOAuthStartUrl,
  type SurfacesBinding,
  type SurfacesChannel,
  type SurfacesInstallRef,
  type SurfacesSeedRef,
  type SurfacesSeedResult,
  type SurfacesSettingsView,
  type SurfacesStatus,
} from "../../../lib/api";
import {
  DEFAULT_SETTINGS_COPY,
  activityLines,
  SETUP_STEPS,
  deriveProgress,
  dryRunSummary,
  dryRunTree,
  fixOptions,
  guardView,
  membersToAdd,
  nestNameForChannel,
  neverList,
  noticeParagraphs,
  pickInstall,
  unresolved,
  willList,
  type ChannelPick,
  type GuardView,
  type MemberToAdd,
  type SetupProgress,
} from "../../../lib/control-room-setup";

interface NestRef {
  id: string;
  name: string;
}

export interface SetupState {
  loaded: boolean;
  error: string | null;
  status: SurfacesStatus | null;
  settings: SurfacesSettingsView | null;
  install: SurfacesInstallRef | null;
  bindings: SurfacesBinding[];
  nests: NestRef[];
  seeded: string[];
  picks: ChannelPick[];
  setPicks: (f: (p: ChannelPick[]) => ChannelPick[]) => void;
  checked: boolean;
  setChecked: (v: boolean) => void;
  progress: SetupProgress;
  reload: () => Promise<void>;
  markSeeded: (nestId: string) => void;
  addNest: (n: NestRef) => void;
  /** Guard checks, shared by every step, keyed by channel+nest+ext. */
  previews: Record<string, GuardView | "loading">;
  setPreviews: (f: (v: Record<string, GuardView | "loading">) => Record<string, GuardView | "loading">) => void;
  inflight: { current: Set<string> };
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The facts setup is worked out from, loaded once and refreshed after each write. */
export function useSetupState(): SetupState {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SurfacesStatus | null>(null);
  const [settings, setSettings] = useState<SurfacesSettingsView | null>(null);
  const [bindings, setBindings] = useState<SurfacesBinding[]>([]);
  const [nests, setNests] = useState<NestRef[]>([]);
  const [seeded, setSeeded] = useState<string[]>([]);
  const [picks, setPicksNow] = useState<ChannelPick[]>([]);
  const [checked, setChecked] = useState(false);
  const [previews, setPreviewsNow] = useState<Record<string, GuardView | "loading">>({});
  const inflight = useRef(new Set<string>());

  const install = useMemo(() => pickInstall(status?.installs ?? [], !!status?.slack_hosted), [status]);

  const reload = useCallback(async () => {
    try {
      const [st, se, bs, ns] = await Promise.all([
        getSurfacesStatus(),
        getSurfacesSettings().catch(() => null),
        listSurfacesBindings().catch(() => [] as SurfacesBinding[]),
        listNests().catch(() => ({ nests: [] as any[] })),
      ]);
      const inst = pickInstall(st.installs, st.slack_hosted);
      const live = bs.filter((b) => b.install_id === inst?.id && b.status !== "removed");
      const seedChecks = await Promise.all(
        [...new Set(live.map((b) => b.nest_id))].map((n) =>
          getSurfacesSeedStatus(n)
            .then((r) => (r.no_seed ? null : n))
            .catch(() => null),
        ),
      );
      setStatus(st);
      setSettings(se);
      setBindings(live);
      setNests((ns.nests ?? []).filter((n: any) => n && typeof n.id === "string").map((n: any) => ({ id: n.id, name: String(n.name ?? n.id) })));
      setSeeded((prev) => [...new Set([...prev, ...seedChecks.filter((n): n is string => !!n)])]);
      setError(null);
    } catch (e) {
      setError(errText(e, "Couldn't load the Surfaces setup."));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const progress = useMemo(
    () => deriveProgress({ install, bindings, seededNestIds: seeded, picks, checked }),
    [install, bindings, seeded, picks, checked],
  );

  return {
    loaded,
    error,
    status,
    settings,
    install,
    bindings,
    nests,
    seeded,
    picks,
    setPicks: (f) => setPicksNow((p) => f(p)),
    checked,
    setChecked,
    progress,
    reload,
    markSeeded: (n) => setSeeded((s) => (s.includes(n) ? s : [...s, n])),
    addNest: (n) => setNests((list) => (list.some((x) => x.id === n.id) ? list : [...list, n])),
    previews,
    setPreviews: (f) => setPreviewsNow((v) => f(v)),
    inflight,
  };
}

// ─── shared bits ────────────────────────────────────────────────────────────

type Tone = "info" | "ok" | "warn" | "bad";
const TONE: Record<Tone, string> = {
  info: "border-border bg-muted/40 text-foreground",
  ok: "border-green-200 bg-green-50 text-green-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  bad: "border-red-200 bg-red-50 text-red-900",
};
const TONE_ICON: Record<Tone, string> = { info: "text-foreground", ok: "text-green-700", warn: "text-amber-700", bad: "text-red-700" };

function Note({ tone, icon, children, testId }: { tone: Tone; icon?: "check" | "alert"; children: ReactNode; testId?: string }) {
  const Icon = icon === "check" ? Check : CircleAlert;
  return (
    <div className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", TONE[tone])} role={tone === "bad" ? "alert" : "status"} data-testid={testId}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_ICON[tone])} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function StepHeading({ title, lede }: { title: string; lede: string }) {
  return (
    <>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-foreground/80">{lede}</p>
    </>
  );
}

function FootBar({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

const Dot = ({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) => (
  <span
    aria-hidden
    className={cn(
      "inline-block h-2 w-2 shrink-0 rounded-full",
      tone === "ok" ? "bg-green-700" : tone === "warn" ? "bg-amber-600" : tone === "bad" ? "bg-red-700" : "bg-zinc-400",
    )}
  />
);

/** Small action buttons at 14px (the shadcn "sm" size drops to 12px). */
const small = "h-8 px-3 text-sm";

type Readiness = NonNullable<SurfacesStatus["readiness"]>;

/**
 * The address this page was opened at, when it differs from the public base
 * URL Slack will send the browser back to (null = same, or unknown).
 */
export function wrongAddress(readiness: Readiness, here: string | null): string | null {
  if (!here || !readiness.redirect_url || readiness.public_url) return null;
  try {
    return new URL(readiness.redirect_url).origin === new URL(here).origin ? null : here;
  } catch {
    return null;
  }
}

const SettingsLink = () => (
  <a href="/settings" className="mt-1 inline-block font-medium underline">
    Open Server settings
  </a>
);

/** po-1444: what this server needs before Slack can connect, each with its fix. */
export function ReadinessChecklist({ readiness, here }: { readiness: Readiness; here: string | null }) {
  const url = readiness.public_url;
  const wrong = wrongAddress(readiness, here);
  const base = readiness.redirect_url ? new URL(readiness.redirect_url).origin : "";
  const lines: { ok: boolean; label: string; fix: ReactNode }[] = [
    {
      ok: !url,
      label: "Slack can reach this server",
      fix: url && (
        <>
          {url.problem}
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {url.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <SettingsLink />
        </>
      ),
    },
    {
      ok: !wrong,
      label: "You opened this server at its public address",
      fix: wrong && (
        <>
          You&apos;re using this server at {wrong}, but its public base URL is {base}. Slack sends you back to the public base URL after approval, so the install can only finish there.
          <div className="mt-1">Set Server settings → Basic → Public base URL to this server&apos;s own public https address.</div>
          <SettingsLink />
        </>
      ),
    },
    {
      ok: readiness.buffer_key,
      label: "Message buffer key is set",
      fix: "Without it Nest never proposes anything. Set the buffer key in Server settings → Surfaces.",
    },
    {
      ok: readiness.model_key,
      label: "A model key is set",
      fix: "The judge needs a model to read conversations. Add a model key in Server settings → Hootie, or give each bound nest its own key.",
    },
  ];
  return (
    <ul className="mb-4 space-y-2 rounded-lg border p-4 text-sm" data-testid="setup-readiness">
      {lines.map((l) => (
        <li key={l.label} className="flex gap-2.5" data-ok={l.ok ? "true" : "false"}>
          {l.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden />}
          <div className="min-w-0">
            <span className="font-medium">{l.label}</span>
            <span className="sr-only">{l.ok ? " (ready)" : " (not ready)"}</span>
            {!l.ok && <div className="mt-0.5 text-foreground/80">{l.fix}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function WillNever({ settings }: { settings: SurfacesSettingsView | null }) {
  const s = settings ?? DEFAULT_SETTINGS_COPY;
  return (
    <div className="mb-4 grid gap-4 rounded-lg border p-4 md:grid-cols-2" data-testid="setup-will-never">
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground">It will</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {willList(s).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground">It will never</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {neverList(s).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function NestSelect({ id, value, nests, onChange, label, className }: { id?: string; value: string; nests: NestRef[]; onChange: (v: string) => void; label: string; className?: string }) {
  return (
    <SearchableSelect
      id={id}
      ariaLabel={label}
      value={value}
      onChange={onChange}
      options={nests.map((n) => ({ value: n.id, label: n.name }))}
      searchValues={false}
      placeholder="Choose a nest"
      searchPlaceholder="Search nests…"
      emptyText="No nests match."
      className={className ?? "w-56 max-w-full"}
    />
  );
}

// ─── the wizard ─────────────────────────────────────────────────────────────

export function SetupWizard({ state, onDone, onHow }: { state: SetupState; onDone: () => void; onHow: () => void }) {
  const [step, setStep] = useState<number | null>(null);
  const opened = useRef(false);
  // Open where setup was left, once the facts are in (AC-CR-15).
  useEffect(() => {
    if (state.loaded && !opened.current) {
      opened.current = true;
      setStep(state.progress.current);
    }
  }, [state.loaded, state.progress.current]);

  if (!state.loaded) return <div className="py-12 text-center text-sm text-muted-foreground">Loading setup…</div>;
  if (state.error) return <Note tone="bad">{state.error}</Note>;

  const p = state.progress;
  const at = step ?? p.current;
  // A step is reachable once every step before it is done (or it is done itself).
  const reachable = (i: number) => i === 0 || p.done[i] || p.done.slice(0, i).every(Boolean);

  return (
    <div data-testid="setup-wizard">
      {p.count > 0 && p.count < 5 && (
        <div className="mb-4">
          <Note tone="info" testId="setup-progress">
            <b>{p.count} of 5 steps done.</b> You can leave and come back. This page works out where you are from what is already set up.
          </Note>
        </div>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[801px]:grid-cols-[240px_minmax(0,1fr)]">
        <ol className="relative -mx-4 flex gap-1 overflow-x-auto px-4 min-[801px]:mx-0 min-[801px]:block min-[801px]:px-0" aria-label="Setup steps" data-testid="setup-steps">
          {SETUP_STEPS.map((s, i) => (
            <li key={s.title} className="shrink-0">
              <button
                type="button"
                onClick={() => reachable(i) && setStep(i)}
                disabled={!reachable(i)}
                aria-current={at === i ? "step" : undefined}
                data-done={p.done[i] ? "true" : "false"}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
                  at === i && "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border text-sm font-semibold",
                    p.done[i] ? "border-primary bg-primary text-primary-foreground" : "border-zinc-300 bg-background text-zinc-700",
                  )}
                  aria-hidden
                >
                  {p.done[i] ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-sm font-medium min-[801px]:whitespace-normal">
                    {s.title}
                    {p.done[i] && <span className="sr-only"> (done)</span>}
                  </span>
                  <span className="hidden text-sm text-muted-foreground min-[801px]:block">{s.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="min-w-0" data-testid={`setup-step-${at + 1}`}>
          {at === 0 && <ConnectStep state={state} next={() => setStep(1)} />}
          {at === 1 && <ChannelsStep state={state} back={() => setStep(0)} next={() => setStep(2)} />}
          {at === 2 && <CheckStep state={state} back={() => setStep(1)} toChannels={() => setStep(1)} next={() => setStep(3)} />}
          {at === 3 && <StarterStep state={state} back={() => setStep(2)} next={() => setStep(4)} />}
          {at === 4 && <ListenStep state={state} back={() => setStep(3)} onDone={onDone} onHow={onHow} />}
        </div>
      </div>
    </div>
  );
}

// ─── 1. Connect Slack ───────────────────────────────────────────────────────

const CRED_FIELDS = [
  { key: "client_id", label: "Client ID" },
  { key: "client_secret", label: "Client secret" },
  { key: "signing_secret", label: "Signing secret" },
] as const;

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** po-1437: the channels a disconnect stops, named, and what each channel is told. */
export function DisconnectChannels({ bindings }: { bindings: SurfacesBinding[] }) {
  const live = bindings.filter((b) => b.status !== "removed" && b.conversation_kind !== "dm");
  if (!live.length) return <p className="text-sm text-muted-foreground">Nest isn&apos;t listening in any channel right now.</p>;
  return (
    <div className="text-sm" data-testid="disconnect-channels">
      <p className="font-medium">
        {live.length === 1 ? "This channel stops" : `These ${live.length} channels stop`}:
      </p>
      <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
        {live.map((b) => (
          <li key={b.id}>#{b.conversation_name ?? b.conversation_id}</li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground">
        Nest posts one message in each, saying Slack was disconnected and by you, so its members know. Each channel&apos;s history records &quot;Slack disconnected by&quot; your email.
      </p>
    </div>
  );
}

export function ConnectStep({ state, next }: { state: SetupState; next: () => void }) {
  const inst = state.install;
  const connected = inst?.status === "active";
  const hosted = !!state.status?.slack_hosted;
  const org = state.status?.org_name;
  const [homeNest, setHomeNest] = useState<string>(inst?.home_nest_id ?? state.nests[0]?.id ?? "");
  const [creds, setCreds] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [manifest, setManifest] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!homeNest && state.nests[0]) setHomeNest(state.nests[0].id);
  }, [state.nests, homeNest]);

  useEffect(() => {
    if (!inst || inst.mode !== "manifest" || connected) return;
    let live = true;
    getSlackInstall(inst.id)
      .then((r) => {
        if (!live) return;
        setCreds(r.install.credentials ?? {});
        setManifest(r.manifest ?? null);
      })
      // Without this read every field shows "Not saved": say so, or the admin re-enters secrets.
      .catch((e) => live && toast.error(errText(e, "Couldn't read the saved Slack values. Reload to try again.")));
    return () => {
      live = false;
    };
  }, [inst, connected]);

  const allCreds = CRED_FIELDS.every((f) => creds[f.key]);
  const readiness = state.status?.readiness;
  // The server refuses too; this keeps the admin from leaving for a Slack error page.
  const here = typeof window === "undefined" ? null : window.location.origin;
  const urlBad = !!readiness && (!!readiness.public_url || !!wrongAddress(readiness, here));
  const homeName = state.nests.find((n) => n.id === inst?.home_nest_id)?.name;

  const download = async () => {
    setBusy(true);
    try {
      let m = manifest;
      if (!inst) {
        if (!homeNest) throw new Error("Choose the nest saved notes land in first.");
        const r = await createSlackInstall(homeNest);
        m = r.manifest;
        setManifest(m);
        await state.reload();
      } else if (!m) {
        // The read on page load failed or hasn't finished: read it again.
        m = (await getSlackInstall(inst.id)).manifest;
        setManifest(m);
      }
      if (!m) throw new Error("This install has no manifest. Reload the page and try again.");
      downloadJson("nest-slack-manifest.json", m);
    } catch (e) {
      toast.error(errText(e, "Couldn't download the manifest."));
    } finally {
      setBusy(false);
    }
  };

  const saveCreds = async () => {
    if (!inst) return;
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    if (!Object.keys(body).length) return;
    setBusy(true);
    try {
      const r = await putSlackCredentials(inst.id, body);
      setCreds(r.credentials);
      setValues({});
      toast.success("Saved. The values are stored encrypted and won't be shown again.");
    } catch (e) {
      toast.error(errText(e, "Couldn't save the values."));
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (hosted) {
      if (!homeNest) return toast.error("Choose the nest saved notes land in first.");
      window.location.assign(slackHostedOAuthStartUrl(homeNest));
      return;
    }
    if (inst) window.location.assign(slackOAuthStartUrl(inst.id));
  };

  const [confirmOff, setConfirmOff] = useState(false);
  const disconnect = async () => {
    if (!inst) return;
    setBusy(true);
    try {
      const r = await disconnectSurfacesInstall(inst.id);
      toast.success(`Disconnected Slack.${r.told ? ` ${r.told} channel(s) were told.` : ""}${r.withdrawn ? ` ${r.withdrawn} pending item(s) withdrawn.` : ""}`);
      setConfirmOff(false);
      await state.reload();
    } catch (e) {
      toast.error(errText(e, "Couldn't disconnect Slack."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading
        title="Connect Slack"
        lede={`This installs ${org ? `${org}'s` : "your"} own copy of the Nest app in your Slack workspace. Installing it doesn't read anything: you pick channels in the next step.`}
      />
      <WillNever settings={state.settings} />
      {readiness && !connected && <ReadinessChecklist readiness={readiness} here={here} />}
      {connected ? (
        <Note tone="ok" icon="check" testId="setup-connected">
          <b>Connected to Slack.</b> {homeName ? `Saved notes land in ${homeName} unless a channel says otherwise.` : "Saved notes land in the nest each channel is bound to."}
          <div className="mt-2">
            <Button variant="outline" className={small} onClick={() => setConfirmOff(true)} disabled={busy} data-testid="setup-disconnect">
              Disconnect Slack
            </Button>
          </div>
          <Dialog open={confirmOff} onOpenChange={(o) => !busy && setConfirmOff(o)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Disconnect Slack?</DialogTitle>
                <DialogDescription>
                  Nest stops listening in every channel. Pending review cards are withdrawn, the Slack token is revoked, and channel bindings, drafts and linked Slack users are removed. Approved notes, nest access and the audit history stay. You can connect again later.
                </DialogDescription>
              </DialogHeader>
              <DisconnectChannels bindings={state.bindings} />
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmOff(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={disconnect} disabled={busy} data-testid="setup-disconnect-confirm">
                  Disconnect
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Note>
      ) : (
        <div className="rounded-lg border p-4">
          {!inst && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="setup-home-nest" className="text-sm font-normal">
                Saved notes land in
              </Label>
              <NestSelect id="setup-home-nest" label="Nest saved notes land in" value={homeNest} nests={state.nests} onChange={setHomeNest} />
            </div>
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
            {hosted ? (
              <li>Approve the install in Slack. Slack shows exactly which permissions it asks for.</li>
            ) : (
              <>
                <li>Create the app from our manifest. Slack shows exactly which permissions it asks for.</li>
                <li>
                  Paste the three values Slack gives you. They are stored encrypted and never shown again.
                  {inst && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3" data-testid="setup-credentials">
                      {CRED_FIELDS.map((f) => (
                        <div key={f.key} className="min-w-0">
                          <Label htmlFor={`cred-${f.key}`} className="flex items-center justify-between text-sm font-normal">
                            {f.label}
                            <span className={cn("text-sm", creds[f.key] ? "text-green-700" : "text-muted-foreground")} data-testid={`cred-state-${f.key}`}>
                              {creds[f.key] ? "Saved" : "Not saved"}
                            </span>
                          </Label>
                          <Input
                            id={`cred-${f.key}`}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            className="mt-1 h-9"
                            placeholder={creds[f.key] ? "Replace the saved value" : ""}
                            value={values[f.key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                          />
                        </div>
                      ))}
                      <div className="sm:col-span-3">
                        <Button variant="outline" className={small} onClick={saveCreds} disabled={busy || !Object.values(values).some((v) => v.trim())}>
                          Save values
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
                <li>Approve the install in Slack.</li>
              </>
            )}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            {!hosted && (
              <Button variant="outline" onClick={download} disabled={busy || urlBad || (!inst && !homeNest)}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                Download manifest
              </Button>
            )}
            <Button onClick={approve} disabled={busy || urlBad || (hosted ? !homeNest : !inst || !allCreds)}>
              Open Slack to approve
            </Button>
          </div>
          {urlBad && (
            <p className="mt-2 text-sm text-red-800" data-testid="setup-url-blocked">
              Slack can&apos;t connect from here yet. Fix the address problem above first.
            </p>
          )}
          {readiness?.redirect_url && !urlBad && (
            <div className="mt-3 text-sm" data-testid="setup-redirect-url">
              <p className="text-muted-foreground">Your Slack app must list this exact address under OAuth &amp; Permissions → Redirect URLs:</p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">{readiness.redirect_url}</code>
                <CopyButton text={readiness.redirect_url} toastMessage="Redirect URL copied" />
              </div>
            </div>
          )}
          {!hosted && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="setup-manifest-note">
              The manifest uses this server&apos;s current address. If that address changes, download it again and update the app&apos;s URLs in Slack.
            </p>
          )}
        </div>
      )}
      <FootBar
        left={<span className="text-sm text-muted-foreground">Only a server admin can connect a workspace.</span>}
        right={
          <Button onClick={next} disabled={!connected}>
            Continue
          </Button>
        }
      />
    </>
  );
}

// ─── 2. Choose channels ─────────────────────────────────────────────────────

type PreviewKey = string;
const keyOf = (p: ChannelPick): PreviewKey => `${p.channelId}|${p.nestId}|${p.extCapture ? 1 : 0}`;

/** Live guard checks for the picked channels, keyed by channel+nest+ext. */
function usePreviews(state: SetupState) {
  const views = state.previews;
  const setViews = state.setPreviews;
  const inflight = state.inflight;
  const nestName = useCallback((id: string) => state.nests.find((n) => n.id === id)?.name ?? "this nest", [state.nests]);

  useEffect(() => {
    const inst = state.install;
    if (!inst) return;
    for (const p of state.picks) {
      if (!p.on || !p.nestId) continue;
      const k = keyOf(p);
      if (views[k] || inflight.current.has(k)) continue;
      inflight.current.add(k);
      setViews((v) => ({ ...v, [k]: "loading" }));
      previewSurfacesBinding({ install_id: inst.id, conversation_id: p.channelId, nest_id: p.nestId, ext_capture_enabled: !!p.extCapture })
        .then((r) => ({ ...guardView(r, { channel: p.channelName, nest: nestName(p.nestId), orgName: state.status?.org_name }), add: membersToAdd(r) }))
        .catch((e): GuardView => ({ state: "refused", label: "Can't listen here", note: errText(e, "The check failed.") }))
        .then((g) => setViews((v) => ({ ...v, [k]: g })))
        .finally(() => inflight.current.delete(k));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.picks, state.install, views, nestName, state.status?.org_name]);

  const viewFor = (p: ChannelPick): GuardView | "loading" | undefined => views[keyOf(p)];
  /** Drop a pick's cached check so the effect above runs it again. */
  const recheck = (p: ChannelPick) =>
    setViews((v) => {
      const { [keyOf(p)]: _gone, ...rest } = v;
      return rest;
    });
  const byChannel = (): Record<string, GuardView | undefined> => {
    const out: Record<string, GuardView | undefined> = {};
    for (const p of state.picks) {
      const v = views[keyOf(p)];
      out[p.channelId] = v && v !== "loading" ? v : undefined;
    }
    return out;
  };
  return { viewFor, byChannel, recheck };
}

/** po-1432: give channel members who can't read the nest read access, then check again. */
function AddToNest({ members, nestId, nestName, channel, onAdded }: { members: MemberToAdd[]; nestId: string; nestName: string; channel: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Re-check only once the dialog closes: a re-check unmounts this row's popup.
  const [addedSome, setAddedSome] = useState(false);
  const close = (o: boolean) => {
    setOpen(o);
    if (!o && addedSome) {
      setAddedSome(false);
      onAdded();
    }
  };
  const addable = members.filter((m) => m.addable);
  if (!addable.length) return null;
  const show = () => {
    setPicked(new Set(addable.map((m) => m.community_user_id!)));
    setOpen(true);
  };
  const add = async () => {
    setBusy(true);
    const ids = [...picked];
    const results = await Promise.allSettled(ids.map((user_id) => addCollaborator(nestId, { user_id, permission: "read" })));
    setBusy(false);
    const failed = ids.filter((_, i) => results[i].status === "rejected");
    if (failed.length) {
      // Keep the dialog open with only the ones that failed ticked, so a retry is one click.
      toast.error(`Couldn't add ${failed.length} of ${ids.length} to ${nestName}.`);
      setPicked(new Set(failed));
      if (failed.length < ids.length) setAddedSome(true);
    } else {
      toast.success(`Added ${ids.length} to ${nestName} with read access.`);
      setOpen(false);
      setAddedSome(false);
      onAdded();
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" className="self-start" onClick={show} data-testid={`add-to-nest-${channel}`}>
        Add to nest…
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add channel members to {nestName}?</DialogTitle>
            <DialogDescription>
              These people are in #{channel} but can't read {nestName}. Ticked people get read access.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2">
            {members.map((m) => (
              <li key={m.surface_user_id} className={cn("flex items-center gap-2 text-sm", !m.addable && "text-muted-foreground")}>
                <Checkbox
                  aria-label={`Add ${m.name ?? m.surface_user_id}`}
                  disabled={!m.addable || busy}
                  checked={!!m.community_user_id && picked.has(m.community_user_id)}
                  onCheckedChange={(v) =>
                    setPicked((s) => {
                      const next = new Set(s);
                      if (v === true) next.add(m.community_user_id!);
                      else next.delete(m.community_user_id!);
                      return next;
                    })
                  }
                />
                <span>{m.name ?? m.surface_user_id}</span>
                {m.email && <span className="text-muted-foreground">{m.email}</span>}
                {!m.addable && <span className="italic">no account</span>}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={add} disabled={busy || !picked.size}>
              {busy ? "Adding…" : `Add to nest (${picked.size})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** po-1440: the guard's short note, then who blocks the pair as one list per reason. */
export function GuardNote({ view, className }: { view: GuardView; className?: string }) {
  if (!view.note && !view.groups?.length) return null;
  return (
    <div className={className} data-testid="guard-note">
      {view.note && <span>{view.note}</span>}
      {view.groups?.map((g) => (
        <div key={g.heading} className="mt-1.5">
          <div className="font-medium text-foreground">{g.heading}</div>
          <ul className="list-disc pl-5">
            {g.people.map((p, i) => (
              <li key={`${p}-${i}`}>{p}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function GuardCell({ view, channel, addTo }: { view: GuardView | "loading" | undefined; channel: SurfacesChannel; addTo?: ReactNode }) {
  if (view === "loading") return <span className="text-sm text-muted-foreground">Checking…</span>;
  if (!view) {
    if (channel.is_ext_shared)
      return (
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Dot tone="off" />
          Off unless you choose
        </span>
      );
    return null;
  }
  if (view.state === "external" || view.state === "refused") {
    return (
      <div className="flex flex-col gap-1 text-sm" data-testid={`guard-${channel.id}`} data-state={view.state}>
        <span className="flex items-center gap-1.5 font-semibold">
          <Dot tone={view.state === "refused" ? "bad" : "off"} />
          {view.label}
        </span>
        <GuardNote view={view} className="text-muted-foreground" />
        {addTo}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid={`guard-${channel.id}`} data-state={view.state}>
      <span className="flex items-center gap-1.5">
        <Dot tone="ok" />
        Can listen
      </span>
      <span className="flex items-center gap-1.5">
        <Dot tone={view.state === "ok" ? "ok" : "warn"} />
        {view.label}
      </span>
      <GuardNote view={view} className="text-muted-foreground" />
      {addTo}
    </div>
  );
}

/** How a bound channel's status reads (po-1437 adds the admin pause). */
export function boundLabel(b: { status: string; paused_by_admin?: boolean }): { tone: "ok" | "warn"; text: string } {
  if (b.status === "active") return { tone: "ok", text: "Listening" };
  if (b.paused_by_admin) return { tone: "warn", text: "Paused by an admin" };
  if (b.status === "paused_by_member") return { tone: "warn", text: "Paused: a member removed Nest" };
  return { tone: "warn", text: "Paused: the reader check failed" };
}

type ManageAction = "pause" | "resume" | "move" | "remove";

/** po-1446: the activity summary, then how to get a card fast while testing. */
export function ChannelActivity({ activity, quietMinutes }: { activity: SurfacesBindingActivity; quietMinutes: number }) {
  return (
    <div className="space-y-3 text-sm" data-testid="channel-activity">
      <ul className="list-disc space-y-1 pl-5">
        {activityLines(activity, quietMinutes).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Note tone="info">
        <b>Testing?</b> Lower the quiet window to 5 minutes in Server settings → Surfaces, or react 🧠 to a message to have that thread judged right away.
      </Note>
    </div>
  );
}

const HISTORY_VERB: Record<SurfacesBindingHistoryEntry["action"], string> = {
  started: "Started listening",
  paused: "Paused",
  resumed: "Resumed",
  removed: "Stopped listening",
  moved: "Moved to another nest",
};

/** po-1437: the channel's history, newest first: when, who (the actual person, or Nest), what, why. */
export function BindingHistoryList({ entries }: { entries: SurfacesBindingHistoryEntry[] }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">No changes recorded yet.</p>;
  return (
    <ol className="max-h-[50vh] space-y-3 overflow-y-auto text-sm" data-testid="binding-history">
      {entries.map((h, i) => (
        <li key={`${h.at}-${i}`} className="border-b pb-2 last:border-b-0">
          <div className="flex flex-wrap justify-between gap-x-3">
            <span className="font-medium">{HISTORY_VERB[h.action] ?? h.action}</span>
            <time className="text-muted-foreground" dateTime={h.at}>
              {new Date(h.at).toLocaleString()}
            </time>
          </div>
          <div className="text-muted-foreground">
            {h.by ? `${h.by.name ? `${h.by.name} · ` : ""}${h.by.email ?? h.by.user_id}` : "Nest (automatic)"}
          </div>
          {h.reason && <p className="mt-0.5">{h.reason}</p>}
        </li>
      ))}
    </ol>
  );
}

/**
 * po-1437: pause / resume / move / stop listening on a bound channel. Move
 * checks the new pair first and only then removes and re-binds, so a refused
 * move changes nothing.
 */
export function BindingManage({
  channel,
  binding,
  state,
  onChanged,
}: {
  channel: SurfacesChannel;
  binding: NonNullable<SurfacesChannel["binding"]>;
  state: SetupState;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState<ManageAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [refusal, setRefusal] = useState<GuardView | null>(null);
  // po-1437: every change needs a reason; it goes on the channel's history for the team.
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<SurfacesBindingHistoryEntry[] | null>(null);
  const why = reason.trim();
  const openAction = (a: ManageAction) => {
    setReason("");
    setRefusal(null);
    setOpen(a);
  };
  const showHistory = async () => {
    setHistory([]);
    try {
      setHistory(await getSurfacesBindingHistory(binding.id));
    } catch (e) {
      setHistory(null);
      toast.error(errText(e, "Couldn't load the history."));
    }
  };
  // po-1446: "why no card?" — counts for the last few days.
  const [activity, setActivity] = useState<SurfacesBindingActivity | "loading" | null>(null);
  const showActivity = async () => {
    setActivity("loading");
    try {
      setActivity(await getSurfacesBindingActivity(binding.id));
    } catch (e) {
      setActivity(null);
      toast.error(errText(e, "Couldn't load the activity."));
    }
  };
  const name = `#${channel.name ?? channel.id}`;
  const nestName = (id: string) => state.nests.find((n) => n.id === id)?.name ?? "that nest";
  const label = boundLabel(binding);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      setOpen(null);
      await state.reload();
      await onChanged();
    } catch (e) {
      toast.error(errText(e, "That didn't work. Try again."));
      // Part of it may have happened (a move that removed but couldn't re-bind): show what is true now.
      await Promise.resolve(state.reload()).catch(() => {});
      await Promise.resolve(onChanged()).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const move = async () => {
    const inst = state.install;
    if (!inst || !target) return;
    setBusy(true);
    setRefusal(null);
    try {
      const p = await previewSurfacesBinding({ install_id: inst.id, conversation_id: channel.id, nest_id: target });
      const v = guardView(p, { channel: channel.name ?? channel.id, nest: nestName(target), orgName: state.status?.org_name });
      if (v.state === "refused" || v.state === "external") {
        setRefusal(v);
        return;
      }
    } catch (e) {
      toast.error(errText(e, "Couldn't check that nest."));
      return;
    } finally {
      setBusy(false);
    }
    // ponytail: two calls, not one server-side move. If the second fails the channel is left unbound and the admin is told; add a /move route if that proves common.
    await act(async () => {
      await removeSurfacesBinding(binding.id, why, target);
      try {
        await createSurfacesBinding({ install_id: inst.id, conversation_id: channel.id, nest_id: target, reason: `Moved from ${nestName(binding.nest_id)}: ${why}` });
      } catch (e) {
        throw new Error(
          `${name} was removed from ${nestName(binding.nest_id)} but couldn't be bound to ${nestName(target)} (${errText(e, "unknown error")}). It isn't listening now. Turn it on again from this list.`,
        );
      }
    }, `${name} now saves into ${nestName(target)}.`);
  };

  const others = state.nests.filter((n) => n.id !== binding.nest_id);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid={`bound-${channel.id}`}>
      <span className="flex items-center gap-1.5">
        <Dot tone={label.tone} />
        {label.text}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-7 px-2 text-sm" disabled={busy} aria-label={`Manage ${name}`}>
            Manage
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {binding.status === "active" ? (
            <DropdownMenuItem onSelect={() => openAction("pause")}>Pause listening</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => openAction("resume")}>Resume listening</DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!others.length} onSelect={() => { setTarget(others[0]?.id ?? ""); openAction("move"); }}>
            Move to another nest
          </DropdownMenuItem>
          <DropdownMenuItem className="text-red-700" onSelect={() => openAction("remove")}>
            Stop listening
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={showActivity}>Activity</DropdownMenuItem>
          <DropdownMenuItem onSelect={showHistory}>History</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={activity !== null} onOpenChange={(o) => !o && setActivity(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activity in {name}</DialogTitle>
            <DialogDescription>What Nest did here in the last {activity && activity !== "loading" ? activity.days : 7} days. Counts only: no message text.</DialogDescription>
          </DialogHeader>
          {activity === "loading" || activity === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ChannelActivity activity={activity} quietMinutes={state.settings?.quiet_minutes ?? DEFAULT_SETTINGS_COPY.quiet_minutes} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>History of {name}</DialogTitle>
            <DialogDescription>Who started, paused, resumed, moved or removed listening here, when, and why. Newest first.</DialogDescription>
          </DialogHeader>
          <BindingHistoryList entries={history ?? []} />
        </DialogContent>
      </Dialog>
      <Dialog open={open !== null} onOpenChange={(o) => !busy && !o && setOpen(null)}>
        <DialogContent>
          {open === "move" ? (
            <>
              <DialogHeader>
                <DialogTitle>Move {name} to another nest</DialogTitle>
                <DialogDescription>
                  Nest checks the new nest first. If it passes, pending cards from {name} are withdrawn and new notes save into the nest you pick. Notes already approved stay in {nestName(binding.nest_id)}.
                </DialogDescription>
              </DialogHeader>
              <NestSelect label={`New nest for ${name}`} value={target} nests={others} onChange={(v) => { setTarget(v); setRefusal(null); }} className="w-full" />
              {refusal && (
                <Note tone="bad" testId="move-refused">
                  <b>{refusal.label}.</b> Nothing changed.
                  <GuardNote view={refusal} className="mt-1" />
                </Note>
              )}
            </>
          ) : (
            <DialogHeader>
              <DialogTitle>{open === "pause" ? `Pause listening in ${name}?` : open === "resume" ? `Resume listening in ${name}?` : `Stop listening in ${name}?`}</DialogTitle>
              <DialogDescription>
                {open === "pause"
                  ? "Nest stops reading new messages here. Messages it was holding are deleted and pending cards are withdrawn. Approved notes stay. Resume any time; Nest checks who can read again first."
                  : open === "resume"
                    ? "Nest checks who can read the nest first, then starts reading new messages here again."
                    : `Nest stops listening and ${name} is no longer tied to ${nestName(binding.nest_id)}. Messages it was holding are deleted and pending cards are withdrawn. Approved notes stay. You can turn it on again later.`}
              </DialogDescription>
            </DialogHeader>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`why-${channel.id}`}>Why? The team sees this in the channel&apos;s history.</Label>
            <textarea
              id={`why-${channel.id}`}
              className="min-h-[72px] w-full rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: launch week, too much noise in this channel"
              data-testid="manage-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
            {open === "move" ? (
              <Button onClick={move} disabled={busy || !target || why.length < 3}>
                Check and move
              </Button>
            ) : (
              <Button
                variant={open === "remove" ? "destructive" : "default"}
                disabled={busy || why.length < 3}
                data-testid="manage-confirm"
                onClick={() =>
                  open === "pause"
                    ? act(() => pauseSurfacesBinding(binding.id, why), `Paused listening in ${name}.`)
                    : open === "resume"
                      ? act(() => resumeSurfacesBinding(binding.id, why), `Nest is listening in ${name} again.`)
                      : act(() => removeSurfacesBinding(binding.id, why), `Nest stopped listening in ${name}.`)
                }
              >
                {open === "pause" ? "Pause" : open === "resume" ? "Resume" : "Stop listening"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function channelMeta(ch: SurfacesChannel) {
  const kind = ch.is_ext_shared ? "Slack Connect" : ch.is_private ? "Private" : "Public";
  return ch.num_members === null ? kind : `${kind} · ${ch.num_members} ${ch.num_members === 1 ? "member" : "members"}`;
}

function ChannelsStep({ state, back, next }: { state: SetupState; back: () => void; next: () => void }) {
  const inst = state.install;
  const [channels, setChannels] = useState<SurfacesChannel[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { viewFor, recheck } = usePreviews(state);

  // One request at a time: "Check again" is disabled while a list is loading,
  // so repeated clicks can't stack up Slack calls.
  const load = useCallback(async () => {
    if (!inst || inst.status !== "active") return;
    setErr(null);
    setLoading(true);
    try {
      const r = await listSlackChannels(inst.id);
      setChannels(r.channels);
      setTruncated(r.truncated);
    } catch (e) {
      setErr(errText(e, "Couldn't list the channels."));
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [inst]);
  useEffect(() => {
    void load();
  }, [load]);

  const pickOf = (ch: SurfacesChannel) => state.picks.find((p) => p.channelId === ch.id);
  const defaultNest = inst?.home_nest_id ?? state.nests[0]?.id ?? "";
  const nestName = (id: string) => state.nests.find((n) => n.id === id)?.name ?? "its nest";
  const update = (ch: SurfacesChannel, patch: Partial<ChannelPick>) => {
    state.setChecked(false);
    state.setPicks((ps) => {
      const cur = ps.find((p) => p.channelId === ch.id) ?? { channelId: ch.id, channelName: ch.name ?? ch.id, nestId: defaultNest, on: false };
      const nextPick = { ...cur, ...patch };
      return ps.some((p) => p.channelId === ch.id) ? ps.map((p) => (p.channelId === ch.id ? nextPick : p)) : [...ps, nextPick];
    });
  };
  const onCount = state.picks.filter((p) => p.on).length;

  return (
    <>
      <StepHeading
        title="Choose channels"
        lede="Start with two or three busy channels. Each channel saves into one nest. The status on the right is a live check. Nothing is saved until you continue."
      />
      {err && <Note tone="bad">{err}</Note>}
      {channels === null ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading channels…</div>
      ) : channels.length === 0 && !err ? (
        <div className="rounded-lg border border-dashed px-5 py-8 text-center text-sm">
          <p className="mx-auto max-w-md text-muted-foreground">
            Nest isn't in any channel yet. In Slack, open a channel, type <code className="rounded bg-muted px-1">/invite</code> and pick your Slack app. It can only listen where it was added.
          </p>
          <Button variant="outline" className="mt-3" onClick={load} disabled={loading}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Check again
          </Button>
        </div>
      ) : (
        <>
        <div className="mb-2 flex justify-end">
          {/* po-1445: a channel Nest was just invited to shows without a page reload. */}
          <Button variant="ghost" className={small} onClick={load} disabled={loading} data-testid="setup-channels-refresh">
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            {loading ? "Refreshing…" : "Refresh list"}
          </Button>
        </div>
        <div className="rounded-lg border px-4" data-testid="setup-channels">
          {channels.map((ch) => {
            const p = pickOf(ch);
            const bound = ch.binding;
            const on = !!bound || !!p?.on;
            const nest = bound?.nest_id ?? p?.nestId ?? defaultNest;
            return (
              <div
                key={ch.id}
                className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 gap-y-2 border-b py-3 last:border-b-0 min-[801px]:grid-cols-[24px_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.6fr)] min-[801px]:items-start"
                data-testid={`channel-row-${ch.id}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-[18px] w-[18px] accent-[hsl(var(--primary))]"
                  aria-label={`Listen in #${ch.name ?? ch.id}`}
                  checked={on}
                  disabled={!!bound}
                  onChange={(e) => update(ch, { on: e.target.checked, nestId: nest })}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1 font-medium">
                    {ch.is_private || ch.is_ext_shared ? <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                    <span className="truncate">{ch.name ?? ch.id}</span>
                  </div>
                  <div className="text-sm text-muted-foreground">{channelMeta(ch)}</div>
                </div>
                <div className="col-start-2 min-[801px]:col-start-auto">
                  {bound ? (
                    <span className="text-sm text-muted-foreground">Into {nestName(bound.nest_id)}</span>
                  ) : (
                    <NestSelect label={`Nest for #${ch.name ?? ch.id}`} value={nest} nests={state.nests} onChange={(v) => update(ch, { nestId: v, on: true })} className="w-full" />
                  )}
                </div>
                <div className="col-start-2 min-[801px]:col-start-auto">
                  {bound ? (
                    <BindingManage channel={ch} binding={bound} state={state} onChanged={load} />
                  ) : (
                    <GuardCell
                      view={p?.on ? viewFor(p) : undefined}
                      channel={ch}
                      addTo={(() => {
                        const v = p?.on ? viewFor(p) : undefined;
                        if (!p || !v || v === "loading" || !v.add?.length) return null;
                        return <AddToNest members={v.add} nestId={p.nestId} nestName={nestName(p.nestId)} channel={ch.name ?? ch.id} onAdded={() => recheck(p)} />;
                      })()}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
      {truncated && <p className="mt-2 text-sm text-muted-foreground">Nest is in more channels than this list shows, so some may be missing here.</p>}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-primary">Who counts as someone who can read a nest?</summary>
        <p className="mt-2 max-w-2xl text-foreground/80">
          People it's shared with, teams, stewards, org keys, other agents, and any outbound connector on that nest. Server admins can read every nest and are left out of the check. If we can't list a channel's members, we refuse rather than guess.
        </p>
      </details>
      <FootBar
        left={
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
        }
        right={
          <Button onClick={next} disabled={onCount === 0 && state.bindings.length === 0}>
            {onCount ? `Check ${onCount} ${onCount === 1 ? "channel" : "channels"}` : "Continue"}
          </Button>
        }
      />
    </>
  );
}

// ─── 3. Check who can read ──────────────────────────────────────────────────

function CheckStep({ state, back, toChannels, next }: { state: SetupState; back: () => void; toChannels: () => void; next: () => void }) {
  const { viewFor, byChannel } = usePreviews(state);
  const [busy, setBusy] = useState<string | null>(null);
  const on = state.picks.filter((p) => p.on);
  const views = byChannel();
  const open = unresolved(state.picks, views);
  const loading = on.some((p) => viewFor(p) === "loading" || viewFor(p) === undefined);
  const okList = on.filter((p) => !open.includes(p));
  const nestName = (id: string) => state.nests.find((n) => n.id === id)?.name ?? "this nest";
  const org = state.status?.org_name;

  const patch = (id: string, change: Partial<ChannelPick>) => state.setPicks((ps) => ps.map((p) => (p.channelId === id ? { ...p, ...change } : p)));

  const createFor = async (p: ChannelPick) => {
    setBusy(p.channelId);
    try {
      const name = nestNameForChannel(p.channelName);
      const r = await createNest(name, `Notes saved from #${p.channelName}.`);
      state.addNest({ id: r.nest.id, name: r.nest.name ?? name });
      patch(p.channelId, { nestId: r.nest.id });
      toast.success(`Created the ${name} nest. Only you can read it until you share it.`);
    } catch (e) {
      toast.error(errText(e, "Couldn't create the nest."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <StepHeading
        title="Check who can read"
        lede="A channel can only save into a nest if everyone who can read that nest is in the channel. Otherwise people who were never in the conversation could read what was said in it."
      />
      {state.bindings.length > 0 && on.length === 0 && (
        <div className="mb-3">
          <Note tone="ok" icon="check">
            <b>
              {state.bindings.length} {state.bindings.length === 1 ? "channel is" : "channels are"} already bound.
            </b>{" "}
            Their checks passed when they were turned on, and the guard keeps checking them.
          </Note>
        </div>
      )}
      {loading && <p className="mb-3 text-sm text-muted-foreground">Checking…</p>}
      <div className="space-y-3" data-testid="setup-check">
        {open.map((p) => {
          const v = views[p.channelId];
          if (!v) return null;
          const ext = v.state === "external";
          return (
            <Note key={p.channelId} tone={ext ? "warn" : "bad"} testId={`refusal-${p.channelId}`}>
              <b>
                #{p.channelName} → {nestName(p.nestId)}: {ext ? "off by default" : "refused"}.
              </b>
              <GuardNote view={v} className="mt-1" />
              <div className="mt-2 flex flex-wrap gap-2">
                {fixOptions(v).map((f) =>
                  f === "create_nest" ? (
                    <Button key={f} variant="outline" className={small} disabled={busy === p.channelId} onClick={() => createFor(p)}>
                      <FolderPlus className="mr-1.5 h-4 w-4" aria-hidden />
                      Create a {nestNameForChannel(p.channelName)} nest for this channel
                    </Button>
                  ) : f === "other_nest" ? (
                    <Button key={f} variant="outline" className={small} onClick={toChannels}>
                      Choose another nest
                    </Button>
                  ) : f === "ext_only" ? (
                    <Button key={f} variant="outline" className={small} onClick={() => patch(p.channelId, { extCapture: true })}>
                      Listen to {org ? `${org} people` : "your own people"} only
                    </Button>
                  ) : (
                    <Button key={f} variant="ghost" className={small} onClick={() => patch(p.channelId, { on: false })}>
                      Leave #{p.channelName} off
                    </Button>
                  ),
                )}
              </div>
            </Note>
          );
        })}
        {okList.length > 0 && (
          <Note tone="ok" icon="check" testId="setup-check-ok">
            <b>
              {okList.length} {okList.length === 1 ? "channel" : "channels"} can listen:
            </b>{" "}
            {okList.map((p) => `#${p.channelName} → ${nestName(p.nestId)}`).join(", ")}.
          </Note>
        )}
      </div>
      <FootBar
        left={
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
        }
        right={
          <Button
            onClick={() => {
              state.setChecked(true);
              next();
            }}
            disabled={open.length > 0 || loading || (on.length === 0 && state.bindings.length === 0)}
            data-testid="setup-check-continue"
          >
            {open.length ? `Resolve ${open.length} first` : "Continue"}
          </Button>
        }
      />
    </>
  );
}

// ─── 4. Add starter folders ─────────────────────────────────────────────────

function StarterStep({ state, back, next }: { state: SetupState; back: () => void; next: () => void }) {
  const targets = state.progress.targetNestIds;
  const unseeded = targets.filter((n) => !state.seeded.includes(n));
  const [nestId, setNestId] = useState<string>(unseeded[0] ?? targets[0] ?? "");
  const [seeds, setSeeds] = useState<SurfacesSeedRef[]>([]);
  const [seedKey, setSeedKey] = useState<string>("");
  const [dry, setDry] = useState<SurfacesSeedResult | null>(null);
  const [applied, setApplied] = useState<{ seed: string; nest: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const nestName = (id: string) => state.nests.find((n) => n.id === id)?.name ?? "this nest";

  // Facts first: a target nest that already has a seed counts as done.
  useEffect(() => {
    let live = true;
    for (const n of targets) {
      if (state.seeded.includes(n)) continue;
      getSurfacesSeedStatus(n)
        .then((r) => live && !r.no_seed && state.markSeeded(n))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join(",")]);

  useEffect(() => {
    if (!nestId && (unseeded[0] || targets[0])) setNestId(unseeded[0] ?? targets[0]);
  }, [nestId, unseeded, targets]);

  useEffect(() => {
    if (!nestId) return;
    let live = true;
    setDry(null);
    listSurfacesSeeds(nestId)
      .then((s) => {
        if (!live) return;
        setSeeds(s);
        setSeedKey((k) => (s.some((x) => `${x.library_nest_id ?? ""}:${x.id}` === k) ? k : s[0] ? `${s[0].library_nest_id ?? ""}:${s[0].id}` : ""));
      })
      .catch(() => live && setSeeds([]));
    return () => {
      live = false;
    };
  }, [nestId]);

  const seed = seeds.find((s) => `${s.library_nest_id ?? ""}:${s.id}` === seedKey) ?? null;
  const tree = dry ? dryRunTree(dry.items) : null;
  const nestDone = state.seeded.includes(nestId);

  const preview = async () => {
    if (!seed) return;
    setBusy(true);
    try {
      setDry(await applySurfacesSeed({ nest_id: nestId, seed_id: seed.id, library_nest_id: seed.library_nest_id, dry_run: true }));
    } catch (e) {
      toast.error(errText(e, "Couldn't preview the starter."));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!seed || !dry) return;
    setBusy(true);
    try {
      const r = await applySurfacesSeed({ nest_id: nestId, seed_id: seed.id, library_nest_id: seed.library_nest_id });
      if (r.status === "partial") toast.warning("Some items didn't apply. Applying again completes them.");
      state.markSeeded(nestId);
      setApplied({ seed: `${seed.title} v${seed.version}`, nest: nestName(nestId) });
      const rest = unseeded.filter((n) => n !== nestId);
      if (rest[0]) {
        setNestId(rest[0]);
        setDry(null);
      }
    } catch (e) {
      toast.error(errText(e, "Couldn't apply the starter."));
    } finally {
      setBusy(false);
    }
  };

  const allDone = targets.length > 0 && targets.every((n) => state.seeded.includes(n));
  const shownTree = tree && (dry?.nest_id === nestId ? tree : null);

  return (
    <>
      <StepHeading
        title="Add starter folders"
        lede="The listener can only propose into folders the starter creates. Rename or delete any of it later. Running it again never duplicates anything or touches your edits."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[1101px]:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              aria-label="Starter"
              value={seedKey}
              onChange={(e) => {
                setSeedKey(e.target.value);
                setDry(null);
              }}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {seeds.length === 0 && <option value="">No starters available</option>}
              {seeds.map((s) => (
                <option key={`${s.library_nest_id ?? ""}:${s.id}`} value={`${s.library_nest_id ?? ""}:${s.id}`}>
                  {s.title} · v{s.version}
                </option>
              ))}
            </select>
            <NestSelect label="Apply to" value={nestId} nests={state.nests.filter((n) => targets.includes(n.id))} onChange={(v) => setNestId(v)} />
          </div>
          {shownTree ? (
            <>
              <div className="rounded-md border bg-zinc-50 px-3.5 py-3 font-mono text-sm leading-[1.9]" data-testid="setup-seed-tree">
                {shownTree.rows.map((r) => (
                  <div key={r.label} data-mark={r.mark} className="min-w-0 break-words">
                    <span className={r.mark === "add" ? "font-semibold text-green-700" : "text-muted-foreground"} aria-label={r.mark === "add" ? "will be created" : "already exists"}>
                      {r.mark === "add" ? "+" : "="}
                    </span>{" "}
                    {r.label} {r.note && <span className="font-sans text-muted-foreground">{r.note}</span>}
                  </div>
                ))}
                {dry && dry.listener.propose_folders.length > 0 && (
                  <div className="min-w-0 break-words">
                    <span className="font-semibold text-green-700">+</span> listener for {nestName(nestId)}{" "}
                    <span className="font-sans text-muted-foreground">
                      Reads only {nestName(nestId)}. Proposes only into these folders. Never publishes.
                    </span>
                  </div>
                )}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">+ will be created · = already exists, left as it is</p>
            </>
          ) : (
            <div className="rounded-lg border border-dashed px-5 py-6 text-center">
              <FolderPlus className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="mb-3 text-sm text-muted-foreground">{nestDone ? `${nestName(nestId)} already has a starter.` : "Preview exactly what this adds before anything is written."}</p>
              <Button variant="outline" onClick={preview} disabled={busy || !seed || !nestId}>
                Preview changes
              </Button>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <Note tone="warn">
            <b>people/ is limited by design.</b> Only role, ownership and contact facts. The listener never proposes pay, health, performance or personal matters, anywhere.
          </Note>
          {shownTree && !nestDone && (
            <Note tone="info" icon="check" testId="setup-dry-run">
              <b>Dry run, nothing written.</b> {dryRunSummary(shownTree)}
            </Note>
          )}
          {applied && (
            <Note tone="ok" icon="check" testId="setup-applied">
              <b>
                Applied {applied.seed} to {applied.nest}.
              </b>
              {unseeded.length > 0 && ` ${unseeded.length} more ${unseeded.length === 1 ? "nest needs" : "nests need"} a starter.`}
            </Note>
          )}
        </div>
      </div>
      <FootBar
        left={
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
        }
        right={
          allDone ? (
            <Button onClick={next}>Continue</Button>
          ) : (
            <Button onClick={apply} disabled={busy || !shownTree || nestDone}>
              Apply starter
            </Button>
          )
        }
      />
    </>
  );
}

// ─── 5. Turn on listening ───────────────────────────────────────────────────

function ListenStep({ state, back, onDone, onHow }: { state: SetupState; back: () => void; onDone: () => void; onHow: () => void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [unnoticed, setUnnoticed] = useState<string[]>([]);
  const views = usePreviews(state).byChannel();
  const toBind = state.picks.filter((p) => p.on && !state.bindings.some((b) => b.conversation_id === p.channelId) && views[p.channelId] && !unresolved([p], views).length);
  const listening = state.progress.done[4];
  const nestName = (id: string) => state.nests.find((n) => n.id === id)?.name ?? "this nest";
  const nests = [...new Set(toBind.map((p) => p.nestId))];
  const noticeNest = nests.length === 1 ? nestName(nests[0]) : nests.length ? "the channel's nest" : nestName(state.bindings[0]?.nest_id ?? "");
  const quiet = state.settings?.quiet_minutes ?? DEFAULT_SETTINGS_COPY.quiet_minutes;

  const turnOn = async () => {
    if (!state.install) return;
    setBusy(true);
    const failed: string[] = [];
    const silent: string[] = [];
    for (const p of toBind) {
      try {
        const r = await createSurfacesBinding({ install_id: state.install.id, conversation_id: p.channelId, nest_id: p.nestId, ext_capture_enabled: !!p.extCapture });
        if (r.notice === "failed") silent.push(`#${p.channelName}`);
      } catch (e) {
        failed.push(`#${p.channelName}: ${errText(e, "couldn't turn on")}`);
      }
    }
    setErrors(failed);
    setUnnoticed(silent);
    await state.reload();
    state.setPicks((ps) => ps.filter((p) => failed.some((f) => f.startsWith(`#${p.channelName}:`))));
    setBusy(false);
  };

  return (
    <>
      <StepHeading
        title="Turn on listening"
        lede="Each channel gets one notice, now. After that the bot speaks only when it has something worth one reviewer's click. Most days, in most channels, that is never."
      />
      <div className="max-w-[620px] rounded-lg border p-4 text-sm" data-testid="setup-notice">
        <div className="mb-2 text-muted-foreground">
          {toBind.length ? `Notice posted to ${toBind.map((p) => `#${p.channelName}`).join(", ")}` : "The notice each channel gets"}
        </div>
        {noticeParagraphs(noticeNest, state.settings?.buffer_ttl_hours ?? DEFAULT_SETTINGS_COPY.buffer_ttl_hours).map((t, i) => (
          <p key={i} className={cn("leading-relaxed", i < 2 && "mb-2")}>
            {i === 0 ? (
              <>
                <b>{t.slice(0, t.indexOf(".") + 1)}</b>
                {t.slice(t.indexOf(".") + 1)}
              </>
            ) : (
              t
            )}
          </p>
        ))}
        <p className="mt-2">
          <a href="/about/surfaces" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
            How Nest handles your messages
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </p>
      </div>
      {unnoticed.length > 0 && (
        <div className="mt-4">
          <Note tone="bad" testId="setup-notice-missing">
            <b>The notice wasn't posted in {unnoticed.join(", ")}.</b> Nest is listening there, but members haven&apos;t been told yet. Remove the channel and turn it on again to retry the notice.
          </Note>
        </div>
      )}
      {errors.length > 0 && (
        <div className="mt-4">
          <Note tone="bad">
            <b>Some channels didn't turn on.</b>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Note>
        </div>
      )}
      {listening && (
        <div className="mt-4">
          <Note tone="ok" icon="check" testId="setup-listening">
            <b>
              Listening in {state.bindings.length} {state.bindings.length === 1 ? "channel" : "channels"}.
            </b>{" "}
            A thread is first reviewed about {quiet} minutes after it goes quiet.{" "}
            <button type="button" className="text-primary underline underline-offset-2" onClick={onHow}>
              How it decides what to keep
            </button>
          </Note>
        </div>
      )}
      <FootBar
        left={
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
        }
        right={
          toBind.length > 0 ? (
            <Button key="turn-on" onClick={turnOn} disabled={busy} data-testid="setup-turn-on">
              Turn on {toBind.length} {toBind.length === 1 ? "channel" : "channels"}
            </Button>
          ) : (
            <Button key="overview" onClick={onDone} disabled={!listening}>
              Go to Overview
            </Button>
          )
        }
      />
    </>
  );
}
