/**
 * Plugins — a nest's connected outside sources (Nest Plugins, Slice A). Loads
 * GET /nests/:id/plugins and the caller's permission on the nest, and owns
 * every call: configure (PUT), turn on/off, remove (DELETE), run now (POST
 * /run), health and older runs. NestPluginsList renders it.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { NestPageHeader } from "../NestPageHeader";
import { NestPluginsList, type PluginBusy } from "./NestPluginsList";
import * as api from "../../lib/api";
import type { NestPlugin, NestPluginsResponse, PluginRun } from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import { isNestArchived } from "../../lib/nest-caps";
import { buildConfigureBody, pluginRole, runToast, type PluginDraft, type PluginRole } from "../../lib/nest-plugins";

interface Props {
  nestId: string;
  nestName: string;
  isArchived?: boolean;
  onBack: () => void;
  openDocument: (nodeId: string) => void;
}

type PerPlugin<T> = Record<string, T | undefined>;

export function PluginsPage({ nestId, nestName, isArchived, onBack, openDocument }: Props) {
  const qc = useQueryClient();
  const list = useQuery(reads.plugins(nestId));
  const nest = useQuery(reads.nest(nestId));
  // Until the nest read lands the page is read-only, never a form that vanishes.
  const role: PluginRole = nest.data
    ? pluginRole((nest.data as any).permission, { isArchived: isArchived || isNestArchived((nest.data as any).nest) })
    : "viewer";

  const [busy, setBusy] = useState<PerPlugin<PluginBusy>>({});
  const [health, setHealth] = useState<PerPlugin<{ ok: boolean; detail?: string }>>({});
  const [errors, setErrors] = useState<PerPlugin<string>>({});
  const [fieldErrors, setFieldErrors] = useState<PerPlugin<Record<string, string>>>({});
  const [moreRuns, setMoreRuns] = useState<PerPlugin<PluginRun[]>>({});
  const [removing, setRemoving] = useState<NestPlugin | null>(null);
  useEffect(() => {
    setBusy({});
    setHealth({});
    setErrors({});
    setFieldErrors({});
    setMoreRuns({});
  }, [nestId]);

  const mark = (name: string, b: PluginBusy | undefined) => setBusy((m) => ({ ...m, [name]: b }));
  const replace = (next: NestPlugin) =>
    qc.setQueryData<NestPluginsResponse>(keys.plugins(nestId), (cur) =>
      cur ? { ...cur, plugins: cur.plugins.map((p) => (p.name === next.name ? next : p)) } : cur,
    );

  const save = async (plugin: NestPlugin, draft: PluginDraft, opts: { enabled?: boolean }) => {
    const built = buildConfigureBody(plugin, draft, opts);
    setErrors((m) => ({ ...m, [plugin.name]: undefined }));
    if (!built.ok) {
      setFieldErrors((m) => ({ ...m, [plugin.name]: built.errors }));
      return;
    }
    setFieldErrors((m) => ({ ...m, [plugin.name]: undefined }));
    mark(plugin.name, "save");
    try {
      const { plugin: next } = await api.configureNestPlugin(nestId, plugin.name, built.body);
      replace(next);
      setHealth((m) => ({ ...m, [plugin.name]: undefined }));
      toast.success(opts.enabled ? `${plugin.displayName} is on` : `${plugin.displayName} saved`);
    } catch (e: any) {
      setErrors((m) => ({ ...m, [plugin.name]: e?.message || "Could not save" }));
    } finally {
      mark(plugin.name, undefined);
    }
  };

  const toggle = async (plugin: NestPlugin, enabled: boolean) => {
    mark(plugin.name, "toggle");
    setErrors((m) => ({ ...m, [plugin.name]: undefined }));
    try {
      const { plugin: next } = await api.configureNestPlugin(nestId, plugin.name, { enabled });
      replace(next);
      toast.success(`${plugin.displayName} is ${enabled ? "on" : "off"}`);
    } catch (e: any) {
      setErrors((m) => ({ ...m, [plugin.name]: e?.message || "Could not update" }));
    } finally {
      mark(plugin.name, undefined);
    }
  };

  const run = async (plugin: NestPlugin) => {
    mark(plugin.name, "run");
    setErrors((m) => ({ ...m, [plugin.name]: undefined }));
    try {
      const { run: r } = await api.runNestPlugin(nestId, plugin.name);
      if (r.status === "failed") toast.error(runToast(plugin.displayName, r));
      else toast.success(runToast(plugin.displayName, r));
      setMoreRuns((m) => ({ ...m, [plugin.name]: undefined }));
      // The run wrote documents: the listings, the review queue and this list move.
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.plugins(nestId) }),
        qc.invalidateQueries({ queryKey: keys.nodes(nestId) }),
      ]);
      api.invalidateNestReads(nestId);
    } catch (e: any) {
      setErrors((m) => ({ ...m, [plugin.name]: e?.message || "The run could not start" }));
    } finally {
      mark(plugin.name, undefined);
    }
  };

  const checkHealth = async (plugin: NestPlugin) => {
    mark(plugin.name, "health");
    try {
      const h = await api.nestPluginHealth(nestId, plugin.name);
      setHealth((m) => ({ ...m, [plugin.name]: h }));
    } catch (e: any) {
      setHealth((m) => ({ ...m, [plugin.name]: { ok: false, detail: e?.message } }));
    } finally {
      mark(plugin.name, undefined);
    }
  };

  const loadMoreRuns = async (plugin: NestPlugin) => {
    try {
      const { runs } = await api.listNestPluginRuns(nestId, plugin.name, 50);
      setMoreRuns((m) => ({ ...m, [plugin.name]: runs }));
    } catch (e: any) {
      toast.error(e?.message || "Could not load older runs");
    }
  };

  const confirmRemove = async () => {
    const plugin = removing;
    if (!plugin) return;
    setRemoving(null);
    mark(plugin.name, "remove");
    try {
      await api.removeNestPlugin(nestId, plugin.name);
      setHealth((m) => ({ ...m, [plugin.name]: undefined }));
      await qc.invalidateQueries({ queryKey: keys.plugins(nestId) });
      toast.success(`${plugin.displayName} removed from ${nestName}`);
    } catch (e: any) {
      setErrors((m) => ({ ...m, [plugin.name]: e?.message || "Could not remove" }));
    } finally {
      mark(plugin.name, undefined);
    }
  };

  return (
    <div className="space-y-4 pb-16 sm:pb-0">
      <NestPageHeader
        nestName={nestName}
        onBack={onBack}
        title={
          <h1 className="flex min-w-0 items-center gap-2 truncate text-xl font-semibold">
            <Plug className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            Plugins
          </h1>
        }
      />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Plugins bring content from outside sources into {nestName}. What they write goes through the same review and
        structure rules as any edit, and a document someone has edited here is never overwritten.
      </p>

      {list.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load the plugins of {nestName}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{(list.error as Error)?.message}</p>
            <Button variant="outline" size="sm" onClick={() => list.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : !list.data ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading plugins…</div>
      ) : (
        <NestPluginsList
          data={list.data}
          role={role}
          busy={busy}
          health={health}
          errors={errors}
          fieldErrors={fieldErrors}
          moreRuns={moreRuns}
          onSave={save}
          onToggle={toggle}
          onRun={run}
          onRemove={setRemoving}
          onCheckHealth={checkHealth}
          onLoadMoreRuns={loadMoreRuns}
          onOpenDocument={openDocument}
        />
      )}

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.displayName} from {nestName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its settings and stored credentials are deleted, and its system identity is retired. Documents it already
              wrote stay in the nest.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
