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
import {
  applySurfacesSeed,
  createNest,
  createSlackInstall,
  createSurfacesBinding,
  getSlackInstall,
  getSurfacesSeedStatus,
  getSurfacesSettings,
  getSurfacesStatus,
  listNests,
  listSlackChannels,
  listSurfacesBindings,
  listSurfacesSeeds,
  previewSurfacesBinding,
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
  SETUP_STEPS,
  deriveProgress,
  dryRunSummary,
  dryRunTree,
  fixOptions,
  guardView,
  nestNameForChannel,
  neverList,
  noticeParagraphs,
  pickInstall,
  unresolved,
  willList,
  type ChannelPick,
  type GuardView,
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

  const install = useMemo(() => pickInstall(status?.installs ?? []), [status]);

  const reload = useCallback(async () => {
    try {
      const [st, se, bs, ns] = await Promise.all([
        getSurfacesStatus(),
        getSurfacesSettings().catch(() => null),
        listSurfacesBindings().catch(() => [] as SurfacesBinding[]),
        listNests().catch(() => ({ nests: [] as any[] })),
      ]);
      const inst = pickInstall(st.installs);
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

function NestSelect({ id, value, nests, onChange, label, className }: { id?: string; value: string; nests: NestRef[]; onChange: (v: string) => void; label: string; className?: string }) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      {!nests.some((n) => n.id === value) && <option value={value}>{value ? "Choose a nest" : "Choose a nest"}</option>}
      {nests.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
        </option>
      ))}
    </select>
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

function ConnectStep({ state, next }: { state: SetupState; next: () => void }) {
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
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [inst, connected]);

  const allCreds = CRED_FIELDS.every((f) => creds[f.key]);
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
      }
      if (m) downloadJson("nest-slack-manifest.json", m);
    } catch (e) {
      toast.error(errText(e, "Couldn't start the install."));
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

  return (
    <>
      <StepHeading
        title="Connect Slack"
        lede={`This installs ${org ? `${org}'s` : "your"} own copy of the Nest app in your Slack workspace. Installing it doesn't read anything: you pick channels in the next step.`}
      />
      <WillNever settings={state.settings} />
      {connected ? (
        <Note tone="ok" icon="check" testId="setup-connected">
          <b>Connected to Slack.</b> {homeName ? `Saved notes land in ${homeName} unless a channel says otherwise.` : "Saved notes land in the nest each channel is bound to."}
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
              <Button variant="outline" onClick={download} disabled={busy || (!inst && !homeNest)}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                Download manifest
              </Button>
            )}
            <Button onClick={approve} disabled={busy || (hosted ? !homeNest : !inst || !allCreds)}>
              Open Slack to approve
            </Button>
          </div>
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
        .then((r) => guardView(r, { channel: p.channelName, nest: nestName(p.nestId), orgName: state.status?.org_name }))
        .catch((e): GuardView => ({ state: "refused", label: "Can't listen here", note: errText(e, "The check failed.") }))
        .then((g) => setViews((v) => ({ ...v, [k]: g })))
        .finally(() => inflight.current.delete(k));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.picks, state.install, views, nestName, state.status?.org_name]);

  const viewFor = (p: ChannelPick): GuardView | "loading" | undefined => views[keyOf(p)];
  const byChannel = (): Record<string, GuardView | undefined> => {
    const out: Record<string, GuardView | undefined> = {};
    for (const p of state.picks) {
      const v = views[keyOf(p)];
      out[p.channelId] = v && v !== "loading" ? v : undefined;
    }
    return out;
  };
  return { viewFor, byChannel };
}

function GuardCell({ view, channel }: { view: GuardView | "loading" | undefined; channel: SurfacesChannel }) {
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
        {view.note && <span className="text-muted-foreground">{view.note}</span>}
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
      {view.note && <span className="text-muted-foreground">{view.note}</span>}
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
  const { viewFor } = usePreviews(state);

  const load = useCallback(async () => {
    if (!inst || inst.status !== "active") return;
    setErr(null);
    try {
      const r = await listSlackChannels(inst.id);
      setChannels(r.channels);
      setTruncated(r.truncated);
    } catch (e) {
      setErr(errText(e, "Couldn't list the channels."));
      setChannels([]);
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
            Nest isn't in any channel yet. In Slack, open a channel, type <code className="rounded bg-muted px-1">/invite</code> and pick Nest. It can only listen where it was added.
          </p>
          <Button variant="outline" className="mt-3" onClick={load}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Check again
          </Button>
        </div>
      ) : (
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
                    <span className="flex items-center gap-1.5 text-sm">
                      <Dot tone={bound.status === "active" ? "ok" : "warn"} />
                      {bound.status === "active" ? "Listening" : "Paused"}
                    </span>
                  ) : (
                    <GuardCell view={p?.on ? viewFor(p) : undefined} channel={ch} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {truncated && <p className="mt-2 text-sm text-muted-foreground">Showing the first 2,000 channels Nest is in.</p>}
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
              </b>{" "}
              {v.note}
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
    for (const p of toBind) {
      try {
        await createSurfacesBinding({ install_id: state.install.id, conversation_id: p.channelId, nest_id: p.nestId, ext_capture_enabled: !!p.extCapture });
      } catch (e) {
        failed.push(`#${p.channelName}: ${errText(e, "couldn't turn on")}`);
      }
    }
    setErrors(failed);
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
        {noticeParagraphs(noticeNest).map((t, i) => (
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
