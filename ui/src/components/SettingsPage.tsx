/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Every field persists to the same /admin/settings endpoint, so the
 * page edits a local DRAFT and commits everything with one global Save (next
 * to the title) instead of a Save button per card. Cards are grouped into
 * tabs by role so the page stays short. Add a new setting to a tab's <Card>
 * list and to that tab's `keys` (so the unsaved-changes dot tracks it).
 */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Github,
  KeyRound,
  Plus,
  RefreshCw,
  Shield,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
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
import {
  listNests,
  getGithubSyncStatus,
  runGithubSyncNow,
  type AdminSettings,
  type SignInGate,
  type ManualSignIn,
  type GithubSyncSource,
  type GithubSyncSourceStatus,
} from "../lib/api";

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
    id: "sso",
    label: "Single sign-on",
    keys: [
      "oidc_enabled",
      "oidc_issuer",
      "oidc_client_id",
      "oidc_client_secret",
      "oidc_allowed_domains",
      "oidc_auto_provision",
    ],
  },
  {
    id: "github",
    label: "GitHub sync",
    keys: [
      "github_sync_token",
      "github_sync_interval_ms",
      "github_sync_sources",
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
      "trace_retention_days",
      "workflow_plane_enabled",
      "subagent_runs_enabled",
      "subagent_max_depth",
      "subagent_max_children",
    ],
  },
];

/**
 * Attributes that keep credential managers out of the settings fields.
 *
 * Nothing on this page is the admin's OWN credential — they're server-side
 * secrets (OIDC client secret, Anthropic key, SMTP URL). Left alone, Chrome
 * and the password-manager extensions read a `type="password"` box as a login
 * form and stuff the admin's saved password into it, which then SAVES as the
 * server's config on the next PATCH. Silent, and confusing to unpick.
 *
 * Three different opt-outs because they honour different things:
 *   - autoComplete="new-password" — the only value Chrome/Safari respect on a
 *     password input; plain "off" is ignored there by design.
 *   - data-1p-ignore / data-lpignore — 1Password and LastPass ignore the
 *     autocomplete attribute entirely and need their own vendor opt-out.
 */
const noAutofill = (type: string) =>
  ({
    autoComplete: type === "password" ? "new-password" : "off",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-form-type": "other",
  }) as const;

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
      {...noAutofill(type)}
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
        {...noAutofill("number")}
      />
      <span className="text-sm text-muted-foreground shrink-0">MB</span>
    </div>
  );
}

/** Small integer input bound to the draft. Keeps a local string so the field
 *  can go transiently empty while typing; only pushes valid integers up. */
