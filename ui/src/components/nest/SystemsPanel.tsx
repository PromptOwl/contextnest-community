/**
 * SystemsPanel — named system keys working in this nest (CU-wdqcq06djb), the
 * UI twin of /systems and MCP `context_systems`. Owner / nest admin only (the
 * host gates it; the server re-checks every call). Same shape as
 * HeadlessAccessPanel: a key is shown once, on create and rotate.
 */
import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/ui/copy-button";
import * as api from "../../lib/api";
import { keyLastUsedLabel } from "../../lib/headless";

export function SystemsPanel({ nestId }: { nestId: string }) {
  const [systems, setSystems] = useState<api.SystemInfo[]>([]);
  // Nests the caller administers — the only ones a system can be added to.
  const [adminNests, setAdminNests] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [capability, setCapability] = useState<"read" | "write">("read");
  const [fresh, setFresh] = useState<{ name: string; apiKey: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<api.SystemInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([api.listNestSystems(nestId), api.listNests()]);
      setSystems(s.systems);
      setAdminNests(n.nests.filter((x) => x.permission === "owner" || x.permission === "admin"));
    } catch (err: any) {
      toast.error(err?.message || "Couldn't load systems");
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every action: busy, call, reload; failures surface as a toast.
  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err: any) {
      toast.error(err?.message || fallback);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const res = await api.createSystem(name.trim(), capability, [nestId]);
      setFresh({ name: res.name, apiKey: res.api_key });
      setName("");
    }, "Couldn't create the system");

  const rotate = (s: api.SystemInfo) =>
    act(async () => {
      const res = await api.rotateSystem(s.id);
      setFresh({ name: res.name, apiKey: res.api_key });
    }, "Couldn't rotate the key");

  const revoke = (s: api.SystemInfo) =>
    act(async () => {
      setRevokeTarget(null);
      await api.revokeSystem(s.id);
      toast.success(`"${s.name}" revoked — its key has stopped working.`);
    }, "Couldn't revoke the system");

  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="systems-panel">
      <div className="space-y-1">
        <Label className="flex items-center gap-2 text-sm font-medium">
          <Bot className="h-4 w-4" /> Systems
        </Label>
        <p className="text-xs text-muted-foreground">
          Named keys for machines and integrations (e.g. "GitHub sync"). Each acts as its own
          identity in history, with read or write access to the nests you give it.
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="System name, e.g. GitHub sync"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && void create()}
          disabled={busy}
        />
        <Select value={capability} onValueChange={(v) => setCapability(v as "read" | "write")}>
          <SelectTrigger className="w-[110px]" aria-label="Access">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">Read</SelectItem>
            <SelectItem value="write">Write</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => void create()} disabled={busy || !name.trim()} data-testid="system-create">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
        </Button>
      </div>

      {fresh && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 text-xs dark:bg-amber-950/30">
          <p className="font-medium">Key for {fresh.name}: copy it now. It won't be shown again.</p>
          <pre className="whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">{fresh.apiKey}</pre>
          <div className="flex gap-2">
            <CopyButton text={fresh.apiKey} label="Copy" toastMessage="Key copied to clipboard" />
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {systems.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {systems.map((s) => {
            const addable = adminNests.filter((n) => !s.nests.some((x) => x.id === n.id));
            // Rotate/revoke reach every nest it works in; the server refuses them
            // unless the caller administers all of those nests.
            const notWhole = s.other_nest_count > 0
              ? "It also works in nests you don't administer. Remove this nest from it instead."
              : undefined;
            return (
              <li key={s.id} className="space-y-1.5 px-3 py-2" data-testid={`system-row-${s.id}`}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <Badge variant="secondary" className="text-[10px] capitalize">{s.capability}</Badge>
                  <Button size="sm" variant="ghost" aria-label={`Rotate ${s.name}'s key`} title={notWhole ?? "Rotate key"} disabled={busy || !!notWhole} onClick={() => void rotate(s)}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Revoke ${s.name}`} title={notWhole ?? "Revoke"} disabled={busy || !!notWhole} onClick={() => setRevokeTarget(s)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.key_prefix && <span className="font-mono">{s.key_prefix}… · </span>}
                  {s.created_by_email ? `Created by ${s.created_by_email} · ` : ""}
                  {keyLastUsedLabel(s.last_used_at)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {s.nests.map((n) => (
                    <Badge key={n.id} variant="outline" className="gap-1 text-[11px]">
                      {n.name}
                      <button
                        type="button"
                        aria-label={`Remove ${s.name} from ${n.name}`}
                        disabled={busy}
                        onClick={() => void act(() => api.removeSystemNest(s.id, n.id), "Couldn't remove the nest")}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  {s.other_nest_count > 0 && (
                    <span className="text-[11px] text-muted-foreground">+{s.other_nest_count} other</span>
                  )}
                  {addable.length > 0 && (
                    <Select
                      value=""
                      onValueChange={(id) => void act(() => api.addSystemNest(s.id, id), "Couldn't add the nest")}
                      disabled={busy}
                    >
                      <SelectTrigger className="h-6 w-[130px] text-[11px]" aria-label={`Add a nest to ${s.name}`}>
                        <SelectValue placeholder="Add nest…" />
                      </SelectTrigger>
                      <SelectContent>
                        {addable.map((n) => (
                          <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke system?</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke &ldquo;{revokeTarget?.name}&rdquo;? Its key stops working immediately, in every nest.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && void revoke(revokeTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="system-revoke-confirm"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
