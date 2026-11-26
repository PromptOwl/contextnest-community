/**
 * The server's one Slack app: create it from the manifest, keep its addresses,
 * save its three keys. Shown in Control room → Setup and Server settings →
 * Surfaces; both read and write the same server settings, so they never differ.
 */
import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getSlackApp, updateAdminSettings } from "../../../lib/api";
import { SLACK_BOT_EVENTS, SLACK_BOT_SCOPES } from "../../../lib/control-room-setup";

type Key = "client_id" | "client_secret" | "signing_secret";
const FIELDS: ReadonlyArray<{ key: Key; label: string }> = [
  { key: "client_id", label: "Client ID" },
  { key: "client_secret", label: "Client secret" },
  { key: "signing_secret", label: "Signing secret" },
];
const ADDRESSES = [
  { key: "events", label: "Event Subscriptions → Request URL" },
  { key: "interactions", label: "Interactivity → Request URL" },
  { key: "redirect", label: "OAuth & Permissions → Redirect URL" },
] as const;

type App = Awaited<ReturnType<typeof getSlackApp>>;

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

/** po-1448: setting the app up by hand instead of from the manifest, with this server's own addresses. */
function ByHandGuide({ urls }: { urls: App["urls"] }) {
  const row = (where: string, text: string, testId?: string) => (
    <li>
      {where}
      <div className="mt-1 flex min-w-0 items-start gap-2" data-testid={testId}>
        <code className="min-w-0 rounded bg-muted px-1.5 py-0.5 text-xs [overflow-wrap:anywhere]">{text}</code>
        <CopyButton text={text.replace(/, /g, "\n")} toastMessage="Copied" />
      </div>
    </li>
  );
  return (
    <details className="rounded-md border px-3 py-2" data-testid="hosted-slack-guide">
      <summary className="cursor-pointer font-medium">Set the app up by hand instead</summary>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-foreground/80">
        <li>
          Open{" "}
          <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="underline">
            api.slack.com/apps
          </a>{" "}
          and create the app, or open the existing one.
        </li>
        <li>In Basic Information → App Credentials, copy the Client ID, Client Secret and Signing Secret into the fields below.</li>
        {row("In OAuth & Permissions → Redirect URLs, add:", urls.redirect)}
        {row("In OAuth & Permissions → Bot Token Scopes, add:", SLACK_BOT_SCOPES.join(", "), "hosted-slack-scopes")}
        {row("In Event Subscriptions, turn events on and set the Request URL to:", urls.events)}
        {row("On the same page, under Subscribe to bot events, add these (message.groups is what private channels need):", SLACK_BOT_EVENTS.join(", "), "hosted-slack-events")}
        {row("In Interactivity & Shortcuts, turn interactivity on and set the Request URL to:", urls.interactions)}
        {row("In Slash Commands, create /nest (or another name, if an app in this workspace already uses it) with the Request URL:", urls.commands)}
        <li>After changing scopes or events on an app that is already installed, use Install App → Reinstall to Workspace.</li>
      </ol>
    </details>
  );
}