function NumField({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  const [s, setS] = useState(String(value));
  useEffect(() => setS(String(value)), [value]);
  return (
    <Input
      type="number"
      min={min}
      max={max}
      value={s}
      className="max-w-[7rem]"
      onChange={(e) => {
        setS(e.target.value);
        const n = Number(e.target.value);
        if (Number.isInteger(n)) onChange(n);
      }}
      {...noAutofill("number")}
    />
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
  const [copiedRedirect, setCopiedRedirect] = useState(false);
  // GitHub sync tab: nests for the target picker, per-source last-run
  // status, and the "Sync now" in-flight flag.
  const [nests, setNests] = useState<Array<{ id: string; name: string }>>([]);
  const [syncStatus, setSyncStatus] = useState<GithubSyncSourceStatus[]>([]);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);
  useEffect(() => {
    if (!settings) return;
    listNests()
      .then((r) => setNests(r.nests.map((n) => ({ id: n.id, name: n.name }))))
      .catch(() => {});
    getGithubSyncStatus()
      .then((r) => setSyncStatus(r.sources))
      .catch(() => {});
  }, [settings]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { results } = await runGithubSyncNow();
      if (results.length === 0) {
        toast.info("No GitHub sources configured — add one below and save first.");
      } else {
        const bad = results.filter((r) => r.status === "error");
        const conflicts = results.filter((r) => r.status === "local-edits");
        if (bad.length) toast.error(`Sync finished with errors: ${bad.map((r) => r.repo).join(", ")}`);
        else if (conflicts.length)
          toast.warning(`Sync finished — local edits kept on: ${conflicts.map((r) => r.repo).join(", ")}`);
        else toast.success("GitHub sync complete");
      }
      const status = await getGithubSyncStatus();
      setSyncStatus(status.sources);
    } catch (e: any) {
      toast.error(e?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

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
      // Write-only keys: the server hands back only a mask/presence flag, so
      // there's no value to diff against — "staged" means a non-empty string
      // (set) or null (clear). Everything else diffs by value like normal.
      if (
        k === "anthropic_api_key" ||
        k === "oidc_client_secret" ||
        k === "github_sync_token"
      ) {
        const v = draft[k];
        return (typeof v === "string" && v.trim() !== "") || v === null;
      }
      // The sources list is an array — diff by value, not reference, so a
      // hand-reverted edit doesn't leave a phantom dirty state.
      if (k === "github_sync_sources") {
        return (
          JSON.stringify(draft[k] ?? []) !== JSON.stringify(base[k] ?? [])
        );
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

          {/* Single sign-on (OIDC) */}
          <TabsContent value="sso" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  Single sign-on (OIDC)
                </CardTitle>
                <CardDescription>
                  Let teammates sign in with your identity provider — Microsoft
                  Entra ID, Google, or any OpenID Connect issuer. Fill in the
                  issuer and app credentials below, then turn it on.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.oidc_enabled ? "On" : "Off"}
                    {!draft.oidc_enabled &&
                      !(draft.oidc_issuer && draft.oidc_client_id) && (
                        <span className="text-muted-foreground">
                          {" "}
                          · configure the issuer and app credentials first
                        </span>
                      )}
                  </span>
                  <Switch
                    checked={draft.oidc_enabled}
                    onCheckedChange={(v) => set({ oidc_enabled: v })}
                  />
                </div>

                {/* "On with a dead flow" is legal server state (e.g. the
                    secret was cleared while enabled stayed true) — the login
                    button simply hides. Make that legible instead of silent.
                    Mirrors the server's readiness rule (isOidcReady) against
                    the DRAFT rather than reading the saved `oidc_ready`, so it
                    warns live while the admin is staging the change. */}
                {(() => {
                  const secretPresent =
                    draft.oidc_client_secret === null
                      ? false
                      : typeof draft.oidc_client_secret === "string" &&
                          draft.oidc_client_secret.trim() !== ""
                        ? true
                        : !!settings?.oidc_client_secret_set;
                  const ready =
                    draft.oidc_enabled &&
                    !!draft.oidc_issuer?.trim() &&
                    !!draft.oidc_client_id?.trim() &&
                    secretPresent;
                  if (!draft.oidc_enabled || ready) return null;
                  return (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                    >
                      Enabled but not configured — the SSO sign-in button stays
                      hidden until the issuer, client ID, and client secret are
                      all set.
                    </div>
                  );
                })()}

                {/* Presets — prefill the issuer for the two common IdPs, and
                    reflect which one the current issuer matches so the buttons
                    read as a selector rather than two identical actions. The
                    match is derived from draft.oidc_issuer, so it also lights
                    up when the issuer was typed/pasted by hand or loaded from
                    the server. Anything else (a custom IdP, or blank) leaves
                    both unselected. */}
                {(() => {
                  const issuer = draft.oidc_issuer?.trim() ?? "";
                  const preset: "entra" | "google" | null =
                    /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(
                      issuer,
                    )
                      ? "entra"
                      : issuer === "https://accounts.google.com"
                        ? "google"
                        : null;
                  return (
                    <div>
                      <div className="text-sm font-medium mb-1">Issuer URL</div>
                      <div
                        className="flex gap-2 mb-2"
                        role="group"
                        aria-label="Identity provider preset"
                      >
                        <Button
                          type="button"
                          variant={preset === "entra" ? "default" : "outline"}
                          size="sm"
                          aria-pressed={preset === "entra"}
                          onClick={() => {
                            const tenant = window.prompt(
                              "Microsoft Entra tenant ID (Directory ID) — find it on your app registration's Overview page:",
                            );
                            if (tenant && tenant.trim())
                              set({
                                oidc_issuer: `https://login.microsoftonline.com/${tenant.trim()}/v2.0`,
                              });
                          }}
                        >
                          Microsoft Entra ID
                        </Button>
                        <Button
                          type="button"
                          variant={preset === "google" ? "default" : "outline"}
                          size="sm"
                          aria-pressed={preset === "google"}
                          onClick={() =>
                            set({ oidc_issuer: "https://accounts.google.com" })
                          }
                        >
                          Google
                        </Button>
                        {preset === null && issuer !== "" && (
                          <span className="self-center text-xs text-muted-foreground">
                            Custom issuer
                          </span>
                        )}
                      </div>
                      <TextField
                        value={draft.oidc_issuer ?? ""}
                        placeholder="https://login.microsoftonline.com/{tenant}/v2.0"
                        onChange={(v) => set({ oidc_issuer: v })}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        https:// only. Must serve
                        /.well-known/openid-configuration.
                      </p>
                    </div>
                  );
                })()}

                <div>
                  <div className="text-sm font-medium mb-1">Client ID</div>
                  <TextField
                    value={draft.oidc_client_id ?? ""}
                    placeholder="Application (client) ID from your IdP app registration"
                    onChange={(v) => set({ oidc_client_id: v })}
                  />
                </div>

                {/* Client secret — write-only, same pattern as the Anthropic
                    key: the server only reports presence, never the value. */}
                <div>
                  <div className="text-sm font-medium mb-1">Client secret</div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {draft.oidc_client_secret === null
                      ? "Will be cleared when you save."
                      : settings?.oidc_client_secret_set
                        ? "A client secret is set. Paste a new one to replace it."
                        : "Not set."}
                  </div>
                  <TextField
                    type="password"
                    value={
                      typeof draft.oidc_client_secret === "string"
                        ? draft.oidc_client_secret
                        : ""
                    }
                    placeholder="Paste to set or replace"
                    onChange={(v) => set({ oidc_client_secret: v })}
                  />
                  {settings?.oidc_client_secret_set &&
                    draft.oidc_client_secret !== null && (
                      <button
                        type="button"
                        className="mt-2 text-xs text-destructive hover:underline"
                        onClick={() => set({ oidc_client_secret: null })}
                      >
                        Clear secret
                      </button>
                    )}
                  {draft.oidc_client_secret === null && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-muted-foreground hover:underline"
                      onClick={() => set({ oidc_client_secret: undefined })}
                    >
                      Keep current secret
                    </button>
                  )}
                </div>

                {/* Redirect URI — read-only; the admin pastes this into the
                    IdP's app registration. Derived from the public base URL
                    when set, else this browser's origin. */}
                <div>
                  <div className="text-sm font-medium mb-1">Redirect URI</div>
                  {(() => {
                    const base = (
                      draft.public_base_url || window.location.origin
                    ).replace(/\/$/, "");
                    const redirectUri = `${base}/auth/oidc/callback`;
                    return (
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-muted/40 border rounded px-2 py-1.5 text-xs font-mono break-all">
                          {redirectUri}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            // navigator.clipboard throws on insecure contexts
                            // (plain-HTTP local setups) — fall back to the
                            // legacy execCommand path, and if that fails too,
                            // tell the admin to copy by hand.
                            try {
                              await navigator.clipboard.writeText(redirectUri);
                            } catch {
                              try {
                                const ta = document.createElement("textarea");
                                ta.value = redirectUri;
                                ta.style.position = "fixed";
                                ta.style.opacity = "0";
                                document.body.appendChild(ta);
                                ta.select();
                                const ok = document.execCommand("copy");
                                document.body.removeChild(ta);
                                if (!ok) throw new Error("copy failed");
                              } catch {
                                toast.error(
                                  "Couldn't copy automatically — select the URI text and copy it manually.",
                                );
                                return;
                              }
                            }
                            setCopiedRedirect(true);
                            setTimeout(() => setCopiedRedirect(false), 1500);
                          }}
                        >
                          {copiedRedirect ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1.5">
                            {copiedRedirect ? "Copied" : "Copy"}
                          </span>
                        </Button>
                      </div>
                    );
                  })()}
                  <p className="text-xs text-muted-foreground mt-1">
                    Register this exact URI in your IdP's app registration
                    (Entra: Authentication → Web redirect URIs; Google:
                    Authorized redirect URIs).
                  </p>
                </div>

                <div>
                  <div className="text-sm font-medium mb-1">
                    Allowed email domains
                  </div>
                  <TextField
                    value={draft.oidc_allowed_domains ?? ""}
                    placeholder="acme.com, contractors.acme.com — empty allows any"
                    onChange={(v) => set({ oidc_allowed_domains: v })}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Only accounts whose email domain is listed may sign in.
                    Leave empty to allow any domain your IdP asserts.
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      Auto-provision new users
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Create an account on first SSO sign-in. Turn off to allow
                      only users you've already invited.
                    </p>
                  </div>
                  <Switch
                    checked={draft.oidc_auto_provision}
                    onCheckedChange={(v) => set({ oidc_auto_provision: v })}
                  />
                </div>

                {/* Auto-provision + no allowlist = anyone the issuer will
                    authenticate gets an account. Harmless on a single-tenant
                    Entra directory (the issuer IS the allowlist), wide open on
                    a multi-tenant or consumer issuer like Google. The two
                    settings are individually reasonable, so warn on the
                    combination — an admin reading either field alone won't see
                    it, and it silently overrides an invite-only server. */}
                {draft.oidc_enabled &&
                  draft.oidc_auto_provision &&
                  !draft.oidc_allowed_domains?.trim() && (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                    >
                      Anyone your issuer can authenticate will get an account on
                      first sign-in — with a consumer or multi-tenant issuer
                      (e.g. Google), that's any account on the internet, and it
                      applies even when manual sign-in is invite-only. Set
                      allowed email domains above, or turn auto-provision off.
                    </div>
                  )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* GitHub sync */}
          <TabsContent value="github" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Github className="h-4 w-4 text-muted-foreground" />
                  GitHub markdown sync
                </CardTitle>
                <CardDescription>
                  Mirror markdown files from GitHub repositories into nests on
                  a schedule. Synced documents get normal version history;
                  documents someone edits locally are never overwritten — they
                  show up below as “local edits”.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-sm font-medium mb-1">Sync interval</div>
                  <div className="flex items-center gap-2">
                    <NumField
                      value={Math.round(
                        (draft.github_sync_interval_ms ?? 0) / 60_000,
                      )}
                      min={0}
                      onChange={(n) =>
                        set({
                          github_sync_interval_ms: Math.max(0, n) * 60_000,
                        })
                      }
                    />
                    <span className="text-sm text-muted-foreground shrink-0">
                      minutes — 0 turns scheduled sync off
                    </span>
                  </div>
                </div>

                {/* Access token — write-only, same affordance as the OIDC
                    client secret: the server only reports presence. */}
                <div>
                  <div className="text-sm font-medium mb-1">
                    GitHub access token
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {draft.github_sync_token === null
                      ? "Will be cleared when you save."
                      : settings?.github_sync_token_set
                        ? "A token is set. Paste a new one to replace it."
                        : "Not set — only public repositories will sync, at GitHub's low anonymous rate limit."}
                  </div>
                  <TextField
                    type="password"
                    value={
                      typeof draft.github_sync_token === "string"
                        ? draft.github_sync_token
                        : ""
                    }
                    placeholder="github_pat_… (fine-grained, Contents: read-only)"
                    onChange={(v) => set({ github_sync_token: v })}
                  />
                  {settings?.github_sync_token_set &&
                    draft.github_sync_token !== null && (
                      <button
                        type="button"
                        className="mt-2 text-xs text-destructive hover:underline"
                        onClick={() => set({ github_sync_token: null })}
                      >
                        Clear token
                      </button>
                    )}
                  {draft.github_sync_token === null && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-muted-foreground hover:underline"
                      onClick={() => set({ github_sync_token: undefined })}
                    >
                      Keep current token
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sources</CardTitle>
                <CardDescription>
                  Each source maps a repository (all markdown files, or one
                  file) into a nest. Directory structure is preserved under the
                  target folder. Save your changes before running a sync.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(draft.github_sync_sources ?? []).map((src, i) => {
                  const update = (patch: Partial<GithubSyncSource>) => {
                    const next = [...(draft.github_sync_sources ?? [])];
                    next[i] = { ...next[i], ...patch };
                    set({ github_sync_sources: next });
                  };
                  const selectCls =
                    "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
                  return (
                    <div
                      key={i}
                      className="rounded-lg border p-3 space-y-2"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <TextField
                          value={src.repo}
                          placeholder="owner/repo"
                          onChange={(v) => update({ repo: v })}
                        />
                        <TextField
                          value={src.branch ?? ""}
                          placeholder="branch (empty = default branch)"
                          onChange={(v) => update({ branch: v })}
                        />
                        <select
                          className={selectCls}
                          value={src.mode ?? "all-markdown"}
                          onChange={(e) =>
                            update({
                              mode: e.target.value as GithubSyncSource["mode"],
                            })
                          }
                        >
                          <option value="all-markdown">
                            All markdown files
                          </option>
                          <option value="single-file">Single file</option>
                        </select>
                        <TextField
                          value={src.path ?? ""}
                          placeholder={
                            (src.mode ?? "all-markdown") === "single-file"
                              ? "file path (default README.md)"
                              : "subfolder filter (empty = whole repo)"
                          }
                          onChange={(v) => update({ path: v })}
                        />
                        <select
                          className={selectCls}
                          value={src.nestId}
                          onChange={(e) => update({ nestId: e.target.value })}
                        >
                          <option value="">Pick a nest…</option>
                          {nests.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.name}
                            </option>
                          ))}
                        </select>
                        <TextField
                          value={src.folder ?? ""}
                          placeholder="target folder in nest (empty = root)"
                          onChange={(v) => update({ folder: v })}
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
                          onClick={() =>
                            set({
                              github_sync_sources: (
                                draft.github_sync_sources ?? []
                              ).filter((_, j) => j !== i),
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove source
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      set({
                        github_sync_sources: [
                          ...(draft.github_sync_sources ?? []),
                          {
                            repo: "",
                            mode: "all-markdown",
                            nestId: nests[0]?.id ?? "",
                          },
                        ],
                      })
                    }
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add source
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={syncNow}
                    disabled={syncing || isDirty}
                    title={
                      isDirty
                        ? "Save your changes first — Sync now runs the saved configuration."
                        : undefined
                    }
                  >
                    {syncing ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    )}
                    Sync now
                  </Button>
                </div>

                {/* Per-source last-run status (saved config, not the draft). */}
                {syncStatus.length > 0 && (
                  <div className="pt-2 border-t space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      Last run
                    </div>
                    {syncStatus.map((s, i) => (
                      <div
                        key={i}
                        className="flex flex-wrap items-baseline gap-x-2 text-xs"
                      >
                        <span className="font-mono">{s.repo}</span>
                        <span
                          className={
                            s.lastStatus === "error"
                              ? "text-destructive"
                              : s.lastStatus === "local-edits"
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }
                        >
                          {s.lastStatus ?? "never run"}
                          {s.lastDetail ? ` — ${s.lastDetail}` : ""}
                        </span>
                        {s.lastRunAt && (
                          <span className="text-muted-foreground/70">
                            {new Date(s.lastRunAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
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

            {/* Activity-trace retention (api_events rolling window) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Activity trace retention
                </CardTitle>
                <CardDescription>
                  How many days of activity-trace rows (API requests and MCP
                  tool calls) to keep. Older rows are pruned opportunistically.
                  Set 0 to keep activity forever.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <NumField
                    value={draft.trace_retention_days}
                    min={0}
                    max={3650}
                    onChange={(n) => set({ trace_retention_days: n })}
                  />
                  <span className="text-sm text-muted-foreground shrink-0">
                    days
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  0–3650 — 0 disables pruning entirely.
                </p>
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

                {/* Recursion caps — the numbers the Runs picker validates
                    against. Editable here so an admin doesn't need env access;
                    same [min,max] the server clamps to. */}
                {draft.subagent_runs_enabled && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm font-medium mb-1">Max depth</div>
                      <NumField
                        value={draft.subagent_max_depth}
                        min={1}
                        max={32}
                        onChange={(n) => set({ subagent_max_depth: n })}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        1–32 — how deep the sub-agent call tree may nest.
                      </p>
                    </div>
                    <div>
                      <div className="text-sm font-medium mb-1">
                        Max sub-agents per run
                      </div>
                      <NumField
                        value={draft.subagent_max_children}
                        min={1}
                        max={128}
                        onChange={(n) => set({ subagent_max_children: n })}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        1–128 — fan-out a single run may spawn.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
