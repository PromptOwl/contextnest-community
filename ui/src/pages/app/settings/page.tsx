/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Every field persists to the same /admin/settings endpoint, so the
 * page edits a local DRAFT and commits everything with one global Save (next
 * to the title) instead of a Save button per card. Cards are grouped into
 * tabs by role so the page stays short. Add a new setting to a tab's <Card>
 * list and to that tab's `keys` (so the unsaved-changes dot tracks it).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Shield, Loader2, Eye, EyeOff, Users, Globe2, Plus, Trash2, Pencil, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
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
import type { AdminSettings, SignInGate, ManualSignIn, CommunitySite } from "../../../lib/api";
import {
  sendTestNotification,
  addCommunitySite,
  updateCommunitySite as updateCommunitySiteApi,
  removeCommunitySite,
} from "../../../lib/api";
import { reads } from "../../../lib/queries";
import { copyTextWithToast } from "../../../lib/clipboard";
import { getAdminModels, getAdminSettings, updateAdminSettings } from "../../../lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/SearchableSelect";
import { modelOptions } from "@/lib/model-options";
import { useAuth } from "../../../auth/AuthContext";
import { AgentConnectPanel } from "./AgentConnectPanel";
import { LicensePanel } from "./LicensePanel";
import { toast } from "sonner";

