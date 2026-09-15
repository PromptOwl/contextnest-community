/**
 * NestPluginsPanel — the Plugins tab on a nest. One row per plugin the
 * server has loaded; expanding a row shows a form rendered from the plugin's
 * settings JSON Schema (secrets are write-only and masked), the run options
 * (raw / summary, target folder, pull cadence), the webhook URL when the
 * plugin accepts one, and the recent run ledger with conflicts called out.
 *
 * Deliberately plain: the same Card / Input / Switch / Badge primitives the
 * rest of the nest uses, laid out as a settings list — no bespoke chrome.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Play, Plug, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import type { NestPlugin, PluginRun } from "../lib/api";

interface Props {
  nestId: string;
  /** False renders read-only (viewers can see what is connected). */
  canEdit: boolean;
  /** Called after an ingest so the document list can refresh. */
  onIngested?: () => void;
}

type Field = { key: string; title: string; description?: string; type: string; enum?: string[]; secret: boolean; required: boolean; def?: unknown };

function fieldsOf(p: NestPlugin): Field[] {
  const props = p.settingsSchema.properties ?? {};
  const required = new Set(p.settingsSchema.required ?? []);
  const out: Field[] = Object.entries(props).map(([key, def]) => ({
    key,
    title: def.title ?? key,
    description: def.description,
    type: def.type ?? "string",
    enum: def.enum,
    secret: p.secretKeys.includes(key),
    required: required.has(key),
    def: def.default,
  }));
  // The reserved webhook secret is not in the plugin's schema; show it when relevant.
  if (p.faces.webhook && !props.webhookSecret) {
    out.push({ key: "webhookSecret", title: "Webhook signing secret", description: "Shared with the sender; the plugin verifies every delivery with it.", type: "string", secret: true, required: false });
  }
  return out;
}

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

function RunStatus({ status }: { status: PluginRun["status"] | string | null }) {
  if (!status) return null;
  const variant = status === "clean" ? "secondary" : status === "conflicts" ? "outline" : "destructive";
  return <Badge variant={variant as any} className="text-[10px]">{status}</Badge>;
}

