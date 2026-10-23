/**
 * The body of a nest's Plugins page: one card per plugin the server loaded,
 * each with a settings form generated from the plugin's JSON Schema (secrets
 * are write-only and show only as "••••"), Run now, connection health and the
 * recent run ledger.
 *
 * Presentational: the page (pages/nest/plugins) owns the data and the calls,
 * so this renders the same from a mocked response in a test as in the app.
 * Ported from #294's NestPluginsPanel onto Slice A's API — the schedule,
 * webhook and OAuth parts of that panel belong to later slices.
 *
 * Who sees what (the server enforces it; this only avoids dead buttons):
 *   nest owner/admin  configure, enable, remove, run
 *   editor (write)    run
 *   viewer (read)     read settings (secrets masked) and run history
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NestPlugin, NestPluginsResponse, PluginRun } from "../../lib/api";
import {
  RUN_STATUS_LABEL,
  SECRET_MASK,
  draftFromPlugin,
  pluginFields,
  roleAllows,
  runCounts,
  runTrigger,
  secretIsSet,
  type PluginDraft,
  type PluginField,
  type PluginRole,
} from "../../lib/nest-plugins";
import { formatServerDate, relTime } from "../../lib/dates";

export type PluginBusy = "save" | "run" | "remove" | "toggle" | "health";

export interface NestPluginsListProps {
  data: NestPluginsResponse;
  role: PluginRole;
  /** What is in flight, per plugin name. */
  busy?: Record<string, PluginBusy | undefined>;
  /** Last connection check, per plugin name. */
  health?: Record<string, { ok: boolean; detail?: string } | undefined>;
  /** The server's last refusal, per plugin name. */
  errors?: Record<string, string | undefined>;
  /** Field-level problems from the last save, per plugin name. */
  fieldErrors?: Record<string, Record<string, string> | undefined>;
  /** Extra runs loaded past the list's last ten, per plugin name. */
  moreRuns?: Record<string, PluginRun[] | undefined>;
  onSave: (plugin: NestPlugin, draft: PluginDraft, opts: { enabled?: boolean }) => void;
  onToggle: (plugin: NestPlugin, enabled: boolean) => void;
  onRun: (plugin: NestPlugin) => void;
  onRemove: (plugin: NestPlugin) => void;
  onCheckHealth: (plugin: NestPlugin) => void;
  onLoadMoreRuns?: (plugin: NestPlugin) => void;
  onOpenDocument?: (nodeId: string) => void;
}

const fieldId = (plugin: string, key: string) => `plugin-${plugin}-${key}`;

function StatusBadge({ plugin }: { plugin: NestPlugin }) {
  if (!plugin.configured) return <Badge variant="neutral">Not set up</Badge>;
  return plugin.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="neutral">Off</Badge>;
}

function RunBadge({ status }: { status: PluginRun["status"] }) {
  const variant = status === "clean" ? "success" : status === "conflicts" ? "warning" : "rejected";
  return (
    <Badge variant={variant} className="shrink-0 font-medium">
      {RUN_STATUS_LABEL[status]}
    </Badge>
  );
}

