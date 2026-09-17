/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Every field persists to the same /admin/settings endpoint, so the
 * page edits a local DRAFT and commits everything with one global Save (next
 * to the title) instead of a Save button per card. Cards are grouped into
 * tabs by role so the page stays short. Add a new setting to a tab's <Card>
 * list and to that tab's `keys` (so the unsaved-changes dot tracks it).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, KeyRound, Shield, Loader2, Eye, EyeOff, Users, Globe2, Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BetaBadge } from "@/components/ui/beta-badge";
import type { AdminSettings, SignInGate, ManualSignIn, CommunitySite } from "../lib/api";
import {
  sendTestNotification,
  addCommunitySite,
  updateCommunitySite as updateCommunitySiteApi,
  removeCommunitySite,
} from "../lib/api";
import { reads } from "../lib/queries";
import { copyTextWithToast } from "../lib/clipboard";
import { toast } from "sonner";

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
      "people_suggest_all_users",
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
      "oidc_department_tagging",
      "sso_token_exchange_enabled",
      "mcp_signing_secret",
      "mcp_token_ttl_seconds",
      "ms_token_exchange_enabled",
      "ms_client_id",
      "ms_tenant_id",
      "google_token_exchange_enabled",
      "google_client_id",
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    keys: ["slack_webhook_url", "msteams_webhook_url", "smtp_url", "notify_email_from", "notify_email_to"],
  },
  {
    // Not draft-backed like the tabs above — sites are added/edited/removed
    // immediately via their own API calls (like the superadmins panel on the
    // Teammates page), so this tab has no keys to track for the unsaved dot.
    id: "community-sites",
    label: "Community sites",
    keys: [],
  },
  {
    id: "advanced",
    label: "Advanced",
    keys: [
      "telemetry_enabled",
      "posthog_key",
      "posthog_host",
      "max_body_bytes",
      "trace_retention_days",
      "type_artifact_enabled",
      "type_table_enabled",
      "workflow_plane_enabled",
      "promptowl_teams_enabled",
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
  // Secret fields get a show/hide toggle so an admin can verify what they
  // typed. noAutofill stays keyed on the DECLARED type (password), so revealing
  // it doesn't re-open the door to credential managers stuffing the box.
  const isPassword = type === "password";
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative flex-1">
      <Input
        value={value}
        type={isPassword && reveal ? "text" : type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={isPassword ? "flex-1 pr-9" : "flex-1"}
        {...noAutofill(type)}
      />
      {isPassword && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setReveal((r) => !r)}
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
          title={reveal ? "Hide" : "Show"}
          aria-label={reveal ? "Hide value" : "Show value"}
        >
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      )}
    </div>
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
  const qc = useQueryClient();
  // Error from the last failed save (shape validation or SMTP verify), shown
  // inline near the fields. Cleared on the next edit or a successful save.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Controlled tab so a failed save can jump the admin to the tab holding the
  // rejected field — otherwise the error banner points at fields on a tab
  // they've navigated away from.
  const [activeTab, setActiveTab] = useState<string>("general");
  const [copiedRedirect, setCopiedRedirect] = useState(false);
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  // Community sites — official sites trusted for SSO auto-login. Not part of
  // the settings draft: each row is its own resource, added/edited/removed
  // immediately (mirrors the superadmins panel on the Teammates page).
  const [communitySites, setCommunitySites] = useState<CommunitySite[] | null>(null);
  const [communitySitesError, setCommunitySitesError] = useState<string | null>(null);
  const fetchCommunitySites = async () => {
    try {
      // Invalidate first so a call after a write (add/edit/delete/toggle)
      // always hits the network instead of returning the stale cached list —
      // same reasoning as ApiKeysPage's refresh().
      await qc.invalidateQueries({ queryKey: reads.communitySites().queryKey });
      const res = await qc.fetchQuery(reads.communitySites());
      setCommunitySites(res.community_sites);
      setCommunitySitesError(null);
    } catch (e: any) {
      setCommunitySitesError(e.message);
    }
  };
  useEffect(() => {
    fetchCommunitySites();
  }, []);
  const [siteDialog, setSiteDialog] = useState<
    { mode: "add" } | { mode: "edit"; site: CommunitySite } | null
  >(null);
  const [siteForm, setSiteForm] = useState({ name: "", url: "", secret: "", is_active: true });
  const [siteSaving, setSiteSaving] = useState(false);
  const [siteFormError, setSiteFormError] = useState<string | null>(null);
  const [deleteSiteTarget, setDeleteSiteTarget] = useState<CommunitySite | null>(null);
  const [deletingSite, setDeletingSite] = useState(false);

  const openAddSiteDialog = () => {
    setSiteForm({ name: "", url: "", secret: "", is_active: true });
    setSiteFormError(null);
    setSiteDialog({ mode: "add" });
  };
  const openEditSiteDialog = (site: CommunitySite) => {
    setSiteForm({ name: site.name, url: site.url, secret: "", is_active: site.is_active });
    setSiteFormError(null);
    setSiteDialog({ mode: "edit", site });
  };
  const saveSiteDialog = async () => {
    if (!siteDialog) return;
    setSiteSaving(true);
    setSiteFormError(null);
    try {
      if (siteDialog.mode === "add") {
        await addCommunitySite({
          name: siteForm.name.trim(),
          url: siteForm.url.trim(),
          secret: siteForm.secret.trim(),
          is_active: siteForm.is_active,
        });
      } else {
        const patch: Partial<{ name: string; url: string; secret: string; is_active: boolean }> = {
          name: siteForm.name.trim(),
          url: siteForm.url.trim(),
          is_active: siteForm.is_active,
        };
        if (siteForm.secret.trim()) patch.secret = siteForm.secret.trim();
        await updateCommunitySiteApi(siteDialog.site.id, patch);
      }
      setSiteDialog(null);
      await fetchCommunitySites();
    } catch (e: any) {
      setSiteFormError(e.message);
    } finally {
      setSiteSaving(false);
    }
  };
  const toggleSiteActive = async (site: CommunitySite) => {
    try {
      await updateCommunitySiteApi(site.id, { is_active: !site.is_active });
      await fetchCommunitySites();
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const confirmDeleteSite = async () => {
    if (!deleteSiteTarget) return;
    setDeletingSite(true);
    try {
      await removeCommunitySite(deleteSiteTarget.id);
      setDeleteSiteTarget(null);
      await fetchCommunitySites();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDeletingSite(false);
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
        k === "mcp_signing_secret"
      ) {
        const v = draft[k];
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

  // "Send test" for the Slack/Teams webhook cards. The server tests the SAVED
  // webhook (it reads config), so the button keys off `settings`, not `draft`:
  // nothing saved → disabled; unsaved edits → a hint that the test hits the
  // old value until Save.
  const [testing, setTesting] = useState<null | "slack" | "teams">(null);
  const sendTest = async (channel: "slack" | "teams") => {
    setTesting(channel);
    try {
      await sendTestNotification(channel);
      toast.success(
        `Test ${channel === "slack" ? "Slack" : "Teams"} notification sent — check the channel.`,
      );
    } catch (e: any) {
      toast.error(e?.message || "Test notification failed.");
    } finally {
      setTesting(null);
    }
  };
  const testButton = (
    channel: "slack" | "teams",
    field: "slack_webhook_url" | "msteams_webhook_url",
  ) => (
    <div className="mt-3 flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={testing === channel || !settings?.[field]}
        onClick={() => sendTest(channel)}
      >
        {testing === channel && (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        )}
        Send test
      </Button>
      {dirtyKeys.includes(field) && (
        <span className="text-xs text-muted-foreground">
          Save first — the test uses the saved URL.
        </span>
      )}
    </div>
  );

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

            {/* Who the add-a-person pickers may offer. Default OFF, and the
                copy says why in the admin's own terms: on a server shared by
                unrelated customers this hands one customer's staff another
                customer's addresses. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  People directory
                </CardTitle>
                <CardDescription>
                  What the "add a person" fields suggest when inviting someone
                  to a nest, a team, or a stewardship role.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="pr-4">
                    <div className="text-sm font-medium">
                      Suggest everyone on this server
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Off, the pickers only suggest people the inviter already
                      shares a nest or team with. On, they suggest every
                      registered account — right when this server is one
                      organisation, wrong when it hosts several, because it
                      shows them each other's email addresses. Either way
                      anyone can still be invited by typing their address.
                    </p>
                  </div>
                  <Switch
                    checked={draft.people_suggest_all_users}
                    onCheckedChange={(v) => set({ people_suggest_all_users: v })}
                  />
                </div>
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
                            if (!(await copyTextWithToast(redirectUri))) return;
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

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      Department auto-tagging
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Tag new documents with the creator's directory department
                      (requires the department claim from your IdP).
                    </p>
                  </div>
                  <Switch
                    checked={draft.oidc_department_tagging}
                    onCheckedChange={(v) => set({ oidc_department_tagging: v })}
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

            {/* Agent SSO — token exchange. Reuses the domain allowlist +
                auto-provision above; adds a self-hosted signing secret + the
                two providers. Security-critical, OFF by default. */}
            <Card>
              <CardHeader>
                <CardTitle>Agent SSO — token exchange</CardTitle>
                <CardDescription>
                  Let an external agent, acting for a user your IdP already
                  authenticated (Microsoft Entra / Google), exchange that IdP's
                  ID token for a short-lived MCP bearer — no second login. Uses
                  the domain allowlist and auto-provision settings above.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.sso_token_exchange_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.sso_token_exchange_enabled}
                    onCheckedChange={(v) =>
                      set({ sso_token_exchange_enabled: v })
                    }
                  />
                </div>

                {/* The server REFUSES this combination on save (and refuses to
                    mint on it), so say why here instead of leaving the admin a
                    field error. */}
                {(draft.ms_token_exchange_enabled ||
                  draft.google_token_exchange_enabled) &&
                  draft.oidc_auto_provision &&
                  !draft.oidc_allowed_domains?.trim() && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    >
                      Blocked: with auto-provision on and no allowed email
                      domains, anyone with an account at that provider could
                      sign themselves up and mint a token. Set allowed email
                      domains above, or turn auto-provision off.
                    </div>
                  )}

                {(() => {
                  const secretPresent =
                    draft.mcp_signing_secret === null
                      ? false
                      : typeof draft.mcp_signing_secret === "string" &&
                          draft.mcp_signing_secret.trim() !== ""
                        ? true
                        : !!settings?.mcp_signing_secret_set;
                  // A provider counts as ready only with the ids its verifier
                  // needs — the toggle alone leaves the backend answering
                  // provider_misconfigured on every request, and this banner is
                  // the only signal the admin gets.
                  const msReady =
                    draft.ms_token_exchange_enabled &&
                    !!draft.ms_client_id?.trim() &&
                    !!draft.ms_tenant_id?.trim();
                  const googleReady =
                    draft.google_token_exchange_enabled &&
                    !!draft.google_client_id?.trim();
                  if (
                    !draft.sso_token_exchange_enabled ||
                    (secretPresent && (msReady || googleReady))
                  )
                    return null;
                  return (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                    >
                      Enabled but not ready — the endpoint needs a signing
                      secret and at least one provider turned on with its client
                      ID filled in (plus the tenant ID for Microsoft).
                    </div>
                  );
                })()}

                <div>
                  <div className="text-sm font-medium mb-1">
                    MCP signing secret
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {draft.mcp_signing_secret === null
                      ? "Will be cleared when you save."
                      : settings?.mcp_signing_secret_set
                        ? "A signing secret is set. Paste a new one to replace it."
                        : "Not set. Use a long random string — this signs the MCP tokens the exchange mints."}
                  </div>
                  <TextField
                    type="password"
                    value={
                      typeof draft.mcp_signing_secret === "string"
                        ? draft.mcp_signing_secret
                        : ""
                    }
                    placeholder="Paste to set or replace (16+ characters)"
                    onChange={(v) => set({ mcp_signing_secret: v })}
                  />
                  {settings?.mcp_signing_secret_set &&
                    draft.mcp_signing_secret !== null && (
                      <button
                        type="button"
                        className="mt-2 text-xs text-destructive hover:underline"
                        onClick={() => set({ mcp_signing_secret: null })}
                      >
                        Clear secret
                      </button>
                    )}
                  {draft.mcp_signing_secret === null && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-muted-foreground hover:underline"
                      onClick={() => set({ mcp_signing_secret: undefined })}
                    >
                      Keep current secret
                    </button>
                  )}
                </div>

                <div>
                  <div className="text-sm font-medium mb-1">
                    Token lifetime (seconds)
                  </div>
                  <TextField
                    type="number"
                    value={String(draft.mcp_token_ttl_seconds ?? 300)}
                    placeholder="300"
                    onChange={(v) =>
                      // Clearing the box means "default", not 0 — 0 would fail
                      // the 30–3600 check and block the whole save.
                      set({
                        mcp_token_ttl_seconds: v.trim() === "" ? 300 : Number(v),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    30–3600. Short by design — a minted token expires quickly.
                  </p>
                </div>

                <div className="border-t pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Microsoft Entra</span>
                    <Switch
                      checked={draft.ms_token_exchange_enabled}
                      onCheckedChange={(v) =>
                        set({ ms_token_exchange_enabled: v })
                      }
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">
                      Client (application) ID
                    </div>
                    <TextField
                      value={draft.ms_client_id ?? ""}
                      placeholder="Entra app (client) ID — the token audience"
                      onChange={(v) => set({ ms_client_id: v })}
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">Tenant ID</div>
                    <TextField
                      value={draft.ms_tenant_id ?? ""}
                      placeholder="Directory (tenant) ID — builds the issuer"
                      onChange={(v) => set({ ms_tenant_id: v })}
                    />
                  </div>
                </div>

                <div className="border-t pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Google</span>
                    <Switch
                      checked={draft.google_token_exchange_enabled}
                      onCheckedChange={(v) =>
                        set({ google_token_exchange_enabled: v })
                      }
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">
                      OAuth client ID
                    </div>
                    <TextField
                      value={draft.google_client_id ?? ""}
                      placeholder="Google OAuth client ID — the token audience"
                      onChange={(v) => set({ google_client_id: v })}
                    />
                  </div>
                </div>

                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Your agent calls{" "}
                  <code className="text-[11px]">POST /auth/token-exchange</code>{" "}
                  with the IdP ID token and receives a short-lived MCP bearer for{" "}
                  <code className="text-[11px]">/mcp</code> and{" "}
                  <code className="text-[11px]">/index</code>. The token is
                  verified by signature, issuer, audience (the client id above)
                  and expiry. Security-critical — keep it off until reviewed.
                  For a public IdP like Google, set the allowed email domains
                  above so only your organization can exchange.
                </div>
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
                {testButton("slack", "slack_webhook_url")}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Microsoft Teams notifications</CardTitle>
                <CardDescription>
                  Post the same governance events to a Microsoft Teams channel
                  as Adaptive Cards via an incoming-webhook URL (create one in
                  Teams with the Workflows app: "Post to a channel when a
                  webhook request is received"). Leave empty to turn the
                  connector off. The URL contains a secret — treat it like a
                  password.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TextField
                  type="password"
                  value={draft.msteams_webhook_url ?? ""}
                  placeholder="https://….logic.azure.com/workflows/…"
                  onChange={(v) => set({ msteams_webhook_url: v })}
                />
                {testButton("teams", "msteams_webhook_url")}
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
                <CardTitle className="text-base">Product analytics</CardTitle>
                <CardDescription>
                  Send usage events to your own PostHog project. Leave the key
                  empty to keep analytics off. Also off whenever usage telemetry
                  above is off.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <TextField
                  value={draft.posthog_key ?? ""}
                  placeholder="Project API key — phc_..."
                  onChange={(v) => set({ posthog_key: v })}
                />
                <TextField
                  value={draft.posthog_host ?? ""}
                  placeholder="Host — https://us.i.posthog.com"
                  onChange={(v) => set({ posthog_host: v })}
                />
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

            {/* Content types — per-type creation toggles (default on).
                Soft-disable: turning one off refuses NEW nodes of the type;
                existing nodes still read/render/version. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Content types</CardTitle>
                <CardDescription>
                  Which node types can be created on this server. Turning one
                  off hides it from the editor and refuses new creations —
                  existing nodes of that type stay readable and versioned.
                  Runnable types (agent, skill, tool) are governed by the
                  workflow plane below.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    Artifacts (hosted HTML) —{" "}
                    {draft.type_artifact_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.type_artifact_enabled}
                    onCheckedChange={(v) => set({ type_artifact_enabled: v })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    Tables (CSV fact stores) —{" "}
                    {draft.type_table_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.type_table_enabled}
                    onCheckedChange={(v) => set({ type_table_enabled: v })}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Workflow plane ("turing" track) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Workflow plane <BetaBadge className="ml-1 align-middle" />
                </CardTitle>
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

            {/* Import teams from PromptOwl */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Import teams from PromptOwl
                </CardTitle>
                <CardDescription>
                  Lets users who signed in with PromptOwl pull their PromptOwl
                  teams in as local teams. Off by default. When off, the
                  PromptOwl Teams panel is hidden and the import API is
                  unavailable.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.promptowl_teams_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.promptowl_teams_enabled}
                    onCheckedChange={(v) => set({ promptowl_teams_enabled: v })}
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

          {/* Community sites */}
          <TabsContent value="community-sites" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Globe2 className="h-4 w-4 text-muted-foreground" />
                      Official community sites
                    </CardTitle>
                    <CardDescription>
                      Sites trusted for one-click SSO auto-login. A visitor
                      arriving with a ticket signed by one of these sites'
                      secrets is signed in automatically — the ticket's
                      audience is also checked against this server's own
                      base URL, so a ticket minted for a different deployment
                      can't be replayed here.
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={openAddSiteDialog}>
                    <Plus className="h-4 w-4 mr-1.5" />
                    Add site
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {communitySitesError && (
                  <div
                    role="alert"
                    className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {communitySitesError}
                  </div>
                )}
                {!communitySites ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading community sites…
                  </div>
                ) : communitySites.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6">
                    No community sites configured yet. Add one to enable SSO
                    auto-login from it.
                  </p>
                ) : (
                  <div className="divide-y">
                    {communitySites.map((site) => (
                      <div
                        key={site.id}
                        className="flex items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate">{site.name}</span>
                            <Badge
                              variant="outline"
                              className={
                                site.is_active
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-muted-foreground/20 text-muted-foreground"
                              }
                            >
                              {site.is_active ? "Enabled" : "Disabled"}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {site.url} · secret {site.secret_set ? "set" : "not set"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Switch
                            checked={site.is_active}
                            onCheckedChange={() => toggleSiteActive(site)}
                            aria-label={`Enable ${site.name}`}
                            title="Enabled sites can sign visitors in with an SSO ticket. This is the admin switch, not a reachability check."
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditSiteDialog(site)}
                            title="Edit this community site"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteSiteTarget(site)}
                            title="Remove this community site"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={!!siteDialog} onOpenChange={(open) => !open && setSiteDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {siteDialog?.mode === "edit" ? "Edit community site" : "Add community site"}
            </DialogTitle>
            <DialogDescription>
              The secret is write-only — leave it blank when editing to keep
              the current one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                value={siteForm.name}
                onChange={(e) => setSiteForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Main community site"
              />
            </div>
            <div>
              <Label htmlFor="site-url">Site URL</Label>
              <Input
                id="site-url"
                value={siteForm.url}
                onChange={(e) => setSiteForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://community.example.com"
              />
            </div>
            <div>
              <Label htmlFor="site-secret">Secret key</Label>
              <Input
                id="site-secret"
                type="password"
                value={siteForm.secret}
                onChange={(e) => setSiteForm((f) => ({ ...f, secret: e.target.value }))}
                placeholder={
                  siteDialog?.mode === "edit" ? "Leave blank to keep the current secret" : "Shared secret (16+ characters)"
                }
                {...noAutofill("password")}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="site-active">Auto-login enabled</Label>
              <Switch
                id="site-active"
                checked={siteForm.is_active}
                onCheckedChange={(v) => setSiteForm((f) => ({ ...f, is_active: v }))}
              />
            </div>
            {siteFormError && (
              <div role="alert" className="text-sm text-destructive">
                {siteFormError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSiteDialog(null)}>
              Cancel
            </Button>
            <Button onClick={saveSiteDialog} disabled={siteSaving}>
              {siteSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {siteDialog?.mode === "edit" ? "Save changes" : "Add site"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteSiteTarget} onOpenChange={(open) => !open && setDeleteSiteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {deleteSiteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Visitors arriving from this site will no longer be auto-signed-in.
              This can't be undone from here — you'll need to re-add the site
              and its secret to restore it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteSiteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteSite} disabled={deletingSite}>
              {deletingSite && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
