/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Every field persists to the same /admin/settings endpoint, so the
 * page edits a local DRAFT and commits everything with one global Save (next
 * to the title) instead of a Save button per card. Cards are grouped into
 * tabs by role so the page stays short. Add a new setting to a tab's <Card>
 * list and to that tab's `keys` (so the unsaved-changes dot tracks it).
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { AdminSettings, SignInGate } from "../lib/api";

interface SettingsPageProps {
  onBack: () => void;
  settings: AdminSettings | null;
  onUpdate: (patch: Partial<AdminSettings>) => void | Promise<void>;
}

const GATE_OPTIONS: { value: SignInGate; label: string; hint: string }[] = [
  { value: "open", label: "Everyone", hint: "Anyone can sign in with PromptOwl." },
  { value: "admin-only", label: "Admins only", hint: "Only the server admin can use PromptOwl sign-in." },
  { value: "disabled", label: "Off", hint: "Hide PromptOwl sign-in — email & password only." },
];

/** Which settings live under each tab — drives the tab's unsaved-changes dot. */
const TABS: { id: string; label: string; keys: (keyof AdminSettings)[] }[] = [
  {
    id: "general",
    label: "General",
    keys: ["promptowl_sign_in_gate", "public_base_url", "logo_url"],
  },
  {
    id: "notifications",
    label: "Notifications",
    keys: ["slack_webhook_url", "smtp_url", "notify_email_from", "notify_email_to"],
  },
  {
    id: "advanced",
    label: "Advanced",
    keys: [
      "telemetry_enabled",
      "max_body_bytes",
      "workflow_plane_enabled",
      "subagent_runs_enabled",
    ],
  },
];

/** Controlled text input bound straight to the draft (no per-field Save). */
function TextField({
  value,
  placeholder,
  onChange,
  type = "text",
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <Input
      value={value}
      type={type}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1"
    />
  );
}

/** Megabytes input that reads/writes the draft's byte count. */
function MbField({
  bytes,
  onChange,
}: {
  bytes: number;
  onChange: (bytes: number) => void;
}) {
  const [mb, setMb] = useState(String(Math.round(bytes / (1024 * 1024))));
  useEffect(() => setMb(String(Math.round(bytes / (1024 * 1024)))), [bytes]);
  return (
    <div className="flex items-center gap-2 max-w-xs">
      <Input
        type="number"
        value={mb}
        onChange={(e) => {
          setMb(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0)
            onChange(Math.floor(n * 1024 * 1024));
        }}
      />
      <span className="text-sm text-muted-foreground shrink-0">MB</span>
    </div>
  );
}