function SettingField({
  plugin,
  field,
  draft,
  setDraft,
  canConfigure,
  error,
}: {
  plugin: NestPlugin;
  field: PluginField;
  draft: PluginDraft;
  setDraft: (d: PluginDraft) => void;
  canConfigure: boolean;
  error?: string;
}) {
  const id = fieldId(plugin.name, field.key);
  const value = draft.values[field.key];
  const setValue = (v: string | boolean) => setDraft({ ...draft, values: { ...draft.values, [field.key]: v } });
  const errorClass = error ? "border-destructive focus-visible:ring-destructive" : "";
  const isSet = field.kind === "secret" && secretIsSet(plugin, field.key);
  const clearing = !!draft.clear[field.key];

  let control;
  if (field.kind === "select") {
    control = (
      <Select value={typeof value === "string" && value ? value : undefined} onValueChange={setValue} disabled={!canConfigure}>
        <SelectTrigger id={id} className={`h-9 ${errorClass}`} aria-invalid={!!error}>
          <SelectValue placeholder={field.defaultValue !== undefined ? String(field.defaultValue) : "Choose"} />
        </SelectTrigger>
        <SelectContent>
          {field.options!.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (field.kind === "boolean") {
    control = (
      <div className="flex h-9 items-center">
        <Switch id={id} checked={value === true} onCheckedChange={setValue} disabled={!canConfigure} />
      </div>
    );
  } else {
    control = (
      <Input
        id={id}
        className={`h-9 ${field.kind === "secret" ? "font-mono" : ""} ${errorClass}`}
        type={field.kind === "secret" ? "password" : field.kind === "integer" || field.kind === "number" ? "number" : "text"}
        // Secrets are write-only: the input never holds the stored value, and
        // the mask the server sends stands in for it as the placeholder.
        value={typeof value === "string" ? value : ""}
        placeholder={
          field.kind === "secret"
            ? isSet && !clearing
              ? SECRET_MASK
              : "Not set"
            : field.defaultValue !== undefined
              ? String(field.defaultValue)
              : ""
        }
        min={field.min}
        max={field.max}
        step={field.kind === "integer" ? 1 : undefined}
        autoComplete={field.kind === "secret" ? "new-password" : "off"}
        spellCheck={false}
        aria-invalid={!!error}
        onChange={(e) => setValue(e.target.value)}
        disabled={!canConfigure || clearing}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {field.title}
        {field.required && <span className="text-muted-foreground"> *</span>}
      </Label>
      {control}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {field.kind === "secret" && isSet && canConfigure && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {clearing ? "Will be removed when you save." : "Saved. Type a new value to replace it."}
          <button
            type="button"
            className={`hover:underline ${clearing ? "" : "text-destructive"}`}
            onClick={() => setDraft({ ...draft, clear: { ...draft.clear, [field.key]: !clearing }, values: { ...draft.values, [field.key]: "" } })}
          >
            {clearing ? "Keep" : "Clear"}
          </button>
        </p>
      )}
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}

function RunRow({ run, canSeeErrors, onOpenDocument }: { run: PluginRun; canSeeErrors: boolean; onOpenDocument?: (id: string) => void }) {
  return (
    <li className="space-y-1 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RunBadge status={run.status} />
        <span className="text-sm tabular-nums">{runCounts(run)}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        <span title={formatServerDate(run.started_at)}>{relTime(run.started_at) || formatServerDate(run.started_at)}</span>
        {" · "}
        {runTrigger(run.triggered_by)}
      </div>
      {run.error && <p className="break-words text-xs text-destructive">{canSeeErrors ? run.error : "The run failed."}</p>}
      {run.failed.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {run.failed.slice(0, 5).map((f) => (
            <li key={f.externalId} className="break-words">
              <span className="font-mono">{f.externalId}</span>
              {f.error && <span className="text-destructive"> — {f.error}</span>}
            </li>
          ))}
          {run.failed.length > 5 && <li className="text-muted-foreground">and {run.failed.length - 5} more</li>}
        </ul>
      )}
      {run.conflicts.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Not overwritten because someone edited them here:{" "}
          {run.conflicts.slice(0, 5).map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              {onOpenDocument ? (
                <button type="button" className="font-mono text-foreground hover:underline" onClick={() => onOpenDocument(c.id)}>
                  {c.id}
                </button>
              ) : (
                <span className="font-mono">{c.id}</span>
              )}
            </span>
          ))}
          {run.conflicts.length > 5 && ` and ${run.conflicts.length - 5} more`}
        </div>
      )}
    </li>
  );
}

