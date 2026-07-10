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
import type { AdminSettings, SignInGate, ManualSignIn } from "../lib/api";

interface SettingsPageProps {
  onBack: () => void;
  settings: AdminSettings | null;
  onUpdate: (
    patch: Partial<AdminSettings> & { anthropic_api_key?: string | null },
  ) => void | Promise<void>;
}

const GATE_OPTIONS: { value: SignInGate; label: string; hint: string }[] = [
  { value: "open", label: "Everyone", hint: "Anyone can sign in with PromptOwl." },
  { value: "admin-only", label: "Admins only", hint: "Only the server admin can use PromptOwl sign-in." },
  { value: "disabled", label: "Off", hint: "Hide PromptOwl sign-in." },
];

const MANUAL_OPTIONS: { value: ManualSignIn; label: string; hint: string }[] = [
  { value: "open", label: "Everyone", hint: "Anyone can sign in and create their own account." },
  { value: "invite-only", label: "Invite only", hint: "Invited users sign in and set a password; no self sign-up." },
  { value: "disabled", label: "Off", hint: "No email & password sign-in — PromptOwl only." },
];

/**
 * Which settings live under each tab. `keys` drives the tab's unsaved-changes
 * dot AND maps a rejected-save field back to its tab: the server returns errors
 * keyed by field name (`fieldErrors`), so a bad From address focuses
 * Notifications by exact key — no message-text scraping.
 */