interface SettingsPageProps {
  settings: AdminSettings | null;
  onUpdate: (
    patch: Partial<AdminSettings>,
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
  /** Hide the tab unless this holds for the draft. */
  visible?: (d: AdminSettings) => boolean;
}[] = [
  {
    id: "basic",
    label: "Basic",
    keys: [
      "community_name",
      "public_base_url",
      "logo_url",
      "manual_sign_in",
      "promptowl_sign_in_gate",
      "posthog_key",
      "posthog_host",
      "max_body_bytes",
      "trace_retention_days",
      "run_retention_days",
    ],
  },
  {
    // Every on/off feature switch. Switches with their own config (SSO)
    // open a dedicated tab while on.
    id: "features",
    label: "Features",
    keys: [
      "workflow_plane_enabled",
      "subagent_runs_enabled",
      "metacognition_enabled",
      "subagent_max_depth",
      "subagent_max_children",
      "promptowl_teams_enabled",
      "type_artifact_enabled",
      "type_table_enabled",
      "telemetry_enabled",
      "nest_creation",
      "people_suggest_all_users",
      "shared_deployment",
      "oidc_enabled",
      "sso_token_exchange_enabled",
    ],
  },
  {
    id: "sso",
    label: "Single sign-on",
    visible: (d) => d.oidc_enabled || d.sso_token_exchange_enabled,
    keys: [
      "oidc_issuer",
      "oidc_client_id",
      "oidc_client_secret",
      "oidc_allowed_domains",
      "oidc_auto_provision",
      "oidc_department_tagging",
      "mcp_signing_secret",
      "mcp_token_ttl_seconds",
      "ms_token_exchange_enabled",
      "ms_client_id",
      "ms_tenant_id",
      "google_token_exchange_enabled",
      "google_client_id",
      "mcp_oauth_enabled",
    ],
  },
  {
    // The in-app chatbot, with the model key it depends on.
    id: "hootie",
    label: "Hootie",
    keys: [
      "provider_keys",
      "hootie_enabled",
      "hootie_model",
      "hootie_name",
      "hootie_logo_url",
      "hootie_accent_color",
      "hootie_greeting",
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    keys: [
      "slack_webhook_url",
      "msteams_webhook_url",
      "email_provider",
      "smtp_url",
      "ses_region",
      "ses_access_key_id",
      "ses_secret_access_key",
      "notify_email_from",
      "notify_email_to",
    ],
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
    // Docs only — nothing here persists, so no keys for the unsaved dot.
    id: "agents",
    label: "Connecting agents",
    keys: [],
  },
  {
    id: "license",
    label: "License",
    keys: [],
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
/** Providers an Enterprise (byok) server can add its own key for. */
const OWN_PROVIDERS = [
  ["claude", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Google Gemini"],
  ["grok", "xAI Grok"],
  ["groq", "Groq"],
] as const;

/**
 * Own-provider key rows (inside the Model keys card). Write-only like any
 * secret: staged in the draft as `provider_keys` (string = set, null =
 * clear) and sent with the global Save; PromptOwl checks and keeps them in its
 * model gateway, this server only sees the masked tail.
 */
function ProviderKeyFields({
  draft,
  current,
  fieldErrors,
  set,
}: {
  draft: Record<string, string | null>;
  current: Record<string, { masked: string }>;
  fieldErrors: Record<string, string>;
  set: (next: Record<string, string | null>) => void;
}) {
  const stage = (p: string, v: string | null | undefined) => {
    const next = { ...draft };
    // Typing then deleting must not read as "clear": empty = untouched.
    if (v === undefined || v === "") delete next[p];
    else next[p] = v;
    set(next);
  };
  return (
    <>
        {OWN_PROVIDERS.map(([p, label]) => (
          <div key={p} className="space-y-1.5" data-testid={`settings-provider-${p}`}>
            <Label htmlFor={`provider-key-${p}`}>{label}</Label>
            <div className="text-xs text-muted-foreground">
              {draft[p] === null
                ? "Will be cleared when you save."
                : current[p]
                  ? `Current: ••••${current[p].masked}`
                  : "Not set."}
            </div>
            <TextField
              id={`provider-key-${p}`}
              type="password"
              error={fieldErrors[`provider_keys.${p}`]}
              value={typeof draft[p] === "string" ? (draft[p] as string) : ""}
              placeholder="Paste to set or replace"
              onChange={(v) => stage(p, v)}
            />
            {current[p] && draft[p] !== null && (
              <button type="button" className="text-xs text-destructive hover:underline" onClick={() => stage(p, null)}>
                Clear key
              </button>
            )}
            {draft[p] === null && (
              <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => stage(p, undefined)}>
                Keep current key
              </button>
            )}
          </div>
        ))}
    </>
  );
}

/** Hootie's model: one of the models this server's key can reach (PromptOwl's
 *  team models on the gateway, the provider's on an own key). If the list
 *  can't be loaded, a name can still be typed. */
function HootieModelField({
  value,
  error,
  onChange,
  reloadKey,
}: {
  value: string;
  error?: string;
  onChange: (v: string) => void;
  /** Changes when the own-provider keys change, so the list is fetched again. */
  reloadKey?: string;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [own, setOwn] = useState<string[]>([]);
  const [providers, setProviders] = useState<Record<string, string>>({});
  useEffect(() => {
    getAdminModels()
      .then((r) => {
        setModels(r.models);
        setOwn(r.own_models ?? []);
        setProviders(r.providers ?? {});
      })
      .catch(() => setModels([]));
  }, [reloadKey]);
  const options = useMemo(
    () => modelOptions(models ?? [], own, providers, value),
    [models, own, providers, value],
  );
  return (
    <div className="space-y-1.5">
      <Label htmlFor="hootie-model">Model</Label>
      {models === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground h-9">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
        </div>
      ) : models.length > 0 ? (
        <SearchableSelect
          id="hootie-model"
          testId="settings-hootie-model"
          value={value}
          onChange={onChange}
          options={options}
          placeholder="Pick a model"
          searchPlaceholder="Search models…"
          emptyText="No model matches."
        />
      ) : (
        <TextField
          error={error}
          id="hootie-model"
          value={value}
          placeholder="claude-sonnet-5"
          onChange={onChange}
        />
      )}
      {error && models && models.length > 0 && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        {models && models.length > 0
          ? `The model Hootie answers with — ${models.length} available on this server.`
          : "The model Hootie answers with. The list of available models couldn't be loaded, so type its name (through a gateway, the gateway's name for it)."}
      </p>
    </div>
  );
}

function TextField({
  id,
  value,
  placeholder,
  onChange,
  type = "text",
  error,
}: {
  /** Set it when a <Label htmlFor> points here, or the label labels nothing. */
  id?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  type?: string;
  /** The server's reason this field was rejected on the last save. */
  error?: string;
}) {
  // Secret fields get a show/hide toggle so an admin can verify what they
  // typed. noAutofill stays keyed on the DECLARED type (password), so revealing
  // it doesn't re-open the door to credential managers stuffing the box.
  const isPassword = type === "password";
  const [reveal, setReveal] = useState(false);
  return (
    <div className="flex-1">
      {/* The reveal button spans the input alone, so an error line below
          doesn't stretch it. */}
      <div className="relative">
      <Input
        id={id}
        value={value}
        type={isPassword && reveal ? "text" : type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className={`flex-1 ${isPassword ? "pr-9" : ""} ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
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
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
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

function SettingsPage({ settings, onUpdate }: SettingsPageProps) {
  // Local editable copy. Re-synced whenever the server value changes (initial
  // load, and after a successful save — which clears the dirty state).
  // Write-only fields (secrets, `provider_keys`) are edited through the same
  // draft + `set()` + global Save: absent = untouched, string = set, null = clear.
  const [draft, setDraft] = useState<AdminSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  // Auth mode isn't an admin setting — it's boot-time config, reported on
  // /health and already derived once in AuthContext. The Connecting-agents
  // tab needs it so open-mode deployments aren't told to send a credential
  // that doesn't exist; read it from there rather than mounting a second
  // query, so there's one place that decides what "open mode" means.
  const { authMode } = useAuth();
  // Error from the last failed save (shape validation or SMTP verify), shown
  // inline near the fields. Cleared on the next edit or a successful save.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-field reasons from the same failed save, shown on the fields themselves.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Controlled tab so a failed save can jump the admin to the tab holding the
  // rejected field — otherwise the error banner points at fields on a tab
  // they've navigated away from.
  const [activeTab, setActiveTab] = useState<string>("basic");
  // Switching SSO off while on its tab hides that tab — fall back to Features.
  const visibleTabs = TABS.filter((t) => !t.visible || (draft && t.visible(draft)));
  const currentTab = visibleTabs.some((t) => t.id === activeTab) ? activeTab : "features";
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
    setFieldErrors({});
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
        k === "oidc_client_secret" ||
        k === "mcp_signing_secret" ||
        k === "ses_secret_access_key"
      ) {
        const v = draft[k];
        return (typeof v === "string" && v.trim() !== "") || v === null;
      }
      if (k === "provider_keys") return Object.keys(draft.provider_keys ?? {}).length > 0;
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
    setFieldErrors({});
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
      const errs: Record<string, string> = e?.body?.fieldErrors ?? {};
      setFieldErrors(errs);
      const badFields = Object.keys(errs);
      const owns = (t: (typeof TABS)[number]) =>
        // "provider_keys.openai" belongs to the tab holding "provider_keys".
        badFields.some((f) => (t.keys as string[]).includes(f.split(".")[0]));
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
    setFieldErrors({});
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
      <PageTitle
        icon={Shield}
        title="Server settings"
        description="Server-wide options. Changes apply on Save and persist across restarts."
        className="mb-6"
        actions={
          settings && (
            <>
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
            </>
          )
        }
      />

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
        <Tabs value={currentTab} onValueChange={setActiveTab}>
          <TabsList>
            {visibleTabs.map((t) => (
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

          {/* Basic */}
          <TabsContent value="basic" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Community</CardTitle>
                <CardDescription>
                  How this server names and presents itself.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="community-name">Community name</Label>
                  <TextField
                    id="community-name"
                    error={fieldErrors.community_name}
                    value={draft.community_name ?? ""}
                    placeholder="Acme Community"
                    onChange={(v) => set({ community_name: v })}
                  />
                  <p className="text-xs text-muted-foreground">
                    The name of this community. Leave empty if unsure.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="public-base-url">Public base URL</Label>
                  <TextField
                    id="public-base-url"
                    error={fieldErrors.public_base_url}
                    value={draft.public_base_url ?? ""}
                    placeholder="https://nest.yourcompany.com"
                    onChange={(v) => set({ public_base_url: v })}
                  />
                  <p className="text-xs text-muted-foreground">
                    This server's public address — used for share links and
                    SSO redirects. Leave empty if unsure.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="logo-url">Logo</Label>
                  <TextField
                    id="logo-url"
                    value={draft.logo_url ?? ""}
                    placeholder="https://example.com/logo.svg"
                    onChange={(v) => set({ logo_url: v })}
                  />
                  <p className="text-xs text-muted-foreground">
                    URL of the logo shown in the header. Leave empty for the
                    default.
                  </p>
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
                <CardTitle className="text-base">Product analytics</CardTitle>
                <CardDescription>
                  Send usage events to your own PostHog project. Leave the key
                  empty to keep analytics off. Also off whenever usage telemetry
                  (Features tab) is off.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField
                  error={fieldErrors.posthog_key}
                  value={draft.posthog_key ?? ""}
                  placeholder="Project API key — phc_..."
                  onChange={(v) => set({ posthog_key: v })}
                />
                <TextField
                  error={fieldErrors.posthog_host}
                  value={draft.posthog_host ?? ""}
                  placeholder="Host — https://us.i.posthog.com"
                  onChange={(v) => set({ posthog_host: v })}
                />
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

              {/* Agent-run retention (runs + run_steps) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Agent run retention</CardTitle>
                  <CardDescription>
                    How many days of finished agent runs, and their step-by-step
                    traces, to keep. Proposals and comments an agent made stay;
                    only their link to the trace stops resolving. Pruned hourly.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <NumField
                      value={draft.run_retention_days}
                      min={0}
                      max={3650}
                      onChange={(n) => set({ run_retention_days: n })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">
                      days
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    0–3650 — 0 (the default) keeps every run.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Features */}
          <TabsContent value="features" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                        ...(v ? {} : { subagent_runs_enabled: false, metacognition_enabled: false }),
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Metacognition agents — server-run, so they need the plane */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Metacognition agents</CardTitle>
                <CardDescription>
                  Agent documents this server runs itself, as a named persona,
                  on the nest's model key. They read the folders they are given
                  and only ever file proposals for review — they never publish.
                  Runs use PromptOwl credits, or your own key. Requires the
                  workflow plane.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.metacognition_enabled ? "On" : "Off"}
                    {!draft.workflow_plane_enabled && (
                      <span className="text-muted-foreground">
                        {" "}
                        · enable the workflow plane first
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={draft.metacognition_enabled}
                    disabled={!draft.workflow_plane_enabled}
                    onCheckedChange={(v) => set({ metacognition_enabled: v })}
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
                  workflow plane.
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
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  Single sign-on (OIDC)
                </CardTitle>
                <CardDescription>
                  Let teammates sign in with your identity provider — Microsoft
                  Entra ID, Google, or any OpenID Connect issuer. Turn it on,
                  then configure it on the Single sign-on tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.oidc_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.oidc_enabled}
                    onCheckedChange={(v) => set({ oidc_enabled: v })}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Agent OAuth — the authorization server MCP clients sign into.
                Default off; refuses to turn on without a public base URL,
                because the metadata must name this server's exact address. */}
            <Card>
              <CardHeader>
                <CardTitle>Agent OAuth — sign-in for MCP clients</CardTitle>
                <CardDescription>
                  Let Claude, ChatGPT, Grok or Cursor sign a person in to this
                  server and receive a token scoped to <em>them</em>, instead
                  of being handed a shared API key. This is what makes each
                  person see their own nests: a key pasted by several people
                  makes all of them the same user here, so they all see
                  whatever its owner can see.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {draft.mcp_oauth_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.mcp_oauth_enabled}
                    onCheckedChange={(v) => set({ mcp_oauth_enabled: v })}
                  />
                </div>

                {!draft.public_base_url?.trim() && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    Blocked: set the public base URL on the General tab first.
                    The discovery documents have to name this server's exact
                    address, and a guessed one fails the client's check with no
                    useful error.
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  While this is on, an MCP client that arrives without a
                  credential is answered with a sign-in challenge rather than a
                  flat refusal. Existing API keys keep working exactly as
                  before.
                </p>
              </CardContent>
            </Card>

            {/* Agent SSO — token exchange. Security-critical, OFF by default. */}
            <Card>
              <CardHeader>
                <CardTitle>Agent SSO — token exchange</CardTitle>
                <CardDescription>
                  Let an external agent, acting for a user your IdP already
                  authenticated (Microsoft Entra / Google), exchange that IdP's
                  ID token for a short-lived MCP bearer — no second login.
                  Configure it on the Single sign-on tab.
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plus className="h-4 w-4 text-muted-foreground" />
                  Nest creation
                </CardTitle>
                <CardDescription>
                  Who can create and import nests on this server.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="pr-4">
                    <div className="text-sm font-medium">
                      Let everyone create nests
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Off, only server admins can create or import nests, and
                      everyone else works in the nests shared with them. On,
                      any signed-in user can create their own.
                    </p>
                  </div>
                  <Switch
                    checked={draft.nest_creation === "everyone"}
                    onCheckedChange={(v) =>
                      set({ nest_creation: v ? "everyone" : "admins" })
                    }
                  />
                </div>
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
                <div className="flex items-start justify-between gap-4 pb-4">
                  <div className="pr-4">
                    <div className="text-sm font-medium">
                      Suggest everyone on this server
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      When enabled, the pickers suggest every registered
                      account on this server.
                    </p>
                    <ul className="text-xs text-muted-foreground mt-1.5 space-y-0.5">
                      <li><b className="text-foreground/80">Off:</b> only people the inviter already shares a nest or team with.</li>
                      <li><b className="text-foreground/80">On:</b> every registered account — right when this server is one organisation, wrong when it hosts several, because it shows users each other's email addresses.</li>
                      <li><b className="text-foreground/80">In either state:</b> anyone can still be invited by typing their email address.</li>
                    </ul>
                  </div>
                  <Switch
                    checked={draft.people_suggest_all_users}
                    onCheckedChange={(v) => set({ people_suggest_all_users: v })}
                  />
                </div>
                <div className="flex items-start justify-between gap-4 pt-4 border-t">
                  <div className="pr-4">
                    <div className="text-sm font-medium">
                      This server hosts several organizations
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      A nest's Organization tier is readable by every account
                      on this server.
                    </p>
                    <ul className="text-xs text-muted-foreground mt-1.5 space-y-0.5">
                      <li><b className="text-foreground/80">Off:</b> the server is one company and the Organization tier applies in one click.</li>
                      <li><b className="text-foreground/80">On:</b> for the PromptOwl-hosted service, or any install shared by unrelated customers — opening a nest to Organization asks for the same acknowledgement as Public. Enforced by the server, not only the UI, and the visibility picker explains who the tier really reaches.</li>
                    </ul>
                  </div>
                  <Switch
                    checked={draft.shared_deployment}
                    onCheckedChange={(v) => set({ shared_deployment: v })}
                    data-testid="settings-shared-deployment"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Single sign-on — config for the two SSO switches on Features.
              The tab only shows while one of them is on. */}
          <TabsContent value="sso" className="space-y-4">
            {draft.oidc_enabled && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                    Single sign-on (OIDC)
                  </CardTitle>
                  <CardDescription>Your identity provider's issuer and app credentials.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
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
                          error={fieldErrors.oidc_issuer}
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
                      error={fieldErrors.oidc_client_secret}
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
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  Sign-up rules
                </CardTitle>
                <CardDescription>
                  Who may sign in or be exchanged a token. Shared by single sign-on and agent SSO.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-sm font-medium mb-1">
                    Allowed email domains
                  </div>
                  <TextField
                    error={fieldErrors.oidc_allowed_domains}
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
            {draft.sso_token_exchange_enabled && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    Agent SSO — token exchange
                  </CardTitle>
                  <CardDescription>
                    Signing secret, token lifetime and the identity providers agents may exchange from.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
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
                      error={fieldErrors.mcp_signing_secret}
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
                      error={fieldErrors.mcp_token_ttl_seconds}
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
            )}
          </TabsContent>

          {/* Hootie */}
          <TabsContent value="hootie" className="space-y-4">
            {/* Model keys — own provider keys (byok), kept by PromptOwl's model
                gateway; write-only, staged as `provider_keys` on the global Save. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Model keys</CardTitle>
                <CardDescription>
                  Your own model keys. A Hootie model from a provider below runs
                  on that provider's key; any other model, and agent runs, use
                  PromptOwl's virtual key on your plan's credits (a nest can set
                  its own key for runs in its Tool environment). Each key is
                  checked with the provider when you save and kept by
                  PromptOwl's model gateway, not on this server.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {settings?.byok_available === false ? (
                  // Pricing spec §9.3: own key only with the byok licence feature.
                  <div className="text-sm text-muted-foreground space-y-2" data-testid="settings-models-by-promptowl">
                    <p>
                      Models on this server are supplied by PromptOwl and use
                      your plan's credits. Using your own model key or gateway
                      is an Enterprise feature.
                    </p>
                  </div>
                ) : (
                <div className="space-y-4">
                {Object.keys(settings?.own_providers ?? {}).length === 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="settings-no-own-keys">
                    No own keys set — Hootie and runs use PromptOwl's virtual key on your plan's credits.
                  </p>
                )}
                <ProviderKeyFields
                  draft={draft.provider_keys ?? {}}
                  current={settings?.own_providers ?? {}}
                  fieldErrors={fieldErrors}
                  set={(provider_keys) => set({ provider_keys })}
                />
                </div>
                )}
              </CardContent>
            </Card>

            {/* Hootie in the nest — the assistant on every page. Sits under
                the key it depends on: switching it on without a key gives
                everyone a panel that explains what's missing, not a broken
                one, so the two settings read together. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Hootie</CardTitle>
                <CardDescription>
                  The assistant in a side panel on every page, opened from a
                  tab on the right edge. It answers from what the person asking
                  can read in the nest, cites the documents it used, and lets
                  them @tag a colleague — which posts the exchange as a comment
                  and notifies them. Off until you turn it on. Runs on your
                  own key for the model's provider, or on PromptOwl models with
                  your plan's credits; without either the panel says so.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    Hootie in the nest — {draft.hootie_enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={draft.hootie_enabled}
                    onCheckedChange={(v) => set({ hootie_enabled: v })}
                    data-testid="settings-hootie-enabled"
                  />
                </div>
                <HootieBrandingFields
                  draft={draft}
                  fieldErrors={fieldErrors}
                  set={set}
                />
                <HootieModelField
                  value={draft.hootie_model ?? ""}
                  error={fieldErrors.hootie_model}
                  onChange={(v) => set({ hootie_model: v })}
                  reloadKey={JSON.stringify(settings?.own_providers ?? {})}
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
                  error={fieldErrors.slack_webhook_url}
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
                  error={fieldErrors.msteams_webhook_url}
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
                  Invites, shares and governance events by email. Send through
                  SMTP, or through AWS SES when this server can't use SMTP. Set
                  a From address and one or more team recipients
                  (comma-separated). Leave the SMTP URL or AWS region empty to
                  turn email off.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div role="radiogroup" className="flex gap-4 text-sm">
                  {(
                    [
                      ["smtp", "SMTP"],
                      ["ses", "AWS SES"],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="email_provider"
                        checked={(draft.email_provider ?? "smtp") === value}
                        onChange={() => set({ email_provider: value })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {(draft.email_provider ?? "smtp") === "smtp" ? (
                  <TextField
                    error={fieldErrors.smtp_url}
                    type="password"
                    value={draft.smtp_url ?? ""}
                    placeholder="smtps://user:pass@smtp.example.com:465"
                    onChange={(v) => set({ smtp_url: v })}
                  />
                ) : (
                  <>
                    <TextField
                      error={fieldErrors.ses_region}
                      value={draft.ses_region ?? ""}
                      placeholder="AWS region — us-east-1"
                      onChange={(v) => set({ ses_region: v })}
                    />
                    <TextField
                      value={draft.ses_access_key_id ?? ""}
                      placeholder="Access key ID — leave empty to use the server's IAM role"
                      onChange={(v) => set({ ses_access_key_id: v })}
                    />
                    <TextField
                      error={fieldErrors.ses_secret_access_key}
                      type="password"
                      value={
                        typeof draft.ses_secret_access_key === "string"
                          ? draft.ses_secret_access_key
                          : ""
                      }
                      placeholder={
                        draft.ses_secret_access_key === null
                          ? "Secret access key — will be cleared when you save"
                          : settings?.ses_secret_access_key_set
                            ? "Secret access key is set — paste to replace"
                            : "Secret access key — leave empty to use the server's IAM role"
                      }
                      onChange={(v) => set({ ses_secret_access_key: v })}
                    />
                    {settings?.ses_secret_access_key_set &&
                      draft.ses_secret_access_key !== null && (
                        <button
                          type="button"
                          className="text-xs text-destructive hover:underline"
                          onClick={() =>
                            set({ ses_secret_access_key: null, ses_access_key_id: "" })
                          }
                        >
                          Clear keys
                        </button>
                      )}
                  </>
                )}
                <TextField
                  error={fieldErrors.notify_email_from}
                  value={draft.notify_email_from ?? ""}
                  placeholder="From — nest@yourcompany.com"
                  onChange={(v) => set({ notify_email_from: v })}
                />
                <TextField
                  error={fieldErrors.notify_email_to}
                  value={draft.notify_email_to ?? ""}
                  placeholder="To — team@yourcompany.com, ops@yourcompany.com"
                  onChange={(v) => set({ notify_email_to: v })}
                />
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

          <TabsContent value="agents" className="space-y-4">
            <AgentConnectPanel
              publicBaseUrl={draft.public_base_url}
              openMode={authMode === "open"}
            />
          </TabsContent>

          <TabsContent value="license" className="space-y-4">
            {activeTab === "license" && <LicensePanel />}
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

/** The route: owns the server-settings load + save (moved out of App), and
 *  hands the form the same props it always took. */
export default function SettingsRoute() {
  const { isAdmin, refreshHealth } = useAuth();
  const qc = useQueryClient();
  // Server-wide settings for the admin Settings page. Loaded once for admins.
  const [serverSettings, setServerSettings] = useState<AdminSettings | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    getAdminSettings()
      .then(setServerSettings)
      .catch(() => {});
  }, [isAdmin]);
  const updateServerSettings = useCallback(async (
    patch: Partial<AdminSettings>,
  ) => {
    try {
      const res = await updateAdminSettings(patch);
      setServerSettings(res.settings);
      // Feature flags gate other views (workflow-plane nav, sub-agent picker,
      // PromptOwl teams …) off the /health-sourced AuthContext state, not
      // serverSettings. Always re-read health after a save so ANY flag exposed
      // there takes effect live — no page reload, and no per-key allowlist to
      // keep in sync as new flags are added.
      await refreshHealth();
      // Pages reading /health through the query cache (e.g. nest_creation).
      await qc.invalidateQueries({ queryKey: reads.health().queryKey });
      toast.success("Settings saved");
    } catch (e: any) {
      // A rejected save (validation / SMTP verify) persisted nothing server-side,
      // so DON'T re-sync — that would reset the draft and wipe what the admin
      // typed. Re-throw the original error (with its `body.fieldErrors`) so the
      // Settings page can focus the offending field's tab and show the message
      // inline — no toast here, or the same error shows twice.
      throw e;
    }
  }, [refreshHealth, qc]);
  return (
    <SettingsPage
      settings={serverSettings}
      onUpdate={updateServerSettings}
    />
  );
}

/**
 * The assistant's name, logo, accent colour and greeting — an Enterprise
 * feature. Without the entitlement the fields are shown locked (the server
 * refuses them anyway and every surface shows the default Hootie).
 */
function HootieBrandingFields({
  draft,
  fieldErrors,
  set,
}: {
  draft: AdminSettings;
  fieldErrors: Record<string, string>;
  set: (patch: Partial<AdminSettings>) => void;
}) {
  const available = !!draft.hootie_branding_available;
  const hex = /^#[0-9a-fA-F]{6}$/.test(draft.hootie_accent_color ?? "")
    ? draft.hootie_accent_color
    : null;
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="settings-hootie-branding">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Name and branding</span>
        <Badge variant="secondary" className="gap-1">
          {!available && <Lock className="h-3 w-3" />}
          Enterprise
        </Badge>
      </div>
      {!available && (
        <p className="text-xs text-muted-foreground" data-testid="settings-hootie-branding-locked">
          Rename the assistant and give it your logo, colour and greeting with
          an Enterprise licence. Until then everyone sees Hootie.
        </p>
      )}
      <fieldset disabled={!available} className="grid gap-3 disabled:opacity-60 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="hootie-name">Name</Label>
          <TextField
            id="hootie-name"
            error={fieldErrors.hootie_name}
            value={draft.hootie_name ?? ""}
            placeholder="Hootie"
            onChange={(v) => set({ hootie_name: v })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hootie-accent">Accent colour</Label>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-8 w-8 shrink-0 rounded-md border"
              style={hex ? { backgroundColor: hex } : undefined}
            />
            <TextField
              id="hootie-accent"
              error={fieldErrors.hootie_accent_color}
              value={draft.hootie_accent_color ?? ""}
              placeholder="#0a7cff — empty uses the theme colour"
              onChange={(v) => set({ hootie_accent_color: v })}
            />
          </div>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="hootie-logo">Logo URL</Label>
          <TextField
            id="hootie-logo"
            error={fieldErrors.hootie_logo_url}
            value={draft.hootie_logo_url ?? ""}
            placeholder="https://cdn.example.com/assistant.png"
            onChange={(v) => set({ hootie_logo_url: v })}
          />
          <p className="text-xs text-muted-foreground">
            An https link to a .png, .jpg, .gif or .webp image. Shown on the
            edge tab, the panel header and next to each answer.
          </p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="hootie-greeting">Greeting</Label>
          <TextField
            id="hootie-greeting"
            error={fieldErrors.hootie_greeting}
            value={draft.hootie_greeting ?? ""}
            placeholder={`Hi, I'm ${draft.hootie_name?.trim() || "Hootie"}`}
            onChange={(v) => set({ hootie_greeting: v })}
          />
        </div>
      </fieldset>
    </div>
  );
}