function PluginCard({
  plugin,
  role,
  defaultOpen,
  busy,
  health,
  error,
  fieldErrors,
  moreRuns,
  onSave,
  onToggle,
  onRun,
  onRemove,
  onCheckHealth,
  onLoadMoreRuns,
  onOpenDocument,
}: Omit<NestPluginsListProps, "data" | "busy" | "health" | "errors" | "fieldErrors" | "moreRuns"> & {
  plugin: NestPlugin;
  defaultOpen: boolean;
  busy?: PluginBusy;
  health?: { ok: boolean; detail?: string };
  error?: string;
  fieldErrors?: Record<string, string>;
  moreRuns?: PluginRun[];
}) {
  const canConfigure = roleAllows(role, "configure");
  const canRun = roleAllows(role, "run");
  const fields = useMemo(() => pluginFields(plugin), [plugin]);
  const [open, setOpen] = useState(defaultOpen || plugin.configured);
  const [draft, setDraft] = useState(() => draftFromPlugin(plugin));
  // A saved or refetched config resets the form to what the server holds.
  const savedKey = JSON.stringify([plugin.configured, plugin.folder, plugin.settings]);
  useEffect(() => setDraft(draftFromPlugin(plugin)), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runs = moreRuns ?? plugin.runs;
  const canPull = plugin.faces.pull;

  return (
    <Card data-plugin={plugin.name} className="overflow-hidden">
      <CardHeader className="gap-3 space-y-0 pb-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold leading-tight">{plugin.displayName}</h2>
              <span className="text-xs text-muted-foreground">v{plugin.version}</span>
              <StatusBadge plugin={plugin} />
              {plugin.last_status && plugin.last_run_at && (
                <span className="text-xs text-muted-foreground">
                  Last run {relTime(plugin.last_run_at)}: {RUN_STATUS_LABEL[plugin.last_status].toLowerCase()}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {plugin.enabled && canPull && canRun && (
              <Button size="sm" variant="outline" onClick={() => onRun(plugin)} disabled={!!busy}>
                {busy === "run" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {busy === "run" ? "Running" : "Run now"}
              </Button>
            )}
            <Switch
              checked={plugin.enabled}
              disabled={!canConfigure || !plugin.configured || !!busy}
              onCheckedChange={(v) => onToggle(plugin, v)}
              aria-label={`${plugin.enabled ? "Turn off" : "Turn on"} ${plugin.displayName}`}
              title={!plugin.configured ? "Set it up below first" : undefined}
            />
          </div>
        </div>
        {/* Its own row, so on a phone the actions don't squeeze it into a column. */}
        <p className="text-sm text-muted-foreground sm:pl-12">{plugin.description}</p>
      </CardHeader>

      <CardContent className="pb-5">
        <button
          type="button"
          className="mb-3 flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          {open ? "Hide details" : plugin.configured || !canConfigure ? "Show details" : "Set up"}
        </button>

        {open && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <section className="space-y-4" aria-label={`${plugin.displayName} settings`}>
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="break-words">{error}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <SettingField
                    key={f.key}
                    plugin={plugin}
                    field={f}
                    draft={draft}
                    setDraft={setDraft}
                    canConfigure={canConfigure}
                    error={fieldErrors?.[f.key]}
                  />
                ))}
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId(plugin.name, "__folder")} className="text-sm">
                    Nest folder
                  </Label>
                  <Input
                    id={fieldId(plugin.name, "__folder")}
                    className="h-9"
                    value={draft.folder}
                    placeholder={plugin.faces.process ? "Nest root" : `inbox/${plugin.name}`}
                    onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
                    disabled={!canConfigure}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">Every document this plugin writes lands under this folder.</p>
                </div>
              </div>

              {canConfigure && (
                <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                  {plugin.configured ? (
                    <Button size="sm" onClick={() => onSave(plugin, draft, {})} disabled={!!busy}>
                      {busy === "save" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
                      Save
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => onSave(plugin, draft, { enabled: true })} disabled={!!busy}>
                      {busy === "save" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
                      Save and enable
                    </Button>
                  )}
                  {plugin.configured && (
                    <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => onRemove(plugin)} disabled={!!busy}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-4 lg:border-l lg:pl-6" aria-label={`${plugin.displayName} activity`}>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Connection</h3>
                {plugin.system ? (
                  <p className="text-xs text-muted-foreground">
                    Writes as <span className="font-medium text-foreground">{plugin.system.name}</span>, a system identity with
                    write access to this nest only. On a governed nest, what it writes waits for review.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Once enabled, it writes as its own system identity, with write access to this nest only.
                  </p>
                )}
                {plugin.faces.healthcheck && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => onCheckHealth(plugin)} disabled={busy === "health"}>
                      {busy === "health" ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      )}
                      Check connection
                    </Button>
                    {health && (
                      <span className={`flex min-w-0 items-center gap-1.5 text-xs ${health.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
                        {health.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                        <span className="break-words">{health.ok ? "Connection works" : health.detail || "Connection failed"}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium">Recent runs</h3>
                {runs.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plugin.enabled ? "No runs yet." : "No runs yet. Runs appear here once it is enabled and run."}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {runs.map((r) => (
                      <RunRow key={r.id} run={r} canSeeErrors={canRun} onOpenDocument={onOpenDocument} />
                    ))}
                  </ul>
                )}
                {!moreRuns && plugin.runs.length >= 10 && onLoadMoreRuns && (
                  <Button size="sm" variant="ghost" className="mt-1 px-2 text-muted-foreground" onClick={() => onLoadMoreRuns(plugin)}>
                    Show older runs
                  </Button>
                )}
              </div>
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function NestPluginsList(props: NestPluginsListProps) {
  const { data, role, busy, health, errors, fieldErrors, moreRuns } = props;
  const canConfigure = roleAllows(role, "configure");
  const canRun = roleAllows(role, "run");
  // A short list opens every card; a long one opens the ones in use.
  const defaultOpen = data.plugins.length <= 3;

  return (
    <div className="space-y-4">
      {!canConfigure && (
        <p className="text-sm text-muted-foreground">
          {canRun
            ? "You can run plugins. Only nest owners and admins change plugin settings."
            : "You can see what is connected. Running a plugin needs edit access, and only nest owners and admins change plugin settings."}
        </p>
      )}

      {data.load_errors.length > 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {data.load_errors.length === 1 ? "A plugin package" : `${data.load_errors.length} plugin packages`} on this server failed to
            load
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-0.5 text-xs">
              {data.load_errors.map((e) => (
                <li key={e.spec} className="break-words">
                  <span className="font-mono">{e.spec}</span>: {e.error}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">A server admin fixes this under Server settings, Features, Plugins.</p>
          </AlertDescription>
        </Alert>
      )}

      {data.plugins.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center">
          <Plug className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">No plugins are installed on this server</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A server admin adds plugin packages under Server settings, Features, Plugins. They show up here once loaded.
          </p>
        </div>
      ) : (
        data.plugins.map((p) => (
          <PluginCard
            key={p.name}
            role={role}
            onSave={props.onSave}
            onToggle={props.onToggle}
            onRun={props.onRun}
            onRemove={props.onRemove}
            onCheckHealth={props.onCheckHealth}
            onLoadMoreRuns={props.onLoadMoreRuns}
            onOpenDocument={props.onOpenDocument}
            plugin={p}
            defaultOpen={defaultOpen}
            busy={busy?.[p.name]}
            health={health?.[p.name]}
            error={errors?.[p.name]}
            fieldErrors={fieldErrors?.[p.name]}
            moreRuns={moreRuns?.[p.name]}
          />
        ))
      )}
    </div>
  );
}
