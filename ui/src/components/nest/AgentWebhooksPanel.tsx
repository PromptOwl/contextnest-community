/**
 * AgentWebhooksPanel — where an @mention of an agent is delivered (PO-1181),
 * the UI twin of /agent-webhooks and MCP `context_agent_webhooks`. Owner /
 * nest admin only (the host gates it; the server re-checks every call).
 *
 * A target shows as host#hash, never the URL. The signing secret is shown
 * once, in a dialog that stays until it is dismissed (PO-1189: it used to
 * render below the fold and a second save replaced it). Each row carries its
 * last delivery, a test send, rotate (the stored URL is reused) and remove.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, Send, ShieldAlert, Trash2, Webhook, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReasonDialog } from "../governance/ReasonDialog";
import * as api from "../../lib/api";
import { formatServerDate, relTime } from "../../lib/dates";
import { reads } from "../../lib/queries";

/** A row's last delivery in words: what happened, why, and to which event. */
export function deliverySummary(d: api.AgentWebhookDelivery | null | undefined): {
  tone: "ok" | "failed" | "pending" | "none";
  text: string;
} {
  if (!d) return { tone: "none", text: "Nothing sent yet" };
  const what = d.event === "agent.test" ? "Test" : "Mention";
  if (d.status === "ok") return { tone: "ok", text: `${what} delivered` };
  if (d.status === "pending") return { tone: "pending", text: `${what} is being delivered` };
  const tries = d.attempts > 1 ? ` after ${d.attempts} tries` : "";
  return { tone: "failed", text: `${what} failed${d.reason ? `: ${d.reason}` : ""}${tries}` };
}

const TONE = {
  ok: { Icon: CheckCircle2, className: "text-emerald-700 dark:text-emerald-400" },
  failed: { Icon: XCircle, className: "text-destructive" },
  pending: { Icon: Clock, className: "text-muted-foreground" },
  none: { Icon: Clock, className: "text-muted-foreground" },
} as const;