export function SettingsPage({ onBack, settings, onUpdate }: SettingsPageProps) {
  // Local editable copy. Re-synced whenever the server value changes (initial
  // load, and after a successful save — which clears the dirty state).
  const [draft, setDraft] = useState<AdminSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const set = (patch: Partial<AdminSettings>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  // null and "" are equivalent for the nullable string fields (backend stores
  // "" as null), so normalize before comparing to avoid a phantom dirty state.
  const dirtyKeys = useMemo(() => {
    if (!draft || !settings) return [] as (keyof AdminSettings)[];
    return (Object.keys(draft) as (keyof AdminSettings)[]).filter(
      (k) => (draft[k] ?? "") !== (settings[k] ?? ""),
    );
  }, [draft, settings]);
  const isDirty = dirtyKeys.length > 0;
  const dirtyInTab = (keys: (keyof AdminSettings)[]) =>
    keys.some((k) => dirtyKeys.includes(k));

  const save = async () => {
    if (!draft || !isDirty) return;
    const patch: Partial<AdminSettings> = {};
    for (const k of dirtyKeys) (patch as Record<string, unknown>)[k] = draft[k];
    setSaving(true);
    try {
      await onUpdate(patch);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => settings && setDraft(settings);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-2xl font-semibold">Server settings</h2>
          <p className="text-sm text-muted-foreground">
            Server-wide options. Changes apply on Save and persist across
            restarts.
          </p>
        </div>
        {settings && (
          <div className="flex items-center gap-2 shrink-0">
            {isDirty && (
              <span className="text-xs text-muted-foreground mr-1">
                Unsaved changes
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={discard}
              disabled={!isDirty || saving}
            >
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={!isDirty || saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        )}
      </div>

      {!draft ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      ) : (
        <Tabs defaultValue="general">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="gap-1.5">
                {t.label}
                {dirtyInTab(t.keys) && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                    aria-label="unsaved changes"
                  />
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* General */}
          <TabsContent value="general" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  PromptOwl sign-in
                </CardTitle>
                <CardDescription>
                  Who can sign in to this server using their PromptOwl account.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {GATE_OPTIONS.map((opt) => {
                    const active = draft.promptowl_sign_in_gate === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          !active && set({ promptowl_sign_in_gate: opt.value })
                        }
                        className={`text-left rounded-lg border p-3 transition-colors ${active
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "hover:bg-muted/50"
                          }`}
                        aria-pressed={active}
                      >
                        <div className="text-sm font-medium">{opt.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {opt.hint}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Public base URL</CardTitle>
                <CardDescription>
                  This server's public address — used for share links and SSO
                  redirects. Leave empty if unsure.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TextField
                  value={draft.public_base_url ?? ""}
                  placeholder="https://nest.yourcompany.com"
                  onChange={(v) => set({ public_base_url: v })}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Logo</CardTitle>
                <CardDescription>
                  URL of the logo shown in the header. Leave empty for the
                  default.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TextField
                  value={draft.logo_url ?? ""}
                  placeholder="https://example.com/logo.svg"
                  onChange={(v) => set({ logo_url: v })}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Notifications */}
          <TabsContent value="notifications" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Slack notifications</CardTitle>
                <CardDescription>
                  Post governance events (review requested, approved, rejected,
                  nest shared) to a Slack channel via an incoming-webhook URL.
                  Leave empty to turn the connector off. The URL contains a
                  secret — treat it like a password.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TextField
                  type="password"
                  value={draft.slack_webhook_url ?? ""}
                  placeholder="https://hooks.slack.com/services/…"
                  onChange={(v) => set({ slack_webhook_url: v })}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Email notifications</CardTitle>
                <CardDescription>
                  Send the same governance events over SMTP. Set the connection
                  URL (smtp:// or smtps://, credentials inline), a From address,
                  and one or more recipients (comma-separated). Leave the URL
                  empty to turn the connector off.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <TextField
                  type="password"
                  value={draft.smtp_url ?? ""}
                  placeholder="smtps://user:pass@smtp.example.com:465"
                  onChange={(v) => set({ smtp_url: v })}
                />
                <TextField
                  value={draft.notify_email_from ?? ""}
                  placeholder="From — nest@yourcompany.com"
                  onChange={(v) => set({ notify_email_from: v })}
                />
                <TextField
                  value={draft.notify_email_to ?? ""}
                  placeholder="To — team@yourcompany.com, ops@yourcompany.com"
                  onChange={(v) => set({ notify_email_to: v })}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Advanced */}
          <TabsContent value="advanced" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Usage telemetry</CardTitle>
                <CardDescription>
                  Send anonymous usage counts to PromptOwl. Turn off to keep all
                  usage data on this server.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.telemetry_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.telemetry_enabled}
                    onCheckedChange={(v) => set({ telemetry_enabled: v })}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Max upload size</CardTitle>
                <CardDescription>
                  Largest request/file accepted, in megabytes. Raise this if big
                  HTML artifacts (decks, dashboards) get rejected.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MbField
                  bytes={draft.max_body_bytes}
                  onChange={(bytes) => set({ max_body_bytes: bytes })}
                />
              </CardContent>
            </Card>

            {/* Workflow plane ("turing" track) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workflow plane</CardTitle>
                <CardDescription>
                  Typed edges, an edge-type registry, and governed runs — the
                  automation layer. Optional; off by default. Turning it on adds
                  API surface and UI views but changes nothing until someone
                  creates an edge.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.workflow_plane_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.workflow_plane_enabled}
                    onCheckedChange={(v) =>
                      set({
                        workflow_plane_enabled: v,
                        // Turning the plane off makes sub-agent runs inert; keep
                        // the two consistent so the server never sees the
                        // dependent-flag-without-parent state.
                        ...(v ? {} : { subagent_runs_enabled: false }),
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Sub-agent runs (recursion) — gated separately from the plane */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Sub-agent runs (recursion)
                </CardTitle>
                <CardDescription>
                  Lets a run spawn nested sub-agent runs (a call tree). Bounded
                  by depth, fan-out and re-entrancy caps so the tree stays
                  finite. This opens a recursion surface — enable it only after
                  reviewing the caps for your deployment. Requires the workflow
                  plane.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.subagent_runs_enabled ? "On" : "Off"}
                    {!draft.workflow_plane_enabled && (
                      <span className="text-muted-foreground">
                        {" "}
                        · enable the workflow plane first
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={draft.subagent_runs_enabled}
                    disabled={!draft.workflow_plane_enabled}
                    onCheckedChange={(v) => set({ subagent_runs_enabled: v })}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
