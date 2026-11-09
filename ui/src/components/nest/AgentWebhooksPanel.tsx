/**
 * AgentWebhooksPanel — where an @mention of an agent is delivered (PO-1181),
 * the UI twin of /agent-webhooks and MCP `context_agent_webhooks`. Owner /
 * nest admin only (the host gates it; the server re-checks every call). A
 * target shows as host#hash; the signing secret is shown once, on the first
 * save or a rotate, like a system key.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/ui/copy-button";
import * as api from "../../lib/api";

export function AgentWebhooksPanel({ nestId }: { nestId: string }) {
  const [hooks, setHooks] = useState<api.AgentWebhook[]>([]);
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ handle: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setHooks((await api.listAgentWebhooks(nestId)).webhooks);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't load agent webhooks");
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const save = () =>
    act(async () => {
      const res = await api.setAgentWebhook(nestId, handle.trim(), url.trim());
      if (res.secret) setFresh({ handle: res.webhook.handle, secret: res.secret });
      else toast.success(`Updated @${res.webhook.handle}; its signing secret is unchanged.`);
      setHandle("");
      setUrl("");
    }, "Couldn't save the webhook");

  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="agent-webhooks-panel">
      <div className="space-y-1">
        <Label className="flex items-center gap-2 text-sm font-medium">
          <Webhook className="h-4 w-4" /> Agent webhooks
        </Label>
        <p className="text-xs text-muted-foreground">
          When someone @mentions an agent here, its runner gets one signed POST. Public https URLs only.
        </p>
      </div>
      <div className="flex gap-2">
        <Input value={handle} placeholder="grok" aria-label="Agent handle" className="w-32" onChange={(e) => setHandle(e.target.value)} disabled={busy} />
        <Input value={url} placeholder="https://runner.example.com/wake" aria-label="Webhook URL" onChange={(e) => setUrl(e.target.value)} disabled={busy} />
        <Button onClick={() => void save()} disabled={busy || !handle.trim() || !url.trim()} data-testid="agent-webhook-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      {fresh && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 text-xs dark:bg-amber-950/30">
          <p className="font-medium">Signing secret for @{fresh.handle}: copy it into the runner now. It won't be shown again.</p>
          <pre className="whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">{fresh.secret}</pre>
          <div className="flex gap-2">
            <CopyButton text={fresh.secret} label="Copy" toastMessage="Secret copied to clipboard" />
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {hooks.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {hooks.map((h) => (
            <li key={h.handle} className="flex items-center gap-2 px-3 py-2">
              <span className="font-medium">@{h.handle}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{h.target}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Rotate @${h.handle}'s secret`}
                title="Rotate secret (needs the URL again)"
                disabled={busy || !url.trim()}
                onClick={() =>
                  void act(async () => {
                    const res = await api.setAgentWebhook(nestId, h.handle, url.trim(), true);
                    if (res.secret) setFresh({ handle: h.handle, secret: res.secret });
                    setUrl("");
                  }, "Couldn't rotate the secret")
                }
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove @${h.handle}`}
                disabled={busy}
                onClick={() => void act(() => api.deleteAgentWebhook(nestId, h.handle), "Couldn't remove the webhook")}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