export function DeliveryStatus({ delivery }: { delivery: api.AgentWebhookDelivery | null | undefined }) {
  const { tone, text } = deliverySummary(delivery);
  const { Icon, className } = TONE[tone];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 text-xs ${className}`} data-testid="agent-webhook-delivery" data-status={tone}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="[overflow-wrap:anywhere]">{text}</span>
      {delivery && (
        <time className="shrink-0 text-muted-foreground" dateTime={delivery.at} title={formatServerDate(delivery.at)}>
          · {relTime(delivery.at)}
        </time>
      )}
    </span>
  );
}

/** The one-time signing secret. Only its button closes it, so it cannot be missed. */
function SecretDialog({ fresh, onClose }: { fresh: { handle: string; secret: string; rotated: boolean } | null; onClose: () => void }) {
  return (
    <Dialog open={!!fresh} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[480px]"
        hideCloseButton
        // The secret is gone once this closes: only the button closes it.
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        data-testid="agent-webhook-secret-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 sm:justify-start">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">Signing secret for @{fresh?.handle}</span>
          </DialogTitle>
          <DialogDescription>
            This secret is shown <strong>only once</strong>. Copy it into the agent's runner now; it proves that a wake-up really came from
            this nest.{fresh?.rotated ? " The previous secret has stopped working." : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs" data-testid="agent-webhook-secret">
            {fresh?.secret}
          </code>
          <CopyButton text={fresh?.secret ?? ""} label="Copy" toastMessage="Secret copied to clipboard" />
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={onClose} data-testid="agent-webhook-secret-close">
            I've saved it, close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentWebhooksPanel({ nestId }: { nestId: string }) {
  const hooks = useQuery(reads.agentWebhooks(nestId));
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** The handle whose test send is in flight. */
  const [testing, setTesting] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ handle: string; secret: string; rotated: boolean } | null>(null);
  const [rotating, setRotating] = useState<api.AgentWebhook | null>(null);
  const [removing, setRemoving] = useState<api.AgentWebhook | null>(null);

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const res = await api.setAgentWebhook(nestId, handle.trim().replace(/^@/, ""), url.trim());
      if (res.secret) setFresh({ handle: res.webhook.handle, secret: res.secret, rotated: false });
      else toast.success(`Updated @${res.webhook.handle}. Its signing secret is unchanged.`);
      setHandle("");
      setUrl("");
    } catch (err: any) {
      // The server's message already says what a valid target is (public https,
      // a tunnel for local testing): show it as is, next to the field.
      setFormError(err?.message || "Couldn't save the webhook");
    } finally {
      setSaving(false);
    }
  };

  const test = async (h: api.AgentWebhook) => {
    setTesting(h.handle);
    try {
      const res = await api.testAgentWebhook(nestId, h.handle);
      const { text } = deliverySummary(res.delivery);
      if (res.ok) toast.success(`@${h.handle}: ${text.toLowerCase()}`);
      else toast.error(`@${h.handle}: ${text.toLowerCase()}`);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't send the test event");
    } finally {
      setTesting(null);
    }
  };

  const rows = hooks.data?.webhooks ?? [];
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="agent-webhooks-panel">
      <div className="space-y-1">
        <Label className="flex items-center gap-2 text-sm font-medium">
          <Webhook className="h-4 w-4" /> Agent webhooks
        </Label>
        <p className="text-xs text-muted-foreground">
          When someone @mentions an agent in a channel, its runner gets one signed POST. Public https URLs only.
        </p>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (handle.trim() && url.trim() && !saving) void save();
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={handle}
            placeholder="grok"
            aria-label="Agent handle"
            className="sm:w-32"
            onChange={(e) => setHandle(e.target.value)}
            disabled={saving}
          />
          <Input
            value={url}
            placeholder="https://runner.example.com/wake"
            aria-label="Webhook URL"
            className="min-w-0 flex-1"
            onChange={(e) => setUrl(e.target.value)}
            disabled={saving}
          />
          <Button type="submit" disabled={saving || !handle.trim() || !url.trim()} data-testid="agent-webhook-save">
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
        {formError && (
          <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert" data-testid="agent-webhook-error">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {formError}
          </p>
        )}
      </form>

      {hooks.isError && !hooks.data ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs" role="alert">
          <span>Couldn't load agent webhooks. {(hooks.error as Error)?.message}</span>
          <Button size="sm" variant="outline" onClick={() => void hooks.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        rows.length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {rows.map((h) => (
              <li key={h.handle} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" data-testid="agent-webhook-row">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium">@{h.handle}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{h.target}</span>
                  </div>
                  <DeliveryStatus delivery={h.last_delivery} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing !== null}
                    onClick={() => void test(h)}
                    data-testid="agent-webhook-test"
                  >
                    {testing === h.handle ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                    Send test event
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    aria-label={`Rotate @${h.handle}'s secret`}
                    title="Rotate the signing secret"
                    onClick={() => setRotating(h)}
                    data-testid="agent-webhook-rotate"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    aria-label={`Remove @${h.handle}`}
                    title="Remove"
                    onClick={() => setRemoving(h)}
                    data-testid="agent-webhook-remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      <SecretDialog fresh={fresh} onClose={() => setFresh(null)} />
      <ReasonDialog
        open={!!rotating}
        onOpenChange={(open) => !open && setRotating(null)}
        title={rotating ? `Rotate @${rotating.handle}'s secret?` : ""}
        description="The current secret stops working at once. The runner needs the new one before it can verify another wake-up. The URL stays as it is."
        confirmLabel="Rotate secret"
        destructive
        onConfirm={async () => {
          if (!rotating) return;
          const res = await api.rotateAgentWebhookSecret(nestId, rotating.handle);
          setFresh({ handle: rotating.handle, secret: res.secret, rotated: true });
        }}
      />
      <ReasonDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? `Remove @${removing.handle}'s webhook?` : ""}
        description="Mentions of this agent will no longer wake it. It still sees them when it next checks its work."
        confirmLabel="Remove webhook"
        destructive
        onConfirm={async () => {
          if (removing) await api.deleteAgentWebhook(nestId, removing.handle);
        }}
      />
    </div>
  );
}