function PluginRow({ nestId, plugin, canEdit, onChanged, onIngested }: { nestId: string; plugin: NestPlugin; canEdit: boolean; onChanged: (p: NestPlugin) => void; onIngested?: () => void }) {
  const [open, setOpen] = useState(plugin.configured && plugin.enabled);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"raw" | "summary">(plugin.mode);
  const [folder, setFolder] = useState(plugin.folder ?? "");
  const [every, setEvery] = useState(plugin.every_minutes ? String(plugin.every_minutes) : "");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; detail?: string } | null>(null);

  useEffect(() => {
    setMode(plugin.mode);
    setFolder(plugin.folder ?? "");
    setEvery(plugin.every_minutes ? String(plugin.every_minutes) : "");
    setDraft({});
  }, [plugin]);

  const fields = fieldsOf(plugin);

  const save = async (extra: Parameters<typeof api.updateNestPlugin>[2] = {}) => {
    setSaving(true);
    setError(null);
    try {
      const settings: Record<string, unknown> = {};
      for (const f of fields) {
        if (!(f.key in draft)) continue;
        const raw = draft[f.key];
        if (f.secret && raw === "") continue; // untouched secret
        settings[f.key] = f.type === "integer" || f.type === "number" ? (raw === "" ? null : Number(raw)) : f.type === "boolean" ? raw === "true" : raw;
      }
      const { plugin: next } = await api.updateNestPlugin(nestId, plugin.name, {
        mode,
        folder: folder.trim() || null,
        every_minutes: every.trim() ? Number(every) : null,
        ...(Object.keys(settings).length ? { settings } : {}),
        ...extra,
      });
      onChanged(next);
      toast.success(`${plugin.displayName} saved`);
    } catch (e: any) {
      setError(e?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (enabled && !plugin.configured) {
      await save({ enabled: true });
      return;
    }
    setSaving(true);
    try {
      const { plugin: next } = await api.updateNestPlugin(nestId, plugin.name, { enabled });
      onChanged(next);
    } catch (e: any) {
      toast.error(e?.message || "Could not update");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const { run } = await api.runNestPlugin(nestId, plugin.name);
      const { plugins } = await api.listNestPlugins(nestId);
      const next = plugins.find((p) => p.name === plugin.name);
      if (next) onChanged(next);
      if (run.status === "failed") toast.error(run.error || `${plugin.displayName}: run failed`);
      else toast.success(`${plugin.displayName}: ${run.created} created, ${run.updated} updated, ${run.unchanged} unchanged${run.conflicts.length ? `, ${run.conflicts.length} kept (local edits)` : ""}`);
      onIngested?.();
    } catch (e: any) {
      setError(e?.message || "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const checkHealth = async () => {
    setHealth(null);
    try {
      setHealth(await api.nestPluginHealth(nestId, plugin.name));
    } catch (e: any) {
      setHealth({ ok: false, detail: e?.message });
    }
  };

  const remove = async () => {
    if (!confirm(`Disconnect ${plugin.displayName} from this nest? Its settings and secrets are forgotten; nodes it wrote stay.`)) return;
    try {
      await api.removeNestPlugin(nestId, plugin.name);
      const { plugins } = await api.listNestPlugins(nestId);
      const next = plugins.find((p) => p.name === plugin.name);
      if (next) onChanged(next);
    } catch (e: any) {
      toast.error(e?.message || "Could not remove");
    }
  };

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-3 py-3">
        <button type="button" className="text-muted-foreground" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{plugin.displayName}</span>
            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
            {plugin.capabilities.map((c) => (
              <Badge key={c} variant="outline" className="text-[10px] font-normal">{c}</Badge>
            ))}
            <RunStatus status={plugin.last_status} />
          </div>
          <div className="text-sm text-muted-foreground truncate">{plugin.description}</div>
        </div>
        {plugin.enabled && canEdit && plugin.faces.pull && (
          <Button variant="outline" size="sm" onClick={runNow} disabled={running} title="Pull now">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            <span className="ml-1.5 hidden sm:inline">Run now</span>
          </Button>
        )}
        <Switch checked={plugin.enabled} disabled={!canEdit || saving} onCheckedChange={toggle} aria-label={`Enable ${plugin.displayName}`} />
      </div>

      {open && (
        <div className="pb-4 pl-7 space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`${plugin.name}-${f.key}`} className="text-sm">
                  {f.title}
                  {f.required && <span className="text-muted-foreground"> *</span>}
                </Label>
                {f.enum ? (
                  <Select value={draft[f.key] ?? String(plugin.settings[f.key] ?? f.def ?? "")} onValueChange={(v) => setDraft({ ...draft, [f.key]: v })} disabled={!canEdit}>
                    <SelectTrigger id={`${plugin.name}-${f.key}`} className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>{f.enum.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                  </Select>
                ) : f.type === "boolean" ? (
                  <div className="h-8 flex items-center">
                    <Switch checked={(draft[f.key] ?? String(plugin.settings[f.key] ?? f.def ?? "false")) === "true"} onCheckedChange={(v) => setDraft({ ...draft, [f.key]: String(v) })} disabled={!canEdit} />
                  </div>
                ) : (
                  <Input
                    id={`${plugin.name}-${f.key}`}
                    type={f.secret ? "password" : f.type === "integer" || f.type === "number" ? "number" : "text"}
                    className="h-8"
                    autoComplete="off"
                    placeholder={f.secret ? (plugin.settings[f.key] ? String(plugin.settings[f.key]) : "not set") : f.def !== undefined ? String(f.def) : ""}
                    value={draft[f.key] ?? (f.secret ? "" : String(plugin.settings[f.key] ?? ""))}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    disabled={!canEdit}
                  />
                )}
                {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-sm">Ingest as</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "raw" | "summary")} disabled={!canEdit}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw">Raw — verbatim</SelectItem>
                  <SelectItem value="summary">Summary — distilled, raw kept</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Target folder</Label>
              <Input className="h-8" value={folder} placeholder={plugin.faces.process ? "nest root" : `inbox/${plugin.name}`} onChange={(e) => setFolder(e.target.value)} disabled={!canEdit} />
            </div>
            {plugin.faces.pull && (
              <div className="space-y-1">
                <Label className="text-sm">Pull every (minutes)</Label>
                <Input className="h-8" type="number" min={5} value={every} placeholder="manual only" onChange={(e) => setEvery(e.target.value)} disabled={!canEdit} />
              </div>
            )}
          </div>

          {plugin.webhook_url && (
            <div className="space-y-1">
              <Label className="text-sm">Webhook URL</Label>
              <div className="flex items-center gap-2">
                <Input className="h-8 font-mono text-xs" readOnly value={plugin.webhook_url} onFocus={(e) => e.currentTarget.select()} />
                <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(plugin.webhook_url!); toast.success("Copied"); }}>Copy</Button>
              </div>
              <p className="text-xs text-muted-foreground">Point {plugin.displayName} at this URL. The token in the path is the credential — treat it like a password.</p>
            </div>
          )}

          {canEdit && (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => save()} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save
              </Button>
              {plugin.faces.healthcheck && (
                <Button variant="outline" size="sm" onClick={checkHealth}>
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                  Test connection
                </Button>
              )}
              {plugin.configured && (
                <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={remove}>
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Disconnect
                </Button>
              )}
              {health && (
                <span className={`text-sm ${health.ok ? "text-muted-foreground" : "text-destructive"}`}>
                  {health.ok ? "Connected" : health.detail || "Failed"}
                </span>
              )}
            </div>
          )}

          {plugin.runs.length > 0 && (
            <div className="text-sm">
              <div className="text-muted-foreground mb-1">Recent runs · last {fmtTime(plugin.last_run_at)}</div>
              <table className="w-full text-xs">
                <tbody>
                  {plugin.runs.slice(0, 5).map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">{fmtTime(r.started_at)}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{r.triggered_by.replace(/^manual:/, "")}</td>
                      <td className="py-1 pr-3"><RunStatus status={r.status} /></td>
                      <td className="py-1 pr-3">{r.created} created · {r.updated} updated · {r.unchanged} unchanged</td>
                      <td className="py-1 text-muted-foreground">
                        {r.conflicts.length > 0 && <span title={r.conflicts.map((c) => c.id).join("\n")}>{r.conflicts.length} kept (edited locally)</span>}
                        {r.error && <span className="text-destructive">{r.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NestPluginsPanel({ nestId, canEdit, onIngested }: Props) {
  const [plugins, setPlugins] = useState<NestPlugin[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<Array<{ spec: string; error: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listNestPlugins(nestId);
      setPlugins(r.plugins);
      setLoadErrors(r.load_errors);
    } catch (e: any) {
      setError(e?.message || "Could not load plugins");
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Plug className="h-4 w-4" />
          Plugins
        </CardTitle>
        <CardDescription>
          Connected sources for this nest. Ingested content lands through the same review path as any edit; nodes you edit by hand are never overwritten.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-3">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loadErrors.length > 0 && (
          <Alert className="mb-3">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {loadErrors.length} plugin package{loadErrors.length === 1 ? "" : "s"} failed to load on this server — see Server settings → Plugins.
            </AlertDescription>
          </Alert>
        )}
        {plugins === null ? (
          <div className="text-sm text-muted-foreground py-6 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : plugins.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6">
            No plugins are installed on this server. A server admin adds packages under Server settings → Plugins.
          </div>
        ) : (
          plugins.map((p) => (
            <PluginRow key={p.name} nestId={nestId} plugin={p} canEdit={canEdit} onIngested={onIngested} onChanged={(next) => setPlugins((cur) => (cur ?? []).map((x) => (x.name === next.name ? next : x)))} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
