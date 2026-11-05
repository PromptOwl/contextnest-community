/**
 * ConnectedAppsPage — the agents that signed in as you through MCP OAuth
 * (Claude, Claude Code, ChatGPT, …), and the button that disconnects one.
 *
 * Disconnecting revokes every token that app holds for you, at once: its next
 * request fails, and it has to send you through sign-in and consent again.
 * API keys are separate and live on the API keys page.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plug, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
import * as api from "../../../lib/api";
import { reads, useConnectedApps } from "../../../lib/queries";
import { parseServerDate } from "../../../lib/dates";
import { ReasonDialog } from "../../../components/governance";

const SCOPE_LABEL: Record<string, string> = {
  "nests:read": "Read",
  "nests:write": "Edit",
  offline_access: "Stays connected",
};

function when(value: string | null): string {
  if (!value) return "never";
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString() : "never";
}

export default function ConnectedAppsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useConnectedApps();
  const apps = data?.apps ?? [];
  // One id at a time: which row is mid-request, so only its button spins.
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; name: string; expired: boolean } | null>(null);

  async function disconnect(id: string) {
    setBusy(id);
    try {
      await api.disconnectApp(id);
      toast.success("App disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect.");
    } finally {
      // Refresh either way: the server is the truth about what is connected.
      qc.invalidateQueries({ queryKey: reads.connectedApps().queryKey });
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle
        icon={Plug}
        title="Connected apps"
        description="Agents you connected by signing in. Each one reads as you and sees what you can see."
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        // Never show "no apps" when we simply could not ask: that reads as
        // "nothing is connected" while agents may still hold live access.
        <div
          className="flex flex-col items-center gap-2 rounded-md border border-destructive/40 p-6 text-center text-sm"
          data-testid="connected-apps-error"
        >
          <p className="text-destructive">
            Couldn't load your connected apps
            {error instanceof Error && error.message ? `: ${error.message}` : "."}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : apps.length === 0 ? (
        <div
          className="rounded-md border p-6 text-center text-sm text-muted-foreground"
          data-testid="connected-apps-empty"
        >
          No connected apps. When you connect Claude or another agent by
          signing in, it shows up here.
        </div>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="connected-apps-list">
          {apps.map((a) => (
            <li
              key={a.clientId}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="connected-app-row"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{a.clientName}</p>
                  {a.expired && (
                    <Badge variant="destructive" className="shrink-0" data-testid="connected-app-expired">
                      Expired
                    </Badge>
                  )}
                  {a.scopes.map((s) => (
                    <Badge key={s} variant="outline" className="shrink-0">
                      {SCOPE_LABEL[s] ?? s}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {a.redirectOrigin && (
                    <>
                      <code className="font-mono">{a.redirectOrigin}</code> ·{" "}
                    </>
                  )}
                  connected {when(a.connectedAt)} · last used {when(a.lastUsedAt)}
                </p>
                {a.expired && (
                  <p className="text-xs text-muted-foreground">
                    Signed out. Reconnect it from {a.clientName} to use it again.
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy === a.clientId}
                onClick={() => setTarget({ id: a.clientId, name: a.clientName, expired: a.expired })}
              >
                {busy === a.clientId ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Unplug className="mr-1.5 h-3.5 w-3.5" />
                )}
                {a.expired ? "Remove" : "Disconnect"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Changing your password disconnects every app at once. API keys are
        managed separately, on the API keys page.
      </p>

      {target && (
        <ReasonDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          title={target.expired ? `Remove "${target.name}"?` : `Disconnect "${target.name}"?`}
          description={
            target.expired
              ? "It is already signed out. This removes it from the list."
              : "It loses access right away. To use it again, connect it and approve it again."
          }
          confirmLabel={target.expired ? "Remove" : "Disconnect"}
          destructive
          onConfirm={() => disconnect(target.id)}
        />
      )}
    </div>
  );
}