const TABS: {
  id: string;
  label: string;
  keys: (keyof AdminSettings)[];
}[] = [
  {
    id: "general",
    label: "General",
    keys: [
      "promptowl_sign_in_gate",
      "manual_sign_in",
      "public_base_url",
      "logo_url",
      "anthropic_api_key",
    ],
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
  // load, and after a successful save — which clears the dirty state). Extends
  // AdminSettings with the write-only `anthropic_api_key`: the server returns it
  // only masked, so it isn't part of AdminSettings, but it's edited through the
  // exact same draft + `set()` + global Save as every other field. Absent =
  // untouched, string = set to this, null = clear on save.
  const [draft, setDraft] = useState<AdminSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  // Error from the last failed save (shape validation or SMTP verify), shown
  // inline near the fields. Cleared on the next edit or a successful save.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Controlled tab so a failed save can jump the admin to the tab holding the
  // rejected field — otherwise the error banner points at fields on a tab
  // they've navigated away from.
  const [activeTab, setActiveTab] = useState<string>("general");
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const set = (patch: Partial<AdminSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    // Any edit invalidates a prior save error — let the admin retry cleanly.
    setSaveError(null);
  };

  // null and "" are equivalent for the nullable string fields (backend stores
  // "" as null), so normalize before comparing to avoid a phantom dirty state.
  const dirtyKeys = useMemo(() => {
    if (!draft || !settings) return [] as (keyof AdminSettings)[];
    const base = settings as unknown as Record<string, unknown>;
    return (Object.keys(draft) as (keyof AdminSettings)[]).filter((k) => {
      // Write-only key: the server hands back only a mask, so there's no value
      // to diff against — "staged" means a non-empty string (set) or null
      // (clear). Everything else diffs by value like normal.
      if (k === "anthropic_api_key") {
        const v = draft.anthropic_api_key;
        return (typeof v === "string" && v.trim() !== "") || v === null;
      }
      return (
        ((draft as unknown as Record<string, unknown>)[k] ?? "") !==
        (base[k] ?? "")
      );
    });
  }, [draft, settings]);
  const isDirty = dirtyKeys.length > 0;
  const dirtyInTab = (keys: (keyof AdminSettings)[]) =>
    keys.some((k) => dirtyKeys.includes(k));

  const save = async () => {
    if (!draft || !isDirty) return;
    const patch: Partial<AdminSettings> = {};
    for (const k of dirtyKeys) (patch as Record<string, unknown>)[k] = draft[k];
    setSaving(true);
    setSaveError(null);
    try {
      await onUpdate(patch);
    } catch (e: any) {
      // Surface the server's reason inline so the admin sees exactly why the
      // save was blocked, and keep the draft so the values stay put for
      // correction. Focus the tab that owns the rejected field so the banner and
      // the offending input are visible together. The server keys each error by
      // field name (`fieldErrors`) — match on that exactly; fall back to "the
      // first tab with an edited field" only if the body carried no field keys.
      setSaveError(e?.message || "Failed to save settings");
      const fieldErrors: Record<string, string> = e?.body?.fieldErrors ?? {};
      const badFields = Object.keys(fieldErrors);
      const owns = (t: (typeof TABS)[number]) =>
        badFields.some((f) => (t.keys as string[]).includes(f));
      const offending = badFields.length
        ? TABS.find(owns)
        : TABS.find((t) => t.keys.some((k) => dirtyKeys.includes(k)));
      if (offending) setActiveTab(offending.id);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    if (settings) setDraft(settings);
    setSaveError(null);
  };

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

      {saveError && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <div className="font-medium">Couldn't save settings</div>
          <div className="mt-0.5 text-destructive/90">{saveError}</div>
        </div>
      )}

      {!draft ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
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
                    // Can't pick "Off" while manual sign-in is also off (lockout —
                    // the server rejects it); disable that one option.
                    const locked =
                      opt.value === "disabled" &&
                      draft.manual_sign_in === "disabled";
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          !active &&
                          !locked &&
                          set({ promptowl_sign_in_gate: opt.value })
                        }
                        className={`text-left rounded-lg border p-3 transition-colors ${
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : locked
                              ? "opacity-50 cursor-not-allowed"
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
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Manual sign-in
                </CardTitle>
                <CardDescription>
                  Email &amp; password sign-in. Independent of PromptOwl — you
                  can't turn this fully off while PromptOwl sign-in is also off.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {MANUAL_OPTIONS.map((opt) => {
                    const active = draft.manual_sign_in === opt.value;
                    // Can't pick "Off" while PromptOwl is also off (lockout —
                    // the server rejects it); disable that one option.
                    const locked =
                      opt.value === "disabled" &&
                      draft.promptowl_sign_in_gate === "disabled";
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          !active &&
                          !locked &&
                          set({ manual_sign_in: opt.value })
                        }
                        className={`text-left rounded-lg border p-3 transition-colors ${
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : locked
                              ? "opacity-50 cursor-not-allowed"
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

            {/* Anthropic API key — server-wide runner/LLM key. Write-only
                (the server only returns it masked), so it isn't part of the
                settings draft; its staged value rides the global Save via
                `apiKeyDraft`. A nest's Tool environment can override it. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Anthropic API key</CardTitle>
                <CardDescription>
                  The server-wide model key. Runners pick it up automatically
                  (every nest, unless a nest overrides it in its Tool
                  environment). No key, no LLM calls. Stored server-side; shown
                  masked.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground mb-2">
                  {draft.anthropic_api_key === null
                    ? "Will be cleared when you save."
                    : settings?.anthropic_api_key_masked
                      ? `Current: ${settings.anthropic_api_key_masked}`
                      : "Not set — runs can't execute until a key exists here or in a nest's Tool environment."}
                </div>
                <TextField
                  type="password"
                  value={
                    typeof draft.anthropic_api_key === "string"
                      ? draft.anthropic_api_key
                      : ""
                  }
                  placeholder="sk-ant-… (paste to set or replace)"
                  onChange={(v) => set({ anthropic_api_key: v })}
                />
                {settings?.anthropic_api_key_masked &&
                  draft.anthropic_api_key !== null && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-destructive hover:underline"
                      onClick={() => set({ anthropic_api_key: null })}
                    >
                      Clear key
                    </button>
                  )}
                {draft.anthropic_api_key === null && (
                  <button
                    type="button"
                    className="mt-2 text-xs text-muted-foreground hover:underline"
                    onClick={() => set({ anthropic_api_key: undefined })}
                  >
                    Keep current key
                  </button>
                )}
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