/** `onReady` tells the parent whether all three keys are saved; `heading` off when the parent already titles it. */
export function SlackAppCard({ onReady, heading = true }: { onReady?: (ready: boolean) => void; heading?: boolean }) {
  const [app, setApp] = useState<App | null>(null);
  const [values, setValues] = useState<Partial<Record<Key, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await getSlackApp();
      setApp(a);
      onReady?.(a.credentials.client_id && a.credentials.client_secret && a.credentials.signing_secret);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't read the Slack app. Reload to try again.");
    }
  }, [onReady]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const patch = Object.fromEntries(
      Object.entries(values)
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => [`surfaces_slack_hosted_${k}`, v!.trim()]),
    );
    if (!Object.keys(patch).length) return;
    setBusy(true);
    setErrors({});
    try {
      await updateAdminSettings(patch);
      setValues({});
      toast.success("Saved. The keys are stored encrypted and won't be shown again.");
      await load();
    } catch (e) {
      // Slack refused a key: say so under that field and keep what was typed, so it can be corrected.
      const fe = (e as { body?: { fieldErrors?: Record<string, string> } }).body?.fieldErrors ?? {};
      const mine = Object.fromEntries(FIELDS.map((f) => [f.key, fe[`surfaces_slack_hosted_${f.key}`]]).filter(([, m]) => m));
      if (Object.keys(mine).length) setErrors(mine);
      else toast.error(e instanceof Error && e.message ? e.message : "Couldn't save the keys.");
    } finally {
      setBusy(false);
    }
  };

  const [confirmClear, setConfirmClear] = useState(false);
  const clear = async () => {
    setBusy(true);
    try {
      // An empty value removes the setting on the server.
      await updateAdminSettings(Object.fromEntries(FIELDS.map((f) => [`surfaces_slack_hosted_${f.key}`, ""])));
      setValues({});
      setErrors({});
      setConfirmClear(false);
      toast.success("The Slack app's keys were cleared.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't clear the keys.");
    } finally {
      setBusy(false);
    }
  };

  const saved = app?.credentials;
  return (
    <div className="space-y-3 text-sm" data-testid="slack-app-card">
      {heading && (
        <div>
          <p className="font-medium">Slack app</p>
          <p className="text-muted-foreground">
            One Slack app for this server. Create it from the manifest, then save its keys here. The same keys show in Control room → Setup and Server settings → Surfaces.
          </p>
        </div>
      )}
      <Button variant="outline" size="sm" onClick={() => app && downloadJson("nest-slack-manifest.json", app.manifest)} disabled={!app}>
        <Download className="mr-1.5 h-4 w-4" aria-hidden />
        Download manifest
      </Button>
      {app && !/^https?:\/\//.test(app.urls.events) && (
        <p className="text-red-800" data-testid="slack-app-no-base-url">
          Set Public base URL in Server settings → Basic first. The Slack app&apos;s addresses are built from it.
        </p>
      )}
      {app && /^https?:\/\//.test(app.urls.events) && (
        <div className="space-y-1.5" data-testid="slack-app-urls">
          <p className="text-muted-foreground">The app must keep these addresses (the manifest sets them):</p>
          {ADDRESSES.map((a) => (
            <div key={a.key} className="min-w-0">
              <span className="text-muted-foreground">{a.label}</span>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">{app.urls[a.key]}</code>
                <CopyButton text={app.urls[a.key]} toastMessage="Address copied" />
              </div>
            </div>
          ))}
        </div>
      )}
      {app && /^https?:\/\//.test(app.urls.events) && <ByHandGuide urls={app.urls} />}
      <div className="grid gap-2 sm:grid-cols-3" data-testid="slack-app-keys">
        {FIELDS.map((f) => (
          <div key={f.key} className="min-w-0">
            <Label htmlFor={`slack-app-${f.key}`} className="flex items-center justify-between text-sm font-normal">
              {f.label}
              <span className={cn("text-sm", saved?.[f.key] ? "text-green-700" : "text-muted-foreground")} data-testid={`slack-app-state-${f.key}`}>
                {saved?.[f.key] ? "Saved" : "Not saved"}
              </span>
            </Label>
            <Input
              id={`slack-app-${f.key}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-9"
              placeholder={saved?.[f.key] ? "Replace the saved value" : ""}
              value={values[f.key] ?? ""}
              aria-invalid={!!errors[f.key] || undefined}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {errors[f.key] && (
              <p className="mt-1 text-sm text-red-800" role="alert" data-testid={`slack-app-error-${f.key}`}>
                {errors[f.key]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={save} disabled={busy || !Object.values(values).some((v) => v?.trim())}>
          Save keys
        </Button>
        {/* Disconnect ends a workspace's connection only; this is how the app's keys go. */}
        <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)} disabled={busy || !saved || !FIELDS.some((f) => saved[f.key])} data-testid="slack-app-clear">
          Clear keys
        </Button>
      </div>
      <Dialog open={confirmClear} onOpenChange={(o) => !busy && setConfirmClear(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the Slack app&apos;s keys?</DialogTitle>
            <DialogDescription>
              The Client ID, Client secret and Signing secret are removed from this server. A workspace still connected through this app stops receiving messages, and no new workspace can connect, until you save new keys. Disconnect Slack in Setup first if you are done with it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={clear} disabled={busy} data-testid="slack-app-clear-confirm">
              Clear keys
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
